#!/usr/bin/env python3
"""Explicit root-only activation of a separately staged env; keep current images."""
import fcntl, json, sys
import deploy
from env_revisions import Revisions, valid_revision


def activate(revision):
    valid_revision(revision)
    with open('/run/lock/homemind-deploy.lock', 'a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        previous = deploy.read_release()
        if not previous: raise ValueError('Missing committed current release')
        environments = Revisions()
        deploy.require_expected_environment(previous.get('env_revision'), previous, environments)
        deploy.verify_running_release(previous)
        if revision == previous['env_revision']: raise ValueError('Already active; no activation required')
        environments.candidate(revision)
        record = {**previous, 'env_revision': revision}
        try:
            environments.activate(revision)
            deploy.promote(record)
            deploy.write_release(record)
            environments.finish_activation(revision, record)
        except Exception:
            # If metadata commit completed, retain pending state for an explicit
            # committed recovery; never silently restore an unrelated release.
            current = deploy.read_release()
            if current.get('env_revision') != revision:
                journal = environments.revisions / (revision + '.rollback.json')
                if journal.exists(): deploy.restore_previous(record, previous, deploy.promote, environments)
            raise
        return {'status': 'ACTIVATED_ENVIRONMENT', 'sha': record['sha'], 'env_revision': revision}


if __name__ == '__main__':
    try:
        if len(sys.argv) != 2: raise ValueError('Expected one public staged revision')
        print(json.dumps(activate(sys.argv[1])))
    except Exception as error:
        print(json.dumps({'status': 'failed', 'error': type(error).__name__}), file=sys.stderr); sys.exit(1)
