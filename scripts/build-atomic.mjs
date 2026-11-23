#!/usr/bin/env node
// Atomic build: tsc writes to a private directory and dist is swapped in only when the compile
// succeeded. A spawned CLI (bin/sinter -> dist/) never sees a half-written or half-deleted dist, and a failed
// compile leaves the previous dist untouched.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');
const next = path.join(root, `dist.build-${process.pid}`);
const prev = path.join(root, `dist.prev-${process.pid}`);
const tsc = path.join(root, 'node_modules', 'typescript', 'bin', 'tsc');

rmSync(next, { recursive: true, force: true });
const run = spawnSync(process.execPath, [tsc, '--incremental', 'false', '--outDir', next], { cwd: root, stdio: 'inherit' });
if (run.status !== 0) {
  rmSync(next, { recursive: true, force: true });
  process.exit(run.status ?? 1);
}
// Only the swap is serialised, so two overlapping builds compile in parallel but never rename over each other.
const lock = path.join(root, 'dist.swap-lock');
/** Linux renameat2(RENAME_EXCHANGE) through python3's ctypes: swaps two directories in one atomic step. false = unavailable. */
function exchange(a, b) {
  if (process.platform !== 'linux') return false;
  const code = `
import ctypes, os, sys
renameat2 = ctypes.CDLL(None).renameat2
AT_FDCWD, RENAME_EXCHANGE = -100, 2
left, right = map(os.fsencode, sys.argv[1:])
sys.exit(renameat2(AT_FDCWD, left, AT_FDCWD, right, RENAME_EXCHANGE) != 0)
`;
  const r = spawnSync('python3', ['-c', code, a, b], { stdio: 'ignore' });
  return r.status === 0;
}
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
for (let tries = 0; ; tries += 1) {
  try { mkdirSync(lock); break; } catch (e) {
    if (e.code !== 'EEXIST') throw e;
    try { if (Date.now() - statSync(lock).mtimeMs > 60_000) rmSync(lock, { recursive: true, force: true }); } catch { /* raced */ }
    if (tries > 600) { rmSync(next, { recursive: true, force: true }); console.error('build-atomic: dist.swap-lock held for 60s'); process.exit(1); }
    sleep(100);
  }
}
try {
  const had = existsSync(dist);
  if (had && !process.env.BUILD_ATOMIC_NO_EXCHANGE && exchange(next, dist)) {
    // dist now holds the new build and `next` the old one: there was no instant without a dist
    rmSync(next, { recursive: true, force: true });
  } else {
    if (had) renameSync(dist, prev);
    // test hook: stall between the two renames, so a missing lock or a missing retry is caught deterministically
    if (process.env.BUILD_ATOMIC_TEST_SWAP_DELAY_MS) sleep(Number(process.env.BUILD_ATOMIC_TEST_SWAP_DELAY_MS));
    renameSync(next, dist);
  }
} finally {
  rmSync(lock, { recursive: true, force: true });
}
rmSync(prev, { recursive: true, force: true });
