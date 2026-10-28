"""Fenced forward recovery; an incompatible schema never returns legacy API."""
import json, os, pathlib, sys, tempfile, unittest
from unittest.mock import patch
sys.path.insert(0,str(pathlib.Path(__file__).resolve().parents[1]/'server'))
import deploy, migration_recovery, recover_env
from env_revisions import Revisions


@unittest.skipUnless(hasattr(os,'geteuid') and os.geteuid()==0,'Owned Linux root operator required')
class MigrationRecoveryContracts(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.root=pathlib.Path(self.tmp.name);self.root.chmod(0o700)
        self.previous={'sha':'a'*40,'migrations':[{'name':'legacy','checksum':'0'*64,'compatible':True}]}
        self.record={'sha':'b'*40,'api_image':'tested-api','migration_image':'tested-migrate','database_image':'tested-db',
            'env_revision':'env-'+'e'*32,'backup':'/private/encrypted-backup.dump.enc',
            'migrations':self.previous['migrations']+[{'name':'quota-v2','checksum':'1'*64,'compatible':False,
                'recovery':migration_recovery.POLICY,'fence':migration_recovery.FENCE}]}
        self.patches=[patch.object(deploy,'ROOT',self.root),patch.object(deploy,'STATE',self.root/'release.json')]
        for p in self.patches:p.start()
        deploy.write_release(self.previous)
    def tearDown(self):
        for p in reversed(self.patches):p.stop()
        self.tmp.cleanup()
    def begin(self):migration_recovery.begin(self.root,self.record,self.previous)
    def test_journal_predates_mutation_is_root_only_and_blocks_regular_deploy(self):
        self.begin();path=migration_recovery.journal_path(self.root)
        self.assertEqual(path.stat().st_mode & 0o777,0o600)
        self.assertEqual(json.loads(path.read_text())['candidate'],self.record)
        with self.assertRaisesRegex(RuntimeError,'pending'):migration_recovery.require_no_pending(self.root)
        with self.assertRaises(RuntimeError):self.begin()
    def test_incompatible_failed_promotion_never_restores_legacy_image_or_environment(self):
        self.begin();attempts=[]
        def promoter(record):attempts.append(record['sha']);raise RuntimeError('Unhealthy')
        with patch.object(deploy,'stop_uncommitted_api') as stop:
            with self.assertRaisesRegex(RuntimeError,'legacy API rollback refused'):
                deploy.promote_or_rollback(self.record,self.previous,promoter)
            stop.assert_called_once()
        self.assertEqual(attempts,[self.record['sha']]);self.assertTrue(migration_recovery.journal_path(self.root).exists())
        self.assertEqual(deploy.read_release(),self.previous)
    def test_journal_cannot_release_before_committed_matching_images_env_and_migrations(self):
        self.begin()
        with self.assertRaises(ValueError):migration_recovery.finish(self.root,self.record)
        for key in ['sha','api_image','env_revision','migrations']:
            wrong={**self.record,key:[] if key=='migrations' else 'wrong'};deploy.write_release(wrong)
            with self.assertRaises(ValueError):migration_recovery.finish(self.root,self.record)
        deploy.write_release(self.record);migration_recovery.finish(self.root,self.record)
        migration_recovery.require_no_pending(self.root)
    def test_already_committed_fenced_migration_allows_future_compatible_image_rollback(self):
        self.assertFalse(migration_recovery.required(self.record,self.record))
        calls=[];deploy.restore_previous(self.record,self.record,lambda r:calls.append(r),None)
        self.assertEqual(calls,[self.record])
    def test_wrong_candidate_recovery_is_rejected_before_any_container_or_db_call(self):
        self.begin()
        with patch.object(deploy,'run') as run:
            with self.assertRaisesRegex(ValueError,'exact recorded'):migration_recovery.recover('c'*40)
            run.assert_not_called()
    def test_missing_quota_fence_blocks_even_after_migration_command_completed(self):
        for answer in [b'f',b'',b't\nf']:
            with patch.object(deploy,'run',return_value=answer):
                with self.assertRaisesRegex(RuntimeError,'fence'):migration_recovery.verify_fence('owned-db')
        with patch.object(deploy,'run',return_value=b't\n'):migration_recovery.verify_fence('owned-db')
    def test_environment_rollback_cannot_reintroduce_legacy_api_during_schema_recovery(self):
        self.begin()
        with patch.object(recover_env,'Revisions'), patch.object(recover_env,'open',create=True,side_effect=lambda *a,**k:(self.root/'lock').open('a')):
            with patch.object(recover_env,'restore_previous') as restore:
                with self.assertRaisesRegex(RuntimeError,'migration recovery pending'):recover_env.recover(self.record['env_revision'])
                restore.assert_not_called()
    def test_interrupted_env_activation_has_explicit_forward_resume_and_healthy_commit(self):
        root=self.root/'env';root.mkdir(mode=0o700);env=Revisions(root)
        original=b'AUTH_SECRET=private-test-only\nGEMINI_API_KEY=\nGEMINI_MODEL=gemini-3.5-flash-lite\n'
        path=env.root/'api.env';path.write_bytes(original);path.chmod(0o600)
        revision=env.stage({'GEMINI_API_KEY':'private-test-only-candidate','GEMINI_MODEL':'gemini-3.5-flash-lite'})
        atomic=env.atomic
        def interrupt(target,data):
            if target.name=='api.env':raise RuntimeError('Interrupted before env write')
            atomic(target,data)
        with patch.object(env,'atomic',side_effect=interrupt):
            with self.assertRaises(RuntimeError):env.activate(revision)
        env.resume_activation(revision)
        self.assertIn(b'AUTH_SECRET=private-test-only\n',path.read_bytes())
        self.assertEqual(env.active(),revision)
        with self.assertRaisesRegex(ValueError,'activation pending'):env.current()
        env.finish_activation(revision,{'env_revision':revision});self.assertEqual(env.current(),revision)
    def test_external_env_edit_during_interruption_is_rejected_without_overwrite(self):
        root=self.root/'env';root.mkdir(mode=0o700);env=Revisions(root)
        path=root/'api.env';path.write_bytes(b'GEMINI_API_KEY=\nGEMINI_MODEL=gemini-3.5-flash-lite\n');path.chmod(0o600)
        revision=env.stage({'GEMINI_API_KEY':'private-test-only-candidate','GEMINI_MODEL':'gemini-3.5-flash-lite'})
        env.activate(revision);path.write_bytes(path.read_bytes()+b'OWNER_CHANGE=preserve\n');before=path.read_bytes()
        with self.assertRaises(ValueError):env.resume_activation(revision)
        self.assertEqual(path.read_bytes(),before)
