import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { LEGACY_BACKFILL_WEIGHT, buildLegacyBackfillRow, legacyNegativeRow,
  selectLegacyBackfill, verifyLegacyBackfillRow } from '../../../src/learning/LegacyBackfill.js';

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const row = (html: string, score: number, judge = 'glm-5.3-flash') => buildLegacyBackfillRow({
  sourceBytes: html, renderDigest: sha(`render:${html}`), judge, judgeVersion: 'v1', score });

describe('legacy backfill authority', () => {
  it('binds file digest, render digest, pinned judge and score into the sealed label', () => {
    const r = row('<html>a</html>', 0.8);
    expect(r.fileDigest).toBe(sha('<html>a</html>'));
    expect(r.label.trustKind).toBe('legacy-backfill-judge');
    expect(r.label.allowedUses).toEqual(['evaluator-training']);
    expect(r.weight).toBe(LEGACY_BACKFILL_WEIGHT);
    expect(verifyLegacyBackfillRow(r)).toBe(true);
  });
  it('rejects an edited score, judge, weight or file digest', () => {
    const r = row('<html>a</html>', 0.1);
    expect(r.decision).toBe('rejected');
    expect(r.label.allowedUses).toEqual(['hard-negative']);
    for (const edit of [{ score: 0.95 }, { judge: 'other' }, { weight: 1 }, { fileDigest: sha('x') },
      { judgeVersion: 'v2' }, { decision: 'accepted' }]) {
      expect(verifyLegacyBackfillRow({ ...r, ...edit } as never)).toBe(false);
    }
  });
  it('refuses unscored input instead of minting a label', () => {
    for (const score of [NaN, -0.1, 1.2]) expect(() => row('<p/>', score)).toThrow('LEGACY_BACKFILL_SCORE_INVALID');
    expect(() => buildLegacyBackfillRow({ sourceBytes: '<p/>', renderDigest: 'bad', judge: 'j',
      judgeVersion: 'v1', score: 0.7 })).toThrow('LEGACY_BACKFILL_RENDER_DIGEST_INVALID');
    expect(() => buildLegacyBackfillRow({ sourceBytes: '<p/>', renderDigest: sha('r'), judge: '',
      judgeVersion: 'v1', score: 0.7 })).toThrow('LEGACY_BACKFILL_JUDGE_UNPINNED');
  });
  it('excludes the holdout by file digest and caps backfill at 30% of the total', () => {
    const rows = Array.from({ length: 20 }, (_, i) => row(`<html>${i}</html>`, 0.7));
    const holdout = new Set([rows[0]!.fileDigest, rows[1]!.fileDigest]);
    const out = selectLegacyBackfill(rows, { liveCount: 7, holdoutFileDigests: holdout });
    expect(out.excludedHoldout).toBe(2);
    expect(out.admitted.length).toBe(3); // 3 / (7 + 3) = 30%
    expect(out.admitted.some(r => holdout.has(r.fileDigest))).toBe(false);
    expect(out.droppedForCap).toBe(15);
    expect(selectLegacyBackfill(rows, { liveCount: 0, holdoutFileDigests: new Set() }).admitted).toHaveLength(0);
  });
  it('dedupes by file digest and drops forged rows', () => {
    const a = row('<html>dup</html>', 0.7);
    const forged = { ...row('<html>f</html>', 0.1), score: 0.9 };
    const out = selectLegacyBackfill([a, a, forged as never], { liveCount: 100, holdoutFileDigests: new Set() });
    expect(out.admitted).toHaveLength(1);
    expect(out.rejectedInvalid).toBe(1);
  });
  it('refuses to build a row in the 0.2 to 0.3 gray zone', () => {
    for (const score of [0.2, 0.25]) expect(() => row('<p>gray</p>', score)).toThrow('LEGACY_BACKFILL_SCORE_GRAY_ZONE');
  });
  it('emits growth-queue negatives only for rejected rows, tagged legacy', () => {
    expect(legacyNegativeRow(row('<p>ok</p>', 0.9))).toBeNull();
    const neg = legacyNegativeRow(row('<p>bad</p>', 0.1))!;
    expect(neg.source).toBe('legacy-backfill');
    expect(neg.input.artifact_sha256).toBe(sha('<p>bad</p>'));
    expect(neg.metadata.weight).toBe(LEGACY_BACKFILL_WEIGHT);
  });
});
