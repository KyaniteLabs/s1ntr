"""Concurrent learn_after_batch runs must not append the same (run_dir, finished_utc) twice.
usage: python3 -I test/art-batch/test_corpus_idempotent.py [script]   (fake HOME; no sinter checkout, so only the corpus stage runs)"""
import json, os, subprocess, sys, tempfile

def test_corpus_idempotent():
    script = os.path.abspath(sys.argv[1] if __name__ == "__main__" and len(sys.argv) > 1 else os.path.join(os.path.dirname(__file__), "..", "..", "scripts", "art-batch", "learn_after_batch.py"))
    home = tempfile.mkdtemp(); out = os.path.join(home, "s1ntr-art", "out", "k")
    for i in range(40):
        d = os.path.join(out, "p%d-r1" % i); os.makedirs(d)
        json.dump({"finished_utc": "2026-11-18T00:00:%02dZ" % i, "model_key": "k", "prompt_id": "p%d" % i, "rc": 0}, open(os.path.join(d, "manifest.json"), "w"))
        json.dump({"production-create:%d" % i: {"kind": "create", "result": {"evaluation": {"score": 0.5}, "receipt": {}}}}, open(os.path.join(d, "product-projections.json"), "w"))  # L5-04: rc=0 runs without a projection are not committed
    env = dict(os.environ, HOME=home)
    ps = [subprocess.Popen([sys.executable, "-I", script, "k"], env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL) for _ in range(8)]
    for p in ps: p.wait()
    rows = [json.loads(l) for l in open(os.path.join(home, "s1ntr-art", "learning", "corpus.jsonl"))]
    keys = [(r["run_dir"], r["finished_utc"]) for r in rows]
    assert len(keys) == len(set(keys)) == 40, "rows=%d unique=%d (want 40/40)" % (len(keys), len(set(keys)))
    print("PASS 40 unique rows from 8 concurrent learners")


if __name__ == '__main__':
    test_corpus_idempotent()
