"""Focused parity checks for streamed improvement history."""
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location("improvement_watch", ROOT / "scripts/atelier/improvement-watch.py")
WATCH = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(WATCH)


class ImprovementWatchRegression(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name)
        data = root / ".omx/atelier/lessons"
        data.mkdir(parents=True)
        WATCH.TREND, WATCH.BESTS, WATCH.OUT = str(data / "trend.jsonl"), str(data / "best.json"), str(root / "out")
        self.trend, self.bests = Path(WATCH.TREND), Path(WATCH.BESTS)
        self.bests.write_text(json.dumps({"p5": {"q": 5, "artifact": "old", "axes": "D=5 A=5", "turn": 1}}))
        self.shows = []
        WATCH.show = lambda *args: self.shows.append(args)

    def tearDown(self):
        self.tmp.cleanup()

    def test_best_update_and_shower_match_valid_history(self):
        rows = [{"domain": "p5", "axes": "D=6 A=6", "artifact": "new", "turn": 2}]
        self.trend.write_text("\n".join(map(json.dumps, rows)))
        WATCH.main()
        self.assertEqual(json.loads(self.bests.read_text())["p5"]["q"], 6)
        self.assertEqual(self.shows[0][1]["artifact"], "old")

    def test_non_improving_row_does_not_shower_or_change_best(self):
        self.trend.write_text(json.dumps({"domain": "p5", "axes": "D=4 A=4", "artifact": "low"}))
        WATCH.main()
        self.assertEqual(json.loads(self.bests.read_text())["p5"]["q"], 5)
        self.assertEqual(self.shows, [])

    def test_malformed_later_row_does_not_partially_update_or_shower(self):
        original = self.bests.read_bytes()
        self.trend.write_text(json.dumps({"domain": "p5", "axes": "D=6 A=6", "artifact": "new"}) + "\nBROKEN\n")
        with self.assertRaises(json.JSONDecodeError):
            WATCH.main()
        self.assertEqual(self.bests.read_bytes(), original)
        self.assertEqual(self.shows, [])

    def test_invalid_utf8_tail_does_not_partially_update_or_shower(self):
        original = self.bests.read_bytes()
        self.trend.write_bytes(json.dumps({"domain": "p5", "axes": "D=6 A=6", "artifact": "new"}).encode() + b"\n\xff")
        with self.assertRaises(UnicodeDecodeError):
            WATCH.main()
        self.assertEqual(self.bests.read_bytes(), original)
        self.assertEqual(self.shows, [])


if __name__ == "__main__":
    unittest.main()
