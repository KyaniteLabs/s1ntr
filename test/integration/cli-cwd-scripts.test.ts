/**
 * The CLI must run its own helper scripts, never a same-named script planted
 * in whatever folder the user happens to run `sinter` from (a cloned repo, a
 * download). Exercises bin/sinter together with scripts/data/sinter_data.py.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const repoRoot = path.resolve(import.meta.dirname, '../..');
const MARKER = 'PLANTED-SCRIPT-RAN';

describe('CLI helper scripts come from the package, not the current folder', () => {
  let work: string;
  let home: string;

  beforeAll(() => {
    work = fs.mkdtempSync(path.join(os.tmpdir(), 'sinter-cwd-planted-'));
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'sinter-cwd-home-'));
    for (const rel of ['scripts/data/sinter_data.py', 'scripts/atelier/promotion-gate.py']) {
      fs.mkdirSync(path.join(work, path.dirname(rel)), { recursive: true });
      fs.writeFileSync(path.join(work, rel), `print("${MARKER}")\n`);
    }
  });

  afterAll(() => {
    fs.rmSync(work, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('`sinter data` runs the packaged sinter_data.py, not ./scripts/data/sinter_data.py', () => {
    const r = spawnSync(process.execPath, [path.join(repoRoot, 'bin/sinter'), 'data'], {
      cwd: work,
      env: { ...process.env, HOME: home, USERPROFILE: home },
      encoding: 'utf8',
      timeout: 60000,
    });
    const out = `${r.stdout}\n${r.stderr}`;
    expect(out.includes(MARKER)).toBe(false);
    // The real script refuses a missing subcommand with its argparse usage.
    expect(out).toMatch(/usage: sinter_data/);
    expect(r.status).toBe(2);
  }, 90000);

  it('builds no helper-script path from the current folder', () => {
    const source = fs.readFileSync(path.join(repoRoot, 'bin/sinter'), 'utf8');
    const cwdScriptPaths = source.split('\n')
      .map((line, i) => ({ line, n: i + 1 }))
      .filter(({ line }) => /path\.join\(process\.cwd\(\),\s*'scripts/.test(line))
      .map(({ n }) => `bin/sinter:${n}`);
    expect(cwdScriptPaths).toEqual([]);
  });
});
