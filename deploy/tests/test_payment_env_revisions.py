"""Private root staging only; no network/provider calls or production changes."""
import json, os, pathlib, sys, tempfile, unittest
from unittest.mock import patch
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / 'server'))
from env_revisions import Revisions


@unittest.skipUnless(hasattr(os, 'geteuid') and os.geteuid() == 0,
                     'Requires the isolated Linux root operator container')
class PaymentEnvironmentTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = pathlib.Path(self.temp.name); self.root.chmod(0o700)
        self.original = (b'# original\nDATABASE_URL=private-test-dsn\nAUTH_ACCESS_SECRET=private-test-auth\n'
                         b'AUTH_DEV_RESET_DELIVERY=false\nGEMINI_API_KEY=private-test-original-gemini\n'
                         b'GEMINI_MODEL=gemini-3.5-flash-lite\nBILLING_ORDER_NAMESPACE=2\n')
        self.path = self.root / 'api.env'; self.path.write_bytes(self.original); self.path.chmod(0o600)
        self.env = Revisions(self.root)
        self.changes = {'PAYOS_ENABLED': 'true', 'PAYOS_CLIENT_ID': 'private-test-payment-client',
                        'PAYOS_API_KEY': 'private-test-payment-api-key',
                        'PAYOS_CHECKSUM_KEY': 'private-test-payment-checksum', 'BILLING_ORDER_NAMESPACE': '2'}

    def tearDown(self): self.temp.cleanup()

    def test_inactive_staging_and_activation_preserve_every_other_field(self):
        revision = self.env.stage(self.changes)
        self.assertEqual(self.path.read_bytes(), self.original)
        self.assertTrue(self.env.activate(revision))
        self.assertEqual(self.env.activation_pending(), revision)
        self.env.finish_activation(revision, {'env_revision': revision})
        self.assertEqual(self.env.current(), revision)
        self.assertTrue(self.path.read_bytes().startswith(self.original))
        self.assertEqual(self.path.stat().st_mode & 0o777, 0o600)
        self.env.rollback(revision); self.env.finish_rollback(revision)
        self.assertEqual(self.path.read_bytes(), self.original)
        self.assertIsNone(self.env.current())

    def test_partial_payment_or_arbitrary_groups_are_rejected_without_staging(self):
        for changes in [{k:v for k,v in self.changes.items() if k != 'PAYOS_API_KEY'},
                        {**self.changes, 'DATABASE_URL': 'changed'},
                        {**self.changes, 'PAYOS_RETURN_URL': 'https://example.invalid'},
                        {**self.changes, 'GEMINI_API_KEY': 'private-test-new-gemini-key'}]:
            with self.subTest(keys=sorted(changes)):
                with self.assertRaises(ValueError): self.env.stage(changes)
        self.assertEqual(self.path.read_bytes(), self.original)
        self.assertEqual(list(self.env.revisions.iterdir()), [])

    def test_credentials_enablement_and_namespace_are_bounded(self):
        for key, value in [('PAYOS_ENABLED', '1'), ('PAYOS_API_KEY', 'short'),
                           ('PAYOS_CHECKSUM_KEY', 'CHANGE_ME_' * 3),
                           ('PAYOS_CLIENT_ID', 'private-test-client\nAUTH_ACCESS_SECRET=changed'),
                           ('PAYOS_API_KEY', 'private-test-key with space'),
                           ('BILLING_ORDER_NAMESPACE', '1'), ('BILLING_ORDER_NAMESPACE', '3'),
                           ('BILLING_ORDER_NAMESPACE', '02'), ('BILLING_ORDER_NAMESPACE', '1000')]:
            with self.subTest(field=key):
                with self.assertRaises(ValueError): self.env.stage({**self.changes, key:value})
        self.assertEqual(self.path.read_bytes(), self.original)

    def test_existing_merchant_cannot_be_changed_but_keys_can_be_refreshed(self):
        before = self.original + b'PAYOS_CLIENT_ID=private-test-other-merchant\n'
        self.path.write_bytes(before)
        with self.assertRaisesRegex(ValueError, 'merchant'): self.env.stage(self.changes)
        revision = self.env.stage({**self.changes, 'PAYOS_CLIENT_ID':'private-test-other-merchant'})
        self.assertEqual(self.path.read_bytes(), before)
        self.assertTrue(self.env.activate(revision))

    def test_combined_complete_groups_preserve_model_and_reject_model_drift(self):
        changes = {**self.changes, 'GEMINI_API_KEY':'private-test-updated-gemini-key',
                   'GEMINI_MODEL':'gemini-3.5-flash-lite'}
        revision = self.env.stage(changes)
        self.assertEqual(self.path.read_bytes(), self.original)
        self.assertIn(b'GEMINI_API_KEY=private-test-updated-gemini-key\n', self.env.candidate(revision)[1])
        with self.assertRaisesRegex(ValueError, 'model'):
            self.env.stage({**changes, 'GEMINI_MODEL':'gemini-different'})

    def test_candidate_revalidates_private_staged_record_before_activation(self):
        revision = self.env.stage(self.changes)
        record_path = self.env.revisions / (revision + '.json')
        record = json.loads(record_path.read_bytes())
        record['changes']['BILLING_ORDER_NAMESPACE'] = '3'
        self.env.atomic(record_path, json.dumps(record).encode())
        with self.assertRaisesRegex(ValueError, 'namespace'): self.env.activate(revision)
        self.assertEqual(self.path.read_bytes(), self.original)
        self.assertIsNone(self.env.activation_pending())

    def test_interrupted_activation_blocks_staging_then_forward_recovery_preserves_bytes(self):
        revision = self.env.stage(self.changes); atomic = self.env.atomic
        def interrupted(path, data):
            if path.name == 'active-env-revision': raise RuntimeError('Simulated interruption')
            return atomic(path, data)
        with patch.object(self.env, 'atomic', side_effect=interrupted):
            with self.assertRaises(RuntimeError): self.env.activate(revision)
        with self.assertRaisesRegex(ValueError, 'activation pending'): self.env.stage(self.changes)
        self.env.resume_activation(revision)
        self.env.finish_activation(revision, {'env_revision':revision})
        self.assertEqual(self.env.current(), revision)
        self.assertTrue(self.path.read_bytes().startswith(self.original))

    def test_duplicate_existing_field_and_unterminated_unrelated_line_fail_closed(self):
        for before in [self.original + b'BILLING_ORDER_NAMESPACE=2\n', self.original + b'# unrelated unterminated comment']:
            self.path.write_bytes(before)
            with self.assertRaises(ValueError):
                revision = self.env.stage(self.changes); self.env.candidate(revision)
            self.assertEqual(self.path.read_bytes(), before)
