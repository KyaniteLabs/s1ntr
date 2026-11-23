"""Push batch (2026-11-18): run_batch.py has the sol62/astra62 seats at xhigh with caps 39/13, honours per-prompt seat+loops,
chains loops through --revise-from, gives push seats a 2 h model timeout and classifies every failure."""
import ast, os, re, json
root = os.path.join(os.path.dirname(__file__), '..', '..')
src = open(os.path.join(root, 'scripts', 'art-batch', 'run_batch.py')).read()
ast.parse(src)
for k, m in (('sol62', 'gpt-6.2-sol'), ('astra62', 'gpt-6.2-astra')):
    assert re.search(r"'%s':\s*\{'provider': 'cli', 'model': '%s',\s*'baseUrl': 'cli://codex/xhigh'" % (k, m), src), k
assert '"sol62": 39, "astra62": 13' in src
assert "SEAT_OF = {'sol': 'sol62', 'astra': 'astra62'}" in src
for needle in ("'--revise-from'", "'--revise-loop'", "'--revise-of'", "failure.json", "def classify_failure", "start_new_session=True", "7200000", "CODEX_BIN"):
    assert needle in src, needle
fn = next(n for n in ast.parse(src).body if isinstance(n, ast.FunctionDef) and n.name == 'classify_failure')
ns = {'re': re}
exec(compile(ast.Module([fn], []), 'x', 'exec'), ns)
c = ns['classify_failure']
assert c(1, '', 'token_expired') == 'auth-expired'
assert c(1, '', 'model_not_found') == 'model-not-supported'
assert c(-9, '', '', True) == 'timeout'
assert c(1, '', 'EFFECT_OUTCOME_UNRESOLVED') == 'unresolved-effect'
assert c(1, '', 'weird').startswith('unclassified')
print('ok')
