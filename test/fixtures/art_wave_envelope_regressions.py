"""Inert regression tests for the SINTER_ART_WALL_SECONDS envelope.

The envelope turns the wave's total wall budget into reachable inner
deadlines: the tail (scoring + receipt + cleanup) is reserved first, then
generation and retry get whatever wall is left, and best-of is gated off
when a single best-of plus the reserve cannot fit. These tests source the
real helpers out of system-loop.sh and exercise them under controlled
ART_WALL_SECONDS / clock / log conditions — no child processes, no node,
no live scoring.
"""
from __future__ import annotations

import os
import re
import subprocess
import tempfile
import unittest
from pathlib import Path

SOURCE = Path(__file__).resolve().parents[2] / "scripts/atelier/system-loop.sh"

# Match the full envelope block — from the ART WAVE ENVELOPE comment through
# the closing brace of art_should_skip_postwave. The helpers use $(date +%s);
# the harness stubs `date` so the helpers report deterministic remaining.
_ENVELOPE_RE = re.compile(
    r"# ART WAVE ENVELOPE \(2026-09-29\):.*?\nart_should_skip_postwave\(\) \{.*?\n\}\n",
    re.DOTALL,
)


def _extract_envelope(source: str) -> str:
    match = _ENVELOPE_RE.search(source)
    if not match:
        raise RuntimeError(
            "ART WAVE ENVELOPE block not found in system-loop.sh — "
            "the helpers under test are missing."
        )
    return match.group(0)


def _run_envelope(
    wall: int | None,
    elapsed: int,
    body: str,
) -> subprocess.CompletedProcess:
    """Source the envelope helpers in a fresh bash and run `body`.

    `wall=None` simulates an unbounded (non-ART) run. `elapsed` is the
    simulated time already spent in the wave — the helpers' $(date +%s)
    is stubbed so `now - RUN_STARTED == elapsed`. The subprocess runs in
    a temp cwd so `art_defer`'s relative `.omx/atelier/lessons/loop.log`
    write lands inside the temp tree.
    """
    envelope = _extract_envelope(SOURCE.read_text())
    now_epoch = 1_700_000_000 + elapsed
    run_started = now_epoch - elapsed
    env_setup = (
        f"export RUN_STARTED={run_started}\n"
        f"export ART_TAIL_RESERVE_SECONDS=300\n"
        f"export ART_WALL_SECONDS={wall if wall is not None else ''}\n"
        # Freeze the helpers' $(date +%s) to the simulated clock.
        f"date() {{ printf '%s\\n' {now_epoch}; }}\n"
        "mkdir -p .omx/atelier/lessons\n"
        ": > .omx/atelier/lessons/loop.log\n"
    )
    script = env_setup + envelope + "\n" + body
    with tempfile.TemporaryDirectory() as tmp:
        return subprocess.run(
            ["bash", "-c", script],
            capture_output=True,
            text=True,
            timeout=10,
            cwd=tmp,
        )


class ArtWaveEnvelope(unittest.TestCase):
    def test_budget_launcher_prefers_configured_art_executable_directory(self):
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            env = dict(os.environ, SINTER_ART_MEMORY_MIB="32", SINTER_ART_CPU_PERCENT="1",
                       SINTER_ART_WALL_SECONDS="2", SINTER_ART_PYTHON="fixture-launcher",
                       SINTER_ART_BUDGETED="")
            for name in ("fallback", "isolated bin"):
                directory = base / name
                directory.mkdir()
                launcher = directory / "fixture-launcher"
                launcher.write_text("#!/bin/sh\necho '" + name + "'\n")
                launcher.chmod(0o700)
            env["PATH"] = str(base / "fallback") + os.pathsep + env["PATH"]
            for override, expected in (("", "fallback"), (str(base / "isolated bin"), "isolated bin")):
                result = subprocess.run(["bash", SOURCE], env={**env, "SINTER_ART_BIN_DIR": override},
                                        capture_output=True, text=True, timeout=3, check=True)
                self.assertEqual(result.stdout.strip(), expected)

    def test_generation_retry_recomputes_deadline_and_refuses_exhaustion(self):
        proc = _run_envelope(720, 120, '''
python3() { printf '%s|%s\n' "$SINTER_ART_GENERATION_WALL_SECONDS" "$*"; }
LOCK_HELPER=helper.py
art_bounded 800 300 30 node first
ART_WAVE_DEADLINE=$((ART_WAVE_DEADLINE - 200))
art_bounded 800 300 30 node retry
ART_WAVE_DEADLINE=$((ART_WAVE_DEADLINE - 100))
art_bounded 800 300 30 node forbidden; echo "exit=$?"
''')
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertIn('270|helper.py bounded --seconds 270 --grace 30 -- node first', proc.stdout)
        self.assertIn('70|helper.py bounded --seconds 70 --grace 30 -- node retry', proc.stdout)
        self.assertNotIn('node forbidden', proc.stdout)
        self.assertIn('exit=124', proc.stdout)

    def test_command_caps_and_organ_costs_keep_original_unbounded_behavior(self):
        proc = _run_envelope(None, 60, '''
python3() { printf '%s\n' "$*"; }
LOCK_HELPER=helper.py
art_bounded 800 300 30 node generate
art_bounded 240 30 0.2 node score
if art_should_skip_postwave 900; then echo DEFER; else echo RUN; fi
''')
        self.assertIn('--seconds 800 --grace 30 -- node generate', proc.stdout)
        self.assertIn('--seconds 240 --grace 0.2 -- node score', proc.stdout)
        self.assertIn('RUN', proc.stdout)
        bounded = _run_envelope(720, 120, 'if art_should_skip_postwave 900; then echo DEFER; fi')
        self.assertIn('DEFER', bounded.stdout)

    def test_unbounded_runs_ignore_wall(self):
        proc = _run_envelope(
            None, 60,
            "art_remaining; echo \"==$?==\"\n"
            "art_generation_budget; echo \"==$?==\"\n"
            "if art_best_of_allowed; then echo BESTOF_OK; fi\n"
            "if art_postwave_allowed; then echo POSTWAVE_OK; fi\n"
            "if art_should_skip_postwave; then echo DEFER; else echo RUN; fi\n",
        )
        self.assertEqual(proc.returncode, 0, proc.stderr)
        # Unbounded: art_remaining echoes nothing, art_generation_budget
        # echoes nothing, all gates fall open.
        self.assertIn("==0==", proc.stdout)
        self.assertIn("BESTOF_OK", proc.stdout)
        self.assertIn("POSTWAVE_OK", proc.stdout)
        self.assertIn("RUN", proc.stdout)
        self.assertNotIn("DEFER", proc.stdout)

    def test_bounded_wall_clamps_generation_budget(self):
        # 720s ART wave, 120s elapsed — remaining 600s, minus 300s tail
        # reserve = 300s budget for generation. best-of (2600+300=2900) is
        # unaffordable; post-wave organs still have slack.
        proc = _run_envelope(
            720, 120,
            "art_remaining\n"
            "art_generation_budget\n"
            "if art_best_of_allowed; then echo BESTOF_OK; else echo BESTOF_NO; fi\n"
            "if art_postwave_allowed; then echo POSTWAVE_OK; else echo POSTWAVE_NO; fi\n"
            "if art_should_skip_postwave; then echo DEFER; else echo RUN; fi\n",
        )
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertIn("600\n", proc.stdout)
        self.assertIn("300\n", proc.stdout)
        self.assertIn("BESTOF_NO", proc.stdout)
        self.assertIn("POSTWAVE_OK", proc.stdout)
        self.assertIn("RUN", proc.stdout)

    def test_bounded_wall_exhaustion_defers_postwave_organs(self):
        # 720s wall, 700s elapsed — remaining 20s, less than 300s tail
        # reserve → generation budget clamps to 0; post-wave organs must
        # defer (no slack left after the tail reserve is owed).
        proc = _run_envelope(
            720, 700,
            "art_remaining\n"
            "art_generation_budget\n"
            "if art_best_of_allowed; then echo BESTOF_OK; else echo BESTOF_NO; fi\n"
            "if art_postwave_allowed; then echo POSTWAVE_OK; else echo POSTWAVE_NO; fi\n"
            "if art_should_skip_postwave; then art_defer rescue; echo DEFER; else echo RUN; fi\n",
        )
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertIn("20\n", proc.stdout)
        self.assertIn("0\n", proc.stdout)
        self.assertIn("BESTOF_NO", proc.stdout)
        self.assertIn("POSTWAVE_NO", proc.stdout)
        self.assertIn("DEFER", proc.stdout)
        # The defer log line must land in the real lessons/loop.log file
        # (cwd-scoped) so an operator can grep DEFERRED post-wave organ
        # without scraping stdout. The _run_envelope helper uses a fresh
        # tempdir, so this assertion re-invokes the defer from a
        # persistent cwd it controls.
        self._assert_defer_log_written()

    def _assert_defer_log_written(self):
        # Run with a persistent cwd so we can inspect the on-disk log.
        envelope = _extract_envelope(SOURCE.read_text())
        now_epoch = 1_700_000_700
        run_started = now_epoch - 700
        env_setup = (
            f"export RUN_STARTED={run_started}\n"
            f"export ART_TAIL_RESERVE_SECONDS=300\n"
            "export ART_WALL_SECONDS=720\n"
            f"date() {{ printf '%s\\n' {now_epoch}; }}\n"
            "mkdir -p .omx/atelier/lessons\n"
            ": > .omx/atelier/lessons/loop.log\n"
        )
        script = env_setup + envelope + "\nif art_should_skip_postwave; then art_defer rescue; fi\n"
        with tempfile.TemporaryDirectory() as tmp:
            subprocess.run(["bash", "-c", script], capture_output=True, text=True, cwd=tmp)
            log = Path(tmp) / ".omx/atelier/lessons/loop.log"
            self.assertTrue(log.exists(), f"defer log missing at {log}")
            text = log.read_text()
            self.assertIn("DEFERRED post-wave organ 'rescue'", text)
            self.assertIn("wave wall 720s exhausted", text)
            self.assertIn("300s tail reserve required", text)

    def test_bounded_wall_with_full_budget_allows_best_of(self):
        # 4000s wall, 100s elapsed — remaining 3900s. best-of (2600+300=2900)
        # fits; post-wave slack check is still positive (3900 >= 300).
        proc = _run_envelope(
            4000, 100,
            "art_generation_budget\n"
            "if art_best_of_allowed; then echo BESTOF_OK; else echo BESTOF_NO; fi\n"
            "if art_postwave_allowed; then echo POSTWAVE_OK; else echo POSTWAVE_NO; fi\n"
            "if art_should_skip_postwave; then echo DEFER; else echo RUN; fi\n",
        )
        self.assertEqual(proc.returncode, 0, proc.stderr)
        # 3900 - 300 = 3600
        self.assertIn("3600\n", proc.stdout)
        self.assertIn("BESTOF_OK", proc.stdout)
        self.assertIn("POSTWAVE_OK", proc.stdout)
        self.assertIn("RUN", proc.stdout)


if __name__ == "__main__":
    unittest.main()
