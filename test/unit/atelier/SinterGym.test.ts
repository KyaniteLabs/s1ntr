import { describe, expect, it } from 'vitest';
import { SinterGym, writePolicyManifest } from '../../../src/atelier/SinterGym.js';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('SinterGym (RL environment over the flywheel)', () => {
  it('replays logged turns as episodes with exogenous-baseline rewards', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gym-'));
    mkdirSync(join(dir, '.omx', 'atelier', 'lessons'), { recursive: true });
    writeFileSync(join(dir, '.omx', 'atelier', 'lessons', 'trend.jsonl'),
      '{"turn":1,"domain":"p5","axes":"D=3.0 A=2.5 R=2.0 N=2.0","arm":"active"}\n' +
      '{"turn":2,"domain":"p5","axes":"D=2.0 A=2.0 R=2.0 N=2.0","arm":"control"}\n' +
      '{"turn":3,"domain":"three","axes":"D=2.8 A=2.6 R=2.4 N=2.2","arm":"active"}\n');
    const env = new SinterGym({ rootDir: dir, seed: 42 });
    expect(env.episodeCount).toBe(3);
    const obs = env.reset();
    expect(obs?.domain).toBe('p5');
    const s1 = env.step(SinterGym.zeroAction(0));
    expect(typeof s1.reward).toBe('number');
    let done = false; let total = 0; let steps = 0;
    while (!done) { const s = env.step(null); total += s.reward; done = s.done; steps += 1; }
    expect(steps).toBe(2); // remaining episodes after first step
    expect(Number.isFinite(total)).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });

  it('rewards each turn against its domain median over the whole log', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gym-median-'));
    mkdirSync(join(dir, '.omx', 'atelier', 'lessons'), { recursive: true });
    // glsl qualities arrive unsorted (5, 1, 3): the median is 3, not the last value read.
    writeFileSync(join(dir, '.omx', 'atelier', 'lessons', 'trend.jsonl'), [
      '{"turn":1,"domain":"glsl","axes":"D=5.0 A=5.0 R=2.0 N=2.0"}',
      '{"turn":2,"domain":"p5","axes":"D=3.0 A=2.5 R=2.0 N=2.0"}',
      '{"turn":3,"domain":"glsl","axes":"D=1.0 A=1.0 R=2.0 N=2.0"}',
      '{"turn":4,"domain":"p5","axes":"D=2.0 A=2.0 R=2.0 N=2.0"}',
      '{"turn":5,"domain":"glsl","axes":"D=3.0 A=3.0 R=2.0 N=2.0"}',
      'not json',
    ].join('\n'));
    const env = new SinterGym({ rootDir: dir });
    expect(env.reset()).toEqual({ domain: 'glsl', control_median: 3, turn: 1 });
    const rewards: number[] = [];
    for (;;) { const s = env.step(null); rewards.push(s.reward); if (s.done) break; }
    // glsl median 3 -> 5-3, 1-3, 3-3; p5 qualities 2.75 and 2 -> upper median 2.75.
    expect(rewards).toEqual([2, 0, -2, -0.75, 0]);
    rmSync(dir, { recursive: true, force: true });
  });

  it('has no episodes and ends at once when no trend log exists', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gym-empty-'));
    const env = new SinterGym({ rootDir: dir });
    expect(env.episodeCount).toBe(0);
    expect(env.reset()).toBeNull();
    expect(env.step(null)).toEqual({ observation: null, reward: 0, done: true });
    rmSync(dir, { recursive: true, force: true });
  });

  it('writes a deploy manifest the live loop can consume', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gym2-'));
    const path = writePolicyManifest(dir, { name: 'replay-linear-v1', domain: 'p5', ablateLessonIds: ['x1'], note: 'smoke' });
    expect(path).toContain('policy-manifest.json');
    rmSync(dir, { recursive: true, force: true });
  });
});
