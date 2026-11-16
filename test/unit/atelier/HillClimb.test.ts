import { describe, expect, it } from 'vitest';

import {
  ACCEPT_GRID, REJECT_GRID, calibrateAcceptance, decideStep, driftEvidence, pairOracle, parseCalibration,
  plateauRung, runHillClimb,
  type AcceptanceCalibration, type DecisionOracle, type HillClimbPorts, type OracleSample,
} from '../../../src/atelier/HillClimb.js';

const repeat = (count: number, sample: OracleSample): OracleSample[] => Array.from({ length: count }, () => sample);

/** 60 clear improvements, 200 clear non-improvements, one improvement the oracle doubted. */
const MIXED: OracleSample[] = [
  ...repeat(60, { p: 0.9, gold: true }),
  ...repeat(200, { p: 0.1, gold: false }),
  { p: 0.3, gold: true },
];

const calibration = (over: Partial<AcceptanceCalibration> = {}): AcceptanceCalibration => ({
  schema: 'sinter.hillclimb-calibration.v1',
  alphaAccept: 0.1, alphaMiss: 0.1, delta: 0.1, samples: 261, improvements: 61,
  acceptAt: 0.8, rejectAt: 0.2, rejectErrorCeiling: 0.02, coverage: 0.9, ece: 0.1, brier: 0.01,
  ...over,
});

/** Artifacts are numbers and bigger is better; `deltas` scripts what the proposer returns. */
function numberWorld(deltas: readonly number[], oracle: HillClimbPorts<number>['oracle']) {
  const proposals: { target: string; widen: boolean }[] = [];
  let verified = 0;
  const ports: HillClimbPorts<number> = {
    propose: async ({ incumbent, target, widen }) => {
      proposals.push({ target, widen });
      return incumbent + deltas[proposals.length - 1];
    },
    oracle,
    verify: async (incumbent, candidate) => { verified += 1; return candidate > incumbent; },
  };
  return { ports, proposals, verifierCalls: () => verified };
}

describe('calibrateAcceptance', () => {
  it('fixes the threshold grids before any data is seen', () => {
    expect(ACCEPT_GRID).toEqual([0.55, 0.6, 0.65, 0.7, 0.75, 0.8, 0.85, 0.9, 0.95]);
    expect(REJECT_GRID).toEqual([0.45, 0.4, 0.35, 0.3, 0.25, 0.2, 0.15, 0.1, 0.05]);
  });

  it('trusts no threshold without samples, so every step escalates', () => {
    const cal = calibrateAcceptance([]);
    expect(cal).toEqual({
      schema: 'sinter.hillclimb-calibration.v1',
      alphaAccept: 0.1, alphaMiss: 0.1, delta: 0.1, samples: 0, improvements: 0,
      acceptAt: null, rejectAt: null, rejectErrorCeiling: null, coverage: 0, ece: null, brier: null,
    });
    expect(decideStep(0.99, cal)).toBe('escalate');
    expect(decideStep(0.01, cal)).toBe('escalate');
  });

  it('needs 50 clean samples before a 10% tolerance can pass at delta 0.1', () => {
    // 0.9^49 = 0.00573 is above the per-test level 0.1/18 = 0.00556; 0.9^50 = 0.00515 is below it.
    expect(calibrateAcceptance(repeat(49, { p: 0.99, gold: true })).acceptAt).toBeNull();
    expect(calibrateAcceptance(repeat(49, { p: 0.99, gold: true })).rejectAt).toBeNull();
    expect(calibrateAcceptance(repeat(50, { p: 0.99, gold: true })).acceptAt).toBe(0.55);
    // No sample sits at or below any reject threshold, so the wrong-reject rate is unbounded: no reject threshold (bug 13).
    expect(calibrateAcceptance(repeat(50, { p: 0.99, gold: true })).rejectAt).toBeNull();
    const withLows = [...repeat(50, { p: 0.99, gold: true }), ...repeat(29, { p: 0.05, gold: false })];
    expect(calibrateAcceptance(withLows).rejectAt).toBeNull();
    expect(calibrateAcceptance([...withLows, { p: 0.05, gold: false }]).rejectAt).toBe(0.45);
  });

  it('picks the loosest thresholds whose mistake rates are bounded', () => {
    const cal = calibrateAcceptance(MIXED);
    expect(cal.samples).toBe(261);
    expect(cal.improvements).toBe(61);
    // All 60 samples at 0.9 are improvements: 0.9^60 = 0.0018 passes from the lowest grid point.
    expect(cal.acceptAt).toBe(0.55);
    // The doubted improvement at 0.3 is one miss in 61 (tail 0.0126) for thresholds >= 0.3; 0.25 has none.
    expect(cal.rejectAt).toBe(0.25);
    // 200 auto-rejected samples, none an improvement: 1 - 0.1^(1/200).
    expect(cal.rejectErrorCeiling).toBeCloseTo(0.011447, 5);
    expect(cal.coverage).toBeCloseTo(260 / 261, 10);
    expect(cal.brier).toBeCloseTo(3.09 / 261, 10);
    expect(cal.ece).toBeCloseTo(26.7 / 261, 10);
  });

  it('refuses to auto-accept when too many confident answers were wrong', () => {
    const cal = calibrateAcceptance([...MIXED, ...repeat(10, { p: 0.9, gold: false })]);
    expect(cal.acceptAt).toBeNull();
    expect(cal.rejectAt).toBe(0.25);
  });

  it('refuses to auto-reject when the oracle buries real improvements', () => {
    // Rejecting everything would be 97% "accurate" here, yet it discards every improvement.
    const cal = calibrateAcceptance([...repeat(970, { p: 0.02, gold: false }), ...repeat(30, { p: 0.02, gold: true })]);
    expect(cal.rejectAt).toBeNull();
    expect(cal.rejectErrorCeiling).toBeNull();
  });

  it('rejects samples and tolerances that are not probabilities', () => {
    expect(() => calibrateAcceptance([{ p: 1.2, gold: true }])).toThrow('sample 0 needs p in [0, 1]');
    expect(() => calibrateAcceptance([{ p: 0.5, gold: 'yes' as unknown as boolean }])).toThrow('sample 0 needs');
    expect(() => calibrateAcceptance([null as unknown as OracleSample])).toThrow('sample 0 needs');
    expect(() => calibrateAcceptance(MIXED, { alphaAccept: 0 })).toThrow('alphaAccept must be in (0, 1), got 0');
    expect(() => calibrateAcceptance(MIXED, { delta: 1 })).toThrow('delta must be in (0, 1), got 1');
  });
});

describe('parseCalibration', () => {
  it('reads back a stored calibration unchanged', () => {
    const cal = calibrateAcceptance(MIXED);
    expect(parseCalibration(JSON.parse(JSON.stringify(cal)))).toEqual(cal);
  });

  it('reads anything else as no calibration', () => {
    expect(parseCalibration(null)).toBeNull();
    expect(parseCalibration({ ...calibration(), schema: 'other.v1' })).toBeNull();
    expect(parseCalibration({ ...calibration(), acceptAt: '0.8' })).toBeNull();
    expect(parseCalibration({ ...calibration(), rejectAt: 1.5 })).toBeNull();
    expect(parseCalibration({ ...calibration(), alphaAccept: undefined })).toBeNull();
    // Bug 18: overlapping thresholds and tolerances no drift alarm can test are unusable.
    expect(parseCalibration({ ...calibration(), acceptAt: 0.3, rejectAt: 0.3 })).toBeNull();
    expect(parseCalibration({ ...calibration(), acceptAt: 0.2, rejectAt: 0.4 })).toBeNull();
    expect(parseCalibration({ ...calibration(), alphaAccept: 0 })).toBeNull();
    expect(parseCalibration({ ...calibration(), alphaAccept: 1 })).toBeNull();
    expect(parseCalibration({ ...calibration(), rejectErrorCeiling: null })).toBeNull();
    expect(parseCalibration({ ...calibration(), rejectErrorCeiling: 0 })).toBeNull();
    expect(parseCalibration({ ...calibration(), rejectAt: null, rejectErrorCeiling: null })).toMatchObject({ rejectAt: null, rejectErrorCeiling: null });
  });
});

describe('decideStep', () => {
  it('lets the oracle decide only at or past a threshold', () => {
    const cal = calibration();
    expect(decideStep(0.8, cal)).toBe('accept');
    expect(decideStep(0.79, cal)).toBe('escalate');
    expect(decideStep(0.21, cal)).toBe('escalate');
    expect(decideStep(0.2, cal)).toBe('reject');
    expect(decideStep(0.9, calibration({ acceptAt: null }))).toBe('escalate');
    expect(decideStep(0.9, null)).toBe('escalate');
  });

  it('throws on an answer that is not a probability', () => {
    expect(() => decideStep(Number.NaN, calibration())).toThrow('p must be a probability in [0, 1], got NaN');
    expect(() => decideStep(-0.1, calibration())).toThrow('got -0.1');
    expect(() => decideStep(1.01, null)).toThrow('got 1.01');
  });
});

describe('driftEvidence', () => {
  it('doubles with each audited error and shrinks with each clean audit', () => {
    expect(driftEvidence(5, 5, 0.1)).toBeCloseTo(32, 10);
    expect(driftEvidence(0, 10, 0.1)).toBeCloseTo((0.8 / 0.9) ** 10, 12);
    expect(driftEvidence(5, 10, 0.1)).toBeCloseTo(32 * (0.8 / 0.9) ** 5, 10);
  });

  it('reads an untestable tolerance as no evidence', () => {
    expect(driftEvidence(3, 3, 0)).toBe(0);
    expect(driftEvidence(3, 3, 1)).toBe(0);
  });
});

describe('plateauRung', () => {
  it('climbs one rung per patience window and then stops', () => {
    expect([0, 1, 2, 3, 4, 5, 6, 7].map(n => plateauRung(n, 2))).toEqual(
      ['continue', 'continue', 'widen', 'widen', 'switch-target', 'switch-target', 'stop', 'stop']);
  });
});

describe('pairOracle', () => {
  it('asks in both orders and averages out a preference for a slot', async () => {
    const states: string[] = [];
    const model: DecisionOracle = {
      decide: async ({ state, questions }) => {
        states.push(state);
        expect(questions).toEqual({ better: { type: 'noul', instructions: 'Is B better than A under the rubric?' } });
        // Says yes more readily to whatever sits in slot B: 0.9 for the candidate, 0.3 for the incumbent.
        return { answers: { better: { type: 'noul', probability: /<B-\w+>\nNEW\n/.test(state) ? 0.9 : 0.3 } } };
      },
    };
    const p = await pairOracle(model, 'clearer motion')('OLD', 'NEW');
    expect(p).toBeCloseTo(0.8, 12);
    const frame = (a: string, b: string) => new RegExp(
      `^Rubric: clearer motion\\n\\n<A-(\\w+)>\\n${a}\\n</A-\\1>\\n\\n<B-\\1>\\n${b}\\n</B-\\1>$`);
    expect(states).toHaveLength(2);
    expect(states[0]).toMatch(frame('OLD', 'NEW'));
    expect(states[1]).toMatch(frame('NEW', 'OLD'));
  });

  it('fails when the model answers without a probability', async () => {
    const model: DecisionOracle = { decide: async () => ({ answers: { better: { type: 'choice' } } }) };
    await expect(pairOracle(model, 'r')('a', 'b')).rejects.toThrow('HILLCLIMB_ORACLE_BAD_ANSWER');
    const empty: DecisionOracle = { decide: async () => ({ answers: {} }) };
    await expect(pairOracle(empty, 'r')('a', 'b')).rejects.toThrow('HILLCLIMB_ORACLE_BAD_ANSWER');
  });
});

describe('runHillClimb', () => {
  const base = { targets: ['palette'], seed: 7, domain: 'test', auditRate: 0, patience: 10 };

  it('verifies every step while no calibration exists and logs the oracle next to the verdict', async () => {
    const world = numberWorld([1, -1, 2, -3], async (a, b) => (b > a ? 0.7 : 0.4));
    const result = await runHillClimb(0, world.ports, { ...base, maxSteps: 4, calibration: null });
    expect(result.incumbent).toBe(3);
    expect(result.steps.map(s => [s.p, s.decision, s.gold, s.accepted])).toEqual([
      [0.7, 'escalate', true, true], [0.4, 'escalate', false, false],
      [0.7, 'escalate', true, true], [0.4, 'escalate', false, false],
    ]);
    expect(result.verifierCalls).toBe(4);
    expect(world.verifierCalls()).toBe(4);
    expect(result).toMatchObject({ stopped: 'budget', rollbacks: 0, drifted: false });
  });

  it('spends the verifier only on uncertain steps and on the closing checkpoint', async () => {
    const answers = [0.9, 0.1, 0.5];
    let asked = 0;
    const world = numberWorld([1, -1, 2], async () => answers[asked++]);
    const result = await runHillClimb(0, world.ports, { ...base, maxSteps: 3, calibration: calibration() });
    expect(result.steps.map(s => [s.decision, s.gold, s.accepted])).toEqual([
      ['accept', null, true], ['reject', null, false], ['escalate', true, true],
    ]);
    expect(result.incumbent).toBe(3);
    // One escalation plus one comparison of the final incumbent with the last verified checkpoint.
    expect(result.verifierCalls).toBe(2);
    expect(result.rollbacks).toBe(0);
  });

  it('rolls back to the last verified checkpoint when unverified accepts made things worse', async () => {
    const world = numberWorld([-1, -1, -1], async () => 0.95);
    const result = await runHillClimb(10, world.ports, {
      ...base, maxSteps: 3, calibration: calibration(), checkpointEvery: 2,
    });
    expect(result.steps.map(s => s.accepted)).toEqual([true, true, true]);
    // 10 -> 9 -> 8 fails the checkpoint and returns to 10; 10 -> 9 fails the closing check too.
    expect(result.incumbent).toBe(10);
    expect(result.rollbacks).toBe(2);
    expect(result.verifierCalls).toBe(2);
  });

  it('corrects audited mistakes and stops trusting the oracle once they pile up', async () => {
    const world = numberWorld([-1, -1, -1, -1, -1, -1, -1], async () => 0.95);
    const result = await runHillClimb(0, world.ports, {
      ...base, maxSteps: 7, calibration: calibration(), auditRate: 1, patience: 10,
    });
    // Five wrong accepts in five audits: evidence 2^5 = 32 crosses 1 / 0.05 = 20.
    expect(result.steps.map(s => s.decision)).toEqual(
      ['accept', 'accept', 'accept', 'accept', 'accept', 'escalate', 'escalate']);
    expect(result.steps.map(s => s.audited)).toEqual([true, true, true, true, true, false, false]);
    expect(result.steps.every(s => s.gold === false && !s.accepted)).toBe(true);
    expect(result.drifted).toBe(true);
    expect(result.incumbent).toBe(0);
    expect(result.verifierCalls).toBe(7);
  });

  it('widens, switches target, then stops when nothing is accepted', async () => {
    const world = numberWorld([-1, -1, -1, -1, -1, -1, -1, -1], async () => 0.5);
    const result = await runHillClimb(0, world.ports, {
      targets: ['palette', 'motion'], seed: 7, domain: 'test', maxSteps: 8, calibration: null, patience: 2,
    });
    expect(result.stopped).toBe('plateau');
    expect(result.steps.map(s => s.rung)).toEqual(
      ['continue', 'continue', 'widen', 'widen', 'switch-target', 'switch-target']);
    expect(world.proposals.map(p => p.widen)).toEqual([false, false, true, true, true, true]);
    // Switch-target moves off the target the climb was on when the plateau began, on every switch step.
    expect(result.steps[4].target).not.toBe(result.steps[1].target);
    expect(result.steps[5].target).not.toBe(result.steps[1].target);
    expect(result.incumbent).toBe(0);
  });

  it('learns which target pays off', async () => {
    const proposals: string[] = [];
    const ports: HillClimbPorts<number> = {
      propose: async ({ incumbent, target }) => { proposals.push(target); return incumbent + (target === 'motion' ? 1 : -1); },
      oracle: async () => 0.5,
      verify: async (incumbent, candidate) => candidate > incumbent,
    };
    const result = await runHillClimb(0, ports, {
      targets: ['palette', 'motion'], seed: 7, domain: 'test', maxSteps: 60, calibration: null, patience: 60,
    });
    const motion = proposals.filter(t => t === 'motion').length;
    expect(motion).toBeGreaterThanOrEqual(50);
    expect(motion).toBeLessThanOrEqual(60);
    expect(result.incumbent).toBe(motion);
  });

  it('escalates when the oracle fails or answers nonsense', async () => {
    let asked = 0;
    const world = numberWorld([1, 1], async () => {
      asked += 1;
      if (asked === 1) throw new Error('DECISION_TIMEOUT');
      return 7;
    });
    const result = await runHillClimb(0, world.ports, { ...base, maxSteps: 2, calibration: calibration() });
    expect(result.steps.map(s => [s.p, s.decision, s.gold])).toEqual([[null, 'escalate', true], [null, 'escalate', true]]);
    expect(result.incumbent).toBe(2);
  });

  it('records a verifier failure as a step and refuses a run with no target', async () => {
    const world = numberWorld([1], async () => 0.5);
    world.ports.verify = async () => { throw new Error('judge panel unavailable'); };
    const result = await runHillClimb(0, world.ports, { ...base, maxSteps: 1, calibration: null });
    expect(result.incumbent).toBe(0);
    expect(result.steps[0]).toMatchObject({ accepted: false, error: { port: 'verify', message: 'judge panel unavailable' } });
    await expect(runHillClimb(0, world.ports, { ...base, targets: [], maxSteps: 1, calibration: null }))
      .rejects.toThrow('at least one mutation target is required');
  });
});
