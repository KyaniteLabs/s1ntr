import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runIslandsCommand, runPhasesCommand } from '../../../src/cli/PopulationCli.js';

function row(domain: string, score: number, artifact: string, ts: string): string {
  const s = score.toFixed(1);
  return JSON.stringify({ domain, artifact, ts, axes: `D=${s} A=${s} R=${s} N=${s}` });
}

describe('PopulationCli', () => {
  let dir: string;
  let trendPath: string;
  let logs: string[];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'population-cli-'));
    mkdirSync(join(dir, '.omx', 'atelier', 'lessons'), { recursive: true });
    trendPath = join(dir, '.omx', 'atelier', 'lessons', 'trend.jsonl');
    logs = [];
    vi.spyOn(process, 'cwd').mockReturnValue(dir);
    vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { logs.push(a.join(' ')); });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(dir, { recursive: true, force: true });
  });

  describe('phases', () => {
    it('says there is nothing to analyze when the trend substrate is missing', () => {
      runPhasesCommand([]);
      expect(logs).toEqual([`[phases] no trend substrate at ${trendPath} — nothing to analyze yet`]);
    });

    it('detects a regime change from low to high scores in one domain', () => {
      const scores = [1, 1, 1, 4, 4, 4];
      writeFileSync(trendPath, scores.map((s, i) => row('svg', s, `/a/art-${i}`, `2026-11-14T10:0${i}:00Z`)).join('\n') + '\n');
      runPhasesCommand(['--window', '3']);
      expect(logs[0]).toBe(`[phases] trend: ${trendPath} (6 scored observations)`);
      expect(logs[1]).toContain('window=3, k=3σ');
      expect(logs[2]).toBe('[phases] 1 phase transition detected:');
      expect(logs[3]).toContain('svg @ obs#3');
      expect(logs[3]).toContain('mean 1.00 → 4.00 (Δ+3.00');
      expect(logs[3]).toContain('up');
      expect(logs[4]).toBe('[phases] rolling tail (mean±sd, last 3): svg 4.00±0.00(n=6)');
    });

    it('reports a stable regime for a flat series and honours --domain filtering', () => {
      const flat = [2, 2, 2, 2, 2, 2].map((s, i) => row('svg', s, `/a/s-${i}`, '2026-11-14T10:00:00Z'));
      const other = [1, 1, 1, 5, 5, 5].map((s, i) => row('p5', s, `/a/p-${i}`, '2026-11-14T10:00:00Z'));
      writeFileSync(trendPath, [...flat, ...other].join('\n') + '\n');
      runPhasesCommand(['--window', '3', '--domain', 'svg', '--trend', trendPath]);
      expect(logs[0]).toBe(`[phases] trend: ${trendPath} (6 scored observations, domain=svg)`);
      expect(logs[2]).toBe('[phases] 0 phase transitions detected — all domains in stable regime');
    });

    it('falls back to defaults when numeric flags are not numbers', () => {
      writeFileSync(trendPath, row('svg', 2, '/a/x', '2026-11-14T10:00:00Z') + '\n');
      runPhasesCommand(['--window', 'abc', '--k-sigma', 'NaN']);
      expect(logs[1]).toContain('window=8, k=3σ');
    });

    it('skips malformed trend lines instead of crashing', () => {
      writeFileSync(trendPath, 'garbage\n' + row('svg', 2, '/a/x', '2026-11-14T10:00:00Z') + '\n{"no":"axes"}\n');
      runPhasesCommand([]);
      expect(logs[0]).toBe(`[phases] trend: ${trendPath} (1 scored observations)`);
    });
  });

  describe('islands', () => {
    it('says there is nothing to speciate when the trend substrate is missing', () => {
      runIslandsCommand([]);
      expect(logs).toEqual([`[islands] no trend substrate at ${trendPath} — nothing to speciate yet`]);
    });

    it('speciates per domain and migrates the top exemplar around the ring', () => {
      writeFileSync(trendPath, [
        row('p5', 2, '/a/p5-low', '2026-11-14T10:00:00Z'),
        row('p5', 4, '/a/p5-top', '2026-11-14T10:01:00Z'),
        row('svg', 3, '/a/svg-top', '2026-11-14T10:02:00Z'),
      ].join('\n') + '\n');
      runIslandsCommand(['--k', '1', '--epochs', '1']);
      expect(logs[0]).toBe(`[islands] 2 islands from 3 artifacts (trend: ${trendPath})`);
      expect(logs[1]).toMatch(/^\[islands\] {3}p5\s+residents=2\s+top=p5-top \(4\.00\)$/);
      expect(logs[2]).toMatch(/^\[islands\] {3}svg\s+residents=1\s+top=svg-top \(3\.00\)$/);
      expect(logs[3]).toBe('[islands] migration: ring topology, k=1, epochs=1');
      expect(logs).toContain('[islands]   epoch 1: p5 → svg [p5-top(4.00)]');
      expect(logs).toContain('[islands]   epoch 1: svg → p5 [svg-top(3.00)]');
      expect(logs).toContain('[islands] immigrant exemplars after 1 epoch(s): p5+1 svg+1');
      expect(logs[logs.length - 1]).toBe('[islands] frontier corridors: none open (board too thin or fully threaded)');
    });
  });
});
