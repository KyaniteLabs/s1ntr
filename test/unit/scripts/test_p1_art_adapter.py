import importlib.util
import hashlib
import io
import json
import os
import sys
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path
from unittest.mock import patch

MODULE = Path(__file__).resolve().parents[3] / "scripts" / "p1-art-adapter.py"
SPEC = importlib.util.spec_from_file_location("p1_art_adapter_test", MODULE)
ADAPTER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(ADAPTER)
INTAKE_PATH = MODULE.with_name("p1-art-intake.py")
INTAKE_SPEC = importlib.util.spec_from_file_location("p1_art_intake_test", INTAKE_PATH)
INTAKE = importlib.util.module_from_spec(INTAKE_SPEC)
INTAKE_SPEC.loader.exec_module(INTAKE)


class P1ProductAdapterTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        os.environ["S1NTR_PRODUCT_SCRATCH"] = self.temp.name
        ADAPTER._CREATED.clear()

    def tearDown(self):
        os.environ.pop("S1NTR_PRODUCT_SCRATCH", None)
        self.temp.cleanup()

    def test_schema_and_render_bind_actor_to_single_art_tool(self):
        schema = ADAPTER.tools()
        self.assertEqual([x["function"]["name"] for x in schema], ["submit_svg"])
        self.assertIn("Create a blue kinetic sculpture", ADAPTER.render({
            "prompt": "Create a blue kinetic sculpture"}))

    def test_rejects_script_and_external_resource_svg(self):
        for source in ('<svg><script>alert(1)</script></svg>',
                       '<svg><image href="https://example.test/a.png"/></svg>'):
            with self.assertRaises(ValueError):
                ADAPTER._safe_svg(source)

    def test_empty_episode_fails_closed_without_fake_score(self):
        result = ADAPTER.score({}, [], [], [])
        self.assertEqual(result["verdict"], "FAIL")
        self.assertEqual(result["axes"]["render_success"], 0.0)

    def test_native_actor_text_labels_and_metadata_are_allowed(self):
        source = ('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 400">'
                  '<title>Warm Overlap</title><desc>Three geometric layers</desc>'
                  '<text x="200" y="35" text-anchor="middle" '
                  'font-family="sans-serif" font-size="24" font-weight="bold" '
                  'fill="#e08e3a">Warm <tspan dx="2" dy="0">Overlap</tspan></text>'
                  '<circle cx="200" cy="200" r="90" fill="#e08e3a"/></svg>')
        result = ADAPTER.execute_tool("submit_svg", json.dumps({
            "title": "Warm Overlap", "svg": source}))
        self.assertEqual(Path(result["artifact"]).read_text(), source)
        self.assertIn("text/tspan", ADAPTER.render({}))

    def test_text_support_keeps_active_attributes_and_urls_forbidden(self):
        for source in ('<svg><text onclick="alert(1)">x</text></svg>',
                       '<svg><text style="fill:red">x</text></svg>',
                       '<svg><text fill="url(https://example.test/x)">x</text></svg>',
                       '<svg><animate attributeName="href" to="javascript:x"/></svg>'):
            with self.subTest(source=source), self.assertRaises(ValueError):
                ADAPTER._safe_svg(source)

    def test_submit_persists_sanitized_svg_and_trace_in_product_scratch(self):
        source = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10">' \
            '<circle cx="5" cy="5" r="4" fill="#123456"/></svg>'
        result = ADAPTER.execute_tool("submit_svg", json.dumps({
            "title": "Blue sphere", "svg": source}))
        artifact = Path(result["artifact"])
        self.assertTrue(artifact.is_relative_to(Path(self.temp.name).resolve()))
        self.assertEqual(artifact.read_text(), source)
        self.assertEqual(len(result["sha256"]), 64)
        self.assertTrue((artifact.parent / "product-trace.jsonl").is_file())
        self.assertEqual(len(ADAPTER.artifact_files()), 2)

    def test_tool_rejects_unknown_names_and_extra_arguments(self):
        for name, args in (("run_shell", "{}"), ("submit_svg", '{"path":"/tmp"}')):
            with self.assertRaises(ValueError):
                ADAPTER.execute_tool(name, args)
        self.assertEqual(ADAPTER.artifact_files(), [])

    def test_persistent_one_paths_are_never_product_scratch(self):
        forbidden = Path(self.temp.name) / "persistent-1"
        os.environ["S1NTR_PRODUCT_SCRATCH"] = str(forbidden)
        with self.assertRaisesRegex(ValueError, "outside the Persistent-1 tree"):
            ADAPTER.execute_tool("submit_svg", json.dumps({
                "title": "Rejected", "svg": "<svg/>"}))

    def test_score_rejects_artifacts_not_bound_to_tool_receipt(self):
        artifact = ADAPTER.execute_tool("submit_svg", json.dumps({
            "title": "Blue sphere", "svg": "<svg/>"}))
        result = ADAPTER.score({}, [], [{"function": {"name": "submit_svg"}}],
                               [{**artifact, "sha256": "0" * 64}])
        self.assertEqual(result["verdict"], "FAIL")
        self.assertIn("does not match", result["notes"])

    def test_native_close_mapping_preserves_owner_outcome_and_pixel_review(self):
        owner = self._owner_close()
        mapped = ADAPTER.map_scorer_to_native_close(
            {"verdict": "NEEDS_REVIEW", "axes": {"visual_score": 0.8},
             "notes": "pixel-only"}, owner,
            {"attempt_id": "p1a-first", "decision_open_sha256": "c" * 64,
             "state": "call_started"}, "b" * 64)
        self.assertEqual(set(mapped["close"]), ADAPTER._NATIVE_CLOSE_FIELDS)
        self.assertEqual(mapped["close"]["success"], owner["success"])
        self.assertEqual(mapped["close"]["reward"], owner["reward"])
        self.assertEqual(mapped["close"]["evaluator_output"]["independent_judge"],
                         owner["evaluator_output"]["independent_judge"])
        self.assertEqual(mapped["close"]["evaluator_output"]["product_pixel_scorer"]["verdict"],
                         "NEEDS_REVIEW")

    def test_each_retry_mapping_requires_its_own_begun_attempt(self):
        scorer = {"verdict": "PASS", "axes": {"visual_score": 0.9}}
        mappings = [ADAPTER.map_scorer_to_native_close(
            scorer, self._owner_close(),
            {"attempt_id": f"p1a-{n}", "decision_open_sha256": str(n) * 64,
             "state": "call_started"}, "b" * 64) for n in (1, 2)]
        self.assertNotEqual(mappings[0]["attempt_id"], mappings[1]["attempt_id"])
        self.assertNotEqual(mappings[0]["decision_open_sha256"],
                            mappings[1]["decision_open_sha256"])

    def test_native_close_mapping_rejects_incomplete_owner_or_attempt(self):
        scorer = {"verdict": "FAIL", "axes": {"visual_score": 0.0}}
        owner = self._owner_close()
        owner["cost"]["complete"] = False
        with self.assertRaisesRegex(ValueError, "complete finite aggregate cost"):
            ADAPTER.map_scorer_to_native_close(scorer, owner,
                {"attempt_id": "p1a", "decision_open_sha256": "c" * 64,
                 "state": "call_started"}, "b" * 64)
        owner = self._owner_close()
        with self.assertRaisesRegex(ValueError, "call_started"):
            ADAPTER.map_scorer_to_native_close(scorer, owner,
                {"attempt_id": "p1a", "decision_open_sha256": "c" * 64,
                 "state": "attempt_open"}, "b" * 64)

    def test_native_close_mapping_rejects_nested_nonfinite_values(self):
        scorer = {"verdict": "PASS", "axes": {"visual": 0.9}}
        for field, nested, value in (
                ("evaluator_output", "independent_judge", float("nan")),
                ("resulting_observation", "render_quality", float("inf"))):
            owner = self._owner_close()
            owner[field][nested] = value
            with self.subTest(field=field), self.assertRaisesRegex(ValueError, "strict JSON"):
                ADAPTER.map_scorer_to_native_close(scorer, owner,
                    {"attempt_id": "p1a", "decision_open_sha256": "c" * 64,
                     "state": "call_started"}, "b" * 64)

    def test_preflight_cli_close_preparation_uses_pinned_product_identity(self):
        with tempfile.TemporaryDirectory() as directory:
            paths = {name: Path(directory) / name for name in
                     ("harness", "intake", "renderer")}
            for path in paths.values():
                path.write_text("fixture source")
            paths["adapter"] = MODULE
            pins = {name: hashlib.sha256(path.read_bytes()).hexdigest()
                    for name, path in paths.items()}
            context_path = Path(directory) / "close.json"
            owner_close = self._owner_close()
            context_path.write_text(json.dumps({
                "scorer_result": {"verdict": "NEEDS_REVIEW", "axes": {"visual": 0.4}},
                "owner_close": owner_close,
                "attempt": {"attempt_id": "p1a", "decision_open_sha256": "c" * 64,
                            "state": "call_started"}}))
            task_path = Path(directory) / "task.json"
            pins_path = Path(directory) / "pins.json"
            task_path.write_text(json.dumps({"task_id": "t", "prompt": "art", "seed": 1}))
            pins_path.write_text(json.dumps(pins))
            argv = [str(INTAKE_PATH), "--task", str(task_path), "--pins", str(pins_path),
                    "--prepare-close", str(context_path)]
            for name, path in paths.items():
                argv.extend([f"--{name}", str(path)])
            output = io.StringIO()
            with patch.object(sys, "argv", argv), redirect_stdout(output):
                INTAKE.main()
            result = json.loads(output.getvalue())
            prepared = result["native_close_preparation"]
        self.assertEqual(prepared["close"]["evaluator_output"]["product_pixel_scorer"]
                         ["evaluator_identity_sha256"],
                         result["product_evaluator_identity_sha256"])
        for field in ("resulting_observation", "branch_state", "reward", "success",
                      "failure_class", "terminal", "evaluator_identity_sha256", "cost"):
            self.assertEqual(prepared["close"][field], owner_close[field])

    def test_preflight_cli_rejects_nonstandard_and_invalid_close_json(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            paths = {name: root / name for name in ("harness", "intake", "renderer")}
            for path in paths.values():
                path.write_text("fixture source")
            paths["adapter"] = MODULE
            pins = {name: hashlib.sha256(path.read_bytes()).hexdigest()
                    for name, path in paths.items()}
            task_path, pins_path = root / "task.json", root / "pins.json"
            context_path = root / "close.json"
            task_path.write_text(json.dumps({"task_id": "t", "prompt": "art", "seed": 1}))
            pins_path.write_text(json.dumps(pins))
            argv = [str(INTAKE_PATH), "--task", str(task_path), "--pins", str(pins_path),
                    "--prepare-close", str(context_path)]
            for name, path in paths.items():
                argv.extend([f"--{name}", str(path)])
            for invalid in ('{"scorer_result":{"nested":NaN}}',
                            '{"owner_close":{"branch_state":[Infinity]}}', '{'):
                context_path.write_text(invalid)
                stdout, stderr = io.StringIO(), io.StringIO()
                with patch.object(sys, "argv", argv), redirect_stdout(stdout), \
                        redirect_stderr(stderr), self.assertRaises(SystemExit) as error:
                    INTAKE.main()
                self.assertEqual(error.exception.code, 2)
                self.assertEqual(stdout.getvalue(), "")
                self.assertIn("error:", stderr.getvalue())

    def test_preflight_cli_rejects_duplicate_owner_keys_without_output(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            paths = {name: root / name for name in ("harness", "intake", "renderer")}
            for path in paths.values():
                path.write_text("fixture source")
            paths["adapter"] = MODULE
            pins = {name: hashlib.sha256(path.read_bytes()).hexdigest()
                    for name, path in paths.items()}
            task_path, pins_path = root / "task.json", root / "pins.json"
            context_path = root / "close.json"
            task_path.write_text(json.dumps({"task_id": "t", "prompt": "art", "seed": 1}))
            pins_path.write_text(json.dumps(pins))
            argv = [str(INTAKE_PATH), "--task", str(task_path), "--pins", str(pins_path),
                    "--prepare-close", str(context_path)]
            for name, path in paths.items():
                argv.extend([f"--{name}", str(path)])
            invalid = (
                '{"scorer_result":{},"owner_close":{},"owner_close":{},"attempt":{}}',
                '{"scorer_result":{},"owner_close":{"success":false,"success":true},'
                '"attempt":{}}',
            )
            for encoded in invalid:
                context_path.write_text(encoded)
                stdout, stderr = io.StringIO(), io.StringIO()
                with patch.object(sys, "argv", argv), redirect_stdout(stdout), \
                        redirect_stderr(stderr), self.assertRaises(SystemExit) as error:
                    INTAKE.main()
                self.assertEqual(error.exception.code, 2)
                self.assertEqual(stdout.getvalue(), "")
                self.assertIn("duplicate JSON object key", stderr.getvalue())

    @staticmethod
    def _owner_close():
        return {"child_node_id": "child-1", "response": "submitted SVG",
                "resulting_observation": {"artifact_sha256": "d" * 64},
                "branch_state": {"branch": "product"}, "reward": 0.25,
                "success": False, "failure_class": "needs_independent_review",
                "terminal": True,
                "evaluator_output": {"independent_judge": {"receipt_sha256": "e" * 64}},
                "evaluator_identity_sha256": "a" * 64,
                "cost": {"value": 1.25, "unit": "elapsed_seconds", "complete": True}}


if __name__ == "__main__":
    unittest.main()
