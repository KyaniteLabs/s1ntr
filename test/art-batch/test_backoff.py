"""L5-19: backoff.py counts only NEW log bytes, never raises a zero cap, adopts an operator's conc.json edit.
usage: python3 -I test/art-batch/test_backoff.py [script]"""
import json, os, subprocess, sys, tempfile, time
script = os.path.abspath(sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(__file__), "..", "..", "scripts", "art-batch", "backoff.py"))
B = tempfile.mkdtemp()
for k in ("a", "z"): os.makedirs("%s/out/%s/r1" % (B, k))
la, lz = B + "/out/a/r1/run.log", B + "/out/z/r1/run.log"
open(la, "w").write("old: API error 429\n"); open(lz, "w").write("ok\n")
time.sleep(1.2)  # history older than the start time
p = subprocess.Popen([sys.executable, "-I", script, B, "a=4", "z=0"], env=dict(os.environ, BACKOFF_INTERVAL="0.3"), stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
def caps(): return json.load(open(B + "/conc.json"))
def wait(f, t=8):
    e = time.time() + t
    while time.time() < e:
        if f(): return True
        time.sleep(0.2)
    return False
try:
    assert wait(lambda: os.path.exists(B + "/conc.json")); time.sleep(1.5)
    os.utime(la, None); time.sleep(1.5)                       # touched, nothing appended: an old 429 must not cut the cap again
    assert caps()["a"] == 4, caps()
    open(la, "a").write("new: API error 429\n"); assert wait(lambda: caps()["a"] == 2), caps()
    open(lz, "a").write("rate_limit_error\n"); time.sleep(1.5); assert caps()["z"] == 0, "a paused seat must stay paused: %s" % caps()
    c = caps(); c["a"] = 0; json.dump(c, open(B + "/conc.json", "w")); time.sleep(1.5)     # operator pause
    assert caps()["a"] == 0, "operator pause must not be overwritten: %s" % caps()
finally: p.terminate(); p.wait()
print("PASS backoff: new bytes only, zero stays zero, operator edit adopted")
