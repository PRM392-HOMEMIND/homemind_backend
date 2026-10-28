#!/usr/bin/env python3
"""Fixed root-owned SSH gate; accepts only tested current-main immutable images."""
import datetime, fcntl, hashlib, io, json, os, pathlib, re, shutil, stat, subprocess, sys, tempfile, time, urllib.parse, urllib.request, zipfile
sys.path.insert(0,str(pathlib.Path(__file__).resolve().parent))
import backup
import migration_recovery
from identity import non_root_user
from env_revisions import Revisions, valid_revision

ROOT=pathlib.Path('/opt/homemind')
STATE=ROOT/'release.json'
REPOSITORY='PRM392-HOMEMIND/homemind_backend'
IMAGE_PREFIX='ghcr.io/prm392-homemind/'

def validate_payload(payload):
    if set(payload)!=set(['repository','sha','run_id','api_image','migration_image','database_image','env_revision','token']): raise ValueError('Unexpected deployment fields')
    valid_revision(payload.get('env_revision'))
    if payload.get('repository')!=REPOSITORY: raise ValueError('Unexpected repository')
    if not re.fullmatch('[0-9a-f]{40}',str(payload.get('sha',''))): raise ValueError('Invalid revision')
    if not re.fullmatch('[0-9]{1,20}',str(payload.get('run_id',''))): raise ValueError('Invalid Actions run')
    for key,name in [('api_image','homemind-api'),('migration_image','homemind-migrate'),('database_image','homemind-db')]:
        if not re.fullmatch(re.escape(IMAGE_PREFIX+name+'@sha256:')+'[0-9a-f]{64}',str(payload.get(key,''))): raise ValueError('Invalid immutable image')
    if not isinstance(payload.get('token'),str) or not 20<=len(payload['token'])<=4096: raise ValueError('Missing short-lived deployment token')

def github(token,path):
    req=urllib.request.Request('https://api.github.com/'+path,headers={'Authorization':'Bearer '+token,'Accept':'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28','User-Agent':'HomeMind-deployment'})
    with urllib.request.urlopen(req,timeout=15) as response: return json.load(response)

def check_authorization(payload):
    token=payload['token']; prefix='repos/'+REPOSITORY+'/'
    repo=github(token,prefix.rstrip('/'))
    if not repo.get('private'): raise ValueError('Repository must remain private')
    run=github(token,prefix+'actions/runs/'+str(payload['run_id']))
    if run.get('head_sha')!=payload['sha'] or run.get('head_branch')!='main' or run.get('event') not in ['push','workflow_dispatch'] or run.get('path')!='.github/workflows/deploy.yml': raise ValueError('Untrusted workflow event/revision')
    jobs=github(token,prefix+'actions/runs/'+str(payload['run_id'])+'/jobs?per_page=100')['jobs']
    if not any(job['name']=='required-checks' and job.get('conclusion')=='success' for job in jobs): raise ValueError('Required CI checks did not pass')
    if not any(job['name']=='publish' and job.get('conclusion')=='success' for job in jobs): raise ValueError('Trusted image publication did not pass')
    check_freshness(payload)
    verify_manifest(payload,run)

def download_artifact(token,artifact_id):
    class SafeRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self,req,fp,code,msg,headers,newurl):
            target=urllib.parse.urlparse(newurl)
            if target.scheme!='https' or not any((target.hostname or '').endswith(suffix) for suffix in ['.blob.core.windows.net','.githubusercontent.com','.actions.githubusercontent.com']): raise ValueError('Unexpected artifact redirect')
            redirected=super().redirect_request(req,fp,code,msg,headers,newurl)
            redirected.remove_header('Authorization')
            return redirected
    req=urllib.request.Request('https://api.github.com/repos/'+REPOSITORY+'/actions/artifacts/'+str(artifact_id)+'/zip',headers={'Authorization':'Bearer '+token,'Accept':'application/vnd.github+json','User-Agent':'HomeMind-deployment'})
    with urllib.request.build_opener(SafeRedirect()).open(req,timeout=30) as response:
        raw=response.read(1024*1024+1)
    if len(raw)>1024*1024: raise ValueError('Deployment manifest artifact too large')
    return raw

def verify_manifest(payload,workflow_run):
    # Only immutable artifacts from this trusted run/attempt bind the tested digests.
    expected='deployment-manifest-'+str(workflow_run['run_attempt'])
    artifacts=github(payload['token'],'repos/'+REPOSITORY+'/actions/runs/'+str(payload['run_id'])+'/artifacts?per_page=100')['artifacts']
    matches=[a for a in artifacts if a['name']==expected and not a.get('expired')]
    if len(matches)!=1: raise ValueError('Missing/ambiguous trusted deployment manifest')
    artifact=matches[0]
    raw=download_artifact(payload['token'],artifact['id'])
    if artifact.get('digest')!='sha256:'+hashlib.sha256(raw).hexdigest(): raise ValueError('Deployment artifact checksum mismatch')
    with zipfile.ZipFile(io.BytesIO(raw)) as archive:
        if archive.namelist()!=['deployment-manifest.json'] or archive.getinfo('deployment-manifest.json').file_size>32768: raise ValueError('Unexpected deployment artifact contents')
        manifest=json.loads(archive.read('deployment-manifest.json'))
    for key in ['repository','sha','run_id','api_image','migration_image','database_image','env_revision']:
        if str(manifest.get(key))!=str(payload[key]): raise ValueError('Image digest does not match the trusted tested run')

def check_freshness(payload):
    main=github(payload['token'],'repos/'+REPOSITORY+'/git/ref/heads/main')
    if main['object']['sha']!=payload['sha']: raise ValueError('Obsolete revision; main has advanced')

def run(args,env=None,input=None):
    result=subprocess.run(args,env=env,input=input,capture_output=True)
    if result.returncode: raise RuntimeError('Deployment command failed: '+args[0]+(' '+args[1] if args[0]=='docker' and len(args)>1 else ''))
    return result.stdout

def compose_env(record):
    return {**os.environ,'APP_IMAGE':record['api_image'],'MIGRATION_IMAGE':record['migration_image'],'DB_IMAGE':record['database_image'],'RELEASE_SHA':record['sha']}

def compose(record,*args):
    return run(['docker','compose','--project-directory',str(ROOT),'-f',str(ROOT/'compose.yaml'),*args],env=compose_env(record))

def readiness(sha,base='http://127.0.0.1:3000/v1',attempts=60):
    for _ in range(attempts):
        try:
            with urllib.request.urlopen(base+'/health/ready',timeout=5) as response:
                if response.status==200 and response.headers.get('X-HomeMind-Revision')==sha and json.load(response).get('status')=='ready': return
        except Exception: pass
        time.sleep(2)
    raise RuntimeError('Readiness/revision verification failed')

def migrate_policy(image,db):
    script="const f=require('fs'),c=require('crypto'),p='prisma/migrations/';const policy=JSON.parse(f.readFileSync('prisma/compatibility.json'));console.log(JSON.stringify(f.readdirSync(p).filter(n=>/^\\d{14}_/.test(n)).sort().map(n=>({name:n,checksum:c.createHash('sha256').update(f.readFileSync(p+n+'/migration.sql')).digest('hex'),compatible:policy[n]===true,...(policy[n]&&typeof policy[n]==='object'?{recovery:policy[n].recovery,fence:policy[n].fence}:{})}))))"
    files=json.loads(run(['docker','run','--rm','--entrypoint','node',image,'-e',script]))
    exists=run(['docker','exec',db,'psql','-U','postgres','-d','homemind','-Atc',"select coalesce(to_regclass('public._prisma_migrations')::text,'')"]).strip()
    applied={}
    if exists:
        rows=run(['docker','exec',db,'psql','-U','postgres','-d','homemind','-At','-F','|','-c',"select migration_name,checksum from public._prisma_migrations where finished_at is not null and rolled_back_at is null"]).decode().splitlines()
        applied=dict(row.split('|') for row in rows)
    current={item['name']:item for item in files}
    if any(name not in current or current[name]['checksum']!=checksum for name,checksum in applied.items()): raise RuntimeError('Previously applied migration modified/omitted')
    if any(not item['compatible'] and (item.get('recovery') != migration_recovery.POLICY or item.get('fence') != migration_recovery.FENCE)
           for item in files if item['name'] not in applied):
        raise RuntimeError('Unreviewed or rollback-incompatible migration')
    return files

def promote(record):
    compose(record,'up','-d','--no-deps','--force-recreate','api')
    readiness(record['sha'])
    readiness(record['sha'],'https://api.homemind.vn/v1',attempts=3)

def restore_previous(record, previous, promoter, environments):
    if migration_recovery.required(record, previous) or migration_recovery.journal_path(ROOT).exists():
        # The durable journal predates migrations. Never return the legacy API
        # or discard this recovery state after a partial schema upgrade.
        stop_uncommitted_api()
        raise RuntimeError('Fenced migration requires tested forward recovery; legacy API rollback refused')
    if environments: environments.rollback(record['env_revision'])
    if previous:
        promoter(previous)
        # Compatible migrations deliberately stay applied after API rollback.
        # Preserve that verified DB revision in the previous code/image/env record.
        if record.get('migrations') and record['migrations'] != previous.get('migrations'):
            write_release({**previous, 'migrations': record['migrations']})
    else:
        # There is no healthy previous release to restore on the first deploy.
        # Stop only this compose project's API before releasing the journal.
        stop_uncommitted_api()
    if environments: environments.finish_rollback(record['env_revision'])

def stop_uncommitted_api():
    ids=run(['docker','ps','-a','--filter','label=com.docker.compose.project=homemind',
             '--filter','label=com.docker.compose.service=api','--format','{{.ID}}']).decode().split()
    if len(ids)>1 or any(not re.fullmatch('[0-9a-f]{12,64}',cid) for cid in ids):
        raise RuntimeError('Ambiguous first-deployment API ownership')
    for cid in ids:
        info=json.loads(run(['docker','inspect',cid]))[0]
        labels=info['Config'].get('Labels') or {}
        if labels.get('com.docker.compose.project.working_dir')!=str(ROOT) or labels.get('com.docker.compose.project.config_files')!=str(ROOT/'compose.yaml'):
            raise RuntimeError('First-deployment API does not match the fixed compose root')
        run(['docker','stop',cid])
        if json.loads(run(['docker','inspect',cid]))[0]['State']['Running']:
            raise RuntimeError('First-deployment API is still running')

def promote_or_rollback(record, previous, promoter=None, environments=None):
    """Restore the previous API only. Compatible database migrations stay applied."""
    promoter = promoter or promote
    try:
        promoter(record)
    except Exception:
        restore_previous(record, previous, promoter, environments)
        if previous:
            print(json.dumps({'status':'failed','api_rollback':'healthy_previous_release','database':'preserved'}))
        raise

def require_committed_environment(previous, environments):
    """A crash after activation needs operator recovery before another deploy."""
    expected = previous.get('env_revision') if previous else None
    if environments.current() != expected:
        raise RuntimeError('Uncommitted environment activation; run the existing root recovery before deployment')

def require_expected_environment(expected, previous, environments):
    valid_revision(expected)
    require_committed_environment(previous, environments)
    active = environments.current()
    if active is None or expected != active:
        raise ValueError('Expected production environment revision does not match active revision')
    environments.candidate(active)
    return active

def read_release(path=None):
    path = path or STATE
    directory = path.parent.lstat()
    if not stat.S_ISDIR(directory.st_mode) or directory.st_uid != 0 or directory.st_mode & 0o022:
        raise ValueError('Unsafe trusted release directory')
    if path.is_symlink(): raise ValueError('Unsafe trusted release state')
    if not path.exists(): return None
    info = path.lstat()
    if (not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_nlink != 1
            or info.st_mode & 0o022 or info.st_size > 4*1024*1024):
        raise ValueError('Unsafe trusted release state')
    if path.with_suffix('.new').exists() or list(path.parent.glob('.release-*')):
        raise ValueError('Interrupted release metadata commit; root recovery required')
    return json.loads(path.read_text())

def write_release(record, path=None):
    """Atomic root-owned metadata commit; environment bytes never enter it."""
    path = path or STATE
    directory = path.parent.lstat()
    if not stat.S_ISDIR(directory.st_mode) or directory.st_uid != 0 or directory.st_mode & 0o022:
        raise ValueError('Unsafe trusted release directory')
    if path.exists() or path.is_symlink():
        info = path.lstat()
        if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_nlink != 1 or info.st_mode & 0o022:
            raise ValueError('Unsafe trusted release state')
    fd, name = tempfile.mkstemp(prefix='.release-', dir=path.parent)
    try:
        with os.fdopen(fd, 'wb') as stream:
            os.fchmod(stream.fileno(), 0o600)
            stream.write(json.dumps(record, indent=2).encode()); stream.flush(); os.fsync(stream.fileno())
        os.replace(name, path)
        descriptor = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
        try: os.fsync(descriptor)
        finally: os.close(descriptor)
    finally:
        if os.path.exists(name): os.unlink(name)

def verify_running_release(record):
    """Read-only attestation, comparing private environments entirely in memory."""
    if not record or not re.fullmatch('[0-9a-f]{40}', str(record.get('sha', ''))):
        raise ValueError('Missing current production release')
    ids = compose(record, 'ps', '-q', 'api').decode().split()
    if len(ids) != 1: raise ValueError('Ambiguous production API ownership')
    actual = json.loads(run(['docker', 'inspect', ids[0]]))[0]
    labels = actual['Config'].get('Labels') or {}
    if (not actual['State']['Running'] or actual['Config']['Image'] != record['api_image'] or
            labels.get('com.docker.compose.project.working_dir') != str(ROOT) or
            labels.get('com.docker.compose.project.config_files') != str(ROOT / 'compose.yaml')):
        raise ValueError('Running API does not match committed release')
    rendered = json.loads(compose(record, 'config', '--format', 'json'))['services']['api']['environment']
    effective = dict(item.split('=', 1) for item in actual['Config'].get('Env', []) if '=' in item)
    if any(effective.get(key) != str(value) for key, value in rendered.items()):
        raise ValueError('Running API environment does not match current trusted configuration')
    for key in ['api_image', 'migration_image', 'database_image']:
        info = json.loads(run(['docker', 'image', 'inspect', record[key]]))[0]
        image_labels = info['Config'].get('Labels') or {}
        if (record[key] not in info.get('RepoDigests', []) or
                image_labels.get('org.opencontainers.image.revision') != record['sha'] or
                image_labels.get('org.opencontainers.image.source') != 'https://github.com/' + REPOSITORY):
            raise ValueError('Committed production image identity mismatch')
    applied = run(['docker', 'exec', backup.database_container(), 'psql', '-U', 'postgres', '-d', 'homemind',
        '-At', '-F', '|', '-c', 'select migration_name,checksum from public._prisma_migrations where finished_at is not null and rolled_back_at is null order by migration_name']).decode().splitlines()
    migrations = dict(row.split('|') for row in applied)
    if not migrations or migrations != {item['name']: item['checksum'] for item in record.get('migrations', [])}:
        raise ValueError('Production migration state does not match committed release')
    readiness(record['sha'], attempts=1)
    readiness(record['sha'], 'https://api.homemind.vn/v1', attempts=1)
    return {'runtime_environment_match': True, 'migration_revision': sorted(migrations)[-1],
            'migration_state': 'MATCH', 'https_health': 'PASS'}

def verified_status(record, environments):
    """Attest only the committed, unchanged environment; never return its bytes."""
    migration_recovery.require_no_pending(ROOT)
    require_committed_environment(record, environments)
    active = environments.current()
    if active is not None:
        environments.candidate(active)
    return {**record, 'active_env_revision': active, 'environment_state': 'COMMITTED' if active else 'LEGACY_UNVERSIONED',
            'pending_env_activation': False, 'rollback_available': bool(active),
            **verify_running_release(record)} if record else {'status': 'not deployed'}

def deploy(payload):
    validate_payload(payload)
    os.umask(0o077)
    with open('/run/lock/homemind-deploy.lock','a') as lock:
        fcntl.flock(lock,fcntl.LOCK_EX)
        check_authorization(payload)
        migration_recovery.require_no_pending(ROOT)
        if shutil.disk_usage(ROOT).free < 4*1024**3: raise RuntimeError('Insufficient free disk')
        previous=read_release()
        environments=Revisions()
        require_expected_environment(payload['env_revision'], previous, environments)
        # CI reuses exactly the active environment. Future environment changes
        # use the explicit root activation transaction, not a deploy fallback.
        environments.candidate(payload['env_revision'])
        record={key:payload[key] for key in ['repository','sha','run_id','api_image','migration_image','database_image','env_revision']}
        compose(record,'config','--quiet')
        registry=pathlib.Path(tempfile.mkdtemp(prefix='homemind-registry-',dir='/run'))
        docker_env={**os.environ,'DOCKER_CONFIG':str(registry)}
        try:
            run(['docker','login','ghcr.io','--username','PRM392-HOMEMIND','--password-stdin'],env=docker_env,input=payload['token'].encode())
            for key in ['api_image','migration_image','database_image']: run(['docker','pull',record[key]],env=docker_env)
        finally:
            # Owned tmpfs credential directory only; never retain an Actions token.
            shutil.rmtree(registry)
        for key in ['api_image','migration_image','database_image']:
            info=json.loads(run(['docker','image','inspect',record[key]]))[0]
            if info['Config']['Labels'].get('org.opencontainers.image.revision')!=record['sha'] or info['Config']['Labels'].get('org.opencontainers.image.source')!='https://github.com/'+REPOSITORY: raise RuntimeError('Image revision/source mismatch')
            if key!='database_image' and not non_root_user(info['Config'].get('User')): raise RuntimeError('Image must run non-root')
        compose(record,'up','-d','--wait','--wait-timeout','120','db')
        db=backup.database_container()
        uid=run(['docker','exec',db,'awk','/^Uid:/ {print $2}','/proc/1/status']).strip()
        if not uid.isdigit() or int(uid)==0: raise RuntimeError('PostgreSQL process must run non-root')
        record['migrations']=migrate_policy(record['migration_image'],db)
        record['backup']=backup.create(db)
        forward_only=migration_recovery.required(record, previous)
        if forward_only:
            migration_recovery.begin(ROOT, record, previous)
            # Prevent legacy provider calls throughout the incompatible upgrade.
            stop_uncommitted_api()
        compose(record,'run','--rm','--no-deps','migrate')
        if forward_only: migration_recovery.verify_fence(db)
        check_freshness(payload)
        already_active=environments.current()==record['env_revision']
        try:
            changed=environments.activate(record['env_revision'])
        except Exception:
            # Covers interrupted activation before the promoter was entered.
            journal=environments.revisions/(record['env_revision']+'.rollback.json')
            if not already_active and journal.exists(): restore_previous(record, previous, promote, environments)
            raise
        promote_or_rollback(record, previous, environments=environments if changed else None)
        record=commit_release(record, environments if changed else None)
        if forward_only:
            verify_running_release(record)
            migration_recovery.finish(ROOT, record)
        print(json.dumps({'status':'deployed','sha':record['sha'],'env_revision':record['env_revision'],'api_image':record['api_image'],'migration_image':record['migration_image']}))

def commit_release(record, environments=None):
    record={**record,'deployed_at':datetime.datetime.now(datetime.timezone.utc).isoformat()}
    archive=ROOT/'releases'
    archive.mkdir(exist_ok=True)
    write_release(record, archive / ((record['deployed_at'].replace(':','-'))+'-'+record['sha']+'.json'))
    write_release(record)
    if environments and environments.activation_pending()==record['env_revision']:
        environments.finish_activation(record['env_revision'], record)
    return record

def main():
    operation=sys.argv[1] if len(sys.argv)==2 else ''
    if operation=='ping': print('HomeMind restricted deployment key: OK'); return
    if operation=='capabilities':
        print(json.dumps({'protocol':2,'env_revision':True,'commands':['ping','status','capabilities','deploy']})); return
    if operation=='status':
        # Share the activation/deployment lock so marker, journal and release
        # record belong to one committed snapshot.
        with open('/run/lock/homemind-deploy.lock','a') as lock:
            fcntl.flock(lock,fcntl.LOCK_SH)
            record=read_release()
            print(json.dumps(verified_status(record, Revisions())))
        return
    if operation!='deploy': raise ValueError('Restricted deployment command')
    raw=sys.stdin.buffer.read(32769)
    if len(raw)>32768: raise ValueError('Deployment request too large')
    deploy(json.loads(raw))

if __name__=='__main__':
    try: main()
    except Exception as error:
        # Avoid printing Docker output, injected env, token, or payload on failure.
        print(json.dumps({'status':'failed','error':str(error) if isinstance(error,(ValueError,RuntimeError)) else type(error).__name__}),file=sys.stderr)
        sys.exit(1)
