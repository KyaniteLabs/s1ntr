"""The corpus row's create_key must be the product-store key (what the shared runtime root and dream use), not the operationId.
usage: python3 -I test/art-batch/test_learn_create_key.py [script]"""
import json, os, subprocess, sys, tempfile

def test_learn_create_key():
    script = os.path.abspath(sys.argv[1] if __name__ == "__main__" and len(sys.argv) > 1 else os.path.join(os.path.dirname(__file__), "..", "..", "scripts", "art-batch", "learn_after_batch.py"))
    home = tempfile.mkdtemp(); d = os.path.join(home, "s1ntr-art", "out", "k", "p0-r1"); os.makedirs(d)
    json.dump({"finished_utc": "2026-11-18T00:00:00Z", "model_key": "k", "prompt_id": "p0", "rc": 0}, open(os.path.join(d, "manifest.json"), "w"))
    proj = {"production-create:abc": {"kind": "create", "result": {"operationId": "operation:1",
            "evaluation": {"score": 0.7, "admissionEligible": True}, "receipt": {"artifactDigest": "dd"}}}}
    json.dump(proj, open(os.path.join(d, "product-projections.json"), "w"))
    env = dict(os.environ, HOME=home)
    subprocess.run([sys.executable, "-I", script, "k"], env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    rows = [json.loads(l) for l in open(os.path.join(home, "s1ntr-art", "learning", "corpus.jsonl"))]
    assert rows[0]["create_key"] == "production-create:abc", rows[0].get("create_key")
    env2 = dict(env, LEARN_REPLAY="p0")
    subprocess.run([sys.executable, "-I", script, "k"], env=env2, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    logdir = os.path.join(home, "s1ntr-art", "logs")
    log = open(os.path.join(logdir, [f for f in os.listdir(logdir) if f.startswith("learn-")][0])).read()
    assert "replay: 1 rows matching p0" in log, log
    print("PASS create_key is the store key; LEARN_REPLAY re-selects corpus rows")


if __name__ == '__main__':
    test_learn_create_key()
