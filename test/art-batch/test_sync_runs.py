"""L5-02: a transfer never leaves a partial or mixed run in the live namespace.
usage: python3 -I test/art-batch/test_sync_runs.py"""
import json, os, subprocess, sys, tempfile
S = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "scripts", "art-batch", "sync_runs.py")
t = tempfile.mkdtemp(); src = t + "/src"; dst = t + "/dst"; os.makedirs(dst)
def mk(root, run, fin, extra=None, manifest=True):
    d = "%s/%s" % (root, run); os.makedirs(d, exist_ok=True); open(d + "/artifact.txt", "w").write(fin)
    if manifest: json.dump({"finished_utc": fin, "model_key": "k"}, open(d + "/manifest.json", "w"))
    if extra: open(d + "/" + extra, "w").write("x")
def go(*extra, rsync="rsync"):
    r = subprocess.run([sys.executable, "-I", S, "--src", src, "--dst", dst, "--origin", "nuc", "--rsync", rsync] + list(extra), capture_output=True, text=True)
    return r.returncode, r.stdout
mk(src, "a-r1", "2026-11-18T01:00:00Z", "x.lock"); mk(src, "b-r1", "2026-11-18T01:00:00Z"); mk(src, "live-r1", "", manifest=False); mk(src, "not a run", "z")
rc, out = go(); assert rc == 0 and "ok=2" in out, out
assert os.path.exists(dst + "/a-r1/manifest.json") and not os.path.exists(dst + "/a-r1/x.lock") and not os.path.exists(dst + "/live-r1"), "locks and unfinished runs must not travel"
rc, out = go(); assert rc == 0 and "skipped=2" in out, out                                # idempotent
# same origin, newer manifest supersedes; old folder kept
mk(src, "a-r1", "2026-11-18T02:00:00Z"); rc, out = go(); assert rc == 0 and "superseded=1" in out, out
assert json.load(open(dst + "/a-r1/manifest.json"))["finished_utc"].startswith("2026-11-18T02") and os.listdir(dst + "/.superseded")
# a DIFFERENT origin's run with the same name is parked, never mixed in
open(dst + "/b-r1/.origin", "w").write("air\n"); mk(src, "b-r1", "2026-11-18T09:00:00Z"); rc, out = go()
assert rc == 0 and "failed=0" in out and "conflict=1" in out and os.listdir(dst + "/.conflict/nuc"), out
assert json.load(open(dst + "/b-r1/manifest.json"))["finished_utc"] == "2026-11-18T01:00:00Z", "the existing run must be untouched"
# an rsync that lands part of a run then fails (rc 23): nothing is promoted, exit nonzero
shim = t + "/rsync-fail"; open(shim, "w").write('#!/bin/sh\nfor last; do :; done\nmkdir -p "$last"; echo partial > "$last/artifact.txt"\nexit 23\n'); os.chmod(shim, 0o755)
mk(src, "c-r1", "2026-11-18T03:00:00Z"); rc, out = go(rsync=shim)
assert rc == 1 and "FAILED c-r1" in out and not os.path.exists(dst + "/c-r1"), out
rc, out = go(); assert "ok=1" in out and "KNOWN-CONFLICT" in out and "known=1" in out and len(os.listdir(dst + "/.conflict/nuc")) == 1, out   # next cycle repairs c-r1; the conflict is not re-parked
assert os.path.exists(dst + "/c-r1/manifest.json")
# a manifest-less leftover folder (interrupted old copy) is moved to .partial and the verified copy lands; not a failure
os.makedirs(dst + "/d-r1"); open(dst + "/d-r1/junk", "w").write("x"); mk(src, "d-r1", "2026-11-18T04:00:00Z"); rc, out = go()
assert rc == 0 and "failed=0" in out and os.path.exists(dst + "/d-r1/manifest.json") and os.listdir(dst + "/.partial"), out
rc, out = go("--src", src + "/missing")
assert rc == 2 and "cannot list" in out, out
mk(src, "race-r1", "2026-11-18T05:00:00Z")
barrier = t + "/barrier"
os.mkdir(barrier)
shim = t + "/rsync-barrier"
with open(shim, "w") as handle:
    handle.write("""#!/bin/sh
rsync "$@" || exit $?
touch "$SYNC_BARRIER/$$"
while [ "$(ls "$SYNC_BARRIER" | wc -l)" -lt 2 ]; do sleep 0.03; done
""")
os.chmod(shim, 0o755)
cmd = [sys.executable, "-I", S, "--src", src, "--dst", dst, "--origin", "nuc", "--re", "^race-r1$", "--rsync", shim]
copies = [subprocess.Popen(cmd, env=dict(os.environ, SYNC_BARRIER=barrier), stdout=subprocess.PIPE, text=True) for _ in range(2)]
try:
    outputs = [copy.communicate(timeout=15)[0] for copy in copies]
finally:
    for copy in copies:
        if copy.poll() is None:
            copy.kill()
            copy.wait()
assert sorted(copy.returncode for copy in copies) == [0, 1], outputs
assert sorted(os.listdir(dst + "/race-r1")) == [".origin", "artifact.txt", "manifest.json"]
rc, out = go("--re", "^race-r1$")
assert rc == 0 and "skipped=1" in out, out
print("PASS sync_runs: staged+atomic, no partials, locks stay, supersede/conflict never mix runs")
