"""F12: an arm trial isolates ONE treatment. Ambient treatment env is scrubbed, a cached score only counts when it is bound to this
arm/prompt/flags/budget, and a fresh run that exited nonzero is a failed attempt even if a projection exists."""
import json, os, stat, subprocess, sys, tempfile

SCRIPT = os.path.join(os.path.dirname(__file__), "..", "..", "scripts", "learning", "arm-trial.py")
FAKE = '''#!/usr/bin/env python3
import json, os, sys
a = sys.argv[1:]
out = a[a.index("-o") + 1]
os.makedirs(out, exist_ok=True)
open(os.environ["SEEN"], "a").write(json.dumps({"exemplars": os.environ.get("SINTER_EXEMPLARS_FILE"), "arm": os.environ.get("ARMNAME")}) + "\\n")
json.dump({"k": {"kind": "create", "result": {"operationId": "op", "evidence": {"status": "rendered"},
    "evaluation": {"score": float(os.environ["ARMSCORE"]), "failureClass": "none"}}}}, open(out + "/product-projections.json", "w"))
sys.exit(int(os.environ.get("EXITCODE", "0")))
'''


def run(tmp, arms, extra_env=None, prompts=("a", "b")):
    fake = os.path.join(tmp, "fake-sinter"); open(fake, "w").write(FAKE); os.chmod(fake, os.stat(fake).st_mode | stat.S_IEXEC)
    pj = os.path.join(tmp, "p.tsv"); open(pj, "w").write("".join(f"{p}\tprompt-{p}\n" for p in prompts))
    sp = os.path.join(tmp, "s.json"); json.dump({"prompts": {p: {"family": p, "split": "dev"} for p in prompts}}, open(sp, "w"))
    af = os.path.join(tmp, "arms.json"); json.dump(arms, open(af, "w"))
    out = os.path.join(tmp, "out"); seen = os.path.join(tmp, "seen.jsonl")
    env = dict(os.environ, SINTER_BIN=fake, SEEN=seen, **(extra_env or {}))
    r = subprocess.run([sys.executable, SCRIPT, "--prompts", pj, "--splits", sp, "--use", "dev", "--arms", af,
                        "--work", os.path.join(tmp, "work"), "--out", out, "--parallel", "1"], env=env, capture_output=True, text=True)
    return r, out, [json.loads(l) for l in open(seen)] if os.path.exists(seen) else []


def test_ambient_exemplar_env_never_reaches_an_arm():
    with tempfile.TemporaryDirectory() as tmp:
        r, out, seen = run(tmp, {"none": {"env": {"ARMSCORE": "0.5"}}, "retrieval": {"env": {"ARMSCORE": "0.6", "SINTER_EXEMPLARS_FILE": "/arm/ex.json"}}},
                           {"SINTER_EXEMPLARS_FILE": "/ambient/sentinel.json"})
        assert r.returncode == 0, r.stderr
        assert {s["exemplars"] for s in seen} == {None, "/arm/ex.json"}, seen


def test_cached_score_is_reused_only_when_bound_to_the_same_arm_definition():
    with tempfile.TemporaryDirectory() as tmp:
        arms = {"none": {"env": {"ARMSCORE": "0.5"}}}
        run(tmp, arms)
        r, out, seen = run(tmp, arms)
        again = len(open(os.path.join(tmp, "seen.jsonl")).read().splitlines())
        # same definition: second invocation reused the cache, so no new attempts were made
        assert again == 2, again
        # changed definition (different budget-bound env) -> stale outputs are not trusted
        arms2 = {"none": {"env": {"ARMSCORE": "0.9"}}}
        r, out, seen = run(tmp, arms2)
        assert json.load(open(out + "/none.json")) == {"a": 0.9, "b": 0.9}


def test_a_nonzero_exit_is_a_failed_attempt_even_with_a_scored_projection():
    with tempfile.TemporaryDirectory() as tmp:
        r, out, seen = run(tmp, {"none": {"env": {"ARMSCORE": "0.8", "EXITCODE": "3"}}})
        assert json.load(open(out + "/none.json")) == {"a": None, "b": None}
