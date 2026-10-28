"""Approved complete Email group; preserve every existing production field."""
import os,pathlib,secrets,sys,tempfile,unittest
sys.path.insert(0,str(pathlib.Path(__file__).resolve().parents[1]/'server'))
from env_revisions import Revisions

class EmailValidationTests(unittest.TestCase):
 def setUp(self):
  self.env=object.__new__(Revisions)
  self.group={'EMAIL_DELIVERY_MODE':'infobip','AUTH_OTP_SECRET':secrets.token_hex(48),
    'INFOBIP_API_KEY':secrets.token_hex(32),'INFOBIP_BASE_URL':'https://owned.api.infobip.com','INFOBIP_EMAIL_FROM':'noreply@example.com'}
 def test_complete_group_and_existing_unchanged_secret_are_valid(self):
  self.assertEqual(self.env.validate_changes(b'PAYOS_ENABLED=false\n',self.group),self.group)
  self.assertEqual(self.env.validate_changes(('AUTH_OTP_SECRET='+self.group['AUTH_OTP_SECRET']+'\n').encode(),self.group),self.group)
 def test_partial_extra_and_unrelated_groups_cannot_be_staged(self):
  for change in [{k:v for k,v in self.group.items() if k!='AUTH_OTP_SECRET'}, {**self.group,'AUTH_ACCESS_SECRET':secrets.token_hex(32)}, {**self.group,'PAYOS_ENABLED':'true'}, {**self.group,'DATABASE_URL':'changed'}]:
   with self.assertRaises(ValueError):self.env.validate_changes(b'',change)
 def test_invalid_origin_injection_secret_sender_and_mode_are_rejected(self):
  for key,value in [('INFOBIP_BASE_URL','http://owned.api.infobip.com'),('INFOBIP_BASE_URL','https://evil.test'),('INFOBIP_BASE_URL','https://owned.api.infobip.com/path'),('INFOBIP_API_KEY','valid\nINJECTED=value'),('INFOBIP_API_KEY','PLACEHOLDER_'*3),('AUTH_OTP_SECRET','short'),('EMAIL_DELIVERY_MODE','mock'),('INFOBIP_EMAIL_FROM','Name <noreply@example.com>')]:
   with self.subTest(field=key),self.assertRaises(ValueError):self.env.validate_changes(b'',{**self.group,key:value})
 def test_otp_reuse_rotation_and_duplicate_fields_fail_closed(self):
  for before in [('AUTH_ACCESS_SECRET='+self.group['AUTH_OTP_SECRET']+'\n').encode(),('AUTH_OTP_SECRET='+secrets.token_hex(32)+'\n').encode(),b'AUTH_OTP_SECRET=one\nAUTH_OTP_SECRET=two\n']:
   with self.assertRaises(ValueError):self.env.validate_changes(before,self.group)

@unittest.skipUnless(hasattr(os,'geteuid') and os.geteuid()==0,'Requires isolated Linux root operator')
class EmailRevisionTests(EmailValidationTests):
 def setUp(self):
  super().setUp();self.temp=tempfile.TemporaryDirectory();self.root=pathlib.Path(self.temp.name);self.root.chmod(0o700)
  self.before=b'# preserved\nDATABASE_URL=private-test-dsn\nAUTH_ACCESS_SECRET=preserved-auth\nPAYOS_ENABLED=false\nGEMINI_API_KEY=preserved-provider\n'
  self.file=self.root/'api.env';self.file.write_bytes(self.before);self.file.chmod(0o600);self.env=Revisions(self.root)
 def tearDown(self):self.temp.cleanup()
 def test_stage_activation_backup_and_rollback_preserve_unrelated_bytes(self):
  revision=self.env.stage(self.group)
  self.assertEqual(self.file.read_bytes(),self.before)
  self.assertTrue(self.env.activate(revision));self.assertEqual(self.env.activation_pending(),revision)
  self.assertEqual(self.env.read(self.env.revisions/(revision+'.rollback.json')).find(self.before.decode().replace('\n','\\n').encode())>=0,True)
  self.env.finish_activation(revision,{'env_revision':revision})
  self.assertEqual(self.env.current(),revision);self.assertTrue(self.file.read_bytes().startswith(self.before))
  self.assertEqual(self.file.stat().st_mode&0o777,0o600)
  self.env.rollback(revision);self.env.finish_rollback(revision)
  self.assertEqual(self.file.read_bytes(),self.before);self.assertIsNone(self.env.current())
 def test_invalid_group_creates_no_staged_revision(self):
  with self.assertRaises(ValueError):self.env.stage({**self.group,'AUTH_OTP_SECRET':'short'})
  self.assertEqual(self.file.read_bytes(),self.before);self.assertEqual(list(self.env.revisions.iterdir()),[])
