"""A promoted retrieval arm (STATE/live-exemplars.json) must reach art-batch generation, not be stripped by clean_env."""
import ast, os, tempfile

def test_run_batch_exemplars():
    src = open(os.path.join(os.path.dirname(__file__), '..', '..', 'scripts', 'art-batch', 'run_batch.py')).read()
    fn = next((n for n in ast.parse(src).body if isinstance(n, ast.FunctionDef) and n.name == 'live_exemplars_env'), None)
    assert fn is not None, 'run_batch.py has no live_exemplars_env(): promoted exemplars never reach generation'
    ns = {'os': os}
    exec(compile(ast.Module([fn], []), 'run_batch.py', 'exec'), ns)
    with tempfile.TemporaryDirectory() as root:
      assert ns['live_exemplars_env'](root) == {}, 'no promoted file means no env'
      os.makedirs(os.path.join(root, '.learn'))
      p = os.path.join(root, '.learn', 'live-exemplars.json'); open(p, 'w').write('{}')
      assert ns['live_exemplars_env'](root) == {'SINTER_EXEMPLARS_FILE': p}
    print('ok')


if __name__ == '__main__':
    test_run_batch_exemplars()
