"""F06: votes carry the uid of the exact take; the converter must not key on (seat, id), which several takes share."""
import json, os, subprocess, sys

SCRIPT = os.path.join(os.path.dirname(__file__), "..", "..", "scripts", "learning", "ratings_to_negatives.py")


def _wall(tmp, cards):
    wall = tmp / "wall"; (wall / "posters").mkdir(parents=True)
    (wall / "index.html").write_text('<script id="data" type="application/json">%s</script>' % json.dumps(cards))
    for c in cards: (wall / "posters" / (c["hsrc"].rsplit(".", 1)[0].split("/")[-1] + ".webp")).write_bytes(b"x")
    return wall


def test_votes_on_two_takes_sharing_seat_and_id_stay_separate(tmp_path):
    cards = [{"key": "ds0731", "id": "hydra-organic-high-r1", "take": "t1", "rid": "hydra-organic-high-r1", "uid": "ds0731-aaaaaaaaaa", "hsrc": "src/a1.html"},
             {"key": "ds0731", "id": "hydra-organic-high-r1", "take": "t2", "rid": "hydra-organic-high-r1", "uid": "ds0731-bbbbbbbbbb", "hsrc": "src/b2.html"}]
    wall = _wall(tmp_path, cards)
    ratings = tmp_path / "ratings.jsonl"
    ratings.write_text("".join(json.dumps(r) + "\n" for r in (
        {"seat": "ds0731", "id": "hydra-organic-high-r1", "uid": "ds0731-aaaaaaaaaa", "vote": "down", "at": "1"},
        {"seat": "ds0731", "id": "hydra-organic-high-r1", "uid": "ds0731-bbbbbbbbbb", "vote": "up", "at": "2"})))
    out = tmp_path / "learning" / "owner-downvotes.jsonl"
    subprocess.run([sys.executable, SCRIPT, "--wall", str(wall), "--ratings", str(ratings), "--out", str(out)], check=True, capture_output=True)
    rows = [json.loads(l) for l in open(out)]
    assert [(r["uid"], r["hsrc"]) for r in rows] == [("ds0731-aaaaaaaaaa", "src/a1.html")]      # the up vote on take 2 must not erase the down on take 1
