"""arm-trial.py: every scheduled attempt is made and logged; failures are null, never dropped; split is respected."""
import json
import os
import stat
import subprocess
import sys
import tempfile

SCRIPT = os.path.join(os.path.dirname(__file__), "..", "..", "scripts", "learning", "arm-trial.py")

FAKE = '''#!/usr/bin/env python3
import json, os, sys
a = sys.argv[1:]
out = a[a.index("-o") + 1]; prompt = a[-1]
if "CRASH" in prompt: sys.exit(1)
if "--teach" in a: print("UNTAUGHT: none" if os.environ.get("NOTEACH") else "Teaching: activated knowledge abc123def456 (visual)")
os.makedirs(out, exist_ok=True)
json.dump({"k": {"kind": "create", "result": {"operationId": "op", "evidence": {"status": "rendered"},
    "evaluation": {"score": float(os.environ["ARMSCORE"]), "failureClass": "none"}}}}, open(out + "/product-projections.json", "w"))
'''


def run(tmp, arms, prompts):
    fake = os.path.join(tmp, "fake-sinter")
    open(fake, "w").write(FAKE)
    os.chmod(fake, os.stat(fake).st_mode | stat.S_IEXEC)
    pj = os.path.join(tmp, "p.tsv")
    open(pj, "w").write("".join(f"{i}\t{p}\n" for i, p in prompts))
    sp = os.path.join(tmp, "s.json")
    json.dump({"prompts": {i: {"family": i, "split": s} for (i, _), s in zip(prompts, ["dev", "dev", "dev", "test"])}}, open(sp, "w"))
    af = os.path.join(tmp, "arms.json")
    json.dump(arms, open(af, "w"))
    out = os.path.join(tmp, "out")
    r = subprocess.run([sys.executable, SCRIPT, "--prompts", pj, "--splits", sp, "--use", "dev", "--arms", af,
                        "--work", os.path.join(tmp, "work"), "--out", out, "--parallel", "2"],
                       env=dict(os.environ, SINTER_BIN=fake), capture_output=True, text=True)
    return r, out


def test_failures_are_null_not_dropped_and_every_attempt_is_logged():
    with tempfile.TemporaryDirectory() as tmp:
        arms = {"none": {"env": {"ARMSCORE": "0.5"}}, "retrieval": {"env": {"ARMSCORE": "0.7"}}}
        r, out = run(tmp, arms, [("a", "ok"), ("b", "CRASH"), ("c", "ok"), ("t", "ok")])
        assert r.returncode == 0, r.stderr
        assert json.load(open(out + "/scheduled.json")) == ["a", "b", "c"]   # test split is not scheduled
        assert json.load(open(out + "/retrieval.json")) == {"a": 0.7, "b": None, "c": 0.7}
        assert json.load(open(out + "/none.json"))["b"] is None
        log = [json.loads(line) for line in open(os.path.join(tmp, "work", "attempts.jsonl"))]
        assert len(log) == 6 and {x["status"] for x in log} == {"scored", "exit-1"}
        assert all(x["provenance"] and x["budget"] == 2 for x in log)


def test_an_arm_that_asked_for_teaching_but_ran_untaught_fails():
    with tempfile.TemporaryDirectory() as tmp:
        arms = {"dream": {"env": {"ARMSCORE": "0.9", "NOTEACH": "1"}, "flags": ["--teach", "visual"]}}
        r, out = run(tmp, arms, [("a", "ok"), ("b", "ok"), ("c", "ok"), ("t", "ok")])
        assert json.load(open(out + "/dream.json")) == {"a": None, "b": None, "c": None}
