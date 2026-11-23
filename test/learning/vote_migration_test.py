"""Lane 4 rows 01/04/05/25: migrate_votes.py builds the crosswalk from real ledgers, the real like server consumes it
(mapped legacy votes resolve to their uid, ambiguous ones are refused and listed at GET /vote-review), and
split-prompts.py keeps whole prompt families in one split."""
import json, os, socket, subprocess, sys, tempfile, time, urllib.error, urllib.request

HERE = os.path.dirname(__file__)
LEARN = os.path.join(HERE, "..", "..", "scripts", "learning")
UID_A, UID_B1, UID_B2 = "glm-0123456789", "kimi-aaaaaaaaaa", "kimi-bbbbbbbbbb"


def wall_data():
    # glm/a-r1: one card, one take -> mapped. kimi/b-r1: two cards share the id -> ambiguous. glm/gone: no card -> orphan.
    return [{"key": "glm", "id": "a-r1", "uid": UID_A, "ntakes": 1},
            {"key": "kimi", "id": "b-r1", "uid": UID_B1, "ntakes": 1},
            {"key": "kimi", "id": "b-r1", "uid": UID_B2, "ntakes": 1}]


def free_port():
    s = socket.socket(); s.bind(("127.0.0.1", 0)); p = s.getsockname()[1]; s.close(); return p


def call(port, path, body=None):
    req = urllib.request.Request(f"http://127.0.0.1:{port}{path}", None if body is None else json.dumps(body).encode(), {"Content-Type": "application/json"})
    try: return 200, json.load(urllib.request.urlopen(req, timeout=5))
    except urllib.error.HTTPError as e: return e.code, json.load(e)


def test_migration_feeds_the_real_like_server():
    with tempfile.TemporaryDirectory() as d:
        full = os.path.join(d, "full.json"); json.dump(wall_data(), open(full, "w"))
        with open(os.path.join(d, "ratings.jsonl"), "w") as f:
            for a in ("glm/a-r1", "kimi/b-r1", "glm/gone"):
                s, i = a.split("/"); f.write(json.dumps({"seat": s, "id": i, "vote": "up", "at": "2026-11-01T00:00:00Z"}) + "\n")
        open(os.path.join(d, "likes.jsonl"), "w").close()
        out = subprocess.run([sys.executable, os.path.join(LEARN, "migrate_votes.py"), full], env=dict(os.environ, VOTES_DIR=d), capture_output=True, text=True, check=True).stdout
        assert "mapped 1 / ambiguous 1 / orphaned 1" in out, out
        xw = json.load(open(os.path.join(d, "vote-crosswalk.json")))["alias"]
        assert xw["glm/a-r1"]["uid"] == UID_A and xw["kimi/b-r1"]["uid"] is None and xw["glm/gone"]["uid"] is None
        port = free_port()
        env = dict(os.environ, LIKES_FILE=os.path.join(d, "likes.jsonl"), RATINGS_FILE=os.path.join(d, "ratings.jsonl"), XWALK_FILE=os.path.join(d, "vote-crosswalk.json"))
        p = subprocess.Popen([sys.executable, os.path.join(LEARN, "like-server.py"), "127.0.0.1", str(port)], env=env)
        try:
            for _ in range(50):
                try: call(port, "/likes"); break
                except Exception: time.sleep(0.1)
            by = {r["id"]: r for r in call(port, "/ratings")[1]}
            assert by["a-r1"]["uid"] == UID_A                    # legacy vote resolved through the crosswalk
            assert by["b-r1"]["uid"] is None                      # ambiguous stays a legacy event, never guessed
            code, body = call(port, "/rate", {"seat": "kimi", "id": "b-r1", "vote": "down"})
            assert code == 409 and "ambiguous" in body["error"]   # a new vote on an ambiguous alias is refused
            code, body = call(port, "/rate", {"seat": "kimi", "id": "b-r1", "uid": UID_B2, "vote": "down"})
            assert code == 200                                    # voting by uid works
            review = {r["alias"]: r for r in call(port, "/vote-review")[1]}
            assert set(review) == {"kimi/b-r1", "glm/gone"}       # the parked votes are readable, not write-only
            assert review["kimi/b-r1"]["events"][0]["ledger"] == "ratings"
        finally: p.kill(); p.wait()


def test_split_prompts_keeps_families_together_and_is_deterministic():
    with tempfile.TemporaryDirectory() as d:
        rows = [(f"p{i}", f"Subject: Family {i % 6}") for i in range(18)]
        tsv = os.path.join(d, "p.tsv"); open(tsv, "w").write("".join(f"{a}\t{b}\n" for a, b in rows))
        outs = []
        for n in (1, 2):
            o = os.path.join(d, f"o{n}.json")
            subprocess.run([sys.executable, os.path.join(LEARN, "split-prompts.py"), tsv, o], check=True, capture_output=True)
            outs.append(json.load(open(o)))
        assert outs[0] == outs[1]                                 # recomputed every cycle, so it must be stable
        fams = {}
        for v in outs[0]["prompts"].values(): fams.setdefault(v["family"], set()).add(v["split"])
        assert all(len(s) == 1 for s in fams.values())            # no family straddles two splits
        assert len({v["split"] for v in outs[0]["prompts"].values()}) >= 2
