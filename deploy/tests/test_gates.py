import hashlib, io, json, pathlib, sys, unittest, zipfile
from unittest.mock import patch
root=pathlib.Path(__file__).resolve().parents[1]/'server'
sys.path.insert(0,str(root))
import deploy
from identity import non_root_user
sys.path.insert(0,str(pathlib.Path(__file__).resolve().parents[2]/'scripts/ci'))
from package_metadata import validate_metadata

def fixture():
    return {'repository':'QuangVMZu/HomeMind','sha':'a'*40,'run_id':'123','env_revision':'env-'+'e'*32,'token':'test-only-not-a-real-github-token','api_image':'ghcr.io/quangvmzu/homemind-api@sha256:'+'b'*64,'migration_image':'ghcr.io/quangvmzu/homemind-migrate@sha256:'+'c'*64,'database_image':'ghcr.io/quangvmzu/homemind-db@sha256:'+'d'*64}

class DeploymentTrustTests(unittest.TestCase):
    def test_private_granular_package_metadata_need_not_supply_repository(self):
        validate_metadata({'visibility':'private','name':'homemind-api','package_type':'container','owner':{'id':42},'repository':None},'api',42,100)
    def test_package_privacy_owner_and_conflicting_repository_are_enforced(self):
        package={'visibility':'private','name':'homemind-api','package_type':'container','owner':{'id':42}}
        for key,value in [('visibility','public'),('owner',{'id':43}),('repository',{'id':101}),('name','another-image')]:
            with self.assertRaises(ValueError): validate_metadata({**package,key:value},'api',42,100)
    def test_rejects_mutable_tag_and_shell_payload(self):
        for field,value in [('api_image','ghcr.io/quangvmzu/homemind-api:latest'),('sha','a'*40+';id'),('repository','another/repo'),('run_id','123;sh')]:
            payload=fixture();payload[field]=value
            with self.assertRaises(ValueError): deploy.validate_payload(payload)
    def responses(self,payload,conclusion='success',event='push',head=None):
        return [{'private':True},{'head_sha':payload['sha'],'head_branch':'main','event':event,'path':'.github/workflows/deploy.yml','run_attempt':1},{'jobs':[{'name':'required-checks','conclusion':conclusion},{'name':'publish','conclusion':'success'}]},{'object':{'sha':head or payload['sha']}}]
    def test_failed_required_check_blocks_deployment(self):
        payload=fixture()
        with patch.object(deploy,'github',side_effect=self.responses(payload,conclusion='failure')):
            with self.assertRaisesRegex(ValueError,'did not pass'): deploy.check_authorization(payload)
    def test_untrusted_pr_event_blocks_deployment(self):
        payload=fixture()
        with patch.object(deploy,'github',side_effect=self.responses(payload,event='pull_request')):
            with self.assertRaisesRegex(ValueError,'Untrusted'): deploy.check_authorization(payload)
    def test_obsolete_main_revision_blocks_deployment(self):
        payload=fixture()
        with patch.object(deploy,'github',side_effect=self.responses(payload,head='d'*40)):
            with self.assertRaisesRegex(ValueError,'Obsolete'): deploy.check_authorization(payload)
    def test_current_successful_private_main_is_authorized(self):
        payload=fixture()
        with patch.object(deploy,'github',side_effect=self.responses(payload)),patch.object(deploy,'verify_manifest') as verify:
            deploy.check_authorization(payload)
            verify.assert_called_once()
    def test_every_uid_zero_spelling_is_rejected(self):
        for user in ['', '0','0:1000','000:1000','root:node','root','ROOT']:
            self.assertFalse(non_root_user(user),user)
        for user in ['node','node:node','1000','1000:0']: self.assertTrue(non_root_user(user),user)
    def artifact(self,manifest):
        stream=io.BytesIO()
        with zipfile.ZipFile(stream,'w') as writer: writer.writestr('deployment-manifest.json',json.dumps(manifest))
        raw=stream.getvalue()
        return raw,{'artifacts':[{'id':7,'name':'deployment-manifest-1','expired':False,'digest':'sha256:'+hashlib.sha256(raw).hexdigest()}]}
    def test_caller_cannot_substitute_an_untested_image_digest(self):
        payload=fixture();manifest={k:v for k,v in payload.items() if k!='token'}
        manifest['api_image']='ghcr.io/quangvmzu/homemind-api@sha256:'+'e'*64
        raw,metadata=self.artifact(manifest)
        with patch.object(deploy,'github',return_value=metadata),patch.object(deploy,'download_artifact',return_value=raw):
            with self.assertRaisesRegex(ValueError,'does not match'): deploy.verify_manifest(payload,{'run_attempt':1})
    def test_environment_revision_is_bound_to_the_trusted_manifest(self):
        payload=fixture();manifest={k:v for k,v in payload.items() if k!='token'}
        manifest['env_revision']='env-'+'f'*32
        raw,metadata=self.artifact(manifest)
        with patch.object(deploy,'github',return_value=metadata),patch.object(deploy,'download_artifact',return_value=raw):
            with self.assertRaisesRegex(ValueError,'does not match'): deploy.verify_manifest(payload,{'run_attempt':1})
    def test_environment_values_and_missing_revision_are_rejected(self):
        payload=fixture();payload.pop('env_revision')
        with self.assertRaises(ValueError): deploy.validate_payload(payload)
        payload=fixture();payload['GEMINI_API_KEY']='test-only-not-a-real-key'
        with self.assertRaises(ValueError): deploy.validate_payload(payload)
    def test_only_checksum_verified_same_run_tested_images_are_allowed(self):
        payload=fixture();raw,metadata=self.artifact({k:v for k,v in payload.items() if k!='token'})
        with patch.object(deploy,'github',return_value=metadata),patch.object(deploy,'download_artifact',return_value=raw): deploy.verify_manifest(payload,{'run_attempt':1})
        metadata['artifacts'][0]['digest']='sha256:'+'0'*64
        with patch.object(deploy,'github',return_value=metadata),patch.object(deploy,'download_artifact',return_value=raw):
            with self.assertRaisesRegex(ValueError,'checksum'): deploy.verify_manifest(payload,{'run_attempt':1})
    def test_failed_promotion_restores_previous_release_and_propagates_failure(self):
        attempted=[]
        def promoter(record):
            attempted.append(record['sha'])
            if record['sha']=='new': raise RuntimeError('Unhealthy candidate')
        with self.assertRaisesRegex(RuntimeError,'Unhealthy'):
            deploy.promote_or_rollback({'sha':'new'}, {'sha':'previous'}, promoter)
        self.assertEqual(attempted,['new','previous'])
    def test_first_deployment_failure_never_invents_a_previous_release(self):
        with patch.object(deploy,'stop_uncommitted_api') as stop:
            with self.assertRaisesRegex(RuntimeError,'Unhealthy'):
                deploy.promote_or_rollback({'sha':'new'}, None, lambda record: (_ for _ in ()).throw(RuntimeError('Unhealthy')))
            stop.assert_called_once()
    def test_reviewed_additive_read_migration_passes_the_actual_migration_policy(self):
        backend=pathlib.Path(__file__).resolve().parents[2]/'apps/homemind_backend/prisma'
        policy=json.loads((backend/'compatibility.json').read_text())
        files=[{'name':p.name,'checksum':hashlib.sha256((p/'migration.sql').read_bytes()).hexdigest(),'compatible':policy.get(p.name) is True}
               for p in sorted((backend/'migrations').iterdir()) if p.is_dir()]
        for item in files:
            if isinstance(policy.get(item['name']),dict): item.update(policy[item['name']])
        # Use an older real baseline. Treating every newly added migration as
        # already applied would miss an omitted rollback compatibility entry.
        applied='\n'.join(x['name']+'|'+x['checksum'] for x in files
                          if x['name']<='20261002004000_billing_recovery_guards').encode()
        with patch.object(deploy,'run',side_effect=[json.dumps(files).encode(),b'public._prisma_migrations',applied]):
            self.assertEqual(deploy.migrate_policy('tested-migrator','owned-db'),files)
        self.assertTrue(deploy.migration_recovery.required({'migrations':files},{'migrations':[x for x in files if x['name']<='20261003008000_billing_durable_cancellation']}))
        # An unreviewed future migration is still rejected.
        files.append({'name':'20990101000000_unreviewed','checksum':'0'*64,'compatible':False})
        with patch.object(deploy,'run',side_effect=[json.dumps(files).encode(),b'public._prisma_migrations',applied]):
            with self.assertRaisesRegex(RuntimeError,'Unreviewed'):deploy.migrate_policy('tested-migrator','owned-db')

if __name__=='__main__': unittest.main()
