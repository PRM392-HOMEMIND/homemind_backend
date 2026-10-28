import os,pathlib,sys,tempfile,unittest
sys.path.insert(0,str(pathlib.Path(__file__).resolve().parents[1]/'server'))
from env_revisions import Revisions
@unittest.skipUnless(hasattr(os,'geteuid') and os.geteuid()==0,'Requires isolated Linux root operator')
class AdminEnvironmentTests(unittest.TestCase):
 def setUp(self):
  self.temp=tempfile.TemporaryDirectory();self.root=pathlib.Path(self.temp.name);self.root.chmod(0o700)
  self.before=b'DATABASE_URL=postgresql://homemind_app:private@db:5432/homemind?pool_timeout=5\nAUTH_ACCESS_SECRET=unchanged\nGEMINI_API_KEY=unchanged\nPAYOS_API_KEY=unchanged\n'
  p=self.root/'api.env';p.write_bytes(self.before);p.chmod(0o600);self.env=Revisions(self.root)
  self.group={'ADMIN_DATABASE_URL':'postgresql://homemind_admin_api:'+('a'*64)+'@db:5432/homemind','ADMIN_WEB_ORIGINS':'https://homemind.vn'}
 def tearDown(self):self.temp.cleanup()
 def test_stage_activate_rollback_preserves_customer_provider_secrets(self):
  revision=self.env.stage(self.group);self.assertEqual((self.root/'api.env').read_bytes(),self.before)
  self.env.activate(revision);self.assertEqual(self.env.activation_pending(),revision)
  with self.assertRaises(ValueError):self.env.current()
  self.env.finish_activation(revision,{'env_revision':revision});self.assertEqual(self.env.current(),revision)
  self.assertTrue((self.root/'api.env').read_bytes().startswith(self.before))
  self.env.rollback(revision);self.assertEqual((self.root/'api.env').read_bytes(),self.before)
  self.env.finish_rollback(revision);self.assertIsNone(self.env.current())
 def test_partial_wrong_role_db_origin_and_injected_values_fail_closed(self):
  for changes in [{'ADMIN_DATABASE_URL':self.group['ADMIN_DATABASE_URL']},{**self.group,'AUTH_ACCESS_SECRET':'changed'},
   {**self.group,'ADMIN_WEB_ORIGINS':'*'},{**self.group,'ADMIN_WEB_ORIGINS':'http://localhost:3000'},
   {**self.group,'ADMIN_WEB_ORIGINS':'https://homemind.vn/path'},
   {**self.group,'ADMIN_DATABASE_URL':self.group['ADMIN_DATABASE_URL'].replace('homemind_admin_api','postgres')},
   {**self.group,'ADMIN_DATABASE_URL':self.group['ADMIN_DATABASE_URL'].replace('@db:','@other:')},
   {**self.group,'ADMIN_DATABASE_URL':self.group['ADMIN_DATABASE_URL']+'\nOTHER=value'}]:
   with self.subTest(fields=list(changes)):
    with self.assertRaises(ValueError):self.env.stage(changes)
  self.assertEqual((self.root/'api.env').read_bytes(),self.before);self.assertEqual(list(self.env.revisions.iterdir()),[])
