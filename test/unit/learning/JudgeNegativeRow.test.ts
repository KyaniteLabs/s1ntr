import { describe, expect, it } from 'vitest';
import { createCreativeLabelAdmission } from '../../../src/learning/CreativeLabelAdmission.js';
import { judgeNegativeRow } from '../../../src/learning/JudgeNegativeRow.js';

const label = (uses: ('hard-negative' | 'few-shot')[]) => createCreativeLabelAdmission({
  trustKind: 'judge-scoring', allowedUses: uses, artifactDigest: 'a'.repeat(64),
  evidenceDigest: 'b'.repeat(64), decisionDigest: 'c'.repeat(64), rendered: true,
  identityValid: true, digestMatched: true, degraded: false });
const evidence = (decision: 'accepted' | 'rejected') => ({ createKey: 'k', decision, domain: 'p5',
  artifactDigest: 'a'.repeat(64), score: 0.3, judge: 'glm/flash', ruleId: 'judge-score-floor-v2-simon40',
  label: label(decision === 'rejected' ? ['hard-negative'] : ['few-shot']) });

describe('judgeNegativeRow', () => {
  it('emits a growth-queue row only for rejected judge evidence', () => {
    expect(judgeNegativeRow(evidence('accepted'))).toBeNull();
    const row = judgeNegativeRow(evidence('rejected'))!;
    expect(row).toMatchObject({ id: 'k', source: 'judge-scoring',
      input: { domain: 'p5', artifact_sha256: 'a'.repeat(64) },
      metadata: { judgeScore: 0.3, judge: 'glm/flash', ruleId: 'judge-score-floor-v2-simon40' } });
    expect(row.label.creative_label.allowedUses).toEqual(['hard-negative']);
  });
});
