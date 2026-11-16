import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  jsonlStepSink, runHillClimb, type AcceptanceCalibration, type HillClimbPorts, type HillClimbStep,
} from '../../../src/atelier/HillClimb.js';

// #1423 PR 1: every finished step reaches disk before the next port call, and a
// port that throws becomes a recorded step instead of aborting the whole run.
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const logPath = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'hillclimb-log-'));
  dirs.push(dir);
  return join(dir, 'run', 'steps.jsonl');
};
const readLog = (path: string): HillClimbStep[] =>
  readFileSync(path, 'utf8').trim().split('\n').map(line => JSON.parse(line) as HillClimbStep);

const base = { targets: ['palette'], seed: 7, domain: 'test', auditRate: 0, calibration: null, patience: 10 };
const oracle: HillClimbPorts<number>['oracle'] = async (a, b) => (b > a ? 0.7 : 0.4);
const verify: HillClimbPorts<number>['verify'] = async (a, b) => b > a;

describe('runHillClimb step log and port failures (#1423)', () => {
  it('propose throws on step 3: steps 1-2 are on disk, step 3 holds the error', async () => {
    const path = logPath();
    let calls = 0;
    const seenOnDisk: number[] = [];
    const ports: HillClimbPorts<number> = {
      propose: async ({ incumbent }) => {
        calls += 1;
        if (calls >= 2) seenOnDisk.push(readLog(path).length);
        if (calls === 3) throw new Error('proposer timed out');
        return incumbent + 1;
      },
      oracle, verify,
    };
    const result = await runHillClimb(0, ports, { ...base, maxSteps: 3, onStep: jsonlStepSink(path) });

    // The log was written before the next proposal was even requested.
    expect(seenOnDisk).toEqual([1, 2]);
    const log = readLog(path);
    expect(log).toHaveLength(3);
    expect(log.slice(0, 2).map(s => [s.step, s.accepted, s.error])).toEqual([[1, true, null], [2, true, null]]);
    expect(log[2]).toMatchObject({ step: 3, accepted: false, gold: null, error: { port: 'propose', message: 'proposer timed out' } });
    expect(result).toMatchObject({ incumbent: 2, stopped: 'budget', portFailures: 1 });
  });

  it('a verifier throw is a recorded, rejected step and the run goes on', async () => {
    let calls = 0;
    const ports: HillClimbPorts<number> = {
      propose: async ({ incumbent }) => incumbent + 1,
      oracle,
      verify: async (a, b) => { calls += 1; if (calls === 1) throw new Error('render crashed'); return b > a; },
    };
    const result = await runHillClimb(0, ports, { ...base, maxSteps: 2 });
    expect(result.steps.map(s => [s.accepted, s.error?.port ?? null])).toEqual([[false, 'verify'], [true, null]]);
    expect(result.incumbent).toBe(1);
  });

  it('stops as infra after maxConsecutiveFailures failures in a row', async () => {
    const ports: HillClimbPorts<number> = {
      propose: async () => { throw new Error('seat down'); },
      oracle, verify,
    };
    const result = await runHillClimb(0, ports, { ...base, maxSteps: 50, maxConsecutiveFailures: 3 });
    expect(result.stopped).toBe('infra');
    expect(result.steps).toHaveLength(3);
    expect(result.portFailures).toBe(3);
  });

  it('a success resets the failure streak', async () => {
    let calls = 0;
    const ports: HillClimbPorts<number> = {
      propose: async ({ incumbent }) => { calls += 1; if (calls % 3 !== 0) throw new Error('flaky'); return incumbent + 1; },
      oracle, verify,
    };
    const result = await runHillClimb(0, ports, { ...base, maxSteps: 9, maxConsecutiveFailures: 3 });
    expect(result.stopped).toBe('budget');
    expect(result.portFailures).toBe(6);
    expect(result.incumbent).toBe(3);
  });

  it('records why the oracle failed while the step still escalates', async () => {
    const ports: HillClimbPorts<number> = {
      propose: async ({ incumbent }) => incumbent + 1,
      oracle: async () => { throw new Error('d1 cold'); },
      verify,
    };
    const result = await runHillClimb(0, ports, { ...base, maxSteps: 1 });
    expect(result.steps[0]).toMatchObject({ p: null, decision: 'escalate', gold: true, accepted: true, error: { port: 'oracle', message: 'd1 cold' } });
    expect(result.portFailures).toBe(0);
  });

  it('a checkpoint check that throws rolls back to the checkpoint', async () => {
    const cal: AcceptanceCalibration = {
      schema: 'sinter.hillclimb-calibration.v1', alphaAccept: 0.1, alphaMiss: 0.1, delta: 0.1, samples: 261,
      improvements: 61, acceptAt: 0.8, rejectAt: 0.2, rejectErrorCeiling: 0.02, coverage: 0.9, ece: 0.1, brier: 0.01,
    };
    const ports: HillClimbPorts<number> = {
      propose: async ({ incumbent }) => incumbent + 1,
      oracle: async () => 0.9,
      verify: async () => { throw new Error('judge panel down'); },
    };
    const result = await runHillClimb(0, ports, { ...base, calibration: cal, maxSteps: 2 });
    expect(result.incumbent).toBe(0);
    expect(result).toMatchObject({ rollbacks: 1, portFailures: 1 });
  });

  it('a sink that throws stops the run', async () => {
    const ports: HillClimbPorts<number> = { propose: async ({ incumbent }) => incumbent + 1, oracle, verify };
    await expect(runHillClimb(0, ports, {
      ...base, maxSteps: 3, onStep: () => { throw new Error('disk full'); },
    })).rejects.toThrow('disk full');
  });
});
