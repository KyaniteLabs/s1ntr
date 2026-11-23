"""run_batch.py must spot a killed run (folder with content, no manifest.json) even when the
operation journal lives in the shared runtime root and not in the run folder."""
import ast, json, os, tempfile

def test_run_batch_unfinished():
    src = open(os.path.join(os.path.dirname(__file__), '..', '..', 'scripts', 'art-batch', 'run_batch.py')).read()
    fn = next((n for n in ast.parse(src).body if isinstance(n, ast.FunctionDef) and n.name == 'unfinished_run'), None)
    rf = next((n for n in ast.parse(src).body if isinstance(n, ast.FunctionDef) and n.name == 'resume_flags'), None)
    assert rf is not None, 'run_batch.py has no resume_flags()'
    assert fn is not None, 'run_batch.py has no unfinished_run()'
    ns = {'os': os, 'json': json}
    exec(compile(ast.Module([fn, rf], []), 'run_batch.py', 'exec'), ns)
    f = ns['unfinished_run']
    t = tempfile.mkdtemp()
    missing = os.path.join(t, 'missing'); assert not f(missing)
    empty = os.path.join(t, 'empty'); os.mkdir(empty); assert not f(empty)
    killed = os.path.join(t, 'killed'); os.makedirs(os.path.join(killed, 'artifacts', 'x'))  # shared root: no journal here
    assert f(killed)
    done = os.path.join(t, 'done'); os.makedirs(os.path.join(done, 'artifacts')); open(os.path.join(done, 'manifest.json'), 'w').write('{}')
    assert not f(done)
    # killed before it wrote anything: only the leftover .lock shows it (journal and checkpoints are in the shared root)
    nothing = os.path.join(t, 'nothing'); assert f(nothing, True) and not f(nothing, False)
    assert f(done, True) is False  # finished runs are never treated as killed
    r = ns['resume_flags']
    assert r(True, True) == ['--retry-unknown'] and r(False, True) == [] and r(True, False) == []
    with open(os.path.join(done, 'manifest.json'), 'w') as manifest:
        json.dump({'rc': 124, 'timed_out': True}, manifest)
    assert r(f(done, True), True) == ['--retry-unknown']
    print('ok')


if __name__ == '__main__':
    test_run_batch_unfinished()
