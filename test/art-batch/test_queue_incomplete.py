"""F13: the queue must not say 'done' (or exit 0) when a canary failed and its seat's jobs were dropped.
usage: python3 -I test/art-batch/test_queue_incomplete.py [queue script]   (fake HOME, fake run_batch.py that fails)"""
import json, os, subprocess, sys, tempfile
script = os.path.abspath(sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(__file__), "..", "..", "scripts", "art-batch", "queue_more4.py"))
home = tempfile.mkdtemp(); base = os.path.join(home, "s1ntr-art"); os.makedirs(os.path.join(base, "out"))
json.dump({"s": [{"id": "p1"}, {"id": "p2"}]}, open(os.path.join(base, "prompts.json"), "w"))
open(os.path.join(base, "run_batch.py"), "w").write("import sys; sys.exit(1)\n")
r = subprocess.run([sys.executable, "-I", script, "k:s:1"], env=dict(os.environ, HOME=home, QUEUE_LAUNCH_PAUSE="0", QUEUE_POLL="0.2", GATE="100"),
                   capture_output=True, text=True, timeout=120)
out = r.stdout
assert "CANARY-FAIL" in out, out
assert "queue-INCOMPLETE" in out and "failed=1 dropped=1" in out, out
assert " queue-done" not in out, out
assert r.returncode == 1, (r.returncode, out)
print("ok")

# zero capacity must end the queue as incomplete, not sleep forever
json.dump({"k": 0}, open(os.path.join(base, "conc.json"), "w"))
r = subprocess.run([sys.executable, "-I", script, "k:s:1"], env=dict(os.environ, HOME=home, QUEUE_LAUNCH_PAUSE="0", QUEUE_POLL="0.2", GATE="100"),
                   capture_output=True, text=True, timeout=60)
assert "ZERO-CAPACITY" in r.stdout and "queue-INCOMPLETE" in r.stdout and r.returncode == 1, (r.returncode, r.stdout)
r = subprocess.run([sys.executable, "-I", script, "k:s:1"], env=dict(os.environ, HOME=home, N="0"), capture_output=True, text=True, timeout=60)
assert r.returncode != 0 and "N must be" in r.stderr, (r.returncode, r.stderr)
print("ok2")
