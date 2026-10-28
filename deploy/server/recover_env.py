#!/usr/bin/env python3
"""Existing root operator recovers an interrupted, uncommitted env activation.

No generic SSH command, arbitrary image, DB restore or down migration is accepted.
The exact previous recorded API is recreated only after its env is restored.
"""
import fcntl, json, sys
import migration_recovery
import deploy
from deploy import STATE, promote, restore_previous, verify_running_release, read_release
from env_revisions import Revisions, valid_revision

def recover(revision):
    valid_revision(revision)
    environments=Revisions()
    with open('/run/lock/homemind-deploy.lock','a') as lock:
        fcntl.flock(lock,fcntl.LOCK_EX)
        migration_recovery.require_no_pending(deploy.ROOT)
        previous=read_release(STATE)
        if previous and previous.get('env_revision')==revision:
            if environments.activation_pending()!=revision or environments.pending():
                raise ValueError('Refusing to roll back a committed environment revision')
            verify_running_release(previous)
            environments.finish_activation(revision, previous)
            print(json.dumps({'status':'recovered_committed_environment','sha':previous['sha']}))
            return
        if previous is None:
            journal=json.loads(environments.read(environments.revisions/(revision+'.rollback.json')))
            if journal['prior'] is not None:raise ValueError('Missing prior release record; recovery requires the recorded API')
        else:
            journal=json.loads(environments.read(environments.revisions/(revision+'.rollback.json')))
            if journal['prior'] != previous.get('env_revision'):
                raise ValueError('Previous release and rollback environment do not match')
        restore_previous({'env_revision':revision},previous,promote,environments)
    print(json.dumps({'status':'recovered_previous_api_and_environment' if previous else 'recovered_first_deployment_stopped_api','sha':previous['sha'] if previous else None,'database':'preserved'}))

if __name__=='__main__':
    try:
        if len(sys.argv)!=2:raise ValueError('Expected one public failed environment revision')
        recover(sys.argv[1])
    except Exception:
        print('{"status":"failed","error":"Environment recovery rejected; private details suppressed"}',file=sys.stderr);sys.exit(1)
