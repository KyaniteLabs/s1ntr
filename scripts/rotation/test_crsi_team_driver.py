"""A private local repository, a fake scan and a fake rotation command."""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

DRIVER = Path(__file__).with_name("crsi_team_driver.py").resolve()


class Driver(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)
        self.repo = self.root / "repo"
        self.repo.mkdir()
        self.env = dict(os.environ, GIT_CONFIG_GLOBAL=os.devnull, GIT_CONFIG_NOSYSTEM="1",
                        GIT_AUTHOR_NAME="Fixture", GIT_COMMITTER_NAME="Fixture",
                        GIT_AUTHOR_EMAIL="fixture@invalid", GIT_COMMITTER_EMAIL="fixture@invalid")
        self.git("init", "-q")
        (self.repo / "battery.json").write_text('{"tasks":[]}')
        self.git("add", "battery.json")
        self.git("commit", "-qm", "fixture")
        self.git("branch", "integrated")
        self.initial = self.git("rev-parse", "HEAD")
        self.backlog = self.root / "backlog.md"
        self.backlog.write_text("- L1 open #1 | files: busy | test: first | claimed elsewhere\n"
                                "- L2 open #2 | files: piece | test: verify piece | sample\n"
                                "## Turn log\n")
        true = [sys.executable, "-c", "pass"]
        self.conf = dict(repository=str(self.repo), upstream="integrated", sync=true, build=true,
                         stateDir=str(self.root / "state"), backlog=str(self.backlog), battery="battery.json",
                         scan=[sys.executable, "-c", "print('- #8 | files: busy/file')"],
                         runner=[sys.executable, "-c", "import json,pathlib,sys; "
                                 "assert 'verify piece' in json.load(open('battery.json'))['tasks'][0]['brief']; "
                                 "pathlib.Path('piece').write_text('done'); "
                                 "(pathlib.Path(sys.argv[1])/'summary.json').write_text("
                                 "json.dumps({'mode':'live','metrics':{'n':1}}))", "{out}"], timeoutSeconds=10)
        self.config = self.root / "config.json"

    def git(self, *args):
        return subprocess.check_output(["git", *args], cwd=self.repo, env=self.env, text=True).strip()

    def run_driver(self):
        self.config.write_text(json.dumps(self.conf))
        return subprocess.run([sys.executable, DRIVER, self.config], env=self.env, text=True,
                              capture_output=True, timeout=15)

    def test_keeps_built_candidate_and_releases_trial(self):
        deps = self.root / "dependencies"
        deps.mkdir()
        self.conf["dependencyDir"] = str(deps)
        result = self.run_driver()
        self.assertEqual(result.returncode, 0, result.stderr)
        state = json.loads((self.root / "state/state.json").read_text())
        candidate = state["turns"][0]["candidate"]
        self.assertEqual(self.git("show", candidate + ":piece"), "done")
        self.assertEqual(self.git("show", candidate + ":battery.json"), '{"tasks":[]}')
        self.assertIn("L2 candidate:", self.backlog.read_text())
        self.assertIn("L1 open", self.backlog.read_text())
        self.assertEqual(self.git("rev-parse", "HEAD"), self.initial)
        self.assertEqual(self.git("status", "--porcelain"), "")
        self.assertEqual(self.git("worktree", "list", "--porcelain").count("worktree "), 1)

    def test_failed_sync_scan_build_and_runner_cannot_land(self):
        for key in ("sync", "scan", "build", "runner"):
            with self.subTest(key=key):
                previous = self.conf[key]
                self.conf[key] = [sys.executable, "-c", "raise SystemExit(7)", "{out}"]
                result = self.run_driver()
                self.assertEqual(result.returncode, 2, result.stderr)
                self.assertIn(key, result.stderr)
                self.assertIn("L2 open", self.backlog.read_text())
                self.assertEqual(self.git("rev-parse", "HEAD"), self.initial)
                self.conf[key] = previous

    def test_incomplete_scan_cannot_claim_an_item(self):
        for scan in ("", "scan unavailable", "- #9 | files: "):
            with self.subTest(scan=scan):
                self.conf["scan"] = [sys.executable, "-c", f"print({scan!r})"]
                result = self.run_driver()
                self.assertEqual(result.returncode, 2, result.stderr)
                self.assertIn("scan", result.stderr)
                self.assertFalse((self.root / "state/state.json").exists())
                self.assertIn("L1 open", self.backlog.read_text())

    def test_zero_exit_without_summary_is_infrastructure_failure(self):
        self.conf["runner"] = [sys.executable, "-c", "open('piece', 'w').close()", "{out}"]
        result = self.run_driver()
        self.assertEqual(result.returncode, 2)
        self.assertIn("summary", result.stderr)
        self.assertIn("L2 open", self.backlog.read_text())

    def test_exhausted_item_stays_open_without_another_turn(self):
        self.conf.update(maxAttempts=1, runner=[sys.executable, "-c", "raise SystemExit(1)", "{out}"])
        self.assertEqual(self.run_driver().returncode, 2)
        self.assertIn("runner failed", (self.root / "state/last-stop.json").read_text())
        self.assertEqual(self.run_driver().returncode, 0)
        state = json.loads((self.root / "state/state.json").read_text())
        self.assertEqual(state["attempts"], {"L2": 1})
        self.assertIn("L2 open", self.backlog.read_text())

    def test_merge_conflict_preserves_both_refs(self):
        self.git("switch", "integrated")
        (self.repo / "battery.json").write_text('{"upstream":true}')
        self.git("commit", "-qam", "upstream")
        self.git("switch", "-")
        (self.repo / "battery.json").write_text('{"local":true}')
        self.git("commit", "-qam", "local")
        before = self.git("rev-parse", "HEAD", "integrated")
        result = self.run_driver()
        self.assertEqual(result.returncode, 2)
        self.assertIn("merge", result.stderr)
        self.assertEqual(self.git("rev-parse", "HEAD", "integrated"), before)
        self.assertEqual(self.git("status", "--porcelain"), "")

    def test_dirty_or_overlapping_work_is_preserved(self):
        (self.repo / "private").write_text("pending")
        result = self.run_driver()
        self.assertEqual(result.returncode, 2)
        self.assertIn("dirty", result.stderr)
        self.assertEqual((self.repo / "private").read_text(), "pending")
        self.assertIn("L2 open", self.backlog.read_text())

    def test_runner_edits_outside_item_are_refused(self):
        self.conf["runner"][2] = self.conf["runner"][2].replace("Path('piece')", "Path('unrelated')")
        result = self.run_driver()
        self.assertEqual(result.returncode, 2)
        self.assertIn("unrelated", result.stderr)
        self.assertIn("L2 open", self.backlog.read_text())


if __name__ == "__main__":
    unittest.main()
