#!/usr/bin/env python3
"""One-time server-owned secrets; reruns preserve passwords and JWT signing keys."""
import os, pathlib, re, secrets, subprocess

root=pathlib.Path('/etc/homemind')
os.umask(0o077); root.mkdir(mode=0o700,exist_ok=True)
gid=int(subprocess.check_output(['docker','run','--rm','--entrypoint','id','postgres:18-trixie@sha256:5a5a84b19854a9ffaa54082c166ff4ec27473a361e496e5ea167f298f2da9722','-g','postgres']))
passwords={}
for role in ['admin','migrator','app']:
    path=root/('db-'+role+'-password')
    if not path.exists():
        fd=os.open(path,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o640)
        with os.fdopen(fd,'w') as writer: writer.write(secrets.token_hex(32)+'\n')
    password=path.read_text().strip()
    if not re.fullmatch('[0-9a-f]{64}',password): raise RuntimeError('Unexpected existing role credential format')
    os.chown(path,0,gid); path.chmod(0o640); passwords[role]=password
api=root/'api.env'; migration=root/'migration.env'
if not api.exists():
    settings={
        'NODE_ENV':'production','HOST':'0.0.0.0','PORT':'3000',
        'DATABASE_URL':f'postgresql://homemind_app:{passwords["app"]}@db:5432/homemind?connect_timeout=5&pool_timeout=5',
        'AUTH_ACCESS_SECRET':secrets.token_hex(32),'AUTH_REFRESH_SECRET':secrets.token_hex(32),'AUTH_RESET_SECRET':secrets.token_hex(32),
        'AUTH_ISSUER':'https://api.homemind.vn','AUTH_AUDIENCE':'homemind-mobile',
        'AUTH_REQUIRE_VERIFICATION':'false','AUTH_DEV_RESET_DELIVERY':'false','AUTH_RATE_LIMIT':'20',
        'TRUSTED_PROXY_IP':'172.28.42.1','GEMINI_API_KEY':'','GEMINI_MODEL':'gemini-3.5-flash-lite',
    }
    api.write_text('\n'.join(key+'='+value for key,value in settings.items())+'\n'); api.chmod(0o600)
if not migration.exists():
    url=f'postgresql://homemind_migrator:{passwords["migrator"]}@db:5432/homemind'
    migration.write_text('NODE_ENV=production\nDATABASE_URL='+url+'\nMIGRATION_DATABASE_URL='+url+'\n'); migration.chmod(0o600)
key=root/'backup-passphrase'
if not key.exists(): key.write_text(secrets.token_hex(32)+'\n'); key.chmod(0o600)
print('Server-owned DB/auth/backup secrets created or preserved. Gemini disabled pending a clean provider key.')
