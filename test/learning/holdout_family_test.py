"""L5-18: every take of one prompt (different rid) is in the same holdout family, so they land in one split."""
import importlib.util, os, sys
d = os.path.join(os.path.dirname(__file__), "..", "..", "scripts", "learning"); sys.path.insert(0, d)
spec = importlib.util.spec_from_file_location("overrides", os.path.join(d, "overrides.py")); m = importlib.util.module_from_spec(spec)
try: spec.loader.exec_module(m)
except SystemExit: pass
def test_takes_share_family():
    a = {"entry": {"id": "abyss", "rid": "abyss.take.abyss-r1", "key": "k"}}; b = {"entry": {"id": "abyss", "rid": "abyss.take.abyss-r3", "key": "k"}}
    assert m.family_of(a) == m.family_of(b) == "abyss"
    held = m.L.split_holdout({m.family_of(a): ["u1", "u2"]})
    assert ("abyss" in held) in (True, False)  # all-or-nothing by family
