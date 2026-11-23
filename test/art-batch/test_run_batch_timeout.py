"""L3-04: a generate child that overruns its deadline must be killed with its whole process group and reported as a typed
timeout (rc 124), not raise out of the batch loop and take every remaining prompt down with it."""
import ast, os, signal, subprocess, sys, tempfile, time
path = os.path.join(os.path.dirname(__file__), '..', '..', 'scripts', 'art-batch', 'run_batch.py')
src = open(path).read()
wanted = {'TIMEOUT_RC', 'run_child'}
nodes = [n for n in ast.parse(src).body
         if (isinstance(n, ast.FunctionDef) and n.name in wanted)
         or (isinstance(n, ast.Assign) and any(getattr(t, 'id', None) in wanted for t in n.targets))]
assert len(nodes) == 2, 'run_batch.py is missing run_child()/TIMEOUT_RC'
ns = {'os': os, 'signal': signal, 'subprocess': subprocess}
exec(compile(ast.Module(nodes, []), 'run_batch.py', 'exec'), ns)
run_child = ns['run_child']

rc, out, err, timed_out = run_child([sys.executable, '-c', 'print("done")'], 30)
assert (rc, out.strip(), timed_out) == (0, 'done', False)
rc, out, err, timed_out = run_child([sys.executable, '-c', 'import sys; sys.exit(3)'], 30)
assert (rc, timed_out) == (3, False)

# A child that spawns a grandchild and hangs: both must die, and the call must return promptly.
tmp = tempfile.TemporaryDirectory(prefix='run-batch-timeout-')
pidfile = os.path.join(tmp.name, 'grandchild.pid')
code = ('import subprocess,sys,time;'
        'g=subprocess.Popen([sys.executable,"-c","import time;time.sleep(300)"]);'
        'open(%r,"w").write(str(g.pid));print("partial",flush=True);time.sleep(300)' % pidfile)
t0 = time.time()
rc, out, err, timed_out = run_child([sys.executable, '-c', code], 2)
assert time.time() - t0 < 30, 'the timeout did not return promptly'
assert timed_out is True and rc == ns['TIMEOUT_RC'] == 124
assert 'partial' in out, 'partial output was lost'
assert 'TIMEOUT' in err
grandchild = int(open(pidfile).read())
time.sleep(0.5)
# Container PID 1 may leave a dead grandchild unreaped. A zombie cannot execute.
state = subprocess.run(['ps', '-o', 'stat=', '-p', str(grandchild)], capture_output=True, text=True, timeout=5)
assert state.returncode in (0, 1), state.stderr
assert state.returncode == 1 or state.stdout.strip().startswith('Z'), 'the grandchild survived the group kill'
tmp.cleanup()

with tempfile.TemporaryDirectory(prefix='run-batch-detached-') as folder:
    pidfile = os.path.join(folder, 'detached.pid')
    code = ('import subprocess,sys,time;'
            'g=subprocess.Popen([sys.executable,"-c","import time;time.sleep(30)"],start_new_session=True);'
            'open(%r,"w").write(str(g.pid));print("detached output",flush=True);time.sleep(30)' % pidfile)
    start = time.monotonic()
    try:
        rc, out, err, timed_out = run_child([sys.executable, '-c', code], 2)
        assert (rc, timed_out) == (124, True) and 'detached output' in out and 'TIMEOUT' in err
        assert time.monotonic() - start < 12, 'a detached descendant stalled pipe draining'
    finally:
        if os.path.isfile(pidfile):
            try:
                os.kill(int(open(pidfile).read()), signal.SIGKILL)
            except ProcessLookupError:
                pass

assert "RESULTS.append(rc)" in src and "'timed_out': timed_out" in src, 'the loop must record the typed timeout'
assert 'subprocess.run([\'node\'' not in src, 'the generate child must go through run_child'
print('ok')
