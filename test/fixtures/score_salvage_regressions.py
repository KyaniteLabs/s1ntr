"""Exercise the real salvage runner with an isolated artifact store and scorer."""
import json
from pathlib import Path
import subprocess
import tempfile
import unittest

SCRIPT = Path(__file__).resolve().parents[2] / "scripts/atelier/score-salvage.mjs"


class SalvageScoring(unittest.TestCase):
    def test_failed_and_empty_scores_remain_retryable(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            pool = root / ".omx/atelier/rescue-pool"
            pool.mkdir(parents=True)
            (root / "dist/utils").mkdir(parents=True)
            (root / "bin").mkdir()
            (root / "package.json").write_text('{"type":"module"}')
            (root / "dist/utils/htmlWrapper.js").write_text(
                'export const HTMLWrapper={wrap:code=>"<html>"+code+"</html>"};')
            (pool / "recover.js").write_text("function setup() { createCanvas(40,40); }")
            lineage = '{"originalFailure":{"id":"original"},"recovery":{"repairModel":null}}'
            (pool / "recover.lineage.json").write_text(lineage)
            runner = ("import os from 'node:os';"
                      "import {syncBuiltinESMExports} from 'node:module';"
                      f"os.homedir=()=>{json.dumps(temp)};syncBuiltinESMExports();"
                      f"await import({json.dumps(SCRIPT.as_uri())});")
            for scorer, complete in [("process.exit(1)", False),
                                     ("console.log('blank guard')", False),
                                     ("console.log('[sss] ensemble D=1 A=1 R=1 N=1')", True)]:
                (root / "bin/sinter").write_text(scorer)
                result = subprocess.run(["node", "--input-type=module", "-e", runner],
                                        cwd=root, capture_output=True, text=True)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual((pool / "recover.js").exists(), not complete)
                self.assertEqual((pool / ".scored/recover.js").exists(), complete)
                self.assertIn(f"batch complete: {int(complete)} scored", result.stdout)
                self.assertEqual((root / ".sinter/output/artifacts/rescue-recover/lineage.json").read_text(), lineage)


if __name__ == "__main__":
    unittest.main()
