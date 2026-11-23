"""The offline training archive must serve each artifact's local runtime."""
import importlib.util
from pathlib import Path
import tempfile
import unittest


SCRIPT = Path(__file__).resolve().parents[3] / "scripts/atelier/rebuild-training-dashboard.py"
spec = importlib.util.spec_from_file_location("rebuild_training_dashboard", SCRIPT)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class VendorAssetsTest(unittest.TestCase):
    def test_copies_nested_playback_asset(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            asset = root / "source/vendor/strudel-web/1.3.0/strudel-web.js"
            asset.parent.mkdir(parents=True)
            asset.write_text("window.strudel = {};", encoding="utf-8")
            module.export_vendor_assets(root / "source", root / "out")
            self.assertEqual((root / "out/vendor/strudel-web/1.3.0/strudel-web.js").read_bytes(), asset.read_bytes())

    def test_fails_when_vendor_assets_are_missing(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            with self.assertRaises(FileNotFoundError):
                module.export_vendor_assets(root / "source", root / "out")


if __name__ == "__main__":
    unittest.main()
