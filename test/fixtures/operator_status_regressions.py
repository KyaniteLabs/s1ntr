"""Operator-status projection checks; no real process or provider calls."""
import importlib.util
import json
from pathlib import Path
from types import SimpleNamespace
import tempfile
import unittest

source = Path(__file__).resolve().parents[2] / 'scripts/atelier/operator-status.py'
spec = importlib.util.spec_from_file_location('operator_status', source)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class OperatorStatusTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.data = self.root / '.omx/atelier'
        self.data.mkdir(parents=True)
        self.api = SimpleNamespace(inspect_owner=lambda *args: {'pid': 10},
            _proc_start=lambda pid: 'exact-start',
            _command=lambda pid: 'python3 scripts/atelier/supervision_lock.py bounded --seconds 15 -- node bin/sinter prompt-next',
            _snapshot_tree=lambda pid: {10: 'supervisor', 12: 'exact-start'} if pid == 10 else {pid: 'exact-start'})

    def hold(self):
        (self.data / 'operator-admission-hold.json').write_text(json.dumps({
            'worker': '', 'requested_at': '2026-09-08T12:00:00Z', 'reason': 'capacity',
            'owners': {'token': 'private-must-not-leak'}}))

    def ack(self, **changes):
        value = {'pid': 12, 'start': 'exact-start', 'at': 1788868860}
        value.update(changes)
        (self.data / 'operator-admission-held.json').write_text(json.dumps(value))

    def test_no_hold_reports_only_verified_supervision(self):
        self.assertEqual(module.status(self.root, self.api), {'state': 'active', 'ownerVerified': True})
        self.api.inspect_owner = lambda *args: None
        self.assertEqual(module.status(self.root, self.api)['state'], 'no-supervisor')

    def test_requested_hold_is_not_completed_hold(self):
        self.hold()
        self.assertEqual(module.status(self.root, self.api)['state'], 'draining')

    def test_live_idle_gate_proves_hold_without_exposing_private_records(self):
        self.hold(); self.ack()
        result = module.status(self.root, self.api)
        self.assertEqual(result['state'], 'held')
        self.assertNotIn('private-must-not-leak', json.dumps(result))
        self.assertNotIn('pid', result)

    def test_stale_pid_or_old_receipt_cannot_claim_held(self):
        self.hold(); self.ack(start='old-start')
        self.assertEqual(module.status(self.root, self.api)['state'], 'draining')
        self.ack(at=1)
        self.assertEqual(module.status(self.root, self.api)['state'], 'draining')

    def test_gate_with_an_active_child_cannot_claim_held(self):
        self.hold(); self.ack()
        self.api._snapshot_tree = lambda pid: {pid: 'exact-start', 99: 'node-child'}
        self.assertEqual(module.status(self.root, self.api)['state'], 'draining')

    def test_malformed_hold_is_unknown(self):
        self.hold()
        (self.data / 'operator-admission-hold.json').write_text('{')
        self.assertEqual(module.status(self.root, self.api)['state'], 'unknown')

    def test_unrelated_gate_cannot_claim_worker_held(self):
        self.hold(); self.ack()
        self.api._snapshot_tree = lambda pid: {pid: 'exact-start'}
        self.assertEqual(module.status(self.root, self.api)['state'], 'draining')

    def test_process_probe_failure_is_unknown(self):
        def fail(*args):
            raise RuntimeError('process service unavailable')
        self.api.inspect_owner = fail
        self.assertEqual(module.status(self.root, self.api)['state'], 'unknown')


if __name__ == '__main__':
    unittest.main()
