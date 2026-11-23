"""F07: the batch learner must hand Dream the renderer identity the real browser reports (`sinter dream renderer-digest`),
never a hash guessed from folder names; when no identity can be had it must not spend a Dream generation call."""
import json, os, subprocess, sys, tempfile
sys.path.insert(0, os.path.dirname(__file__))
from learn_after_batch_holdout_test import PROOF_EXPORT, SCRIPT, world

STUB = """#!/usr/bin/env node
const fs = require('fs'); const argv = process.argv.slice(2);
""" + PROOF_EXPORT + """const a = argv;
fs.appendFileSync(process.env.STUB_CALLS, JSON.stringify({a, digest: process.env.SINTER_DREAM_RENDERER_ENVIRONMENT_DIGEST || null}) + '\\n');
if (a[0] === 'dream' && a[1] === 'renderer-digest') {
  if (process.env.STUB_DIGEST) { console.log(process.env.STUB_DIGEST); process.exit(0); }
  console.error('DREAM_RENDERER_DIGEST_UNAVAILABLE: no chromium'); process.exit(6);
}
process.exit(0);
// 'compost' "taste ingest <corpus" cmd === 'judge-evidence'
"""


def go(extra, evidence="ab" * 32):
    with tempfile.TemporaryDirectory() as tmp:
        home, base, repo, shas = world(tmp, ["p1"], renderer=evidence)
        open(os.path.join(repo, "bin", "sinter"), "w").write(STUB)
        ld = os.path.join(base, "learning")
        os.makedirs(os.path.join(ld, "dream")); os.makedirs(os.path.join(ld, "runtime"))
        json.dump({"schema": "x"}, open(os.path.join(ld, "dream", "command.base.json"), "w"))
        open(os.path.join(ld, "holdout-dream.txt"), "w").write("held-out")
        calls = os.path.join(tmp, "calls.jsonl"); open(calls, "w").close()
        env = dict(os.environ, HOME=home, S1NTR_LEARN_REPO=repo, STUB_CALLS=calls, STUB_PROOFS=os.path.join(tmp, "verified-sources.json"), **extra)
        env.pop("STUB_DIGEST", None) if "STUB_DIGEST" not in extra else None
        r = subprocess.run([sys.executable, "-I", SCRIPT, "k"], env=env, capture_output=True, text=True, cwd=tmp)
        logs = "".join(open(os.path.join(dp, f)).read() for dp, _, fs in os.walk(base) for f in fs if f.startswith("learn-") and f.endswith(".log"))
        return r, [json.loads(l) for l in open(calls)], logs


def test_dream_gets_the_browsers_own_identity():
    want = "ab" * 32
    r, calls, logs = go({"STUB_DIGEST": want})
    runs = [c for c in calls if c["a"][:2] == ["dream", "run"]]
    assert len(runs) == 1, (r.stdout, r.stderr, calls)
    assert runs[0]["digest"] == want


def test_no_browser_identity_means_no_generation_call():
    r, calls, logs = go({})
    assert not [c for c in calls if c["a"][:2] == ["dream", "run"]], calls
    assert "DREAM-PENDING: renderer identity not usable" in logs


def test_host_that_is_not_the_evidence_renderer_spends_nothing():
    r, calls, logs = go({"STUB_DIGEST": "ab" * 32}, evidence="cd" * 32)
    assert not [c for c in calls if c["a"][:2] == ["dream", "run"]], calls
    assert "renderer identity not usable" in logs
    assert r.returncode != 0
