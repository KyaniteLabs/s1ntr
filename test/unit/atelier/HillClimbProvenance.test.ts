import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  calibrationId, defaultFingerprint, jsonlStepSink, runHillClimb,
  type AcceptanceCalibration, type HillClimbConfig, type HillClimbPorts,
} from '../../../src/atelier/HillClimb.js';

// #1423 PR 2: a run is replayable from its log: seed, domain, calibration id
// and artifact ids are on every step.
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

const CAL: AcceptanceCalibration = {
  schema: 'sinter.hillclimb-calibration.v1', alphaAccept: 0.1, alphaMiss: 0.1, delta: 0.1, samples: 261,
  improvements: 61, acceptAt: 0.8, rejectAt: 0.2, rejectErrorCeiling: 0.02, coverage: 0.9, ece: 0.1, brier: 0.01,
};

/** Deterministic fake ports: every random choice comes from the loop's own seed. */
function ports(): HillClimbPorts<string> {
  let n = 0;
  return {
    propose: async ({ incumbent, target, widen }) => `${incumbent}|${target}${widen ? '+' : ''}${(n += 1)}`,
    oracle: async (_a, b) => (b.length % 3) / 2,
    verify: async (_a, b) => b.length % 2 === 0,
  };
}
const config = (over: Partial<HillClimbConfig<string>> = {}): HillClimbConfig<string> => ({
  targets: ['palette', 'motion', 'layout'], maxSteps: 25, calibration: CAL, patience: 4,
  auditRate: 0.3, seed: 42, domain: 'p5-sketch', ...over,
});

async function logOf(over: Partial<HillClimbConfig<string>> = {}): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'hillclimb-prov-'));
  dirs.push(dir);
  const path = join(dir, 'steps.jsonl');
  await runHillClimb('seed-sketch', ports(), config({ ...over, onStep: jsonlStepSink(path) }));
  return readFileSync(path, 'utf8');
}

describe('runHillClimb provenance (#1423 PR 2)', () => {
  it('same seed and fake ports give a byte-identical log', async () => {
    const first = await logOf();
    expect(first.length).toBeGreaterThan(0);
    expect(await logOf()).toBe(first);
  });

  it('a different seed gives a different log', async () => {
    expect(await logOf({ seed: 43 })).not.toBe(await logOf());
  });

  it('writes seed, domain, calibration id and artifact ids on every step', async () => {
    const result = await runHillClimb('seed-sketch', ports(), config({ maxSteps: 3 }));
    const first = result.steps[0];
    expect(first).toMatchObject({
      seed: 42, domain: 'p5-sketch', calibrationId: calibrationId(CAL),
      incumbentId: defaultFingerprint('seed-sketch'),
    });
    expect(first.candidateId).toMatch(/^[0-9a-f]{64}$/);
    expect(first.candidateId).not.toBe(first.incumbentId);
  });

  it('a failed proposal has no candidate id', async () => {
    const failing: HillClimbPorts<string> = { ...ports(), propose: async () => { throw new Error('down'); } };
    const result = await runHillClimb('x', failing, config({ maxSteps: 1 }));
    expect(result.steps[0]).toMatchObject({ candidateId: null, incumbentId: defaultFingerprint('x') });
  });

  it('calibration id is content-addressed and null without a calibration', () => {
    expect(calibrationId(null)).toBeNull();
    expect(calibrationId({ ...CAL })).toBe(calibrationId(CAL));
    expect(calibrationId({ ...CAL, acceptAt: 0.85 })).not.toBe(calibrationId(CAL));
    const reordered = Object.fromEntries(Object.entries(CAL).reverse()) as unknown as AcceptanceCalibration;
    expect(calibrationId(reordered)).toBe(calibrationId(CAL));
  });

  it('refuses a run without a usable seed or domain', async () => {
    await expect(runHillClimb('x', ports(), config({ seed: Number.NaN }))).rejects.toThrow('seed must be a safe integer');
    await expect(runHillClimb('x', ports(), config({ seed: 1.5 }))).rejects.toThrow('seed must be a safe integer');
    await expect(runHillClimb('x', ports(), config({ domain: ' ' }))).rejects.toThrow('domain is required');
  });

  it('uses a custom fingerprint when given', async () => {
    const result = await runHillClimb('abc', ports(), config({ maxSteps: 1, fingerprint: a => `len:${a.length}` }));
    expect(result.steps[0].incumbentId).toBe('len:3');
  });
});
