#!/usr/bin/env python3
"""Existing root operator only: stage an inactive revision using private stdin."""
import fcntl, json, os, sys
from env_revisions import Revisions

def main():
    os.umask(0o077)
    raw = sys.stdin.buffer.read(8193)
    if len(raw) > 8192: raise ValueError('Environment staging request too large')
    with open('/run/lock/homemind-deploy.lock', 'a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        revision = Revisions().stage(json.loads(raw))
    print(json.dumps({'status': 'staged_inactive', 'env_revision': revision}))

if __name__ == '__main__':
    try: main()
    except Exception:
        print('{"status":"failed","error":"Environment staging rejected; private details suppressed"}', file=sys.stderr)
        sys.exit(1)
