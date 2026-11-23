import hashlib, json, os, sys
HERE = os.path.dirname(__file__)
sys.path.insert(0, os.path.join(HERE, "..", "..", "scripts", "learning"))
import guidance as G
import compost_motifs as C

def sha(t): return hashlib.sha256(t.encode()).hexdigest()
def row(code, domain="hydra", score=0.9, **kw):
    return dict({"source_sha256": sha(code), "domain": domain, "score": score, "admission_eligible": True, "degraded": False}, **kw)
def seed(i, code_list, text, score=0.8):
    return {"id": i, "content": text, "score": score, "source": {"domains": ["hydra"], "fragments": []},
            "provenance": {"ancestorDigests": [sha(c) for c in code_list], "taint": "accepted", "qualityAuthority": False}}

def store(tmp, rows, seeds, votes=()):
    d = tmp / "learning"; d.mkdir()
    (d / "corpus.jsonl").write_text("".join(json.dumps(r) + "\n" for r in rows))
    (d / "source-votes.jsonl").write_text("".join(json.dumps(v) + "\n" for v in votes))
    sp = tmp / "seeds.json"; sp.write_text(json.dumps(seeds)); return str(d), str(sp), rows

def unbare(d, domain="hydra"):
    for i in range(60):
        b, info = G.compose({"id": "%s-%d" % (domain, i), "domain": domain, "prompt": "BRIEF"}, d, "", env={})
        if not info.get("control"): return b, info
    raise AssertionError("every brief was a control")

def test_motif_in_store_reaches_the_brief_in_words(tmp_path):
    d, sp, admitted = store(tmp_path, [row("A")], [seed("s1", ["A"], "Tidal feedback: a slow wave folds back on itself and leaves a ghost trail.")])
    assert len(C.build(d, admitted, sp)) == 1
    b, info = unbare(d)
    assert "Tidal feedback" in b and "ghost trail" in b and info["motifs"] == ["Tidal feedback"]
    assert b.startswith("BRIEF")

def test_motif_organ_disconnected_means_no_motif(tmp_path):
    d, sp, admitted = store(tmp_path, [row("A")], [seed("s1", ["A"], "Tidal feedback: a slow wave folds back.")])
    assert C.build(d, [], sp) == []        # raw corpus has no authority
    b, info = unbare(d)
    assert "Tidal feedback" not in b and info.get("motifs", []) == []

def test_unsigned_votes_do_not_change_motif_admission(tmp_path):
    rows = [row("good"), row("weak", score=0.2), row("down"), row("up", score=0.2), row("other", domain="p5")]
    seeds = [seed("a", ["good"], "Good idea: calm drift."), seed("b", ["weak"], "Weak idea: noise."), seed("c", ["down"], "Downvoted idea: mud."),
             seed("d", ["up"], "Loved idea: bright pulse."), seed("e", ["other"], "Other idea: p5 only."), seed("f", ["missing"], "Unknown idea: ghost.")]
    d, sp, admitted = store(tmp_path, rows, seeds, votes=[{"source_sha256": sha("down"), "vote": "down"}, {"source_sha256": sha("up"), "vote": "up"}])
    hydra = [m["name"] for m in C.build(d, admitted, sp) if m["domain"] == "hydra"]
    assert sorted(hydra) == ["Downvoted idea", "Good idea"], hydra

def test_code_seeds_are_dropped_and_at_most_two_motifs(tmp_path):
    rows = [row(c) for c in "ABCD"]
    seeds = [seed("a", ["A"], "function f(){ return 1 }"), seed("b", ["B"], "Idea B: one."), seed("c", ["C"], "Idea C: two."), seed("d", ["D"], "Idea D: three.")]
    d, sp, admitted = store(tmp_path, rows, seeds)
    assert len(C.build(d, admitted, sp)) == 3
    b, info = unbare(d)
    assert len(info["motifs"]) == 2 and "function" not in b

def test_control_briefs_stay_bare(tmp_path):
    d, sp, admitted = store(tmp_path, [row("A")], [seed("s1", ["A"], "Tidal feedback: a slow wave.")]); C.build(d, admitted, sp)
    ctl = [G.compose({"id": "hydra-%d" % i, "domain": "hydra", "prompt": "BRIEF"}, d, "", env={}) for i in range(60)]
    assert any(i["control"] and b == "BRIEF" for b, i in ctl) and any(not i["control"] and "Tidal" in b for b, i in ctl)


def test_wall_vote_export_does_not_change_training(tmp_path):
    import ratings_to_source_votes as R
    wall = tmp_path / "wall"; (wall / "src").mkdir(parents=True)
    (wall / "src" / "a.html").write_text("UP"); (wall / "src" / "b.html").write_text("DOWN")
    ents = [{"key": "k", "id": "a", "hsrc": "src/a.html"}, {"key": "k", "id": "b", "hsrc": "src/b.html"}]
    (wall / "index.html").write_text('<script id="data" type="application/json">%s</script>' % json.dumps(ents))
    rt = tmp_path / "r.jsonl"
    rt.write_text("".join(json.dumps(x) + "\n" for x in [{"seat": "k", "id": "a", "vote": "up", "at": "1"}, {"seat": "k", "id": "b", "vote": "up", "at": "1"}, {"seat": "k", "id": "b", "vote": "down", "at": "2"}]))
    rows = [row("UP", score=0.1), row("DOWN", score=0.95)]
    d, sp, admitted = store(tmp_path, rows, [seed("u", ["UP"], "Loved idea: bright pulse."), seed("d", ["DOWN"], "Hated idea: mud.")])
    R.build(d, str(wall), str(rt))
    assert [m["name"] for m in C.build(d, admitted, sp)] == ["Hated idea"]



def test_holdout_piece_does_not_supply_a_motif(tmp_path):
    d, sp, admitted = store(tmp_path, [row("A", holdout=True)], [seed("s1", ["A"], "Tidal feedback: a slow wave.")])
    assert C.build(d, admitted, sp) == []
