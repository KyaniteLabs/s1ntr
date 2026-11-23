"""Owner overrides organ: capture, deterministic explain, scout rule, budget, held-out split. Keeper takes are fixtures."""
import json
import os
import sys

import pytest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "..", "scripts", "learning"))
import overrides_lib as L  # noqa: E402

FX = os.path.join(HERE, "..", "fixtures", "overrides")


def src(n): return open(os.path.join(FX, n + ".js")).read()
def toks(n): return L.code_tokens(src(n))
def frame(n, early=True):
    pytest.importorskip("numpy"); pytest.importorskip("PIL")
    import frame_features as FF
    e = os.path.join(FX, n + ".early.png")
    return FF.frame_features(os.path.join(FX, n + ".late.png"), e if early and os.path.exists(e) else None)


LOVED = "hydra-feedback-high-r2-r3"


def test_keeper_code_tokens_find_feedback_and_colorama_only_in_loved_takes():
    assert {"@feedback", "colorama"} <= toks(LOVED)
    assert {"@feedback", "colorama"} <= toks("hydra-organic-xhigh-r2-r3")
    assert "@feedback" in toks("hydra-feedback-high-r2-r1") and "colorama" not in toks("hydra-feedback-high-r2-r1")
    assert "colorama" not in toks("hydra-organic-xhigh-r2-r1") and "@feedback" not in toks("hydra-organic-xhigh-r2-r1")


def test_explain_names_rainbow_datamosh_from_sibling_diff_and_corpus_evidence():
    sib = [toks("hydra-feedback-high-r2-r1"), toks("hydra-feedback-high-r2-r2")]
    cands = L.technique_candidates(toks(LOVED), sib)
    assert frozenset(["@feedback", "colorama"]) in cands
    # corpus: feedback+colorama pieces are loved, colorama alone and feedback alone are not
    rated = [({"@feedback", "colorama"}, "up")] * 3 + [({"colorama"}, "down")] * 3 + [({"@feedback"}, "down")] * 4
    sig, (rate, n) = L.pick_signature(cands, rated, "up")
    assert sig == ["@feedback", "colorama"] and n == 3 and rate > 0.5
    name, cat = L.name_technique(sig, L.load_catalog(os.path.join(HERE, "..", "..", "scripts", "learning", "technique-catalog.json")))
    assert name == "rainbow-datamosh" and "fract" in cat["mechanism"]


def test_explain_groups_both_keepers_into_one_technique_and_gates_noise():
    def piece(uid, key, rid, take, name):
        return {"entry": {"key": key, "rid": rid, "id": rid, "take": take, "domain": "hydra"}, "tokens": toks(name), "src": src(name)}
    pieces = {
        "a": piece("a", "mimo", "fb", "r1", "hydra-feedback-high-r2-r1"), "b": piece("b", "mimo", "fb", "r2", "hydra-feedback-high-r2-r2"),
        "c": piece("c", "mimo", "fb", LOVED, LOVED),
        "d": piece("d", "mimo", "org", "r1", "hydra-organic-xhigh-r2-r1"), "e": piece("e", "mimo", "org", "r2", "hydra-organic-xhigh-r2-r2"),
        "f": piece("f", "mimo", "org", "r3", "hydra-organic-xhigh-r2-r3"),
        "g": piece("g", "x", "z", "r1", "hydra-feedback-high-r2-r3"),   # a third colorama+feedback piece, loved
    }
    votes = {"c": "up", "f": "up", "g": "up", "a": "down", "b": "down", "d": "down", "e": "down"}
    rows = L.explain([{"uid": "c", "direction": "up"}, {"uid": "f", "direction": "up"}], pieces, votes, L.load_catalog(os.path.join(HERE, "..", "..", "scripts", "learning", "technique-catalog.json")))
    top = rows[0]
    assert top["name"] == "rainbow-datamosh" and top["support"] == 2 and top["direction"] == "up"
    assert "colorama" in top["knobs"] and top["knobs"]["colorama"][0] > 0


def test_resolve_votes_uid_crosswalk_clear_and_unmapped(tmp_path):
    r = tmp_path / "r.jsonl"; c = tmp_path / "c.json"
    c.write_text(json.dumps({"alias": {"mimo/x": {"uid": "u1"}, "mimo/y": {"uid": None}}}))
    rows = [{"seat": "uid", "id": "u2", "uid": "u2", "vote": "up"}, {"seat": "mimo", "id": "x", "vote": "down"},
            {"seat": "mimo", "id": "x", "vote": "up"}, {"seat": "mimo", "id": "y", "vote": "up"},
            {"seat": "uid", "id": "u3", "uid": "u3", "vote": "up"}, {"seat": "uid", "id": "u3", "uid": "u3", "vote": None}]
    r.write_text("".join(json.dumps(x) + "\n" for x in rows))
    votes, st = L.resolve_votes(str(r), str(c))
    assert votes == {"u1": "up", "u2": "up"} and st["unresolved_aliases"] == 1


def test_classify_is_two_sided():
    fail = {"status": "failed", "score": 0.31, "fail": "below-quality-floor"}
    ok = {"status": "accepted", "score": 0.74}
    assert L.classify(fail, "up") == "override-up" and L.classify(ok, "down") == "override-down"
    assert L.classify(ok, "up") == "agree" and L.classify(fail, "down") == "agree"
    assert L.classify({"status": "unjudged", "score": None}, "up") is None


F_GOOD = {"chroma_p95": 0.75, "value_range": 0.7, "structure": 0.4, "motion": 0.17, "blank": False, "value_mean": 0.5, "hue_olive_teal": 0.2, "edge_density": 0.6}
FAIL = {"status": "failed", "score": 0.31, "fail": "below-quality-floor", "why": "saturated glitch static"}
FAMILY = [{"voronoi", "noise", "shape"}] * 4


def test_scout_overrules_alive_vivid_surprising_and_reports_which_gates_fired():
    out = L.scout(F_GOOD, FAIL, {"@feedback", "colorama", "voronoi", "noise", "shape", "rapid"}, FAMILY,
                  [dict(F_GOOD, chroma_p95=0.3, value_range=0.3, structure=0.8, edge_density=0.0, motion=0.02)] * 4)
    assert out["overrule"] and out["fired"] == ["a", "b", "c"] and {"@feedback", "colorama"} <= set(out["novel_ops"])


def test_scout_never_rescues_mud_dead_or_judge_passes():
    mud = dict(F_GOOD, chroma_p95=0.2, value_range=0.7, hue_olive_teal=0.9)
    o = L.scout(mud, FAIL, {"@feedback", "colorama"}, FAMILY, [])
    assert not o["overrule"] and not o["b"] and "mud-camo" in o["blocked"]
    blank = dict(F_GOOD, blank=True)
    assert not L.scout(blank, FAIL, {"x", "y"}, FAMILY, [])["overrule"]
    dead = dict(FAIL, fail="Hydra failed to render within timeout (blank output)", status="failed")
    o = L.scout(F_GOOD, dead, {"@feedback", "colorama"}, FAMILY, [])
    assert not o["overrule"] and not o["a"] and "judge-dead" in o["blocked"]
    assert L.scout(F_GOOD, {"status": "accepted", "score": 0.8}, {"a", "b"}, FAMILY, [])["blocked"] == "judge-did-not-fail"
    assert L.scout(None, FAIL, set(), [], [])["blocked"] == "no-frames"


def test_scout_not_alive_when_frames_do_not_move_and_not_surprising_when_family_does_the_same():
    still = dict(F_GOOD, motion=0.0)
    assert not L.scout(still, FAIL, {"a", "b", "c"}, [], [])["a"]
    same = L.scout(F_GOOD, FAIL, {"voronoi", "noise", "shape"}, FAMILY, [])
    assert not same["c"] and not same["overrule"]


def test_keeper_frames_are_alive_and_vivid_and_blank_takes_are_dead():
    f = frame(LOVED)
    assert not f["blank"] and f["chroma_p95"] >= L.RULE["VIVID_CHROMA"] and f["motion"] >= L.RULE["MOTION_MIN"] and not L.is_mud(f)
    assert frame("hydra-organic-xhigh-r2-r2")["blank"]
    assert L.failure_signatures(frame("hydra-organic-xhigh-r2-r2"), FAIL)


def test_budget_is_capped_and_follows_the_owner_hit_rate():
    base = L.budget(100, None); assert base == 10
    assert L.budget(100, 0.6) > base and L.budget(100, 0.05) < base
    assert L.budget(100, 0.9) <= 25 and L.budget(0, 0.9) <= 2


def test_holdout_split_is_by_family_and_stable():
    fams = {"p%d" % i: [i] for i in range(200)}
    h1, h2 = L.split_holdout(fams), L.split_holdout(dict(reversed(list(fams.items()))))
    assert h1 == h2 and 30 <= len(h1) <= 90


def test_knob_variants_scale_the_mechanism_operator_only():
    import overrides
    v = overrides.knob_variants(src(LOVED), ["@feedback", "colorama"])
    assert [x["factor"] for x in v] == [0.5, 1.5] and all("colorama" in x["source"] for x in v) and v[0]["source"] != src(LOVED)


def test_predict_uses_scout_and_matching_techniques_on_the_right_side():
    t_up = {"id": "hydra:up:feedback+colorama", "signature": ["@feedback", "colorama"], "direction": "up"}
    piece = {"entry": FAIL, "tokens": toks(LOVED)}
    assert L.predict(piece, [t_up], None) == ["technique:hydra:up:feedback+colorama"]
    assert L.predict({"entry": {"status": "accepted", "score": 0.8}, "tokens": toks(LOVED)}, [t_up], None) == []


def test_run_end_to_end_on_a_tiny_wall(tmp_path):
    pytest.importorskip("numpy"); pytest.importorskip("PIL")
    from PIL import Image
    import overrides
    wall = tmp_path / "wall"; (wall / "src").mkdir(parents=True); (wall / "posters").mkdir()
    names = ["hydra-feedback-high-r2-r1", "hydra-feedback-high-r2-r2", LOVED]
    data = []
    for i, n in enumerate(names):
        open(wall / "src" / ("s%d.html" % i), "w").write("<script>%s</script>" % src(n))
        Image.open(os.path.join(FX, n + ".late.png")).save(wall / "posters" / ("s%d.webp" % i))
        data.append({"uid": "m-%d" % i, "key": "mimo", "id": "fb", "rid": "fb", "take": n, "domain": "hydra", "hsrc": "src/s%d.html" % i,
                     "status": "failed" if n == LOVED else "accepted", "score": 0.31 if n == LOVED else 0.7})
    (wall / "index.html").write_text('<script id="data" type="application/json">%s</script>' % json.dumps(data))
    ratings = tmp_path / "r.jsonl"
    ratings.write_text(json.dumps({"seat": "uid", "id": "m-2", "uid": "m-2", "vote": "up"}) + "\n" + json.dumps({"seat": "uid", "id": "m-0", "uid": "m-0", "vote": "down"}) + "\n")
    out = tmp_path / "learning"
    ev, techs = overrides.run(str(wall), str(ratings), None, [], str(out))
    assert ev["overrides"] == {"total": 2, "up": 1, "down": 1}
    rec = [json.loads(l) for l in open(out / "overrides.jsonl")]
    assert {r["kind"] for r in rec} == {"override-up", "override-down"}
    rec = [r for r in rec if r["uid"] == "m-2"][0]
    assert rec["kind"] == "override-up" and rec["judge"]["verdict"] == "fail" and set(rec["scout"]) >= {"a", "b", "c", "fired"}
    for f in ("techniques.jsonl", "technique-guidance.md", "serendipity-queue.jsonl", "overrides-eval.json"): assert (out / f).exists()


def test_resolve_votes_honours_the_uid_a_current_wall_vote_carries(tmp_path):
    # the wall now posts {seat:'ds0731', id:..., uid:'ds0731-xxxx'}; the learner used to drop every such vote (seat != 'uid', no crosswalk alias)
    r = tmp_path / "r.jsonl"
    r.write_text(json.dumps({"seat": "ds0731", "id": "hydra-kaleid-high-r1", "uid": "ds0731-aaaa", "vote": "up"}) + "\n"
                 + json.dumps({"seat": "ds0731", "id": "hydra-kaleid-high-r1", "uid": "ds0731-aaaa", "vote": "down"}) + "\n")
    votes, st = L.resolve_votes(str(r), None)
    assert votes == {"ds0731-aaaa": "down"}
