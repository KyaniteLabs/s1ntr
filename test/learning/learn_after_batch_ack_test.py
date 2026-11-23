"""F08: a failed stage is not acknowledged as corpus progress. A rerun (no ad hoc LEARN_REPLAY regex) redoes only the unfinished
stage, a failure exits nonzero, and a changed evidence set gets its own Dream idempotency key."""
import json, os, shutil, subprocess, sys, tempfile
sys.path.insert(0, os.path.dirname(__file__))
from learn_after_batch_holdout_test import PROOF_EXPORT, SCRIPT, world

STUB = """#!/usr/bin/env node
const fs = require('fs'); const argv = process.argv.slice(2);
""" + PROOF_EXPORT + """const a = argv;
let cmd = null;
if (a[0] === 'dream' && a[1] === 'run') cmd = JSON.parse(fs.readFileSync(a[2], 'utf8'));
fs.appendFileSync(process.env.STUB_CALLS, JSON.stringify({a, cmd}) + '\\n');
if (a[0] === 'dream' && a[1] === 'renderer-digest') { console.log('ab'.repeat(32)); process.exit(0); }
if (a.includes('--write-negatives') && process.env.STUB_FAIL_EXPORT === '1') { console.error('boom'); process.exit(1); }
process.exit(0);
// 'compost' "taste ingest <corpus" cmd === 'judge-evidence'
"""


def prep(tmp, pieces):
    home, base, repo, shas = world(tmp, pieces)
    open(os.path.join(repo, "bin", "sinter"), "w").write(STUB)
    ld = os.path.join(base, "learning"); os.makedirs(os.path.join(ld, "dream"), exist_ok=True); os.makedirs(os.path.join(ld, "runtime"), exist_ok=True)
    json.dump({"schema": "x", "idempotencyKey": "dream-base"}, open(os.path.join(ld, "dream", "command.base.json"), "w"))
    open(os.path.join(ld, "holdout-dream.txt"), "w").write("held-out")
    return home, base, repo


def go(tmp, home, repo, **extra):
    calls = os.path.join(tmp, "calls.jsonl"); open(calls, "w").close()
    env = dict(os.environ, HOME=home, S1NTR_LEARN_REPO=repo, STUB_CALLS=calls, STUB_PROOFS=os.path.join(tmp, "verified-sources.json"), **extra)
    r = subprocess.run([sys.executable, "-I", SCRIPT, "k"], env=env, capture_output=True, text=True, cwd=tmp)
    return r, [json.loads(l) for l in open(calls)]


def names(calls):
    return [" ".join(c["a"][:2]) for c in calls]


def test_failed_stage_exits_nonzero_and_rerun_finishes_only_that_stage():
    with tempfile.TemporaryDirectory() as tmp:
        home, base, repo = prep(tmp, ["p1"])
        r1, c1 = go(tmp, home, repo, STUB_FAIL_EXPORT="1")
        assert r1.returncode != 0, (r1.stdout, r1.stderr)
        r2, c2 = go(tmp, home, repo)
        assert r2.returncode == 0, (r2.stdout, r2.stderr)
        assert any("--write-negatives" in c["a"] for c in c2), names(c2)               # redone without LEARN_REPLAY
        assert not [n for n in names(c2) if n.startswith("compost")], names(c2)  # compost already acknowledged: exactly once
        r3, c3 = go(tmp, home, repo)
        assert r3.returncode == 0
        assert all("--write-negatives" not in c["a"] and c["a"][:2] not in (["compost", "add"], ["dream", "run"]) for c in c3)


def test_changed_evidence_set_gets_its_own_dream_key():
    with tempfile.TemporaryDirectory() as tmp:
        home, base, repo = prep(tmp, ["p1", "p2"])
        # Hold back the second run until the same batch has finished once.
        piece = os.path.join(base, "out", "k", "p2")
        pending = os.path.join(tmp, "pending")
        shutil.move(piece, pending)
        _, c1 = go(tmp, home, repo)
        k1 = [c["cmd"]["idempotencyKey"] for c in c1 if c["cmd"]]
        shutil.move(pending, piece)
        _, c2 = go(tmp, home, repo)
        k2 = [c["cmd"]["idempotencyKey"] for c in c2 if c["cmd"]]
        assert k1 and k2 and k1 != k2 and all(k.startswith("dream-base") for k in k1 + k2), (k1, k2)
