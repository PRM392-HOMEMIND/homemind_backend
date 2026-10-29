import json, os, pathlib, sys, tempfile, unittest
from unittest.mock import patch
sys.path.insert(0,str(pathlib.Path(__file__).resolve().parents[1]/'server'))
from env_revisions import Revisions

@unittest.skipUnless(hasattr(os,'geteuid') and os.geteuid()==0,'Requires the isolated Linux root operator container')
class EnvironmentRevisionTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.root=pathlib.Path(self.temp.name);self.root.chmod(0o700)
        self.original=b'# preserved\nDATABASE_URL=postgresql://test-only\nAUTH_ACCESS_SECRET=test-only\nGEMINI_API_KEY=\nGEMINI_MODEL=gemini-3.5-flash-lite\n'
        self.path=self.root/'api.env';self.path.write_bytes(self.original);self.path.chmod(0o600)
        self.env=Revisions(self.root)
    def tearDown(self):self.temp.cleanup()
    def activate(self, revision):
        changed=self.env.activate(revision)
        if changed:self.env.finish_activation(revision,{"env_revision":revision})
        return changed
    def stage(self):return self.env.stage({'GEMINI_API_KEY':'test-only-placeholder-key-123456','GEMINI_MODEL':'gemini-3.5-flash-lite'})
    def test_staging_is_inactive_and_activation_preserves_auth_and_db(self):
        revision=self.stage();self.assertEqual(self.path.read_bytes(),self.original)
        self.activate(revision);self.assertEqual(self.env.current(),revision)
        self.assertIn(b'DATABASE_URL=postgresql://test-only\nAUTH_ACCESS_SECRET=test-only\n',self.path.read_bytes())
        self.assertEqual(self.path.stat().st_mode&0o777,0o600)
        self.env.rollback(revision);self.env.finish_rollback(revision);self.assertEqual(self.path.read_bytes(),self.original);self.assertIsNone(self.env.current())
    def test_dotted_provider_credential_is_bounded_and_preserves_other_settings(self):
        key='test-only.dotted-placeholder.key-123456'
        revision=self.env.stage({'GEMINI_API_KEY':key,'GEMINI_MODEL':'gemini-3.5-flash-lite'})
        self.assertEqual(self.path.read_bytes(),self.original)
        self.activate(revision)
        self.assertEqual(self.path.read_bytes(),self.original.replace(b'GEMINI_API_KEY=\n',('GEMINI_API_KEY='+key+'\n').encode()))
        self.env.rollback(revision);self.env.finish_rollback(revision);self.assertEqual(self.path.read_bytes(),self.original)
        for invalid in [key+'\r\nAUTH_ACCESS_SECRET=changed',key+' ',key+'"',key+'/', 'x'*257]:
            with self.assertRaises(ValueError):
                self.env.stage({'GEMINI_API_KEY':invalid,'GEMINI_MODEL':'gemini-3.5-flash-lite'})
        self.assertEqual(self.path.read_bytes(),self.original)
    def test_stale_base_cannot_be_activated(self):
        revision=self.stage();self.path.write_bytes(self.original+b'NEW=operator-change\n')
        with self.assertRaisesRegex(ValueError,'stale'):self.activate(revision)
    def test_unchanged_active_revision_is_reusable_without_environment_rotation(self):
        revision=self.stage();self.assertTrue(self.activate(revision))
        after=self.path.read_bytes();self.assertFalse(self.activate(revision));self.assertEqual(self.path.read_bytes(),after)
    def test_tampered_active_environment_blocks_future_deploy(self):
        revision=self.stage();self.activate(revision);self.path.write_bytes(self.path.read_bytes()+b'NEW=later\n')
        with self.assertRaisesRegex(ValueError,'outside'):self.env.candidate(revision)

    def test_status_attests_matching_active_journal_without_secret_bytes(self):
        import deploy
        revision=self.stage();self.activate(revision)
        record={'sha':'tested-source','env_revision':revision}
        with patch.object(deploy,'verify_running_release',return_value={}):result=deploy.verified_status(record,self.env)
        self.assertEqual(result['active_env_revision'],revision);self.assertEqual(result['environment_state'],'COMMITTED')
        self.assertNotIn('placeholder-key',json.dumps(result))
        self.assertNotIn('active_env_revision',record)

    def test_status_rejects_tampered_environment_before_attestation(self):
        import deploy
        revision=self.stage();self.activate(revision)
        self.path.write_bytes(self.path.read_bytes()+b'UNAPPROVED=change\n')
        with self.assertRaisesRegex(ValueError,'outside'):
            deploy.verified_status({'env_revision':revision},self.env)

    def test_status_rejects_uncommitted_active_revision(self):
        import deploy
        revision=self.stage();self.activate(revision)
        with self.assertRaisesRegex(RuntimeError,'Uncommitted'):
            deploy.verified_status({'env_revision':'env-'+'a'*32},self.env)

    def test_status_rejects_pending_first_deployment_recovery(self):
        import deploy
        revision=self.stage();self.activate(revision);self.env.rollback(revision)
        with self.assertRaisesRegex(ValueError,'recovery pending'):
            deploy.verified_status(None,self.env)

    def test_legacy_status_never_claims_an_environment_revision(self):
        import deploy
        with patch.object(deploy,'verify_running_release',return_value={}):
            result=deploy.verified_status({'sha':'legacy'},self.env)
        self.assertIsNone(result['active_env_revision']);self.assertEqual(result['environment_state'],'LEGACY_UNVERSIONED')
        self.assertEqual(deploy.verified_status(None,self.env),{'status':'not deployed'})
    def test_stale_rollback_preserves_a_later_operator_change(self):
        revision=self.stage();self.activate(revision);changed=self.path.read_bytes()+b'NEW=later\n';self.path.write_bytes(changed)
        with self.assertRaisesRegex(ValueError,'stale'):self.env.rollback(revision)
        self.assertEqual(self.path.read_bytes(),changed)
    def test_no_auth_rotation_or_multiline_injection(self):
        for changes in [{'AUTH_ACCESS_SECRET':'new'}, {'GEMINI_API_KEY':'key\nAUTH_ACCESS_SECRET=new','GEMINI_MODEL':'gemini-3.5-flash-lite'}, {'GEMINI_API_KEY':'test-only-placeholder-key-123456','GEMINI_MODEL':'gemini-different'}]:
            with self.assertRaises(ValueError):self.env.stage(changes)
        self.assertEqual(self.path.read_bytes(),self.original)
    def test_symlink_and_world_readable_secret_are_rejected(self):
        other=self.root/'other';self.path.rename(other);self.path.symlink_to(other)
        with self.assertRaises(OSError):self.stage()
        self.path.unlink();other.rename(self.path);self.path.chmod(0o644)
        with self.assertRaises(ValueError):self.stage()
    def test_failure_restores_environment_before_the_previous_api(self):
        import deploy
        revision=self.stage();self.activate(revision);attempts=[]
        def promote(record):
            attempts.append(record['sha'])
            if record['sha']=='new':raise RuntimeError('Unhealthy candidate')
            self.assertEqual(self.path.read_bytes(),self.original)
            with self.assertRaisesRegex(ValueError,'recovery pending'):self.env.current()
        with self.assertRaises(RuntimeError):deploy.promote_or_rollback({'sha':'new','env_revision':revision},{'sha':'previous'},promote,self.env)
        self.assertEqual(attempts,['new','previous']);self.assertIsNone(self.env.current())
    def test_recovery_finishes_a_rollback_interrupted_before_marker_restore(self):
        previous=self.stage();self.activate(previous)
        revision=self.env.stage({'GEMINI_API_KEY':'test-only-second-placeholder-key','GEMINI_MODEL':'gemini-3.5-flash-lite'})
        before=self.path.read_bytes();self.activate(revision)
        atomic=self.env.atomic
        def interrupted(path,data):
            if path.name=='active-env-revision':raise RuntimeError('Simulated process interruption')
            atomic(path,data)
        self.env.atomic=interrupted
        with self.assertRaises(RuntimeError):self.env.rollback(revision)
        self.assertEqual(self.path.read_bytes(),before);self.assertEqual(self.env.active(),revision)
        with self.assertRaisesRegex(ValueError,'recovery pending'):self.env.current()
        self.env.atomic=atomic;self.env.rollback(revision);self.env.finish_rollback(revision)
        self.assertEqual(self.path.read_bytes(),before);self.assertEqual(self.env.current(),previous)
    def test_uncommitted_activation_is_rejected_before_any_deployment_mutation(self):
        import deploy
        from test_gates import fixture
        revision=self.stage();self.activate(revision)
        previous={'sha':'a'*40}
        state=self.root/'release.json';state.write_text(json.dumps(previous))
        from types import SimpleNamespace
        # Use the isolated test lock, including in read-only operator containers.
        with patch.object(deploy,'open',create=True,side_effect=lambda *args,**kwargs:(self.root/'deploy.lock').open('a')),patch.object(deploy,'STATE',state),patch.object(deploy,'ROOT',self.root),patch.object(deploy,'Revisions',return_value=self.env),patch.object(deploy,'check_authorization'),patch.object(deploy.shutil,'disk_usage',return_value=SimpleNamespace(free=5*1024**3)),patch.object(deploy,'compose') as compose,patch.object(deploy,'run') as run,patch.object(deploy.backup,'create') as backup:
            with self.assertRaisesRegex(RuntimeError,'Uncommitted'):deploy.deploy(fixture())
            compose.assert_not_called();run.assert_not_called();backup.assert_not_called()
        self.assertEqual(json.loads(state.read_text()),previous)
        self.assertEqual(self.env.current(),revision)
        self.env.rollback(revision);self.env.finish_rollback(revision)
        deploy.require_committed_environment(previous,self.env)
    def test_committed_environment_can_be_reused_but_missing_marker_is_rejected(self):
        import deploy
        revision=self.stage();self.activate(revision)
        deploy.require_committed_environment({'env_revision':revision},self.env)
        self.env.rollback(revision);self.env.finish_rollback(revision)
        with self.assertRaisesRegex(RuntimeError,'Uncommitted'):deploy.require_committed_environment({'env_revision':revision},self.env)
    def test_rollback_gap_blocks_deploy_status_and_new_staging_until_prior_api_verified(self):
        import deploy
        revision=self.stage();self.activate(revision);self.env.rollback(revision)
        self.assertEqual(self.path.read_bytes(),self.original);self.assertIsNone(self.env.active())
        with self.assertRaisesRegex(ValueError,'recovery pending'):self.env.current()
        with self.assertRaisesRegex(ValueError,'recovery pending'):deploy.require_committed_environment({'sha':'previous'},self.env)
        with self.assertRaisesRegex(ValueError,'recovery pending'):self.stage()
        self.env.finish_rollback(revision);deploy.require_committed_environment({'sha':'previous'},self.env)
    def test_root_recovery_failure_is_durable_and_retry_finishes_only_after_prior_promote(self):
        import recover_env
        revision=self.stage();self.activate(revision)
        state=self.root/'release.json';state.write_text(json.dumps({'sha':'previous'}))
        with patch.object(recover_env,'STATE',state),patch.object(recover_env,'Revisions',return_value=self.env),patch.object(recover_env,'open',create=True,side_effect=lambda *a,**k:(self.root/'deploy.lock').open('a')):
            with patch.object(recover_env,'promote',side_effect=RuntimeError('Previous readiness failed')):
                with self.assertRaises(RuntimeError):recover_env.recover(revision)
            self.assertEqual(self.path.read_bytes(),self.original)
            with self.assertRaisesRegex(ValueError,'recovery pending'):self.env.current()
            def healthy(record):
                self.assertEqual(record['sha'],'previous')
                self.assertEqual(self.path.read_bytes(),self.original)
                with self.assertRaisesRegex(ValueError,'recovery pending'):self.env.current()
            with patch.object(recover_env,'promote',side_effect=healthy):recover_env.recover(revision)
        self.assertIsNone(self.env.current());self.assertFalse((self.root/'recovery-pending').exists())
    def test_activation_interruption_marks_uncommitted_before_environment_write(self):
        import deploy
        revision=self.stage();atomic=self.env.atomic
        def interrupted(path,data):
            if path.name=='api.env':raise RuntimeError('Simulated interruption before environment write')
            atomic(path,data)
        self.env.atomic=interrupted
        with self.assertRaises(RuntimeError):self.activate(revision)
        self.assertEqual(self.path.read_bytes(),self.original)
        with self.assertRaisesRegex(ValueError,'activation pending'):deploy.require_committed_environment({'sha':'previous'},self.env)
        self.env.atomic=atomic;self.env.rollback(revision);self.env.finish_rollback(revision)
        deploy.require_committed_environment({'sha':'previous'},self.env)

    def test_first_deployment_failure_stops_candidate_before_releasing_journal(self):
        import deploy
        revision=self.stage();self.activate(revision)
        def stopped():
            self.assertEqual(self.path.read_bytes(),self.original)
            with self.assertRaisesRegex(ValueError,'recovery pending'):self.env.current()
        with patch.object(deploy,'stop_uncommitted_api',side_effect=stopped) as stop:
            with self.assertRaisesRegex(RuntimeError,'Unhealthy'):
                deploy.promote_or_rollback({'sha':'new','env_revision':revision},None,lambda r:(_ for _ in ()).throw(RuntimeError('Unhealthy')),self.env)
            stop.assert_called_once()
        self.assertIsNone(self.env.current());deploy.require_committed_environment(None,self.env)

    def test_crashed_first_deploy_recovery_waits_for_stop_and_is_retryable(self):
        import recover_env,deploy
        revision=self.stage();self.activate(revision);state=self.root/'absent-release.json'
        with patch.object(recover_env,'STATE',state),patch.object(recover_env,'Revisions',return_value=self.env),patch.object(recover_env,'open',create=True,side_effect=lambda *a,**k:(self.root/'deploy.lock').open('a')),patch.object(recover_env,'promote') as promote:
            with patch.object(deploy,'stop_uncommitted_api',side_effect=RuntimeError('Stop failed')):
                with self.assertRaisesRegex(RuntimeError,'Stop failed'):recover_env.recover(revision)
            with self.assertRaisesRegex(ValueError,'recovery pending'):self.env.current()
            with patch.object(deploy,'stop_uncommitted_api'):recover_env.recover(revision)
            promote.assert_not_called()
        self.assertIsNone(self.env.current());self.assertFalse(state.exists());self.assertEqual(self.path.read_bytes(),self.original)

    def test_missing_release_record_does_not_release_prior_revision(self):
        import recover_env,deploy
        prior=self.stage();self.activate(prior)
        revision=self.env.stage({'GEMINI_API_KEY':'test-only-second-placeholder-key','GEMINI_MODEL':'gemini-3.5-flash-lite'});self.activate(revision)
        with patch.object(recover_env,'STATE',self.root/'absent-release.json'),patch.object(recover_env,'Revisions',return_value=self.env),patch.object(recover_env,'open',create=True,side_effect=lambda *a,**k:(self.root/'deploy.lock').open('a')),patch.object(deploy,'stop_uncommitted_api') as stop:
            with self.assertRaisesRegex(ValueError,'Missing prior release'):recover_env.recover(revision)
            stop.assert_not_called()
        self.assertEqual(self.env.current(),revision)

    def test_first_deploy_stop_refuses_unrelated_compose_root(self):
        import deploy
        labels={'com.docker.compose.project.working_dir':'/unrelated','com.docker.compose.project.config_files':'/unrelated/compose.yaml'}
        with patch.object(deploy,'run',side_effect=[b'abcdef123456\n',json.dumps([{'Config':{'Labels':labels}}]).encode()]) as run:
            with self.assertRaisesRegex(RuntimeError,'fixed compose root'):deploy.stop_uncommitted_api()
            self.assertEqual(run.call_count,2)
    def test_first_deploy_stop_verifies_the_owned_api_is_durably_stopped(self):
        import deploy
        labels={'com.docker.compose.project.working_dir':str(deploy.ROOT),'com.docker.compose.project.config_files':str(deploy.ROOT/'compose.yaml')}
        with patch.object(deploy,'run',side_effect=[b'abcdef123456\n',json.dumps([{'Config':{'Labels':labels}}]).encode(),b'',json.dumps([{'State':{'Running':False}}]).encode()]) as run:
            deploy.stop_uncommitted_api();self.assertEqual(run.call_count,4)
            self.assertEqual(run.call_args_list[2].args[0],['docker','stop','abcdef123456'])
