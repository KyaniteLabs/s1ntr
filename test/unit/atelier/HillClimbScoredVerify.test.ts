import { describe, expect, it } from 'vitest';

import {
  readVerdict, runHillClimb,
  type AcceptanceCalibration, type HillClimbConfig, type HillClimbPorts, type VerifyVerdict,
} from '../../../src/atelier/HillClimb.js';

// #1423 PR 3 (bug 11): the verifier returns a score difference and a noise
// margin; only a difference above the margin moves the incumbent.
const CAL: AcceptanceCalibration = {
  schema: 'sinter.hillclimb-calibration.v1', alphaAccept: 0.1, alphaMiss: 0.1, delta: 0.1, samples: 261,
  improvements: 61, acceptAt: 0.8, rejectAt: 0.2, rejectErrorCeiling: 0.02, coverage: 0.9, ece: 0.1, brier: 0.01,
};
const config = (over: Partial<HillClimbConfig<string>> = {}): HillClimbConfig<string> => ({
  targets: ['palette'], maxSteps: 4, calibration: CAL, patience: 10, auditRate: 0, seed: 1, domain: 'test', ...over,
});
/** Oracle always unsure, so every step escalates to the verifier. */
function ports(verdict: () => boolean | VerifyVerdict): HillClimbPorts<string> {
  let n = 0;
  return {
    propose: async ({ incumbent }) => `${incumbent}+${(n += 1)}`,
    oracle: async () => 0.5,
    verify: async () => verdict(),
  };
}

describe('readVerdict', () => {
  it('passes a bare boolean through with no verdict', () => {
    expect(readVerdict(true)).toEqual({ gold: true, verdict: null });
    expect(readVerdict(false)).toEqual({ gold: false, verdict: null });
  });
  it('is better only when delta exceeds the margin', () => {
    expect(readVerdict({ delta: 0.3, margin: 0.1 }).gold).toBe(true);
    expect(readVerdict({ delta: 0.1, margin: 0.1 }).gold).toBe(false);
    expect(readVerdict({ delta: 0.05, margin: 0.1 }).gold).toBe(false);
    expect(readVerdict({ delta: -1, margin: 0 }).gold).toBe(false);
  });
  it('rejects malformed verdicts', () => {
    expect(() => readVerdict({ delta: Number.NaN, margin: 0.1 })).toThrow(/HILLCLIMB_VERDICT_INVALID/);
    expect(() => readVerdict({ delta: 0.2, margin: -0.1 })).toThrow(/HILLCLIMB_VERDICT_INVALID/);
    expect(() => readVerdict({ delta: Infinity, margin: 0 })).toThrow(/HILLCLIMB_VERDICT_INVALID/);
  });
});

describe('runHillClimb with scored verdicts (#1423 PR 3)', () => {
  it('a win inside the noise margin does not move the incumbent', async () => {
    const result = await runHillClimb('s', ports(() => ({ delta: 0.05, margin: 0.1 })), config());
    expect(result.incumbent).toBe('s');
    expect(result.steps.every(step => !step.accepted)).toBe(true);
    expect(result.steps[0].verdict).toEqual({ delta: 0.05, margin: 0.1 });
  });

  it('a win above the margin is accepted and recorded', async () => {
    const result = await runHillClimb('s', ports(() => ({ delta: 0.4, margin: 0.1 })), config({ maxSteps: 1 }));
    expect(result.incumbent).toBe('s+1');
    expect(result.steps[0]).toMatchObject({ gold: true, accepted: true, verdict: { delta: 0.4, margin: 0.1 } });
  });

  it('a boolean verifier still works and records no verdict', async () => {
    const result = await runHillClimb('s', ports(() => true), config({ maxSteps: 1 }));
    expect(result.steps[0]).toMatchObject({ gold: true, accepted: true, verdict: null });
  });

  it('a malformed verdict is a recorded verify failure, not an acceptance', async () => {
    const result = await runHillClimb('s', ports(() => ({ delta: Number.NaN, margin: 0 })), config({ maxSteps: 1 }));
    expect(result.incumbent).toBe('s');
    expect(result.steps[0]).toMatchObject({ accepted: false, verdict: null, error: { port: 'verify' } });
  });
});
