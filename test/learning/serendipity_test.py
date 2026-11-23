"""Deterministic off-profile takes and replay of the saved guidance decision."""
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "scripts" / "learning"))
import guidance as G

FEATS = list(G.PHRASES)


def profile(**w):
    return {"features": FEATS, "weights": [w.get(f, 0.0) for f in FEATS], "n_votes": 40}


def ldir(tmp, prof=None, techs=()):
    d = tmp / "learning"; d.mkdir(parents=True, exist_ok=True)
    (d / "techniques.jsonl").write_text("".join(json.dumps(t) + "\n" for t in techs))
    if prof: (d / "taste-profile.json").write_text(json.dumps(prof))
    return str(d)


def briefs(d, n=240, env=None, domain="hydra"):
    return [G.compose({"id": "%s-p%d" % (domain, i), "domain": domain, "prompt": "BASE"}, d, "", dict(env or {})) for i in range(n)]


LOVES_DETAIL = dict(edge_density=1.2, motion=0.8, chroma_p95=1.0, value_range=0.6)


def test_share_is_about_one_in_six_and_env_configurable_and_off_at_zero(tmp_path):
    d = ldir(tmp_path, profile(**LOVES_DETAIL)); r = briefs(d)
    assert r == briefs(d)
    k = sum(1 for _, i in r if i.get("serendipity"))
    assert 240 / 6 * .55 < k < 240 / 6 * 1.45, k
    assert sum(1 for _, i in briefs(d, env={"S1NTR_SERENDIPITY_ONE_IN": "0"}) if i.get("serendipity")) == 0
    k2 = sum(1 for _, i in briefs(d, env={"S1NTR_SERENDIPITY_ONE_IN": "2"}) if i.get("serendipity"))
    assert k2 > k * 1.8 and k2 < 240 * .65


def test_control_takes_are_never_serendipity_and_cold_start_has_nothing_to_leave(tmp_path):
    d = ldir(tmp_path, profile(**LOVES_DETAIL))
    for b, i in briefs(d, env={"S1NTR_SERENDIPITY_ONE_IN": "1"}):
        assert not (i.get("control") and i.get("serendipity"))
        if i.get("control"): assert b == "BASE"
    cold = ldir(tmp_path / "x", None)
    assert not any(i.get("serendipity") for _, i in briefs(cold, env={"S1NTR_SERENDIPITY_ONE_IN": "1"}))


def test_axis_pushes_against_the_learned_sign_logs_the_axis_and_drops_that_axis_from_the_taste_line(tmp_path):
    d = ldir(tmp_path, profile(**LOVES_DETAIL)); seen = set()
    for b, i in briefs(d, env={"S1NTR_SERENDIPITY_ONE_IN": "1"}):
        if i.get("control") or i.get("serendipity_kind") != "axis": continue
        seen.add(i["serendipity_axis"]); assert i["serendipity_axis"] in G.SER_AXES and "Exploration take" in b
        w = dict(zip(FEATS, profile(**LOVES_DETAIL)["weights"]))[i["serendipity_axis"]]
        assert i["serendipity_dir"] == ("+" if w < 0 else "-")
        assert G.SER_AXES[i["serendipity_axis"]][0 if w < 0 else 1] in b
    assert seen <= {"edge_density", "motion"} and seen   # only axes the profile has an opinion on; chroma/range never


def test_never_perturbs_toward_muddy_or_off_the_tonal_axes(tmp_path):
    assert not (set(G.SER_AXES) & {"chroma_mean", "chroma_p95", "value_range", "value_std"})
    for f, (hi, lo) in G.SER_AXES.items(): assert not G.MUDDY.search(hi + " " + lo), f
    assert not G.MUDDY.search(G.SER_KEEP)
    d = ldir(tmp_path, profile(chroma_p95=1.5, chroma_mean=1.0, value_range=1.0, value_std=.8))   # opinions only on never-axes
    assert not any(i.get("serendipity_kind") == "axis" for _, i in briefs(d, env={"S1NTR_SERENDIPITY_ONE_IN": "1"}))
    for b, i in briefs(ldir(tmp_path / "y", profile(**LOVES_DETAIL)), env={"S1NTR_SERENDIPITY_ONE_IN": "1"}):
        assert not G.MUDDY.search(b.split("Exploration take")[-1]), b[-300:]


def test_unseen_technique_mode_picks_a_technique_the_profile_has_not_proven(tmp_path):
    proven = {"id": "h1", "name": "proven", "domain": "hydra", "direction": "up", "support": 9, "corpus_rate": .8, "corpus_base": .5, "signature": ["a"]}
    fresh = {"id": "h2", "name": "fresh-idea", "domain": "hydra", "direction": "up", "support": 1, "corpus_rate": .6, "corpus_base": .5, "signature": ["b"]}
    d = ldir(tmp_path, profile(**LOVES_DETAIL), [proven, fresh]); got = [i for _, i in briefs(d, env={"S1NTR_SERENDIPITY_ONE_IN": "1"}) if i.get("serendipity_kind") == "technique"]
    assert got and all(i["serendipity_axis"] == "technique:fresh-idea" and "fresh-idea" not in i["techniques"] for i in got)


def test_replay_keeps_the_decision_after_a_profile_change(tmp_path, monkeypatch):
    monkeypatch.setenv("S1NTR_SERENDIPITY_ONE_IN", "1")
    d = ldir(tmp_path, profile(**LOVES_DETAIL))
    entry = {"id": "take", "domain": "hydra", "prompt": "BASE"}
    while G._bucket("ctl:" + entry["id"], G.CONTROL_ONE_IN) == 0:
        entry["id"] += "x"
    out = tmp_path / "run"
    brief, info = G.saved_brief(entry, out, d, "")
    assert info["serendipity"]
    (out / "brief.txt").unlink()
    monkeypatch.setenv("S1NTR_GUIDANCE", "0")
    assert G.saved_brief(entry, out, d, "") == (brief, dict(info, reused=True))
    assert (out / "brief.txt").read_text() == brief
