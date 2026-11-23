import json, os, sys
import pytest
np = pytest.importorskip("numpy")
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "scripts", "learning"))
import beauty as B

F = {"chroma_mean": .4, "chroma_p95": .8, "value_range": .7, "value_mean": .5, "value_std": .2, "edge_density": .3, "structure": .4,
     "palette_entropy": 2.0, "balance_x": .1, "balance_y": -.1, "right_bias": .55, "motion": .2, "blank": False, "hue_olive_teal": .1}


def pool(n=120, seed=0):
    r = np.random.default_rng(seed); out = []
    for _ in range(n):
        f = dict(F); f["chroma_p95"] = float(r.uniform(0, 1)); f["edge_density"] = float(r.uniform(0, .6)); f["motion"] = float(r.uniform(0, .5))
        out.append(f)
    return out


def test_identical_frames_different_prompts_same_score():
    prof = B.new_profile([B.vectorise(f) for f in pool()]); prof["weights"] = [0.3] * len(B.FEATURES)
    a = {"f": dict(F), "entry": {"prompt": "a calm forest", "domain": "hydra", "score": 0.9, "status": "accepted", "rid": "x"}}
    b = {"f": dict(F), "entry": {"prompt": "chaotic glitch storm", "domain": "p5", "score": 0.1, "status": "failed", "rid": "y"}}
    assert B.score_vec(prof, B.piece_vector(a)) == B.score_vec(prof, B.piece_vector(b))
    ra, rb = B.beauty_records({"a": a}, prof)[0], B.beauty_records({"b": b}, prof)[0]
    assert ra["beauty"] == rb["beauty"] and ra["prompt_fit"] != rb["prompt_fit"]   # two separate fields


def test_neutral_profile_is_half():
    prof = B.new_profile([B.vectorise(f) for f in pool()])
    assert B.score_vec(prof, B.vectorise(F)) == 0.5


def test_fit_recovers_preference_and_auc():
    ps = pool(200); X = [B.vectorise(f) for f in ps]; y = [1 if f["chroma_p95"] > .5 else 0 for f in ps]
    base = B.new_profile(X); q = B.fit_votes(base, X[:150], y[:150])
    assert B.auc([B.score_vec(q, x) for x in X[150:]], y[150:]) > .95


def test_export_import_roundtrip(tmp_path):
    X = [B.vectorise(f) for f in pool()]; q = B.fit_votes(B.new_profile(X), X, [i % 2 for i in range(len(X))])
    p = str(tmp_path / "p.json"); B.save_profile(q, p); r = B.load_profile(p)
    assert r == q and "image" not in json.dumps(r) and len(json.dumps(r)) < 4000
    bad = dict(q, feature_version="beauty.f0"); json.dump(bad, open(p, "w"))
    with pytest.raises(ValueError): B.load_profile(p)


def test_pairwise_fit_and_active_pair():
    ps = pool(80); X = {str(i): B.vectorise(f) for i, f in enumerate(ps)}; base = B.new_profile(list(X.values()))
    wins = [(str(i), str(j)) for i in range(0, 40, 2) for j in (i + 1,) if ps[i]["chroma_p95"] > ps[j]["chroma_p95"]] + \
           [(str(j), str(i)) for i in range(0, 40, 2) for j in (i + 1,) if ps[i]["chroma_p95"] <= ps[j]["chroma_p95"]]
    q, cov = B.fit_pairs(base, [X[w] for w, _ in wins], [X[l] for _, l in wins])
    assert q["weights"][B.FEATURES.index("chroma_p95")] > 0
    nxt = B.next_pair(q, cov, X, set(wins)); assert nxt and nxt[0] != nxt[1] and nxt not in wins


def test_seed_pairs_span_archetypes():
    r = np.random.default_rng(1); pl = {}
    for i, f in enumerate(pool(60, 3)): f["structure"] = float(r.uniform(0, 1)); pl[str(i)] = f
    pl["blank"] = dict(F, blank=True); sp = B.seed_pairs(pl)
    assert len(sp) >= 2 and all(a != b and "blank" not in (a, b) for a, b in sp)


def test_stop_rule_bounds():
    s = B.StopRule(min_pairs=3, max_pairs=5); sc = [1, 2, 3, 4]
    assert [s.update(sc) for _ in range(5)] == [False, False, True, True, True]


def test_auc_ties_and_missing():
    assert B.auc([1, 1], [1, 0]) == .5 and B.auc([1, 2], [1, 1]) is None


def test_platt_calibration_fixes_saturation_and_keeps_ranking():
    ps = pool(80, 5); X = [B.vectorise(f) for f in ps]; nz = np.random.default_rng(1).normal(size=80); y = [1 if f["chroma_p95"] + nz[i] * .6 > .5 else 0 for i, f in enumerate(ps)]
    base = B.new_profile(X); raw = B.fit_votes(base, X, y); cal = B.fit_calibrated(base, X, y)
    rs = [B.score_vec(raw, x) for x in X]; cs = [B.score_vec(cal, x) for x in X]
    assert "calib" in cal and cal["calib"]["a"] < 1.0 and max(cs) < max(rs)   # noisy labels: the raw fit is overconfident, Platt shrinks the extremes
    assert B.auc(cs, y) == pytest.approx(B.auc(rs, y), abs=1e-9)  # monotone: ranking identical


def test_top_unrated_is_diverse_and_not_tied():
    ps = pool(60, 7); pieces = {str(i): {"f": f, "entry": {"id": str(i), "score": .5, "status": "accepted"}} for i, f in enumerate(ps)}
    for i in range(10): pieces["d%d" % i] = {"f": dict(ps[0]), "entry": {"id": "d%d" % i, "score": .5, "status": "accepted"}}   # ten identical stripes
    prof = B.new_profile([B.vectorise(f) for f in ps]); prof["weights"] = [0.0] * len(B.FEATURES); prof["weights"][B.FEATURES.index("chroma_p95")] = 3.0
    prof["weights"][B.FEATURES.index("edge_density")] = 3.0
    recs = B.beauty_records(pieces, prof); top = B.top_unrated(pieces, {}, recs, prof, k=10)
    dup = [r for r in top if r["uid"] in ("0",) or r["uid"].startswith("d")]
    assert len(dup) <= 1 and len(top) == 10 and len({r["beauty_logit"] for r in top}) == 10


def test_ablation_flags_edge_density_artefact():
    r = np.random.default_rng(2); ps = pool(240, 9)
    y = [1 if f["edge_density"] > .3 else 0 for f in ps]      # taste is purely edge density here
    X = [B.vectorise(f) for f in ps]; base = B.new_profile(X); fams = [str(i // 2) for i in range(len(X))]
    ab = B.ablation(X, y, fams, base)
    assert ab["drop"]["edge_structure"] < ab["full"] - .2 and ab["alone"]["edge_structure"] > .9


def test_refresh_weights_only_the_upvoted_exploration_take(tmp_path, monkeypatch):
    monkeypatch.setenv("S1NTR_OWNER", "fixture")
    features = pool(8)
    rows = [{"uid": str(i), "id": "same-prompt", "status": "accepted", "score": .8,
             "serendipity": i in (0, 2, 4)} for i in range(len(features))]
    (tmp_path / "index.html").write_text('<script id="data">' + json.dumps(rows) + '</script>')
    cache = tmp_path / "cache.json"
    cache.write_text(json.dumps({str(i): f for i, f in enumerate(features)}))
    ratings = tmp_path / "votes.jsonl"
    votes = ["up", "up", "down", "down", None]
    ratings.write_text("".join(json.dumps({"uid": str(i), "vote": v}) + "\n" for i, v in enumerate(votes)))
    assert B.main(["refresh", "--wall", str(tmp_path), "--runs", str(tmp_path / "runs"),
                   "--ratings", str(ratings), "--cache", str(cache), "--crosswalk", str(tmp_path / "crosswalk"),
                   "--ldir", str(tmp_path)]) == 0
    result = B.load_profile(str(tmp_path / "taste-profile.json"))
    X = [B.vectorise(f) for f in features]
    expected = B.fit_votes(B.new_profile(X), X[:4] + [X[0], X[0]], [1, 1, 0, 0, 1, 1])
    assert result["weights"] == pytest.approx(expected["weights"])
    assert result["n_votes"] == 4 and result["serendipity_upvotes"] == 1
    assert not (tmp_path / "taste-model.json").exists()


def test_unrated_exploration_is_exempt_from_the_dull_list():
    pieces = {u: {"entry": {"id": "same", "serendipity": u == "explore", "status": "accepted", "score": .9}}
              for u in ("explore", "ordinary")}
    records = [{"uid": u, "beauty": .2, "beauty_logit": -1} for u in pieces]
    _, dull = B.promotions(pieces, {}, records)
    assert [r["uid"] for r in dull] == ["ordinary"]
