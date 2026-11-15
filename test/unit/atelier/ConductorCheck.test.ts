import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  checkAdherence,
  checkIfPending,
  planIsFresh,
} from '../../../src/atelier/ConductorCheck.js';

const gameDir = (cwd: string) => join(cwd, '.omx', 'atelier', 'game');

function writeTrend(cwd: string, rows: Array<Record<string, unknown>>): void {
  mkdirSync(join(cwd, '.omx', 'atelier', 'lessons'), { recursive: true });
  writeFileSync(join(cwd, '.omx', 'atelier', 'lessons', 'trend.jsonl'),
    rows.map(r => JSON.stringify(r)).join('\n') + '\n');
}

const plan = (primary = 'three', secondary = 'glsl', ts = '2026-08-31T12:00:00Z') => ({ primary, secondary, ts });
const row = (over: Record<string, unknown> = {}) => ({
  ts: '2026-08-31T12:05:00Z',
  domain: 'three',
  artifact: '/tmp/art1',
  domains: ['three', 'glsl'],
  axes: 'D=7.00 A=7.00 R=7.00 N=7.00 | judges: x',
  ...over,
});

describe('ConductorCheck (Elixis conductor adherence + auto-disable)', () => {
  let cwd: string;
  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'sinter-conductor-test-'));
    mkdirSync(gameDir(cwd), { recursive: true });
  });
  afterEach(() => { rmSync(cwd, { recursive: true, force: true }); });

  it('planIsFresh: only rows inside the 30-minute turn window match', () => {
    expect(planIsFresh(plan(), row())).toBe(true); // 5 min apart
    expect(planIsFresh(plan(), row({ ts: '2026-08-31T12:40:00Z' }))).toBe(false); // 40 min
    expect(planIsFresh(plan('three', 'glsl', 'bogus'), row())).toBe(false);
  });

  it('adhered turn: verdict recorded, plan consumed', () => {
    writeFileSync(join(gameDir(cwd), 'conductor-last.json'), JSON.stringify(plan()));
    const v = checkAdherence(cwd, plan(), row());
    expect(v.adhered).toBe(true);
    expect(v.declared).toEqual(['three', 'glsl']);
    const verdicts = readFileSync(join(gameDir(cwd), 'conductor-verdicts.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    expect(verdicts).toHaveLength(1);
    expect(verdicts[0]).toMatchObject({ adhered: true, declared: ['three', 'glsl'], plan: { primary: 'three', secondary: 'glsl' } });
    expect(existsSync(join(gameDir(cwd), 'conductor-last.json'))).toBe(false); // consumed
  });

  it('miss (missing or reordered domain): verdict recorded, candidate NOT consumed — retryable', () => {
    writeFileSync(join(gameDir(cwd), 'conductor-last.json'), JSON.stringify(plan()));
    const v = checkAdherence(cwd, plan(), row({ domains: ['three'] })); // secondary never declared
    expect(v.adhered).toBe(false);
    expect(existsSync(join(gameDir(cwd), 'conductor-last.json'))).toBe(false); // released for retry

    writeFileSync(join(gameDir(cwd), 'conductor-last.json'), JSON.stringify(plan()));
    const v2 = checkAdherence(cwd, plan(), row({ domains: ['glsl', 'three'] })); // wrong layer order
    expect(v2.adhered).toBe(false);
    const verdicts = readFileSync(join(gameDir(cwd), 'conductor-verdicts.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    expect(verdicts.map(x => x.adhered)).toEqual([false, false]);
  });

  it('auto-disable: 2 consecutive sub-baseline combination turns pause the lane with evidence', () => {
    // machine baseline: 20 rows at mean 6.0
    writeTrend(cwd, Array.from({ length: 20 }, (_, i) => row({
      ts: `2026-08-31T0${1 + (i % 8)}:0${i % 10}:00Z`, artifact: `/tmp/base${i}`,
      domains: ['p5'], axes: 'D=6.00 A=6.00 R=6.00 N=6.00 | judges: x',
    })));

    // turn 1: combination piece mean 4.0 — below median 6.0 -> streak 1
    writeTrend(cwd, [
      ...Array.from({ length: 20 }, (_, i) => row({
        ts: `2026-08-31T0${1 + (i % 8)}:0${i % 10}:00Z`, artifact: `/tmp/base${i}`,
        domains: ['p5'], axes: 'D=6.00 A=6.00 R=6.00 N=6.00 | judges: x',
      })),
      row({ axes: 'D=4.00 A=4.00 R=4.00 N=4.00 | judges: x' }),
    ]);
    const v1 = checkAdherence(cwd, plan(), row({ axes: 'D=4.00 A=4.00 R=4.00 N=4.00 | judges: x' }));
    expect(v1.adhered).toBe(true);
    let state = JSON.parse(readFileSync(join(gameDir(cwd), 'conductor.state'), 'utf8'));
    expect(state.enabled).toBe(true);
    expect(state.subBaselineStreak).toBe(1);

    // turn 2: another below-baseline combination piece -> lane pauses
    writeFileSync(join(gameDir(cwd), 'conductor-last.json'), JSON.stringify(plan('p5', 'hydra', '2026-08-31T13:00:00Z')));
    const v2 = checkAdherence(cwd, plan('p5', 'hydra', '2026-08-31T13:00:00Z'),
      row({ ts: '2026-08-31T13:05:00Z', domains: ['p5', 'hydra'], axes: 'D=3.00 A=3.00 R=3.00 N=3.00 | judges: x' }));
    expect(v2.adhered).toBe(true);
    state = JSON.parse(readFileSync(join(gameDir(cwd), 'conductor.state'), 'utf8'));
    expect(state.enabled).toBe(false);
    expect(state.reason).toContain('consecutive');
    expect(state.evidence.streak).toBe(2);
    expect(state.evidence.baselineMedian).toBe(6);
  });

  it('an above-baseline turn resets the streak and never disables', () => {
    writeTrend(cwd, Array.from({ length: 5 }, (_, i) => row({
      ts: `2026-08-31T0${i + 1}:00:00Z`, artifact: `/tmp/base${i}`,
      domains: ['p5'], axes: 'D=3.00 A=3.00 R=3.00 N=3.00 | judges: x',
    })));
    // preset a streak of 1, then score ABOVE the baseline median of 3
    writeFileSync(join(gameDir(cwd), 'conductor.state'), JSON.stringify({ enabled: true, subBaselineStreak: 1 }));
    const v = checkAdherence(cwd, plan(), row({ axes: 'D=8.00 A=8.00 R=8.00 N=8.00 | judges: x' }));
    expect(v.adhered).toBe(true);
    const state = JSON.parse(readFileSync(join(gameDir(cwd), 'conductor.state'), 'utf8'));
    expect(state.enabled).toBe(true);
    expect(state.subBaselineStreak).toBe(0);
  });

  it('checkIfPending: skips when no plan, stale plan, or out-of-window row', () => {
    expect(checkIfPending(cwd, row())).toBeNull(); // no plan record
    writeFileSync(join(gameDir(cwd), 'conductor-last.json'), JSON.stringify(plan('three', 'glsl', '2026-08-30T00:00:00Z')));
    // Stale plans now EXPIRE (verifier fix 2026-09-01): verdict recorded,
    // plan released — budget burns are never silent.
    expect(checkIfPending(cwd, row())).toBeNull();
    expect(existsSync(join(gameDir(cwd), 'conductor-last.json'))).toBe(false);
  });
});

describe('conductor stale-plan expiry (verifier fix 2026-09-01)', () => {
  it('records an EXPIRED verdict and releases a plan that aged past its window', async () => {
    const { checkIfPending } = await import('../../../src/atelier/ConductorCheck.js');
    const { mkdtempSync, writeFileSync, existsSync, readFileSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const cwd = mkdtempSync(join(tmpdir(), 'conductor-expiry-'));
    const { mkdirSync } = await import('node:fs');
    mkdirSync(join(cwd, '.omx/atelier/game'), { recursive: true });
    const plan = { primary: 'p5', secondary: 'hydra', ts: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString() };
    writeFileSync(join(cwd, '.omx/atelier/game/conductor-last.json'), JSON.stringify(plan));
    const freshRow = { ts: new Date().toISOString(), domain: 'p5', domains: ['p5'] };
    const verdict = checkIfPending(cwd, freshRow as never);
    expect(verdict).toBeNull();
    expect(existsSync(join(cwd, '.omx/atelier/game/conductor-last.json'))).toBe(false);
    const line = readFileSync(join(cwd, '.omx/atelier/game/conductor-verdicts.jsonl'), 'utf8').trim().split('\n').pop();
    const v = JSON.parse(line!);
    expect(v.expired).toBe(true);
    expect(v.reason).toContain('budget consumed');
  });
});
