import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const bin = path.resolve(__dirname, '../../bin/sinter');

describe('sinter gui-evolve refuses before any bootstrap (Sol F12)', { timeout: 90000 }, () => {
  it.each([['--n', 'abc'], ['--n', '0']])('malformed %s %s exits 1 with a clear message', (flag, val) => {
    const cwd = mkdtempSync(path.join(tmpdir(), 'gui-evolve-'));
    try {
      const r = spawnSync('node', [bin, 'gui-evolve', 'run', flag, val], { cwd, encoding: 'utf8', timeout: 60000,
        env: { ...process.env, HOME: cwd } });
      expect(r.status).toBe(1);
      expect(r.stderr).toContain('--n must be a whole number');
    } finally { rmSync(cwd, { recursive: true, force: true }); }
  });
  it('an unknown subcommand exits 1', () => {
    const cwd = mkdtempSync(path.join(tmpdir(), 'gui-evolve-'));
    try {
      const r = spawnSync('node', [bin, 'gui-evolve', 'bogus'], { cwd, encoding: 'utf8', timeout: 60000, env: { ...process.env, HOME: cwd } });
      expect(r.status).toBe(1);
      expect(r.stderr).toContain('unknown subcommand');
    } finally { rmSync(cwd, { recursive: true, force: true }); }
  });
});
