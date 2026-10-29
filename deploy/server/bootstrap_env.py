#!/usr/bin/env python3
"""Explicit root-only one-time version metadata for verified legacy production."""
import fcntl, json, pathlib, sys
import deploy
from env_revisions import Revisions


def bootstrap(expected_sha, recover=False):
    with open('/run/lock/homemind-deploy.lock', 'a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        record = deploy.read_release()
        if not record: raise ValueError('Missing current legacy release')
        if record.get('sha') != expected_sha:
            raise ValueError('Bootstrap requires the exact verified current release')
        environments = Revisions()
        if environments.pending() or environments.activation_pending():
            raise ValueError('Environment activation/recovery must finish before bootstrap')
        if not recover and (record.get('env_revision') or environments.current()):
            raise ValueError('Environment already initialized; bootstrap is one-time only')
        # Check the existing archive, actual immutable images, running env,
        # migration state and local/public readiness before any metadata write.
        archives = list((deploy.ROOT / 'releases').glob('*-' + expected_sha + '.json'))
        matches = [json.loads(path.read_text()) for path in archives]
        fields = ['sha', 'api_image', 'migration_image', 'database_image', 'migrations', 'deployed_at']
        if not any(all(item.get(key) == record.get(key) for key in fields) for item in matches):
            raise ValueError('Current production archive is missing or inconsistent')
        deploy.verify_running_release(record)
        revision = environments.resume_bootstrap(expected_sha) if recover else environments.begin_bootstrap(expected_sha)
        if record.get('env_revision') not in [None, revision]:
            raise ValueError('Release changed during bootstrap recovery')
        updated = {**record, 'env_revision': revision}
        deploy.write_release(updated)
        environments.finish_bootstrap(revision, updated)
        result = deploy.verified_status(updated, environments)
        return {'status': 'BOOTSTRAPPED_CURRENT_ENV_METADATA', 'sha': expected_sha,
                'env_revision': revision, 'active_env_revision': result['active_env_revision'],
                'secrets_changed': False, 'environment_values_changed': False}


if __name__ == '__main__':
    try:
        if len(sys.argv) not in [2, 3] or (len(sys.argv) == 3 and sys.argv[2] != '--recover'):
            raise ValueError('Expected current release SHA and optional explicit --recover')
        print(json.dumps(bootstrap(sys.argv[1], len(sys.argv) == 3)))
    except Exception as error:
        print(json.dumps({'status': 'failed', 'error': str(error) if isinstance(error, ValueError) else type(error).__name__}), file=sys.stderr)
        sys.exit(1)
