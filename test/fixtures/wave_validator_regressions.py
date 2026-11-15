"""Exercise the real wave gate with isolated history and explicit receipts."""
import hashlib
import importlib.util
import json
import math
from pathlib import Path
import subprocess
import tempfile
import unittest

SOURCE = Path(__file__).resolve().parents[2] / "scripts/atelier/validate-100.py"
RECEIPT_SOURCE = SOURCE.parent / "score_receipt.py"
_SPEC = importlib.util.spec_from_file_location("score_receipt", RECEIPT_SOURCE)
RECEIPT = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(RECEIPT)


class WaveRegression(unittest.TestCase):
    def run_gate(self, score=10, judges=None, receipt=None, corrupt=False, paths=None,
                 turn_offset=0):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            lessons = root / ".omx/atelier/lessons"
            lessons.mkdir(parents=True)
            paths = paths or [f"/output/piece-{i}" for i in range(10)]
            rows = [{"event_type": "artifact_scored", "artifact": paths[i],
                     "axes": f"D={score} A={score} R={score} N={score}",
                     "judges": judges if judges is not None else ["eye-one", "eye-two"]}
                    for i in range(10)]
            history = bytearray()
            records = []
            try:
                number = float(score)
                if not math.isfinite(number):
                    raise ValueError
            except (TypeError, ValueError):
                number = 10.0
            axes = {axis: number for axis in "DARN"}
            for turn, (path, row) in enumerate(zip(paths, rows), 1):
                line = (json.dumps(row, separators=(",", ":")) + "\n").encode()
                offset = len(history)
                history.extend(line)
                digest = hashlib.sha256(line).hexdigest()
                records.append({"schema": "sinter.wave.receipt/1", "turn": turn + turn_offset,
                                "artifact": path,
                                "artifact_identity": str(Path(path).resolve()),
                                "trend_offset": offset, "trend_length": len(line),
                                "trend_sha256": digest, "row_sha256": digest,
                                "axes": axes})
            if corrupt:
                history[0] = ord("X")
            (lessons / "trend.jsonl").write_bytes(bytes(history))
            artifacts = root / "wave.txt"
            selected = receipt if receipt is not None else paths[:6]
            by_path = {path: record for path, record in zip(paths, records)}
            evidence = [by_path.get(path, {"artifact": path}) for path in selected]
            artifacts.write_text("\n".join(json.dumps(item) for item in evidence))
            result = subprocess.run(["python3", str(SOURCE), "--artifacts", str(artifacts),
                                     "--turns", "10"], cwd=root, capture_output=True,
                                    text=True, timeout=5)
            return result.returncode, json.loads(result.stdout)

    def test_canonical_ceiling_and_coverage(self):
        status, result = self.run_gate()
        self.assertEqual(status, 0)
        self.assertTrue(result["passed"])
        self.assertEqual(result["scored_turns"], 6)
        self.assertFalse(self.run_gate(score=5)[1]["passed"])
        self.assertEqual(self.run_gate(turn_offset=10)[0], 1)

    def test_malformed_or_single_judge_panels_fail(self):
        for kwargs in ({"score": "nan"}, {"score": 11}, {"score": "bad"},
                       {"judges": ["one"]}, {"judges": ["one", "one"]}, {"corrupt": True}):
            with self.subTest(kwargs=kwargs):
                status, result = self.run_gate(**kwargs)
                self.assertEqual(status, 1)
                self.assertFalse(result["passed"])

    def test_old_other_worker_or_duplicate_successes_do_not_count(self):
        for receipt in ([], ["other-worker"] * 6, ["/output/piece-0"] * 6,
                        [f"/output/piece-{i}" for i in range(5)]):
            with self.subTest(receipt=receipt):
                self.assertFalse(self.run_gate(receipt=receipt)[1]["passed"])

    def test_same_basename_artifacts_keep_distinct_identity(self):
        paths = [f"/output/a/piece-{i}" for i in range(5)]
        paths += ["/output/b/piece-0"]
        paths += [f"/output/b/piece-{i}" for i in range(1, 5)]
        status, result = self.run_gate(paths=paths)
        self.assertEqual(status, 0)
        self.assertTrue(result["passed"])

    def test_new_score_schema_requires_judge_join_events(self):
        with tempfile.TemporaryDirectory() as tmp:
            trend = Path(tmp) / "trend.jsonl"
            row = {"event_type": "artifact_scored", "schema_version": "sinter.trend/1.2",
                   "artifact": "/output/piece", "artifact_identity_sha256": "a" * 64,
                   "scorecard_id": "score-1", "axes": "D=8 A=8 R=8 N=8",
                   "judges": ["eye-one", "eye-two"]}
            trend.write_bytes((json.dumps(row, separators=(",", ":")) + "\n").encode())
            with self.assertRaisesRegex(ValueError, "missing judge call join"):
                RECEIPT.verify_new_row("/output/piece", 0, row["axes"], 1, trend)

    def test_receipt_rejects_corrupt_boundary_and_non_string_identity(self):
        row = json.dumps({"event_type": "artifact_scored",
                          "artifact": "/output/piece",
                          "axes": "D=10 A=10 R=10 N=10",
                          "judges": ["one", "two"]}).encode() + b"\n"
        with tempfile.TemporaryDirectory() as tmp:
            trend = Path(tmp) / "trend.jsonl"
            trend.write_bytes(b"unterminated" + row)
            with self.assertRaises(ValueError):
                RECEIPT.verify_new_row("/output/piece", len(b"unterminated"),
                                        "D=10 A=10 R=10 N=10", 1, trend)
            with self.assertRaises(ValueError):
                RECEIPT._line_at(row + row, 0, len(row) * 2)
        self.assertEqual(RECEIPT.artifact_identity(42), "")
        self.assertEqual(RECEIPT.artifact_identity({"id": "piece"}), "")


if __name__ == "__main__":
    unittest.main()
