"""queue_more4.py must requeue every typed contention failure, not only RENDER_DURATION_LIMIT_EXCEEDED (Sol L3-16)."""
import ast, os
src = open(os.path.join(os.path.dirname(__file__), '..', '..', 'scripts', 'art-batch', 'queue_more4.py')).read()
body = ast.parse(src).body
marks = next(n for n in body if isinstance(n, ast.Assign) and n.targets[0].id == 'CONTENTION_MARKERS')
fn = next(n for n in body if isinstance(n, ast.FunctionDef) and n.name == 'contended')
ns = {}
exec(compile(ast.Module([marks, fn], []), 'queue_more4.py', 'exec'), ns)
c = ns['contended']
for m in ('RENDER_DURATION_LIMIT_EXCEEDED', 'RENDER_HARD_DEADLINE: render exceeded 90000 ms', 'PIPELINE_TIMEOUT: render and score exceeded 1 ms'):
    assert c('x ' + m + ' y'), m
assert not c('SCORE_CAPTURE_FAILED: screenshot') and not c('')
print('ok')
