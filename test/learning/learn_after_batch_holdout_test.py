"""A frozen or unsigned piece cannot reach learning, including on replay or after source healing.

Runs the learner against a stub with a separate fixture for verified judge evidence.
"""
import hashlib, json, os, subprocess, sys, tempfile

SCRIPT = os.environ.get("LEARN_SCRIPT") or os.path.join(os.path.dirname(__file__), "..", "..", "scripts", "art-batch", "learn_after_batch.py")
# Both the retry and renderer fixtures consume this same offline proof-export contract.
PROOF_EXPORT = """// This stub supports --training-filter and returns only fixture-approved runs.
const output = argv.indexOf('--accepted-sources-out');
if (output !== -1) {
  const trusted = JSON.parse(fs.readFileSync(process.env.STUB_PROOFS, 'utf8'));
  fs.writeFileSync(argv[output + 1], JSON.stringify(trusted.filter(proof => argv.includes(proof.run_dir))));
}
"""
STUB = """#!/usr/bin/env node
const fs = require('fs'); const argv = process.argv.slice(2);
""" + PROOF_EXPORT + """const recorded = argv.slice();
if (argv[0] === 'compost' && argv[1] === 'add') recorded[2] = fs.readFileSync(argv[2], 'utf8');
fs.appendFileSync(process.env.STUB_CALLS, JSON.stringify(recorded) + '\\n');
process.exit(0);
// cmd === 'judge-evidence'; --training-filter
"""


def world(tmp, pieces, renderer="ab" * 32):
    home = os.path.join(tmp, "home"); base = os.path.join(home, "s1ntr-art"); repo = os.path.join(tmp, "repo")
    os.makedirs(os.path.join(repo, "bin")); open(os.path.join(repo, "bin", "sinter"), "w").write(STUB)
    shas = {}
    for pid in pieces:
        d = os.path.join(base, "out", "k", pid); os.makedirs(os.path.join(d, "artifacts", "a1"))
        src = "<html>%s</html>" % pid; open(os.path.join(d, "artifacts", "a1", "source.txt"), "w").write(src)
        shas[pid] = hashlib.sha256(src.encode()).hexdigest()
        json.dump({"finished_utc": "2026-11-18T00:00:00Z", "model_key": "k", "prompt_id": pid, "rc": 0}, open(os.path.join(d, "manifest.json"), "w"))
        json.dump({"ck-" + pid: {"kind": "create", "result": {"operationId": "op-" + pid, "evaluation": {"score": 0.9, "degraded": False, "admissionEligible": True},
                   "receipt": {"artifactDigest": "dg-" + pid}}}}, open(os.path.join(d, "product-projections.json"), "w"))
    proofs = [{"run_dir": os.path.join(base, "out", "k", pid), "create_key": "ck-" + pid, "score": 0.9,
               "domain": "p5", "artifact_digest": "dg-" + pid, "source_sha256": shas[pid],
               "create_receipt_digest": shas[pid],
               "renderer_environment_digest": renderer, "state_root": os.path.join(base, "learning", "runtime")} for pid in pieces]
    with open(os.path.join(tmp, "verified-sources.json"), "w") as proofs_file:
        json.dump(proofs, proofs_file)
    return home, base, repo, shas


def run(tmp, home, repo, **extra):
    calls = os.path.join(tmp, "calls.jsonl"); open(calls, "w").close()  # per-run call log
    env = dict(os.environ, HOME=home, S1NTR_LEARN_REPO=repo, STUB_CALLS=calls,
               STUB_PROOFS=os.path.join(tmp, "verified-sources.json"), **extra)
    r = subprocess.run([sys.executable, "-I", SCRIPT, "k"], env=env, capture_output=True, text=True, cwd=tmp)
    return r, [json.loads(l) for l in open(calls)]


def composted(calls):
    return [call[2] for call in calls if call[:2] == ["compost", "add"]]


def test_row_frozen_after_ingest_is_excluded_from_every_stage_on_replay():
    with tempfile.TemporaryDirectory() as tmp:
        home, base, repo, shas = world(tmp, ["p1", "p2"])
        r, calls = run(tmp, home, repo)
        assert r.returncode == 0 and composted(calls) == ["<html>p1</html>", "<html>p2</html>"]
        open(os.path.join(base, "learning", "holdout-files.txt"), "w").write(shas["p2"] + "\n")
        r, calls = run(tmp, home, repo, LEARN_REPLAY=".")
        assert composted(calls) == ["<html>p1</html>"], "frozen p2 reached compost on replay"
        je = [c for c in calls if c and c[0] == "judge-evidence"][-1]
        assert not any(x.endswith("/p2") for x in je), je
        assert all(c[:2] != ["taste", "ingest"] for c in calls)


def test_healed_row_whose_source_hash_is_frozen_is_not_trained():
    with tempfile.TemporaryDirectory() as tmp:
        home, base, repo, shas = world(tmp, ["p1", "p2"])
        rows = [{"run_dir": "out/k/%s" % p, "finished_utc": "2026-11-18T00:00:00Z", "prompt_id": p, "model_key": "k", "create_key": "ck-" + p,
                 "score": 0.9, "admission_eligible": True, "degraded": False} for p in ("p1", "p2")]
        os.makedirs(os.path.join(base, "learning"))
        open(os.path.join(base, "learning", "corpus.jsonl"), "w").write("".join(json.dumps(x) + "\n" for x in rows))
        open(os.path.join(base, "learning", "holdout-files.txt"), "w").write(shas["p2"] + "\n")
        r, calls = run(tmp, home, repo)
        assert composted(calls) == ["<html>p1</html>"], r.stderr
        stored = {json.loads(l)["prompt_id"]: json.loads(l) for l in open(os.path.join(base, "learning", "corpus.jsonl"))}
        assert stored["p2"]["holdout"] is True


def test_unreadable_holdout_list_fails_closed():
    with tempfile.TemporaryDirectory() as tmp:
        home, base, repo, _ = world(tmp, ["p1"])
        os.makedirs(os.path.join(base, "learning", "holdout-files.txt"))  # a directory: open() raises IsADirectoryError
        r, calls = run(tmp, home, repo)
        assert calls == [], "trained with an unreadable holdout list"
        assert "LEARN-FAIL" in r.stderr
