"""Retention and single-writer guarantees for automatic dashboard refresh."""
import fcntl
import gzip
import hashlib
import inspect
import importlib.util
import json
import os
from pathlib import Path
import socketserver
import tempfile
import threading
import time
import unittest
import weakref
from types import SimpleNamespace
from unittest.mock import patch
from functools import partial
from http.client import HTTPConnection
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.request import urlopen

ROOT = Path(__file__).resolve().parents[3]


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


rebuild = load("dashboard_rebuild", ROOT / "scripts/atelier/rebuild-training-dashboard.py")
runner = load("dashboard_runner", ROOT / "scripts/atelier/auto-refresh-training-dashboard.py")
fleet = load("dashboard_fleet", ROOT / "scripts/atelier/fleet-server.py")
dashboard = load("dashboard_builder", ROOT / "tools/dashboards/build-training-dashboard.py")


class DashboardRefreshTest(unittest.TestCase):
    def test_native_artifact_clone_keeps_source_and_destination_writes_private(self):
        if dashboard.sys.platform != "darwin":
            self.skipTest("clonefile is available only on macOS")
        native = dashboard._clonefile_function()
        if native is None:
            self.skipTest("clonefile symbol is unavailable")
        with tempfile.TemporaryDirectory() as tmp:
            source, target = Path(tmp) / "source", Path(tmp) / "target"
            original = b"synthetic artifact body"
            source.write_bytes(original)
            results = []

            def observed_clonefile(src, dst, flags):
                result = native(src, dst, flags)
                results.append(result)
                return result

            with patch.object(dashboard, "_clonefile_function", return_value=observed_clonefile):
                dashboard._copy_artifact(source, target)
            if results != [0]:
                self.skipTest("temporary volume does not support clonefile")
            target.write_bytes(b"destination changed")
            self.assertEqual(source.read_bytes(), original)
            source.write_bytes(b"source changed")
            self.assertEqual(target.read_bytes(), b"destination changed")

    def test_artifact_copy_uses_cached_clonefile_abi_before_metadata_copy(self):
        with tempfile.TemporaryDirectory() as tmp:
            source, target = Path(tmp) / "source", Path(tmp) / "target"
            source.write_text("artifact body", encoding="utf-8")
            os.utime(source, ns=(1_700_000_000_000_000_000, 1_700_000_000_000_000_000))
            calls = []

            def clonefile(src, dst, flags):
                calls.append((os.fsdecode(src), os.fsdecode(dst), flags))
                target.write_bytes(Path(os.fsdecode(src)).read_bytes())
                return 0

            with patch.object(dashboard, "_clonefile_function", return_value=clonefile), \
                 patch.object(dashboard.shutil, "copy2", side_effect=AssertionError("fallback")):
                dashboard._copy_artifact(source, target)
            self.assertEqual(calls, [(str(source), str(target), 0)])
            self.assertEqual(target.read_bytes(), source.read_bytes())
            self.assertEqual(target.stat().st_mtime_ns, source.stat().st_mtime_ns)

    def test_artifact_copy_preserves_copy2_overwrite_for_existing_targets(self):
        with tempfile.TemporaryDirectory() as tmp:
            source, target = Path(tmp) / "source", Path(tmp) / "target"
            source.write_bytes(b"new artifact")
            target.write_bytes(b"old artifact")
            clonefile = patch.object(dashboard, "_clonefile_function", return_value=None)
            with clonefile, patch.object(dashboard.shutil, "copy2", wraps=dashboard.shutil.copy2) as copy2:
                dashboard._copy_artifact(source, target)
            copy2.assert_called_once_with(source, target)
            self.assertEqual(target.read_bytes(), source.read_bytes())

    def test_artifact_export_resolves_bases_once_and_preserves_copied_bodies(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp).resolve()
            base, out = root / "artifacts", root / "out"
            expected = {}
            for art_id in ("art-one", "art-two"):
                for name in ("playable.html", "source.txt", "provenance.txt"):
                    source = base / art_id / name
                    source.parent.mkdir(parents=True, exist_ok=True)
                    source.write_text(f"{art_id}:{name}", encoding="utf-8")
                    expected[f"{art_id}/{name}"] = source.read_text(encoding="utf-8")
            with patch.object(fleet, "ROOT", root), \
                 patch.object(fleet, "artifact_bases", return_value=[base]) as resolve_bases, \
                 patch.object(dashboard, "_clonefile_function", return_value=lambda *_: -1):
                copied, size = dashboard.export_artifacts(
                    fleet, {"art": {name: {"recoveredText": False}
                                    for name in ("art-one", "art-two")}, "meta": {}}, out)
            self.assertEqual(resolve_bases.call_count, 1)
            self.assertEqual(copied, 6)
            self.assertEqual(size, sum(len(body) for body in expected.values()))
            for relative, body in expected.items():
                self.assertEqual((out / "art" / relative).read_text(encoding="utf-8"), body)

    def artifact_embed(self, root, bases):
        fleet_path = root / ".omx/atelier/fleet/fleet.json"
        fleet_path.parent.mkdir(parents=True)
        fleet_path.write_text("{}", encoding="utf-8")
        with patch.object(fleet, "ROOT", root), \
             patch.object(fleet, "artifact_bases", return_value=bases), \
             patch.object(fleet, "history_payload", return_value={}):
            embed, _ = dashboard.build_embed(root, fleet)
        return embed

    def test_builder_uses_retained_provenance_after_empty_duplicate_root(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp).resolve()
            art_id = "a" * 64
            empty, retained = root / "merged", root / "retained"
            for base in (empty, retained):
                (base / art_id).mkdir(parents=True)
            receipt = {"identity": "retained/model", "request": {"model": "model"}}
            for filename, body in (("playable.html", "<html>retained</html>"),
                                   ("source.txt", "retained source"),
                                   ("provenance.txt", json.dumps(receipt))):
                (retained / art_id / filename).write_text(body, encoding="utf-8")
            embed = self.artifact_embed(root, [empty, retained])
            self.assertEqual(embed["art"][art_id], {
                "availability": True, "recoveredText": False,
                "provenance": {"identity": "retained/model", "model": "model"}})
            with patch.object(fleet, "artifact_bases", return_value=[empty, retained]):
                dashboard.export_artifacts(fleet, embed, root / "out")
            for filename in ("playable.html", "source.txt", "provenance.txt"):
                self.assertEqual((root / "out/art" / art_id / filename).read_bytes(),
                                 (retained / art_id / filename).read_bytes())

    def test_builder_never_pools_competing_or_symlinked_provenance(self):
        for symlinked in (False, True):
            with self.subTest(symlinked=symlinked), tempfile.TemporaryDirectory() as tmp:
                root = Path(tmp).resolve()
                art_id = "b" * 64
                primary, alternate = root / "primary", root / "alternate"
                for base in (primary, alternate):
                    (base / art_id).mkdir(parents=True)
                    (base / art_id / "playable.html").write_text(base.name, encoding="utf-8")
                receipt = alternate / art_id / "provenance.txt"
                receipt.write_text(json.dumps({"identity": "other/model"}), encoding="utf-8")
                if symlinked:
                    (primary / art_id / "provenance.txt").symlink_to(receipt)
                embed = self.artifact_embed(root, [primary, alternate])
                self.assertTrue(embed["art"][art_id]["availability"])
                self.assertIsNone(embed["art"][art_id]["provenance"])
                with patch.object(fleet, "artifact_bases", return_value=[primary, alternate]):
                    dashboard.export_artifacts(fleet, embed, root / "out")
                self.assertEqual((root / "out/art" / art_id / "playable.html").read_text(),
                                 "primary")
                self.assertFalse((root / "out/art" / art_id / "provenance.txt").exists())

    def test_builder_reuses_exact_fresh_history_projection_with_sync_statuses(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp).resolve()
            path = root / ".omx/atelier/fleet/merged/history.json"
            path.parent.mkdir(parents=True)
            payload = {"artifacts": [{"id": "art-1", "archivedSource": True}],
                       "scorecards": [{"file": "Air--score.json", "record": {"score": 7}}],
                       "sources": {"Air_ART_current": {"checkedAt": 123, "lastSuccess": 123,
                                                         "errors": {}, "worker": "PMA2"}},
                       "secondJudge": [], "thirdJudge": [], "quarantinedScorecards": [],
                       "quality": {"quarantinedRecords": 0, "quarantinedEntries": 0}}
            path.write_text(json.dumps(payload), encoding="utf-8")
            env = {"SINTER_DASHBOARD_HISTORY_PROJECTION": str(path),
                   "SINTER_DASHBOARD_HISTORY_PROJECTION_SHA256": hashlib.sha256(
                       path.read_bytes()).hexdigest()}
            with patch.object(fleet, "ROOT", root), patch.dict(os.environ, env), \
                 patch.object(fleet, "archive_sources", side_effect=AssertionError("archive re-read")):
                self.assertEqual(fleet.history_payload(), payload)

    def test_builder_rejects_changed_fresh_history_projection(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp).resolve()
            path = root / ".omx/atelier/fleet/merged/history.json"
            path.parent.mkdir(parents=True)
            path.write_text("{}", encoding="utf-8")
            digest = hashlib.sha256(path.read_bytes()).hexdigest()
            path.write_text('{"scorecards":[]}', encoding="utf-8")
            env = {"SINTER_DASHBOARD_HISTORY_PROJECTION": str(path),
                   "SINTER_DASHBOARD_HISTORY_PROJECTION_SHA256": digest}
            with patch.object(fleet, "ROOT", root), patch.dict(os.environ, env):
                with self.assertRaisesRegex(ValueError, "changed or failed verification"):
                    fleet.history_payload()

    def test_builder_rejects_projection_swapped_to_symlink_at_open(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp).resolve()
            path = root / ".omx/atelier/fleet/merged/history.json"
            path.parent.mkdir(parents=True)
            path.write_text("{}", encoding="utf-8")
            target = root / "attacker.json"
            target.write_text("{}", encoding="utf-8")
            digest = hashlib.sha256(path.read_bytes()).hexdigest()
            env = {"SINTER_DASHBOARD_HISTORY_PROJECTION": str(path),
                   "SINTER_DASHBOARD_HISTORY_PROJECTION_SHA256": digest}
            real_open = os.open

            def swap_then_open(name, flags, *args, **kwargs):
                if Path(name) == path:
                    path.unlink()
                    path.symlink_to(target)
                return real_open(name, flags, *args, **kwargs)

            with patch.object(fleet, "ROOT", root), patch.dict(os.environ, env), \
                 patch("os.open", side_effect=swap_then_open):
                with self.assertRaises(OSError):
                    fleet.history_payload()

    def test_projection_parent_walk_rejects_ancestor_symlink_for_pin_and_read(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp).resolve()
            fleet_dir = root / ".omx/atelier/fleet"
            fleet_dir.mkdir(parents=True)
            target_dir = root / "outside"
            target_dir.mkdir()
            payload = {"artifacts": [], "scorecards": [], "sources": {},
                       "secondJudge": [], "thirdJudge": [], "quarantinedScorecards": [],
                       "quality": {}}
            target = target_dir / "history.json"
            target.write_text(json.dumps(payload), encoding="utf-8")
            merged = fleet_dir / "merged"
            merged.symlink_to(target_dir, target_is_directory=True)
            path = merged / "history.json"
            env = {"SINTER_DASHBOARD_HISTORY_PROJECTION": str(path),
                   "SINTER_DASHBOARD_HISTORY_PROJECTION_SHA256": hashlib.sha256(
                       target.read_bytes()).hexdigest()}
            with patch.object(fleet, "ROOT", root), patch.dict(os.environ, env):
                with self.assertRaises(OSError):
                    fleet.read_regular_file_no_follow(path, root)
                with self.assertRaises(OSError):
                    fleet.history_payload()

    def page(self, out, record):
        out.mkdir(parents=True, exist_ok=True)
        embed = {"apis": {"history": {"scorecards": [record], "secondJudge": [], "thirdJudge": []}},
                 "art": {"a" * 64: {"availability": True}}}
        (out / "sinter-command-center.html").write_text(
            "window.__SINTER_EMBED__ = " + json.dumps(embed) + ";\n", encoding="utf-8")

    def test_failed_refresh_keeps_last_good_page(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            current, candidate = root / "current", root / ".training-dashboard-candidate-test"
            self.page(current, {"file": "old.json", "record": {"artifact": "old"}})
            self.page(candidate, {"file": "new.json", "record": {"artifact": "new"}})
            before = (current / "sinter-command-center.html").read_bytes()
            previous = rebuild.dashboard_snapshot(current)
            with self.assertRaisesRegex(ValueError, "lost 1 retained scorecards"):
                rebuild.validate_and_promote(previous, candidate, current)
            self.assertEqual((current / "sinter-command-center.html").read_bytes(), before)

    def test_projected_versions_survive_verbatim_on_both_pages_idempotently(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            old, candidate = root / "old", root / "candidate"
            previous = {"file": "same.json", "record": {"domain": "ascii",
                        "correction": "domain_mismatch"}}
            current = {"file": "same.json", "record": {"domain": "hyperframes"}}
            self.page(old, previous)
            self.page(candidate, current)
            gallery = candidate / "session-gallery.html"
            gallery.write_bytes((candidate / "sinter-command-center.html").read_bytes())
            snapshot = rebuild.dashboard_snapshot(old)
            rebuild.preserve_projected_history(snapshot, candidate)
            self.assertNotIn("history", snapshot)
            once = (candidate / "sinter-command-center.html").read_bytes()
            retained = rebuild.dashboard_snapshot(candidate)
            rebuild.assert_preserved(snapshot, retained)
            self.assertEqual(retained["history"]["scorecards"], [previous, current])
            self.assertEqual(gallery.read_bytes(), once)
            rebuild.preserve_projected_history(rebuild.dashboard_snapshot(old), candidate)
            self.assertEqual((candidate / "sinter-command-center.html").read_bytes(), once)

    def test_projected_judge_versions_survive_with_external_provenance(self):
        with tempfile.TemporaryDirectory() as tmp:
            old, candidate = Path(tmp) / "old", Path(tmp) / "candidate"
            old.mkdir()
            candidate.mkdir()
            prior = {"secondJudge": {"file": "second.json", "record": {"verdict": "old"}},
                     "thirdJudge": {"file": "third.json", "record": {"verdict": "old"}}}
            fresh = {"secondJudge": {"file": "second.json", "record": {"verdict": "new"}},
                     "thirdJudge": {"file": "third.json", "record": {"verdict": "new"}}}
            for directory, rows in ((old, prior), (candidate, fresh)):
                history = {"scorecards": [], **{name: [row] for name, row in rows.items()}}
                embed = {"apis": {"history": history}, "art": {}}
                (directory / "sinter-command-center.html").write_text(
                    "window.__SINTER_EMBED__ = " + json.dumps(embed) + ";\n", encoding="utf-8")
            (candidate / "session-gallery.html").write_bytes(
                (candidate / "sinter-command-center.html").read_bytes())
            snapshot = rebuild.dashboard_snapshot(old)
            rebuild.preserve_projected_history(snapshot, candidate)
            retained = rebuild.dashboard_snapshot(candidate)
            for family in ("secondJudge", "thirdJudge"):
                self.assertEqual(retained["history"][family], [prior[family], fresh[family]])
                self.assertEqual(prior[family]["record"], {"verdict": "old"})
            rebuild.assert_preserved(snapshot, retained)
            self.assertEqual((candidate / "session-gallery.html").read_bytes(),
                             (candidate / "sinter-command-center.html").read_bytes())
            page = (candidate / "sinter-command-center.html").read_text(encoding="utf-8")
            embed = json.loads(page.split("window.__SINTER_EMBED__ = ", 1)[1].split(";\n", 1)[0])
            markers = embed["meta"]["retainedProjectedVersions"].values()
            self.assertEqual({marker["family"] for marker in markers}, {"secondJudge", "thirdJudge"})

    def test_refresh_summary_releases_full_history_before_build(self):
        class History(dict):
            pass

        other = History({"untouched": True})

        class FakeFleet:
            ROOT = Path("/owned/stage")

            def __init__(self):
                self.history_ref = None
                self.HISTORY_PUBLIC_CACHE = {"/other/root": other}

            def refresh_history_once(self):
                payload = History({"scorecards": [{"score": 7}],
                                   "sources": {"Air_ART": {"errors": {}, "checkedAt": 1,
                                                              "lastSuccess": 1},
                                               "archive": {"errors": {"sync": "timeout"}}}})
                self.history_ref = weakref.ref(payload)
                self.HISTORY_PUBLIC_CACHE[str(self.ROOT)] = payload
                return payload

            def refresher(self, once):
                return {"totalScored": 1, "partial": True}

        source = FakeFleet()
        summary = rebuild.refresh_history_summary(source, [{"name": "Air_ART"}])
        self.assertEqual(summary, (1, {"archive": {"sync": "timeout"}}, 1, True))
        self.assertNotIn(str(source.ROOT), source.HISTORY_PUBLIC_CACHE)
        self.assertIs(source.HISTORY_PUBLIC_CACHE["/other/root"], other)
        self.assertIsNone(source.history_ref())

    def test_changed_bytes_at_a_retained_body_path_block_promotion(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            old, candidate = root / "old", root / "candidate"
            record = {"file": "same.json", "record": {"artifact": "same"}}
            self.page(old, record)
            self.page(candidate, record)
            rel = Path("art") / ("a" * 64) / "source.txt"
            for directory, content in ((old, "original bytes"), (candidate, "changed bytes")):
                body = directory / rel
                body.parent.mkdir(parents=True, exist_ok=True)
                body.write_text(content, encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "changed 1 retained body files"):
                rebuild.assert_preserved(rebuild.dashboard_snapshot(old),
                                         rebuild.dashboard_snapshot(candidate))

    def test_candidate_cleanup_refuses_paths_outside_owned_parent(self):
        with tempfile.TemporaryDirectory() as tmp:
            outside = Path(tmp) / "valuable"
            outside.mkdir()
            with self.assertRaisesRegex(ValueError, "unsafe candidate cleanup"):
                rebuild.cleanup_candidate(outside, Path(tmp) / "other")
            self.assertTrue(outside.is_dir())

    def test_preservation_guard_covers_judges_artwork_and_bodies(self):
        previous = {"records": {"scorecards": set(), "secondJudge": {"old-second"},
                                 "thirdJudge": {"old-third"}},
                    "artifacts": {"old-art"}, "bodies": {"art/old-art/source.txt": "sha"}}
        candidate = {"records": {"scorecards": set(), "secondJudge": set(), "thirdJudge": set()},
                     "artifacts": {"old-art"}, "bodies": {"art/old-art/source.txt": "sha"}}
        with self.assertRaisesRegex(ValueError, "secondJudge"):
            rebuild.assert_preserved(previous, candidate)
        candidate["records"]["secondJudge"].add("old-second")
        with self.assertRaisesRegex(ValueError, "thirdJudge"):
            rebuild.assert_preserved(previous, candidate)
        candidate["records"]["thirdJudge"].add("old-third")
        candidate["artifacts"].clear()
        with self.assertRaisesRegex(ValueError, "artifacts"):
            rebuild.assert_preserved(previous, candidate)
        candidate["artifacts"].add("old-art")
        candidate["bodies"].clear()
        with self.assertRaisesRegex(ValueError, "bodies"):
            rebuild.assert_preserved(previous, candidate)
        candidate["bodies"]["art/old-art/source.txt"] = "sha"
        self.assertIsNone(rebuild.assert_preserved(previous, candidate))
        candidate["bodies"]["art/old-art/source.txt"] = "changed-sha"
        with self.assertRaisesRegex(ValueError, "changed 1 retained body"):
            rebuild.assert_preserved(previous, candidate)

    def test_optional_telemetry_errors_do_not_block_healthy_current_art(self):
        feeds = [{"name": "Air ART"}]
        sources = {"Air_ART": {"checkedAt": 12, "lastSuccess": 12, "errors": {}},
                   "Nucbox": {"errors": {"trend": "transfer_failed"}}}
        self.assertEqual(rebuild.art_transfer_errors(feeds, sources), {})
        sources["Air_ART"]["errors"] = {"artifacts": "transfer_failed"}
        self.assertTrue(rebuild.art_transfer_errors(feeds, sources))

    def test_history_quarantines_unsupported_refs_without_losing_raw_rows(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / "history-root"
            archive = root / ".omx/atelier/fleet/archive"
            files = []
            for source in ("Air_ART_current", "HTML_ART"):
                folder = archive / source
                (folder / "scorecards").mkdir(parents=True)
                (folder / "status.json").write_text(json.dumps({"checkedAt": 123, "lastSuccess": 122, "errors": {}}))
                for stamp in (1790661495590, 1790664010779):
                    row = {"artifact": "playable.html", "domain": "html", "scoredAt": stamp,
                           "ensemble": {"D": 5}}
                    path = folder / "scorecards" / f"score-{stamp}.json"
                    path.write_text(json.dumps(row)); files.append(path)
            feeds = [{"name": "Air ART current", "hostspec": None, "root": "/tmp/air",
                      "artifacts": "/tmp/air/artifacts", "worker": "PMA2"}]
            with patch.object(fleet, "ROOT", root), patch.object(fleet, "artifact_bases", return_value=[]), \
                 patch.dict(fleet.HISTORY_SYNC_STATUS, {str(root): {
                     "HTML_ART": {"checkedAt": 123, "lastSuccess": 122, "errors": {}},
                     "Air_ART_current": {"checkedAt": 123, "lastSuccess": 122,
                                         "errors": {}, "retained": True}}}), \
                 patch.dict(os.environ, {"SINTER_ART_FEEDS_JSON": json.dumps(feeds)}, clear=True):
                payload = fleet.history_payload()
            self.assertEqual(len(payload["scorecards"]), 4)
            self.assertEqual(payload["quality"], {"quarantinedRecords": 2, "quarantinedEntries": 4})
            self.assertEqual({x["reason"] for x in payload["quarantinedScorecards"]},
                             {"unsupported_artifact_reference"})
            hashes = {x["recordSha256"] for x in payload["quarantinedScorecards"]}
            self.assertEqual(len(hashes), 2)
            self.assertTrue(all(len(value) == 64 for value in hashes))
            self.assertEqual({Path(x["file"]).name for x in payload["quarantinedScorecards"]},
                             {path.parent.parent.name + "--" + path.name for path in files})
            self.assertEqual([json.loads(path.read_text())["scoredAt"] for path in files],
                             [1790661495590, 1790664010779] * 2)
            self.assertNotIn("retained", payload["sources"]["Air_ART_current"])
            self.assertTrue(payload["sources"]["HTML_ART"]["retained"])
            self.assertEqual(payload["sources"]["HTML_ART"]["retainedReason"],
                             "not_in_current_art_feeds")
            self.assertEqual((payload["sources"]["HTML_ART"]["checkedAt"],
                              payload["sources"]["HTML_ART"]["lastSuccess"]), (123, 122))

    def test_successful_promotion_keeps_one_rollback(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            current, candidate = root / "current", root / ".training-dashboard-candidate-test"
            current.mkdir()
            candidate.mkdir()
            (current / "build.txt").write_text("previous", encoding="utf-8")
            (candidate / "build.txt").write_text("new", encoding="utf-8")
            rebuild.promote_candidate(candidate, current)
            self.assertEqual((current / "build.txt").read_text(), "new")
            self.assertEqual((root / "current.rollback/build.txt").read_text(), "previous")

    def test_command_center_template_renders_feed_count_and_quarantine(self):
        template = (ROOT / "sinter-command-center.html").read_text(encoding="utf-8")
        self.assertIn("window.__SINTER_EMBED__?.meta?.artFeedCount", template)
        self.assertIn("configured ART source feeds · retained history", template)
        self.assertIn("some(s=>s?.retained!==true&&historyErrorCount(s?.errors)>0)", template)
        self.assertIn("quarantined source entries", template)

    def test_ui_update_sets_feed_count_and_head_reload_with_scroll_restore(self):
        with tempfile.TemporaryDirectory() as tmp:
            out = Path(tmp)
            page = out / "sinter-command-center.html"
            page.write_text('<!doctype html><html><body>\n<script>window.__SINTER_EMBED__ = '
                            '{"apis":{"history":{"scorecards":[],"sources":{} }},"files":{"body":"</script><body>"},"art":{}};\n'
                            '</script></body></html>')
            feeds = [{"name": "Air ART current", "hostspec": None, "root": "/tmp/air",
                      "artifacts": "/tmp/air/artifacts", "worker": "PMA2"}]
            validate = rebuild.validate_inline_scripts

            def validate_after_release(page):
                caller = inspect.currentframe().f_back
                self.assertEqual(caller.f_code.co_name, "update_dashboard_ui")
                self.assertNotIn("html", caller.f_locals)
                self.assertNotIn("payload", caller.f_locals)
                validate(page)

            with patch.dict(os.environ, {"SINTER_ART_FEEDS_JSON": json.dumps(feeds)}), \
                 patch.object(rebuild, "validate_inline_scripts", new=validate_after_release):
                rebuild.update_dashboard_ui(out)
            html = page.read_text()
            marker = "window.__SINTER_EMBED__ = "
            embed_start = html.index(marker) + len(marker)
            embed = json.loads(html[embed_start:html.index(";\n", embed_start)])
            self.assertEqual(embed["meta"]["artFeedCount"], 1)
            self.assertIn('"body":"\\u003c/script>\\u003cbody>"', html)
            self.assertEqual(html.count("window.setInterval(check, 60000)"), 1)
            self.assertIn("req.open('HEAD'", html)
            self.assertIn("window.setInterval(check, 60000)", html)
            self.assertIn("if (document.hidden) return", html)
            self.assertIn("sessionStorage.setItem", html)
            self.assertLess(html.index("</script><script>"), html.index("dashboard-scroll:"))

    def test_disk_preflight_refuses_to_start_below_reserve(self):
        with tempfile.TemporaryDirectory() as tmp, patch.object(rebuild.shutil, "disk_usage") as usage:
            usage.return_value = SimpleNamespace(free=10)
            with self.assertRaisesRegex(OSError, "needs 20 free bytes"):
                rebuild.assert_free_space([tmp], minimum=20)

    def test_running_cycle_skips_when_another_writer_holds_lock(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            stage, wrapper, output = root / "input", root / "run-budgeted.py", root / "current"
            wrapper.touch()
            lock_path = root / ".current.refresh.lock"
            with lock_path.open("a") as lock:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                args = SimpleNamespace(stage=str(stage), out=str(output), budget_wrapper=str(wrapper))
                with patch.object(runner.subprocess, "run") as execute:
                    self.assertEqual(runner.run_cycle(args), 75)
                    execute.assert_not_called()

    def test_shutdown_waits_for_budget_wrapper_and_releases_refresh_lock(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            wrapper, ready, stopped = root / "wrapper.py", root / "ready", root / "stopped"
            wrapper.write_text("import os,signal,time\nfrom pathlib import Path\n"
                "signal.signal(signal.SIGTERM, lambda *_: (Path(os.environ['STOPPED']).touch(), exit(0)))\n"
                "Path(os.environ['READY']).touch()\nwhile True: time.sleep(.05)\n")
            stop = threading.Event()
            args = SimpleNamespace(stage=str(root / "stage"), out=str(root / "current"),
                                   budget_wrapper=str(wrapper), historical_root="unused",
                                   nucbox_hostspec="unused")
            with patch.dict(os.environ, {"READY": str(ready), "STOPPED": str(stopped)}):
                result = []
                worker = threading.Thread(target=lambda: result.append(runner.run_cycle(args, stop)))
                worker.start()
                for _ in range(100):
                    if ready.exists():
                        break
                    time.sleep(.02)
                self.assertTrue(ready.exists())
                stop.set()
                worker.join(timeout=5)
            self.assertFalse(worker.is_alive())
            self.assertTrue(stopped.exists())
            self.assertEqual(result, [128 + runner.signal.SIGTERM])
            lock_path = root / ".current.refresh.lock"
            with lock_path.open("a") as lock:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)

    def test_existing_dashboard_server_disables_browser_caching(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            current = root / "current"
            current.mkdir()
            (current / "sinter-command-center.html").write_text("current", encoding="utf-8")
            handler = partial(runner.NoCacheHandler, directory=str(current))
            server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
            thread = threading.Thread(target=server.serve_forever, kwargs={"poll_interval": 0.01}, daemon=True)
            thread.start()
            try:
                with urlopen(f"http://127.0.0.1:{server.server_port}/sinter-command-center.html") as response:
                    self.assertEqual(response.headers.get("Cache-Control"),
                                     runner.REVALIDATE)
                    self.assertEqual(response.headers.get("Content-Type"), "text/html; charset=utf-8")
                    self.assertEqual(response.read(), b"current")
                promoted = root / "candidate"
                promoted.mkdir()
                (promoted / "sinter-command-center.html").write_text("promoted", encoding="utf-8")
                current.rename(root / "rollback")
                promoted.rename(current)
                with urlopen(f"http://127.0.0.1:{server.server_port}/sinter-command-center.html") as response:
                    self.assertEqual(response.read(), b"promoted")
            finally:
                server.shutdown()
                server.server_close()
                thread.join(timeout=2)


class DashboardServingTest(unittest.TestCase):
    """Serving layer: gzip, validators, conditional requests and cache bounds."""

    PAGE = "sinter-command-center.html"
    BODY = ("<script>window.__SINTER_EMBED__ = {"
            + json.dumps({"body": "x" * 40000})
            + "};</script>\n") * 40

    def setUp(self):
        self._cache = runner.CompressionCache()
        self._level = runner.DEFAULT_GZIP_LEVEL
        runner.DashboardHandler.cache = self._cache
        self._server = None

    def tearDown(self):
        if self._server is not None:
            self._server[0].shutdown()
            self._server[0].server_close()
            self._server[1].join(timeout=2)
        runner.DashboardHandler.cache = self._cache
        runner.DashboardHandler.gzip_level = self._level

    def serve(self, directory):
        runner.DashboardHandler.gzip_level = self._level
        self._cache.reset()
        server = ThreadingHTTPServer(("127.0.0.1", 0),
                                     partial(runner.DashboardHandler, directory=str(directory)))
        server.quiet = True
        thread = threading.Thread(target=server.serve_forever, kwargs={"poll_interval": 0.01}, daemon=True)
        thread.start()
        self._server = (server, thread)
        return server.server_port

    def request(self, port, method="GET", headers=None, path=None):
        connection = HTTPConnection("127.0.0.1", port, timeout=30)
        connection.putrequest(method, path or f"/{self.PAGE}", skip_accept_encoding=True)
        for name, value in (headers or {}).items():
            connection.putheader(name, value)
        connection.putheader("Connection", "close")
        connection.endheaders()
        response = connection.getresponse()
        body = response.read()
        status = response.status
        head = dict(response.getheaders())
        connection.close()
        return status, head, body

    def dashboard(self, tmp, body=None):
        directory = Path(tmp) / "current"
        directory.mkdir(exist_ok=True)
        raw = (body if body is not None else self.BODY).encode("utf-8")
        (directory / self.PAGE).write_bytes(raw)
        return directory, raw

    def test_gzip_shrinks_the_wire_body_and_decompresses_to_identical_bytes(self):
        with tempfile.TemporaryDirectory() as tmp:
            directory, raw = self.dashboard(tmp)
            port = self.serve(directory)
            status, headers, body = self.request(port, headers={"Accept-Encoding": "gzip"})
            self.assertEqual(status, 200)
            self.assertEqual(headers["Content-Encoding"], "gzip")
            self.assertEqual(headers["Vary"], "Accept-Encoding")
            self.assertEqual(int(headers["Content-Length"]), len(body))
            self.assertLess(len(body), len(raw) // 3)
            self.assertEqual(gzip.decompress(body), raw)

    def test_identity_client_still_receives_every_raw_byte(self):
        with tempfile.TemporaryDirectory() as tmp:
            directory, raw = self.dashboard(tmp)
            port = self.serve(directory)
            status, headers, body = self.request(port, headers={"Accept-Encoding": "identity"})
            self.assertEqual(status, 200)
            self.assertNotIn("Content-Encoding", headers)
            self.assertEqual(body, raw)

    def test_absent_accept_encoding_still_serves_every_raw_byte(self):
        with tempfile.TemporaryDirectory() as tmp:
            directory, raw = self.dashboard(tmp)
            port = self.serve(directory)
            status, _, body = self.request(port)
            self.assertEqual(status, 200)
            self.assertEqual(body, raw)

    def test_gzip_is_refused_when_the_client_declares_it_unacceptable(self):
        with tempfile.TemporaryDirectory() as tmp:
            directory, raw = self.dashboard(tmp)
            port = self.serve(directory)
            status, headers, body = self.request(port, headers={"Accept-Encoding": "gzip;q=0"})
            self.assertEqual(status, 200)
            self.assertNotIn("Content-Encoding", headers)
            self.assertEqual(body, raw)

    def test_weak_etag_and_last_modified_answer_conditional_get(self):
        with tempfile.TemporaryDirectory() as tmp:
            directory, raw = self.dashboard(tmp)
            port = self.serve(directory)
            _, headers, _ = self.request(port, headers={"Accept-Encoding": "gzip"})
            etag = headers["ETag"]
            self.assertTrue(etag.startswith("W/"))
            self.assertNotEqual(etag, headers.get("Last-Modified"))
            status, cached, body = self.request(port, headers={
                "Accept-Encoding": "gzip", "If-None-Match": etag})
            self.assertEqual(status, 304)
            self.assertEqual(body, b"")
            self.assertEqual(cached["ETag"], etag)
            status, _, body = self.request(port, headers={
                "Accept-Encoding": "gzip", "If-Modified-Since": headers["Last-Modified"]})
            self.assertEqual(status, 304)
            self.assertEqual(body, b"")
            status, _, body = self.request(port, headers={
                "Accept-Encoding": "gzip", "If-None-Match": 'W/"stale"'})
            self.assertEqual(status, 200)
            self.assertEqual(gzip.decompress(body), raw)

    def test_head_reports_gzip_length_without_a_body(self):
        with tempfile.TemporaryDirectory() as tmp:
            directory, _ = self.dashboard(tmp)
            port = self.serve(directory)
            status, headers, body = self.request(port, method="HEAD",
                                                 headers={"Accept-Encoding": "gzip"})
            self.assertEqual(status, 200)
            self.assertEqual(headers["Content-Encoding"], "gzip")
            self.assertEqual(body, b"")
            get_status, get_headers, get_body = self.request(port, headers={"Accept-Encoding": "gzip"})
            self.assertEqual(headers["Content-Length"], get_headers["Content-Length"])
            self.assertEqual(int(headers["Content-Length"]), len(get_body))

    def test_reloader_head_poll_still_sees_a_newer_page_after_promotion(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            directory, first = self.dashboard(root)
            port = self.serve(directory)
            _, before, _ = self.request(port, method="HEAD")
            self.assertNotIn("Content-Encoding", before)
            self.assertTrue(before["Last-Modified"])
            promoted = root / "candidate"
            promoted.mkdir()
            (promoted / self.PAGE).write_bytes((self.BODY + "<!-- newer -->").encode("utf-8"))
            os.utime(promoted / self.PAGE, (time.time() + 5, time.time() + 5))
            directory.rename(root / "rollback")
            promoted.rename(directory)
            status, after, body = self.request(port, method="HEAD")
            self.assertEqual(status, 200)
            self.assertEqual(body, b"")
            self.assertNotEqual(after["ETag"], before["ETag"])
            self.assertGreater(after["Last-Modified"], before["Last-Modified"])
            _, _, body = self.request(port, headers={"Accept-Encoding": "gzip"})
            self.assertIn(b"<!-- newer -->", gzip.decompress(body))

    def test_changed_bytes_with_same_size_invalidate_the_cached_body(self):
        with tempfile.TemporaryDirectory() as tmp:
            directory, _ = self.dashboard(tmp)
            port = self.serve(directory)
            _, _, first = self.request(port, headers={"Accept-Encoding": "gzip"})
            page = directory / self.PAGE
            page.write_bytes(b"z" * page.stat().st_size)
            os.utime(page, (time.time() + 5, time.time() + 5))
            _, _, second = self.request(port, headers={"Accept-Encoding": "gzip"})
            self.assertNotEqual(first, second)
            self.assertEqual(gzip.decompress(second), b"z" * page.stat().st_size)

    def test_repeated_requests_compress_once(self):
        with tempfile.TemporaryDirectory() as tmp:
            directory, raw = self.dashboard(tmp)
            port = self.serve(directory)
            self.request(port, headers={"Accept-Encoding": "gzip"})
            self.assertEqual(self._cache.compressions, 1)
            for _ in range(4):
                _, _, body = self.request(port, headers={"Accept-Encoding": "gzip"})
                self.assertEqual(gzip.decompress(body), raw)
            self.assertEqual(self._cache.compressions, 1)
            self.assertEqual(self._cache.hits, 4)

    def test_compression_cache_evicts_to_stay_within_its_bounds(self):
        cache = runner.CompressionCache(max_entries=2, max_bytes=1024)
        cache.put(("a", 1, 1), b"x" * 100)
        cache.put(("b", 1, 1), b"y" * 100)
        cache.put(("c", 1, 1), b"z" * 100)
        self.assertEqual(len(cache._entries), 2)
        self.assertIsNone(cache.get(("a", 1, 1)))
        self.assertIsNotNone(cache.get(("b", 1, 1)))
        self.assertLessEqual(cache.total_bytes, 1024)

    def test_concurrent_first_requests_compress_a_file_only_once(self):
        with tempfile.TemporaryDirectory() as tmp:
            directory, raw = self.dashboard(tmp, body=self.BODY * 4)
            port = self.serve(directory)
            results = []

            def fetch():
                results.append(self.request(port, headers={"Accept-Encoding": "gzip"})[2])

            threads = [threading.Thread(target=fetch) for _ in range(6)]
            for thread in threads:
                thread.start()
            for thread in threads:
                thread.join(timeout=60)
            self.assertEqual(len(results), 6)
            for body in results:
                self.assertEqual(gzip.decompress(body), raw)
            self.assertEqual(self._cache.compressions, 1)

    def test_prewarm_covers_both_pages_and_keeps_first_gallery_get_cached(self):
        with tempfile.TemporaryDirectory() as tmp:
            directory, _ = self.dashboard(tmp)
            gallery_raw = (self.BODY + "<!-- session gallery -->").encode("utf-8")
            (directory / "session-gallery.html").write_bytes(gallery_raw)
            self.assertEqual(runner.PREWARM_PAGES,
                             (self.PAGE, "session-gallery.html"))
            self.assertEqual(runner.DEFAULT_CACHE_ENTRIES, 8)
            self.assertEqual(runner.DEFAULT_CACHE_BYTES, 64 * 1024 ** 2)
            self.assertEqual(runner.prewarm(str(directory), runner.PREWARM_PAGES),
                             list(runner.PREWARM_PAGES))
            self.assertEqual(self._cache.compressions, 2)
            self.assertLessEqual(len(self._cache._entries), runner.DEFAULT_CACHE_ENTRIES)
            self.assertLessEqual(self._cache.total_bytes, runner.DEFAULT_CACHE_BYTES)
            port = self.serve_prewarmed(directory)
            _, headers, body = self.request(
                port, headers={"Accept-Encoding": "gzip"}, path="/session-gallery.html")
            self.assertEqual(headers["Content-Encoding"], "gzip")
            self.assertEqual(body, gzip.compress(gallery_raw, compresslevel=self._level, mtime=0))
            self.assertEqual(gzip.decompress(body), gallery_raw)
            self.assertEqual(self._cache.compressions, 2)
            self.assertEqual(self._cache.hits, 1)

    def serve_prewarmed(self, directory):
        runner.DashboardHandler.gzip_level = self._level
        server = ThreadingHTTPServer(("127.0.0.1", 0),
                                     partial(runner.DashboardHandler, directory=str(directory)))
        server.quiet = True
        thread = threading.Thread(target=server.serve_forever, kwargs={"poll_interval": 0.01}, daemon=True)
        thread.start()
        self._server = (server, thread)
        return server.server_port

    def test_gzip_level_zero_serves_every_raw_byte(self):
        with tempfile.TemporaryDirectory() as tmp:
            directory, raw = self.dashboard(tmp)
            runner.DashboardHandler.gzip_level = None
            server = ThreadingHTTPServer(("127.0.0.1", 0),
                                         partial(runner.DashboardHandler, directory=str(directory)))
            server.quiet = True
            thread = threading.Thread(target=server.serve_forever, kwargs={"poll_interval": 0.01}, daemon=True)
            thread.start()
            self._server = (server, thread)
            status, headers, body = self.request(server.server_port,
                                                headers={"Accept-Encoding": "gzip"})
            self.assertEqual(status, 200)
            self.assertNotIn("Content-Encoding", headers)
            self.assertEqual(body, raw)

    def test_missing_page_still_answers_404(self):
        with tempfile.TemporaryDirectory() as tmp:
            directory, _ = self.dashboard(tmp)
            port = self.serve(directory)
            status, _, _ = self.request(port, path="/absent.html")
            self.assertEqual(status, 404)

    def test_directory_listing_still_works(self):
        with tempfile.TemporaryDirectory() as tmp:
            directory, _ = self.dashboard(tmp)
            (directory / "notes.txt").write_text("plain", encoding="utf-8")
            port = self.serve(directory)
            status, _, body = self.request(port, path="/")
            self.assertEqual(status, 200)
            self.assertIn(b"sinter-command-center.html", body)

    def test_collector_warms_private_gallery_response_once(self):
        with tempfile.TemporaryDirectory() as tmp:
            directory, _ = self.dashboard(tmp)
            raw = (self.BODY + "<!-- gallery -->").encode("utf-8")
            (directory / "session-gallery.html").write_bytes(raw)
            port = self.serve_prewarmed(directory)
            origin = rebuild.parse_private_dashboard_origin(f"http://127.0.0.1:{port}")
            warmed_bytes = rebuild.warm_private_dashboard(origin)
            self.assertGreater(warmed_bytes, 0)
            status, headers, body = self.request(
                port, headers={"Accept-Encoding": "gzip"}, path="/session-gallery.html")
            self.assertEqual(status, 200)
            self.assertEqual(headers["Content-Encoding"], "gzip")
            self.assertEqual(gzip.decompress(body), raw)
            self.assertEqual(self._cache.compressions, 1)
            self.assertEqual(self._cache.hits, 1)

    def test_private_warmup_is_opt_in_fail_soft_and_rejects_public_origin(self):
        args = rebuild.build_argument_parser().parse_args(["--historical-root", "/tmp/history"])
        self.assertIsNone(args.private_dashboard_origin)
        origin = rebuild.parse_private_dashboard_origin("http://127.0.0.1:18767")
        self.assertIsNone(rebuild.prewarm_private_dashboard(None))
        with patch.object(rebuild, "warm_private_dashboard", side_effect=TimeoutError):
            self.assertIsNone(rebuild.prewarm_private_dashboard(origin))
        with self.assertRaises(rebuild.argparse.ArgumentTypeError):
            rebuild.parse_private_dashboard_origin("http://8.8.8.8:18767")

    def test_private_warmup_rejects_bad_or_oversized_responses(self):
        cases = ((200, "gzip", "32", b"x" * 32, 32),
                 (200, "gzip", "33", b"", None),
                 (200, "gzip", None, b"x" * 33, None),
                 (200, "gzip", "invalid", b"x", None),
                 (200, "gzip", "0", b"", None),
                 (200, "", "1", b"x", None),
                 (302, "gzip", "1", b"x", None))
        for status, encoding, length, body, expected in cases:
            with self.subTest(status=status, encoding=encoding, length=length):
                requests = []

                class ResponseHandler(BaseHTTPRequestHandler):
                    def do_GET(self):
                        requests.append(self.path)
                        self.send_response(status)
                        self.send_header("Content-Encoding", encoding)
                        self.send_header("Location", "/redirect-must-not-be-followed")
                        if length is not None:
                            self.send_header("Content-Length", length)
                        self.end_headers()
                        try:
                            self.wfile.write(body)
                        except OSError:
                            pass

                server = ThreadingHTTPServer(("127.0.0.1", 0), ResponseHandler)
                thread = threading.Thread(target=server.serve_forever, kwargs={"poll_interval": 0.01})
                thread.start()
                origin = rebuild.parse_private_dashboard_origin(
                    f"http://127.0.0.1:{server.server_port}")
                try:
                    with patch.object(rebuild, "MAX_PREWARM_BYTES", 32):
                        self.assertEqual(rebuild.prewarm_private_dashboard(origin), expected)
                    self.assertEqual(requests, ["/session-gallery.html"])
                finally:
                    server.shutdown()
                    server.server_close()
                    thread.join(timeout=2)

    def test_private_warmup_deadline_interrupts_dripping_headers_and_body(self):
        head = b"HTTP/1.1 200 OK\r\nContent-Encoding: gzip\r\n"
        chunked = head + b"Transfer-Encoding: chunked\r\nConnection: close\r\n\r\n"
        cases = ((head + b"X-Drip: ", b"\r\nContent-Length: 1\r\n\r\nx"),
                 (head + b"Content-Length: 24\r\nConnection: close\r\n\r\n", b""),
                 (chunked + b"1;", b"\r\nx\r\n0\r\n\r\n"),
                 (chunked + b"1\r\nx\r\n0\r\nX-Drip: ", b"\r\n\r\n"))
        for prefix, suffix in cases:
            with self.subTest(prefix=prefix):
                stopped = threading.Event()

                class DripHandler(BaseHTTPRequestHandler):
                    def do_GET(self):
                        try:
                            self.wfile.write(prefix)
                            for _ in range(24):
                                if stopped.wait(0.04):
                                    return
                                self.wfile.write(b"x")
                            self.wfile.write(suffix)
                        except OSError:
                            pass

                server = ThreadingHTTPServer(("127.0.0.1", 0), DripHandler)
                thread = threading.Thread(target=server.serve_forever, kwargs={"poll_interval": 0.01})
                thread.start()
                origin = rebuild.parse_private_dashboard_origin(
                    f"http://127.0.0.1:{server.server_port}")
                timers, sockets = [], []
                real_timer, real_dup = threading.Timer, rebuild.socket.socket.dup

                def track_timer(*args, **kwargs):
                    timer = real_timer(*args, **kwargs)
                    timers.append(timer)
                    return timer

                def track_dup(sock):
                    duplicate = real_dup(sock)
                    sockets.append(duplicate)
                    return duplicate

                try:
                    started = time.monotonic()
                    with patch.object(rebuild, "PREWARM_TIMEOUT_SECONDS", 0.2), \
                         patch.object(rebuild.threading, "Timer", side_effect=track_timer), \
                         patch.object(rebuild.socket.socket, "dup", new=track_dup):
                        self.assertIsNone(rebuild.prewarm_private_dashboard(origin))
                    self.assertLess(time.monotonic() - started, 0.7)
                    self.assertTrue(timers and sockets)
                    self.assertTrue(all(not timer.is_alive() for timer in timers))
                    self.assertTrue(all(sock.fileno() == -1 for sock in sockets))
                finally:
                    stopped.set()
                    server.shutdown()
                    server.server_close()
                    thread.join(timeout=2)

    def test_private_warmup_deadline_includes_connect_and_tls_handshake(self):
        stopped = threading.Event()

        class SilentTLSHandler(socketserver.BaseRequestHandler):
            def handle(self):
                self.request.recv(4096)
                stopped.wait(1)

        server = socketserver.ThreadingTCPServer(("127.0.0.1", 0), SilentTLSHandler)
        thread = threading.Thread(target=server.serve_forever, kwargs={"poll_interval": 0.01})
        thread.start()
        origin = rebuild.parse_private_dashboard_origin(
            f"https://127.0.0.1:{server.server_address[1]}")
        real_connect = rebuild.socket.create_connection

        def delayed_connect(*args, **kwargs):
            time.sleep(0.3)
            return real_connect(*args, **kwargs)

        try:
            started = time.monotonic()
            with patch.object(rebuild, "PREWARM_TIMEOUT_SECONDS", 0.5), \
                 patch.object(rebuild.socket, "create_connection", side_effect=delayed_connect):
                self.assertIsNone(rebuild.prewarm_private_dashboard(origin))
            self.assertLess(time.monotonic() - started, 0.7)
        finally:
            stopped.set()
            server.shutdown()
            server.server_close()
            thread.join(timeout=2)

    def test_private_warmup_connection_failure_closes_without_a_watchdog(self):
        origin = rebuild.parse_private_dashboard_origin("http://127.0.0.1:18767")
        real_close = HTTPConnection.close
        with patch.object(rebuild.socket, "create_connection", side_effect=ConnectionRefusedError), \
             patch.object(rebuild.threading, "Timer") as timer, \
             patch.object(HTTPConnection, "close", autospec=True, side_effect=real_close) as close:
            self.assertIsNone(rebuild.prewarm_private_dashboard(origin))
        close.assert_called_once()
        timer.assert_not_called()


if __name__ == "__main__":
    unittest.main()
