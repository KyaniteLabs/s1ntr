// Sol L3-16: a panel sweep where every seat errors must not persist an error-only row (it made later sweeps skip the piece).
import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

describe('third-judge sweep with every seat failing (spawned CLI)', () => {
  it('saves nothing, says NO VERDICT, exits non-zero so the next sweep retries', () => {
    const cwd = mkdtempSync(path.join(tmpdir(), 'tj-novd-'));
    try {
      const art = path.join(cwd, 'art1'); mkdirSync(art);
      writeFileSync(path.join(art, 'source.txt'), 'function setup(){}');
      const lessons = path.join(cwd, '.omx', 'atelier', 'lessons'); mkdirSync(lessons, { recursive: true });
      writeFileSync(path.join(lessons, 'trend.jsonl'), JSON.stringify({ artifact: art, domain: 'p5', axes: 'D=7 A=7 R=7 N=7' }) + '\n');
      const empty = mkdtempSync(path.join(tmpdir(), 'tj-path-'));   // neither command-code nor agy is on PATH
      const run = spawnSync(process.execPath, [path.resolve('bin/sinter'), 'third-judge', 'sweep'],
        { cwd, env: { ...process.env, PATH: empty, HOME: cwd }, encoding: 'utf8', timeout: 120_000 });
      const out = `${run.stdout}${run.stderr}`;
      expect(out).toMatch(/NO VERDICT from any seat/);
      expect(out).not.toMatch(/ saved consensus/);
      expect(run.status).toBe(1);
      const saved = readdirSync(path.join(cwd, '.omx', 'atelier', 'third-judge')).filter(f => f.endsWith('.json'));
      expect(saved).toEqual([]);
      rmSync(empty, { recursive: true, force: true });
    } finally { rmSync(cwd, { recursive: true, force: true }); }
  });
});
