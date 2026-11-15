import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SHADOW_BUDGETS,
  RECURSIVE_CONTRACT_VERSION,
  assertExperimentTransition,
  assertIndependentReview,
  assertMutationAuthority,
  assertSealedEvaluator,
  assertStageOnePromotion,
  parseRecursiveContractReceipt,
  parseRecursiveExperimentContract,
} from '../../../src/runtime-core/RecursiveImprovementContract.js';

function contract(overrides: Record<string, unknown> = {}) {
  return {
    version: RECURSIVE_CONTRACT_VERSION,
    loop: 'autoresearch',
    experimentId: 'experiment-1',
    lineageId: 'lineage-1',
    state: 'observe',
    stage: 'shadow',
    sourceMutationRequested: true,
    budgets: DEFAULT_SHADOW_BUDGETS,
    ...overrides,
  };
}

describe('RecursiveImprovementContract W5-01', () => {
  it('rejects unknown loops and missing lineage', () => {
    expect(() => parseRecursiveExperimentContract(
      contract({ loop: 'unknown' }),
    )).toThrow(/UNKNOWN_LOOP/);
    expect(() => parseRecursiveExperimentContract(
      contract({ lineageId: '' }),
    )).toThrow(/MISSING_LINEAGE/);
  });

  it('rejects missing hard budgets', () => {
    expect(() => parseRecursiveExperimentContract(
      contract({ budgets: { ...DEFAULT_SHADOW_BUDGETS, calls: 0 } }),
    )).toThrow(/INVALID_BUDGET/);
  });

  it('rejects non-Autoresearch source mutation', () => {
    expect(() => parseRecursiveExperimentContract(
      contract({ loop: 'dream' }),
    )).toThrow(/MUTATION_AUTHORITY_DENIED/);
    expect(() => assertMutationAuthority({
      contract: contract({ sourceMutationRequested: false }),
      pathClass: 'candidate-source',
      activeExperiment: false,
    })).toThrow(/MUTATION_AUTHORITY_DENIED/);
    expect(() => assertMutationAuthority({
      contract: contract({ sourceMutationRequested: false }),
      pathClass: 'candidate-source',
      activeExperiment: true,
    })).toThrow(/MUTATION_AUTHORITY_DENIED/);
  });

  it('rejects skipped and unknown transitions', () => {
    expect(assertExperimentTransition(
      contract(),
      'hypothesize',
    )).toBe('hypothesize');
    expect(() => assertExperimentTransition(
      contract(),
      'mutate',
    )).toThrow(/INVALID_TRANSITION/);
    expect(() => assertExperimentTransition(
      contract(),
      'teleport',
    )).toThrow(/UNKNOWN_STATE/);
  });

  it.each([
    'protected-evaluator',
    'sealed-evaluator-dependency',
  ])('rejects direct or indirect judge mutation: %s', (pathClass) => {
    expect(() => assertMutationAuthority({
      contract: contract(),
      pathClass,
      activeExperiment: true,
    })).toThrow(/JUDGE_MUTATION_DENIED/);
  });

  it('permits only declared candidate and generated-owned mutations', () => {
    expect(assertMutationAuthority({
      contract: contract(),
      pathClass: 'candidate-source',
      activeExperiment: true,
    })).toBe('candidate-source');
    expect(assertMutationAuthority({
      contract: contract(),
      pathClass: 'generated-owned',
      activeExperiment: true,
      declaredGeneratedOwner: true,
    })).toBe('generated-owned');
    expect(() => assertMutationAuthority({
      contract: contract(),
      pathClass: 'secret-config-git',
      activeExperiment: true,
    })).toThrow(/MUTATION_PATH_DENIED/);
  });

  it('rejects self-review, unknown identity, and reviewer write tools', () => {
    const author = { provider: 'openai', model: 'sol', verified: true };
    expect(() => assertIndependentReview({
      author,
      reviewer: author,
      reviewerTools: ['readFile'],
    })).toThrow(/SELF_REVIEW_DENIED/);
    expect(() => assertIndependentReview({
      author,
      reviewer: { provider: 'xai', model: 'grok', verified: false },
      reviewerTools: ['readFile'],
    })).toThrow(/UNVERIFIED_IDENTITY/);
    expect(() => assertIndependentReview({
      author,
      reviewer: { provider: 'xai', model: 'grok', verified: true },
      reviewerTools: ['applyEdit'],
    })).toThrow(/REVIEWER_WRITE_DENIED/);
  });

  it('fails closed when sealed evaluator evidence is missing or drifts', () => {
    expect(() => assertSealedEvaluator({
      identityVerified: false,
      evidenceComplete: false,
    })).toThrow(/MISSING_EVALUATOR_EVIDENCE/);
    expect(() => assertSealedEvaluator({
      manifestHash: 'a',
      beforeHash: 'a',
      afterHash: 'b',
      identityVerified: true,
      evidenceComplete: true,
    })).toThrow(/EVALUATOR_SEAL_DRIFT/);
  });

  it('rejects veto bypass, unverified promotion, and Stage 1 merge', () => {
    const reviewed = contract({ state: 'review' });
    expect(() => assertStageOnePromotion({
      contract: reviewed,
      action: 'emit-candidate',
      reviewerVerdict: 'veto',
      verified: true,
    })).toThrow(/VETO_BLOCKS_PROMOTION/);
    expect(() => assertStageOnePromotion({
      contract: reviewed,
      action: 'emit-candidate',
      reviewerVerdict: 'approve',
      verified: false,
    })).toThrow(/UNVERIFIED_PROMOTION/);
    expect(() => assertStageOnePromotion({
      contract: reviewed,
      action: 'merge',
      reviewerVerdict: 'approve',
      verified: true,
    })).toThrow(/STAGE_ONE_MERGE_DENIED/);
  });

  it('allows a verified reviewer-approved candidate only', () => {
    expect(() => assertStageOnePromotion({
      contract: contract({ state: 'review' }),
      action: 'emit-candidate',
      reviewerVerdict: 'approve',
      verified: true,
    })).not.toThrow();
  });

  it('requires lineage, trust, taint, and evidence references on receipts', () => {
    const receipt = {
      receiptId: 'receipt-1',
      experimentId: 'experiment-1',
      lineageId: 'lineage-1',
      loop: 'autoresearch',
      state: 'verify',
      trust: 'model-inference',
      taint: 'tainted',
      evidenceRefs: ['sha256:abc'],
      timestamp: '2026-07-30T06:00:00Z',
    };
    expect(parseRecursiveContractReceipt(receipt)).toEqual(receipt);
    expect(() => parseRecursiveContractReceipt({
      ...receipt,
      trust: 'trusted-because-model-said-so',
    })).toThrow(/UNKNOWN_TRUST_CLASS/);
    expect(() => parseRecursiveContractReceipt({
      ...receipt,
      evidenceRefs: [''],
    })).toThrow(/INVALID_EVIDENCE_REFS/);
  });
});
