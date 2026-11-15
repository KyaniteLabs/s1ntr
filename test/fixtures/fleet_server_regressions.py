"""Regression scenarios for the fleet collector; isolated files and loopback HTTP."""
import importlib.util
import json
import os
import shutil
import socket
from pathlib import Path
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import call, patch
from urllib.request import Request, urlopen
from urllib.error import HTTPError

sys.dont_write_bytecode = True
SOURCE = Path(__file__).resolve().parents[2] / "scripts/atelier/fleet-server.py"
SPEC = importlib.util.spec_from_file_location("fleet_server", SOURCE)
fleet = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(fleet)
SYNC_HISTORY = fleet.sync_history

QUALITY_MARKERS = {"scoreScale": 10, "scoringContract": fleet.SCORE_CONTRACT}
QUALITY_FIELDS = {"judges": ["judge-one", "judge-two"], **QUALITY_MARKERS}


class FleetRegression(unittest.TestCase):
    def test_history_transfers_overlap_only_distinct_destinations(self):
        guard = threading.Lock()
        active = set()
        observed = []
        peak = 0
        def sync(host, name, *args, **kwargs):
            nonlocal peak
            key = fleet.history_key(name)
            with guard:
                self.assertNotIn(key, active)
                active.add(key)
                peak = max(peak, len(active))
                observed.append(name)
            time.sleep(0.08)
            with guard:
                active.remove(key)
            return {"name": name, "errors": {"scorecards": "transfer_failed"}}
        sources = [(name, None) for name in ("A B", "A_B", "C", "D", "E", "XPS")]
        with patch.object(fleet, "MACHINES", sources), \
             patch.object(fleet, "art_feeds", return_value=[]), \
             patch.object(fleet, "sync_history", side_effect=sync), \
             patch.dict(os.environ, {"SINTER_HISTORY_NUCBOX_HOSTSPEC": "", "SINTER_NUCBOX_HOSTSPEC": ""}):
            payload = fleet.refresh_history_once()
        self.assertEqual(peak, 3)
        self.assertCountEqual(observed, ["A B", "A_B", "C", "D", "E"])
        self.assertEqual(payload["sources"]["A_B"]["name"], "A_B")
        self.assertTrue(all(status["errors"]["scorecards"] == "transfer_failed"
                            for status in payload["sources"].values()))

    def test_domain_correction_preserves_history_but_excludes_false_gain(self):
        atelier = self.root / ".omx/atelier"
        (atelier / "lessons").mkdir(parents=True)
        artifact = "/tmp/artifacts/art-one/playable.html"
        scored = {"event_type": "artifact_scored", "artifact": artifact,
                  "scorecard": "score-one.json", "domain": "hyperframes",
                  "axes": "D=6 A=6 R=6 N=6", **QUALITY_FIELDS}
        correction = {"event_type": "artifact_score_corrected", "artifact": artifact,
                      "scorecard": "score-one.json", "reason": "domain_mismatch",
                      "eligible_for_domain_gain": False, "provenance_domain": "ascii"}
        (atelier / "lessons/trend.jsonl").write_text(
            json.dumps(scored) + "\n" + json.dumps(correction) + "\n")
        source = fleet.history_root() / "XPS/scorecards"
        source.mkdir(parents=True)
        (source / "score-one.json").write_text(json.dumps({
            "artifact": artifact, "domain": "hyperframes", **QUALITY_FIELDS}))
        with patch.object(fleet, "MACHINES", [("Laptop (Air)", None)]), \
             patch.object(fleet, "CACHE", self.root / "cache"), \
             patch.object(fleet, "load_retired_machines", return_value=[]):
            snapshot = fleet.refresher(once=True)
        self.assertEqual(snapshot["totalScored"], 0)
        merged = [json.loads(line) for line in
                  (atelier / "fleet/merged/trend.jsonl").read_text().splitlines()]
        corrected = next(row for row in merged if row.get("event_type") == "artifact_scored")
        self.assertEqual(corrected["domain"], "ascii")
        self.assertEqual(corrected["scoringContract"], "domain-mismatch")
        projected = fleet.history_payload()["scorecards"][0]["record"]
        self.assertEqual(projected["domain"], "ascii")
        self.assertEqual(projected["scoringContract"], "domain-mismatch")
        self.assertEqual(projected["correction"], "domain_mismatch")

    def test_explicit_art_feed_keeps_live_score_and_history(self):
        worker = self.root / "worker"
        artifacts = self.root / "worker-runtime/artifacts"
        atelier = worker / ".omx/atelier"
        for family in ("lessons", "scorecards", "second-judge", "third-judge", "tournament-rejects"):
            (atelier / family).mkdir(parents=True)
        art = artifacts / "art-one"
        art.mkdir(parents=True)
        (art / "playable.html").write_text("<html>art</html>")
        pair, op = "a" * 64, "b" * 64
        paired_root = self.root / "legacy-worker-runtime/paired"
        paired_art = paired_root / pair / "active/turn-190/artifacts" / op
        paired_art.mkdir(parents=True)
        for filename in ("playable.html", "source.txt", "provenance.txt"):
            (paired_art / filename).write_text("<html>paired</html>")
        (atelier / "scorecards/score-one.json").write_text(json.dumps({"artifact": "art-one"}))
        row = {"event_type": "artifact_scored", "artifact": str(art / "playable.html"), "domain": "html",
               "axes": "D=6 A=6 R=6 N=6", **QUALITY_FIELDS}
        paired_row = {**row, "artifact": str(paired_art / "playable.html")}
        inherited = {**row, "artifact": "/other/artifacts/old/playable.html"}
        (atelier / "lessons/trend.jsonl").write_text(
            "\n".join(map(json.dumps, (inherited, row, paired_row))) + "\n")
        feed = {"name": "HTML ART", "hostspec": None, "root": str(worker),
                "artifacts": str(artifacts), "worker": "PMA2", "paired": str(paired_root)}
        other_artifacts = self.root / "worker-runtime-two/artifacts"
        other_art = other_artifacts / "art-two"
        other_art.mkdir(parents=True)
        (other_art / "playable.html").write_text("<html>new art</html>")
        other_feed = {**feed, "name": "ASCII ART", "artifacts": str(other_artifacts), "worker": "PMM5"}
        other_feed.pop("paired")
        def copy_local_fixture(command, **kwargs):
            # This scenario tests feed selection and retained content. Transfer
            # failure/containment have separate cases; CI need not install rsync.
            self.assertEqual(command[0], "rsync")
            source, target = map(Path, command[-2:])
            self.assertTrue(source.is_relative_to(self.root))
            self.assertTrue(target.is_relative_to(self.root))
            shutil.copytree(source, target, dirs_exist_ok=True)
            return type("TransferResult", (), {"returncode": 0})()
        with patch.dict(os.environ, {"SINTER_ART_FEEDS_JSON": json.dumps([feed, other_feed])}), \
             patch.object(fleet, "MACHINES", []), patch.object(fleet, "CACHE", self.root / "cache"), \
             patch.object(fleet, "load_retired_machines", return_value=[]):
            snapshot = fleet.refresher(once=True)
            with patch.object(fleet, "sync_history", SYNC_HISTORY), \
                 patch.object(fleet.subprocess, "run", side_effect=copy_local_fixture):
                history = fleet.refresh_history_once()
        self.assertEqual(snapshot["totalScored"], 2)
        self.assertFalse(history["sources"]["HTML_ART"]["errors"])
        archived = self.root / ".omx/atelier/fleet/archive/HTML_ART"
        self.assertTrue((archived / "scorecards/score-one.json").is_file())
        self.assertTrue((archived / "artifacts/art-one/playable.html").is_file())
        self.assertTrue((archived / f"paired-artifacts/{pair}/active/turn-190/artifacts/{op}/playable.html").is_file())
        self.assertEqual(len(history["scorecards"]), 1)
        other_archive = self.root / ".omx/atelier/fleet/archive/ASCII_ART"
        self.assertTrue((other_archive / "artifacts/art-two/playable.html").is_file())
        self.assertFalse((other_archive / "scorecards/score-one.json").exists())

    def test_one_shot_collection_retains_prior_scored_rows_without_remote_push(self):
        atelier = self.root / ".omx/atelier"
        merged = atelier / "fleet/merged/trend.jsonl"
        merged.parent.mkdir(parents=True)
        old = {"event_type": "artifact_scored", "artifact": "old-art", "domain": "p5", **QUALITY_FIELDS}
        new = {"event_type": "artifact_scored", "artifact": "new-art", "domain": "hydra", **QUALITY_FIELDS}
        merged.write_text(json.dumps(old) + "\n")
        lessons = atelier / "lessons/trend.jsonl"
        lessons.parent.mkdir(parents=True)
        lessons.write_text(json.dumps(new) + "\n")
        with patch.object(fleet, "MACHINES", [("Laptop (Air)", None)]), \
             patch.object(fleet, "CACHE", self.root / "cache"), \
             patch.object(fleet, "load_retired_machines", return_value=[]), \
             patch.object(fleet, "push_trend") as push:
            result = fleet.refresher(once=True)
        push.assert_not_called()
        self.assertEqual(result["totalScored"], 2)
        self.assertEqual(len(merged.read_text().splitlines()), 2)

    def test_recovered_text_requires_exact_original_and_preview_bytes(self):
        import hashlib
        ident = 'a' * 64
        art = self.root / 'home/.sinter/output/artifacts' / ident
        art.mkdir(parents=True)
        (art / 'source.txt').write_text(' original text\n')
        (art / 'playable.html').write_text('<script>invalid original</script>')
        preview = self.root / '.omx/atelier/reconstructed-text' / (ident + '.html')
        preview.parent.mkdir(parents=True)
        preview.write_text('<pre> original text\n</pre>')
        index = self.root / 'docs/agents/text-preview-index.json'
        index.parent.mkdir(parents=True)
        sha = lambda p: hashlib.sha256(p.read_bytes()).hexdigest()
        index.write_text(json.dumps({ident: {'source': sha(art / 'source.txt'),
            'original': sha(art / 'playable.html'), 'preview': sha(preview)}}))
        self.assertEqual(fleet.recovered_text_preview(ident), preview)
        self.assertIsNone(fleet.recovered_text_preview('b' * 64))
        server = fleet.HTTPServer(('127.0.0.1', 0), fleet.Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            base = f'http://127.0.0.1:{server.server_port}'
            self.assertEqual(self.request(base + f'/art/{ident}/recovered-text.html')[2], preview.read_bytes())
            self.assertEqual(self.request(base + f'/art/{ident}/recovered-text.html')[1].get('Cache-Control'), 'no-store')
            self.assertEqual(self.request(base + f'/art/{ident}/recovered-text.html', 'HEAD')[0], 200)
            self.assertEqual(self.request(base + '/.omx/atelier/reconstructed-text/')[0], 404)
        finally:
            server.shutdown(); server.server_close(); thread.join()
        original = (art / 'source.txt').read_bytes()
        (art / 'source.txt').write_text('changed')
        self.assertIsNone(fleet.recovered_text_preview(ident))
        (art / 'source.txt').write_bytes(original)
        preview.write_text('changed display')
        self.assertIsNone(fleet.recovered_text_preview(ident))

    def test_engine_activity_counts_failures_without_claiming_a_rate(self):
        log = '\n'.join(['[23:00:00Z] generating: art',
                         '[23:00:20Z] TURN FAILED (generation, 2 attempts)',
                         '[loop 2] TURN FAILED (scoring exit=4)',
                         '[loop 3] TURN FAILED (missing axes)'])
        self.assertEqual(fleet.engine_activity(log), {
            'available': True, 'sampleLines': 4, 'turnsStarted': 1,
            'turnsFailed': 3, 'generationFailures': 1, 'scoringFailures': 2})
        self.assertFalse(fleet.engine_activity('')['available'])
        self.assertEqual(fleet.engine_activity(log + '\n' + '\n'.join(['idle'] * 300))['turnsFailed'], 0)

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.root_patch = patch.object(fleet, "ROOT", self.root)
        self.root_patch.start()
        self.addCleanup(self.root_patch.stop)
        self.history_patch = patch.object(fleet, "sync_history", return_value={})
        self.history_patch.start()
        self.addCleanup(self.history_patch.stop)
        self.home_patch = patch.object(Path, "home", return_value=self.root / "home")
        self.home_patch.start()
        self.addCleanup(self.home_patch.stop)

    def test_full_history_retains_artifacts_and_original_score_records(self):
        source = fleet.history_root() / "XPS"
        art = source / "artifacts/old-art"
        art.mkdir(parents=True)
        (art / "playable.html").write_text("original artwork")
        cards = source / "scorecards"
        cards.mkdir()
        original = {"artifact": "/private/source/old-art", "domain": "p5", "ensemble": {"D": 9},
                    "judges": [{"vendor": "old judge", "axes": {"D": 9}}], "private_token": "hidden"}
        (cards / "score-123.json").write_text(json.dumps(original))
        payload = fleet.history_payload()
        self.assertEqual(payload["artifacts"], [{"id": "old-art", "archivedSource": False}])
        record = payload["scorecards"][0]["record"]
        self.assertEqual(record["artifact"], "old-art")
        self.assertEqual(record["ensemble"], original["ensemble"])
        self.assertNotIn("scoreScale", record)
        self.assertNotIn("private_token", record)
        self.assertEqual(fleet.served_artifact("old-art", "playable.html"), (art / "playable.html").resolve())
        self.assertIsNone(fleet.served_artifact("old-art", "provenance.txt"))

    def test_history_sync_never_deletes_source_or_retained_archive(self):
        with patch.object(fleet.subprocess, "run", return_value=fleet.subprocess.CompletedProcess([], 0)) as run:
            status = SYNC_HISTORY(None, "Laptop (Air)")
        self.assertFalse(status["errors"])
        self.assertEqual(run.call_count, 6)
        tournament = next(call.args[0] for call in run.call_args_list
                          if call.args[0][-1].endswith("/tournament-rejects/"))
        for name in ("playable.html", "source.txt", "provenance.txt", "lineage.json"):
            self.assertIn("--include=" + name, tournament)
        for call in run.call_args_list:
            self.assertEqual(call.args[0][0], "rsync")
            self.assertFalse(any(arg.startswith("--delete") for arg in call.args[0]))
            self.assertTrue(call.args[0][-1].startswith(str(fleet.history_root())))
        with patch.object(fleet.subprocess, "run", return_value=fleet.subprocess.CompletedProcess([], 1)):
            failed = SYNC_HISTORY(None, "Laptop (Air)")
        self.assertEqual(failed["lastSuccess"], status["lastSuccess"])
        self.assertEqual(len(failed["errors"]), 6)

    def test_tournament_artwork_remains_visible_after_leaving_active_store(self):
        source = fleet.history_root() / "Fixture"
        art = source / "tournament-rejects/nonwinner"
        art.mkdir(parents=True)
        for name, content in (("playable.html", "original nonwinning artwork"),
                              ("source.txt", "original source"),
                              ("provenance.txt", '{"identity":"original/model"}')):
            (art / name).write_text(content)
            self.assertEqual(fleet.served_artifact("nonwinner", name),
                             (art / name).resolve())
        (art / "lineage.json").write_text('{"originalFailure":{"prompt":"private fixture"}}')
        self.assertIsNone(fleet.served_artifact("nonwinner", "lineage.json"))
        payload = fleet.history_payload()
        self.assertIn({"id": "nonwinner", "archivedSource": False}, payload["artifacts"])
        self.assertEqual(payload["scorecards"], [])  # Presence does not invent a score.
        outside = self.root / "outside"
        outside.mkdir()
        (outside / "playable.html").write_text("must not serve")
        (source / "tournament-rejects/escaped").symlink_to(outside, target_is_directory=True)
        self.assertIsNone(fleet.served_artifact("escaped", "playable.html"))

    def test_paired_history_archive_preserves_nested_bodies_and_rejects_bad_ids(self):
        producer_body = self.root / "runtime/paired" / ("c" * 64) / "active/turn-1/artifacts" / ("d" * 64)
        producer_body.mkdir(parents=True)
        for name in ("playable.html", "source.txt", "provenance.txt"):
            (producer_body / name).write_text("fixture")
        with patch.object(fleet.subprocess, "run", return_value=fleet.subprocess.CompletedProcess([], 0)) as run:
            status = SYNC_HISTORY(None, "Fixture", str(self.root / "producer"), str(self.root / "runtime/artifacts"))
        self.assertFalse(status["errors"])
        paired_call = next(call.args[0] for call in run.call_args_list
                           if call.args[0][-2].endswith("/paired/"))
        self.assertTrue(paired_call[-2].endswith("/paired/"))
        self.assertTrue(paired_call[-1].endswith("/paired-artifacts/"))
        self.assertTrue(all(not arg.startswith("--delete") for arg in paired_call))
        self.assertTrue(all("--include=" + name in paired_call
                            for name in ("playable.html", "source.txt", "provenance.txt")))
        archive = fleet.history_root() / "Fixture/paired-artifacts"
        pair, op = "a" * 64, "b" * 64
        body = archive / pair / "active/turn-7/artifacts" / op
        body.mkdir(parents=True)
        for name in ("playable.html", "source.txt", "provenance.txt"):
            (body / name).write_text("fixture-" + name)
        bad = archive / pair / "active/turn-8/artifacts" / "invalid-op"
        bad.mkdir(parents=True)
        for name in ("playable.html", "source.txt", "provenance.txt"):
            (bad / name).write_text("fixture")
        self.assertEqual(fleet.archive_status(fleet.history_root() / "Fixture")["errors"], {})
        status_file = fleet.history_root() / "Fixture/status.json"
        status_file.write_text(json.dumps({"errors": {"paired-artifacts": "transfer_failed"}}))
        self.assertEqual(fleet.archive_status(fleet.history_root() / "Fixture")["errors"],
                         {"paired-artifacts": "transfer_failed"})
        status_file.write_text(json.dumps({"errors": {}}))
        self.assertEqual(fleet.served_artifact(op, "playable.html"), (body / "playable.html").resolve())
        payload = fleet.history_payload()
        self.assertIn({"id": op, "archivedSource": False}, payload["artifacts"])
        self.assertNotIn({"id": "invalid-op", "archivedSource": False}, payload["artifacts"])
        (body / "playable.html").unlink()
        (body / "playable.html").symlink_to(self.root / "outside.html")
        (self.root / "outside.html").write_text("must not serve")
        self.assertIsNone(fleet.served_artifact(op, "playable.html"))

    def test_history_projection_keeps_native_hashed_playable_references(self):
        originals = {}
        expected = []
        for source_name, identifiers in (("Air_ART_current", ["a" * 64, "b" * 64]),
                                         ("Steam_Deck_ART_current", ["c" * 64])):
            cards = fleet.history_root() / source_name / "scorecards"
            cards.mkdir(parents=True)
            for index, ident in enumerate(identifiers):
                path = cards / f"score-{index}.json"
                record = {"artifact": f"/owner/runtime/artifacts/{ident}/playable.html",
                          "domain": "p5", "ensemble": {"D": 7, "A": 6, "R": 5, "N": 4}}
                path.write_text(json.dumps(record))
                originals[path] = path.read_bytes()
                expected.append((source_name + "--" + path.name, ident))
        payload = fleet.history_payload()
        self.assertCountEqual([(row["file"], row["record"]["artifact"])
                               for row in payload["scorecards"]], expected)
        self.assertEqual(payload["quarantinedScorecards"], [])
        self.assertEqual(payload["quality"]["quarantinedRecords"], 0)
        for path, content in originals.items():
            self.assertEqual(path.read_bytes(), content)
        self.assertNotIn("/owner/runtime", json.dumps(payload))

    def test_history_projection_quarantines_untrusted_artifact_references(self):
        refs = ["playable.html", "/owner/artifacts/../trusted/playable.html",
                "/owner/artifacts/./trusted/playable.html", "https://untrusted/trusted/playable.html",
                " https://untrusted/" + "a" * 64 + "/playable.html",
                "\thttps://untrusted/" + "a" * 64 + "/playable.html",
                "file:/owner/trusted/playable.html", r"owner\trusted\playable.html",
                r"/owner\untrusted/artifacts/trusted/playable.html",
                "/owner/artifacts/unsafe..id/playable.html"]
        cards = fleet.history_root() / "Fixture" / "scorecards"
        cards.mkdir(parents=True)
        for index, ref in enumerate(refs):
            self.assertIsNone(fleet.history_artifact_id(ref))
            (cards / f"score-{index}.json").write_text(json.dumps({"artifact": ref}))
        payload = fleet.history_payload()
        self.assertEqual(len(payload["scorecards"]), len(refs))
        self.assertEqual(len(payload["quarantinedScorecards"]), len(refs))
        self.assertTrue(all(row["reason"] == "unsupported_artifact_reference"
                            for row in payload["quarantinedScorecards"]))
        self.assertTrue(all(fleet.history_artifact_id(row["record"].get("artifact")) is None
                            for row in payload["scorecards"]))

    def test_history_projection_removes_nested_private_payloads(self):
        axes = {"D": 90, "A": 8, "R": 7, "N": 6, "apiKey": "secret"}
        record = {"artifact": "old-art", "domain": "p5", "ensemble": axes,
                  "judges": [{"vendor": "judge", "axes": axes, "rawResponse": "secret"}],
                  "defects": [{"prompt": "secret", "apiKey": "secret"}],
                  "team": {"judge": {**axes, "error": "secret", "rawResponse": "secret"}},
                  "round1": axes, "round2": {"judge": {**axes, "prompt": "secret"}}}
        projected = fleet.project_history_record(record)
        rendered = json.dumps(projected)
        for private in ("secret", "apiKey", "rawResponse", "prompt"):
            self.assertNotIn(private, rendered)
        self.assertEqual(projected["ensemble"]["D"], 90)
        self.assertEqual(projected["judges"][0]["axes"]["A"], 8)
        self.assertEqual(len(projected["defects"]), 1)
        self.assertIs(projected["team"]["judge"]["error"], True)

    def test_archive_rejects_escaped_families_and_malformed_status(self):
        source = fleet.history_root() / "Fixture"
        source.mkdir(parents=True)
        (source / "status.json").write_text("[]")
        outside = self.root / "private"
        outside.mkdir()
        (outside / "secret.json").write_text('{"id":"secret"}')
        (source / "scorecards").symlink_to(outside, target_is_directory=True)
        payload = fleet.history_payload()
        self.assertEqual(payload["scorecards"], [])
        self.assertEqual(payload["sources"]["Fixture"]["errors"], {"status": "invalid"})

    def test_archive_sync_rejects_escaped_and_regular_file_destinations(self):
        source = fleet.history_root() / "Fixture"
        source.mkdir(parents=True)
        outside = self.root / "outside"
        outside.mkdir()
        (source / "scorecards").symlink_to(outside, target_is_directory=True)
        (source / "third-judge").write_text("not a directory")
        with patch.object(fleet.subprocess, "run", return_value=fleet.subprocess.CompletedProcess([], 0)) as run:
            status = SYNC_HISTORY(None, "Fixture")
        self.assertEqual(run.call_count, 4)
        self.assertEqual(status["errors"]["scorecards"], "unsafe_destination")
        self.assertEqual(status["errors"]["third-judge"], "unavailable_destination")
        self.assertEqual(list(outside.iterdir()), [])
        with tempfile.TemporaryDirectory() as another:
            root = Path(another)
            archive = root / ".omx/atelier/fleet/archive"
            archive.parent.mkdir(parents=True)
            archive.symlink_to(outside, target_is_directory=True)
            with patch.object(fleet, "ROOT", root), patch.object(fleet.subprocess, "run") as run:
                status = SYNC_HISTORY(None, "Fixture")
                run.assert_not_called()
                self.assertEqual(fleet.archive_sources(), [])
                self.assertEqual(status["errors"]["archive"], "unsafe_destination")
                with patch.object(fleet, "sync_history", SYNC_HISTORY), patch.object(fleet, "MACHINES", [("Fixture", None)]):
                    payload = fleet.refresh_history_once()
                self.assertTrue(any(s.get("errors") for s in payload["sources"].values()))
                self.assertEqual(payload["sources"]["Fixture"]["errors"]["archive"], "unsafe_destination")
                self.assertIs(fleet.HISTORY_PUBLIC_CACHE[str(root)], payload)

    def test_history_refresh_retains_xps_without_contact_and_pulls_nucbox(self):
        sources = [("XPS", "xps:simon"), ("Fixture", None)]
        with patch.object(fleet, "MACHINES", sources), patch.object(
            fleet, "sync_history", return_value={"errors": {}}
        ) as sync, patch.dict(os.environ, {"SINTER_HISTORY_NUCBOX_HOSTSPEC": "nucbox:simon"}):
            fleet.refresh_history_once()
        self.assertCountEqual(sync.call_args_list,
                         [call(None, "Fixture"), call("nucbox:simon", "Nucbox")])

    def test_archive_status_and_judges_do_not_follow_external_files(self):
        source = fleet.history_root() / "Fixture"
        source.mkdir(parents=True)
        private = self.root / "private.json"
        private.write_text('{"private":"secret","id":"external","errors":{}}')
        status = source / "status.json"
        status.symlink_to(private)
        self.assertNotIn("private", fleet.archive_status(source))
        status.unlink()
        status.write_text(private.read_text())
        self.assertNotIn("private", fleet.archive_status(source))
        judges = source / "second-judge"
        judges.mkdir()
        (judges / "external.json").symlink_to(private)
        self.assertEqual(fleet._collect_sj(self.root)["results"], [])
        local = self.root / ".omx/atelier/second-judge"
        outside = self.root / "external-judges"
        outside.mkdir()
        (outside / "external.json").write_text(private.read_text())
        local.symlink_to(outside, target_is_directory=True)
        self.assertEqual(fleet._collect_sj(self.root)["results"], [])

    def test_retained_snapshot_status_requires_explicit_boolean(self):
        source = fleet.history_root() / "retired"
        source.mkdir(parents=True)
        for value in (True, False, "true", {"private": "secret"}):
            (source / "status.json").write_text(json.dumps({"errors": {}, "retained": value}))
            status = fleet.archive_status(source)
            self.assertEqual(status.get("retained", False), value is True)
            self.assertNotIn("secret", json.dumps(status))

    def test_second_judge_mirrors_do_not_duplicate_recent_verdicts(self):
        local = self.root / ".omx/atelier/second-judge"
        archived = fleet.history_root() / "Air/second-judge"
        local.mkdir(parents=True)
        archived.mkdir(parents=True)
        axes = dict.fromkeys("DARN", 7)
        record = {"id": "old-art", "round1": axes,
                  "round2": dict.fromkeys(["sol", "glm-5.3", "grok"], axes)}
        for folder in (local, archived):
            (folder / "same.json").write_text(json.dumps(record))
        self.assertEqual(len(fleet._collect_sj(self.root)["results"]), 1)

    def test_legacy_rescue_sources_and_ghosts_keep_distinct_routes(self):
        base = fleet.history_root() / "Laptop" / "legacy-rescue"
        scored = base / "scored/r13"
        ghost = base / "ghost-alive-v2/r13"
        scored.mkdir(parents=True)
        ghost.mkdir(parents=True)
        (scored / "playable.html").write_text("original p5")
        (ghost / "playable.html").write_text("original music")
        (base / "old.false-kill.js").write_text("original source")
        original = self.root / "original-ghosts"
        original.mkdir()
        legacy_link = self.root / ".omx/atelier/rejects/code/rescue/ghost-alive-v2"
        legacy_link.parent.mkdir(parents=True)
        legacy_link.symlink_to(original, target_is_directory=True)
        self.assertEqual(fleet.served_artifact("r13", "playable.html"), (scored / "playable.html").resolve())
        self.assertEqual(fleet.dashboard_path("/.omx/atelier/rejects/code/rescue/ghost-alive-v2/r13/playable.html"), ghost / "playable.html")
        self.assertEqual(fleet.served_artifact("old.false-kill", "source.txt"), (base / "old.false-kill.js").resolve())
        self.assertIsNone(fleet.served_artifact("old.false-kill", "playable.html"))
        self.assertIn({"id": "old.false-kill", "archivedSource": True}, fleet.history_payload()["artifacts"])

    def test_artifact_files_share_one_selected_copy(self):
        merged = self.root / ".omx/atelier/fleet/merged/artifacts/copied-art"
        linked = self.root / ".omx/atelier/art-link/artifacts/copied-art"
        merged.mkdir(parents=True)
        linked.mkdir(parents=True)
        (merged / "playable.html").write_text("new artwork")
        (linked / "playable.html").write_text("old artwork")
        (linked / "provenance.txt").write_text('{"identity":"old/model"}')
        self.assertEqual(fleet.served_artifact("copied-art", "playable.html"), (merged / "playable.html").resolve())
        self.assertIsNone(fleet.served_artifact("copied-art", "provenance.txt"))
        (merged / "provenance.txt").write_text('{"identity":"new/model"}')
        self.assertEqual(fleet.served_artifact("copied-art", "provenance.txt"), (merged / "provenance.txt").resolve())

    def test_idle_browser_connection_does_not_block_other_requests(self):
        accepted = threading.Event()
        class ObservedHandler(fleet.Handler):
            def handle(self):
                accepted.set()
                super().handle()
            def log_message(self, *args):
                pass
        server = fleet.HTTPServer(("127.0.0.1", 0), ObservedHandler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        idle = socket.create_connection(server.server_address, timeout=2)
        try:
            self.assertTrue(accepted.wait(2), "idle connection was not accepted")
            url = f"http://127.0.0.1:{server.server_port}/api/ghosts"
            origin = f"http://127.0.0.1:{server.server_port}"
            with urlopen(Request(url, headers={"Origin": origin}), timeout=1) as response:
                self.assertEqual(response.status, 200)
                self.assertEqual(response.headers.get("Access-Control-Allow-Origin"), origin)
                self.assertEqual(json.load(response), {"available": False, "entries": []})
            with urlopen(Request(url, headers={"Origin": "https://untrusted.invalid"}), timeout=1) as response:
                self.assertIsNone(response.headers.get("Access-Control-Allow-Origin"))
            stale = self.root / ".omx/atelier/fleet/merged/history.json"
            stale.parent.mkdir(parents=True)
            stale.write_text('{"private":"secret","artifacts":[{"id":"stale"}]}')
            with urlopen(origin + "/api/history", timeout=2) as response:
                history = json.load(response)
                self.assertNotIn("private", history)
                self.assertEqual(history["artifacts"], [])
            with patch.object(fleet, "history_payload", side_effect=AssertionError("request must use validated snapshot")):
                with urlopen(origin + "/api/history", timeout=2) as response:
                    self.assertEqual(json.load(response), history)
        finally:
            idle.close()
            server.shutdown()
            server.server_close()
            thread.join(timeout=2)

    def test_incomplete_browser_request_is_closed_after_timeout(self):
        self.assertEqual(fleet.Handler.timeout, 10)
        class FastHandler(fleet.Handler):
            timeout = 0.1
            def log_message(self, *args):
                pass
        server = fleet.HTTPServer(("127.0.0.1", 0), FastHandler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            with socket.create_connection(server.server_address, timeout=2) as client:
                client.sendall(b"GET /api/ghosts HTTP/1.1\r\n")
                self.assertEqual(client.recv(1), b"")
            url = f"http://127.0.0.1:{server.server_port}/api/ghosts"
            self.assertEqual(self.request(url)[0], 200)
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=2)

    def test_sandbox_origin_can_read_only_published_vendor_modules(self):
        (self.root / "vendor").mkdir()
        (self.root / "vendor/manifest.json").write_text(
            (Path(fleet.__file__).resolve().parents[2] / "vendor/manifest.json").read_text())
        module = self.root / "vendor/three/0.160.0/three.module.js"
        module.parent.mkdir(parents=True)
        module.write_text("export const version = 'fixture';")
        server = fleet.HTTPServer(("127.0.0.1", 0), fleet.Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        base = f"http://127.0.0.1:{server.server_port}"
        try:
            manifest = json.loads((self.root / "vendor/manifest.json").read_text())
            for asset in manifest["assets"]:
                relative = "vendor/" + asset["file"]
                if asset.get("dir"):
                    relative += "/nested/index.js"
                target = self.root / relative
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(b"fixture")
                request = Request(base + "/" + relative, headers={"Origin": "null"})
                with urlopen(request, timeout=2) as response:
                    self.assertEqual(response.status, 200, relative)
                    self.assertEqual(response.headers.get("Access-Control-Allow-Origin"), "null", relative)
                    expected = "application/wasm" if relative.endswith(".wasm") else "text/javascript"
                    self.assertEqual(response.headers.get_content_type(), expected, relative)
            for relative in ("vendor/thi.ng/geom/private.json", "vendor/thi.ng/geom-private/index.js",
                             "vendor/thi.ng/geom/folder.js", "vendor/thi.ng/geom/../private.js"):
                target = self.root / relative
                target.parent.mkdir(parents=True, exist_ok=True)
                if relative.endswith("folder.js"):
                    target.mkdir()
                else:
                    target.write_text("not published")
                request = Request(base + "/" + relative, headers={"Origin": "null"})
                with self.assertRaises(HTTPError) as failure:
                    urlopen(request, timeout=2)
                self.assertIsNone(failure.exception.headers.get("Access-Control-Allow-Origin"))
                failure.exception.close()
            request = Request(base + "/vendor/three/0.160.0/three.module.js", headers={"Origin": "null"})
            with urlopen(request, timeout=2) as response:
                self.assertEqual(response.status, 200)
                self.assertEqual(response.headers.get("Access-Control-Allow-Origin"), "null")
            request = Request(base + "/api/ghosts", headers={"Origin": "null"})
            with urlopen(request, timeout=2) as response:
                self.assertIsNone(response.headers.get("Access-Control-Allow-Origin"))
            request = Request(base + "/vendor/three/0.160.0/missing.js", headers={"Origin": "null"})
            with self.assertRaises(HTTPError) as failure:
                urlopen(request, timeout=2)
            self.assertIsNone(failure.exception.headers.get("Access-Control-Allow-Origin"))
            failure.exception.close()
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=2)

    def test_missing_retired_archive_is_explicit(self):
        rows = fleet.load_retired_machines()
        self.assertEqual(len(rows), 1)
        self.assertTrue(rows[0]["retired"])
        self.assertTrue(rows[0]["partial"])
        self.assertEqual(rows[0]["error"], "Retained corpus archive unavailable")

    def test_retired_provenance_gap_is_optional_but_required_artifacts_error(self):
        bests = {"p5": {"id": "retired-art", "mean": 8, **QUALITY_MARKERS}}
        row = {"event_type": "artifact_scored", "artifact": "retired-art",
               "domain": "p5", "axes": "D=8 A=8 R=8 N=8", **QUALITY_FIELDS}
        files = {key: "[]" for key in ("beads", "threads", "moves", "plates")}
        files.update(bests=json.dumps(bests), elo="{}", frontier="[]", trend=json.dumps(row))
        retired = dict(name="Retired", retired=True, rows=[row], moves=0, bests=bests,
                       files=files, partial=False, rowDrops=0, fileErrors={})
        with patch.object(fleet, "MACHINES", []), \
             patch.object(fleet, "CACHE", self.root / "cache"), \
             patch.object(fleet, "load_retired_machines", return_value=[retired]), \
             patch.object(fleet.time, "sleep", side_effect=StopIteration):
            with self.assertRaises(StopIteration):
                fleet.refresher()
        report = json.loads((self.root / ".omx/atelier/fleet/fleet.json").read_text())
        key = "Retired:retired-art/"
        self.assertEqual(report["provenanceUnavailable"], {key + "provenance.txt": "retired history has no provenance"})
        self.assertEqual(set(report["artifactTransferErrors"]), {key + "playable.html", key + "source.txt"})
        self.assertTrue(report["partial"])
        self.assertTrue(report["machines"][0]["partial"])

    def test_unreadable_file_keeps_other_machine_data(self):
        atelier = self.root / ".omx/atelier"
        (atelier / "lessons").mkdir(parents=True)
        (atelier / "lessons/trend.jsonl").write_text('{"event_type":"artifact_scored","artifact":"kept"}\n')
        read = Path.read_text
        def deny_bests(path, *args, **kwargs):
            if path.name == "best-per-domain.json":
                raise PermissionError("fixture")
            return read(path, *args, **kwargs)
        with patch.object(Path, "read_text", deny_bests):
            result = fleet.collect(None, "fixture")
        self.assertNotIn("error", result)
        self.assertEqual(result["rows"][0]["artifact"], "kept")
        self.assertEqual(result["fileErrors"]["bests"], "PermissionError")
        self.assertTrue(result["partial"])

    def test_paired_feed_intake_preserves_81_scores_and_84_contexts_across_three_roots(self):
        counts = {"artifact_scored": 0, "generation_context": 0}
        for feed in ("Air", "Mini", "Pro"):
            source = self.root / feed
            artifact_root = self.root / (feed + "-runtime/artifacts")
            feed_scores = 0
            rows, pair_num = [], list(range(14))
            for index in pair_num:
                pair = f"{index + 1:064x}"
                for arm in ("active", "staged"):
                    op = f"{index * 2 + (arm == 'staged') + 1:064x}"
                    relative = f"{pair}/{arm}/turn-{index + 1}/artifacts/{op}"
                    body = artifact_root.parent / "paired" / relative
                    body.mkdir(parents=True)
                    for name in ("playable.html", "source.txt", "provenance.txt"):
                        (body / name).write_text("fixture")
                    rows.append({"event_type": "generation_context", "artifact": str(body),
                                 "pair_id": pair, "prompt": "Create a fixture.", "persona": "none",
                                 "arm": arm, "candidate_genome_sha256": ("c" if arm == "active" else "d") * 64,
                                 "domain": "p5", "model": "fixture-model"})
                    counts["generation_context"] += 1
                    if feed_scores < 27:
                        rows.append({"event_type": "artifact_scored", "artifact": str(body / "playable.html"),
                                     "ts": f"score-{counts['artifact_scored']}", "domain": "p5",
                                     "model": "fixture-model", "axes": "D=8 A=8 R=8 N=8",
                                     "judges": ["judge-one", "judge-two"], "scoreScale": 10})
                        counts["artifact_scored"] += 1
                        feed_scores += 1
            trend = source / ".omx/atelier/lessons/trend.jsonl"
            trend.parent.mkdir(parents=True)
            trend.write_text("\n".join(json.dumps(row) for row in rows))
            result = fleet.collect(None, feed, str(source), str(artifact_root), worker="fixture")
            self.assertEqual(result["rows"], rows)
            sys.path.insert(0, str(SOURCE.parents[2] / "scripts/atelier"))
            from learning_turns import paired_turns, scored_turns
            pins = {"active": "c" * 64, "staged": "d" * 64}
            scored = scored_turns(trend, pins)
            self.assertEqual(len(scored), 27)
            self.assertEqual(len(paired_turns(scored, ["p5"])), 26)
        self.assertEqual(counts, {"artifact_scored": 81, "generation_context": 84})

    def test_explicit_paired_root_preserves_scores_and_contexts_outside_artifact_store(self):
        source = self.root / "producer"
        artifacts = self.root / "output/artifacts"
        paired = self.root / "worker-runtime/paired"
        body = paired / ("a" * 64) / "active/turn-7/artifacts" / ("b" * 64)
        body.mkdir(parents=True)
        for name in ("playable.html", "source.txt", "provenance.txt"):
            (body / name).write_text("original-" + name)
        rows = [{"event_type": "generation_context", "artifact": str(body), "pair_id": "a" * 64},
                {"event_type": "artifact_scored", "artifact": str(body / "playable.html"),
                 "axes": "D=8 A=8 R=8 N=8", "domain": "p5", **QUALITY_FIELDS}]
        unrelated = {**rows[-1], "artifact": str(paired) + "-other/unrelated/playable.html"}
        trend = source / ".omx/atelier/lessons/trend.jsonl"
        trend.parent.mkdir(parents=True)
        trend.write_text("\n".join(json.dumps(row) for row in rows + [unrelated]))
        result = fleet.collect(None, "Fixture", str(source), str(artifacts), worker="fixture",
                               paired_root=str(paired))
        self.assertEqual(result["rows"], rows)
        self.assertEqual(result["sourceFilteredRows"], 0)
        self.assertEqual(result["rowDrops"], 0)
        with patch.object(fleet.subprocess, "run", return_value=fleet.subprocess.CompletedProcess([], 0)) as run:
            status = SYNC_HISTORY(None, "Fixture", str(source), str(artifacts), paired_root=str(paired))
        self.assertFalse(status["errors"])
        transfers = [entry.args[0] for entry in run.call_args_list]
        self.assertTrue(any(command[-2] == str(paired) + "/" for command in transfers))
        self.assertFalse(any(command[-2] == str(artifacts.parent / "paired") + "/" for command in transfers))

    def test_nested_paired_root_requires_valid_complete_bodies_before_canonical_admission(self):
        source, artifacts = self.root / "producer", self.root / "output/artifacts"
        paired = artifacts / "paired"
        feed = {"name": "Fixture", "hostspec": None, "root": str(source),
                "artifacts": str(artifacts), "worker": "fixture", "paired": str(paired)}
        with patch.dict(os.environ, {"SINTER_ART_FEEDS_JSON": json.dumps([feed])}):
            self.assertEqual(fleet.art_feeds(), [feed])
        canonical = {"event_type": "artifact_scored", "artifact": str(artifacts / "ordinary/playable.html")}
        rows, admitted = [canonical], [canonical]
        for index, missing in enumerate((None, "playable.html", "source.txt", "provenance.txt", "malformed")):
            pair = "z" * 64 if missing == "malformed" else "a" * 64
            body = paired / pair / f"active/turn-{index + 1}/artifacts" / ("b" * 64)
            body.mkdir(parents=True)
            for name in ("playable.html", "source.txt", "provenance.txt"):
                if name != missing:
                    (body / name).write_text("original-" + name)
            pair_rows = [{"event_type": "generation_context", "artifact": str(body),
                          "pair_id": pair, "arm": "active", "candidate_genome_sha256": "c" * 64,
                          "prompt": "Create a fixture.", "persona": "none", "domain": "p5"},
                         {"event_type": "artifact_scored", "artifact": str(body / "playable.html"),
                          "axes": "D=8 A=8 R=8 N=8", "domain": "p5", **QUALITY_FIELDS}]
            rows.extend(pair_rows)
            if missing is None:
                admitted.extend(pair_rows)
        trend = source / ".omx/atelier/lessons/trend.jsonl"
        trend.parent.mkdir(parents=True)
        trend.write_text("\n".join(json.dumps(row) for row in rows))
        result = fleet.collect(None, "Fixture", str(source), str(artifacts), worker="fixture",
                               paired_root=str(paired))
        self.assertEqual(result["rows"], admitted)
        self.assertEqual(result["rowDrops"], 8)
        self.assertEqual(result["sourceFilteredRows"], 0)
        self.assertTrue(result["partial"])
        self.assertEqual(trend.read_text(), "\n".join(json.dumps(row) for row in rows))

    def test_art_feed_validates_optional_paired_root(self):
        feed = {"name": "Fixture", "hostspec": None, "root": str(self.root / "producer"),
                "artifacts": str(self.root / "output/artifacts"), "worker": "fixture",
                "paired": str(self.root / "worker-runtime/paired")}
        with patch.dict(os.environ, {"SINTER_ART_FEEDS_JSON": json.dumps([feed])}):
            self.assertEqual(fleet.art_feeds(), [feed])
        for value in (None, "relative/paired", "/runtime/../paired", "/runtime/artifacts", "/runtime/paired;echo"):
            with self.subTest(value=value), patch.dict(os.environ, {
                    "SINTER_ART_FEEDS_JSON": json.dumps([{**feed, "paired": value}])}):
                with self.assertRaises(ValueError):
                    fleet.art_feeds()

    def test_paired_intake_rejects_incomplete_symlink_and_malformed_paths(self):
        source, artifacts = self.root / "source", self.root / "runtime/artifacts"
        paired = artifacts.parent / "paired"
        pair, op = "a" * 64, "b" * 64
        good = paired / pair / "active/turn-1/artifacts" / op
        good.mkdir(parents=True)
        (good / "source.txt").write_text("fixture")
        (good / "provenance.txt").write_text("fixture")
        outside = self.root / "outside.html"
        outside.write_text("fixture")
        (good / "playable.html").symlink_to(outside)
        paths = [good / "playable.html", paired / pair / "active/turn-2/artifacts" / op / "playable.html",
                 paired / pair / "active/turn-1/artifacts/../" / op / "playable.html",
                 paired / ("z" * 64) / "active/turn-1/artifacts" / op / "playable.html",
                 paired / pair / "active/turn-1/artifacts" / ("z" * 64) / "playable.html",
                 paired / pair / "control/turn-1/artifacts" / op / "playable.html",
                 paired / pair / "active/turn-0/artifacts" / op / "playable.html",
                 Path(str(paired) + "-unrelated") / pair / "active/turn-1/artifacts" / op / "playable.html"]
        trend = source / ".omx/atelier/lessons/trend.jsonl"
        trend.parent.mkdir(parents=True)
        trend.write_text("\n".join(json.dumps({"event_type": "artifact_scored", "artifact": str(path)})
                                 for path in paths))
        result = fleet.collect(None, "Fixture", str(source), str(artifacts), worker="fixture")
        self.assertEqual(result["rows"], [])
        self.assertEqual(result["rowDrops"], 7)
        self.assertTrue(result["partial"])
        valid = paired / ("c" * 64) / "staged/turn-3/artifacts" / ("d" * 64)
        valid.mkdir(parents=True)
        for name in ("playable.html", "source.txt", "provenance.txt"):
            (valid / name).write_text("fixture")
        def local_ssh(_host, command, **_kwargs):
            return fleet.subprocess.run(fleet.shlex.split(command), capture_output=True,
                                        text=True, check=True).stdout
        with patch.object(fleet, "ssh", side_effect=local_ssh):
            self.assertEqual(fleet.paired_remote_bodies("fixture:user", paired),
                             {"c" * 64 + "/staged/turn-3/artifacts/" + "d" * 64})

    def test_refused_paired_row_marks_current_manifest_partial_with_drop_count(self):
        source, artifacts = self.root / "source", self.root / "runtime/artifacts"
        missing = artifacts.parent / "paired" / ("a" * 64) / "active/turn-1/artifacts" / ("b" * 64)
        trend = source / ".omx/atelier/lessons/trend.jsonl"
        trend.parent.mkdir(parents=True)
        trend.write_text(json.dumps({"event_type": "artifact_scored", "artifact": str(missing / "playable.html")}))
        feed = {"name": "Fixture", "hostspec": None, "root": str(source),
                "artifacts": str(artifacts), "worker": "fixture"}
        with patch.dict(os.environ, {"SINTER_ART_FEEDS_JSON": json.dumps([feed])}), \
             patch.object(fleet, "MACHINES", []), patch.object(fleet, "CACHE", self.root / "cache"), \
             patch.object(fleet, "load_retired_machines", return_value=[]):
            fleet.refresher(once=True)
        report = json.loads((self.root / ".omx/atelier/fleet/fleet.json").read_text())
        snapshot = json.loads((self.root / ".omx/atelier/fleet/snapshot.json").read_text())
        self.assertTrue(report["partial"])
        self.assertTrue(report["machines"][0]["partial"])
        self.assertEqual(report["mergeDrops"]["Fixture:trend-badrows"], 1)
        self.assertEqual(snapshot["mergeDrops"], report["mergeDrops"])

    def test_local_artifact_missing_and_permission_are_distinct(self):
        with self.assertRaises(fleet.ArtifactMissing):
            fleet.mirror_artifact(None, "missing-art", "provenance.txt", self.root / "out")
        source = self.root / ".omx/atelier/art-link/artifacts/protected-art"
        source.mkdir(parents=True)
        (source / "provenance.txt").write_text("private fixture")
        with patch.object(Path, "open", side_effect=PermissionError("fixture")):
            with self.assertRaises(PermissionError):
                fleet.mirror_artifact(None, "protected-art", "provenance.txt", self.root / "out")

    def test_failed_publication_preserves_previous_document_and_cleans_temp(self):
        path = self.root / "snapshot.json"
        fleet.write_json(path, {"cycle": 1})
        with self.assertRaises(TypeError):
            fleet.write_json(path, {"bad": object()})
        with self.assertRaises(ValueError):
            fleet.write_json(path, {"bad": float("nan")})
        self.assertEqual(json.loads(path.read_text()), {"cycle": 1})
        with patch.object(fleet.os, "replace", side_effect=OSError("interrupted publish")):
            with self.assertRaises(OSError):
                fleet.write_json(path, {"cycle": 2})
        self.assertEqual(json.loads(path.read_text()), {"cycle": 1})
        self.assertEqual(list(self.root.iterdir()), [path])
        fleet.write_json(path, {"cycle": 3})
        self.assertEqual(json.loads(path.read_text()), {"cycle": 3})

    def test_corrupt_retired_rows_are_counted(self):
        archive = self.root / ".omx/atelier/fleet/retired-srv1542844-test"
        archive.mkdir(parents=True)
        (archive / "srv-full-state.txt").write_text(
            '---F:best-per-domain.json---\n{"p5":{"id":"retained","mean":8}}\n'
            '---F:lessons/trend.jsonl---\n{"id":"ok"}\nnull\nBROKEN\n')
        row = fleet.load_retired_machines()[0]
        self.assertEqual(row["rows"], [{"id": "ok"}])
        self.assertEqual(row["rowDrops"], 2)
        self.assertEqual(row["bests"], {"p5": {"id": "retained", "mean": 8}})
        self.assertTrue(row["partial"])

    def test_failed_transfer_never_publishes_remote_partial_file(self):
        import subprocess
        for failure in ("scp", "mkdir"):
            calls = []
            def run(command, **kwargs):
                calls.append(command)
                failed = command[0] == failure or command[-1].startswith(failure + " ")
                return subprocess.CompletedProcess(command, int(failed))
            with patch.object(fleet.subprocess, "run", side_effect=run):
                with self.assertRaises(RuntimeError):
                    fleet.push_trend("fixture:user", self.root / "trend.jsonl")
            self.assertFalse(any(command[-1].startswith("mv ") for command in calls))
            self.assertTrue(calls[-1][-1].startswith("rm -f "))
        with patch.object(fleet.subprocess, "run", return_value=subprocess.CompletedProcess([], 0)) as run:
            fleet.push_trend("fixture:user", self.root / "trend.jsonl")
        self.assertTrue(any(call.args[0][-1].startswith("mv ") for call in run.call_args_list))

    def test_corrupt_files_do_not_hide_valid_judge_verdict(self):
        folder = self.root / ".omx/atelier/second-judge"
        folder.mkdir(parents=True)
        for i in range(25):
            path = folder / f"bad-{i}.json"
            path.write_text("BROKEN")
            os.utime(path, (2000 + i, 2000 + i))
            empty = folder / f"empty-{i}.json"
            empty.write_text("{}")
            os.utime(empty, (3000 + i, 3000 + i))
        axes = dict.fromkeys(["D", "A", "R", "N"], 7)
        valid = folder / "valid.json"
        valid.write_text(json.dumps({"id": "valid", "round1": axes,
                                    "round2": dict.fromkeys(["sol", "glm-5.3", "grok"], axes)}))
        os.utime(valid, (1000, 1000))
        result = fleet._collect_sj(self.root)
        self.assertEqual([r["id"] for r in result["results"]], ["valid"])
        self.assertEqual(result["avgDelta"], 0)
        self.assertEqual(result["droppedRecords"], 50)
        self.assertEqual(result["judgeDroppedRecords"], 50)
        merge = self.root / ".omx/atelier/fleet/merged/merge-drops.json"
        merge.parent.mkdir(parents=True)
        merge.write_text(json.dumps({"Fixture:elo-unverified": 100}))
        separated = fleet._collect_sj(self.root)
        self.assertEqual(separated["droppedRecords"], 150)
        self.assertEqual(separated["judgeDroppedRecords"], 50)
        self.assertEqual(result["judgeHealth"], dict.fromkeys(["sol", "glm-5.3", "grok"], "ok"))

    def test_out_of_range_judge_axes_are_counted_as_dropped(self):
        folder = self.root / ".omx/atelier/second-judge"
        folder.mkdir(parents=True)
        for value in (-1, 100, 0, 10):
            axes = dict.fromkeys("DARN", value)
            (folder / f"{value}.json").write_text(json.dumps({"id": str(value),
                "round1": axes, "round2": dict.fromkeys(["sol", "glm-5.3", "grok"], axes)}))
        report = fleet._collect_sj(self.root)
        self.assertEqual(report["droppedRecords"], 2)
        self.assertEqual({row["r1"] for row in report["results"]}, {0, 10})
        self.assertEqual({row["r2"] for row in report["results"]}, {0, 10})

    def test_artifact_paths_reject_traversal_and_symlinks(self):
        base = self.root / "artifacts"
        base.mkdir()
        for value in ["..", ".", "../escape", "bad/name", "x" * 201, None, 12]:
            with self.subTest(value=value):
                self.assertIsNone(fleet.artifact_path(base, value, "playable.html"))
        (base / "escape").symlink_to(self.root, target_is_directory=True)
        self.assertIsNone(fleet.artifact_path(base, "escape", "playable.html"))
        self.assertEqual(fleet.artifact_path(base, "r13-valid", "playable.html"),
                         (base / "r13-valid/playable.html").resolve())
        self.assertIsNone(fleet.artifact_path(base, "valid", "secret.txt"))

    def test_refresh_preserves_repeated_moves_and_deduplicates_replicas(self):
        game = self.root / ".omx/atelier/game"
        game.mkdir(parents=True)
        first = {"at": "2026-09-04T01:00:00Z", "action": "repeat", "a": "a", "b": "b"}
        second = {**first, "at": "2026-09-04T02:00:00Z"}
        (game / "moves.json").write_text(json.dumps([first, second, first]))
        with patch.object(fleet, "MACHINES", [("Laptop (Air)", None)]), \
             patch.object(fleet, "CACHE", self.root / "cache"), \
             patch.object(fleet, "load_retired_machines", return_value=[]), \
             patch.object(fleet.time, "sleep", side_effect=StopIteration), \
             patch.object(fleet.subprocess, "run") as subprocess_run:
            with self.assertRaises(StopIteration):
                fleet.refresher()
            subprocess_run.assert_not_called()
        merged = json.loads((self.root / ".omx/atelier/fleet/merged/moves.json").read_text())
        self.assertEqual(merged, [first, second])

    def request(self, url, method="GET"):
        try:
            with urlopen(Request(url, method=method), timeout=3) as response:
                return response.status, response.headers, response.read()
        except HTTPError as error:
            with error:
                return error.code, error.headers, error.read()

    def test_snapshot_uses_current_cycle_and_only_scored_ids(self):
        atelier = self.root / ".omx/atelier"
        (atelier / "lessons").mkdir(parents=True)
        bests = {"p5": {"id": "r13-good", "mean": 7.5, **QUALITY_MARKERS}}
        elo = {"r13-good": {"rating": 1234, **QUALITY_MARKERS}}
        (atelier / "best-per-domain.json").write_text(json.dumps(bests))
        (atelier / "elo.json").write_text(json.dumps(elo))
        rows = [{"event_type": "artifact_failed", "artifact": "r13-failed"},
                {"event_type": "artifact_scored", "artifact": "r13-good", "domain": "p5",
                 "axes": "D=7.5 A=7.5 R=7.5 N=7.5", **QUALITY_FIELDS}]
        (atelier / "lessons/trend.jsonl").write_text("\n".join(map(json.dumps, rows)))
        with patch.object(fleet, "MACHINES", [("Laptop (Air)", None)]), \
             patch.object(fleet, "CACHE", self.root / "cache"), \
             patch.object(fleet, "load_retired_machines", return_value=[]), \
             patch.object(fleet.time, "sleep", side_effect=StopIteration), \
             patch.object(fleet.subprocess, "run") as subprocess_run:
            with self.assertRaises(StopIteration):
                fleet.refresher()
            subprocess_run.assert_not_called()
        snapshot = json.loads((atelier / "fleet/snapshot.json").read_text())
        self.assertEqual(snapshot["bests"], bests)
        self.assertEqual(snapshot["elo"], elo)
        self.assertEqual([r["id"] for r in snapshot["scorecardIndex"]], ["r13-good"])
        self.assertEqual(snapshot["totalScored"], 1)

    def run_synthetic_cycle(self, bests=None, elo=None, bad_child=False, transfer=False, rows=None, peer_elo=None, files_override=None):
        bests, elo = bests or {}, elo or {}
        files = {key: "[]" for key in ("beads", "threads", "moves", "plates")}
        files.update(bests=json.dumps(bests), elo=json.dumps(elo), frontier="[]", trend="")
        files["trend"] = "\n".join(json.dumps(row) for row in (rows or []))
        files.update(files_override or {})
        if bad_child:
            files["beads"] = '[7]'
        machine = dict(name="Fixture", rows=rows or [], moves=0, bests=bests, files=files,
                       partial=False, rowDrops=0, fileErrors={})
        peers = [] if peer_elo is None else [dict(machine, name="Peer", retired=True,
            bests={}, files={**files, "bests": "{}", "elo": json.dumps(peer_elo)})]
        with patch.object(fleet, "MACHINES", [("Fixture", "fixture:user")]), \
             patch.object(fleet, "CACHE", self.root / "cache"), \
             patch.object(fleet, "collect", return_value=machine), \
             patch.object(fleet, "load_retired_machines", return_value=peers), \
             patch.object(fleet, "push_trend", side_effect=RuntimeError if transfer else None), \
             patch.object(fleet, "mirror_artifact", side_effect=RuntimeError if transfer else None), \
             patch.object(fleet.time, "sleep", side_effect=StopIteration):
            with self.assertRaises(StopIteration):
                fleet.refresher()
        folder = self.root / ".omx/atelier/fleet"
        return tuple(json.loads((folder / name).read_text())
                     for name in ("fleet.json", "snapshot.json"))

    def run_artifact_cycle(self, remote_provenance=True, scp_failure=None, reset=False,
                           remote_probe_rc=None):
        if reset:
            import shutil
            shutil.rmtree(self.root / ".omx/atelier/fleet/merged/artifacts/fixture-art", ignore_errors=True)
        bests = {"p5": {"id": "fixture-art", "mean": 8, **QUALITY_MARKERS}}
        row = {"event_type": "artifact_scored", "artifact": "fixture-art",
               "domain": "p5", "axes": "D=8 A=8 R=8 N=8", **QUALITY_FIELDS}
        files = {key: "[]" for key in ("beads", "threads", "moves", "plates")}
        files.update(bests=json.dumps(bests), elo="{}", frontier="[]", trend=json.dumps(row))
        machine = dict(name="Fixture", rows=[row], moves=0, bests=bests, files=files,
                       partial=False, rowDrops=0, fileErrors={})

        def run(command, **kwargs):
            import subprocess
            if command[0] == "ssh":
                self.assertIn("test -d", command[-1])
                self.assertIn("test -r", command[-1])
                self.assertIn("test -x", command[-1])
                self.assertIn(f"exit {fleet.ARTIFACT_MISSING_RC}", command[-1])
                if remote_probe_rc is not None:
                    return subprocess.CompletedProcess(command, remote_probe_rc)
                filename = next(name for name in ("playable.html", "source.txt", "provenance.txt") if name in command[-1])
                missing = fleet.ARTIFACT_MISSING_RC if filename == "provenance.txt" and not remote_provenance else 0
                return subprocess.CompletedProcess(command, missing)
            if command[0] == "scp":
                filename = command[-2].rsplit("/", 1)[-1]
                if filename == scp_failure:
                    return subprocess.CompletedProcess(command, 1)
                Path(command[-1]).write_text("remote fixture")
                return subprocess.CompletedProcess(command, 0)
            raise AssertionError("unexpected transport command")

        with patch.object(fleet, "MACHINES", [("Fixture", "fixture:user")]), \
             patch.object(fleet, "CACHE", self.root / "cache"), \
             patch.object(fleet, "collect", return_value=machine), \
             patch.object(fleet, "load_retired_machines", return_value=[]), \
             patch.object(fleet, "push_trend"), \
             patch.object(fleet.time, "sleep", side_effect=StopIteration), \
             patch.object(fleet.subprocess, "run", side_effect=run):
            with self.assertRaises(StopIteration):
                fleet.refresher()
        folder = self.root / ".omx/atelier/fleet"
        return tuple(json.loads((folder / name).read_text())
                     for name in ("fleet.json", "snapshot.json"))

    def test_missing_provenance_is_explicit_and_recovers(self):
        first, first_snapshot = self.run_artifact_cycle(remote_provenance=False)
        key = "Fixture:fixture-art/provenance.txt"
        self.assertEqual(first["artifactTransferErrors"], {})
        self.assertEqual(first["provenanceUnavailable"], {key: "missing"})
        self.assertEqual(first_snapshot["provenanceUnavailable"], {key: "missing"})
        self.assertTrue(first["partial"])

        recovered, recovered_snapshot = self.run_artifact_cycle(remote_provenance=True)
        self.assertEqual(recovered["artifactTransferErrors"], {})
        self.assertEqual(recovered["provenanceUnavailable"], {})
        self.assertEqual(recovered_snapshot["provenanceUnavailable"], {})
        self.assertTrue((self.root / ".omx/atelier/fleet/merged/artifacts/fixture-art/provenance.txt").is_file())

    def test_required_artifact_and_optional_transport_failures_stay_errors(self):
        for filename in ("playable.html", "source.txt", "provenance.txt"):
            with self.subTest(filename=filename):
                report, snapshot = self.run_artifact_cycle(scp_failure=filename, reset=True)
                key = "Fixture:fixture-art/" + filename
                self.assertEqual(report["artifactTransferErrors"][key], "RuntimeError")
                self.assertEqual(report["provenanceUnavailable"], {})
                self.assertEqual(snapshot["artifactTransferErrors"][key], "RuntimeError")

    def test_remote_probe_failures_stay_transfer_errors(self):
        expected = {"Fixture:fixture-art/" + name for name in
                    ("playable.html", "source.txt", "provenance.txt")}
        for label, code in (("shell failure", 1), ("ssh failure", 255),
                            ("inaccessible directory", fleet.ARTIFACT_PROBE_UNAVAILABLE_RC)):
            with self.subTest(label=label):
                report, snapshot = self.run_artifact_cycle(remote_probe_rc=code, reset=True)
                self.assertEqual(set(report["artifactTransferErrors"]), expected)
                self.assertEqual(report["provenanceUnavailable"], {})
                self.assertEqual(set(snapshot["artifactTransferErrors"]), expected)

    def test_confirmed_missing_required_files_remain_errors(self):
        report, snapshot = self.run_artifact_cycle(remote_probe_rc=fleet.ARTIFACT_MISSING_RC)
        required = {"Fixture:fixture-art/" + name: "ArtifactMissing"
                    for name in ("playable.html", "source.txt")}
        optional = {"Fixture:fixture-art/provenance.txt": "missing"}
        for payload in (report, snapshot):
            self.assertEqual(payload["artifactTransferErrors"], required)
            self.assertEqual(payload["provenanceUnavailable"], optional)
            self.assertTrue(payload["partial"])

    def test_scorecard_index_matches_canonical_rows_within_window(self):
        def scored(artifact, value, stamp=None, domain="p5", model="old"):
            return {"event_type": "artifact_scored", "artifact": artifact,
                    "axes": " ".join(f"{key}={value}" for key in "DARN"),
                    "ts": stamp, "domain": domain, "model": model, **QUALITY_FIELDS}
        # The canonical dated row lies outside the 100-row membership window;
        # its older duplicate still selects that ID for the scorecard index.
        rows = [scored("dated", 9, "2026-09-05T02:00:00Z", "svg", "new")]
        rows += [{"event_type": "generation_started"} for _ in range(101)]
        rows += [scored("dated", 1, "2026-09-05T01:00:00Z"),
                 scored("undated", 2), scored("undated", 8, domain="tone", model="latest")]
        document, snapshot = self.run_synthetic_cycle(rows=rows)
        recent = {row["id"]: row for row in document["recent"]}
        index = {row["id"]: row for row in snapshot["scorecardIndex"]}
        self.assertEqual(document["totalScored"], 2)
        self.assertEqual(snapshot["scorecardWindow"], {"perMachine": 100, "rows": 2})
        self.assertEqual(set(index), {"dated", "undated"})
        for identity in index:
            self.assertEqual(index[identity], {key: recent[identity][key]
                                              for key in ("id", "domain", "model", "axes")})
        self.assertEqual(index["dated"]["axes"], "D=9 A=9 R=9 N=9")
        self.assertEqual(index["undated"]["axes"], "D=8 A=8 R=8 N=8")

    def test_quality_admission_keeps_raw_rows_but_filters_unsupported_derivations(self):
        def row(artifact, judges="valid", markers=True):
            value = {"event_type": "artifact_scored", "artifact": artifact,
                     "axes": "D=8 A=8 R=8 N=8"}
            if judges != "missing":
                value["judges"] = (["judge-one", "judge-two"] if judges == "valid" else judges)
            if markers:
                value.update(QUALITY_MARKERS)
            return value
        rows = [row("one", ["judge-one"]), row("missing", "missing"),
                row("non-list", "not-a-list"),
                row("duplicate", ["zai/GLM", "glm"]), row("valid"),
                row("object", [{"vendor": "zai/GLM"}, {"vendor": "gemini"}]),
                row("/runtime/artifacts/full-path-id/playable.html"),
                row("scale-old", ["judge-one", "judge-two"], markers=False)]
        bests = {name: {"id": name, "mean": 8, **QUALITY_MARKERS}
                 for name in ("one", "valid", "object", "scale-old")}
        bests["full"] = {"id": "/runtime/artifacts/full-path-id/playable.html",
                          "mean": 8, **QUALITY_MARKERS}
        elo = {name: {"rating": 1000, **QUALITY_MARKERS}
               for name in ("one", "valid", "scale-old")}
        elo["/runtime/artifacts/full-path-id/playable.html"] = {"rating": 1001, **QUALITY_MARKERS}
        report, snapshot = self.run_synthetic_cycle(rows=rows, bests=bests, elo=elo)
        self.assertEqual(report["totalScored"], 3)
        self.assertTrue(report["partial"])
        self.assertEqual((report["judgeCoverageUnavailable"], report["judgeCoverageInsufficient"],
                          report["scoreScaleUnverified"]), (2, 2, 1))
        self.assertEqual({item["id"] for item in snapshot["scorecardIndex"]}, {"valid", "object", "full-path-id"})
        self.assertEqual(set(snapshot["bests"]), {"valid", "object", "full"})
        self.assertEqual(set(snapshot["elo"]), {"valid", "/runtime/artifacts/full-path-id/playable.html"})
        self.assertEqual(len((self.root / ".omx/atelier/fleet/merged/trend.jsonl").read_text().splitlines()), 8)

    def test_art_feed_best_playable_path_mirrors_artifact_directory(self):
        art_id = "a" * 64
        root = "/owner/runtime/artifacts"
        feed = {"name": "Fixture", "hostspec": "fixture:user", "artifacts": root,
                "root": "/owner/source", "worker": "Fixture"}
        row = {"event_type": "artifact_scored", "artifact": art_id,
               "axes": "D=8 A=8 R=8 N=8", **QUALITY_FIELDS}
        bests = {"p5": {"id": f"{root}/{art_id}/playable.html", "mean": 8,
                        **QUALITY_MARKERS}}
        files = {key: "[]" for key in ("beads", "threads", "moves", "plates")}
        files.update(bests=json.dumps(bests), elo="{}", frontier="[]", trend=json.dumps(row))
        machine = dict(name="Fixture", rows=[row], moves=0, bests=bests, files=files,
                       partial=False, rowDrops=0, fileErrors={})
        calls = []

        def mirror(host, artifact, filename, target, artifact_root):
            calls.append((host, artifact, filename, artifact_root))
            if artifact != art_id:
                raise RuntimeError("artifact directory is not the playable filename")
            target.write_text("original artwork evidence")

        with patch.object(fleet, "MACHINES", []), \
             patch.object(fleet, "art_feeds", return_value=[feed]), \
             patch.object(fleet, "CACHE", self.root / "cache"), \
             patch.object(fleet, "collect", return_value=machine), \
             patch.object(fleet, "load_retired_machines", return_value=[]), \
             patch.object(fleet, "push_trend"), \
             patch.object(fleet, "mirror_artifact", side_effect=mirror), \
             patch.object(fleet.time, "sleep", side_effect=StopIteration):
            with self.assertRaises(StopIteration):
                fleet.refresher()
        report = json.loads((self.root / ".omx/atelier/fleet/fleet.json").read_text())
        self.assertEqual(calls, [("fixture:user", art_id, name, root)
                                for name in ("playable.html", "source.txt", "provenance.txt")])
        self.assertEqual(report["artifactTransferErrors"], {})
        self.assertEqual(report["provenanceUnavailable"], {})
        self.assertEqual((self.root / ".omx/atelier/fleet/merged/artifacts" / art_id /
                          "playable.html").read_text(), "original artwork evidence")

    def test_unverified_best_keeps_archive_provenance_probe(self):
        row = {"event_type": "artifact_scored", "artifact": "legacy-art",
               "axes": "D=8 A=8 R=8 N=8", "judges": ["one"], **QUALITY_MARKERS}
        bests = {"p5": {"id": "legacy-art", "mean": 8, **QUALITY_MARKERS}}
        files = {key: "[]" for key in ("beads", "threads", "moves", "plates")}
        files.update(bests=json.dumps(bests), elo="{}", frontier="[]", trend=json.dumps(row))
        machine = dict(name="Fixture", rows=[row], moves=0, bests=bests, files=files,
                       partial=False, rowDrops=0, fileErrors={})
        calls = []

        def mirror(_host, artifact, filename, target):
            calls.append((artifact, filename))
            if filename == "provenance.txt":
                raise fleet.ArtifactMissing
            target.write_text("legacy archive")

        with patch.object(fleet, "MACHINES", [("Fixture", "fixture:user")]), \
             patch.object(fleet, "CACHE", self.root / "cache"), \
             patch.object(fleet, "collect", return_value=machine), \
             patch.object(fleet, "load_retired_machines", return_value=[]), \
             patch.object(fleet, "push_trend"), \
             patch.object(fleet, "mirror_artifact", side_effect=mirror), \
             patch.object(fleet.time, "sleep", side_effect=StopIteration):
            with self.assertRaises(StopIteration):
                fleet.refresher()
        report = json.loads((self.root / ".omx/atelier/fleet/fleet.json").read_text())
        snapshot = json.loads((self.root / ".omx/atelier/fleet/snapshot.json").read_text())
        self.assertEqual(calls, [("legacy-art", name) for name in ("playable.html", "source.txt", "provenance.txt")])
        self.assertEqual(snapshot["bests"], {})
        self.assertEqual(report["provenanceUnavailable"], {"Fixture:legacy-art/provenance.txt": "missing"})
        self.assertEqual(report["artifactTransferErrors"], {})
        self.assertEqual(len((self.root / ".omx/atelier/fleet/merged/trend.jsonl").read_text().splitlines()), 1)

    def test_merge_and_transfer_losses_mark_both_publications_partial(self):
        self.assertFalse(self.run_synthetic_cycle()[0]["partial"])
        for kwargs in ({"bad_child": True}, {"transfer": True,
                       "bests": {"p5": {"id": "fixture-art", "mean": 8}}}):
            with self.subTest(kwargs=kwargs):
                for report in self.run_synthetic_cycle(**kwargs):
                    self.assertTrue(report["partial"])
                    self.assertTrue(report["machines"][0]["partial"])
                    self.assertTrue(report.get("mergeDrops") or report.get("transferErrors"))

    def test_malformed_rankings_do_not_abort_refresh_or_replace_valid_zero(self):
        for invalid in ("broken", None, True, [], {}):
            with self.subTest(invalid=invalid):
                bests = {"bad": {"mean": invalid}, "good": {"id": "good", "mean": 0, **QUALITY_MARKERS}}
                elo = {"bad": {"rating": invalid}, "good": {"rating": 0, **QUALITY_MARKERS}}
                report, snapshot = self.run_synthetic_cycle(bests=bests, elo=elo,
                    rows=[{"event_type": "artifact_scored", "artifact": "good",
                           "axes": "D=0 A=0 R=0 N=0", **QUALITY_FIELDS}])
                self.assertTrue(report["partial"])
                self.assertEqual(snapshot["bests"], {"good": {"id": "good", "mean": 0, **QUALITY_MARKERS}})
                self.assertEqual(snapshot["elo"], {"good": {"rating": 0, **QUALITY_MARKERS}})
                self.assertEqual(report["mergeDrops"]["Fixture:bests-invalid"], 1)
                self.assertEqual(report["mergeDrops"]["Fixture:elo-invalid"], 1)

    def test_nonfinite_json_files_are_reported_and_never_published_as_json(self):
        for invalid in (float("nan"), float("inf")):
            report, snapshot = self.run_synthetic_cycle(
                files_override={"beads": '[{"id":"bad","mean":NaN}]',
                    "bests": json.dumps({"bad": {"mean": invalid}}),
                    "elo": json.dumps({"bad": {"rating": invalid}})})
            self.assertTrue(report["partial"])
            self.assertEqual(snapshot["bests"], {})
            self.assertEqual(snapshot["elo"], {})
            self.assertEqual(snapshot["beads"], [])
            self.assertEqual(report["mergeDrops"]["Fixture:bests-unparsable"], 1)
            self.assertEqual(report["mergeDrops"]["Fixture:elo-unparsable"], 1)
            fleet.parse_json(json.dumps(snapshot, allow_nan=False))

    def test_overflow_json_is_dropped_before_refresh_publication(self):
        for payload in ('{"ts":1e400}', '{"nested":[-1e400]}'):
            with self.assertRaises(ValueError):
                fleet.parse_json(payload)
        atelier = self.root / ".omx/atelier"
        (atelier / "lessons").mkdir(parents=True)
        (atelier / "lessons/trend.jsonl").write_text(
            '{"artifact":"bad","event_type":"artifact_scored","ts":1e400}\n'
            '{"artifact":"valid","event_type":"artifact_scored","judges":["one","two"],'
            '"scoreScale":10,"scoringContract":"' + fleet.SCORE_CONTRACT + '"}\n')
        with patch.object(fleet, "MACHINES", [("Local", None)]), \
             patch.object(fleet, "CACHE", self.root / "cache"), \
             patch.object(fleet, "load_retired_machines", return_value=[]), \
             patch.object(fleet.time, "sleep", side_effect=StopIteration):
            with self.assertRaises(StopIteration):
                fleet.refresher()
        for name in ("fleet.json", "snapshot.json"):
            report = fleet.parse_json((atelier / "fleet" / name).read_text())
            self.assertTrue(report["partial"])
            self.assertEqual(report["totalScored"], 1)

    def test_out_of_range_trend_axes_do_not_count_as_scored(self):
        rows = [{"artifact": str(value), "event_type": "artifact_scored",
                 "axes": " ".join(f"{axis}={value}" for axis in "DARN"), **QUALITY_FIELDS}
                for value in (-1, 100, 0, 10)]
        report, snapshot = self.run_synthetic_cycle(rows=rows)
        self.assertTrue(report["partial"])
        self.assertEqual(report["totalScored"], 2)
        self.assertEqual({r["id"] for r in snapshot["scorecardIndex"]}, {"0", "10"})

    def test_elo_merge_keeps_maximum_across_scalar_and_object_ratings(self):
        _, snapshot = self.run_synthetic_cycle(elo={"shared": {"rating": 1200, **QUALITY_MARKERS}},
                                               peer_elo={"shared": {"rating": 1400, **QUALITY_MARKERS}}, rows=[
                                                   {"event_type": "artifact_scored", "artifact": "shared",
                                                    "axes": "D=7 A=7 R=7 N=7", **QUALITY_FIELDS}])
        self.assertEqual(snapshot["elo"], {"shared": {"rating": 1400, **QUALITY_MARKERS}})

    def test_hostile_trend_metadata_preserves_valid_scores_without_crashing(self):
        rows = [{"artifact": "valid", "event_type": "artifact_scored",
                 "axes": "D=7 A=7 R=7 N=7", "domain": {"bad": 1},
                 "prompt": ["bad"], "model": {"bad": 1}, "ts": 10**400,
                 **QUALITY_FIELDS},
                {"artifact": "invalid", "event_type": "artifact_scored", "axes": {"bad": 1}}]
        report, snapshot = self.run_synthetic_cycle(rows=rows)
        self.assertTrue(report["partial"])
        self.assertEqual(report["totalScored"], 1)
        self.assertEqual(report["domains"], {"unknown": 1})
        self.assertEqual([row["id"] for row in snapshot["scorecardIndex"]], ["valid"])

    def test_malformed_graph_identities_drop_without_losing_valid_neighbors(self):
        files = {"beads": json.dumps([{"id": ["bad"]}, {"id": "valid"}]),
                 "threads": json.dumps([{"a": {}, "b": "valid"}, {"a": "one", "b": "two"}]),
                 "frontier": json.dumps([{"beadA": [], "beadB": "valid"}])}
        report, snapshot = self.run_synthetic_cycle(files_override=files)
        self.assertTrue(report["partial"])
        self.assertEqual(snapshot["beads"], [{"id": "valid", "domain": "unknown"}])
        self.assertEqual(snapshot["threads"], [{"a": "one", "b": "two"}])
        for kind in ("beads", "threads", "frontier"):
            self.assertEqual(report["mergeDrops"][f"Fixture:{kind}-badidentity"], 1)

    def test_artifact_http_parity_and_containment(self):
        folder = self.root / ".omx/atelier/fleet/merged/artifacts/r13-valid"
        folder.mkdir(parents=True)
        body = b"<html>artifact fixture</html>"
        (folder / "playable.html").write_bytes(body)
        (folder / "provenance.txt").write_text(json.dumps({
            "identity": "provider/model", "request": {"model": "model", "private": "must not leak"},
            "private_path": "must not leak"}))
        (self.root / "secret.txt").write_text("not an artifact")
        (self.root / "sinter-command-center.html").write_text("dashboard")
        public_assets = ["sinter-viz-3d.html", "sinter-viz-landscape.html",
                         ".omx/atelier/rescue-pool/art.js", "vendor/d3/7.9.0/d3.min.js",
                         "vendor/three/0.160.0/three.module.js"]
        for name in public_assets:
            asset = self.root / name
            asset.parent.mkdir(parents=True, exist_ok=True)
            asset.write_text("public fixture")
        private_lineage = [".omx/atelier/rescue-pool/art.lineage.json",
                           ".omx/atelier/fleet/merged/artifacts/r13-valid/lineage.json"]
        for name in private_lineage:
            (self.root / name).write_text('{"originalFailure":{"prompt":"private fixture"}}')
        (self.root / "vendor/manifest.json").write_text(
            (Path(fleet.__file__).resolve().parents[2] / "vendor/manifest.json").read_text())
        private_vendor = [f"vendor/three/0.160.0/secret.{ext}" for ext in ("txt", "json", "html")]
        for name in private_vendor:
            (self.root / name).write_text("private fixture")
        (self.root / "vendor/three/0.160.0/folder.js").mkdir()
        (self.root / ".git").write_text("private git directory pointer")
        (folder.parent / "escape.json").symlink_to(self.root.parent / "outside.json")
        server = fleet.HTTPServer(("127.0.0.1", 0), fleet.Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            base = f"http://127.0.0.1:{server.server_port}"
            path = base + "/art/r13-valid/playable.html"
            self.assertEqual(self.request(base + "/sinter-command-center.html")[0], 200)
            self.assertEqual(self.request(base + "/")[0], 200)
            self.assertEqual(self.request(base + "/", method="HEAD")[0], 200)
            availability = base + "/api/artifact-availability?ids=r13-valid,missing"
            metadata = self.request(availability)
            self.assertEqual(metadata[0], 200)
            self.assertEqual(metadata[1].get("Cache-Control"), "no-store")
            self.assertEqual(json.loads(metadata[2]),
                     {"availability": {"r13-valid": True, "missing": False},
                      "recoveredText": {"r13-valid": False, "missing": False},
                              "provenance": {"r13-valid": {"identity": "provider/model", "model": "model"},
                                             "missing": None}})
            (folder / "provenance.txt").write_text("[]")
            self.assertIsNone(json.loads(self.request(availability)[2])["provenance"]["r13-valid"])
            self.assertEqual(self.request(availability, "HEAD")[2], b"")
            home = self.root / "home"
            for directory, art_id in ((self.root / ".omx/atelier/art-link/artifacts", "linked-art"),
                                      (home / ".sinter/output/artifacts", "home-art")):
                (directory / art_id).mkdir(parents=True)
                (directory / art_id / "playable.html").write_bytes(body)
            with patch.object(fleet.Path, "home", return_value=home):
                roots = self.request(base + "/api/artifact-availability?ids=linked-art,home-art")
                self.assertEqual(json.loads(roots[2]),
                     {"availability": {"linked-art": True, "home-art": True},
                      "recoveredText": {"linked-art": False, "home-art": False},
                                  "provenance": {"linked-art": None, "home-art": None}})
                for art_id in ("linked-art", "home-art"):
                    self.assertEqual(self.request(base + "/art/" + art_id + "/playable.html")[2], body)
            for query in ("", "ids=..", "ids=a%2Fb", "ids=a&ids=b", "ids=a&extra=1",
                          "ids=" + ",".join(str(i) for i in range(65))):
                self.assertEqual(self.request(base + "/api/artifact-availability?" + query)[0], 400)
            escape_target = self.root / "outside-artifact-roots"
            escape_target.mkdir()
            (escape_target / "playable.html").write_bytes(b"must not be served")
            (folder.parent / "escaped-id").symlink_to(escape_target)
            escaped = self.request(base + "/api/artifact-availability?ids=escaped-id")
            self.assertEqual(json.loads(escaped[2]), {"availability": {"escaped-id": False},
                                                     "provenance": {"escaped-id": None},
                                                     "recoveredText": {"escaped-id": False}})
            self.assertEqual(self.request(base + "/art/escaped-id/playable.html")[0], 404)
            ghosts = base + "/api/ghosts"
            self.assertEqual(self.request(ghosts)[1].get("Cache-Control"), "no-store")
            self.assertEqual(self.request(ghosts, "HEAD")[1].get("Cache-Control"), "no-store")
            self.assertEqual(json.loads(self.request(ghosts)[2]),
                             {"available": False, "entries": []})
            ghost_root = self.root / ".omx/atelier/rejects/code/rescue/ghost-alive-v2"
            (ghost_root / "r1").mkdir(parents=True)
            (ghost_root / "private").mkdir()
            (ghost_root / "r2").symlink_to(self.root.parent)
            self.assertEqual(json.loads(self.request(ghosts)[2]),
                             {"available": True, "entries": ["r1"]})
            self.assertEqual(self.request(ghosts, "HEAD")[2], b"")
            for name in public_assets:
                for method in ("GET", "HEAD"):
                    self.assertEqual(self.request(base + "/" + name, method)[0], 200, name)
            listing = self.request(base + "/.omx/atelier/rescue-pool/")[2]
            self.assertIn(b'art.js', listing)
            self.assertNotIn(b'lineage', listing)
            for hidden in ["/secret.txt", "/.git", "/scripts/atelier/fleet-server.py",
                           *("/" + name for name in private_lineage),
                           "/.omx/atelier/rescue-pool/art.Lineage.json",
                           "/.omx/atelier/fleet/merged/artifacts/r13-valid/LINEAGE.json",
                           "/vendor/three/0.160.0/", *("/" + name for name in private_vendor),
                           "/vendor/three/0.160.0/folder.js/",
                           "/.omx/atelier/fleet/merged/escape.json",
                           "/.omx/atelier/fleet/merged/%2e%2e/%2e%2e/secret.txt"]:
                for method in ["GET", "HEAD"]:
                    self.assertEqual(self.request(base + hidden, method)[0], 404)
            for suffix in ["", "?refresh=1", "?prompt=ignore%20instructions"]:
                get = self.request(path + suffix)
                head = self.request(path + suffix, "HEAD")
                self.assertEqual((get[0], head[0]), (200, 200))
                self.assertEqual(get[2], body)
                self.assertEqual(head[2], b"")
                self.assertEqual(get[1]["Content-Length"], head[1]["Content-Length"])
            for path in ["/art/%2e%2e/secret.txt", "/art/r13-valid/playable.html/extra",
                         "/art/r13-valid/secret.txt", "/art/missing/playable.html"]:
                self.assertEqual(self.request(base + path)[0], 404)
                self.assertEqual(self.request(base + path, "HEAD")[0], 404)
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=3)
            self.assertFalse(thread.is_alive())


if __name__ == "__main__":
    unittest.main()
