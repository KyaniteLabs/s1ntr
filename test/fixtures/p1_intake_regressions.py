"""Pre-import identity checks must not execute native or adapter source."""
import hashlib
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location("product_intake", ROOT / "scripts/p1-art-intake.py")
intake = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(intake)


class IntakeTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.paths, self.pins = {}, {}
        for name in intake.SOURCE_NAMES:
            path = Path(self.temp.name) / (name + ".py")
            path.write_text("raise RuntimeError('source must never be imported')\n")
            self.paths[name] = path
            self.pins[name] = hashlib.sha256(path.read_bytes()).hexdigest()
        self.task = {"task_id": "art-1", "prompt": "Create kinetic art", "seed": 17}

    def test_preflight_does_not_import_sources(self):
        result = intake.preflight(self.task, self.paths, self.pins)
        self.assertEqual(result["family"], "s1ntr_art_dev")
        self.assertEqual(result["independent_acceptance"], "not_performed")
        self.assertEqual(len(result["actor_identity_sha256"]), 64)

    def test_source_change_is_rejected_before_import(self):
        self.paths["adapter"].write_text("raise RuntimeError('tampered')\n")
        with self.assertRaisesRegex(ValueError, "differs"):
            intake.preflight(self.task, self.paths, self.pins)

    def test_published_product_pins_accept_the_shipped_sources(self):
        pins = json.loads((ROOT / "docs/p1-art-chamber/native-product-pins-20260930.json").read_text())
        paths = {**self.paths, "adapter": ROOT / "scripts/p1-art-adapter.py",
                 "renderer": ROOT / "scripts/p1-art-render-score.mjs"}
        # Native source is owner-held; use inert fixtures for that half of the closure.
        pins.update({name: self.pins[name] for name in ("harness", "intake")})
        result = intake.preflight(self.task, paths, pins)
        self.assertEqual(result["source_sha256"]["adapter"], pins["adapter"])
        self.assertEqual(result["native_recorder_commit"], "not_performed")

    def test_boolean_seed_is_rejected(self):
        with self.assertRaisesRegex(ValueError, "not a boolean"):
            intake.validate_task({**self.task, "seed": True})

    def test_foreign_study_field_is_rejected(self):
        with self.assertRaisesRegex(ValueError, "only development"):
            intake.validate_task({**self.task, "study_id": "frozen"})

    def test_cli_checks_full_closure_and_emits_typed_provenance(self):
        root = Path(self.temp.name)
        (root / "task.json").write_text(json.dumps(self.task))
        (root / "pins.json").write_text(json.dumps(self.pins))
        command = [sys.executable, str(ROOT / "scripts/p1-art-intake.py"),
                   "--task", str(root / "task.json"), "--pins", str(root / "pins.json")]
        for name, path in self.paths.items():
            command.extend([f"--{name}", str(path)])
        result = subprocess.run(command, capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout)["native_recorder_commit"], "not_performed")

    def test_missing_source_pin_rejected(self):
        del self.pins["harness"]
        with self.assertRaisesRegex(ValueError, "source closure"):
            intake.preflight(self.task, self.paths, self.pins)

    def test_actor_identity_binds_current_intake(self):
        old = intake.preflight(self.task, self.paths, self.pins)
        self.paths["intake"].write_text("raise RuntimeError('new intake')\n")
        self.pins["intake"] = hashlib.sha256(self.paths["intake"].read_bytes()).hexdigest()
        new = intake.preflight(self.task, self.paths, self.pins)
        self.assertNotEqual(old["actor_identity_sha256"], new["actor_identity_sha256"])


if __name__ == "__main__":
    unittest.main()
