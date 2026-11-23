"""The manifest dict in run_batch.py must really contain the prompt-provenance keys. A trailing '# comment' inside the
dict literal once swallowed the rest of its line (reasoning, prompt_sha256, guidance, brief_sha256), so wall rows had no
prompt data and nothing failed. Parse the source: comments cannot hide from the AST."""
import ast, os, sys
path = sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(__file__), '..', '..', 'scripts', 'art-batch', 'run_batch.py')
tree = ast.parse(open(path).read())
manifests = [n.value for n in ast.walk(tree) if isinstance(n, ast.Assign) and isinstance(n.value, ast.Dict)
             and any(isinstance(t, ast.Name) and t.id == 'man' for t in n.targets)]
assert manifests, "run_batch.py has no 'man = {...}' manifest dict"
keys = {k.value for k in manifests[0].keys if isinstance(k, ast.Constant)}
for k in ('prompt_id', 'prompt', 'domain', 'reasoning', 'prompt_sha256', 'guidance', 'brief_sha256'):
    assert k in keys, 'manifest lost key %r (a comment inside the dict literal?)' % k
print('ok')
