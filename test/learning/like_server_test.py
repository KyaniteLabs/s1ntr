"""Likes persist across a server restart (the reload guarantee)."""
import json
import os
import socket
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request

SERVER = os.path.join(os.path.dirname(__file__), "..", "..", "scripts", "learning", "like-server.py")


def free_port():
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    p = s.getsockname()[1]
    s.close()
    return p


def start(file, port):
    env = dict(os.environ, LIKES_FILE=file)
    p = subprocess.Popen([sys.executable, SERVER, "127.0.0.1", str(port)], env=env)
    for _ in range(50):
        try:
            urllib.request.urlopen(f"http://127.0.0.1:{port}/likes", timeout=1)
            return p
        except Exception:
            time.sleep(0.1)
    p.kill()
    raise RuntimeError("server did not start")


def post(port, body):
    req = urllib.request.Request(f"http://127.0.0.1:{port}/like", json.dumps(body).encode(),
                                 {"Content-Type": "application/json"})
    return json.load(urllib.request.urlopen(req, timeout=5))


def likes(port):
    return json.load(urllib.request.urlopen(f"http://127.0.0.1:{port}/likes", timeout=5))


def test_like_survives_restart_and_unlike_removes():
    with tempfile.TemporaryDirectory() as d:
        f = os.path.join(d, "likes.jsonl")
        port = free_port()
        p = start(f, port)
        try:
            assert post(port, {"seat": "ds1017", "id": "abyss-r1"})["ok"]
            assert post(port, {"seat": "glm", "id": "x-r1"})["ok"]
        finally:
            p.terminate()
            p.wait()
        port = free_port()
        p = start(f, port)
        try:
            assert sorted(item["id"] for item in likes(port)) == ["abyss-r1", "x-r1"]
            post(port, {"seat": "glm", "id": "x-r1", "liked": False})
            assert [item["id"] for item in likes(port)] == ["abyss-r1"]
            try:
                post(port, {"seat": "../etc", "id": "x"})
                raise AssertionError("accepted a path-like seat")
            except urllib.error.HTTPError as e:
                assert e.code == 400
        finally:
            p.terminate()
            p.wait()


def _pick_env(tmp):
    wall = os.path.join(tmp, "wall")
    os.makedirs(wall)
    for name, body in (("a.html", "<p>A-code</p>"), ("b.html", "<p>B-code</p>")):
        open(os.path.join(wall, name), "w").write(body)
    near = {"pairId": "pp1", "prompt": "P", "judge": "j",
            "a": {"id": "seatA/a1", "hsrc": "a.html", "score": 0.70}, "b": {"id": "seatB/b1", "hsrc": "b.html", "score": 0.65}}
    far = {"pairId": "pp2", "prompt": "Q", "judge": "j",
           "a": {"id": "seatA/a2", "hsrc": "a.html", "score": 0.9}, "b": {"id": "seatB/b2", "hsrc": "b.html", "score": 0.3}}
    pairs = os.path.join(tmp, "pairs.json")
    json.dump({"pairs": [far, near]}, open(pairs, "w"))
    return dict(os.environ, LIKES_FILE=os.path.join(tmp, "likes.jsonl"), PICKS_FILE=os.path.join(tmp, "picks.jsonl"),
                PAIRS_FILE=pairs, WALL_DIR=wall)


def _get(port, path):
    return json.load(urllib.request.urlopen(f"http://127.0.0.1:{port}{path}", timeout=5))


def _post(port, path, body):
    req = urllib.request.Request(f"http://127.0.0.1:{port}{path}", json.dumps(body).encode(), {"Content-Type": "application/json"})
    return json.load(urllib.request.urlopen(req, timeout=5))


def _up(env):
    port = free_port()
    p = subprocess.Popen([sys.executable, SERVER, "127.0.0.1", str(port)], env=env)
    for _ in range(50):
        try:
            _get(port, "/likes")
            return p, port
        except Exception:
            time.sleep(0.1)
    p.kill()
    raise RuntimeError("server did not start")


def test_pick_is_blind_borderline_first_swapped_on_repeat_and_durable():
    with tempfile.TemporaryDirectory() as tmp:
        env = _pick_env(tmp)
        p, port = _up(env)
        try:
            first = _get(port, "/pair")
            assert first["pairId"] == "pp1" and first["n"] == 0
            blob = json.dumps(first)
            assert "seatA" not in blob and "seatB" not in blob and "0.7" not in blob and "score" not in blob
            left_is_a = "A-code" in first["left"]["html"]
            assert _post(port, "/pick", {"pairId": "pp1", "n": 0, "choice": "left"})["ok"]
            second = _get(port, "/pair")
            assert second["pairId"] == "pp1" and second["n"] == 1
            assert ("A-code" in second["left"]["html"]) != left_is_a
            _post(port, "/pick", {"pairId": "pp1", "n": 1, "choice": "tie"})
            assert _get(port, "/pair")["pairId"] == "pp2"
        finally:
            p.terminate()
            p.wait()
        rows = [json.loads(line) for line in open(env["PICKS_FILE"])]
        assert rows[0]["winner"] == ("seatA/a1" if left_is_a else "seatB/b1")
        assert rows[0]["judgeScores"]["seatA/a1"] == 0.70 and rows[1]["winner"] is None
        p, port = _up(env)
        try:
            assert _get(port, "/pair")["pairId"] == "pp2"
            try:
                _post(port, "/pick", {"pairId": "pp1", "n": 0, "choice": "best"})
                raise AssertionError("accepted bad choice")
            except urllib.error.HTTPError as e:
                assert e.code == 400
        finally:
            p.terminate()
            p.wait()


def test_pair_with_missing_piece_code_is_skipped_not_a_500():
    with tempfile.TemporaryDirectory() as tmp:
        env = _pick_env(tmp)
        pairs = json.load(open(env["PAIRS_FILE"]))
        pairs["pairs"].insert(0, {"pairId": "gone", "prompt": "G", "judge": "j",
                                  "a": {"id": "s/a", "hsrc": "missing.html", "score": 0.5},
                                  "b": {"id": "s/b", "hsrc": "b.html", "score": 0.5}})
        json.dump(pairs, open(env["PAIRS_FILE"], "w"))
        p, port = _up(env)
        try:
            d = _get(port, "/pair")
            assert d["pairId"] == "pp1" and "error" not in d       # the dead pair is skipped, the next valid pair is served
            assert d["remaining"] == 2                             # and not counted
        finally:
            p.terminate()
            p.wait()


def test_pick_page_guards_against_a_service_error_response():
    page = open(os.path.join(os.path.dirname(__file__), "..", "..", "scripts", "learning", "pick.html")).read()
    assert "d.error||!d.left||!d.right" in page and "Reload to retry" in page


def test_pick_page_sets_srcdoc_only_after_the_iframe_has_layout():
    page = open(os.path.join(os.path.dirname(__file__), "..", "..", "scripts", "learning", "pick.html")).read()
    line = next(l for l in page.splitlines() if l.startswith("function show"))
    # appendChild first, then srcdoc after two animation frames (width 0 at setup froze pieces: getImageData IndexSizeError)
    assert line.index("appendChild(x)") < line.index("requestAnimationFrame(()=>requestAnimationFrame(()=>{x.srcdoc=html}))")
    assert "x.srcdoc=html;el.appendChild" not in line


def test_both_bad_pick_keeps_note_and_has_no_winner_and_repick_replaces():
    with tempfile.TemporaryDirectory() as tmp:
        env = _pick_env(tmp)
        p, port = _up(env)
        try:
            _get(port, "/pair")
            assert _post(port, "/pick", {"pairId": "pp1", "n": 0, "choice": "bad", "note": "left never moved; right too dark"})["ok"]
            # Back button: a re-pick of the same (pairId, n) supersedes the earlier one.
            assert _post(port, "/pick", {"pairId": "pp1", "n": 0, "choice": "left", "note": "x" * 900})["ok"]
        finally:
            p.terminate()
            p.wait()
        rows = [json.loads(line) for line in open(env["PICKS_FILE"])]
        assert rows[0]["choice"] == "bad" and rows[0]["winner"] is None
        assert rows[0]["note"] == "left never moved; right too dark"
        assert rows[1]["winner"] is not None and len(rows[1]["note"]) == 500


def rate(port, body):
    req = urllib.request.Request(f"http://127.0.0.1:{port}/rate", json.dumps(body).encode(),
                                 {"Content-Type": "application/json"})
    return json.load(urllib.request.urlopen(req, timeout=5))


def ratings(port):
    return {f"{r['seat']}/{r['id']}": r for r in json.load(urllib.request.urlopen(f"http://127.0.0.1:{port}/ratings", timeout=5))}


def test_rate_up_is_a_like_down_removes_it_and_notes_persist():
    with tempfile.TemporaryDirectory() as d:
        f = os.path.join(d, "likes.jsonl")
        port = free_port()
        p = start(f, port)
        try:
            assert rate(port, {"seat": "glm", "id": "a-r1", "vote": "up"})["vote"] == "up"
            assert [x["id"] for x in likes(port)] == ["a-r1"]  # thumbs-up counts as a like for learning
            rate(port, {"seat": "glm", "id": "a-r1", "note": "great motion"})  # note only: vote and like unchanged
            r = ratings(port)["glm/a-r1"]
            assert r["vote"] == "up" and r["note"] == "great motion"
            assert [x["id"] for x in likes(port)] == ["a-r1"]
            rate(port, {"seat": "glm", "id": "a-r1", "vote": "down"})
            assert likes(port) == [] and ratings(port)["glm/a-r1"]["note"] == "great motion"
            rate(port, {"seat": "glm", "id": "a-r1", "vote": "down", "note": "worse on second look"})
            rate(port, {"seat": "glm", "id": "a-r1", "vote": None, "note": ""})
            assert ratings(port)["glm/a-r1"]["vote"] is None and ratings(port)["glm/a-r1"]["note"] == ""
            assert likes(port) == []
            with open(os.path.join(d, "ratings.jsonl")) as fh:
                assert [json.loads(x)["note"] for x in fh if json.loads(x)["note"]] == ["great motion", "great motion", "worse on second look"]
        finally:
            p.terminate()
            p.wait()
        port = free_port()
        p = start(f, port)
        try:
            assert ratings(port)["glm/a-r1"]["vote"] is None  # survives restart
        finally:
            p.terminate()
            p.wait()


def test_rate_down_and_null_remove_a_legacy_like_and_bad_input_is_400():
    with tempfile.TemporaryDirectory() as d:
        port = free_port()
        p = start(os.path.join(d, "likes.jsonl"), port)
        try:
            post(port, {"seat": "ds1017", "id": "old-r1"})  # a like from before ratings existed
            rate(port, {"seat": "ds1017", "id": "old-r1", "vote": None})
            assert likes(port) == []
            for bad in ({"seat": "../x", "id": "a", "vote": "up"}, {"seat": "glm", "id": "a", "vote": "maybe"},
                        {"seat": "glm", "id": "a", "note": 5}):
                try:
                    rate(port, bad)
                    raise AssertionError("accepted " + json.dumps(bad))
                except urllib.error.HTTPError as e:
                    assert e.code == 400
            long = rate(port, {"seat": "glm", "id": "b", "vote": "up", "note": "x" * 5000})
            assert len(long["note"]) == 1000
        finally:
            p.terminate()
            p.wait()


def test_first_thumbs_down_and_vote_changes_arm_the_learning_trigger():
    """F05: a first thumbs-down on an unliked piece changed no like, so the debounced learn trigger never fired."""
    with tempfile.TemporaryDirectory() as d:
        f, marker, port = os.path.join(d, "likes.jsonl"), os.path.join(d, "fired"), free_port()
        env = dict(os.environ, LIKES_FILE=f, LIKE_DEBOUNCE="0.3", LIKE_TRIGGER="echo x >> %s" % marker)
        p = subprocess.Popen([sys.executable, SERVER, "127.0.0.1", str(port)], env=env)
        try:
            for _ in range(50):
                try: urllib.request.urlopen(f"http://127.0.0.1:{port}/likes", timeout=1); break
                except Exception: time.sleep(0.1)

            def rate(body):
                req = urllib.request.Request(f"http://127.0.0.1:{port}/rate", json.dumps(body).encode(), {"Content-Type": "application/json"})
                return json.load(urllib.request.urlopen(req, timeout=5))

            def fired(n):
                time.sleep(0.9); return os.path.exists(marker) and len(open(marker).read().split()) == n
            uid = "ds0731-81a2ddfb62"
            rate({"seat": "ds0731", "id": "hydra-organic-high-r1", "uid": uid, "vote": "down"}); assert fired(1)       # first down: false/false
            rate({"seat": "ds0731", "id": "hydra-organic-high-r1", "uid": uid, "vote": "down"}); assert fired(1)       # repeat of the same vote: nothing new to learn
            rate({"seat": "ds0731", "id": "hydra-organic-high-r1", "uid": uid, "vote": None}); assert fired(2)         # clearing a down changes the labels too
            rate({"seat": "ds0731", "id": "hydra-organic-high-r1", "uid": uid, "note": "n"}); assert fired(2)          # a note alone does not
        finally:
            p.terminate(); p.wait()
