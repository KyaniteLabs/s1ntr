import { describe, it, expect } from 'vitest';
import {
  parseTrendScores,
  detectSeriesTransitions,
  detectPhaseTransitions,
  rollingTailStats,
  type TrendScorePoint,
} from '../../../src/evolution/PhaseTransitions.js';

// ═══ Deterministic noise (mulberry32 — same PRNG the LatentField uses) ═══

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Bounded symmetric noise in [-amp, +amp] — reproducible across machines. */
function noise(seed: number, n: number, amp: number): number[] {
  const rng = mulberry32(seed);
  return Array.from({ length: n }, () => (rng() * 2 - 1) * amp);
}

function seriesWithTransition(
  n1: number, n2: number, base: number, shift: number, amp: number, seed = 42,
): number[] {
  return [...noise(seed, n1, amp).map((v) => base + v),
          ...noise(seed + 1, n2, amp).map((v) => base + shift + v)];
}

function toPoints(scores: number[], domain = 'p5'): TrendScorePoint[] {
  return scores.map((score, seq) => ({
    seq, domain, score, ts: new Date(2026, 0, 1, 0, seq).toISOString(),
  }));
}

// The statistic flags the cut where the after-window first becomes majority
// new-regime: for a step of |shift| with minSigma dominating, that is when
// ≥5 of 8 window points are shifted (Δmean ≥ 5·|shift|/8 > k·minSigma), i.e.
// a few observations before the true change point. Assertions use tight
// ranges around the geometric expectation, plus exact counts/directions.

// ═══ parseTrendScores ═══

describe('parseTrendScores', () => {
  it('keeps axes-bearing rows and drops generation_context / malformed rows', () => {
    const text = [
      JSON.stringify({ turn: 1, domain: 'p5', axes: 'D=2.00 A=3.00 R=4.00 N=3.00', artifact: '/a/1' }),
      JSON.stringify({ event_type: 'generation_context', schema_version: 'sinter.trend/1.1', turn: 2, domain: 'p5' }),
      'not json at all',
      JSON.stringify({ ts: '2026-08-26T20:09:42Z', event_type: 'artifact_scored', domain: 'three', axes: 'D=4.00 A=4.00 R=4.00 N=4.00 | backfill', artifact: '/a/2' }),
      JSON.stringify({ turn: 3, domain: 'p5' }), // no axes — filtered
    ].join('\n');
    const points = parseTrendScores(text);
    expect(points).toHaveLength(2);
    expect(points[0]).toMatchObject({ seq: 0, domain: 'p5', score: 3.0, turn: 1, artifact: '/a/1' });
    expect(points[1]).toMatchObject({ seq: 3, domain: 'three', score: 4.0, ts: '2026-08-26T20:09:42Z' });
    expect(points[1].turn).toBeUndefined();
  });

  it('returns empty for empty input', () => {
    expect(parseTrendScores('')).toEqual([]);
  });
});

// ═══ detectSeriesTransitions — the documented two-window rolling z ═══

describe('detectSeriesTransitions', () => {
  it('detects a known upward transition near the true cut point, once', () => {
    // 30 obs at 3.0 ± 0.25, then 30 at 4.2 ± 0.25 — shift = 1.2 ≈ 5σ
    const scores = seriesWithTransition(30, 30, 3.0, 1.2, 0.25);
    const hits = detectSeriesTransitions(scores, { window: 8, kSigma: 3.0, minSigma: 0.2 });
    expect(hits).toHaveLength(1);
    expect(hits[0].index).toBeGreaterThanOrEqual(25);
    expect(hits[0].index).toBeLessThanOrEqual(30);
    expect(hits[0].afterMean).toBeGreaterThan(hits[0].beforeMean);
    expect(hits[0].z).toBeGreaterThan(3.0);
    // the flag fires when the after-window is majority new-regime, so its
    // mean is a mixture: clearly lifted off the old plateau, below the new
    expect(hits[0].beforeMean).toBeLessThan(3.4);
    expect(hits[0].afterMean).toBeGreaterThan(hits[0].beforeMean + 0.5);
    expect(hits[0].afterMean).toBeLessThan(4.2);
  });

  it('detects a known downward transition with the after-mean below the before-mean', () => {
    const scores = seriesWithTransition(30, 30, 4.0, -1.5, 0.2, 7);
    const hits = detectSeriesTransitions(scores, { window: 8, kSigma: 3.0, minSigma: 0.2 });
    expect(hits).toHaveLength(1);
    expect(hits[0].index).toBeGreaterThanOrEqual(24);
    expect(hits[0].index).toBeLessThanOrEqual(30);
    expect(hits[0].afterMean).toBeLessThan(hits[0].beforeMean);
  });

  it('flags a stable series zero times', () => {
    for (const seed of [1, 2, 3, 99]) {
      const scores = noise(seed, 60, 0.25).map((v) => 3.0 + v);
      const hits = detectSeriesTransitions(scores, { window: 8, kSigma: 3.0, minSigma: 0.2 });
      expect(hits).toEqual([]);
    }
  });

  it('never scans series shorter than two windows', () => {
    expect(detectSeriesTransitions([3, 3, 3, 4, 4, 4, 4, 5], {})).toEqual([]);
  });

  it('detects each of two separated regime changes once', () => {
    const scores = [
      ...noise(11, 24, 0.2).map((v) => 2.5 + v),
      ...noise(12, 24, 0.2).map((v) => 3.7 + v),
      ...noise(13, 24, 0.2).map((v) => 2.6 + v),
    ];
    const hits = detectSeriesTransitions(scores, { window: 8, kSigma: 3.0, minSigma: 0.2 });
    expect(hits).toHaveLength(2);
    expect(hits[0].index).toBeGreaterThanOrEqual(19);
    expect(hits[0].index).toBeLessThanOrEqual(24);
    expect(hits[0].afterMean).toBeGreaterThan(hits[0].beforeMean); // up at 24
    expect(hits[1].index).toBeGreaterThanOrEqual(43);
    expect(hits[1].index).toBeLessThanOrEqual(48);
    expect(hits[1].afterMean).toBeLessThan(hits[1].beforeMean); // down at 48
  });
});

// ═══ detectPhaseTransitions — per-domain grouping + provenance ═══

describe('detectPhaseTransitions', () => {
  it('reports transitions per domain with ts provenance and direction', () => {
    const points: TrendScorePoint[] = [
      ...toPoints(seriesWithTransition(30, 30, 3.0, 1.2, 0.25), 'p5'),
      ...toPoints(noise(5, 60, 0.2).map((v) => 3.5 + v), 'glsl'),
    ];
    const transitions = detectPhaseTransitions(points, { window: 8, kSigma: 3.0, minSigma: 0.2 });
    expect(transitions).toHaveLength(1);
    expect(transitions[0].domain).toBe('p5');
    expect(transitions[0].index).toBeGreaterThanOrEqual(25);
    expect(transitions[0].index).toBeLessThanOrEqual(30);
    expect(transitions[0].direction).toBe('up');
    expect(transitions[0].ts).toBe(points[transitions[0].index].ts);
  });

  it('quiet domains produce nothing while a neighbor shifts', () => {
    const points: TrendScorePoint[] = [
      ...toPoints(seriesWithTransition(24, 24, 3.0, -1.2, 0.2, 8), 'hydra'),
      ...toPoints(noise(9, 48, 0.2).map((v) => 3.0 + v), 'tone'),
    ];
    const transitions = detectPhaseTransitions(points, { window: 8, kSigma: 3.0, minSigma: 0.2 });
    expect(transitions.map((t) => t.domain)).toEqual(['hydra']);
    expect(transitions[0].direction).toBe('down');
  });
});

// ═══ rollingTailStats ═══

describe('rollingTailStats', () => {
  it('summarizes the tail window per domain', () => {
    const points = toPoints([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 'p5');
    const stats = rollingTailStats(points, 4);
    expect(stats).toHaveLength(1);
    expect(stats[0].n).toBe(10);
    expect(stats[0].mean).toBeCloseTo(8.5, 10);
    expect(stats[0].sd).toBeCloseTo(1.2909944487358056, 10);
  });
});
