#!/usr/bin/env python3
"""Explicit root-only recovery; the forced SSH gate never accepts this command."""
import fcntl, json, re, sys
from migration_recovery import recover

if __name__ == '__main__':
    try:
        if len(sys.argv) != 2 or not re.fullmatch('[0-9a-f]{40}', sys.argv[1]):
            raise ValueError('Expected exact recorded candidate SHA')
        with open('/run/lock/homemind-deploy.lock', 'a') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)
            print(json.dumps(recover(sys.argv[1])))
    except Exception:
        print('{"status":"failed","error":"Forward migration recovery refused; trusted journal retained"}', file=sys.stderr)
        sys.exit(1)
