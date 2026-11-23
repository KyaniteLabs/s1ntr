"""G02: run_batch.py must exit non-zero when any prompt's generate child failed, and the batch
loop must record every child's return code (a launcher printing ALLDONE over failed children hid a whole failed batch)."""
import ast, os
path = os.path.join(os.path.dirname(__file__), '..', '..', 'scripts', 'art-batch', 'run_batch.py')
src = open(path).read()
fn = next((n for n in ast.parse(src).body if isinstance(n, ast.FunctionDef) and n.name == 'batch_exit_code'), None)
assert fn is not None, 'run_batch.py has no batch_exit_code()'
ns = {}
exec(compile(ast.Module([fn], []), 'run_batch.py', 'exec'), ns)
f = ns['batch_exit_code']
assert f([]) == 0 and f([0, 0]) == 0
assert f([0, 4]) == 1 and f([1]) == 1 and f([-9]) == 1
assert 'RESULTS.append(rc)' in src, 'child return codes are not collected'
assert src.rstrip().endswith('sys.exit(batch_exit_code(RESULTS))'), 'the script does not exit with the aggregate'
print('ok')
