"""judge-agreement.py: accuracy vs human picks, borderline subset, position-swap consistency, latest pick wins."""
import importlib.util
import json
import os

spec = importlib.util.spec_from_file_location(
    "ja", os.path.join(os.path.dirname(__file__), "..", "..", "scripts", "learning", "judge-agreement.py"))
ja = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ja)


def rec(pair, n, choice, winner, scores=(0.8, 0.6)):
    return {"pairId": pair, "n": n, "choice": choice, "winner": winner, "judgeScores": {"a": scores[0], "b": scores[1]}}


def test_accuracy_ties_and_swap_consistency():
    latest = {}
    for r in [
        rec("p1", 0, "left", "a"), rec("p1", 1, "right", "a"),
        rec("p2", 0, "left", "b"), rec("p2", 1, "left", "a"),
        rec("p3", 0, "tie", None), rec("p3", 1, "tie", None),
        rec("p4", 0, "left", "a", scores=(0.5, 0.5)),
    ]:
        latest[(r["pairId"], r["n"])] = r
    out = ja.analyse(latest)
    assert out["decisive"] == 5 and out["scorable"] == 4 and out["judge_ties"] == 1
    assert out["accuracy"] == 0.75
    assert out["swap"] == {"pairs": 3, "consistent": 2, "consistency": 0.667}
    assert out["human_ties"] == 0.286


def test_latest_pick_wins_and_empty_is_safe(tmp_path):
    f = tmp_path / "picks.jsonl"
    f.write_text("\n".join(json.dumps(r) for r in [rec("p", 0, "left", "b"), rec("p", 0, "left", "a")]) + "\nnot json\n")
    out = ja.analyse(ja.load(str(f)))
    assert out["picks"] == 1 and out["accuracy"] == 1.0
    empty = ja.analyse({})
    assert empty["accuracy"] is None and empty["swap"]["consistency"] is None


def test_same_identity_picks_are_unrecoverable_not_scored():
    """L5-06: a pick whose sides share one id has one judge score and an ambiguous winner; it must not be scored or count as consistent."""
    dup = {"pairId": "d", "n": 0, "choice": "left", "left": "k/p", "right": "k/p", "winner": "k/p", "judgeScores": {"k/p": 0.7}}
    dup1 = dict(dup, n=1)
    good = rec("g", 0, "left", "a"); good["left"], good["right"] = "a", "b"
    out = ja.analyse({("d", 0): dup, ("d", 1): dup1, ("g", 0): good})
    assert out["unrecoverable"] == 2 and out["picks"] == 1 and out["swap"]["pairs"] == 0
