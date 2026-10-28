#!/usr/bin/env python3
"""Root-only, encrypted local backups. Restore rehearsal never targets live DB."""
import datetime, fcntl, hashlib, hmac, json, os, pathlib, re, secrets, select, subprocess, sys, time

BACKUPS = pathlib.Path('/var/backups/homemind')
KEY = pathlib.Path('/etc/homemind/backup-passphrase')
RUNTIME = pathlib.Path('/run')
PG_IMAGE = 'postgres:18-trixie@sha256:5a5a84b19854a9ffaa54082c166ff4ec27473a361e496e5ea167f298f2da9722'

def run(args, **kwargs):
    result = subprocess.run(args, capture_output=True, **kwargs)
    if result.returncode: raise RuntimeError('Backup command failed: '+args[0])
    return result.stdout

def database_container():
    ids = run(['docker','ps','-q','--filter','label=com.docker.compose.project=homemind','--filter','label=com.docker.compose.service=db']).decode().split()
    if len(ids) != 1: raise RuntimeError('Expected exactly one HomeMind DB container')
    return ids[0]

def mac(path):
    digest = hmac.new(KEY.read_bytes().strip(), digestmod=hashlib.sha256)
    with path.open('rb') as reader:
        for chunk in iter(lambda: reader.read(1024*1024), b''): digest.update(chunk)
    return digest.hexdigest()

def verify(path):
    path=pathlib.Path(path).resolve()
    if path.parent != BACKUPS.resolve() or not path.name.endswith('.dump.enc'): raise RuntimeError('Unexpected backup path')
    manifest=json.loads(path.with_suffix('.json').read_text())
    if not hmac.compare_digest(manifest['hmac_sha256'],mac(path)): raise RuntimeError('Backup authentication failed')
    return path

def decrypt_into(path, consumer):
    decrypt=subprocess.Popen(['openssl','enc','-d','-aes-256-cbc','-pbkdf2','-iter','200000','-pass','file:'+str(KEY),'-in',str(verify(path))],stdout=subprocess.PIPE,stderr=subprocess.PIPE)
    restore=subprocess.Popen(consumer,stdin=decrypt.stdout,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
    decrypt.stdout.close(); decrypt.stdout=None
    out,err=restore.communicate(); _,decrypt_error=decrypt.communicate()
    if restore.returncode or decrypt.returncode: raise RuntimeError('Backup validation/restore failed')
    return out

def create(db=None):
    os.umask(0o077); BACKUPS.mkdir(parents=True,exist_ok=True)
    db=db or database_container()
    stamp=datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ')
    path=BACKUPS/(stamp+'-'+secrets.token_hex(4)+'.dump.enc')
    keeper=subprocess.Popen(['docker','exec','-i',db,'psql','-X','-qAt','-v','ON_ERROR_STOP=1','-U','postgres','-d','homemind'],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
    try:
        keeper.stdin.write(b'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;\nSELECT pg_export_snapshot();\n');keeper.stdin.flush()
        if not select.select([keeper.stdout],[],[],15)[0]: raise RuntimeError('Snapshot export timed out')
        snapshot=keeper.stdout.readline().decode().strip()
        if not re.fullmatch('[0-9A-Fa-f]+-[0-9A-Fa-f]+-[0-9]+',snapshot): raise RuntimeError('Snapshot export failed')
        # Both the dump and every validation count use the SAME exported snapshot.
        counts=table_counts(db,snapshot)
        dump=subprocess.Popen(['docker','exec',db,'pg_dump','-U','postgres','-d','homemind','-Fc','--snapshot='+snapshot],stdout=subprocess.PIPE,stderr=subprocess.PIPE)
        encrypt=subprocess.Popen(['openssl','enc','-aes-256-cbc','-pbkdf2','-iter','200000','-salt','-pass','file:'+str(KEY),'-out',str(path)],stdin=dump.stdout,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
        dump.stdout.close(); dump.stdout=None; encrypt.communicate(); dump.communicate()
        if dump.returncode or encrypt.returncode:
            path.unlink(missing_ok=True); raise RuntimeError('Database backup failed')
    finally:
        keeper.communicate(b'ROLLBACK;\n\\q\n',timeout=15)
    path.with_suffix('.json').write_text(json.dumps({'created_at':stamp,'hmac_sha256':mac(path),'encryption':'AES-256-CBC/PBKDF2 + HMAC-SHA256','offsite':False,'table_counts':counts,'counts_snapshot':'same exported snapshot as pg_dump'}))
    # --list consumes only TOC and breaks the decrypt pipe on larger archives.
    # Generate SQL to /dev/null instead, validating the entire archive stream.
    decrypt_into(path,['docker','exec','-i',db,'pg_restore','--file=/dev/null'])
    # Fourteen days of local, authenticated encrypted snapshots. Never delete keys.
    for manifest in BACKUPS.glob('*.dump.json'):
        candidate=manifest.with_suffix('.enc')
        if candidate != path and time.time()-manifest.stat().st_mtime > 14*86400:
            if candidate.exists(): candidate.unlink()
            manifest.unlink()
    return str(path)

def table_counts(db,snapshot=None):
    prefix='BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY; SET TRANSACTION SNAPSHOT '+"'"+snapshot+"'; " if snapshot else ''
    suffix='; ROLLBACK' if snapshot else ''
    tables=run(['docker','exec',db,'psql','-X','-U','postgres','-d','homemind','-qAtc',prefix+"select schemaname || E'\\t' || tablename from pg_tables where schemaname in ('public','admin') order by schemaname,tablename"+suffix]).decode().splitlines()
    result={}
    for entry in tables:
        schema,table=entry.split('\t')
        if schema not in ['public','admin'] or not table or not all(c.isalnum() or c=='_' for c in table): raise RuntimeError('Unexpected table identifier')
        # Public keys remain compatible with pre-admin encrypted manifests.
        key=table if schema=='public' else schema+'.'+table
        result[key]=int(run(['docker','exec',db,'psql','-X','-U','postgres','-d','homemind','-qAtc',prefix+'select count(*) from "'+schema+'"."'+table+'"'+suffix]).decode().strip())
    return result

def restore_rehearsal(path, image=None):
    os.umask(0o077); path=verify(path)
    name='homemind-restore-'+secrets.token_hex(6)
    env=RUNTIME/(name+'.env')
    env.write_text('POSTGRES_PASSWORD='+secrets.token_hex(32)+'\n')
    try:
        state=pathlib.Path('/opt/homemind/release.json')
        image=image or (json.loads(state.read_text())['database_image'] if state.exists() else PG_IMAGE)
        run(['docker','run','-d','--name',name,'--network','none','--tmpfs','/var/lib/postgresql:rw,size=1g','--env-file',str(env),image])
        for _ in range(60):
            if subprocess.run(['docker','exec',name,'pg_isready','-h','127.0.0.1','-U','postgres'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL).returncode == 0: break
            time.sleep(2)
        # pg_dump preserves ACLs but not cluster roles. The isolated recovery
        # principals cannot authenticate or bypass tenant policies.
        run(['docker','exec','-i',name,'psql','-U','postgres','-v','ON_ERROR_STOP=1'],input=b'CREATE ROLE homemind_migrator NOLOGIN; CREATE ROLE homemind_app NOLOGIN; CREATE ROLE homemind_admin_api NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;')
        run(['docker','exec',name,'createdb','-U','postgres','-O','homemind_migrator','homemind'])
        decrypt_into(path,['docker','exec','-i',name,'pg_restore','-U','postgres','-d','homemind','--exit-on-error'])
        expected=json.loads(path.with_suffix('.json').read_text())['table_counts']
        restored=table_counts(name)
        if restored!=expected: raise RuntimeError('Restored table/row counts differ')
        admin_tables=sum(key.startswith('admin.') for key in restored)
        return {'restore':'PASS','public_table_count':len(restored)-admin_tables,'admin_table_count':admin_tables,'row_counts_match':True,'isolated':True}
    finally:
        subprocess.run(['docker','rm','-f',name],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
        env.unlink(missing_ok=True)

if __name__ == '__main__':
    try:
        with open('/run/lock/homemind-deploy.lock','a') as lock:
            fcntl.flock(lock,fcntl.LOCK_EX)
            if len(sys.argv)>2 and sys.argv[1]=='restore-rehearsal': print(json.dumps(restore_rehearsal(sys.argv[2])))
            else: print(json.dumps({'backup':create(),'offsite':False}))
    except Exception as error:
        print(str(error),file=sys.stderr); sys.exit(1)
