"""Run the real supervisor in a disposable repository with inert child tools."""
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest
import uuid

SOURCE = Path(__file__).resolve().parents[2] / "scripts/atelier/standing-loop.sh"
LOCK_HELPER = SOURCE.parent / "supervision_lock.py"


class StandingRegression(unittest.TestCase):
    def run_scenario(self, first, validator_exit=0, wave_exit=0,
                     expected=0, seq_waves=2, timeout=30, wave_turns=None):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            scripts = root / "scripts/atelier"
            scripts.mkdir(parents=True)
            runtime = root / ".omx/atelier"
            (runtime / "lessons").mkdir(parents=True)
            shutil.copy2(SOURCE, scripts / "standing-loop.sh")
            shutil.copy2(LOCK_HELPER, scripts / "supervision_lock.py")
            (scripts / "repair-ledger.py").write_text("pass\n")
            (scripts / "validate-100.py").write_text(
                "import os, pathlib, sys\n"
                "if sys.argv[sys.argv.index('--turns')+1] != os.environ.get('SINTER_STANDING_TURNS', '10'): raise SystemExit(98)\n"
                "p=pathlib.Path('attempt'); n=int(p.read_text())+1 if p.exists() else 1\n"
                "p.write_text(str(n))\n"
                "print(os.environ['FIRST'] if n==1 else '{\"passed\":true}')\n"
                "sys.exit(int(os.environ['VEXIT']) if n==1 else 0)\n")
            (scripts / "system-loop.sh").write_text(
                '[ "$1" = "${SINTER_STANDING_TURNS:-10}" ] || exit 97\nexit "$WEXIT"\n')
            bin_dir = root / "bin"
            bin_dir.mkdir()
            waves = "\\n".join(str(i) for i in range(1, seq_waves + 1))
            for name, code in {"seq": f"printf '{waves}\\n'", "sleep": ":", "nohup": ":"}.items():
                executable = bin_dir / name
                executable.write_text("#!/bin/sh\n" + code + "\n")
                executable.chmod(0o755)
            env = dict(os.environ, PATH=f"{bin_dir}:{os.environ['PATH']}",
                       WORKER_ID="qa-" + uuid.uuid4().hex, FIRST=first,
                       VEXIT=str(validator_exit), WEXIT=str(wave_exit),
                       SINTER_STANDING_TURNS=str(wave_turns or 10))
            result = subprocess.run(["bash", str(scripts / "standing-loop.sh")],
                                    cwd=root, env=env, capture_output=True, text=True, timeout=timeout)
            self.assertEqual(result.returncode, expected, result.stderr)
            self.assertFalse(Path(f"/tmp/sinter-standing-loop-{env['WORKER_ID']}.lockd").exists())
            return (runtime / f"lessons/standing-{env['WORKER_ID']}.log").read_text()

    def test_rejects_misleading_validation(self):
        for first, status in [('log: {"passed":true}', 0), ('{"passed":true}', 1),
                              ('{"passed":"true"}', 0), ('{"passed":false}', 0)]:
            with self.subTest(output=first, exit=status):
                log = self.run_scenario(first, status)
                self.assertNotIn("REACHED — wave 1", log)
                self.assertIn("REACHED — wave 2", log)

    def test_failed_wave_cannot_claim_success(self):
        log = self.run_scenario('{"passed":true}', wave_exit=1, expected=1)
        self.assertNotIn("REACHED", log)

    def test_wave_cap_reports_failure_after_all_attempts(self):
        log = self.run_scenario('{"passed":true}', wave_exit=1, expected=1,
                                seq_waves=50, timeout=60)
        self.assertIn("runner end", log)
        self.assertNotIn("REACHED", log)

    def test_valid_wave_stops_immediately(self):
        log = self.run_scenario('{"passed":true}')
        self.assertIn("[standing] WAVE scored=0", log)
        self.assertIn("REACHED — wave 1", log)
        self.assertNotIn("WAVE 2 start", log)

    def test_configurable_wave_count_matches_validator_denominator(self):
        log = self.run_scenario('{"passed":true}', wave_turns=1)
        self.assertIn("REACHED — wave 1", log)

    def test_wave_turn_count_rejects_out_of_range_values(self):
        for turns in ("0", "11", "abc", "1.5"):
            with self.subTest(turns=turns):
                log = self.run_scenario('{"passed":true}', wave_turns=turns,
                                        expected=2)
                self.assertIn("SINTER_STANDING_TURNS must be an integer from 1 to 10", log)
                self.assertNotIn("WAVE 1 start", log)


if __name__ == "__main__":
    unittest.main()
