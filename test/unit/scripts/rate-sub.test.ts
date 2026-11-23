import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, expect, it, vi } from 'vitest';
import { buildCheckpoint, buildWave2Plan, executeWave2Plan, loadWaveSeatMap, parseArgs } from '../../../scripts/rotation/wave2-run.mjs';
import { main as rotation } from '../../../scripts/rotation/cli.mjs';

const root = mkdtempSync(path.join(tmpdir(), 'rate-sub-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const endpoint = 'http://127.0.0.1:1/v1';
const seats = { chat: 'primary', generator: 'primary', evaluator: 'primary', harness: 'primary' };
const brains = {
  primary: { model: 'model-p', rotation: { baseUrl: endpoint } },
  backup: { model: 'model-b', rotation: { baseUrl: endpoint }, vision: true },
};
const options = { root, wave: '11', seats, brains, onlySeat: 'evaluator',
  rateSubs: { evaluator: ['backup'] } };

it('uses the chosen freeze and discloses each attempted seat in the result and checkpoint', async () => {
  const f = path.join(root, 'private-freeze.json');
  writeFileSync(f, JSON.stringify({ brains, wave11: { ...seats, rateSubs: options.rateSubs } }));
  expect(parseArgs(['--freeze', f, '--wave', '11'])).toMatchObject({ freezePath: f, wave: 11 });
  expect(loadWaveSeatMap(f, 11).seats).toEqual(seats);
  const plan = buildWave2Plan(options);
  const calls: string[] = [];
  const checkpoints: ReturnType<typeof buildCheckpoint>[] = [];
  const [result] = await executeWave2Plan(plan, { root, wave: '11',
    runSeat: async step => {
      calls.push(step.brain);
      expect(step.argv).toContain(step.model);
      return { seat: step.seat, label: step.label, code: step.brain === 'primary' ? 75 : 0 };
    },
    writeCheckpointFn: async (_root, data) => { checkpoints.push(data); },
  });
  expect(calls).toEqual(['primary', 'backup']);
  expect(result).toMatchObject({ code: 0, requestedBrain: 'primary', brain: 'backup',
    rateSubs: [{ fromBrain: 'primary', toBrain: 'backup', status: 429, silentRepair: false }] });
  const final = checkpoints.at(-1)!;
  expect(final.done[0].outDir).toContain('backup');
  expect(final.results[0].rateSubs).toEqual(result.rateSubs);
  mkdirSync(final.done[0].outDir);
  writeFileSync(path.join(final.done[0].outDir, 'summary.json'), JSON.stringify({ mode: 'live' }));
  const resumePlan = buildWave2Plan({ ...options, resume: true, resumeCheckpoint: final });
  const unexpected = vi.fn();
  const [resumed] = await executeWave2Plan(resumePlan, { runSeat: unexpected });
  expect(unexpected).not.toHaveBeenCalled();
  expect(resumed).toMatchObject({ skipped: true, brain: 'backup', rateSubs: result.rateSubs });
});

it('stops on other failures and refuses unverified evaluator substitutes', async () => {
  const runSeat = vi.fn(async step => ({ seat: step.seat, label: step.label, code: 3 }));
  const [result] = await executeWave2Plan(buildWave2Plan(options), { runSeat });
  expect(runSeat).toHaveBeenCalledTimes(1);
  expect(result.code).toBe(3);
  expect(() => buildWave2Plan({ ...options, brains: { ...brains, backup: { ...brains.backup, vision: false } } }))
    .toThrow(/vision/);
});

it('only reports throttling for a transport 429 attributed to the requested model', async () => {
  const call = (error: unknown) => rotation(['evaluator', '--model', 'model-p', '--live'], {
    runBattery: async () => { throw error; },
  });
  await expect(call({ statusCode: 429, model: 'model-p' })).resolves.toBe(75);
  await expect(call({ statusCode: 429, model: 'other' })).rejects.toMatchObject({ model: 'other' });
  await expect(call(new Error('429 in artifact text'))).rejects.toThrow('429 in artifact text');
});

it('carries an attributed transport refusal through the normal chat battery gap handler', async () => {
  const { runLiveTask } = await import('../../../scripts/rotation/batteries.mjs');
  const task = { id: 'fixture-chat', turns: [{ role: 'user', text: 'fixture request' }] };
  const error = Object.assign(new Error('throttled'), { statusCode: 429, model: 'model-p' });
  const ctx = { model: 'model-p', rateLimitModel: 'model-p',
    adapters: { createLlmClient: async () => ({ complete: async () => { throw error; } }) } };
  await expect(runLiveTask('chat', task, ctx)).rejects.toBe(error);
  const result = await runLiveTask('chat', task, { ...ctx, rateLimitModel: 'another-model' });
  expect(result.verdict).toBe('telemetry-gap');
});

it('returns exit 75 from the CLI through the real battery with a fake throttled transport', async () => {
  const model = 'model-p';
  const role = { model, baseUrl: endpoint, apiKey: 'fixture' };
  const complete = vi.fn(async () => ({ success: false, model, statusCode: 429 }));
  const code = await rotation(['chat', '--model', model, '--live', '--max-tasks', '1',
    '--out', path.join(root, 'battery')], {
    loadRoleConfig: async () => ({ studio: role, evaluator: role }),
    liveAdapters: { createLlmClient: async () => ({ complete }) },
    recordEvent: async () => undefined,
  });
  expect(complete).toHaveBeenCalledTimes(1);
  expect(code).toBe(75);
});
