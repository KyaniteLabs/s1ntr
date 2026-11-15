"""Serve synthetic dashboard data with the actual restricted HTTP handler."""
import importlib.util
import json
from pathlib import Path
import shutil
import signal
import sys
import tempfile
from unittest.mock import patch
from datetime import datetime, timezone

REPO = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location("fleet", REPO / "scripts/atelier/fleet-server.py")
fleet = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fleet)


def main():
    with tempfile.TemporaryDirectory(prefix="liminal-dashboard-qa-") as tmp:
        root = Path(tmp)
        home_patch = patch.object(Path, 'home', return_value=root / 'fixture-home')
        home_patch.start()
        fleet.ROOT = root
        fleet.CACHE = root / "cache"
        atelier = root / ".omx/atelier"
        def save(relative, value):
            target = atelier / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(value if isinstance(value, str) else json.dumps(value))
        for name in ("sinter-command-center.html", "session-gallery.html",
                     "sinter-viz-3d.html", "sinter-viz-landscape.html"):
            shutil.copyfile(REPO / name, root / name)
        for name in ("vendor/d3/7.9.0", "vendor/three/0.160.0"):
            shutil.copytree(REPO / name, root / name)
        shutil.copyfile(REPO / "vendor/manifest.json", root / "vendor/manifest.json")
        now = datetime.now(timezone.utc).isoformat()
        beads = [{"id": "r13-one", "domain": "p5", "mean": 8, "axes": {"D": 8, "A": 8, "R": 8, "N": 8}},
                 {"id": "r13-two", "domain": "glsl", "mean": 7, "axes": {"D": 7, "A": 7, "R": 7, "N": 7}}]
        for relative in fleet.FILES.values():
            save(relative, {} if relative in ("best-per-domain.json", "elo.json") else [])
        save("game/beads.json", beads)
        markers = {"scoreScale": 10, "scoringContract": fleet.SCORE_CONTRACT}
        save("best-per-domain.json", {"p5": {"id": "r13-one", "mean": 8, "elo": 900, **markers}})
        save("elo.json", {"r13-one": {"rating": 1234, "games": 2, **markers}})
        save("lessons/bandit.json", {"posteriors": [{"a": 2, "b": 3}], "history": []})
        save("lessons/rescue.log", "")
        score_ms = int(datetime.fromisoformat(now).timestamp() * 1000) + 500
        rows = [{"event_type": "artifact_scored", "artifact": b["id"], "domain": b["domain"],
                 "ts": now, "axes": " ".join(f"{k}={v}" for k, v in b["axes"].items()) +
                 " | judges: eye-one+eye-two | defects: 0", "judges": ["eye-one", "eye-two"],
                 "scoreScale": 10, "scoringContract": fleet.SCORE_CONTRACT}
                for b in beads]
        save("lessons/trend.jsonl", "\n".join(map(json.dumps, rows)) + "\n")
        for index, bead in enumerate(beads):
            save(f"scorecards/score-{score_ms + index}.json",
                 {"artifact": bead["id"], "domain": bead["domain"], "ensemble": bead["axes"],
                  "judges": [{"vendor": name, "axes": bead["axes"]} for name in ("eye-one", "eye-two")],
                  "defects": [], "level": "A" if index == 0 else "B",
                  "scoreScale": 10, "scoringContract": fleet.SCORE_CONTRACT})
            for filename, content in (("playable.html", "<!doctype html><title>Fixture artifact</title><p>Fixture artwork</p>"),
                                      ("source.txt", "/* synthetic fixture source */"),
                                      ("provenance.txt", json.dumps({"identity": "fixture", "request": {"model": "fixture"}}))):
                save(f"art-link/artifacts/{bead['id']}/{filename}", content)
        for folder in ("third-judge", "second-judge", "improvements", "rescue-pool",
                       "rejects/code/rescue/ghost-alive-v2"):
            (atelier / folder).mkdir(parents=True, exist_ok=True)
        with patch.object(fleet, "MACHINES", [("Laptop (Air)", None)]), \
             patch.object(fleet, "load_retired_machines", return_value=[]), \
             patch.object(fleet.time, "sleep", side_effect=StopIteration), \
             patch.object(fleet.subprocess, "run", side_effect=AssertionError("fixture attempted transport")):
            try:
                fleet.refresher()
            except StopIteration:
                pass
        server = fleet.HTTPServer(("127.0.0.1", int(sys.argv[1])), fleet.Handler)
        def stop(*_):
            raise KeyboardInterrupt
        signal.signal(signal.SIGTERM, stop)
        print(f"Synthetic dashboard ready on port {server.server_port}", flush=True)
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            pass
        finally:
            server.server_close()
            home_patch.stop()


if __name__ == "__main__":
    main()
