import { createHash } from 'node:crypto';
import { dreamEvidenceReceiptDigest, validateDreamEvidence, validateEvaluatorIndependence,
  validateEvaluatorManifests,
  type DreamEvaluatorIdentity, type DreamObservedEvidence,
  type DreamRenderedEvidenceResolver,
} from './DreamResearchEvidence.js';
import type { DreamExperimentExecution,
  DreamExperimentExecutor, DreamTransportGate } from './DreamResearchRuntime.js';
import type { DreamExperimentPlan } from './DreamResearchTypes.js';
import type { DreamDecisionIssuer } from './DreamDecisionAuthority.js';
import { dreamContractDigest, dreamCreativeDeltaDigest, isCreativeWrapper,
  structuralRuleMatches,
  type DreamAnonymousComparison, type DreamBlindComparisonPolicy,
  type DreamOperatorDeclaration } from './DreamBlindComparison.js';
export { sealDreamBlindComparisonPolicy, sealDreamOperatorDeclaration }
  from './DreamBlindComparison.js';

export interface DreamCreativeCandidate {
  id: string;
  source: string;
  graphDigest: string;
  layerIds: string[];
  domains: string[];
  invariantDigests?: Readonly<Record<string, string>>;
  mutation?: { operatorId: string; changedFactor: string; changedPaths: string[];
    protectedInvariantDigests: Readonly<Record<string, string>>;
    creativeDeltaDigest: string };
  layerAblations?: Array<{ removedLayerId: string; source: string }>;
}

export interface DreamCreativeOperator {
  declaration: DreamOperatorDeclaration;
  produce(plan: DreamExperimentPlan): Promise<{
    baseline: DreamCreativeCandidate;
    variants: DreamCreativeCandidate[];
  }>;
}

export interface DreamRenderedObserver {
  observe(candidate: DreamCreativeCandidate,
    plan: DreamExperimentPlan): Promise<DreamObservedEvidence>;
}

export interface DreamCriterionVerdict {
  outcome: 'keeper' | 'rejected' | 'inconclusive';
  uncertainty: number;
  criteria: Array<{ criterion: string; evidenceDigest: string;
    direction: 'improved' | 'regressed' | 'neutral' }>;
}

export type DreamEvaluatorEvidence = Omit<DreamObservedEvidence,
  'artifactDigest' | 'playableDigest' | 'runtimeErrors'> & {
    readonly runtimeFailureDigests: readonly string[];
  };

export interface DreamPairwiseEvaluator {
  identity: DreamEvaluatorIdentity;
  compare(payload: DreamAnonymousComparison<DreamEvaluatorEvidence>):
    Promise<DreamCriterionVerdict>;
}

export class DreamRenderedExperimentExecutor implements DreamExperimentExecutor {
  readonly kind = 'provider' as const;

  constructor(private readonly operator: DreamCreativeOperator,
    private readonly observer: DreamRenderedObserver,
    private readonly evaluators: readonly [DreamPairwiseEvaluator, DreamPairwiseEvaluator],
    private readonly decisions: DreamDecisionIssuer,
    private readonly policy: DreamBlindComparisonPolicy,
    private readonly renderedEvidence: DreamRenderedEvidenceResolver) {
    validateEvaluatorIndependence(evaluators[0].identity, evaluators[1].identity);
  }

  async execute(plan: DreamExperimentPlan,
    transport?: DreamTransportGate): Promise<DreamExperimentExecution> {
    if (!transport) throw new Error('DREAM_TRANSPORT_GATE_REQUIRED');
    if (plan.context.operatorDigest !== this.operator.declaration.declarationDigest) {
      throw new Error('DREAM_OPERATOR_MANIFEST_MISMATCH');
    }
    if (plan.context.policyDigest !== this.policy.policyDigest) {
      throw new Error('DREAM_BLIND_POLICY_MISMATCH');
    }
    validateEvaluatorManifests(this.evaluators.map(item => item.identity),
      plan.context.evaluatorManifestDigests);
    const candidates = await transport('creative-operator', () => this.operator.produce(plan));
    this.assertGenuine(candidates.baseline, candidates.variants, plan);
    const baseline = await transport('render-baseline',
      () => this.observer.observe(candidates.baseline, plan), { metered: false });
    const variants: DreamObservedEvidence[] = [];
    for (const candidate of candidates.variants) {
      variants.push(await transport(`render-variant:${candidate.id}`,
        () => this.observer.observe(candidate, plan), { metered: false }));
    }
    for (const evidence of [baseline, ...variants]) {
      this.renderedEvidence.assertAttested(evidence);
      const failures = validateDreamEvidence(evidence, plan.requiredModalities);
      if (failures.length > 0) throw new Error(failures.join(','));
    }
    if (plan.requiredModalities.includes('multi-layer')) {
      [baseline, ...variants].forEach((item, index) => {
        const candidate = [candidates.baseline, ...candidates.variants][index];
        if (item.layerAblations?.length !== candidate.layerIds.length) {
          throw new Error('DREAM_LAYER_ABLATION_INCOMPLETE');
        }
      });
    }
    const arms = [baseline, ...variants];
    const verdicts: DreamCriterionVerdict[] = [];
    for (const [index, evaluator] of this.evaluators.entries()) {
      const payload = this.anonymousPayload(arms, index);
      verdicts.push(await transport(`evaluator-${index + 1}`,
        () => evaluator.compare(payload)));
    }
    for (const verdict of verdicts) this.assertCriterionEvidence(verdict);
    const outcome = this.resolve(verdicts);
    const comparison = { outcome, reason: `independent-criterion-verdict:${outcome}` };
    return { baselineEvidenceDigest: dreamEvidenceReceiptDigest(baseline),
      variantEvidenceDigests: variants.map(dreamEvidenceReceiptDigest),
      variantArtifactDigests: variants.map(item => item.artifactDigest),
      comparison, comparisonCapability: this.decisions.issueComparison({
        aggregateId: plan.aggregateId, ...comparison,
        baselineEvidenceDigest: dreamEvidenceReceiptDigest(baseline),
        variantEvidenceDigests: variants.map(dreamEvidenceReceiptDigest),
        variantArtifactDigests: variants.map(item => item.artifactDigest) }) };
  }

  private anonymousPayload(evidence: readonly DreamObservedEvidence[], index: number):
    DreamAnonymousComparison<DreamEvaluatorEvidence> {
    const seed = this.policy.evaluatorOrderSeeds[index];
    let arms = evidence.map(item => Object.freeze({
      armId: dreamContractDigest({ seed, evidenceDigest: dreamEvidenceReceiptDigest(item) }),
      evidence: anonymousEvidence(item),
    })).sort((left, right) => left.armId.localeCompare(right.armId));
    if (index === 1) arms = [...arms].reverse();
    return Object.freeze({ schema: 'sinter.dream-anonymous-comparison',
      policyDigest: this.policy.policyDigest, criteria: [...this.policy.criterionIds],
      arms: Object.freeze(arms) });
  }

  private assertGenuine(baseline: DreamCreativeCandidate,
    variants: DreamCreativeCandidate[], plan: DreamExperimentPlan): void {
    const declaration = this.operator.declaration;
    if (variants.length === 0) throw new Error('DREAM_VARIANT_REQUIRED');
    if (variants.some(item => item.source === baseline.source
      || item.graphDigest === baseline.graphDigest)) throw new Error('DREAM_REPLAY_REJECTED');
    if ([baseline, ...variants].some(item => item.domains.some(
      domain => !declaration.compatibleDomains.includes(domain)))) {
      throw new Error('DREAM_OPERATOR_DOMAIN_INCOMPATIBLE');
    }
    for (const variant of variants) {
      const mutation = variant.mutation;
      if (!mutation || mutation.operatorId !== declaration.id
        || mutation.changedFactor !== declaration.factor) {
        throw new Error('DREAM_OPERATOR_FACTOR_CONFOUNDED');
      }
      if (mutation.creativeDeltaDigest !== dreamCreativeDeltaDigest(
        baseline.source, variant.source, mutation.changedPaths)
        || mutation.changedPaths.length === 0
        || mutation.changedPaths.some(changed => !declaration.structuralDiffRules.some(
          rule => structuralRuleMatches(rule, changed)))) {
        throw new Error('DREAM_STRUCTURAL_DIFF_UNDECLARED');
      }
      if (isCreativeWrapper(baseline.source, variant.source)) {
        throw new Error('DREAM_WRAPPER_VARIATION_REJECTED');
      }
      for (const invariant of declaration.protectedInvariants) {
        if (baseline.invariantDigests?.[invariant] !== mutation.protectedInvariantDigests[invariant]) {
          throw new Error('DREAM_PROTECTED_INVARIANT_CHANGED');
        }
      }
    }
    if (plan.requiredModalities.includes('multi-layer')
      && [baseline, ...variants].some(item => item.layerIds.length < 2
        || item.layerAblations?.length !== item.layerIds.length)) {
      throw new Error('DREAM_LAYER_COLLAPSE_REJECTED');
    }
  }

  private assertCriterionEvidence(verdict: DreamCriterionVerdict): void {
    if (verdict.criteria.length === 0 || !Number.isFinite(verdict.uncertainty)
      || verdict.uncertainty < 0 || verdict.uncertainty > 1
      || verdict.criteria.some(item => !/^[a-f0-9]{64}$/.test(item.evidenceDigest)
        || !this.policy.criterionIds.includes(item.criterion)
        || !['improved', 'regressed', 'neutral'].includes(item.direction))) {
      throw new Error('DREAM_CRITERION_EVIDENCE_REQUIRED');
    }
    if (new Set(verdict.criteria.map(item => item.criterion)).size
      !== verdict.criteria.length) throw new Error('DREAM_CRITERION_DUPLICATED');
  }

  private resolve(verdicts: readonly DreamCriterionVerdict[]):
    DreamCriterionVerdict['outcome'] {
    if (verdicts.some(verdict => verdict.criteria.some(criterion =>
      criterion.direction === 'regressed'
      && this.policy.criticalRegressionCriteria.includes(criterion.criterion)))) {
      return 'rejected';
    }
    if (verdicts.some(verdict => verdict.uncertainty > this.policy.uncertaintyThreshold)) {
      return 'inconclusive';
    }
    const outcomes = new Set(verdicts.map(verdict => verdict.outcome));
    return outcomes.size === 1 ? verdicts[0].outcome : 'inconclusive';
  }
}

function anonymousEvidence(evidence: DreamObservedEvidence): DreamEvaluatorEvidence {
  const { artifactDigest: _artifactDigest, playableDigest: _playableDigest,
    runtimeErrors, pixelFrames, ...rendered } = evidence;
  return Object.freeze({ ...rendered,
    frames: Object.freeze([...rendered.frames]),
    temporalSamples: Object.freeze([...rendered.temporalSamples]),
    pixelFrames: Object.freeze(pixelFrames.map(frame => Object.freeze({ ...frame }))),
    runtimeFailureDigests: Object.freeze(runtimeErrors.map(error =>
      createHash('sha256').update(error).digest('hex'))),
  });
}
