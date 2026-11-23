"""Taste test: adaptive picks -> per-user profile -> the next brief changes.  Real taste.py / beauty.py / guidance.py / like-server.py."""
import json, os, socket, subprocess, sys, time, urllib.request
import pytest
np = pytest.importorskip("numpy")
LD = os.path.join(os.path.dirname(__file__), "..", "..", "scripts", "learning")
sys.path.insert(0, LD)
import beauty as B, taste as T, guidance as G

F = {"chroma_mean": .4, "chroma_p95": .8, "value_range": .7, "value_mean": .5, "value_std": .2, "edge_density": .3, "structure": .4,
     "palette_entropy": 2.0, "balance_x": .1, "balance_y": -.1, "right_bias": .55, "motion": .2, "blank": False, "hue_olive_teal": .1}


def corpus(n=90, seed=0):
    r = np.random.default_rng(seed); out = {}
    for i in range(n):
        f = dict(F); f["chroma_p95"] = float(r.uniform(0, 1)); f["chroma_mean"] = f["chroma_p95"] * .6; f["value_range"] = float(r.uniform(.1, 1))
        f["edge_density"] = float(r.uniform(0, .6)); f["motion"] = float(r.uniform(0, .5)); f["structure"] = float(r.uniform(0, 1)); f["palette_entropy"] = float(r.uniform(0.5, 3))
        out["u-%04d" % i] = f
    return out


def wall(tmp, feats):
    d = tmp / "wall"; (d / "posters").mkdir(parents=True)
    ents = [{"uid": u, "key": "ds", "id": "p%d" % i, "take": 1, "hsrc": "h/%s.html" % u, "status": "accepted", "score": .5} for i, u in enumerate(feats)]
    (d / "index.html").write_text('<!doctype html><script id="data" type="application/json">%s</script>' % json.dumps(ents))
    for u in feats: (d / "posters" / (u + ".webp")).write_bytes(b"x")
    (tmp / "cache.json").write_text(json.dumps(feats)); return d, tmp / "cache.json"


def take_test(pool, ldir, user, likes, cap=12):
    """A simulated person: prefers whichever piece scores higher on `likes(features)`."""
    for _ in range(40):
        c, st = T.handle(str(ldir), pool, "GET", "pair", {"user": user})
        assert c == 200
        if st["stop"]: return st
        l, r = st["left"]["uid"], st["right"]["uid"]
        choice = "left" if likes(pool.feats[l]) >= likes(pool.feats[r]) else "right"
        c, st = T.handle(str(ldir), pool, "POST", "answer", {"user": user, "left": l, "right": r, "choice": choice}); assert c == 200
        if st["stop"]: return st
    raise AssertionError("test never stopped")


def test_taste_test_stops_within_cap_and_learns_the_direction(tmp_path):
    feats = corpus(); wd, cache = wall(tmp_path, feats); pool = T.pool_from_wall(str(wd), str(cache)); ld = tmp_path / "learning"
    st = take_test(pool, ld, "vivid", lambda f: f["chroma_p95"])
    rows = T.read_rows(str(ld / "profiles/vivid/answers.jsonl")); assert 6 <= len([r for r in rows if "win" in r]) <= T.HARD_CAP
    c, res = T.handle(str(ld), pool, "GET", "result", {"user": "vivid"}); assert c == 200 and len(res["liked"]) == T.LIKED_N
    assert any("saturated" in w for w in res["words"]["likes"]) and res["active"]
    prof = B.load_profile(str(ld / "profiles/vivid/profile.json")); assert prof["source"] == "taste-test" and prof["n_pairs"] >= 6
    # the predicted-liked pieces really are the vivid ones
    assert np.mean([feats[x["uid"]]["chroma_p95"] for x in res["liked"]]) > np.mean([f["chroma_p95"] for f in feats.values()]) + .15


def test_two_users_get_opposite_profiles_and_different_briefs(tmp_path):
    feats = corpus(); wd, cache = wall(tmp_path, feats); pool = T.pool_from_wall(str(wd), str(cache)); ld = tmp_path / "learning"
    take_test(pool, ld, "vivid", lambda f: f["chroma_p95"]); take_test(pool, ld, "calm", lambda f: -f["chroma_p95"])
    for u in ("vivid", "calm"): assert T.handle(str(ld), pool, "GET", "result", {"user": u})[0] == 200
    entry = next({"id": "p%d" % i, "domain": "hydra", "prompt": "a slow bloom"} for i in range(50) if G._bucket("ctl:p%d" % i, G.CONTROL_ONE_IN) != 0)
    bare = G.compose(entry, str(ld), env={"S1NTR_USER": "nobody"})[0]            # no profile: the bare brief
    a, ia = G.compose(entry, str(ld), env={"S1NTR_USER": "vivid"}); b, ib = G.compose(entry, str(ld), env={"S1NTR_USER": "calm"})
    assert bare == entry["prompt"] and a != bare and b != bare and a != b          # the next brief changes, per user
    assert ia["taste"] and ib["taste"] and "taste test" in a and "vivid" in a and "muted" in b


def test_votes_profile_is_never_replaced_by_a_test_and_migration_keeps_the_source(tmp_path):
    feats = corpus(); wd, cache = wall(tmp_path, feats); pool = T.pool_from_wall(str(wd), str(cache)); ld = tmp_path / "learning"; ld.mkdir()
    X = [B.vectorise(f) for f in feats.values()]; base = B.new_profile(X)
    votes = B.fit_votes(base, X, [1 if f["chroma_p95"] > .5 else 0 for f in feats.values()]); B.save_profile(votes, str(ld / "taste-profile.json"))
    before = (ld / "taste-profile.json").read_bytes()
    assert T.migrate(str(ld), "owner") == "migrated" and T.migrate(str(ld), "owner") == "exists"
    mine = B.load_profile(str(ld / "profiles/owner/profile.json")); assert mine["source"] == "votes" and mine["weights"] == votes["weights"]
    assert (ld / "taste-profile.json").read_bytes() == before                      # nothing rewritten in place
    take_test(pool, ld, "owner", lambda f: -f["chroma_p95"]); c, res = T.handle(str(ld), pool, "GET", "result", {"user": "owner"})
    assert c == 200 and res["active"] is False and B.load_profile(str(ld / "profiles/owner/profile.json"))["source"] == "votes"
    assert os.path.exists(ld / "profiles/owner/taste-test.json")


def test_skip_is_not_fitted_and_not_asked_twice_and_bad_input_is_refused(tmp_path):
    feats = corpus(); wd, cache = wall(tmp_path, feats); pool = T.pool_from_wall(str(wd), str(cache)); ld = str(tmp_path / "learning")
    c, st = T.handle(ld, pool, "GET", "pair", {"user": "u1"}); l, r = st["left"]["uid"], st["right"]["uid"]
    c, st2 = T.handle(ld, pool, "POST", "answer", {"user": "u1", "left": l, "right": r, "choice": "skip"}); assert c == 200 and st2["answered"] == 0
    assert {st2["left"]["uid"], st2["right"]["uid"]} != {l, r}
    assert T.handle(ld, pool, "POST", "answer", {"user": "u1", "left": l, "right": r, "choice": "left"})[0] == 409
    assert T.handle(ld, pool, "POST", "answer", {"user": "u1", "left": l, "right": "nope", "choice": "left"})[0] == 400
    assert T.handle(ld, pool, "GET", "pair", {"user": "../etc"})[0] == 400
    assert T.handle(ld, pool, "GET", "result", {"user": "u1"})[0] == 409           # no picks yet
    assert "u1" not in json.dumps(st)                                               # a pair never carries the user, seat or score


def test_replay_runs_on_a_fixture_and_reports_every_n(tmp_path):
    feats = corpus(70)
    pieces = {u: {"f": f, "entry": {"id": u, "rid": "r%d" % (i // 3), "uid": u}} for i, (u, f) in enumerate(feats.items())}
    votes = {u: ("up" if f["chroma_p95"] > .55 else "down") for u, f in feats.items()}
    r = T.replay(pieces, votes, Ns=(4, 12), splits=4, randoms=2)
    assert r[4]["active_auc"] and r[12]["active_auc"] > .8 and r[12]["runs"] >= 3 and len(r[12]["diff_ci95"]) == 2   # paired, one figure per split
    assert 1 <= r["stop_rule"]["stop_runs"] <= 4 and r["stop_rule"]["stop_at_median"] == 12   # the stop floor is 12 picks
    raw = T.replay(pieces, votes, Ns=(4,), splits=2, randoms=1, salt0=5, raw=True); assert len(raw[4]["active"]) == len(raw[4]["random"]) == len(raw[4]["full"])


def test_http_endpoints_work_end_to_end_and_never_touch_ratings(tmp_path):
    feats = corpus(); wd, cache = wall(tmp_path, feats); ld = tmp_path / "learning"; ld.mkdir()
    s = socket.socket(); s.bind(("127.0.0.1", 0)); port = s.getsockname()[1]; s.close()
    env = dict(os.environ, LIKES_FILE=str(tmp_path / "likes.jsonl"), WALL_DIR=str(wd), TASTE_LDIR=str(ld), TASTE_CACHE=str(cache), LIKE_TRIGGER="touch %s" % (tmp_path / "TRIGGERED"), LIKE_DEBOUNCE="0")
    p = subprocess.Popen([sys.executable, os.path.join(LD, "like-server.py"), "127.0.0.1", str(port)], env=env)
    try:
        def call(method, path, body=None):
            req = urllib.request.Request("http://127.0.0.1:%d%s" % (port, path), json.dumps(body).encode() if body is not None else None, {"Content-Type": "application/json"}, method=method)
            return json.load(urllib.request.urlopen(req, timeout=10))
        for _ in range(50):
            try: call("GET", "/likes"); break
            except Exception: time.sleep(.1)
        for _ in range(T.HARD_CAP + 2):
            st = call("GET", "/taste/pair?user=web1")
            if st["stop"]: break
            l, r = st["left"]["uid"], st["right"]["uid"]
            st = call("POST", "/taste/answer", {"user": "web1", "left": l, "right": r, "choice": "left" if feats[l]["chroma_p95"] >= feats[r]["chroma_p95"] else "right"})
            if st["stop"]: break
        res = call("GET", "/taste/result?user=web1"); assert res["picks"] >= 6 and res["words"]["likes"] and res["liked"][0]["poster"].startswith("posters/")
        assert os.path.exists(ld / "profiles/web1/profile.json")
        assert not (tmp_path / "ratings.jsonl").exists() and not (tmp_path / "likes.jsonl").exists()
        time.sleep(.5); assert not (tmp_path / "TRIGGERED").exists()               # the owner's refit trigger stays unarmed
    finally:
        p.terminate(); p.wait()


def test_page_is_a_standalone_phone_page():
    s = open(os.path.join(LD, "taste-test.html")).read()
    assert s.lstrip().lower().startswith("<!doctype html>") and "charset" in s[:200].lower() and 'name="viewport"' in s[:400]
    assert "srcdoc" not in s and "<iframe" not in s and "https://" not in s    # stills only; nothing loaded from elsewhere
    assert "/taste/pair" in s and "/taste/answer" in s and "/taste/result" in s


def test_dead_frames_are_never_candidates_seeds_or_liked_picks(tmp_path):
    """Blank, near-black, blown-out and flat renders waste a pick: they are excluded from the pool, every shown pair and the result."""
    feats = corpus(60)
    bad = {"d-black": dict(F, value_mean=.01, value_range=.5, value_std=.1), "d-blank": dict(F, blank=True), "d-flat": dict(F, value_range=.08, value_mean=.4),
           "d-white": dict(F, value_mean=.99, value_range=.5), "d-edgey-black": dict(F, value_mean=.02, edge_density=.9, chroma_p95=1.0)}
    feats.update(bad); wd, cache = wall(tmp_path, feats); pool = T.pool_from_wall(str(wd), str(cache))
    assert not set(bad) & set(pool.feats) and not set(bad) & set(pool.cands) and len(pool.feats) == 60
    assert all(T.dead(f) for f in bad.values()) and not any(T.dead(f) for f in corpus(60).values())
    shown = set(); ld = tmp_path / "learning"
    for _ in range(40):
        c, st = T.handle(str(ld), pool, "GET", "pair", {"user": "v"}); assert c == 200
        if st["stop"]: break
        l, r = st["left"]["uid"], st["right"]["uid"]; shown |= {l, r}
        T.handle(str(ld), pool, "POST", "answer", {"user": "v", "left": l, "right": r, "choice": "left" if pool.feats[l]["chroma_p95"] >= pool.feats[r]["chroma_p95"] else "right"})
    assert shown and not shown & set(bad)
    c, res = T.handle(str(ld), pool, "GET", "result", {"user": "v"}); assert not {x["uid"] for x in res["liked"]} & set(bad)
