"""Execute the actual watchdog age function with disposable score history."""
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
import time
import unittest
import uuid

ROOT = Path(__file__).resolve().parents[2]
HELPER = ROOT / 'scripts/atelier/supervision_lock.py'
WATCHDOG = ROOT / 'scripts/atelier/watchdog.sh'
SOURCE = (ROOT / 'scripts/atelier/watchdog.sh').read_text()
AGE = re.search(r'(?ms)^scored_age\(\) \{\n.*?^\}', SOURCE).group()
STREAK = re.search(r'(?ms)^wave_streak\(\) \{\n.*?^\}', SOURCE).group()
LEASE = re.search(r'(?ms)^report_product_lease\(\) \{\n.*?^\}', SOURCE).group()
PROGRESS = re.search(r'(?ms)^progress_age\(\) \{\n.*?^\}', SOURCE).group()


class WatchdogRegression(unittest.TestCase):
    def age(self, rows):
        with tempfile.TemporaryDirectory() as tmp:
            trend = Path(tmp) / '.omx/atelier/lessons/trend.jsonl'
            trend.parent.mkdir(parents=True)
            trend.write_text('\n'.join(json.dumps(row) for row in rows))
            env = dict(os.environ, WATCH_STARTED=str(time.time()-3600))
            result = subprocess.run(['bash', '-c', AGE+'\nscored_age'], cwd=tmp,
                                    env=env, capture_output=True, text=True, timeout=5)
            self.assertEqual(result.returncode, 0, result.stderr)
            return int(result.stdout.strip())

    def row(self, age=60, **fields):
        return dict(event_type='artifact_scored', artifact='fixture',
                    axes='D=8 A=8 R=8 N=8', judges=['one','two'],
                    ts=datetime.fromtimestamp(time.time()-age, timezone.utc).isoformat(), **fields)

    def progress_age(self, mtime, started=900, now=1000):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / 'loop-progress.heartbeat'
            if mtime is not None:
                path.write_text('turn\n')
                os.utime(path, (mtime, mtime))
            result = subprocess.run(['bash', '-c', PROGRESS + '\nprogress_age "$1"',
                                     'fixture', str(now)], cwd=tmp,
                                    env=dict(os.environ, PROGRESS_FILE=str(path),
                                             WATCH_STARTED=str(started)),
                                    capture_output=True, text=True, timeout=5)
            self.assertEqual(result.returncode, 0, result.stderr)
            return int(result.stdout.strip())

    def test_missing_or_pre_run_heartbeat_ages_from_watchdog_start(self):
        self.assertEqual(self.progress_age(None), 100)
        self.assertEqual(self.progress_age(100), 100)
        self.assertEqual(self.progress_age(950), 50)

    @staticmethod
    def process_state(pid):
        try:
            return Path(f'/proc/{pid}/stat').read_text().rsplit(')', 1)[1].split()[0]
        except (FileNotFoundError, IndexError, OSError):
            result = subprocess.run(['ps', '-o', 'stat=', '-p', str(pid)],
                                    capture_output=True, text=True, check=False)
            return result.stdout.strip().split()[0] if result.stdout.strip() else ''

    @staticmethod
    def parent_pid(pid):
        try:
            return int(Path(f'/proc/{pid}/stat').read_text().rsplit(')', 1)[1].split()[1])
        except (FileNotFoundError, IndexError, OSError, ValueError):
            result = subprocess.run(['ps', '-o', 'ppid=', '-p', str(pid)],
                                    capture_output=True, text=True, check=False)
            return int(result.stdout.strip()) if result.stdout.strip() else 0

    def assert_stopped(self, pid):
        deadline = time.monotonic() + 3
        while time.monotonic() < deadline:
            try:
                os.kill(pid, 0)
            except ProcessLookupError:
                return
            if self.process_state(pid).startswith('Z'):
                return
            time.sleep(0.03)
        self.fail(f'process {pid} remains live')

    def test_watchdog_preserves_product_store_lease(self):
        with tempfile.TemporaryDirectory() as tmp:
            lease = Path(tmp) / 'product.lease'
            lease.mkdir()
            owner = lease / 'owner.json'
            content = json.dumps(dict(pid=os.getpid(), token='store-owned'))
            owner.write_text(content)
            os.utime(lease, (time.time()-10000, time.time()-10000))
            result = subprocess.run(['bash', '-c', LEASE+'\nreport_product_lease'],
                env=dict(os.environ, SINTER_PRODUCT_LEASE=str(lease),
                         WLOG=str(Path(tmp) / 'watchdog.log')),
                capture_output=True, text=True, timeout=5)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(owner.read_text(), content)
            self.assertFalse(list(Path(tmp).glob('*.stale.*')))

    def test_only_consecutive_current_run_zero_waves_hold_down(self):
        run = '[standing] RUN token=fixture\n'
        zero = '[standing] WAVE scored=0\n'
        scored = '[standing] WAVE scored=6\n'
        for log, expected in [(run+zero+zero, '2 2'),
                              (run+zero+scored+zero, '3 1'),
                              (run+zero+zero+run+scored, '1 0'),
                              (run+'untrusted scored 0 text\n', '0 0'),
                              ('', '0 0')]:
            with self.subTest(expected=expected), tempfile.TemporaryDirectory() as tmp:
                path = Path(tmp) / 'standing.log'
                path.write_text(log)
                result = subprocess.run(['bash', '-c', STREAK+'\nwave_streak'],
                    env=dict(os.environ, LOG=str(path)), capture_output=True,
                    text=True, timeout=5)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(result.stdout.strip(), expected)

    def test_valid_current_outcome_resets_age(self):
        self.assertLess(self.age([self.row()]), 65)

    def test_empty_malformed_future_and_historical_rows_cannot_hide_silence(self):
        for rows in [[], [None, 4], [self.row(-10000)], [self.row(7200)],
                     [{**self.row(), 'axes':'D=NaN A=8 R=8 N=8'}],
                     [{**self.row(), 'judges':['one','one']}]]:
            with self.subTest(rows=rows):
                self.assertGreaterEqual(self.age(rows), 3599)

    def test_actual_recycle_replaces_standing_and_keeps_watchdog(self):
        worker = f'wd-fixture-{os.getpid()}-{uuid.uuid4().hex[:6]}'
        other = f'{worker}-other'
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            lessons = root / '.omx/atelier/lessons'
            scripts = root / 'scripts/atelier'
            lessons.mkdir(parents=True)
            scripts.mkdir(parents=True)
            shutil.copy2(HELPER, scripts / 'supervision_lock.py')
            shutil.copy2(WATCHDOG, scripts / 'watchdog.sh')
            (scripts / 'repair-ledger.py').write_text('raise SystemExit(0)\n')
            standing = scripts / 'standing-loop.sh'
            standing.write_text('''#!/bin/bash
cd "$(dirname "$0")/../../" || exit 1
W="${WORKER_ID:-}"
H=scripts/atelier/supervision_lock.py
L=/tmp/sinter-standing-loop${W:+-$W}.lockd
T=$(python3 "$H" claim "$L" --pid "$$" --identity standing-loop.sh --worker "$W") || exit $?
cleanup() { [ -n "$T" ] && python3 "$H" release "$L" "$T" >/dev/null 2>&1 || true; }
trap cleanup EXIT
trap 'exit 143' TERM INT
if [ "${START_WATCHDOG:-0}" = 1 ] && [ ! -e "${WATCH_MARKER}" ]; then
  touch "${WATCH_MARKER}"
  WORKER_ID="$W" python3 "$H" launch-detached -- bash scripts/atelier/watchdog.sh >/dev/null 2>&1 &
fi
[ -s "${OWNER_HISTORY}" ] && touch "${PROGRESS_FILE}"
echo "$$" >> "${OWNER_HISTORY}"
sleep 30 & echo "$!" >> "${CHILD_HISTORY}"; wait
''')
            standing.chmod(0o755)
            progress = lessons / f'loop-progress-{worker}.heartbeat'
            progress.write_text('stale\n')
            old = time.time() - 10000
            os.utime(progress, (old, old))
            marker = root / 'watchdog.started'
            owner_history = root / 'owners.log'
            child_history = root / 'children.log'
            runtime = root / 'runtime'
            lease = runtime / 'product-projections.json.lease'
            lease.mkdir(parents=True)
            lease_owner = lease / 'owner.json'
            lease_content = '{"pid": 7, "token": "store-owned"}'
            lease_owner.write_text(lease_content)
            base_env = dict(os.environ, WORKER_ID=worker, START_WATCHDOG='1',
                            WATCH_MARKER=str(marker), OWNER_HISTORY=str(owner_history),
                            CHILD_HISTORY=str(child_history), PROGRESS_FILE=str(progress),
                            WATCHDOG_POLL_SECONDS='0.1',
                            WATCHDOG_STUCK_HUNG_SECONDS='0',
                            SINTER_LIMINAL_RUNTIME_ROOT=str(runtime))
            other_env = dict(base_env, WORKER_ID=other, START_WATCHDOG='0',
                             OWNER_HISTORY=str(root / 'other-owners.log'),
                             CHILD_HISTORY=str(root / 'other-children.log'),
                             PROGRESS_FILE=str(lessons / f'loop-progress-{other}.heartbeat'))
            (lessons / f'loop-progress-{other}.heartbeat').write_text('active\n')
            def owner(name, identity='standing-loop.sh'):
                lock = f'/tmp/sinter-{"watchdog" if identity == "watchdog.sh" else "standing-loop"}-{name}.lockd'
                result = subprocess.run(['python3', str(scripts / 'supervision_lock.py'),
                    'owner', lock, '--identity', identity, '--worker', name],
                    capture_output=True, text=True, check=False)
                return int(result.stdout.strip()) if result.returncode == 0 else None
            def wait_owner(name, identity='standing-loop.sh', timeout=8):
                deadline = time.monotonic() + timeout
                while time.monotonic() < deadline:
                    pid = owner(name, identity)
                    if pid is not None:
                        return pid
                    time.sleep(0.05)
                self.fail(f'no verified {identity} owner for {name}')
            def stop(name, identity='standing-loop.sh'):
                lock = f'/tmp/sinter-{"watchdog" if identity == "watchdog.sh" else "standing-loop"}-{name}.lockd'
                subprocess.run(['python3', str(scripts / 'supervision_lock.py'),
                    'terminate-owner', lock, '--identity', identity, '--worker', name,
                    '--grace', '0.2'], capture_output=True, check=False)
            def wait_replacement(old_pid):
                deadline = time.monotonic() + 10
                while time.monotonic() < deadline:
                    candidate = owner(worker)
                    if candidate is not None and candidate != old_pid:
                        return candidate
                    time.sleep(0.05)
                self.fail('watchdog did not replace the owned standing process')
            def wait_clear(identity='standing-loop.sh'):
                deadline = time.monotonic() + 5
                while time.monotonic() < deadline:
                    if owner(worker, identity) is None:
                        return
                    time.sleep(0.05)
                self.fail(f'{identity} owner did not clear')
            def wait_child(path):
                deadline = time.monotonic() + 5
                while time.monotonic() < deadline:
                    lines = path.read_text().splitlines() if path.exists() else []
                    if lines:
                        return int(lines[-1])
                    time.sleep(0.05)
                self.fail('standing fixture did not publish a child PID')
            old_proc = other_proc = None
            independent_proc = independent_watchdog = None
            try:
                other_proc = subprocess.Popen(['python3', str(scripts / 'supervision_lock.py'),
                    'launch', '--', 'bash', str(standing)], cwd=root, env=other_env)
                other_pid = wait_owner(other)
                old_proc = subprocess.Popen(['python3', str(scripts / 'supervision_lock.py'),
                    'launch', '--', 'bash', str(standing)], cwd=root, env=base_env)
                old_pid = wait_owner(worker)
                watchdog_pid = wait_owner(worker, 'watchdog.sh')
                self.assertNotEqual(self.process_state(watchdog_pid), 'Z')
                self.assertNotEqual(watchdog_pid, old_pid)
                self.assertNotEqual(self.parent_pid(watchdog_pid), old_pid)
                replacement = wait_replacement(old_pid)
                self.assertNotEqual(owner(worker, 'watchdog.sh'), None)
                old_child = int(child_history.read_text().splitlines()[0])
                self.assert_stopped(old_pid)
                self.assert_stopped(old_child)
                self.assertEqual(owner(other), other_pid)
                os.kill(other_pid, 0)
                self.assertEqual(lease_owner.read_text(), lease_content)
                stop(worker, 'watchdog.sh')
                wait_clear('watchdog.sh')
                stop(worker)
                wait_clear()
                owner_history.write_text('')
                child_history.write_text('')
                progress.write_text('stale\n')
                os.utime(progress, (old, old))
                independent_env = dict(base_env, START_WATCHDOG='0')
                independent_proc = subprocess.Popen(['python3', str(scripts / 'supervision_lock.py'),
                    'launch', '--', 'bash', str(standing)], cwd=root, env=independent_env)
                independent_old = wait_owner(worker)
                independent_child = wait_child(child_history)
                independent_watchdog = subprocess.Popen(['python3', str(scripts / 'supervision_lock.py'),
                    'launch', '--', 'bash', str(scripts / 'watchdog.sh')],
                    cwd=root, env=independent_env, stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL)
                adopted_watchdog = wait_owner(worker, 'watchdog.sh')
                self.assertNotEqual(self.parent_pid(adopted_watchdog), independent_old)
                independent_replacement = wait_replacement(independent_old)
                self.assertNotEqual(independent_replacement, independent_old)
                self.assert_stopped(independent_old)
                self.assert_stopped(independent_child)
                self.assertEqual(owner(worker, 'watchdog.sh'), adopted_watchdog)
                self.assertEqual(owner(other), other_pid)
                os.kill(other_pid, 0)
                self.assertEqual(lease_owner.read_text(), lease_content)
            finally:
                stop(worker, 'watchdog.sh')
                stop(worker)
                stop(other)
                for process in (old_proc, other_proc, independent_proc,
                                independent_watchdog):
                    if process is not None:
                        if process.poll() is None:
                            process.kill()
                        process.wait()


if __name__ == '__main__':
    unittest.main()
