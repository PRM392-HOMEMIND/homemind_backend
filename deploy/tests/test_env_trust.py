"""Root-only env metadata, pre-mutation matching, and interrupted activation."""
import json, os, pathlib, sys, tempfile, unittest
from unittest.mock import patch
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / 'server'))
import deploy, bootstrap_env, activate_env, recover_env
from env_revisions import Revisions
from test_gates import fixture


@unittest.skipUnless(hasattr(os, 'geteuid') and os.geteuid() == 0, 'Isolated Linux root operator required')
class EnvTrustContracts(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = pathlib.Path(self.temp.name); self.root.chmod(0o700)
        self.path = self.root / 'api.env'
        self.original = b'AUTH_SECRET=test-only\nGEMINI_API_KEY=\nGEMINI_MODEL=gemini-3.5-flash-lite\n'
        self.path.write_bytes(self.original); self.path.chmod(0o600)
        self.env = Revisions(self.root)
        self.state = self.root / 'release.json'
        self.record = {key: value for key, value in fixture().items() if key not in ['token', 'env_revision']}
        self.record.update(migrations=[], deployed_at='test-round')
        self.state.write_text(json.dumps(self.record))
        archive = self.root / 'releases'; archive.mkdir()
        (archive / ('test-' + self.record['sha'] + '.json')).write_text(json.dumps(self.record))
        self.stack = []
        for target in [deploy, bootstrap_env, activate_env, recover_env]:
            p = patch.object(target, 'open', create=True, side_effect=lambda *a, **k: (self.root / 'lock').open('a'))
            self.stack.append(p); p.start()
        for p in [patch.object(deploy, 'ROOT', self.root), patch.object(deploy, 'STATE', self.state),
                  patch.object(recover_env, 'STATE', self.state), patch.object(bootstrap_env, 'Revisions', return_value=self.env),
                  patch.object(activate_env, 'Revisions', return_value=self.env), patch.object(recover_env, 'Revisions', return_value=self.env)]:
            self.stack.append(p); p.start()
    def tearDown(self):
        for p in reversed(self.stack): p.stop()
        self.temp.cleanup()
    def initialize(self):
        with patch.object(deploy, 'verify_running_release', return_value={}):
            result = bootstrap_env.bootstrap(self.record['sha'])
        self.record = json.loads(self.state.read_text())
        return result['env_revision']
    def staged(self):
        return self.env.stage({'GEMINI_API_KEY': 'test-only-candidate-credential-123', 'GEMINI_MODEL': 'gemini-3.5-flash-lite'})

    def test_explicit_bootstrap_versions_only_verified_legacy_bytes_once(self):
        inode = self.path.stat().st_ino
        revision = self.initialize()
        self.assertEqual(self.env.current(), revision)
        self.assertEqual(self.record['env_revision'], revision)
        self.assertEqual(self.path.read_bytes(), self.original)
        self.assertEqual(self.path.stat().st_ino, inode)
        self.assertFalse((self.root / 'bootstrap-pending').exists())
        with patch.object(deploy, 'verify_running_release'):
            with self.assertRaisesRegex(ValueError, 'one-time'): bootstrap_env.bootstrap(self.record['sha'])

    def test_bootstrap_rejects_unhealthy_or_inconsistent_production_without_metadata_write(self):
        with patch.object(deploy, 'verify_running_release', side_effect=ValueError('Not healthy')):
            with self.assertRaises(ValueError): bootstrap_env.bootstrap(self.record['sha'])
        self.assertIsNone(self.env.current()); self.assertEqual(list(self.env.revisions.iterdir()), [])
        with self.assertRaises(ValueError): bootstrap_env.bootstrap('f' * 40)
        archive = next((self.root / 'releases').iterdir()); archive.write_text('{}')
        with self.assertRaisesRegex(ValueError, 'archive'): bootstrap_env.bootstrap(self.record['sha'])
        self.assertEqual(self.path.read_bytes(), self.original)

    def test_interrupted_bootstrap_blocks_regular_gate_until_explicit_recovery(self):
        with patch.object(deploy, 'verify_running_release', return_value={}), patch.object(deploy, 'write_release', side_effect=RuntimeError('Crash')):
            with self.assertRaises(RuntimeError): bootstrap_env.bootstrap(self.record['sha'])
        revision = self.env.active()
        with self.assertRaisesRegex(ValueError, 'bootstrap pending'): self.env.current()
        with self.assertRaises(ValueError): deploy.require_expected_environment(revision, self.record, self.env)
        with patch.object(deploy, 'verify_running_release', return_value={}): bootstrap_env.bootstrap(self.record['sha'], recover=True)
        self.assertEqual(self.env.current(), revision)
        self.assertEqual(self.path.read_bytes(), self.original)

    def test_bootstrap_recovery_refuses_changed_environment(self):
        self.env.begin_bootstrap(self.record['sha'])
        self.path.write_bytes(self.original + b'CHANGED=test-only\n')
        with self.assertRaisesRegex(ValueError, 'no longer matches'): self.env.resume_bootstrap(self.record['sha'])
        with self.assertRaises(ValueError): self.env.current()

    def test_matching_current_revision_passes_and_missing_or_mismatch_fail_closed(self):
        with self.assertRaises(ValueError): deploy.require_expected_environment('env-' + 'b'*32, self.record, self.env)
        revision = self.initialize()
        self.assertEqual(deploy.require_expected_environment(revision, self.record, self.env), revision)
        for value in [None, '', 'bad', 'env-' + 'b'*32]:
            with self.assertRaises(ValueError): deploy.require_expected_environment(value, self.record, self.env)
        (self.root / 'active-env-revision').unlink()
        with self.assertRaises(RuntimeError): deploy.require_expected_environment(revision, self.record, self.env)

    def test_mismatch_blocks_before_docker_migration_or_backup(self):
        self.initialize(); payload = fixture()
        from types import SimpleNamespace
        with patch.object(deploy, 'Revisions', return_value=self.env), patch.object(deploy, 'check_authorization'), \
             patch.object(deploy.shutil, 'disk_usage', return_value=SimpleNamespace(free=5*1024**3)), \
             patch.object(deploy, 'compose') as compose, patch.object(deploy, 'run') as run, patch.object(deploy.backup, 'create') as backup:
            with self.assertRaisesRegex(ValueError, 'does not match'): deploy.deploy(payload)
            compose.assert_not_called(); run.assert_not_called(); backup.assert_not_called()

    def test_active_marker_waits_for_environment_write_and_pending_requires_recovery(self):
        prior = self.initialize(); revision = self.staged(); atomic = self.env.atomic
        def interrupted(path, data):
            if path.name == 'api.env': raise RuntimeError('Crash before env write')
            atomic(path, data)
        with patch.object(self.env, 'atomic', side_effect=interrupted):
            with self.assertRaises(RuntimeError): self.env.activate(revision)
        self.assertEqual(self.env.active(), prior)
        self.assertEqual(self.path.read_bytes(), self.original)
        self.assertEqual(self.env.activation_pending(), revision)
        with self.assertRaisesRegex(ValueError, 'activation pending'): deploy.require_expected_environment(prior, self.record, self.env)
        with patch.object(recover_env, 'promote') as promote: recover_env.recover(revision)
        promote.assert_called_once_with(self.record)
        self.assertEqual(self.env.current(), prior)

    def test_rollback_restores_previous_image_code_and_env_before_journal_release(self):
        prior = self.initialize(); revision = self.staged()
        self.env.activate(revision)
        def promoter(record):
            self.assertEqual(record, self.record)
            self.assertEqual(self.path.read_bytes(), self.original)
            self.assertEqual(self.env.active(), prior)
            with self.assertRaisesRegex(ValueError, 'recovery pending'): self.env.current()
        deploy.restore_previous({'env_revision': revision}, self.record, promoter, self.env)
        self.assertEqual(self.env.current(), prior)
        self.assertFalse((self.root / 'activation-pending').exists())

    def test_activation_commits_only_after_healthy_current_api(self):
        prior = self.initialize(); revision = self.staged()
        def healthy(record):
            self.assertEqual(self.env.active(), revision)
            self.assertEqual(json.loads(self.state.read_text())['env_revision'], prior)
            with self.assertRaises(ValueError): self.env.current()
        with patch.object(deploy, 'verify_running_release'), patch.object(deploy, 'promote', side_effect=healthy):
            activate_env.activate(revision)
        self.assertEqual(self.env.current(), revision)
        self.assertEqual(json.loads(self.state.read_text())['env_revision'], revision)

    def test_committed_activation_crash_requires_health_revalidation_before_releasing_pending(self):
        self.initialize(); revision = self.staged(); self.env.activate(revision)
        committed = {**self.record, 'env_revision': revision}; deploy.write_release(committed)
        with patch.object(recover_env, 'verify_running_release', side_effect=ValueError('Runtime mismatch')):
            with self.assertRaises(ValueError): recover_env.recover(revision)
        self.assertEqual(self.env.activation_pending(), revision)
        with patch.object(recover_env, 'verify_running_release'), patch.object(recover_env, 'promote') as promote:
            recover_env.recover(revision)
            promote.assert_not_called()
        self.assertEqual(self.env.current(), revision)

    def test_recovery_rejects_previous_release_env_relationship_mismatch(self):
        self.initialize(); revision = self.staged(); self.env.activate(revision)
        deploy.write_release({**self.record, 'env_revision': 'env-' + 'f'*32})
        with patch.object(recover_env, 'promote') as promote:
            with self.assertRaisesRegex(ValueError, 'do not match'): recover_env.recover(revision)
            promote.assert_not_called()

    def test_release_metadata_interruption_and_unsafe_ownership_fail_closed(self):
        self.state.with_suffix('.new').write_text('{}')
        with self.assertRaisesRegex(ValueError, 'Interrupted'): deploy.read_release()
        self.state.with_suffix('.new').unlink()
        self.state.chmod(0o666)
        with self.assertRaisesRegex(ValueError, 'Unsafe'): deploy.read_release()

    def test_rollback_preserves_compatible_applied_migration_revision_in_previous_release(self):
        prior = self.initialize()
        applied = [{'name': '20261004000000_test_only_additive', 'checksum': 'b'*64, 'compatible': True}]
        with patch.object(deploy, 'promote'):
            deploy.restore_previous({'env_revision': prior, 'migrations': applied}, self.record, lambda r: None, None)
        saved = deploy.read_release()
        for field in ['sha', 'api_image', 'env_revision']:
            self.assertEqual(saved[field], self.record[field])
        self.assertEqual(saved['migrations'], applied)

    def runtime_fixture(self):
        record = {**self.record, 'migrations': [{'name':'20261003000000_test', 'checksum':'c'*64}]}
        actual = {'State': {'Running': True}, 'Config': {'Image': record['api_image'], 'Env': ['AUTH_SECRET=test-only'],
                  'Labels': {'com.docker.compose.project.working_dir':str(self.root),
                             'com.docker.compose.project.config_files':str(self.root/'compose.yaml')}}}
        images = [json.dumps([{'RepoDigests':[record[key]], 'Config':{'Labels':{
                  'org.opencontainers.image.revision':record['sha'], 'org.opencontainers.image.source':'https://github.com/'+deploy.REPOSITORY}}}]).encode()
                  for key in ['api_image', 'migration_image', 'database_image']]
        return record, actual, images

    def test_read_only_runtime_attestation_checks_loaded_env_images_migrations_and_health(self):
        record, actual, images = self.runtime_fixture()
        outputs = [json.dumps([actual]).encode(), *images, ('20261003000000_test|'+'c'*64+'\n').encode()]
        with patch.object(deploy, 'compose', side_effect=[b'abcdef\n',json.dumps({'services':{'api':{'environment':{'AUTH_SECRET':'test-only'}}}}).encode()]), \
             patch.object(deploy, 'run', side_effect=outputs), patch.object(deploy.backup, 'database_container', return_value='owned-db'), \
             patch.object(deploy, 'readiness') as health:
            result = deploy.verify_running_release(record)
            self.assertTrue(result['runtime_environment_match']);self.assertEqual(result['migration_state'],'MATCH')
            self.assertEqual(health.call_count,2)

    def test_runtime_environment_mismatch_is_rejected_without_secret_output(self):
        record, actual, images = self.runtime_fixture()
        with patch.object(deploy, 'compose', side_effect=[b'abcdef\n',json.dumps({'services':{'api':{'environment':{'AUTH_SECRET':'different-test-only'}}}}).encode()]), \
             patch.object(deploy, 'run', return_value=json.dumps([actual]).encode()):
            with self.assertRaisesRegex(ValueError, '^Running API environment does not match current trusted configuration$'):
                deploy.verify_running_release(record)


if __name__ == '__main__': unittest.main()
