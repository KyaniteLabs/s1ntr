from pathlib import Path
import os
import subprocess
import sys


def test_wall_report_names_missing_numpy(tmp_path):
    repo = Path(__file__).resolve().parents[2]
    wall_fixture = repo / "test/learning/fixtures/wall-vote"
    fake_numpy = tmp_path / "numpy"
    fake_numpy.mkdir()
    (fake_numpy / "__init__.py").write_text(
        'raise ModuleNotFoundError("No module named numpy", name="numpy")\n'
    )
    runs = tmp_path / "runs"
    runs.mkdir()
    result = subprocess.run(
        [sys.executable, str(repo / "scripts/learning/beauty.py"), "report",
         "--wall", str(wall_fixture / "wall"), "--ratings", str(wall_fixture / "ratings.jsonl"),
         "--runs", str(runs), "--out", str(tmp_path / "report")],
        env={**os.environ, "PYTHONPATH": str(tmp_path)},
        capture_output=True, text=True, check=False, timeout=15,
    )
    assert result.returncode == 2, result.stderr
    assert "python3 -m pip install numpy" in result.stderr
    assert "Traceback" not in result.stderr
    assert not (tmp_path / "report").exists()
