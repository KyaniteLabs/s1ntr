import { describe, expect, it } from 'vitest';
import { dimensionsForPhase } from '../../../../src/atelier/judging/dimensions.js';
import {
  canPromote,
  JudgingOrgan,
  ProviderPool,
} from '../../../../src/atelier/judging/index.js';
import type { JudgeTransport, JudgementRequest, LaneDescriptor } from '../../../../src/atelier/judging/index.js';

const request: JudgementRequest = { id: 'art-1', artifact: { pixels: 3 } };
const lane = (sense: LaneDescriptor['sense'], model: string): LaneDescriptor => ({
  sense, provider: 'fake', model, transport: 'callable',
});
const scores = (sense: LaneDescriptor['sense'], value: number | null) => Object.fromEntries(
  dimensionsForPhase(sense).map((dimension) => [dimension.id, value]),
);
const allLanes = (): LaneDescriptor[] => [
  lane('R1_PERCEPTUAL', 'eye'), lane('R2_STRUCTURAL', 'code'), lane('R3_INSTRUMENTATION', 'probe'),
];
const registerAll = (pool: ProviderPool, value = 8): void => {
  allLanes().forEach((entry) => {
    const transport: JudgeTransport = async () => ({ scores: scores(entry.sense, value) });
    pool.register(entry, transport);
  });
};

describe('JudgingOrgan', () => {
  it('blocks promotion when any canonical dimension is null', async () => {
    const pool = new ProviderPool();
    allLanes().forEach((entry) => {
      const values = scores(entry.sense, 8);
      if (entry.sense === 'R2_STRUCTURAL') values['code-correctness'] = null;
      const notApplicable = entry.sense === 'R2_STRUCTURAL'
        ? { 'code-correctness': 'not assessed by this fixture' }
        : {};
      pool.register(entry, async () => ({ scores: values, notApplicable }));
    });
    const outcome = await new JudgingOrgan(pool).judge(request);
    expect(outcome.quorumStatus).toBe('complete');
    expect(canPromote(outcome)).toBe(false);
  });

  it('reports throughput counters for scored, deferred, and insufficient work', async () => {
    const scoredPool = new ProviderPool();
    registerAll(scoredPool);
    const organ = new JudgingOrgan(scoredPool);
    await organ.judge(request);
    const deferred = await new JudgingOrgan(new ProviderPool()).judge({ ...request, id: 'deferred' });
    expect(deferred.deferred).toBe(true);
    const insufficientPool = new ProviderPool();
    const failing = lane('R1_PERCEPTUAL', 'failed');
    insufficientPool.register(failing, async () => { throw new Error('down'); });
    const insufficient = await new JudgingOrgan(insufficientPool).judge({ ...request, id: 'failed' });
    expect(insufficient.quorumStatus).toBe('insufficient_quorum');
    expect(organ.stats()).toEqual({ requested: 1, scored: 1, deferred: 0, insufficientQuorum: 0 });
  });

  it('scores a complete fake panel and permits promotion', async () => {
    const pool = new ProviderPool();
    registerAll(pool, 9);
    const outcome = await new JudgingOrgan(pool).judge(request);
    expect(outcome.requestId).toBe('art-1');
    expect(Object.keys(outcome.verdicts)).toHaveLength(3);
    expect(canPromote(outcome)).toBe(true);
  });

  it('passes the request and lane identity to fake transports', async () => {
    const testLane = lane('R1_PERCEPTUAL', 'eye');
    let received: { id: string; model: string } | null = null;
    const pool = new ProviderPool();
    pool.register(testLane, async (receivedRequest, receivedLane) => {
      received = { id: receivedRequest.id, model: receivedLane.model };
      return { scores: scores('R1_PERCEPTUAL', 6) };
    });
    await new JudgingOrgan(pool).judge(request);
    expect(received).toEqual({ id: 'art-1', model: 'eye' });
  });

  it('keeps explicit not-applicable null scores in the verdict', async () => {
    const testLane = lane('R1_PERCEPTUAL', 'eye');
    const values = scores('R1_PERCEPTUAL', 7);
    values['audio-musicality'] = null;
    const pool = new ProviderPool([testLane]);
    pool.register(testLane, async () => ({ scores: values, notApplicable: { 'audio-musicality': 'silent visual work' } }));
    const outcome = await new JudgingOrgan(pool).judge(request);
    expect(outcome.verdicts.R1_PERCEPTUAL.scores['audio-musicality']).toBeNull();
    expect(canPromote(outcome)).toBe(false);
  });

  it('marks incomplete transport output as insufficient quorum', async () => {
    const testLane = lane('R1_PERCEPTUAL', 'eye');
    const pool = new ProviderPool();
    pool.register(testLane, async () => ({ scores: { composition: 8 } }));
    const outcome = await new JudgingOrgan(pool).judge(request);
    expect(outcome.quorumStatus).toBe('insufficient_quorum');
    expect(outcome.failureReason).toBe('insufficient_quorum');
  });
});
