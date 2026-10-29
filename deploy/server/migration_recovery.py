"""Durable forward recovery for explicitly reviewed, fenced schema changes.

No database down migration and no restoration of an API that bypasses quota.
The journal holds only release identities and an encrypted backup reference.
"""
import datetime, json, pathlib

POLICY = 'FENCED_FORWARD_ONLY'
FENCE = 'ASSISTANT_QUOTA_V2_FENCE'


def journal_path(root):
    return pathlib.Path(root) / 'migration-recovery.json'


def require_no_pending(root):
    path = journal_path(root)
    if path.exists() or path.is_symlink():
        raise RuntimeError('Fenced migration recovery pending; explicit root forward recovery required')


def required(record, previous):
    applied = {item['name'] for item in (previous or {}).get('migrations', [])}
    return any(item.get('recovery') == POLICY and item['name'] not in applied
               for item in record.get('migrations', []))


def begin(root, record, previous):
    import deploy
    require_no_pending(root)
    if not required(record, previous) or not record.get('backup'):
        raise ValueError('Forward recovery requires a reviewed migration and verified backup')
    if 'token' in record or 'token' in (previous or {}):
        raise ValueError('Credential-bearing recovery record refused')
    deploy.write_release({'policy': POLICY, 'candidate': record, 'previous': previous,
                          'created_at': datetime.datetime.now(datetime.timezone.utc).isoformat()},
                         journal_path(root))


def verify_fence(db):
    import deploy
    sql = """select
      obj_description('public.create_assistant_turn(uuid,text,text,text,jsonb,jsonb,jsonb,text,integer)'::regprocedure,'pg_proc')='ASSISTANT_QUOTA_V2_FENCE'
      and not has_function_privilege('homemind_app','public.create_assistant_turn_unmetered_v1(uuid,text,text,text,jsonb,jsonb,jsonb,text,integer)','EXECUTE')
      and has_function_privilege('homemind_app','public.assistant_quota_admit(uuid,uuid,text)','EXECUTE')
      and has_function_privilege('homemind_app','public.assistant_quota_assert_lease(uuid,uuid)','EXECUTE')"""
    if deploy.run(['docker', 'exec', db, 'psql', '-U', 'postgres', '-d', 'homemind', '-Atc', sql]).strip() != b't':
        raise RuntimeError('Required quota persistence fence is missing')


def finish(root, record):
    import deploy
    path = journal_path(root)
    journal = deploy.read_release(path)
    committed = deploy.read_release(pathlib.Path(root) / 'release.json')
    if not journal or not committed or journal['candidate']['sha'] != record['sha']:
        raise ValueError('Forward recovery journal does not match committed candidate')
    for key in ['sha', 'api_image', 'migration_image', 'database_image', 'env_revision', 'migrations']:
        if committed.get(key) != record.get(key):
            raise ValueError('Forward recovery release is not durably committed')
    path.unlink()
    import os
    descriptor = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def recover(expected_sha):
    """Root operator only; recover the already authorized immutable candidate."""
    import deploy
    from env_revisions import Revisions
    journal = deploy.read_release(journal_path(deploy.ROOT))
    if not journal or journal.get('policy') != POLICY:
        raise ValueError('No trusted fenced migration recovery journal')
    record = journal['candidate']
    if record.get('sha') != expected_sha or not required(record, journal.get('previous')):
        raise ValueError('Recovery must use the exact recorded candidate')
    current = deploy.read_release()
    allowed = [record['sha'], (journal.get('previous') or {}).get('sha')]
    if current and current.get('sha') not in allowed:
        raise ValueError('Committed release changed after this recovery began')
    environments = Revisions()
    if environments.pending() or environments.bootstrap_pending():
        raise ValueError('Unrelated environment recovery must be resolved first')
    activation = environments.activation_pending()
    if activation not in [None, record['env_revision']]:
        raise ValueError('Unrelated environment activation must be resolved first')
    if activation is None: environments.candidate(record['env_revision'])
    deploy.backup.verify(record['backup'])
    for key in ['api_image', 'migration_image', 'database_image']:
        info = json.loads(deploy.run(['docker', 'image', 'inspect', record[key]]))[0]
        labels = info['Config'].get('Labels') or {}
        if record[key] not in info.get('RepoDigests', []) or labels.get('org.opencontainers.image.revision') != record['sha'] or labels.get('org.opencontainers.image.source') != 'https://github.com/' + deploy.REPOSITORY:
            raise ValueError('Forward recovery image identity mismatch')
    deploy.stop_uncommitted_api()
    db = deploy.backup.database_container()
    actual = deploy.migrate_policy(record['migration_image'], db)
    if actual != record['migrations']:
        raise ValueError('Forward recovery migration identity mismatch')
    deploy.compose(record, 'run', '--rm', '--no-deps', 'migrate')
    verify_fence(db)
    if activation:
        environments.resume_activation(record['env_revision'])
    elif environments.active() != record['env_revision']:
        environments.activate(record['env_revision'])
    deploy.promote(record)
    record = deploy.commit_release(record, environments)
    deploy.verify_running_release(record)
    finish(deploy.ROOT, record)
    return {'status': 'recovered_tested_forward_candidate', 'sha': record['sha'],
            'database': 'preserved', 'legacy_api_restored': False}
