import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runConductorCommand } from '../../../src/cli/ConductorCli.js';

describe('runConductorCommand', () => {
  let dir: string;
  let logs: string[];
  const game = () => join(dir, '.omx', 'atelier', 'game');
  const trend = () => join(dir, '.omx', 'atelier', 'lessons', 'trend.jsonl');

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'conductor-cli-'));
    mkdirSync(game(), { recursive: true });
    mkdirSync(join(dir, '.omx', 'atelier', 'lessons'), { recursive: true });
    logs = [];
    vi.spyOn(process, 'cwd').mockReturnValue(dir);
    vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { logs.push(a.join(' ')); });
    vi.stubEnv('SINTER_CONDUCTOR_OFF', '');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    rmSync(dir, { recursive: true, force: true });
  });

  it('status on a blank workspace shows an active lane, empty budget and no plan', () => {
    runConductorCommand([]);
    expect(logs).toEqual([
      '[conductor] lane: active',
      '[conductor] budget: 0/2 combination turns today',
      '[conductor] last plan: none pending',
      '[conductor] verdicts recorded: 0',
    ]);
  });

  it('status reports a paused lane with its reason and the env kill switch', () => {
    writeFileSync(join(game(), 'conductor.state'), JSON.stringify({ enabled: false, reason: 'two sub-baseline turns' }));
    vi.stubEnv('SINTER_CONDUCTOR_OFF', '1');
    runConductorCommand(['status']);
    expect(logs[0]).toBe('[conductor] lane: PAUSED (env kill switch SINTER_CONDUCTOR_OFF=1)');
    expect(logs[1]).toBe('[conductor] reason: two sub-baseline turns');
  });

  it('status shows streak, today budget, last plan and the latest verdict line', () => {
    writeFileSync(join(game(), 'conductor.state'), JSON.stringify({ enabled: true, subBaselineStreak: 1 }));
    const today = new Date().toISOString().slice(0, 10);
    writeFileSync(join(game(), 'conductor-count.json'), JSON.stringify({ wave: today, used: 1 }));
    writeFileSync(join(game(), 'conductor-last.json'), JSON.stringify({ primary: 'svg', secondary: 'p5', ts: '2026-11-14T10:00:00Z' }));
    writeFileSync(join(game(), 'conductor-verdicts.jsonl'), '{"adhered":true}\n{"adhered":false}\n');
    runConductorCommand([]);
    expect(logs).toContain('[conductor] sub-baseline streak: 1/2');
    expect(logs).toContain('[conductor] budget: 1/2 combination turns today');
    expect(logs).toContain('[conductor] last plan: svg+p5 @ 2026-11-14T10:00:00Z');
    expect(logs).toContain('[conductor] verdicts recorded: 2 — latest: {"adhered":false}');
  });

  it('ignores a budget record from a previous day', () => {
    writeFileSync(join(game(), 'conductor-count.json'), JSON.stringify({ wave: '2020-01-01', used: 2 }));
    runConductorCommand([]);
    expect(logs).toContain('[conductor] budget: 0/2 combination turns today');
  });

  it('check with no trend stream says nothing is pending', () => {
    runConductorCommand(['check']);
    expect(logs).toEqual(['[conductor] no pending plan in the turn window (nothing to check)']);
  });

  it('check reports ADHERED when the primary domain precedes the secondary, and consumes the plan', () => {
    writeFileSync(join(game(), 'conductor-last.json'), JSON.stringify({ primary: 'svg', secondary: 'p5', ts: '2026-11-14T10:00:00.000Z' }));
    writeFileSync(trend(),
      JSON.stringify({ ts: '2026-11-14T10:05:00.000Z', domain: 'svg', domains: ['svg', 'p5'], axes: 'D=3 A=3 R=3 N=3' }) + '\n');
    runConductorCommand(['check']);
    expect(logs).toEqual(['[conductor] adherence: ADHERED declared=["svg","p5"]']);
    expect(existsSync(join(game(), 'conductor-last.json'))).toBe(false);
    expect(readFileSync(join(game(), 'conductor-verdicts.jsonl'), 'utf8')).toContain('"adhered":true');
  });

  it('check reports MISSED when the order is reversed', () => {
    writeFileSync(join(game(), 'conductor-last.json'), JSON.stringify({ primary: 'svg', secondary: 'p5', ts: '2026-11-14T10:00:00.000Z' }));
    writeFileSync(trend(),
      JSON.stringify({ ts: '2026-11-14T10:05:00.000Z', domains: ['p5', 'svg'], axes: 'D=3 A=3 R=3 N=3' }) + '\n');
    runConductorCommand(['check']);
    expect(logs).toEqual(['[conductor] adherence: MISSED declared=["p5","svg"]']);
  });

  it('check with a corrupt trend line degrades to "nothing to check" instead of throwing', () => {
    writeFileSync(trend(), 'not json\n');
    expect(() => runConductorCommand(['check'])).not.toThrow();
    expect(logs).toEqual(['[conductor] no pending plan in the turn window (nothing to check)']);
  });
});
