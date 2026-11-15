import { describe, expect, it } from 'vitest';
import { dimensionsForPhase } from '../../../../src/atelier/judging/dimensions.js';
import { JudgingOrgan, LaneBreakers, ProviderPool } from '../../../../src/atelier/judging/index.js';
import type { JudgeTransport, LaneDescriptor } from '../../../../src/atelier/judging/index.js';

const request = { id: 'piece-1', artifact: { kind: 'fake' } } as const;
const lane = (model: string, priority = 0): LaneDescriptor => ({
  sense: 'R1_PERCEPTUAL', provider: 'test', model, transport: 'fake', priority,
});
const phaseLane = (sense: LaneDescriptor['sense'], model: string, priority = 0): LaneDescriptor => ({
  sense, provider: 'test', model, transport: 'fake', priority,
});
const scores = (sense: LaneDescriptor['sense'], value: number) => Object.fromEntries(
  dimensionsForPhase(sense).map((dimension) => [dimension.id, value]),
);
const transportFor = (sense: LaneDescriptor['sense'], value: number): JudgeTransport => async () => ({
  scores: scores(sense, value),
});

describe('quota ladder', () => {
  it('uses a same-sense substitute after the primary fails', async () => {
    const primary = lane('primary');
    const substitute = lane('substitute', 1);
    const pool = new ProviderPool([primary, substitute, phaseLane('R2_STRUCTURAL', 'code'), phaseLane('R3_INSTRUMENTATION', 'probe')]);
    pool.register(primary, async () => { throw new Error('quota'); });
    pool.register(substitute, transportFor('R1_PERCEPTUAL', 7));
    pool.register(phaseLane('R2_STRUCTURAL', 'code'), transportFor('R2_STRUCTURAL', 7));
    pool.register(phaseLane('R3_INSTRUMENTATION', 'probe'), transportFor('R3_INSTRUMENTATION', 7));
    const outcome = await new JudgingOrgan(pool).judge(request);
    expect(outcome.verdicts.R1_PERCEPTUAL.lane).toEqual(substitute);
    expect(outcome.ladder.slice(0, 2).map((step) => step.action)).toEqual(['primary', 'substitute']);
    expect(outcome.quorumStatus).toBe('complete');
  });

  it('defers when no healthy lane is available', async () => {
    const outcome = await new JudgingOrgan(new ProviderPool()).judge(request);
    expect(outcome.deferred).toBe(true);
    expect(outcome.quorumStatus).toBe('deferred');
    expect(Object.values(outcome.verdicts.R1_PERCEPTUAL.scores)).toEqual(
      dimensionsForPhase('R1_PERCEPTUAL').map(() => null),
    );
    expect(outcome.ladder[0]).toMatchObject({ action: 'defer', lane: null });
  });

  it('returns an all-null insufficient-quorum outcome after every lane fails', async () => {
    const primary = lane('primary');
    const substitute = lane('substitute', 1);
    const r2 = phaseLane('R2_STRUCTURAL', 'code');
    const r3 = phaseLane('R3_INSTRUMENTATION', 'probe');
    const pool = new ProviderPool([primary, substitute, r2, r3]);
    const fails: JudgeTransport = async () => { throw new Error('offline'); };
    pool.register(primary, fails);
    pool.register(substitute, fails);
    pool.register(r2, fails);
    pool.register(r3, fails);
    const outcome = await new JudgingOrgan(pool).judge(request);
    expect(outcome.quorumStatus).toBe('insufficient_quorum');
    expect(outcome.deferred).toBe(false);
    expect(Object.values(outcome.verdicts.R1_PERCEPTUAL.scores)).toEqual(
      dimensionsForPhase('R1_PERCEPTUAL').map(() => null),
    );
  });

  it('does not average surviving judges or shrink the denominator', async () => {
    const primary = lane('primary');
    const substitute = lane('substitute', 1);
    const pool = new ProviderPool([primary, substitute]);
    pool.register(primary, transportFor('R1_PERCEPTUAL', 2));
    pool.register(substitute, transportFor('R1_PERCEPTUAL', 10));
    const r2 = phaseLane('R2_STRUCTURAL', 'code');
    const r3 = phaseLane('R3_INSTRUMENTATION', 'probe');
    pool.register(r2, transportFor('R2_STRUCTURAL', 2));
    pool.register(r3, transportFor('R3_INSTRUMENTATION', 2));
    const outcome = await new JudgingOrgan(pool).judge(request);
    expect(outcome.verdicts.R1_PERCEPTUAL.scores['composition']).toBe(2);
    expect(outcome.verdicts.R1_PERCEPTUAL.scores['composition']).not.toBe(6);
  });

  it('records the defer step after a failed lane is benched', async () => {
    const primary = lane('primary');
    const r2 = phaseLane('R2_STRUCTURAL', 'code');
    const r3 = phaseLane('R3_INSTRUMENTATION', 'probe');
    const pool = new ProviderPool([primary, r2, r3], { breakers: new LaneBreakers({ failureThreshold: 1 }) });
    pool.register(primary, async () => { throw new Error('quota'); });
    pool.register(r2, transportFor('R2_STRUCTURAL', 2));
    pool.register(r3, transportFor('R3_INSTRUMENTATION', 2));
    const first = await new JudgingOrgan(pool).judge(request);
    expect(first.quorumStatus).toBe('insufficient_quorum');
    expect(first.ladder.some((step) => step.action === 'defer')).toBe(true);
    const second = await new JudgingOrgan(pool).judge({ ...request, id: 'piece-2' });
    expect(second.quorumStatus).toBe('deferred');
    expect(second.ladder[0].action).toBe('defer');
  });
});
