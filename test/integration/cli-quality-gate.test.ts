/**
 * Sol audit F05: `quality run|gate` threw GOLDEN_CANDIDATES_REQUIRED for every nonempty suite, so the gate never
 * evaluated anything. These run the real binary with saved candidates and prove the exit code comes from judgment.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.setConfig({ testTimeout: 90_000 });
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
let home: string;
beforeEach(() => { home = mkdtempSync(path.join(tmpdir(), 'sinter-quality-')); mkdirSync(path.join(home, 'cand')); });
afterEach(() => { rmSync(home, { recursive: true, force: true }); });

const GOOD = '<!DOCTYPE html><html><body><canvas id=c></canvas><script>const x=document.getElementById("c").getContext("2d");let t=0;function f(){t+=.1;x.fillStyle="hsl("+t*40+",80%,50%)";x.fillRect(0,0,99,99);requestAnimationFrame(f)}f()</script></body></html>';

function sinter(args: string[]) {
  const r = spawnSync(process.execPath, [path.join(repoRoot, 'bin/sinter'), ...args], {
    cwd: home, env: { ...process.env, HOME: home }, encoding: 'utf8', timeout: 60_000,
  });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
}
function suite(minScore: number) {
  const file = path.join(home, 'suite.json');
  writeFileSync(file, JSON.stringify({ name: 's', cases: [{ id: 'c1', prompt: 'orbit', domain: 'html', minScore, tags: [] }], createdAt: '2026-01-01T00:00:00Z' }));
  return file;
}

describe('quality run|gate evaluate a nonempty suite (F05)', () => {
  it('run: a real candidate is judged and passes', () => {
    writeFileSync(path.join(home, 'cand', 'c1.html'), GOOD);
    const r = sinter(['quality', 'run', '--spec', suite(0.3), '--candidates', path.join(home, 'cand')]);
    expect(r.out).toMatch(/PASS c1: 0\.\d+/);
    expect(r.out).toMatch(/Suite passed: true/);
    expect(r.status).toBe(0);
  });

  it('run and gate: a failing candidate gives a nonzero exit from judgment, not from a thrown error', () => {
    writeFileSync(path.join(home, 'cand', 'c1.html'), 'x');
    for (const sub of ['run', 'gate']) {
      const r = sinter(['quality', sub, '--spec', suite(0.4), '--candidates', path.join(home, 'cand')]);
      expect(r.out).toMatch(/FAIL c1: 0\.\d+/);
      expect(r.out).not.toMatch(/GOLDEN_SUITE_CANDIDATE_REQUIRED/);
      expect(r.status).toBe(1);
    }
  });

  it('refuses without --candidates or with a missing case file, naming the problem', () => {
    expect(sinter(['quality', 'gate', '--spec', suite(0.3)]).out).toMatch(/--candidates <dir> is required/);
    const r = sinter(['quality', 'gate', '--spec', suite(0.3), '--candidates', path.join(home, 'cand')]);
    expect(r.out).toMatch(/GOLDEN_CANDIDATES_MISSING: .*c1/);
    expect(r.status).toBe(1);
  });
});
