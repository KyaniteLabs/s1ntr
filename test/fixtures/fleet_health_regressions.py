"""Fleet verification must fail closed on transport, owner, and outcome gaps."""
from datetime import datetime, timezone
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import tempfile
import time
import unittest
from unittest.mock import patch

SOURCE = Path(__file__).resolve().parents[2] / "scripts/atelier/fleet-health.py"
SPEC = importlib.util.spec_from_file_location("fleet_health", SOURCE)
health = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(health)


class HealthRegression(unittest.TestCase):
    def inspect(self, score_age=60, started_age=120, mismatch=False, owner="12345", score_fields=None, owner_start=None):
        with tempfile.TemporaryDirectory() as tmp:
            root, now = Path(tmp), time.time()
            for prefix in ("scripts/atelier", ".omx/atelier"):
                (root / prefix).mkdir(parents=True)
                for name in ("standing-loop", "system-loop", "watchdog"):
                    p = root / prefix / f"{name}.sh"
                    p.write_text("echo unchanged\n")
                    os.utime(p, (now - 300, now - 300))
            if mismatch:
                (root / "scripts/atelier/system-loop.sh").write_text("echo changed\n")
            (root / "scripts/atelier/supervision_lock.py").write_text(
                (SOURCE.parent / "supervision_lock.py").read_text())
            lessons = root / ".omx/atelier/lessons"
            lessons.mkdir()
            row = {"event_type": "artifact_scored", "ts": datetime.fromtimestamp(
                now - score_age, timezone.utc).isoformat(), "artifact":"fixture-artifact",
                "axes":"D=8 A=8 R=8 N=8", "judges":["one", "two"]}
            row.update(score_fields or {})
            (lessons / "trend.jsonl").write_text(json.dumps(row) + "\nmalformed\n")
            real_read = Path.read_text
            real_bytes = Path.read_bytes
            def read_bytes(path):
                if str(path).startswith("/proc/"):
                    raise FileNotFoundError(path)
                return real_bytes(path)
            started = datetime.fromtimestamp(now - started_age).strftime("%a %b %d %H:%M:%S %Y")
            def read(path, *args, **kwargs):
                if str(path).startswith("/proc/"):
                    raise FileNotFoundError(path)
                if str(path).startswith("/tmp/sinter-"):
                    name="standing-loop" if "standing-loop" in str(path) else "watchdog"
                    pid="12346" if name=="watchdog" and owner=="12345" else owner
                    return json.dumps({"pid":pid,"identity":name+".sh","worker":"",
                        "start":owner_start or started,"token":"a"*32})
                return real_read(path, *args, **kwargs)
            def ps(command, **kwargs):
                name="watchdog" if "12346" in command else "standing-loop"
                fields=([started] if "lstart=" in command else [])+([f"bash .omx/atelier/{name}.sh"] if "command=" in command else [])
                return subprocess.CompletedProcess(command, 0, " ".join(fields)+"\n")
            with patch.object(Path, "read_text", read), patch.object(Path, "read_bytes", read_bytes), \
                 patch.object(health.subprocess, "run", ps), patch.object(health.os, "kill"):
                return health.inspect(root, 1800)

    def test_current_sources_owners_and_outcome(self):
        result = self.inspect()
        self.assertTrue(result["ok"], result)
        self.assertEqual(result["droppedRows"], 1)
        self.assertEqual(result["ownerVerifierSha256"], hashlib.sha256(
            (SOURCE.parent / "supervision_lock.py").read_bytes()).hexdigest())
        self.assertTrue(self.inspect(started_age=300)["ok"], "same-second deployment was falsely stale")

    def test_stale_future_missing_owner_and_source_drift_fail(self):
        for kwargs in ({"score_age": 1900}, {"score_age": -120}, {"started_age": 400},
                       {"mismatch": True}, {"owner": "0"}, {"owner": "bad"}, {"owner_start":"stale"},
                       {"score_fields":{"axes":"D=8"}}, {"score_fields":{"axes":"D=NaN A=8 R=8 N=8"}},
                       {"score_fields":{"judges":["one","one"]}}, {"score_fields":{"artifact":""}}):
            with self.subTest(kwargs=kwargs):
                self.assertFalse(self.inspect(**kwargs)["ok"])

    def test_empty_target_list_and_injection_fail_without_transport(self):
        for args in ([], ["--root", "/tmp", "--target", "-oProxyCommand=bad"],
                     ["--root", "relative"], ["--root", "/tmp", "--max-score-age", "0"]):
            result = subprocess.run(["python3", str(SOURCE), *args], capture_output=True, timeout=5)
            self.assertEqual(result.returncode, 2)


if __name__ == "__main__":
    unittest.main()
