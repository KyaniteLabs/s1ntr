import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { applyLikes, mergeProductStores, OWNER_LIKE_RULE, candidatesFromProductStore, skipUnverifiable, selectScoreSealedParents, SCORE_SEAL_RULE,
  type ScoreSealCandidate, type ScoreSealPolicy } from '../../../src/learning/ScoreSeal.js';

const judge = 'glm/glm-5.3-flash';
const policy: ScoreSealPolicy = { minScore: 0.5, topPerDomain: 4, judge, groups: 2, parentsPerGroup: 1 };
const two: ScoreSealPolicy = { ...policy, parentsPerGroup: 2 };
const c = (n: number, over: Partial<ScoreSealCandidate> = {}): ScoreSealCandidate => ({
  createKey: `k${n}`, score: 0.9 - n * 0.05, domain: 'html', seat: `seat${n}`, judge,
  lineageId: `l${n}`, artifactDigest: `a${n}`, admissionEligible: true, degraded: false,
  identityValid: true, ...over });

describe('score-sealed Dream parents', () => {
  it('seals the top scored parents into disjoint groups with plain provenance', () => {
    const r = selectScoreSealedParents([c(1), c(2), c(3), c(4)], policy, new Date('2026-11-18T00:00:00Z'));
    expect(r.sealed).toBe(true);
    expect(r.groups).toHaveLength(2);
    const keys = r.groups.flatMap(g => g.createKeys);
    expect(new Set(keys).size).toBe(keys.length);
    expect(r.groups[0]!.command.evidence.every(e => e.source === 'judge-scoring')).toBe(true);
    expect(r.provenance).toMatchObject({ rule: SCORE_SEAL_RULE, judge, minScore: 0.5,
      sealedAt: '2026-11-18T00:00:00.000Z', handSigned: false });
    expect(r.provenance.ownerDirective).toContain('2026-11-18');
  });
  it('refuses low scores, other judges, degraded or failed creates', () => {
    const bad = [c(1, { score: 0.4 }), c(2, { judge: 'other' }), c(3, { degraded: true }),
      c(4, { failureClass: 'render' }), c(5, { admissionEligible: false })];
    expect(selectScoreSealedParents(bad, policy).sealed).toBe(false);
  });
  it('never reuses an artifact or lineage across parents (independence)', () => {
    const r = selectScoreSealedParents([c(1), c(2, { artifactDigest: 'a1' }),
      c(3, { lineageId: 'l1' })], policy);
    expect(r.sealed).toBe(false);
    expect(r.reason).toMatch(/NEED_2_INDEPENDENT_PARENTS_HAVE_1/);
  });
  it("treats failureClass 'none' as no failure", () => {
    expect(selectScoreSealedParents([c(1, { failureClass: 'none' }), c(2, { failureClass: 'none' })], policy).sealed).toBe(true);
  });
  it('cannot be configured below two groups', () => {
    expect(selectScoreSealedParents([c(1), c(2)], { ...policy, groups: 1 }).reason)
      .toBe('ACTIVATION_NEEDS_AT_LEAST_2_GROUPS');
  });
  it('reads candidates from a product store document', () => {
    const doc = { x: { kind: 'create', result: { domain: 'html', lineageId: 'L', roles: { generator: 'g' },
      receipt: { artifactDigest: 'A' }, evaluation: { score: 0.7, evaluatorIdentity: judge,
        admissionEligible: true, degraded: false, identityValid: true } } }, y: { kind: 'owner-review' } };
    expect(candidatesFromProductStore(doc)).toEqual([expect.objectContaining({
      createKey: 'x', score: 0.7, seat: 'g', artifactDigest: 'A' })]);
  });
});

describe('likes, merge, domain', () => {
  it('owner likes outrank score-only parents and bypass the per-domain cap and the top bar', () => {
    const list = [c(1), c(2), c(3), c(4), c(5, { score: 0.35, seat_dir: 's', piece_id: 'old' })];
    const r = selectScoreSealedParents(applyLikes(list, [{ seat: 's', id: 'old', at: '2026-11-18T01:00:00Z' }]),
      { ...policy, topPerDomain: 2 });
    expect(r.sealed).toBe(true);
    const liked = r.provenance.parents.find(p => p.createKey === 'k5')!;
    expect(liked.signal).toBe(OWNER_LIKE_RULE);
    expect(r.provenance.parents[0]!.createKey).toBe('k5');
  });
  it('never lets a like waive the judge floor, the pinned judge or admission', () => {
    const r = selectScoreSealedParents(applyLikes([c(1), c(2, { score: 0.1, seat_dir: 's', piece_id: 'x' }),
      c(3, { judge: 'x', seat_dir: 's', piece_id: 'y' })], [{ seat: 's', id: 'x', at: 't' }, { seat: 's', id: 'y', at: 't' }]), policy);
    expect(r.sealed).toBe(false);
  });
  it('keeps one domain per seal so groups share a principle', () => {
    const r = selectScoreSealedParents([c(1, { domain: 'a' }), c(2, { domain: 'b' }), c(3, { domain: 'a' }),
      c(4, { domain: 'b' })], two);
    expect(r.sealed).toBe(false);
    const ok = selectScoreSealedParents([c(1), c(2), c(3), c(4)], two);
    expect(new Set(ok.provenance.parents.map(p => p.domain)).size).toBe(1);
    expect(ok.groups.every(g => g.createKeys.length === 2)).toBe(true);
  });
  it('merge keeps the best Create per repeated key and prefers a liked run', () => {
    const mk = (score: number) => ({ kind: 'create', result: { evaluation: { admissionEligible: true, score } } });
    const runs = [{ seat: 'a', id: 'r', store: { k: mk(0.9) } }, { seat: 'b', id: 'r', store: { k: mk(0.5) } }];
    expect(mergeProductStores(runs).sources.get('k')!.seat).toBe('a');
    expect(mergeProductStores(runs, new Set(['b/r'])).sources.get('k')!.seat).toBe('b');
  });
  it('binds a like to its artifact: a take sharing the seat/id alias does not inherit it', () => {
    const list = [c(1, { seat_dir: 's', piece_id: 'dup', artifactDigest: 'old' }), c(2, { seat_dir: 's', piece_id: 'dup', artifactDigest: 'new' })];
    const out = applyLikes(list, [{ seat: 's', id: 'dup', at: 't', artifactDigest: 'new' }]);
    expect(out.map(x => Boolean(x.likedAt))).toEqual([false, true]);
    expect(applyLikes(list, [{ seat: 's', id: 'dup', at: 't' }]).every(x => x.likedAt)).toBe(true); // legacy like with no digest stays alias-keyed
    const mk = (digest: string) => ({ kind: 'create', result: { receipt: { artifactDigest: digest }, evaluation: { admissionEligible: true, score: 0.5 } } });
    const runs = [{ seat: 'a', id: 'r', store: { k: mk('x') } }, { seat: 'b', id: 'r', store: { k: mk('y') } }];
    expect(mergeProductStores(runs, new Set(['b/r']), new Map([['b/r', 'other']])).sources.get('k')!.seat).toBe('a');
    expect(mergeProductStores(runs, new Set(['b/r']), new Map([['b/r', 'y']])).sources.get('k')!.seat).toBe('b');
  });
});

describe('legacy receipts (real pre-#1790 fixture)', () => {
  const real = JSON.parse(readFileSync('test/fixtures/legacy-receipts/legacy-creates.json', 'utf8'));
  it('classifies a receipt without evaluationDigest as legacy-unbound and keeps it a candidate', () => {
    const candidates = candidatesFromProductStore(real);
    expect(candidates).toHaveLength(2);
    expect(candidates.every(c => c.evaluationBinding === 'legacy-unbound')).toBe(true);
  });
  it('marks a receipt whose evaluationDigest mismatches, and the counter reports it', () => {
    const bad = JSON.parse(JSON.stringify(real));
    for (const v of Object.values<any>(bad)) v.result.receipt.evaluationDigest = 'f'.repeat(64);
    const candidates = candidatesFromProductStore(bad);
    expect(candidates.every(c => c.evaluationBinding === 'mismatch')).toBe(true);
    expect(skipUnverifiable(candidates)).toEqual({ kept: [], skipped: 2 });
    expect(skipUnverifiable(candidatesFromProductStore(real)).skipped).toBe(0);
  });
});
