"""A requested scoring domain cannot override artifact provenance."""
from pathlib import Path
import subprocess
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[3]


class ScoringDomainPreflightTest(unittest.TestCase):
    def test_rejects_mismatch_before_capture_or_judging(self):
        with tempfile.TemporaryDirectory() as temp:
            art = Path(temp)
            (art / "playable.html").write_text("<!doctype html><title>ASCII art</title>")
            (art / "provenance.txt").write_text('{"domain":"ascii"}')
            result = subprocess.run(
                ["node", "bin/sinter", "sss-score", "--domain", "hyperframes", str(art)],
                cwd=ROOT, text=True, capture_output=True, timeout=15)
            self.assertEqual(result.returncode, 6)
            self.assertIn("SSS_SCORE_DOMAIN_MISMATCH", result.stderr)
            self.assertNotIn("[sss] scorecard:", result.stdout)


if __name__ == "__main__":
    unittest.main()
