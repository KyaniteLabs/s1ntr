"""Verify the ART budget contains a generator in its own process group."""
import os
import importlib.util
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import Mock, patch

import psutil


GUARD = Path(__file__).resolve().parents[2] / "scripts/atelier/run-budgeted.py"
SPEC = importlib.util.spec_from_file_location("run_budgeted", GUARD)
runner = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(runner)


class BudgetedArtRegression(unittest.TestCase):
    def test_exit_during_final_sample_preserves_real_status(self):
        for status in (0, 7):
            with self.subTest(status=status):
                child = Mock(pid=999999, returncode=None)
                child.poll.side_effect = lambda: child.returncode
                samples = iter((False, True))
                def sample(_pid):
                    if next(samples):
                        child.returncode = status
                    return 0, 0, 0, set(), []
                argv = ['guard', '--memory-mib', '256', '--cpu-percent', '50',
                        '--wall-seconds', '1', '--', 'unused-command']
                with patch.object(sys, 'argv', argv), \
                        patch.object(runner.subprocess, 'Popen', return_value=child), \
                        patch.object(runner.signal, 'signal'), \
                        patch.object(runner.time, 'sleep'), \
                        patch.object(runner.time, 'monotonic', side_effect=[0, 0, 0, 1, 1]), \
                        patch.object(runner, 'usage', side_effect=sample), \
                        patch.object(runner, 'stop') as stop:
                    self.assertEqual(runner.run(), status)
                    stop.assert_not_called()

    def test_aggregate_cpu_debt_repays_parallel_peak(self):
        debt, pause = runner.cpu_debt_pause(0, 8, 1, 50)
        self.assertAlmostEqual(debt, 7.5)
        self.assertAlmostEqual(pause, 15)
        self.assertAlmostEqual(8 / (1 + pause), 0.5)
        debt, pause = runner.cpu_debt_pause(debt, 0, pause, 50)
        self.assertAlmostEqual(debt, 0)
        self.assertAlmostEqual(pause, 0)

    def test_wall_timeout_and_sigterm_stop_nested_session(self):
        for mode in ("timeout", "signal"):
            with self.subTest(mode=mode), tempfile.TemporaryDirectory() as tmp:
                root = Path(tmp)
                pidfile, helper = root / "child.pid", root / "parent.py"
                helper.write_text(
                    "import pathlib,subprocess,sys,time\n"
                    "p=subprocess.Popen([sys.executable,'-c','import time;time.sleep(60)'],"
                    "start_new_session=True)\n"
                    "pathlib.Path(sys.argv[1]).write_text(str(p.pid))\n"
                    "time.sleep(60)\n")
                deadline = "1" if mode == "timeout" else "30"
                process = subprocess.Popen(
                    [sys.executable, str(GUARD), "--memory-mib", "256",
                     "--cpu-percent", "100", "--wall-seconds", deadline, "--",
                     sys.executable, str(helper), str(pidfile)],
                    stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
                started = time.monotonic()
                child_pid = None
                try:
                    while not pidfile.exists() and time.monotonic() - started < 5:
                        time.sleep(0.05)
                    self.assertTrue(pidfile.exists())
                    child_pid = int(pidfile.read_text())
                    if mode == "signal":
                        process.send_signal(signal.SIGTERM)
                    stdout, stderr = process.communicate(timeout=7)
                    self.assertEqual(process.returncode, 124 if mode == "timeout" else 143,
                                     stdout + stderr)
                    self.assertLess(time.monotonic() - started, 7)
                    time.sleep(0.2)
                    alive = (child_pid and psutil.pid_exists(child_pid)
                             and psutil.Process(child_pid).status() != psutil.STATUS_ZOMBIE)
                    self.assertFalse(alive, f"nested child {child_pid} survived {mode}")
                finally:
                    if process.poll() is None:
                        process.send_signal(signal.SIGTERM)
                        process.communicate(timeout=5)
                    if child_pid and psutil.pid_exists(child_pid):
                        try:
                            os.kill(child_pid, signal.SIGKILL)
                        except ProcessLookupError:
                            pass

    def test_memory_stop_reaches_nested_session(self):
        with tempfile.TemporaryDirectory() as tmp:
            pidfile = Path(tmp) / "child.pid"
            helper = Path(tmp) / "parent.py"
            helper.write_text(
                "import pathlib,subprocess,sys,time\n"
                "p=subprocess.Popen([sys.executable,'-c',"
                "'import time; x=bytearray(96*1024*1024); time.sleep(60)'],"
                "start_new_session=True)\n"
                "pathlib.Path(sys.argv[1]).write_text(str(p.pid))\n"
                "time.sleep(60)\n")
            pid = None
            try:
                result = subprocess.run(
                    [sys.executable, str(GUARD), "--memory-mib", "32",
                     "--cpu-percent", "100", "--wall-seconds", "10", "--",
                     sys.executable, str(helper), str(pidfile)],
                    capture_output=True, text=True, timeout=15)
                pid = int(pidfile.read_text())
                self.assertEqual(result.returncode, 124, result.stderr)
                self.assertIn("unique_mib=", result.stderr)
                time.sleep(0.3)
                self.assertFalse(psutil.pid_exists(pid) and
                                 psutil.Process(pid).is_running())
            finally:
                if pid and psutil.pid_exists(pid):
                    try:
                        os.kill(pid, signal.SIGKILL)
                    except ProcessLookupError:
                        pass


if __name__ == "__main__":
    unittest.main()
