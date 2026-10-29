#!/usr/bin/env python3
"""Root-only prepare of a dedicated runtime role. No source/env activation or bootstrap."""
import json,os,pathlib,re,secrets,subprocess,sys
from urllib.parse import urlsplit,urlunsplit
from env_revisions import Revisions

def prepare(root=pathlib.Path('/etc/homemind')):
    revisions=Revisions(root);revisions.current()
    path=revisions.root/'db-admin-reader-password'
    # Never rotate on redeploy. Existing metadata must agree with the actual role.
    existed=path.exists()
    password=revisions.read(path).decode().strip() if existed else secrets.token_hex(32)
    if not re.fullmatch(r'[a-f0-9]{64}',password):raise ValueError('Unsafe admin-reader metadata')
    before=revisions.read(revisions.root/'api.env')
    values=dict(line.split('=',1) for line in before.decode().splitlines() if '=' in line and not line.startswith('#'))
    db=urlsplit(values['DATABASE_URL'])
    if db.username!='homemind_app' or db.path!='/homemind':raise ValueError('Unexpected production database')
    # Reuse the actual trusted release-state Compose convention; no invented env file.
    from deploy import compose_env,ROOT,read_release,verified_status
    record=read_release()
    if not record:raise ValueError('A committed production baseline is required')
    verified_status(record,revisions)
    command=['docker','compose','--project-directory',str(ROOT),'-f',str(ROOT/'compose.yaml'),'exec','-T','db','psql','-U','postgres','-d','homemind','-v','ON_ERROR_STOP=1']
    command_env=compose_env(record)
    found=subprocess.run(command+['-Atc',"SELECT count(*) FROM pg_roles WHERE rolname='homemind_admin_api'"],env=command_env,capture_output=True,text=True,check=True).stdout.strip()
    if found=='1' and not existed:raise ValueError('Existing admin role without trusted credential; manual recovery required')
    if found=='0':
        # Journal credential before creating role; a retry uses the same value.
        if not existed:revisions.atomic(path,(password+'\n').encode())
        sql="CREATE ROLE homemind_admin_api LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD '"+password+"';\n"
        subprocess.run(command,input=sql,env=command_env,text=True,check=True,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
    elif found!='1':raise ValueError('Invalid role count')
    check=subprocess.run(command+['-Atc',"SELECT (rolcanlogin AND NOT rolsuper AND NOT rolbypassrls AND NOT rolcreaterole AND NOT rolcreatedb AND NOT rolinherit AND NOT rolreplication AND (rolvaliduntil IS NULL OR rolvaliduntil > now()) AND NOT EXISTS(SELECT 1 FROM pg_auth_members WHERE member=pg_roles.oid)) FROM pg_roles WHERE rolname='homemind_admin_api'"],env=command_env,capture_output=True,text=True,check=True).stdout.strip()
    if check!='t':raise ValueError('Unsafe existing admin runtime role')
    subprocess.run(command+['-c','GRANT CONNECT ON DATABASE homemind TO homemind_admin_api'],env=command_env,check=True,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
    # Verify trusted metadata against real password authentication without
    # placing the password on process arguments or returning it in diagnostics.
    authenticate=command[:command.index('psql')]+['sh','-c','IFS= read -r PGPASSWORD; export PGPASSWORD; exec psql --no-psqlrc -h 127.0.0.1 -U homemind_admin_api -d homemind -Atc "SELECT current_user"']
    authenticated=subprocess.run(authenticate,input=password+'\n',env=command_env,capture_output=True,text=True)
    if authenticated.returncode or authenticated.stdout.strip()!='homemind_admin_api':raise ValueError('Admin-reader credential verification failed; recovery required')
    target=urlunsplit((db.scheme,'homemind_admin_api:'+password+'@'+db.netloc.split('@',1)[1],db.path,'',''))
    revision=revisions.stage({'ADMIN_DATABASE_URL':target,'ADMIN_WEB_ORIGINS':'https://homemind.vn'})
    return {'status':'STAGED_ONLY','revision':revision,'role':'homemind_admin_api','secretValuesPrinted':False}

if __name__=='__main__':
    try:print(json.dumps(prepare()))
    except Exception:sys.exit('ADMIN_ROLE_PREPARATION_FAILED_VALUES_WITHHELD')
