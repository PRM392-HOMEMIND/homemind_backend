import pathlib,sys,unittest,subprocess
from unittest.mock import patch,MagicMock
sys.path.insert(0,str(pathlib.Path(__file__).resolve().parents[1]/'server'))
import admin_role,deploy

class AdminRolePreparationTests(unittest.TestCase):
 def prepare(self,exists=True,count='1',safe='t',authenticated=True):
  revisions=MagicMock();revisions.root=pathlib.Path('/trusted')
  revisions.read.side_effect=lambda path: (b'a'*64+b'\n') if path.name=='db-admin-reader-password' else b'DATABASE_URL=postgresql://homemind_app:unchanged@db:5432/homemind\n'
  def run(args,**kwargs):
   if args[-1].startswith('SELECT count'):return subprocess.CompletedProcess(args,0,count,'')
   if args[-1].startswith('SELECT ('):return subprocess.CompletedProcess(args,0,safe,'')
   if 'sh' in args:
    self.assertNotIn('a'*64,' '.join(args));self.assertEqual(kwargs['input'],'a'*64+'\n')
    return subprocess.CompletedProcess(args,0 if authenticated else 2,'homemind_admin_api\n' if authenticated else '','')
   return subprocess.CompletedProcess(args,0,'','')
  with patch.object(admin_role,'Revisions',return_value=revisions),patch.object(pathlib.Path,'exists',return_value=exists),patch.object(deploy,'read_release',return_value={'sha':'a'*40}),patch.object(deploy,'verified_status'),patch.object(deploy,'compose_env',return_value={}),patch.object(admin_role.subprocess,'run',side_effect=run),patch.object(admin_role.secrets,'token_hex',return_value='a'*64):
   try:return admin_role.prepare(),revisions
   except ValueError:
    revisions.stage.assert_not_called();raise
 def test_fresh_role_is_verified_before_admin_only_staging(self):
  result,revisions=self.prepare(False,'0');self.assertEqual(result['status'],'STAGED_ONLY')
  revisions.atomic.assert_called_once();self.assertEqual(set(revisions.stage.call_args.args[0]),{'ADMIN_DATABASE_URL','ADMIN_WEB_ORIGINS'})
 def test_existing_role_preserves_secret_and_requires_actual_authentication(self):
  _,revisions=self.prepare();revisions.atomic.assert_not_called()
  with self.assertRaises(ValueError):self.prepare(authenticated=False)
 def test_existing_role_without_metadata_or_unsafe_privileges_fails_closed(self):
  for args in [dict(exists=False,count='1'),dict(safe='f')]:
   with self.subTest(args=args),self.assertRaises(ValueError):self.prepare(**args)
