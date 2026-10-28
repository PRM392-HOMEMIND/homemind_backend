import pathlib,sys,unittest
from unittest.mock import patch
sys.path.insert(0,str(pathlib.Path(__file__).resolve().parents[1]/'server'))
import backup

class AdminBackupCoverageTests(unittest.TestCase):
 def test_same_snapshot_counts_include_admin_preserving_legacy_public_keys(self):
  with patch.object(backup,'run',side_effect=[b'admin\taudit_logs\nadmin\tprincipals\npublic\tusers\n',b'8',b'1',b'20'])as run:
   self.assertEqual(backup.table_counts('owned','00000003-00000002-1'),{'admin.audit_logs':8,'admin.principals':1,'users':20})
   for call in run.call_args_list:self.assertIn("SET TRANSACTION SNAPSHOT '00000003-00000002-1'",call.args[0][-1])
 def test_catalog_identifier_cannot_escape_allowlisted_schemas(self):
  for value in [b'unsafe\tusers\n',b'admin\tusers";drop\n']:
   with patch.object(backup,'run',return_value=value)as run,self.assertRaises(RuntimeError):backup.table_counts('owned')
   self.assertEqual(run.call_count,1)
