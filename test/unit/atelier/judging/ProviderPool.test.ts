import { describe, expect, it } from 'vitest';
import { LaneBreakers, laneKey, ProviderPool } from '../../../../src/atelier/judging/index.js';
import type { JudgeTransport, LaneDescriptor } from '../../../../src/atelier/judging/index.js';

const lane = (sense: LaneDescriptor['sense'], model: string, priority = 0): LaneDescriptor => ({
  sense, provider: 'test', model, transport: 'fake', priority,
});

describe('ProviderPool', () => {
  it('groups lanes by judging sense', () => {
    const pool = new ProviderPool([lane('R1_PERCEPTUAL', 'eye'), lane('R2_STRUCTURAL', 'code')]);
    expect(pool.lookup('R1_PERCEPTUAL').map((entry) => entry.model)).toEqual(['eye']);
    expect(pool.lookup('R2_STRUCTURAL').map((entry) => entry.model)).toEqual(['code']);
  });

  it('returns primary before same-sense substitutes', () => {
    const primary = lane('R1_PERCEPTUAL', 'primary', 0);
    const substitute = lane('R1_PERCEPTUAL', 'substitute', 1);
    const pool = new ProviderPool([substitute, primary]);
    expect(pool.primary('R1_PERCEPTUAL')).toEqual(primary);
    expect(pool.substitutes('R1_PERCEPTUAL')).toEqual([substitute]);
  });

  it('never returns a lane from another sense as a substitute', () => {
    const pool = new ProviderPool([lane('R1_PERCEPTUAL', 'eye'), lane('R2_STRUCTURAL', 'code')]);
    expect(pool.substitutes('R1_PERCEPTUAL')).toEqual([]);
  });

  it('skips a benched lane during lookup', () => {
    const breakers = new LaneBreakers({ failureThreshold: 1 });
    const primary = lane('R1_PERCEPTUAL', 'primary');
    const substitute = lane('R1_PERCEPTUAL', 'substitute', 1);
    const pool = new ProviderPool([primary, substitute], { breakers });
    pool.recordFailure(primary);
    expect(pool.primary('R1_PERCEPTUAL')).toEqual(substitute);
  });

  it('tracks per-lane attempts, successes, and failures', () => {
    const testLane = lane('R3_INSTRUMENTATION', 'probe');
    const pool = new ProviderPool([testLane]);
    pool.recordFailure(testLane);
    pool.recordSuccess(testLane);
    expect(pool.health(testLane)).toEqual({
      key: laneKey(testLane), attempts: 2, successes: 1, failures: 1, consecutiveFailures: 0,
    });
  });

  it('accepts injected transports by lane key or registration', async () => {
    const first = lane('R1_PERCEPTUAL', 'first');
    const second = lane('R2_STRUCTURAL', 'second');
    const transport: JudgeTransport = async () => ({ scores: { composition: 8 } });
    const pool = new ProviderPool([first], { transports: { [laneKey(first)]: transport } });
    pool.registerJudge(second, transport);
    expect(pool.transportFor(first)).toBe(transport);
    expect(pool.transportFor(second)).toBe(transport);
    await expect(pool.transportFor(first)?.({ id: 'x', artifact: null }, first)).resolves.toEqual({ scores: { composition: 8 } });
  });
});
