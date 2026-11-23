"""Exercise the bounded supervisor with a local stand-in for the node executable."""
import json
import os
from pathlib import Path
import subprocess
import tempfile
import time
import unittest

HELPER = Path(__file__).resolve().parents[2] / "scripts/atelier/supervision_lock.py"


class Admission(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)
        self.hold = self.root / "hold"
        self.ack = self.root / "ack"
        self.heartbeat = self.root / ".omx/atelier/lessons/loop-progress-fixture.heartbeat"
        self.heartbeat.parent.mkdir(parents=True)
        self.heartbeat.touch()
        self.node = self.root / "node"
        self.node.write_text("#!/bin/sh\necho ran > started\n")
        self.node.chmod(0o700)

    def request(self, worker="fixture"):
        self.hold.write_text(json.dumps({"worker": worker,
                                         "turn_epoch_ns": self.heartbeat.stat().st_mtime_ns}))

    def start(self, cmd):
        env = dict(os.environ, WORKER_ID="fixture", SINTER_OPERATOR_ADMISSION_HOLD=str(self.hold),
                   SINTER_OPERATOR_ADMISSION_ACK=str(self.ack))
        child = subprocess.Popen(["python3", HELPER, "bounded", "--seconds", "3", "--",
                                  self.node, "bin/sinter", cmd], cwd=self.root, env=env)
        def stop():
            if child.poll() is None:
                child.terminate()
            child.wait(timeout=3)
        self.addCleanup(stop)
        return child

    def check_hold(self, cmd, reason):
        before = self.heartbeat.stat().st_mtime_ns
        child = self.start(cmd)
        until = time.monotonic() + 3
        while not self.ack.exists() and child.poll() is None and time.monotonic() < until:
            time.sleep(0.02)
        self.assertTrue(self.ack.is_file(), "held supervisor must acknowledge before spawning")
        receipt = json.loads(self.ack.read_text())
        self.assertEqual((receipt["pid"], receipt["reason"]), (child.pid, reason))
        self.assertEqual(self.ack.stat().st_mode & 0o777, 0o600)
        self.assertFalse((self.root / "started").exists())
        self.hold.unlink()
        self.assertEqual(child.wait(timeout=3), 0)
        self.assertGreater(self.heartbeat.stat().st_mtime_ns, before)
        self.assertTrue((self.root / "started").exists())

    def test_next_turn(self):
        self.request()
        self.check_hold("prompt-next", "next-turn")

    def test_post_wave(self):
        self.request()
        self.check_hold("second-judge", "post-wave")

    def test_malformed_hold(self):
        self.hold.write_text("{")
        self.check_hold("generate", "hold-metadata-unavailable")

    def test_same_turn_and_other_workers_can_drain(self):
        self.request()
        self.assertEqual(self.start("sss-score").wait(timeout=3), 0)
        self.request(worker="other")
        self.assertEqual(self.start("prompt-next").wait(timeout=3), 0)
        self.assertFalse(self.ack.exists())


if __name__ == "__main__":
    unittest.main()
