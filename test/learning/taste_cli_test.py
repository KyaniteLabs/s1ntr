"""Wall votes remain available for reports and cannot train the live taste profile through the CLI."""
import json
import os
import subprocess
import sys

import pytest

pytest.importorskip("numpy")
ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))

F = {"chroma_mean": .4, "chroma_p95": .5, "value_range": .7, "value_mean": .5, "value_std": .2, "edge_density": .3, "structure": .4,
     "palette_entropy": 2.0, "balance_x": .1, "balance_y": -.1, "right_bias": .5, "motion": .2, "blank": False}


def fixture(tmp):
    wall = tmp / "wall"; wall.mkdir(); ldir = tmp / "learning"; ldir.mkdir()
    data, cache, votes = [], {}, []
    for i in range(24):
        up = i % 2 == 0; uid = "u%02d" % i
        data.append({"uid": uid, "key": "seat", "id": "p%02d" % i, "take": 1, "rid": "fam%02d" % i, "prompt": "x", "domain": "p5", "score": .5, "status": "accepted"})
        f = dict(F); f["chroma_p95"] = .9 - 0.01 * i if up else .1 + 0.01 * i; f["edge_density"] = .5 if up else .1; f["value_range"] = .8 if up else .2
        cache[uid] = f; votes.append({"seat": "uid", "id": uid, "uid": uid, "vote": "up" if up else "down", "at": "2026-11-19T00:00:%02dZ" % i})
    (wall / "index.html").write_text('<html><script id="data" type="application/json">%s</script></html>' % json.dumps(data))
    (tmp / "ratings.jsonl").write_text("".join(json.dumps(v) + "\n" for v in votes))
    (tmp / "cache.json").write_text(json.dumps(cache))
    return wall, ldir


@pytest.mark.parametrize("command", ["train", "eval"])
def test_archive_taste_refuses_legacy_wall_options(tmp_path, command):
    wall, ldir = fixture(tmp_path)
    home = tmp_path / "home"
    home.mkdir()
    env = {k: v for k, v in os.environ.items() if not k.startswith(("SINTER_", "LIMINAL_", "ATELIER_", "LLM_", "HARNESS_", "EVALUATOR_"))
           and not k.endswith(("_API_KEY", "_AUTH_TOKEN", "_BASE_URL"))}
    env.update(HOME=str(home), USERPROFILE=str(home), SINTER_PROJECT_ROOT=str(tmp_path),
               SINTER_CONFIG_PATH=str(home / "no-config.json"), SINTER_PROOF_ISOLATION="1")
    result = subprocess.run(
        ["node", os.path.join(ROOT, "bin", "sinter"), "taste", command,
         "--ldir", str(ldir), "--wall", str(wall), "--ratings", str(tmp_path / "ratings.jsonl")],
        cwd=tmp_path, capture_output=True, text=True, timeout=30, env=env,
    )
    assert result.returncode == 2, result.stdout + result.stderr
    assert "scripts/learning/beauty.py report" in result.stderr
    assert not (ldir / "taste-profile.json").exists()
    assert not (tmp_path / ".sinter").exists()


def test_wall_report_keeps_heldout_auc(tmp_path):
    wall, ldir = fixture(tmp_path)
    report = tmp_path / "report"
    result = subprocess.run(
        [sys.executable, os.path.join(ROOT, "scripts", "learning", "beauty.py"), "report",
         "--wall", str(wall), "--ratings", str(tmp_path / "ratings.jsonl"),
         "--crosswalk", str(tmp_path / "none.json"), "--cache", str(tmp_path / "cache.json"),
         "--runs", str(tmp_path / "no-frames" / "*.png"), "--out", str(report)],
        cwd=tmp_path, capture_output=True, text=True, timeout=30,
    )
    assert result.returncode == 0, result.stdout + result.stderr
    assert json.loads(result.stdout)["grouped_cv_auc_by_prompt_family"] is not None
    assert not (ldir / "taste-profile.json").exists()
