"""L5-14: replay selects by exact seat path (out/k never pulls out/kb), honours the CURRENT holdout (not the flag stored at first commit),
and an unreadable holdout file stops the run (exit 3) instead of meaning 'nothing held out'.
usage: python3 -I test/art-batch/test_learn_replay.py [script]"""
import glob, json, os, subprocess, sys, tempfile
script = os.path.abspath(sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(__file__), "..", "..", "scripts", "art-batch", "learn_after_batch.py"))
home = tempfile.mkdtemp(); base = os.path.join(home, "s1ntr-art"); repo = os.path.join(home, "repo"); os.makedirs(repo + "/bin"); os.makedirs(base + "/learning"); os.makedirs(base + "/logs")
open(repo + "/bin/sinter", "w").write("process.exit(0)\n"); os.makedirs(home + "/bin"); open(home + "/bin/node", "w").write("#!/bin/sh\nexit 0\n"); os.chmod(home + "/bin/node", 0o755)
os.makedirs(base + "/out/k")
def row(seat, pid): return {"run_dir": "out/%s/%s-r1" % (seat, pid), "finished_utc": "2026-11-18T00:00:00Z", "rc": 0, "prompt_id": pid, "model_key": seat, "create_key": seat + pid, "holdout": False}
open(base + "/learning/corpus.jsonl", "w").write("".join(json.dumps(r) + "\n" for r in (row("k", "ok"), row("kb", "other"), row("k", "held"))))
open(base + "/learning/holdout-prompts.txt", "w").write("held\n")   # frozen AFTER the row was committed with holdout=false
def run():
    env = dict(os.environ, HOME=home, S1NTR_LEARN_REPO=repo, LEARN_REPLAY=".", PATH=home + "/bin:" + os.environ["PATH"])
    return subprocess.run([sys.executable, "-I", script, "k"], env=env, capture_output=True, text=True)
r = run(); log = open(glob.glob(base + "/logs/learn-*.log")[0]).read()
assert r.returncode == 0 and "replay: 1 rows" in log, (r.returncode, r.stderr, log[-400:])      # only k/ok: not kb/other, not the now-held-out k/held
os.chmod(base + "/learning/holdout-prompts.txt", 0)
if os.geteuid() != 0:
    r = run(); assert r.returncode == 3, (r.returncode, r.stderr)
    os.chmod(base + "/learning/holdout-prompts.txt", 0o644)
print("PASS replay: exact seat, current holdout, unreadable holdout stops")
