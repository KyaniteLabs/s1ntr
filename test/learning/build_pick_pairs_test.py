"""build-pick-pairs.py drops pieces whose code is no longer on the wall and pairs only same-prompt pieces."""
import json
import os
import subprocess
import sys
import tempfile

SCRIPT = os.path.join(os.path.dirname(__file__), "..", "..", "scripts", "learning", "build-pick-pairs.py")


def test_missing_piece_code_is_dropped_and_pairs_share_a_prompt():
    with tempfile.TemporaryDirectory() as t:
        os.makedirs(t + "/src")
        for name in ("a", "b", "c"):
            open(f"{t}/src/{name}.html", "w").write(name)
        rows = [{"key": "k", "id": n, "prompt": p, "score": "0.7", "status": "accepted", "hsrc": f"src/{n}.html"}
                for n, p in (("a", "P"), ("b", "P"), ("c", "Q"))]
        rows.append({"key": "k", "id": "gone", "prompt": "P", "score": "0.7", "status": "accepted", "hsrc": "src/gone.html"})
        open(t + "/index.html", "w").write('<script id="data" type="application/json">' + json.dumps(rows) + "</script>")
        subprocess.run([sys.executable, SCRIPT, t + "/index.html", t + "/o.json"], check=True, capture_output=True)
        pairs = json.load(open(t + "/o.json"))["pairs"]
        assert len(pairs) == 1 and {pairs[0]["a"]["id"], pairs[0]["b"]["id"]} == {"k/a", "k/b"}


def test_same_seat_takes_get_distinct_side_ids():
    """L5-06: two takes of one seat/prompt used to share `seat/id`, so the pick keyed both sides, one score and the winner identically."""
    with tempfile.TemporaryDirectory() as t:
        os.makedirs(t + "/src")
        rows = []
        for n, take, score in (("a", "p-r1", "0.61"), ("b", "p-r2", "0.72")):
            open(f"{t}/src/{n}.html", "w").write(n)
            rows.append({"key": "k", "id": "p", "take": take, "uid": "k-" + n, "prompt": "P", "score": score, "status": "accepted", "hsrc": f"src/{n}.html"})
        open(t + "/index.html", "w").write('<script id="data" type="application/json">' + json.dumps(rows) + "</script>")
        subprocess.run([sys.executable, SCRIPT, t + "/index.html", t + "/o.json"], check=True, capture_output=True)
        pairs = json.load(open(t + "/o.json"))["pairs"]
        assert len(pairs) == 1
        a, b = pairs[0]["a"], pairs[0]["b"]
        assert a["id"] != b["id"] and {a["uid"], b["uid"]} == {"k-a", "k-b"}
        assert a["id"].startswith("k/p#") and b["id"].startswith("k/p#")
