/**
 * Organ: holdout / score seal. Real selectScoreSealedParents: only admitted, non-degraded, judge-matched
 * pieces above the floor become parents; owner likes outrank score; down-graded pieces never leak in.
 */
import { describe, expect, it } from 'vitest';
import { DEFAULT_SCORE_SEAL_POLICY, selectScoreSealedParents, type ScoreSealCandidate } from '../../src/learning/ScoreSeal.js';

const policy = { ...DEFAULT_SCORE_SEAL_POLICY, judge: 'j1' };
const cand = (i: number, o: Partial<ScoreSealCandidate> = {}): ScoreSealCandidate => ({
  createKey: `k${i}`, score: 0.8, domain: 'p5', seat: `s${i}`, judge: 'j1', lineageId: `l${i}`, artifactDigest: `d${i}`,
  admissionEligible: true, degraded: false, identityValid: true, ...o });

describe('organ: holdout / score seal', () => {
  it('seals when enough clean parents exist and emits idempotent dream commands', () => {
    const r = selectScoreSealedParents([0, 1, 2, 3].map(i => cand(i)), policy);
    expect(r.sealed).toBe(true);
    expect(r.groups).toHaveLength(2);
    expect(r.groups[0]!.command.schema).toBe('sinter.dream-product-command');
  });
  it('perturbation: degraded, wrong-judge, low-score or unadmitted pieces never become parents', () => {
    const bad = [cand(0, { degraded: true }), cand(1, { judge: 'other' }), cand(2, { score: 0.1 }), cand(3, { admissionEligible: false })];
    const r = selectScoreSealedParents([...bad, cand(4), cand(5), cand(6)], policy);
    expect(r.sealed).toBe(false);
    const ok = selectScoreSealedParents([...bad, cand(4), cand(5), cand(6), cand(7)], policy);
    const keys = ok.groups.flatMap(g => g.createKeys);
    expect(keys.sort()).toEqual(['k4', 'k5', 'k6', 'k7']);
  });
  it('an owner like outranks a higher score', () => {
    const r = selectScoreSealedParents([cand(0, { score: 0.99 }), cand(1, { score: 0.99 }), cand(2, { score: 0.99 }),
      cand(3, { score: 0.65, likedAt: '2026-11-18T00:00:00Z' })], { ...policy, topPerDomain: 8 });
    expect(r.provenance.parents.map(p => p.createKey)).toContain('k3');
  });
});
