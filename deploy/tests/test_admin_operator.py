import pathlib,sys,unittest,subprocess,json
from unittest.mock import patch
sys.path.insert(0,str(pathlib.Path(__file__).resolve().parents[1]/'server'))
import admin_maintenance

class AdminMaintenanceTests(unittest.TestCase):
 def test_maintenance_uses_verified_active_migrator_and_bounded_stdin(self):
  payload={'status':'PRUNED_APPROVED_RETENTION','removed':20,'expiredSessionsRemoved':2,'retentionDays':90,'maxRows':5000}
  with patch.object(admin_maintenance.os,'geteuid',return_value=0,create=True),patch.object(admin_maintenance,'read_release',return_value={'sha':'a'*40}),patch.object(admin_maintenance,'Revisions'),patch.object(admin_maintenance,'verified_status') as verify,patch.object(admin_maintenance,'compose_env',return_value={}),patch.object(admin_maintenance.subprocess,'run',return_value=subprocess.CompletedProcess([],0,json.dumps(payload),'')) as run:
   self.assertEqual(admin_maintenance.maintain(),payload);verify.assert_called_once();args=run.call_args.args[0]
   self.assertEqual(args[-3:],['node','migrate','scripts/admin-audit-maintain.cjs']);self.assertIn('--no-deps',args)
   self.assertEqual(json.loads(run.call_args.kwargs['input']),{'operation':'prune-audit','retentionDays':90,'maxRows':5000})
 def test_pending_or_invalid_release_blocks_before_execution(self):
  with patch.object(admin_maintenance.os,'geteuid',return_value=0,create=True),patch.object(admin_maintenance,'read_release',return_value={'sha':'a'*40}),patch.object(admin_maintenance,'Revisions'),patch.object(admin_maintenance,'verified_status',side_effect=ValueError('Pending')),patch.object(admin_maintenance.subprocess,'run') as run:
   with self.assertRaises(ValueError):admin_maintenance.maintain()
   run.assert_not_called()
 def test_non_root_denied(self):
  with patch.object(admin_maintenance.os,'geteuid',return_value=1000,create=True):
   with self.assertRaises(ValueError):admin_maintenance.maintain()
 def test_failed_or_unbounded_output_is_not_trusted(self):
  for result in [subprocess.CompletedProcess([],1,'','private'),subprocess.CompletedProcess([],0,json.dumps({'status':'PRUNED_APPROVED_RETENTION','removed':5001,'expiredSessionsRemoved':0,'retentionDays':90,'maxRows':5000}),''),subprocess.CompletedProcess([],0,'{}','')]:
   with self.subTest(code=result.returncode),patch.object(admin_maintenance.os,'geteuid',return_value=0,create=True),patch.object(admin_maintenance,'read_release',return_value={'sha':'a'*40}),patch.object(admin_maintenance,'Revisions'),patch.object(admin_maintenance,'verified_status'),patch.object(admin_maintenance,'compose_env',return_value={}),patch.object(admin_maintenance.subprocess,'run',return_value=result):
    with self.assertRaises(ValueError):admin_maintenance.maintain()
