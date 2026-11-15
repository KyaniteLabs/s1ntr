"""Run the actual system loop with inert local generator and scorer tools."""
import json
import math
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
import textwrap
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "scripts/atelier"))
from learning_turns import paired_turns, scored_turns


SOURCE = Path(__file__).resolve().parents[2] / "scripts/atelier/system-loop.sh"
LOCK_HELPER = SOURCE.parent / "supervision_lock.py"
RECEIPT_HELPER = SOURCE.parent / "score_receipt.py"


class SystemLoopRegression(unittest.TestCase):
    def test_paired_early_reject_runs_before_next_pair_plan(self):
        source = SOURCE.read_text()
        gate = source.index("graduate.py --early-reject-only")
        next_plan = source.index("learning_turns.py plan")
        self.assertLess(gate, next_plan)
        self.assertIn("hints-staging.json", source[gate:next_plan])

    def test_prompt_circuit_breaker_keeps_only_latest_four_scores(self):
        source = SOURCE.read_text()
        start = 'BENCHED=$(python3 - "$P" <<\'BRK\' 2>/dev/null\n'
        body = source.split(start, 1)[1].split('\nBRK\n', 1)[0]
        prompt = "prompt café matching this trend history"
        low = {"prompt": prompt, "axes": "D=1 A=1 R=1 N=1"}
        high = {"prompt": prompt, "axes": "D=10 A=10 R=10 N=10"}
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            trend = root / ".omx/atelier/lessons/trend.jsonl"
            trend.parent.mkdir(parents=True)
            history = ([json.dumps(low, ensure_ascii=False)] * 99_995
                       + [json.dumps(low, ensure_ascii=False)] * 2
                       + ["{malformed", json.dumps(low, ensure_ascii=False),
                          json.dumps(high, ensure_ascii=False)])
            trend.write_bytes("\n".join(history).encode())
            result = subprocess.run([sys.executable, "-c", body, prompt], cwd=root,
                                    capture_output=True, text=True, timeout=10)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertNotEqual(result.stdout.strip(), "BENCH")
            with trend.open("ab") as stream:
                stream.write(b"\n")
                for _ in range(4):
                    stream.write((json.dumps(low, ensure_ascii=False) + "\n").encode())
            result = subprocess.run([sys.executable, "-c", body, prompt], cwd=root,
                                    capture_output=True, text=True, timeout=10)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(result.stdout.strip(), "BENCH")
            trend.write_text(json.dumps({"prompt": "unrelated", "axes": "D=1 A=1"}))
            result = subprocess.run([sys.executable, "-c", body, prompt], cwd=root,
                                    capture_output=True, text=True, timeout=10)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(result.stdout.strip(), "")
            trend.write_bytes(b'{"prompt":"unrelated","axes":"D=1"}\n\xff')
            result = subprocess.run([sys.executable, "-c", body, prompt], cwd=root,
                                    capture_output=True, text=True, timeout=10)
            self.assertNotEqual(result.returncode, 0)

    def _write(self, path, text, executable=False):
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text)
        if executable:
            path.chmod(0o700)

    def _sandbox_source(self, root, locks):
        text = SOURCE.read_text()
        text = text.replace("/tmp/", str(locks) + "/")
        text = text.replace("find /tmp ", "find %s " % locks)
        text, count = re.subn(
            r'^export PATH="(.*)"$',
            lambda match: 'export PATH="$HOME/.local/bin:' + match.group(1) + '"',
            text, count=1, flags=re.MULTILINE)
        self.assertEqual(count, 1)
        target = root / "scripts/atelier/system-loop.sh"
        self._write(target, text, executable=True)
        shutil.copy2(LOCK_HELPER, target.parent / "supervision_lock.py")
        shutil.copy2(RECEIPT_HELPER, target.parent / "score_receipt.py")
        return target

    def _prepare_tree(self, root, mode, refinement):
        lessons = root / ".omx/atelier/lessons"
        (root / ".omx/atelier/prompts").mkdir(parents=True)
        (root / ".omx/atelier/personas").mkdir(parents=True)
        (root / ".omx/atelier/second-judge").mkdir(parents=True)
        cadence = root / ".omx/atelier/third-judge/.cadence-marker"
        cadence.parent.mkdir(parents=True)
        cadence.touch()
        lessons.mkdir(parents=True)
        self._write(root / ".omx/atelier/prompts/model-rotation.json", "{}\n")
        self._write(root / ".omx/atelier/personas/active-persona.json",
                    '{"id":"fixture-persona"}\n')
        self._write(lessons / "trend.jsonl", "")
        self._write(root / ".omx/atelier/table-cursor", "5\n")
        if mode == "historical":
            old = root / "artifacts/turn-1"
            self._write(old / "source.txt", "historical artwork\n")
            row = {"event_type": "artifact_scored", "artifact": str(old),
                   "axes": "D=10 A=10 R=10 N=10",
                   "judges": ["judge-a", "judge-b"]}
            self._write(lessons / "trend.jsonl", json.dumps(row) + "\n")
        self._write(root / ".omx/atelier/lessons/hints.json", "[]\n")
        self._write(root / "config.json",
                    '{"roles":{"generator":{"model":"fixture"},'
                    '"evaluator":{"apiKey":"fixture"}},"providers":{}}\n')
        if refinement:
            base = root / "artifacts/base"
            self._write(base / "source.txt", "existing artwork\n")
            self._write(root / ".omx/atelier/best-per-domain.json",
                        json.dumps({"three":{"dir":"artifacts/base",
                                               "domain":"three"}}))
        return lessons

    def _node_program(self):
        return textwrap.dedent("""\
            #!/usr/bin/env python3
            import datetime
            import json
            import os
            import sys
            from pathlib import Path

            root = Path(os.environ["TEST_ROOT"])
            args = sys.argv[1:]
            calls = root / "node-calls.jsonl"
            def record(value):
                if value.get("kind") == "generate":
                    value["lane"] = {key: os.environ.get("SINTER_GENERATOR_" + key, "")
                                     for key in ("MODEL", "BASE_URL", "PROVIDER")}
                with calls.open("a") as stream:
                    stream.write(json.dumps(value) + "\\n")
            record({"args": args})
            if args[:1] == ["-v"]:
                print("v-fixture")
                raise SystemExit(0)
            if "prompt-next" in args or "rotate" in args:
                if "next" in args:
                    mode = os.environ.get("ROTATE_MODE")
                    if mode == "hold":
                        print('{"modelId":"hold"}')
                    elif mode == "retry":
                        attempts = root / "rotation-attempts"
                        count = int(attempts.read_text()) + 1 if attempts.exists() else 1
                        attempts.write_text(str(count))
                        model = "fixture" if count == 1 else "fixture-retry"
                        print(json.dumps({"modelId": model, "provider": "openai"}))
                    else:
                        print('{"modelId":"fixture","provider":"openai"}')
                raise SystemExit(0)
            if "sss-score" in args:
                mode = os.environ.get("SCORE_MODE", "valid")
                if mode in ("judge_retry", "judge_retry_fail"):
                    attempts = root / "score-attempts"
                    count = int(attempts.read_text()) + 1 if attempts.exists() else 1
                    attempts.write_text(str(count))
                    if count == 1 or mode == "judge_retry_fail":
                        print("SSS_SCORE_INSUFFICIENT_JUDGES: minimax-m3:duplicate_lane,glm-5.3-flash:http_529")
                        raise SystemExit(4)
                    mode = "valid"
                axes = {"valid": "D=10 A=10 R=10 N=10",
                        "historical": "D=10 A=10 R=10 N=10",
                        "malformed": "D=10 A=10 R=nan N=10",
                        "missing": "D=10 A=10 R=10"}.get(mode, "")
                out = Path(args[-1])
                scored_artifact = out / "playable.html" if out.is_dir() else out
                if mode == "nonzero":
                    print("[sss] LEVEL: HIGH ensemble D=10 A=10 R=10 N=10")
                    raise SystemExit(7)
                if mode == "valid":
                    domain = args[args.index("--domain") + 1] if "--domain" in args else None
                    row = {"event_type": "artifact_scored", "artifact": str(scored_artifact),
                           "domain": domain, "model": "fixture", "scoreScale": 10, "axes": axes,
                           "judges": ["judge-a", "judge-b"],
                           "ts": datetime.datetime.now(datetime.timezone.utc).isoformat()}
                    with (root / ".omx/atelier/lessons/trend.jsonl").open("a") as stream:
                        stream.write(json.dumps(row) + "\\n")
                    (root / "score-complete").touch()
                print("[sss] LEVEL: HIGH ensemble %s | judges=judge-a,judge-b" % axes)
                raise SystemExit(0)
            if "bin/sinter" not in args:
                raise SystemExit(0)
            ignored = {"rescue", "second-judge", "gbg", "name", "field", "third-judge"}
            if any(item in args for item in ignored):
                raise SystemExit(0)
            count_file = root / "generation-count"
            count = int(count_file.read_text()) + 1 if count_file.exists() else 1
            count_file.write_text(str(count))
            if count == 1 and os.environ.get("GENERATION_FAILURE_MODE"):
                record({"kind": "generate", "args": args})
                messages = {
                    "fresh": "Error: LIMINAL_GENERATION_INVALID:current-check",
                    "c0": "Error: C0_GENERATION_INVALID:p5.js code references undeclared identifier: culori",
                    "decorated_c0": "❌ Error: C0_GENERATION_INVALID:undeclared identifier: culori",
                    "syntax": "Error: invalid JavaScript syntax: Unexpected token (1:2)",
                    "plain_syntax": "invalid JavaScript syntax: Unexpected token (1:2)",
                    "auth": "Error: HTTP 401: authentication failed",
                    "quoted_auth": "Error: HTTP 401: upstream body quotes Error: C0_GENERATION_INVALID:prior remote detail",
                    "transport": "Error: network connection timed out; invalid JavaScript syntax: upstream detail",
                    "quoted_transport": "Error: network connection timed out: upstream body quotes Error: C0_GENERATION_INVALID:prior remote detail",
                    "admission": "Error: C0_ADMISSION_DENIED: native admission held",
                    "validation_then_auth": "Error: C0_GENERATION_INVALID:current-check\\nError: HTTP 401",
                }
                message = messages.get(os.environ["GENERATION_FAILURE_MODE"])
                if message:
                    print(message, file=sys.stderr)
                raise SystemExit(1)
            domain = ""
            if "--domain" in args:
                domain = args[args.index("--domain") + 1]
            output_index = args.index("--output") if "--output" in args else -1
            output_root = Path(args[output_index + 1]) if output_index >= 0 else root
            artifact = output_root / "artifacts" / ("turn-%d" % count)
            artifact.mkdir(parents=True, exist_ok=True)
            (artifact / "source.txt").write_text("fixture generation %d\\n" % count)
            (artifact / "playable.html").write_text("<html>fixture</html>\\n")
            record({"kind": "generate", "domain": domain, "args": args})
            if os.environ.get("GENERATE_MODE") == "fail":
                raise SystemExit(1)
            print("Saved: %s" % (artifact / "source.txt"))
            """)

    def _write_helpers(self, root):
        scripts = root / "scripts/atelier"
        self._write(scripts / "balance.py",
                    'print("{\\"weights\\":{\\"three\\":1}}")\n')
        self._write(scripts / "frontier-pick.py", textwrap.dedent("""\
            import os
            from pathlib import Path
            p = Path(".frontier-count")
            n = int(p.read_text()) + 1 if p.exists() else 1
            p.write_text(str(n))
            if os.environ.get("TEST_REFINEMENT") == "1" and n == 8:
                print("three")
            """))
        self._write(scripts / "bandit_bridge.py", textwrap.dedent("""\
            import json, os, sys
            from pathlib import Path
            with (Path(os.environ['TEST_ROOT']) / 'bandit-calls.jsonl').open('a') as stream:
                stream.write(json.dumps(sys.argv[1:]) + '\\n')
            """))
        for name in ("genome_guard.py", "improvement-watch.py",
                     "graduate.py", "repair-ledger.py"):
            self._write(scripts / name, "raise SystemExit(0)\n")
        shutil.copy2(SOURCE.parent / "learning_turns.py", scripts / "learning_turns.py")

    def _run_scenario(self, mode="valid", turns=1, refinement=False,
                      wave_receipt=True, rotate_mode="available", domain=None,
                      waves=1, art_cursor_start=None, generate_mode="valid", worker=None,
                      rotation_json=None, generation_failure="", staged_lessons=False, paired=False):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            locks = root / "locks"
            locks.mkdir()
            home = root / "home"
            (home / ".local/bin").mkdir(parents=True)
            lessons = self._prepare_tree(root, mode, refinement)
            if art_cursor_start is not None:
                self._write(lessons / f"art-turn{'-' + worker if worker else ''}.cursor",
                            str(art_cursor_start) + "\n")
            if staged_lessons:
                self._write(lessons / "hints-staging.json", '[{"id":"staged","text":"test"}]')
            if generation_failure:
                self._write(lessons / "failures.log",
                            "Error: LIMINAL_GENERATION_INVALID:historical-check\n")
            self._write_helpers(root)
            if paired:
                self._write(lessons / 'paired-domains.json', json.dumps({'domains': ['p5', 'glsl']}))
                for name, ident in [('active', 'baseline'), ('staging', 'candidate')]:
                    self._write(lessons / f'hints-{name}.json', json.dumps([
                        {'id': ident, 'text': ident, 'domains': ['p5', 'glsl']}]))
                shutil.copy2(lessons / 'hints-active.json', lessons / 'hints.json')
                shutil.copy2(SOURCE.parent / 'genome_guard.py', root / 'scripts/atelier/genome_guard.py')
            node = home / ".local/bin/node"
            self._write(node, self._node_program(), executable=True)
            self._write(home / ".local/bin/sleep",
                        '#!/bin/sh\nprintf "%s\\n" "$*" >> "$TEST_ROOT/sleeps"\nexit 0\n',
                        executable=True)
            loop = self._sandbox_source(root, locks)
            receipt = root / "wave.receipt"
            if wave_receipt:
                receipt.write_text("")
            env = dict(os.environ)
            env.update({"HOME": str(home), "TEST_ROOT": str(root),
                        "SCORE_MODE": mode, "ROTATE_MODE": rotate_mode,
                        "GENERATE_MODE": generate_mode,
                        "TEST_REFINEMENT": "1" if refinement else "",
                        "GENERATION_FAILURE_MODE": generation_failure,
                        "SINTER_LIMINAL_RUNTIME_ROOT": str(root / "runtime"),
                        "PYTHONDONTWRITEBYTECODE": "1"})
            if wave_receipt:
                env["WAVE_RESULT_FILE"] = str(receipt)
            if domain is not None:
                env["SINTER_ART_DOMAIN"] = domain
            env.pop("WORKER_ID", None)
            if worker:
                env["WORKER_ID"] = worker
            if rotation_json is not None:
                env["SINTER_ART_ROTATION_JSON"] = rotation_json
            for _ in range(waves):
                result = subprocess.run(["bash", str(loop), str(turns)], cwd=root,
                                        env=env, capture_output=True, text=True,
                                        timeout=max(30, turns * 15))
                if result.returncode != 0:
                    break
            trend = lessons / "trend.jsonl"
            calls = root / "node-calls.jsonl"
            rows = [json.loads(line) for line in trend.read_text().splitlines()
                    if line.strip()]
            node_calls = [json.loads(line) for line in calls.read_text().splitlines()
                          if line.strip()] if calls.exists() else []
            pins = {row["arm"]: row["candidate_genome_sha256"] for row in rows
                    if row.get("arm") in ("active", "staged")
                    and row.get("candidate_genome_sha256")}
            qualified = scored_turns(trend, pins) if paired else []
            bandit_path = root / "bandit-calls.jsonl"
            bandit_calls = ([json.loads(line) for line in bandit_path.read_text().splitlines()]
                            if bandit_path.exists() else [])
            self.assertFalse(list(locks.glob("*.lockd")))
            return {"result": result, "rows": rows, "calls": node_calls,
                    "qualified": qualified,
                    "paired": paired_turns(qualified, {"p5", "glsl"}) if paired else [],
                    "bandit_calls": bandit_calls,
                    "receipt": receipt.read_text() if receipt.exists() else "",
                    "progress": (lessons / "loop-progress.heartbeat").exists(),
                    "receipt_mtime": receipt.stat().st_mtime_ns if receipt.exists() else None,
                    "score_mtime": (root / "score-complete").stat().st_mtime_ns
                    if (root / "score-complete").exists() else None,
                    "sleeps": (root / "sleeps").read_text().splitlines()
                    if (root / "sleeps").exists() else [],
                    "log": (lessons / "loop.log").read_text(),
                    "failures": (lessons / "failures.log").read_text()
                    if (lessons / "failures.log").exists() else ""}

    def test_paired_worker_matches_actual_prompts_across_wave_restarts(self):
        output = self._run_scenario(worker='paired', paired=True, waves=9)
        self.assertEqual(output['result'].returncode, 0, output['result'].stderr)
        contexts = [r for r in output['rows'] if r.get('event_type') == 'generation_context']
        self.assertEqual([r['arm'] for r in contexts],
                         ['active', 'staged', 'staged', 'active', 'active', 'staged', 'staged', 'active', 'control'])
        for i in [0, 2, 4, 6]:
            a, b = contexts[i:i + 2]
            self.assertEqual(a['domain'], b['domain'])
            self.assertEqual(a['prompt'], b['prompt'])
            self.assertEqual(a['pair_id'], b['pair_id'])
            self.assertNotEqual(a['artifact'], b['artifact'])
            self.assertTrue(a['candidate_genome_sha256'])
            self.assertNotEqual(a['candidate_genome_sha256'], b['candidate_genome_sha256'])
        self.assertEqual(len(output['qualified']), 8)
        self.assertEqual(len(output['paired']), 8)
        self.assertFalse(any(call[0] == 'prepare' for call in output['bandit_calls']))
        self.assertFalse(any('prompt-next' in call or 'best-of' in call for call in output['calls']))

    def test_valid_score_binds_receipt_to_new_trend_row(self):
        output = self._run_scenario()
        self.assertEqual(output["result"].returncode, 0,
                         output["result"].stderr + output["log"] + output["failures"])
        self.assertTrue(output["progress"])
        scored = [row for row in output["rows"]
                  if row.get("event_type") == "artifact_scored"]
        self.assertEqual(len(scored), 1)
        receipt = json.loads(output["receipt"])
        self.assertEqual(receipt["turn"], 1)
        self.assertEqual(receipt["artifact_identity"],
                         str(Path(scored[0]["artifact"]).resolve()))
        self.assertEqual(receipt["trend_sha256"], receipt["row_sha256"])
        self.assertEqual(receipt["axes"], {axis: 10.0 for axis in "DARN"})
        self.assertLessEqual(output["score_mtime"], output["receipt_mtime"])
        standalone = self._run_scenario(wave_receipt=False)
        self.assertEqual(standalone["result"].returncode, 0,
                         standalone["result"].stderr)
        self.assertEqual(standalone["receipt"], "")
        self.assertEqual(sum(row.get("event_type") == "artifact_scored"
                             for row in standalone["rows"]), 1)

    def test_explicit_wave_rotation_uses_selected_lane(self):
        pinned = '{"modelId":"fixture-flash","baseUrl":"cli://command-code","provider":"cli"}'
        output = self._run_scenario(rotate_mode="hold", rotation_json=pinned)
        self.assertEqual(output["result"].returncode, 0, output["log"])
        self.assertIn("rotation: fixture-flash @ cli://command-code", output["log"])
        self.assertFalse(any("rotate" in call["args"] for call in output["calls"]))
        held = self._run_scenario(rotation_json='{"modelId":"hold"}')
        self.assertNotEqual(held["result"].returncode, 0)
        self.assertFalse(any(call.get("kind") == "generate" for call in held["calls"]))

    def test_rate_pause_occurs_only_between_scored_turns(self):
        single = self._run_scenario(turns=1)
        pair = self._run_scenario(turns=2)
        self.assertEqual(single["result"].returncode, 0, single["log"])
        self.assertEqual(pair["result"].returncode, 0, pair["log"])
        self.assertNotIn("45", single["sleeps"])
        self.assertEqual(pair["sleeps"].count("45"), 1)

    def test_judge_retry_scores_same_artifact_once(self):
        output = self._run_scenario(mode="judge_retry")
        self.assertEqual(output["result"].returncode, 0, output["log"])
        self.assertEqual(sum("sss-score" in call["args"] for call in output["calls"]), 2)
        self.assertEqual(sum(row.get("event_type") == "artifact_scored"
                             for row in output["rows"]), 1)
        self.assertIn("15", output["sleeps"])
        self.assertIn("retrying same artifact", output["log"])
        failed = self._run_scenario(mode="judge_retry_fail")
        self.assertNotEqual(failed["result"].returncode, 0)
        self.assertEqual(sum("sss-score" in call["args"] for call in failed["calls"]), 2)
        self.assertFalse(any(row.get("event_type") == "artifact_scored"
                             for row in failed["rows"]))

    def test_bad_or_historical_score_cannot_create_receipt(self):
        for mode in ("malformed", "missing", "historical"):
            with self.subTest(mode=mode):
                output = self._run_scenario(mode=mode)
                self.assertEqual(output["result"].returncode, 1)
                self.assertEqual(output["receipt"], "")
                self.assertFalse(any(row.get("event_type") == "artifact_scored"
                                     and "turn-1" in row.get("artifact", "")
                                     for row in output["rows"]
                                     if mode != "historical"))
                self.assertIn("TURN FAILED", output["log"])

    def test_nonzero_score_is_rejected(self):
        output = self._run_scenario(mode="nonzero")
        self.assertEqual(output["result"].returncode, 1)
        self.assertEqual(output["receipt"], "")
        self.assertNotIn("score-complete", output["log"])

    def test_dispatch_hold_never_generates(self):
        output = self._run_scenario(rotate_mode="hold")
        self.assertEqual(output["result"].returncode, 1)
        self.assertFalse(any(row.get("kind") == "generate" for row in output["calls"]))
        self.assertEqual(output["receipt"], "")
        self.assertIn("rotation held", output["log"])
        self.assertIn("scored 0 | FAILED 1", output["log"])

    def test_retry_rejects_same_failed_lane(self):
        output = self._run_scenario(domain="svg", generate_mode="fail")
        generated = [row for row in output["calls"] if row.get("kind") == "generate"]
        self.assertEqual(output["result"].returncode, 1)
        self.assertEqual(len(generated), 1)
        self.assertIn("retry held: no distinct live lane", output["log"])
        self.assertIn("TURN FAILED", output["log"])

    def test_operator_pin_never_rotates_to_an_unapproved_retry_lane(self):
        pin = '{"modelId":"fixture-flash","baseUrl":"cli://command-code","provider":"cli"}'
        output = self._run_scenario(rotation_json=pin, generate_mode="fail")
        generated = [row for row in output["calls"] if row.get("kind") == "generate"]
        self.assertEqual(output["result"].returncode, 1)
        self.assertEqual(len(generated), 1)
        self.assertFalse(any("rotate" in row["args"] for row in output["calls"]))
        self.assertIn("operator pin has no approved alternate lane", output["log"])

    def test_operator_pin_repairs_current_source_validation_on_same_lane(self):
        pin = '{"modelId":"fixture-pinned","baseUrl":"https://fixture.invalid","provider":"openai"}'
        for mode, diagnostic in (("c0", "undeclared identifier: culori"),
                                 ("decorated_c0", "❌ Error: C0_GENERATION_INVALID:"),
                                 ("fresh", "current-check"), ("syntax", "Unexpected token"),
                                 ("plain_syntax", "invalid JavaScript syntax:")):
            with self.subTest(mode=mode):
                output = self._run_scenario(rotation_json=pin, generation_failure=mode)
                generated = [row for row in output["calls"] if row.get("kind") == "generate"]
                self.assertEqual(output["result"].returncode, 0, output["log"])
                self.assertEqual(len(generated), 2)
                expected = {"MODEL": "fixture-pinned", "BASE_URL": "https://fixture.invalid",
                            "PROVIDER": "openai"}
                self.assertTrue(all(row["lane"] == expected for row in generated))
                self.assertIn(diagnostic, generated[1]["args"][-1])
                self.assertIn("REPAIR:", generated[1]["args"][-1])
                self.assertNotIn("historical-check", generated[1]["args"][-1])
                self.assertFalse(any("rotate" in row["args"] for row in output["calls"]))
                receipt = json.loads(output["receipt"])
                self.assertEqual(receipt["turn"], 1)
                self.assertTrue(receipt["artifact"].endswith("/turn-2/playable.html"))

    def test_operator_pin_holds_nonvalidation_stale_and_superseded_failures(self):
        pin = '{"modelId":"fixture-pinned","baseUrl":"https://fixture.invalid","provider":"openai"}'
        for mode in ("auth", "quoted_auth", "transport", "quoted_transport", "admission",
                     "stale", "validation_then_auth"):
            with self.subTest(mode=mode):
                output = self._run_scenario(rotation_json=pin, generation_failure=mode)
                generated = [row for row in output["calls"] if row.get("kind") == "generate"]
                self.assertEqual(output["result"].returncode, 1)
                self.assertEqual(len(generated), 1)
                self.assertFalse(any("rotate" in row["args"] for row in output["calls"]))
                self.assertEqual(output["receipt"], "")
                self.assertIn("operator pin has no approved alternate lane", output["log"])

    def test_operator_pin_validation_repair_stays_bounded_to_two_attempts(self):
        pin = '{"modelId":"fixture-pinned","provider":"openai"}'
        output = self._run_scenario(rotation_json=pin, generation_failure="c0", generate_mode="fail")
        generated = [row for row in output["calls"] if row.get("kind") == "generate"]
        self.assertEqual(output["result"].returncode, 1)
        self.assertEqual(len(generated), 2)
        self.assertEqual(output["receipt"], "")

    def test_explicit_domain_keeps_host_wave_distinct(self):
        output = self._run_scenario(domain="svg")
        self.assertEqual(output["result"].returncode, 0, output["result"].stderr)
        generated = [row for row in output["calls"] if row.get("kind") == "generate"]
        self.assertEqual([row["domain"] for row in generated], ["svg"])
        args = generated[0]["args"]
        self.assertTrue(Path(args[args.index("--output") + 1]).is_absolute())
        self.assertTrue(args[args.index("--output") + 1].endswith("/runtime"))
        self.assertFalse(any("prompt-next" in row["args"] for row in output["calls"]))

    def test_balanced_worker_keeps_artifacts_in_its_runtime_root(self):
        output = self._run_scenario(worker="PMM2")
        self.assertEqual(output["result"].returncode, 0, output["result"].stderr)
        generated = [row for row in output["calls"] if row.get("kind") == "generate"]
        self.assertEqual(len(generated), 1)
        args = generated[0]["args"]
        self.assertEqual(args[args.index("--output") + 1],
                         str(Path(output["result"].args[1]).parents[2] / "runtime"))

    def test_explicit_domain_fourth_turn_avoids_global_best_of_root(self):
        output = self._run_scenario(domain="svg", turns=4)
        self.assertEqual(output["result"].returncode, 0,
                         output["result"].stderr + output["log"] + output["failures"])
        generated = [row for row in output["calls"] if row.get("kind") == "generate"]
        self.assertEqual(len(generated), 4)
        self.assertTrue(all("--output" in row["args"] for row in generated))
        self.assertFalse(any("best-of" in row["args"] for row in output["calls"]))

    def test_explicit_domain_rotates_prompts_and_controls_across_waves(self):
        output = self._run_scenario(domain="svg", waves=2, art_cursor_start=6)
        self.assertEqual(output["result"].returncode, 0,
                         output["result"].stderr + output["log"] + output["failures"])
        generated = [row for row in output["calls"] if row.get("kind") == "generate"]
        self.assertEqual(len(generated), 2)
        self.assertNotEqual(generated[0]["args"][-1].split(" — rendered ")[0],
                            generated[1]["args"][-1].split(" — rendered ")[0])
        contexts = [row for row in output["rows"]
                    if row.get("event_type") == "generation_context"]
        self.assertEqual([(row["turn"], row["arm"], row["ctrl"]) for row in contexts],
                         [(7, "active", ""), (8, "control", "control")])
        records = [call for call in output["bandit_calls"] if call[0] == "record"]
        self.assertEqual([(call[1], call[4], call[5]) for call in records],
                         [("7", "active", ""), ("8", "control", "control")])

    def test_invalid_explicit_domain_fails_before_generation(self):
        output = self._run_scenario(domain="not-a-domain")
        self.assertEqual(output["result"].returncode, 2)
        self.assertFalse(any(row.get("kind") == "generate" for row in output["calls"]))

    def test_balanced_worker_keeps_learning_arm_cadence_across_one_turn_waves(self):
        output = self._run_scenario(worker="fixture", waves=4, art_cursor_start=6,
                                    staged_lessons=True)
        self.assertEqual(output["result"].returncode, 0, output["log"])
        contexts = [row for row in output["rows"]
                    if row.get("event_type") == "generation_context"]
        self.assertEqual([(row["turn"], row["arm"], row["ctrl"]) for row in contexts],
                         [(7, "active", ""), (8, "control", "control"),
                          (9, "active", ""), (10, "staged", "")])
        records = [call for call in output["bandit_calls"] if call[0] == "record"]
        self.assertEqual([call[1] for call in records], ["7", "8", "9", "10"])
        receipts = [json.loads(line) for line in output["receipt"].splitlines()]
        self.assertEqual([row["turn"] for row in receipts], [1, 1, 1, 1])

    def test_retry_uses_only_current_attempt_validation_feedback(self):
        stale = self._run_scenario(generation_failure="stale", rotate_mode="retry")
        prompts = [row["args"][-1] for row in stale["calls"]
                   if row.get("kind") == "generate"]
        self.assertEqual(len(prompts), 2)
        self.assertNotIn("historical-check", prompts[1])
        self.assertIn("variation retry", prompts[1])

        fresh = self._run_scenario(generation_failure="fresh", rotate_mode="retry")
        prompts = [row["args"][-1] for row in fresh["calls"]
                   if row.get("kind") == "generate"]
        self.assertEqual(len(prompts), 2)
        self.assertIn("current-check", prompts[1])
        self.assertNotIn("historical-check", prompts[1])

    def test_score_age_ignores_invalid_or_future_rows(self):
        from datetime import datetime, timezone, timedelta
        function = SOURCE.read_text().split('scored_age_secs() {', 1)[1].split('\n}', 1)[0]
        command = 'scored_age_secs() {' + function + '\n}\nscored_age_secs'
        now = datetime.now(timezone.utc)
        valid = {"event_type": "artifact_scored", "artifact": "artifacts/valid",
                 "axes": "D=0 A=10 R=5 N=5", "judges": ["judge-a", "judge-b"],
                 "ts": now.isoformat()}
        old = {**valid, "ts": (now - timedelta(seconds=120)).isoformat()}
        invalid = [None, {**valid, "axes": "D=NaN A=10 R=5 N=5"},
                   {**valid, "axes": "D=11 A=10 R=5 N=5"},
                   {**valid, "axes": "D=1 D=2 A=10 R=5 N=5"},
                   {**valid, "judges": ["judge-a"]},
                   {**valid, "judges": ["judge-a", " judge-a "]},
                   {**valid, "artifact": 7}, {**valid, "event_type": "generation_started"},
                   {**valid, "ts": now.replace(tzinfo=None).isoformat()},
                   {**valid, "ts": (now + timedelta(hours=1)).isoformat()}]
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            trend = root / '.omx/atelier/lessons/trend.jsonl'
            trend.parent.mkdir(parents=True)
            environment = {**os.environ, "RUN_STARTED": str(now.timestamp() - 3600)}
            for candidate in [*invalid, valid]:
                with self.subTest(candidate=candidate):
                    trend.write_text(json.dumps(old) + '\n' + json.dumps(candidate) + '\n')
                    result = subprocess.run(['bash', '-c', command], cwd=root, env=environment,
                                            capture_output=True, text=True, timeout=5)
                    self.assertEqual(result.returncode, 0, result.stderr)
                    age = int(result.stdout.strip())
                    if candidate == valid:
                        self.assertTrue(0 <= age <= 5, age)
                    else:
                        self.assertTrue(115 <= age <= 125, age)

    def test_refinement_does_not_leak_into_following_turn(self):
        output = self._run_scenario(turns=5, refinement=True)
        self.assertEqual(output["result"].returncode, 0,
                         output["result"].stderr + output["log"] + output["failures"])
        generated = [row for row in output["calls"] if row.get("kind") == "generate"]
        self.assertGreaterEqual(len(generated), 5)
        self.assertEqual(generated[3]["domain"], "three")
        self.assertEqual(generated[4]["domain"], "hydra")


if __name__ == "__main__":
    if sys.argv[1:] == ["--list-tests"]:
        pending = list(unittest.defaultTestLoader.loadTestsFromModule(sys.modules[__name__]))
        names = []
        while pending:
            test = pending.pop(0)
            if isinstance(test, unittest.TestSuite):
                pending[0:0] = list(test)
            else:
                names.append(test.id().removeprefix("__main__."))
        print(json.dumps(names))
    else:
        unittest.main()
