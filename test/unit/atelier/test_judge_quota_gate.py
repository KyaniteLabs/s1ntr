import datetime as dt
import importlib.util
import json
import os
import tempfile
import unittest
from pathlib import Path


SCRIPT = Path(__file__).resolve().parents[3] / "scripts/atelier/judge-quota-gate.py"
SPEC = importlib.util.spec_from_file_location("judge_quota_gate", SCRIPT)
GATE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(GATE)


class JudgeQuotaGateTest(unittest.TestCase):
    def evidence(self, directory, request_id, code="1308"):
        row = {
            "failureClass": "http_429",
            "capturedAt": "2026-09-29T14:32:57.855Z",
            "body": json.dumps({
                "error": {"code": code, "message":
                          "Usage limit reached for 5 hour. Your limit will reset at 2026-09-29 23:11:22"},
                "request_id": request_id,
            }),
        }
        (directory / "glm-5.3-flash-one.json").write_text(json.dumps(row))

    def test_infers_provider_clock_offset_from_request_id(self):
        with tempfile.TemporaryDirectory() as temp:
            directory = Path(temp)
            self.evidence(directory, "20260929223257sample")
            self.assertEqual(GATE.next_eligible(directory),
                             dt.datetime(2026, 9, 29, 15, 11, 22, tzinfo=dt.timezone.utc))

    def test_uses_five_hour_hold_without_verifiable_clock(self):
        with tempfile.TemporaryDirectory() as temp:
            directory = Path(temp)
            self.evidence(directory, "opaque")
            self.assertEqual(GATE.next_eligible(directory),
                             dt.datetime(2026, 9, 29, 19, 32, 57, 855000, tzinfo=dt.timezone.utc))
            self.evidence(directory, "opaque", code="unrelated")
            self.assertIsNone(GATE.next_eligible(directory))

    def test_accepts_only_a_new_score_from_the_configured_fallback_pair(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            evidence = root / "judge-evidence"
            scorecards = root / "scorecards"
            evidence.mkdir()
            scorecards.mkdir()
            self.evidence(evidence, "20260929223257sample")
            config = root / "config.json"
            config.write_text(json.dumps({"roles": {"evaluator": {
                "provider": "kilo", "model": "dots-studio/dots-3-note-preview:free",
                "reasoning": {"effort": "none"}, "apiKey": "test-key"}}}))
            score = scorecards / "score-one.json"
            score.write_text(json.dumps({"scoreScale": 10,
                "scoringContract": "spu-2.0-literal-v1",
                "judges": [{"vendor": "dots-3-note-preview:free"},
                           {"vendor": "minimax-m3"}]}))
            os.utime(evidence / "glm-5.3-flash-one.json", (100, 100))
            os.utime(score, (101, 101))
            self.assertTrue(GATE.qualified_fallback(evidence, config))
            os.utime(score, (99, 99))
            self.assertFalse(GATE.qualified_fallback(evidence, config))
            os.utime(score, (101, 101))
            config.write_text(json.dumps({"roles": {"evaluator": {"provider": "minimax"}}}))
            self.assertFalse(GATE.qualified_fallback(evidence, config))


if __name__ == "__main__":
    unittest.main()
