"""L5-04: a run must not reach the corpus as 'learned' before the stages that learn from it succeeded.
 - rc=0 run without product-projections.json is NOT committed (PENDING-PROJECTION), then committed once the projection exists
 - a failing signed judge export leaves the row learn_pending, exits 3, and the next run retries it; a good run clears the flag
 - an existing rc=0 `no_projection` row is rehydrated when its projection appears
usage: python3 -I test/art-batch/test_learn_pending.py [script]"""
import json, os, subprocess, sys, tempfile
script = os.path.abspath(sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(__file__), "..", "..", "scripts", "art-batch", "learn_after_batch.py"))
home = tempfile.mkdtemp(); base = os.path.join(home, "s1ntr-art"); repo = os.path.join(home, "repo")
os.makedirs(repo + "/bin")
def stub(rc):
    with open(repo + "/bin/sinter", "w") as f:
        f.write("""// --training-filter
const fs = require('node:fs');
const i = process.argv.indexOf('--accepted-sources-out');
if (i >= 0) fs.writeFileSync(process.argv[i + 1], '[]');
process.exit(i >= 0 ? 0 : %d);
""" % rc)
stub(1)
def run(extra=None):
    env = dict(os.environ, HOME=home, S1NTR_LEARN_REPO=repo); env.update(extra or {})
    return subprocess.run([sys.executable, "-I", script, "k"], env=env, capture_output=True, text=True)
def mk(name, proj):
    d = os.path.join(base, "out", "k", name); os.makedirs(d)
    json.dump({"finished_utc": "2026-11-18T00:00:0%dZ" % len(name), "model_key": "k", "prompt_id": name, "rc": 0}, open(d + "/manifest.json", "w"))
    if proj: write_proj(d)
    return d
def write_proj(d):
    json.dump({"production-create:" + os.path.basename(d): {"kind": "create", "result": {"evaluation": {"score": 0.7, "admissionEligible": True}, "receipt": {"artifactDigest": "dd"}}}}, open(d + "/product-projections.json", "w"))
def corpus():
    p = base + "/learning/corpus.jsonl"; return [json.loads(l) for l in open(p)] if os.path.exists(p) else []
d1 = mk("a-r1", True); d2 = mk("bb-r1", False)
r = run()
rows = corpus()
assert r.returncode == 3, (r.returncode, r.stderr)                      # signed judge export failed
assert [x["prompt_id"] for x in rows] == ["a-r1"], rows                 # projection-less rc=0 run not committed
assert rows[0]["learn_pending"] is True
write_proj(d2); stub(0)
r = run(); rows = {x["prompt_id"]: x for x in corpus()}
assert r.returncode == 0, (r.returncode, r.stdout, r.stderr)
assert set(rows) == {"a-r1", "bb-r1"} and not any(x.get("learn_pending") for x in rows.values()), rows   # retried, committed, cleared
# legacy no_projection rc=0 row: rehydrated once the projection exists
d3 = mk("ccc-r1", False); legacy = {"run_dir": os.path.relpath(d3, base), "finished_utc": "2026-11-18T00:00:06Z", "rc": 0, "prompt_id": "ccc-r1", "no_projection": "x"}
open(base + "/learning/corpus.jsonl", "a").write(json.dumps(legacy) + "\n"); write_proj(d3)
assert run().returncode == 0
c = [x for x in corpus() if x["prompt_id"] == "ccc-r1"]
assert len(c) == 1 and "no_projection" not in c[0] and c[0]["create_key"] and not c[0].get("learn_pending"), c
print("PASS pending-projection, retry-on-stage-failure, rehydrate")
