"""Exercise token ownership and interruption behavior without live supervisors."""
from pathlib import Path
import os
import signal
import subprocess
import tempfile
import time
import unittest
from unittest import mock


ROOT = Path(__file__).resolve().parents[2]
HELPER = ROOT / "scripts/atelier/supervision_lock.py"


class LifecycleRegression(unittest.TestCase):
    def invoke(self, *args):
        return subprocess.run(["python3", str(HELPER), *map(str, args)],
                              capture_output=True, text=True, timeout=5)

    @staticmethod
    def process_state(pid):
        try:
            tail = Path(f"/proc/{pid}/stat").read_text().rsplit(")", 1)[1].split()
            return tail[0]
        except (FileNotFoundError, IndexError, OSError):
            result = subprocess.run(["ps", "-o", "stat=", "-p", str(pid)],
                                    capture_output=True, text=True, check=False)
            return result.stdout.strip().split()[0] if result.stdout.strip() else ""

    def assert_process_stopped(self, pid, timeout=1.0):
        deadline = time.monotonic() + timeout
        while True:
            try:
                os.kill(pid, 0)
            except ProcessLookupError:
                return
            except PermissionError as exc:
                self.fail(f"cannot verify process {pid}: {exc}")
            if self.process_state(pid).startswith("Z"):
                return
            if time.monotonic() >= deadline:
                self.fail(f"process {pid} remains live")
            time.sleep(0.02)

    def worker(self):
        return subprocess.Popen(["bash", "-c", "exec -a standing-loop.sh sleep 30"])

    def confusing_worker(self):
        return subprocess.Popen(["bash", "-c",
                                  "exec -a unrelated python3 -c 'import time; time.sleep(30)' standing-loop.sh"])

    def claim(self, lock, pid, worker="w1", identity="standing-loop.sh"):
        return self.invoke("claim", lock, "--pid", pid, "--identity", identity,
                           "--worker", worker)

    def test_claim_is_atomic_and_identity_scoped(self):
        with tempfile.TemporaryDirectory() as tmp:
            lock = Path(tmp) / "owner.lockd"
            first = self.worker()
            second = self.worker()
            try:
                c1 = subprocess.Popen(["python3", str(HELPER), "claim", lock,
                                       "--pid", str(first.pid), "--identity", "standing-loop.sh",
                                       "--worker", "w1"], stdout=subprocess.PIPE,
                                      stderr=subprocess.PIPE, text=True)
                c2 = subprocess.Popen(["python3", str(HELPER), "claim", lock,
                                       "--pid", str(second.pid), "--identity", "standing-loop.sh",
                                       "--worker", "w2"], stdout=subprocess.PIPE,
                                      stderr=subprocess.PIPE, text=True)
                c1.communicate(timeout=5); c2.communicate(timeout=5)
                self.assertEqual(sorted((c1.returncode, c2.returncode)), [0, 2])
                self.assertEqual(self.invoke("verify", lock, "--identity", "system-loop.sh",
                                             "--worker", "w1").returncode, 2)
            finally:
                first.kill(); second.kill()
                first.wait(); second.wait()

    def test_stale_token_cannot_release_replacement(self):
        with tempfile.TemporaryDirectory() as tmp:
            lock = Path(tmp) / "owner.lockd"
            first = self.worker()
            second = None
            try:
                result = self.claim(lock, first.pid)
                self.assertEqual(result.returncode, 0, result.stderr)
                token = result.stdout.strip()
                self.assertEqual(self.invoke("release", lock, "wrong-token").returncode, 2)
                first.terminate(); first.wait()
                self.assertEqual(self.invoke("reclaim", lock, "--identity", "standing-loop.sh",
                                             "--worker", "w1").returncode, 0)
                second = self.worker()
                replacement = self.claim(lock, second.pid)
                self.assertEqual(replacement.returncode, 0, replacement.stderr)
                self.assertEqual(self.invoke("release", lock, token).returncode, 2)
                self.assertTrue(lock.exists())
            finally:
                if first.poll() is None:
                    first.kill()
                first.wait()
                if second is not None:
                    second.kill(); second.wait()

    def test_inspect_owner_is_read_only_and_verified(self):
        import importlib.util
        spec = importlib.util.spec_from_file_location("supervision_lock", HELPER)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        with tempfile.TemporaryDirectory() as tmp:
            lock = Path(tmp) / "owner.lockd"
            process = self.worker()
            try:
                result = self.claim(lock, process.pid)
                self.assertEqual(result.returncode, 0)
                before = (lock / "owner.json").read_bytes()
                owner = module.inspect_owner(lock, "standing-loop.sh", "w1")
                self.assertEqual(owner["token"], result.stdout.strip())
                self.assertEqual(before, (lock / "owner.json").read_bytes())
            finally:
                process.kill(); process.wait()
            self.assertIsNone(module.inspect_owner(lock, "standing-loop.sh", "w1"))

    def test_argv_argument_cannot_impersonate_script_identity(self):
        with tempfile.TemporaryDirectory() as tmp:
            lock = Path(tmp) / "owner.lockd"
            process = self.confusing_worker()
            try:
                self.assertEqual(self.claim(lock, process.pid).returncode, 0)
                self.assertEqual(self.invoke("verify", lock, "--identity", "standing-loop.sh",
                                             "--worker", "w1").returncode, 1)
            finally:
                process.kill(); process.wait()

    def test_terminate_owner_requires_exact_identity(self):
        with tempfile.TemporaryDirectory() as tmp:
            lock = Path(tmp) / "owner.lockd"
            process = self.worker()
            try:
                self.assertEqual(self.claim(lock, process.pid).returncode, 0)
                wrong = self.invoke("terminate-owner", lock, "--identity", "other.sh",
                                    "--worker", "w1")
                self.assertEqual(wrong.returncode, 1)
                self.assertIsNone(process.poll())
                right = self.invoke("terminate-owner", lock, "--identity", "standing-loop.sh",
                                    "--worker", "w1", "--grace", "0.05")
                self.assertEqual(right.returncode, 0)
                process.wait(timeout=3)
            finally:
                if process.poll() is None:
                    process.kill(); process.wait()

    def test_terminate_cleans_interrupted_process_tree(self):
        with tempfile.TemporaryDirectory() as tmp:
            marker = Path(tmp) / "child.pid"
            parent = subprocess.Popen(["bash", "-c", f"sleep 30 & echo $! > {marker}; wait"])
            try:
                for _ in range(30):
                    if marker.exists():
                        break
                    time.sleep(0.01)
                child_pid = int(marker.read_text())
                start = self.invoke("start", "--pid", parent.pid).stdout.strip()
                result = self.invoke("terminate", "--pid", parent.pid, "--start", start,
                                     "--grace", "0.05")
                self.assertEqual(result.returncode, 0, result.stderr)
                parent.wait(timeout=3)
                self.assert_process_stopped(child_pid)
            finally:
                if parent.poll() is None:
                    parent.kill(); parent.wait()

    def test_termination_refuses_unsafe_pid_and_missing_start(self):
        import importlib.util
        spec = importlib.util.spec_from_file_location("supervision_lock", HELPER)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        with mock.patch.object(module.os, "kill") as kill, mock.patch.object(module.os, "killpg") as group:
            for pid, start in [(0, "x"), (1, "x"), (-1, "x"), (12345, "")]:
                self.assertEqual(module._terminate(pid, expected_start=start), 1)
            kill.assert_not_called()
            group.assert_not_called()

    def test_linux_cmdline_bytes_are_decoded_before_tokenization(self):
        import importlib.util
        spec = importlib.util.spec_from_file_location("supervision_lock", HELPER)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)

        class FakeProc:
            def read_bytes(self):
                return b"/bin/bash\0standing-loop.sh\0"

        with mock.patch.object(module, "Path", lambda _: FakeProc()):
            self.assertEqual(module._command(123), "/bin/bash standing-loop.sh")

    def test_owned_group_catches_child_spawned_during_shutdown(self):
        with tempfile.TemporaryDirectory() as tmp:
            marker = Path(tmp) / "late-child.pid"
            script = Path(tmp) / "trap-child.sh"
            script.write_text("trap 'sleep 30 & echo $! > %s' TERM\n"
                              "while true; do sleep 30; done\n" % marker)
            script.chmod(0o700)
            parent = subprocess.Popen(["python3", str(HELPER), "launch", "--",
                                       "bash", str(script)])
            child_pid = None
            try:
                start = self.invoke("start", "--pid", parent.pid).stdout.strip()
                result = self.invoke("terminate", "--pid", parent.pid, "--start", start,
                                     "--grace", "0.05")
                self.assertEqual(result.returncode, 0, result.stderr)
                parent.wait(timeout=3)
                for _ in range(30):
                    if marker.exists():
                        child_pid = int(marker.read_text())
                        break
                    time.sleep(0.01)
                self.assertIsNotNone(child_pid)
                self.assert_process_stopped(child_pid)
            finally:
                if parent.poll() is None:
                    parent.kill(); parent.wait()
                if child_pid is not None:
                    try:
                        os.kill(child_pid, 9)
                    except ProcessLookupError:
                        pass

    def test_bounded_preserves_child_exit_status(self):
        result = self.invoke("bounded", "--seconds", "1", "--", "python3", "-c",
                             "raise SystemExit(7)")
        self.assertEqual(result.returncode, 7, result.stderr)

    def test_bounded_deadline_kills_owned_descendants(self):
        import importlib.util
        from types import SimpleNamespace
        spec = importlib.util.spec_from_file_location("supervision_lock", HELPER)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        with tempfile.TemporaryDirectory() as tmp:
            marker = Path(tmp) / "child.pid"
            code = ("import pathlib, subprocess; p=subprocess.Popen(['sleep','30']); "
                    "marker=pathlib.Path(%r); ready=marker.with_suffix('.ready'); "
                    "ready.write_text(str(p.pid)); ready.replace(marker); p.wait()" % str(marker))
            # Interpreter scheduling is setup, not part of the kill deadline.
            worker = subprocess.Popen(["python3", "-c", code], start_new_session=True)
            child_pid = None
            try:
                deadline = time.monotonic() + 5
                while not marker.exists() and worker.poll() is None and time.monotonic() < deadline:
                    time.sleep(0.01)
                self.assertTrue(marker.is_file(), "owned descendant did not become ready")
                child_pid = int(marker.read_text())
                started = time.monotonic()
                # Only substitute acquisition of the already-ready real session.
                launch = mock.Mock(return_value=worker)
                proxy = SimpleNamespace(Popen=launch, run=subprocess.run,
                                        TimeoutExpired=subprocess.TimeoutExpired)
                with mock.patch.object(module, "subprocess", proxy):
                    result = module._bounded(0.1, 0.05, ["python3", "-c", code])
                launch.assert_called_once_with(["python3", "-c", code], start_new_session=True)
                self.assertEqual(result, 124)
                self.assertLess(time.monotonic() - started, 2)
                self.assert_process_stopped(child_pid)
            finally:
                try:
                    os.killpg(worker.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
                worker.wait(timeout=3)

    def test_bounded_term_cleans_owned_descendants(self):
        with tempfile.TemporaryDirectory() as tmp:
            marker = Path(tmp) / "child.pid"
            code = ("import pathlib, subprocess; p=subprocess.Popen(['sleep','30']); "
                    "pathlib.Path(%r).write_text(str(p.pid)); p.wait()" % str(marker))
            runner = subprocess.Popen(["python3", str(HELPER), "bounded", "--seconds", "5",
                                       "--grace", "0.05", "--", "python3", "-c", code],
                                      stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
            try:
                for _ in range(100):
                    if marker.exists():
                        break
                    time.sleep(0.01)
                runner.send_signal(signal.SIGTERM)
                _, stderr = runner.communicate(timeout=3)
                self.assertEqual(runner.returncode, 143, stderr)
                self.assert_process_stopped(int(marker.read_text()))
            finally:
                if runner.poll() is None:
                    runner.kill(); runner.wait()

    def test_bounded_int_cleans_owned_descendants(self):
        with tempfile.TemporaryDirectory() as tmp:
            marker = Path(tmp) / "child.pid"
            code = ("import pathlib, subprocess; p=subprocess.Popen(['sleep','30']); "
                    "pathlib.Path(%r).write_text(str(p.pid)); p.wait()" % str(marker))
            runner = subprocess.Popen(["python3", str(HELPER), "bounded", "--seconds", "5",
                                       "--grace", "0.05", "--", "python3", "-c", code],
                                      stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
            try:
                for _ in range(100):
                    if marker.exists():
                        break
                    time.sleep(0.01)
                runner.send_signal(signal.SIGINT)
                _, stderr = runner.communicate(timeout=3)
                self.assertEqual(runner.returncode, 130, stderr)
                self.assert_process_stopped(int(marker.read_text()))
            finally:
                if runner.poll() is None:
                    runner.kill(); runner.wait()


    def test_terminate_deadline_crossing_still_kills_owned_process(self):
        import importlib.util
        spec = importlib.util.spec_from_file_location("supervision_lock", HELPER)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)

        def checked_sleep(seconds):
            if seconds < 0:
                raise ValueError("sleep length must be non-negative")

        with mock.patch.object(module, "_proc_start", return_value="owned"), \
             mock.patch.object(module, "_snapshot_tree", return_value={12345: "owned"}), \
             mock.patch.object(module, "_proc_group", return_value=9876), \
             mock.patch.object(module.os, "kill") as kill, \
             mock.patch.object(module.time, "monotonic", side_effect=[0, 0.999, 1.001, 1.002]), \
             mock.patch.object(module.time, "sleep", side_effect=checked_sleep):
            self.assertEqual(module._terminate(12345, 1, "owned"), 0)
        self.assertEqual(kill.call_args_list,
                         [mock.call(12345, signal.SIGTERM), mock.call(12345, signal.SIGKILL)])

    def test_stopped_assertion_rejects_live_child(self):
        child = subprocess.Popen(["sleep", "30"])
        try:
            with self.assertRaises(AssertionError):
                self.assert_process_stopped(child.pid, timeout=0.05)
        finally:
            child.kill(); child.wait()


if __name__ == "__main__":
    unittest.main()
