/**
 * Wave 2 runner: freeze-driven seats + modular skip/resume/kill-switch (no live LLM).
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  loadWave2SeatMap,
  loadWaveSeatMap,
  buildSeatArgv,
  parseArgs,
  isWaveSpendKilled,
  seatHasLiveSummary,
  buildWave2Plan,
  buildCheckpoint,
  executeWave2Plan,
  SEAT_ORDER,
} from '../../../scripts/rotation/wave2-run.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const freezePath = path.join(root, 'docs/agents/waves/tour-seat-live-freeze.json');

describe('wave2-run freeze-driven seats', () => {
  it('loads freeze.wave2 K3/Grok/GLM/Sol + fixedJudge', () => {
    const { seats, fixedJudge } = loadWave2SeatMap(freezePath);
    expect(seats).toEqual({
      harness: 'K3',
      generator: 'Grok',
      evaluator: 'GLM',
      chat: 'Sol',
    });
    expect(fixedJudge?.model).toBe('gemini-3.1-pro-low');
    expect(fixedJudge?.route).toBe('agy-cliproxy');
  });

  it('buildSeatArgv wires Grok auth flag and K3 kilo base', () => {
    const grok = buildSeatArgv('generator', 'Grok', { outDir: '/tmp/g' });
    expect(grok.argv).toContain('--auth');
    expect(grok.argv).toContain('grok');
    expect(grok.argv).toContain('grok-4.6'); // model follows the wave2 freeze map (scripts/rotation/wave2-run.mjs)
    expect(grok.model).toBe('grok-4.6');

    const k3 = buildSeatArgv('harness', 'K3', { outDir: '/tmp/h', maxTasks: 1 });
    expect(k3.argv).toContain('kimi-k3'); // k3 rides cliproxy per current freeze map
    expect(k3.argv).toContain('http://localhost:8317/v1');
    expect(k3.argv).toContain('--max-tasks');
    expect(k3.argv[k3.argv.indexOf('--max-tasks') + 1]).toBe('1');

    const glm = buildSeatArgv('evaluator', 'GLM', { outDir: '/tmp/e' });
    expect(glm.argv).toContain('glm-5.2:latest'); // follows wave2 freeze map (ollama)
    expect(glm.argv).toContain('http://localhost:11434/v1'); // wave2 GLM rides local ollama per map

    const sol = buildSeatArgv('chat', 'Sol', { outDir: '/tmp/c' });
    expect(sol.argv).toContain('gpt-5.6-sol');
    expect(sol.argv).toContain('http://localhost:8317/v1');
  });

  it('rejects incomplete freeze wave2 map', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'w2-freeze-'));
    const bad = path.join(dir, 'freeze.json');
    fs.writeFileSync(bad, JSON.stringify({ wave2: { harness: 'K3' } }));
    expect(() => loadWave2SeatMap(bad)).toThrow(/harness, generator, evaluator, chat/);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('loads freeze.wave4 Sol/K3/Grok/GLM leverage map', () => {
    const { seats, waveKey } = loadWaveSeatMap(freezePath, 4);
    expect(waveKey).toBe('wave4');
    expect(seats).toEqual({
      harness: 'Sol',
      generator: 'K3',
      evaluator: 'Grok',
      chat: 'GLM',
    });
  });

  it('rejects unknown brain', () => {
    expect(() => buildSeatArgv('harness', 'Opus', { outDir: '/tmp/x' })).toThrow(/unknown brain/);
  });
});

describe('wave2-run modular controls', () => {
  it('isWaveSpendKilled treats 0/false/off/no as killed', () => {
    expect(isWaveSpendKilled({})).toBe(false);
    expect(isWaveSpendKilled({ LIMINAL_WAVE_SPEND: '1' })).toBe(false);
    expect(isWaveSpendKilled({ LIMINAL_WAVE_SPEND: '0' })).toBe(true);
    expect(isWaveSpendKilled({ LIMINAL_WAVE_SPEND: 'false' })).toBe(true);
    expect(isWaveSpendKilled({ LIMINAL_WAVE_SPEND: 'OFF' })).toBe(true);
    expect(isWaveSpendKilled({ LIMINAL_WAVE_SPEND: 'no' })).toBe(true);
  });

  it('parseArgs: skip seats, only-seat, resume-stamp', () => {
    const a = parseArgs([
      '--skip-generator',
      '--skip-chat',
      '--only-seat',
      'evaluator',
      '--resume-stamp',
      '2026-07-29T05-00-00',
      '--max-tasks',
      '2',
    ]);
    expect(a.skipSeats.sort()).toEqual(['chat', 'generator']);
    expect(a.onlySeat).toBe('evaluator');
    expect(a.resumeStamp).toBe('2026-07-29T05-00-00');
    expect(a.maxTasks).toBe(2);
    expect(a.wave).toBe(2);
    expect(parseArgs(['--wave', '4']).wave).toBe(4);
    expect(() => parseArgs(['--only-seat', 'nope'])).toThrow(/only-seat/);
    expect(() => parseArgs(['--skip-opus'])).toThrow(/unknown --skip/);
  });

  it('parseArgs: --skip-harness sets harnessMode skip', () => {
    const a = parseArgs(['--skip-harness', '--harness-smoke']);
    expect(a.skipSeats).toContain('harness');
    expect(a.harnessMode).toBe('skip');
  });

  it('seatHasLiveSummary only true for mode=live', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'w2-sum-'));
    expect(seatHasLiveSummary(dir)).toBe(false);
    fs.writeFileSync(path.join(dir, 'summary.json'), JSON.stringify({ mode: 'live-partial' }));
    expect(seatHasLiveSummary(dir)).toBe(false);
    fs.writeFileSync(path.join(dir, 'summary.json'), JSON.stringify({ mode: 'live' }));
    expect(seatHasLiveSummary(dir)).toBe(true);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('buildWave2Plan: only-seat + skip + resume live', () => {
    const seats = { harness: 'K3', generator: 'Grok', evaluator: 'GLM', chat: 'Sol' };
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'w2-plan-'));
    // pre-seed generator live summary
    const genDir = path.join(root, 'generator-grok');
    fs.mkdirSync(genDir, { recursive: true });
    fs.writeFileSync(path.join(genDir, 'summary.json'), JSON.stringify({ mode: 'live', northStar: 0.8 }));

    const plan = buildWave2Plan({
      seats,
      root,
      onlySeat: null,
      skipSeats: ['chat'],
      harnessMode: 'smoke',
      resume: true,
    });
    expect(plan.map((p) => p.seat)).toEqual(SEAT_ORDER);
    const gen = plan.find((p) => p.seat === 'generator');
    expect(gen?.skipped).toBe(true);
    expect(gen?.skipReason).toBe('resume-live-summary');
    const chat = plan.find((p) => p.seat === 'chat');
    expect(chat?.skipped).toBe(true);
    expect(chat?.skipReason).toBe('flag');
    const harness = plan.find((p) => p.seat === 'harness');
    expect(harness?.skipped).toBe(false);
    expect(harness?.argv).toContain('--max-tasks');
    expect(harness?.argv[harness.argv.indexOf('--max-tasks') + 1]).toBe('1');

    const only = buildWave2Plan({
      seats,
      root,
      onlySeat: 'evaluator',
      skipSeats: [],
      resume: false,
    });
    expect(only).toHaveLength(1);
    expect(only[0].seat).toBe('evaluator');
    expect(only[0].skipped).toBe(false);

    fs.rmSync(root, { recursive: true, force: true });
  });

  it('buildCheckpoint lists done/pending/skipped', () => {
    const plan = [
      {
        seat: 'generator',
        brain: 'Grok',
        skipped: false,
        label: 'generator-grok',
        outDir: '/tmp/g',
      },
      {
        seat: 'chat',
        brain: 'Sol',
        skipped: true,
        skipReason: 'flag',
        label: 'chat-skipped',
        outDir: '/tmp/c',
      },
    ];
    const results = [{ seat: 'generator', label: 'generator-grok', code: 0 }];
    const cp = buildCheckpoint({
      stamp: 's1',
      root: '/tmp/root',
      tip: 'deadbeef',
      freezeHash: 'sha256:abc',
      seats: { generator: 'Grok', chat: 'Sol' },
      fixedJudge: null,
      plan,
      results,
    });
    expect(cp.schema).toBe('sinter-wave2-checkpoint-v1');
    expect(cp.done.map((d) => d.seat)).toEqual(['generator']);
    expect(cp.skipped.map((s) => s.seat)).toEqual(['chat']);
    expect(cp.pending).toEqual([]);
    expect(cp.tip).toBe('deadbeef');
  });

  it('parseArgs defaults to parallel concurrency', () => {
    expect(parseArgs([]).concurrency).toBe('parallel');
    expect(parseArgs(['--sequential']).concurrency).toBe('sequential');
    expect(parseArgs(['--parallel']).concurrency).toBe('parallel');
  });

  it('executeWave2Plan parallel runs active seats concurrently (not serial sum)', async () => {
    const started: number[] = [];
    const seats = { harness: 'K3', generator: 'Grok', evaluator: 'GLM', chat: 'Sol' };
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'w2-par-'));
    const plan = buildWave2Plan({
      seats,
      root,
      skipSeats: [],
      resume: false,
    });
    expect(plan.filter((p) => !p.skipped)).toHaveLength(4);

    const delayMs = 80;
    const results = await executeWave2Plan(plan, {
      concurrency: 'parallel',
      tip: 'deadbeef',
      freezeHash: 'sha256:x',
      seats,
      stamp: 't1',
      root,
      runSeat: async (step) => {
        started.push(Date.now());
        await new Promise((r) => setTimeout(r, delayMs));
        return {
          seat: step.seat,
          label: step.label,
          code: 0,
          argv: step.argv,
          parallel: true,
          latencyMs: delayMs,
        };
      },
    });

    expect(results).toHaveLength(4);
    // All four should start within one delay window if parallel (serial would be ~4x delay)
    const spread = Math.max(...started) - Math.min(...started);
    expect(spread).toBeLessThan(delayMs);
    // checkpoint written
    const cp = JSON.parse(fs.readFileSync(path.join(root, 'wave2-checkpoint.json'), 'utf8'));
    expect(cp.schema).toBe('sinter-wave2-checkpoint-v1');
    expect(cp.done.length).toBe(4);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('executeWave2Plan sequential starts seats one after another', async () => {
    const started: number[] = [];
    const seats = { harness: 'K3', generator: 'Grok', evaluator: 'GLM', chat: 'Sol' };
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'w2-seq-'));
    const plan = buildWave2Plan({
      seats,
      root,
      onlySeat: null,
      skipSeats: ['chat', 'harness'],
      resume: false,
    });
    const delayMs = 50;
    await executeWave2Plan(plan, {
      concurrency: 'sequential',
      tip: 't',
      freezeHash: 'h',
      seats,
      stamp: 's',
      root,
      runSeat: async (step) => {
        started.push(Date.now());
        await new Promise((r) => setTimeout(r, delayMs));
        return { seat: step.seat, label: step.label, code: 0, argv: step.argv, parallel: false };
      },
    });
    // generator then evaluator: start gap should be >= delay
    expect(started.length).toBe(2);
    expect(started[1] - started[0]).toBeGreaterThanOrEqual(delayMs - 5);
    fs.rmSync(root, { recursive: true, force: true });
  });
});
