import { describe, expect, it } from 'vitest';
import { createExplorationDecisionAdmission,
  validateExplorationDecisionAdmission } from
  '../../../src/evolution/ExplorationDecisionAdmission.js';

const digest = (char: string) => char.repeat(64);
const valid = { purpose: 'parent-selection' as const, artifactId: 'artifact-a',
  ownerDecision: 'accepted' as const,
  role: 'generator', domain: 'p5', criterionScore: 0.82,
  artifactDigest: digest('a'), evidenceDigest: digest('b'),
  decisionDigest: digest('c'), criterionDigest: digest('d'),
  rendered: true as const, identityValid: true as const,
  digestMatched: true as const, degraded: false as const };

describe('exploration decision admission', () => {
  it('binds purpose, role, domain, criteria, and exact evidence', () => {
    const admission = createExplorationDecisionAdmission(valid);
    expect(validateExplorationDecisionAdmission(admission, {
      purpose: 'parent-selection', artifactId: 'artifact-a',
      role: 'generator', domain: 'p5' })).toEqual(admission);
    expect(() => validateExplorationDecisionAdmission(admission, {
      purpose: 'evolution-reward', artifactId: 'artifact-a',
      role: 'generator', domain: 'p5' })).toThrow('EXPLORATION_DECISION_SCOPE_MISMATCH');
  });

  it('rejects static, degraded, or unbound criterion evidence', () => {
    for (const patch of [{ rendered: false }, { degraded: true },
      { digestMatched: false }, { criterionDigest: 'static-score' }]) {
      expect(() => createExplorationDecisionAdmission({ ...valid, ...patch } as never))
        .toThrow('EXPLORATION_DECISION_EVIDENCE_INVALID');
    }
  });
});
