"""Exercise the actual tournament branch with fake child transports; no providers."""
import json
from pathlib import Path
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]


class TournamentDomain(unittest.TestCase):
    def test_candidates_keep_requested_domain_when_scored(self):
        cli = (ROOT / "bin/sinter").read_text()
        branch = cli.split("else if (cmd === 'best-of') {", 1)[1]
        branch = branch.split("\nelse if (cmd === 'data')", 1)[0].rsplit("}", 1)[0]
        for domain in ["textgen", "ascii", "glsl", "strudel", "p5", None]:
            with self.subTest(domain=domain), tempfile.TemporaryDirectory() as directory:
                tmp = Path(directory)
                setup = """
import fs from 'node:fs'; import path from 'node:path';
import child from 'node:child_process'; import {syncBuiltinESMExports} from 'node:module';
const cmdArgs = ['2', 'Fixture composition']; const calls = []; let generated = 0;
child.execFileSync = (command, args, options) => {
  calls.push({args, noTrend: options.env.SINTER_NO_TREND_APPEND});
  if (args.includes('sss-score')) return '[sss] ensemble D=4 A=4 R=4 N=4';
  const dir = path.join(process.cwd(), 'candidate-' + ++generated);
  fs.mkdirSync(dir); fs.writeFileSync(path.join(dir, 'source.txt'), 'fixture');
  return 'Saved: ' + path.join(dir, 'source.txt');
}; syncBuiltinESMExports();
"""
                flags = {} if domain is None else {"domain": domain}
                runner = tmp / "runner.mjs"
                runner.write_text(setup + "\nconst flags = " + json.dumps(flags) + ";\n"
                                  + branch + "\nfs.writeFileSync('calls.json', JSON.stringify(calls));")
                result = subprocess.run(["node", str(runner)], cwd=tmp, capture_output=True, text=True)
                self.assertEqual(result.returncode, 0, result.stderr)
                calls = json.loads((tmp / "calls.json").read_text())
                self.assertEqual(len(calls), 4)
                for call in calls:
                    args = call["args"]
                    self.assertEqual(args[args.index("--domain") + 1] if "--domain" in args else None, domain)
                self.assertTrue(all(call.get("noTrend") == "1" for call in calls[2:]))
                self.assertTrue((tmp / ".omx/atelier/tournament-rejects/candidate-2/source.txt").is_file())


if __name__ == "__main__":
    unittest.main()
