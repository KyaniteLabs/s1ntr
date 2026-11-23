"""The renderer digest comes from the newest rendered Create's evidence, and a missing one fails loudly."""
import json
import os
import subprocess
import sys
import tempfile

SCRIPT = os.path.join(os.path.dirname(__file__), "..", "..", "scripts", "learning", "derive-renderer-digest.py")
A, B = "a" * 64, "b" * 64


def piece(root, seat, name, digest, status="rendered", mtime=None):
    d = os.path.join(root, seat, name)
    os.makedirs(d)
    f = os.path.join(d, "product-projections.json")
    with open(f, "w") as fh:
        json.dump({"k": {"kind": "create", "result": {"evidence": {
            "status": status, "rendererEnvironmentDigest": digest}}}}, fh)
    if mtime:
        os.utime(f, (mtime, mtime))


def run(*dirs):
    return subprocess.run([sys.executable, SCRIPT, *dirs], capture_output=True, text=True)


def test_newest_rendered_create_wins_and_failed_ones_are_ignored():
    with tempfile.TemporaryDirectory() as d:
        piece(d, "s", "old", A, mtime=1000)
        piece(d, "s", "new", B, mtime=2000)
        piece(d, "s", "newest-failed", "c" * 64, status="failed", mtime=3000)
        r = run(d)
        assert r.returncode == 0 and r.stdout.strip() == B


def test_no_evidence_fails_loudly_instead_of_guessing():
    with tempfile.TemporaryDirectory() as d:
        piece(d, "s", "p", "", status="failed")
        r = run(d)
        assert r.returncode != 0 and "no rendered Create" in r.stderr and r.stdout == ""
