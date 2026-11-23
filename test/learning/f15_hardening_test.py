"""F15: stable exemplar order, explicit unavailable pair file, tie vs both-bad is disagreement, uid-keyed picks."""
import json, os, subprocess, sys, tempfile, urllib.error
sys.path.insert(0, os.path.dirname(__file__))
import importlib.util
from like_server_test import _up, _get, _post, _pick_env

ROOT = os.path.join(os.path.dirname(__file__), "..", "..", "scripts", "learning")


def test_missing_and_malformed_pair_file_is_unavailable_not_done():
    for content in (None, "{not json"):
        with tempfile.TemporaryDirectory() as tmp:
            env = _pick_env(tmp)
            if content is None: os.remove(env["PAIRS_FILE"])
            else: open(env["PAIRS_FILE"], "w").write(content)
            p, port = _up(env)
            try:
                try:
                    _get(port, "/pair"); raise AssertionError("served a pair or done")
                except urllib.error.HTTPError as e:
                    assert e.code == 503 and json.load(e)["unavailable"] is True
                try:
                    _post(port, "/pick", {"pairId": "pp1", "n": 0, "choice": "left"}); raise AssertionError("accepted")
                except urllib.error.HTTPError as e:
                    assert e.code == 503
            finally:
                p.terminate(); p.wait()


def test_two_takes_sharing_a_key_are_told_apart_by_uid():
    with tempfile.TemporaryDirectory() as tmp:
        env = _pick_env(tmp)
        pairs = json.load(open(env["PAIRS_FILE"]))
        for pr in pairs["pairs"]:
            pr["a"]["id"] = pr["b"]["id"] = "seatA/same"
            pr["a"]["uid"], pr["b"]["uid"] = "u-aaaaaaaaaa", "u-bbbbbbbbbb"
        json.dump(pairs, open(env["PAIRS_FILE"], "w"))
        p, port = _up(env)
        try:
            _get(port, "/pair"); _post(port, "/pick", {"pairId": "pp1", "n": 0, "choice": "left"})
        finally:
            p.terminate(); p.wait()
        rec = [json.loads(l) for l in open(env["PICKS_FILE"])][0]
        assert {rec["left"], rec["right"]} == {"u-aaaaaaaaaa", "u-bbbbbbbbbb"} and rec["winner"] in rec.values()
        assert set(rec["judgeScores"]) == {"u-aaaaaaaaaa", "u-bbbbbbbbbb"}


def test_tie_then_both_bad_is_not_consistent():
    spec = importlib.util.spec_from_file_location("ja", os.path.join(ROOT, "judge-agreement.py"))
    ja = importlib.util.module_from_spec(spec); spec.loader.exec_module(ja)
    mk = lambda n, c: {"pairId": "p", "n": n, "choice": c, "winner": None, "judgeScores": {"a": .5, "b": .5}}
    out = ja.analyse({("p", 0): mk(0, "tie"), ("p", 1): mk(1, "bad")})
    assert out["swap"]["consistent"] == 0


def _piece(scan, seat, piece, score, code):
    d = os.path.join(scan, seat, piece)
    op = f"op-{seat}-{piece}"
    import hashlib
    art = os.path.join(d, "artifacts", hashlib.sha256(op.encode()).hexdigest())
    os.makedirs(art)
    open(os.path.join(art, "source.txt"), "w").write(code)
    json.dump({"k": {"kind": "create", "result": {"domain": "html", "operationId": op, "evidence": {"status": "rendered"},
               "evaluation": {"score": score}}}}, open(os.path.join(d, "product-projections.json"), "w"))


def test_equal_scores_pick_the_same_exemplars_in_any_scan_order():
    with tempfile.TemporaryDirectory() as tmp:
        a, b = os.path.join(tmp, "scanA"), os.path.join(tmp, "scanB")
        # three distinct pieces, all score 0.8; distinct vocabulary so diversity never drops one
        _piece(a, "seatC", "p1", 0.8, "alpha beta gamma delta epsilon zeta eta theta")
        _piece(b, "seatA", "p9", 0.8, "iota kappa lambda omicron sigma tau upsilon phi")
        _piece(b, "seatA", "p2", 0.8, "chi psi omega ratio fiber string number object")
        seen = []
        for order in ((a, b), (b, a)):
            out = os.path.join(tmp, "o.json")
            args = [sys.executable, os.path.join(ROOT, "build-exemplars.py"), "--domain", "html", "--out", out, "--k", "3"]
            for d in order: args += ["--scan", d]
            r = subprocess.run(args, capture_output=True, text=True)
            assert r.returncode == 0, r.stderr
            seen.append([(e["seat"], e["piece"]) for e in json.load(open(out))["exemplars"]])
        assert seen[0] == seen[1] == [("seatA", "p2"), ("seatA", "p9"), ("seatC", "p1")]


def test_like_naming_an_artifact_binds_only_that_artifact():
    import hashlib
    with tempfile.TemporaryDirectory() as tmp:
        scan = os.path.join(tmp, "scan")
        _piece(scan, "s", "dup", 0.4, "alpha beta gamma delta epsilon zeta eta theta")
        pj = os.path.join(scan, "s", "dup", "product-projections.json")
        store = json.load(open(pj)); store["k"]["result"]["receipt"] = {"artifactDigest": "dig-real"}
        json.dump(store, open(pj, "w"))
        likes = os.path.join(tmp, "likes.jsonl"); out = os.path.join(tmp, "o.json")
        run = lambda: subprocess.run([sys.executable, os.path.join(ROOT, "build-exemplars.py"), "--domain", "html", "--out", out,
                                      "--scan", scan, "--likes", likes, "--min-score", "0.3"], capture_output=True, text=True)
        open(likes, "w").write(json.dumps({"seat": "s", "id": "dup", "artifactDigest": "dig-other"}) + "\n")
        assert run().returncode == 0 and json.load(open(out))["exemplars"][0]["liked"] is False
        open(likes, "w").write(json.dumps({"seat": "s", "id": "dup", "artifactDigest": "dig-real"}) + "\n")
        assert run().returncode == 0 and json.load(open(out))["exemplars"][0]["liked"] is True
