import ast, json, os, sys, importlib.util, pytest
HERE = os.path.dirname(__file__)
sys.path.insert(0, os.path.join(HERE, "..", "..", "scripts", "learning")); sys.path.insert(0, os.path.join(HERE, "..", "..", "scripts", "art-batch"))
import guidance as G
import install_guidance as I

TECH = {"id": "hydra:up:feedback+colorama", "name": "rainbow-datamosh", "direction": "up", "domain": "hydra", "signature": ["@feedback", "colorama"], "support": 2,
        "corpus_rate": 0.84, "corpus_base": 0.59, "mechanism": "feedback loop plus colorama wraps channels", "pattern_code": "src(o0).colorama(0.1).out(o0)", "knob_notes": "colorama sets churn"}
DOWN = dict(TECH, id="hydra:down:voronoi", name="voronoi", direction="down", signature=["voronoi"], support=22)
WEAK = dict(TECH, id="x", name="weak", corpus_rate=0.60)          # lift 0.01 < MIN_LIFT
OTHER = dict(TECH, id="p5", name="p5thing", domain="p5")


def ldir(tmp, techs=(), profile=None):
    d = tmp / "learning"; d.mkdir(exist_ok=True)
    (d / "techniques.jsonl").write_text("".join(json.dumps(t) + "\n" for t in techs))
    if profile: (d / "taste-profile.json").write_text(json.dumps(profile))
    return str(d)


def ids_unbare(domain="hydra", n=40):
    return [("%s-p%d" % (domain, i)) for i in range(n)]


def test_technique_injected_as_guidance_not_hardcoded(tmp_path):
    d = ldir(tmp_path, [TECH]); guided = 0
    for pid in ids_unbare():
        b, info = G.compose({"id": pid, "domain": "hydra", "prompt": "ORIGINAL BRIEF"}, d, "-r1", env={})
        assert b.startswith("ORIGINAL BRIEF")                        # the prompt itself is never rewritten
        if info["techniques"]:
            guided += 1
            assert "rainbow-datamosh" in b and "optional inspiration" in b and "Ignore any of it that conflicts" in b and "colorama" in b
    assert 0 < guided < 40                                          # a control share is left bare


def test_control_share_is_deterministic_and_about_a_quarter(tmp_path):
    d = ldir(tmp_path, [TECH]); res = [G.compose({"id": p, "domain": "hydra", "prompt": "x"}, d, "-r1", env={})[1]["control"] for p in ids_unbare(n=200)]
    assert res == [G.compose({"id": p, "domain": "hydra", "prompt": "x"}, d, "-r1", env={})[1]["control"] for p in ids_unbare(n=200)]
    assert 0.12 < sum(res) / 200 < 0.4


def test_domain_support_and_lift_gates(tmp_path):
    d = ldir(tmp_path, [DOWN, WEAK, OTHER])
    for pid in ids_unbare():
        b, info = G.compose({"id": pid, "domain": "hydra", "prompt": "P"}, d, "", env={})
        assert b == "P" and not info["techniques"]                  # down, weak-lift and other-domain techniques are never injected


def test_off_switch(tmp_path):
    d = ldir(tmp_path, [TECH])
    for pid in ids_unbare(n=10): assert G.compose({"id": pid, "domain": "hydra", "prompt": "P"}, d, "", env={"S1NTR_GUIDANCE": "0"})[0] == "P"


def test_taste_cold_start_is_silent_and_trained_profile_speaks(tmp_path):
    feats = ["chroma_p95", "value_range", "edge_density", "motion"]
    cold = {"features": feats, "weights": [0.0] * 4, "n_votes": 0, "n_pairs": 0}
    assert G.taste_sentence(cold) is None
    young = {"features": feats, "weights": [1.0, 0, 0, 0], "n_votes": 5, "n_pairs": 0}
    assert G.taste_sentence(young) is None
    ok = {"features": feats, "weights": [1.2, -0.8, 0.0, 0.1], "n_votes": 120, "n_pairs": 0}
    s = G.taste_sentence(ok); assert "saturated" in s and "flat, low-contrast" in s
    d = ldir(tmp_path, [], ok); got = [G.compose({"id": p, "domain": "p5", "prompt": "P"}, d, "", env={})[1]["taste"] for p in ids_unbare("p5")]
    assert any(got)


def test_install_patch_is_anchored_idempotent_and_feeds_the_generate_call(tmp_path):
    src = open(os.path.join(HERE, "..", "..", "scripts", "art-batch", "run_batch.py")).read()
    assert I.MARK in src                                            # the repo copy ships patched
    fresh = src.replace(I.HOOK, "").replace("  brief, ginfo = brief_for(p, out)\n", "").replace("brief]", "p['prompt']]").replace(" 'guidance': ginfo, 'brief_sha256': hashlib.sha256(brief.encode()).hexdigest(),", "")
    legacy_hook = I.HOOK.split("def brief_for", 1)[0] + I.OLD_BRIEF
    upgraded, changed = I.patch(src.replace(I.HOOK, legacy_hook))
    assert changed and upgraded == src and I.patch(upgraded)[1] is False
    assert I.MARK not in fresh
    new, changed = I.patch(fresh); assert changed and I.patch(new)[1] is False
    compile(new, "run_batch.py", "exec")
    def generate_arguments(node):
        return isinstance(node, ast.List) and [
            value.value if isinstance(value, ast.Constant) else None for value in node.elts[:3]
        ] == ["node", "bin/sinter", "generate"]
    calls = [node for node in ast.walk(ast.parse(new)) if generate_arguments(node)]
    assert len(calls) == 1
    assert isinstance(calls[0].elts[-1], ast.Name) and calls[0].elts[-1].id == "brief"
    assert "'guidance': ginfo" in new
    with pytest.raises(SystemExit): I.patch("print('nothing to anchor')")


def test_brief_file_is_reused_on_resume(tmp_path):
    ns = {"os": os, "sys": sys, "BASE": str(tmp_path), "REPO": str(tmp_path), "guidance": None}
    code = I.HOOK.split("def brief_for")[1]; exec("def brief_for" + code, ns)
    out = tmp_path / "run"; out.mkdir(); (out / "brief.txt").write_text("FIRST BRIEF")
    assert ns["brief_for"]({"id": "a", "domain": "hydra", "prompt": "NEW"}, str(out)) == ("FIRST BRIEF", {"reused": True})


def test_auto_refit_is_coalescing_and_serialised(tmp_path):
    import subprocess
    repo = tmp_path / "repo"; (repo / "scripts" / "art-batch").mkdir(parents=True)
    (repo / "scripts" / "art-batch" / "refresh_guidance.sh").write_text('#!/bin/bash\necho "run $1 $2" >> "$1/calls"\nsleep 1\n')
    sh = os.path.join(HERE, "..", "..", "scripts", "art-batch", "auto_refit.sh")
    env = dict(os.environ, S1NTR_REPO=str(repo), S1NTR_LEARNING=str(tmp_path / "L"), S1NTR_AIR_HOSTS="air1")
    a = subprocess.Popen(["bash", sh], env=env); import time; time.sleep(0.4)
    subprocess.run(["bash", sh], env=env, check=True); subprocess.run(["bash", sh], env=env, check=True)   # two votes mid-run
    a.wait()
    calls = (tmp_path / "L" / "calls").read_text().splitlines()
    assert calls == ["run %s air1" % (tmp_path / "L")] * 2          # one run, plus exactly one repeat for the votes that arrived meanwhile


MUTED_PROMPT = "A Hydra piece of cells under a microscope; a muted palette of moss, bone and deep teal."


def test_palette_guard_fires_on_muddy_palette_words_for_every_brief_including_control(tmp_path):
    """hydra-organic asked for 'a muted palette of moss, bone and deep teal' on every seat; owners marked 130 of those down (mud-camo)."""
    d = ldir(tmp_path, [TECH]); fired = ctl = 0
    for pid in ids_unbare(n=40):
        b, info = G.compose({"id": pid, "domain": "hydra", "prompt": MUTED_PROMPT}, d, "", env={})
        assert b.startswith(MUTED_PROMPT) and info["palette_guard"] and "high chroma" in b
        ctl += info["control"]
    assert ctl > 0                                              # the guard is a fix, so it also covers the bare control share
    b, info = G.compose({"id": "x", "domain": "hydra", "prompt": "A bright neon tunnel."}, d, "", env={"S1NTR_GUIDANCE": "0"})
    assert b == "A bright neon tunnel." and not info.get("palette_guard")
    b, info = G.compose({"id": "x", "domain": "hydra", "prompt": MUTED_PROMPT}, d, "", env={"S1NTR_GUIDANCE": "0"})
    assert b == MUTED_PROMPT                                    # the master off switch still means a bare prompt


def test_prompt_lint_rejects_muddy_palette_wording_and_passes_the_v2_set(tmp_path):
    import lint_prompts as LP
    bad = tmp_path / "bad.json"; bad.write_text(json.dumps({"hydra": [{"id": "h1", "prompt": MUTED_PROMPT}, {"id": "h2", "prompt": "Subtle earthy tones."}, {"id": "h3", "prompt": "Neon cells."}]}))
    assert [b[1] for b in LP.lint([str(bad)])] == ["h1", "h2"]
    v2 = os.path.join(HERE, "..", "..", "scripts", "art-batch", "prompts-hydra-organic-v2.json")
    assert LP.lint([v2]) == []                                   # the replacement set is clean
    both = tmp_path / "v1.json"; both.write_text(json.dumps([{"id": "hydra-organic-medium-r1", "prompt": MUTED_PROMPT}]))
    assert LP.lint([str(both), v2]) == []                        # v1 text kept as history is skipped once v2 supersedes it
