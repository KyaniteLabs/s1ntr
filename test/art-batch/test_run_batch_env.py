"""run_batch.py must not strip SINTER_BLENDER_BIN (blender lane) while still stripping other SINTER_*/LIMINAL_* vars."""
import ast, os, re

def test_run_batch_env():
    src = open(os.path.join(os.path.dirname(__file__), '..', '..', 'scripts', 'art-batch', 'run_batch.py')).read()
    fn = next((n for n in ast.parse(src).body if isinstance(n, ast.FunctionDef) and n.name == 'clean_env'), None)
    assert fn is not None, 'run_batch.py has no clean_env()'
    ns = {}
    exec(compile(ast.Module([fn], []), 'run_batch.py', 'exec'), ns)
    out = ns['clean_env']({'SINTER_BLENDER_BIN': '/opt/blender/blender', 'SINTER_CONFIG_PATH': 'x', 'LIMINAL_X': '1', 'LLM_MODEL': 'm', 'PATH': '/bin'})
    assert out == {'SINTER_BLENDER_BIN': '/opt/blender/blender', 'PATH': '/bin'}, out
    out = ns['clean_env']({'LIMINAL_RENDERED_SCORE_TIMEOUT_MS': '300000', 'LIMINAL_API_KEY': 'k', 'SINTER_X': '1', 'PATH': '/bin'})
    assert out == {'LIMINAL_RENDERED_SCORE_TIMEOUT_MS': '300000', 'PATH': '/bin'}, out
    assert "env.setdefault('PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH'" in src, 'pinned Chrome must be a default'
    assert not re.search(r"PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=os\.path\.join", src), 'pinned Chrome overwrites the override'
    print('ok')


if __name__ == '__main__':
    test_run_batch_env()
