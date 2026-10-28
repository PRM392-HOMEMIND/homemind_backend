#!/usr/bin/env python3
"""Root operator maintenance; immutable active migrator, approved retention only."""
import json, os, pathlib, subprocess, sys

sys.path.insert(0,str(pathlib.Path(__file__).resolve().parent))
from deploy import ROOT, compose_env, read_release, verified_status
from env_revisions import Revisions

def maintain():
    if os.geteuid()!=0:raise ValueError('Root operator required')
    record=read_release()
    if not record:raise ValueError('Committed release required')
    verified_status(record,Revisions())
    request={'operation':'prune-audit','retentionDays':90,'maxRows':5000}
    command=['docker','compose','--project-directory',str(ROOT),'-f',str(ROOT/'compose.yaml'),
             'run','--rm','--no-deps','-T','--entrypoint','node','migrate','scripts/admin-audit-maintain.cjs']
    # No secrets in command/output; Compose reads the existing protected migration env.
    result=subprocess.run(command,input=json.dumps(request),text=True,env=compose_env(record),capture_output=True,timeout=60)
    if result.returncode:raise ValueError('Maintenance failed; values withheld')
    payload=json.loads(result.stdout)
    if set(payload)!={'status','removed','expiredSessionsRemoved','retentionDays','maxRows'} or payload['status']!='PRUNED_APPROVED_RETENTION' or payload['retentionDays']!=90 or payload['maxRows']!=5000:
        raise ValueError('Unexpected maintenance result')
    for key in ['removed','expiredSessionsRemoved']:
        if not isinstance(payload[key],int) or isinstance(payload[key],bool) or not 0<=payload[key]<=5000:raise ValueError('Invalid bounded count')
    return payload

if __name__=='__main__':
    try:print(json.dumps(maintain()))
    except Exception:
        print('ADMIN_MAINTENANCE_FAILED_VALUES_WITHHELD',file=sys.stderr);sys.exit(1)
