import { createHash } from 'node:crypto';
import type { LLMClient } from '../llm/LLMClient.js';
import { dreamCreativeDeltaDigest, type DreamAnonymousComparison,
  type DreamOperatorDeclaration } from '../dreaming/research/DreamBlindComparison.js';
import type { DreamCreativeCandidate, DreamCreativeOperator, DreamCriterionVerdict,
  DreamEvaluatorEvidence, DreamPairwiseEvaluator }
  from '../dreaming/research/DreamRenderedExperimentExecutor.js';
import type { DreamObservedEvidence, DreamEvaluatorIdentity }
  from '../dreaming/research/DreamResearchEvidence.js';
import type { DreamExperimentPlan, DreamTransferOutcome }
  from '../dreaming/research/DreamResearchTypes.js';
import type { DreamTransferEvaluator, DreamTransferProducer }
  from '../dreaming/research/DreamTransferRunner.js';
import type { CompoundBlindedArm, CompoundCreateJudge, CompoundCreateJudgment }
  from './CompoundCreateProofPort.js';
import { answerJson } from '../llm/ModelOutput.js';
// Liminal-owned transfer oracle (AC6) — re-export keeps module on production call graph.
export {
  buildOracleReceipt,
  oracleControlCandidate,
  oracleTreatmentCandidate,
  scoreOracleDualEval,
} from './DreamTransferOracle.js';

const digest = (value: unknown) => createHash('sha256')
  .update(JSON.stringify(value)).digest('hex');

const PLAYABLE_SOURCE_CONTRACT = 'Return complete self-contained playable HTML source. '
  + 'Use no external URLs, remote assets, network requests, imports, CDNs, images, fonts, '
  + 'audio, video, or iframe content. Generate every visual element locally in the source. '
  + 'Forbidden source forms include remote src or href attributes, CSS url(), fetch(), '
  + 'dynamic import(), XMLHttpRequest, WebSocket, EventSource, and iframe elements.';

const REMOTE_SOURCE_PATTERNS = [
  /\b(?:src|href)\s*=\s*["']\s*(?:https?:)?\/\//i,
  /\burl\s*\(/i,
  /\b(?:fetch|import)\s*\(/i,
  /\b(?:XMLHttpRequest|WebSocket|EventSource)\b/i,
  /<iframe\b/i,
] as const;

function assertSelfContainedSource(source: string): void {
  if (REMOTE_SOURCE_PATTERNS.some(pattern => pattern.test(source))) {
    throw new Error('DREAM_EXTERNAL_RESOURCE_FORBIDDEN');
  }
}

export function dreamClientIdentity(client: LLMClient): DreamEvaluatorIdentity {
  const config = client.getConfig();
  const route = { provider: config.provider ?? 'configured', model: config.model,
    baseUrl: config.baseUrl };
  return Object.freeze({ identityDigest: digest(route),
    hostDigest: digest({ baseUrl: config.baseUrl }) });
}

function parseObject(text: string): Record<string, unknown> {
  const value = JSON.parse(answerJson(text)) as unknown;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('DREAM_PROVIDER_RESPONSE_INVALID');
  }
  return value as Record<string, unknown>;
}

export class LLMDreamCreativeOperator implements DreamCreativeOperator {
  constructor(readonly declaration: DreamOperatorDeclaration,
    private readonly client: LLMClient) {}

  async produce(plan: DreamExperimentPlan): Promise<{
    baseline: DreamCreativeCandidate; variants: DreamCreativeCandidate[] }> {
    const response = await this.client.generate(
      `Return strict JSON creative source. No markdown. ${PLAYABLE_SOURCE_CONTRACT}`,
      JSON.stringify({ task: 'Produce one baseline and one genuine structural variant',
        sourceContract: PLAYABLE_SOURCE_CONTRACT,
        hypothesis: plan.hypothesis, declaration: this.declaration,
        schema: { baseline: { id: 'string', source: 'playable source',
          layerIds: ['string'], domains: ['html'] },
        variant: { id: 'string', source: 'playable source',
          layerIds: ['string'], domains: ['html'], changedPaths: ['composition.depth'] } } }),
      undefined, true, undefined, { jsonMode: true, maxTokens: 8_192 });
    if (!response.success) throw new Error(response.error ?? 'DREAM_OPERATOR_PROVIDER_FAILED');
    const body = parseObject(response.code);
    const baseline = this.candidate(body.baseline, 'baseline');
    const variant = this.candidate(body.variant, 'variant');
    const changedPaths = (body.variant as Record<string, unknown>).changedPaths;
    if (!Array.isArray(changedPaths) || changedPaths.length === 0
      || changedPaths.some(item => typeof item !== 'string' || !item.trim())) {
      throw new Error('DREAM_OPERATOR_CHANGED_PATHS_INVALID');
    }
    const invariant = digest({ domains: baseline.domains });
    baseline.invariantDigests = { domain: invariant };
    variant.mutation = { operatorId: this.declaration.id,
      changedFactor: this.declaration.factor, changedPaths: [...changedPaths] as string[],
      protectedInvariantDigests: { domain: invariant },
      creativeDeltaDigest: dreamCreativeDeltaDigest(
        baseline.source, variant.source, changedPaths as string[]) };
    return { baseline, variants: [variant] };
  }

  private candidate(value: unknown, fallback: string): DreamCreativeCandidate {
    const item = value as Record<string, unknown>;
    if (!item || typeof item.source !== 'string' || !item.source.trim()
      || !Array.isArray(item.layerIds) || item.layerIds.length === 0
      || item.layerIds.some(value => typeof value !== 'string' || !value.trim())
      || !Array.isArray(item.domains) || item.domains.length === 0
      || item.domains.some(value => typeof value !== 'string' || !value.trim())) {
      throw new Error('DREAM_OPERATOR_CANDIDATE_INVALID');
    }
    assertSelfContainedSource(item.source);
    return { id: typeof item.id === 'string' ? item.id : fallback, source: item.source,
      graphDigest: digest(item.source), layerIds: item.layerIds as string[],
      domains: item.domains as string[] };
  }
}

export class LLMDreamEvaluator implements DreamPairwiseEvaluator, DreamTransferEvaluator {
  readonly identity: DreamEvaluatorIdentity;
  constructor(private readonly client: LLMClient) {
    this.identity = dreamClientIdentity(client);
  }

  async compare(input: DreamAnonymousComparison<DreamEvaluatorEvidence>):
  Promise<DreamCriterionVerdict>;
  async compare(treatment: DreamObservedEvidence, control: DreamObservedEvidence):
  Promise<DreamTransferOutcome>;
  async compare(first: DreamAnonymousComparison<DreamEvaluatorEvidence> | DreamObservedEvidence,
    second?: DreamObservedEvidence): Promise<DreamCriterionVerdict | DreamTransferOutcome> {
    const comparison = second
      ? { task: 'unseen-transfer',
        criterion: 'visual-depth',
        armOrder: 'treatment-frames-then-control-frames',
        rubric: {
          validated: 'treatment shows clearer multi-layer depth (occlusion and/or scale strata) than control',
          falsified: 'control is equal or better on visual depth; treatment fails the depth advantage',
          inconclusive: 'pixels insufficient to decide depth advantage',
        },
        treatment: { ...first as DreamObservedEvidence, pixelFrames: undefined },
        control: { ...second, pixelFrames: undefined } }
      : { task: 'blind-criterion', comparison: {
        ...first as DreamAnonymousComparison<DreamEvaluatorEvidence>,
        arms: (first as DreamAnonymousComparison<DreamEvaluatorEvidence>).arms.map(arm => ({
          ...arm, evidence: { ...arm.evidence, pixelFrames: undefined },
        })),
      } };
    const pixelFrames = second
      ? [
        ...(first as DreamObservedEvidence).pixelFrames.map((frame, index) => ({
          ...frame, label: `treatment-frame-${index + 1}`,
        })),
        ...second.pixelFrames.map((frame, index) => ({
          ...frame, label: `control-frame-${index + 1}`,
        })),
      ]
      : (first as DreamAnonymousComparison<DreamEvaluatorEvidence>).arms
        .flatMap(arm => arm.evidence.pixelFrames);
    const systemPrompt = second
      ? 'Judge only attached rendered pixels. Image order is treatment frames then control frames (labels match). '
        + 'validated = treatment has clearer multi-layer visual depth than control; '
        + 'falsified = no treatment depth advantage; inconclusive = cannot decide. '
        + 'Return strict JSON. No markdown.'
      : 'Judge only attached rendered pixels. Return strict JSON. No markdown.';
    const response = await this.client.generate(
      systemPrompt,
      JSON.stringify({ ...comparison,
        schema: second ? { outcome: 'validated|falsified|inconclusive' }
          : { outcome: 'keeper|rejected|inconclusive', uncertainty: 0.2,
            criteria: [{ criterion: 'id', direction: 'improved|regressed|neutral' }] } }),
      undefined, true, pixelFrames, { jsonMode: true });
    if (!response.success) throw new Error(response.error ?? 'DREAM_EVALUATOR_PROVIDER_FAILED');
    const body = parseObject(response.code);
    if (second) return this.transferOutcome(body.outcome);
    const outcome = String(body.outcome);
    const uncertainty = Number(body.uncertainty);
    const rawCriteria = body.criteria;
    if (!['keeper', 'rejected', 'inconclusive'].includes(outcome)
      || !Number.isFinite(uncertainty) || uncertainty < 0 || uncertainty > 1
      || !Array.isArray(rawCriteria) || rawCriteria.length === 0
      || rawCriteria.some(item => !item || typeof item !== 'object'
        || typeof item.criterion !== 'string' || !item.criterion.trim()
        || !['improved', 'regressed', 'neutral'].includes(String(item.direction)))) {
      throw new Error('DREAM_CRITERION_VERDICT_INVALID');
    }
    const criteria = (rawCriteria as Array<Record<string, unknown>>).map(item => ({
      criterion: String(item.criterion), direction: String(item.direction) as
        'improved' | 'regressed' | 'neutral', evidenceDigest: digest(item),
    }));
    return { outcome: outcome as DreamCriterionVerdict['outcome'], uncertainty, criteria };
  }

  private transferOutcome(value: unknown): DreamTransferOutcome {
    if (!['validated', 'falsified', 'inconclusive'].includes(String(value))) {
      throw new Error('DREAM_TRANSFER_VERDICT_INVALID');
    }
    return String(value) as DreamTransferOutcome;
  }
}

/** Pinned transfer arm markers (tests assert; ralplan A+ AC1/AC2). */
export const TRANSFER_CONTROL_MARKERS = Object.freeze({
  NO_FINDING: 'CONTROL_ARM_NO_FINDING',
  OVERRIDE_DEPTH: 'OVERRIDE_HOLDOUT_DEPTH',
});
export const TRANSFER_TREATMENT_MARKERS = Object.freeze({
  FINDING_BOUND: 'TREATMENT_ARM_FINDING_BOUND',
  DEPTH_CUES: 'DEPTH_CUES_MIN_TWO',
});
export const TRANSFER_DEPTH_CUE_VOCAB = Object.freeze([
  'layered occlusion',
  'scale/parallax strata',
  'soft depth stacking',
] as const);

/** Contrastive arm contract for transfer producer (A+). Exported for tests. */
export function transferArmInstructions(findingDigest: string | null): string {
  if (findingDigest == null) {
    return [
      TRANSFER_CONTROL_MARKERS.NO_FINDING,
      TRANSFER_CONTROL_MARKERS.OVERRIDE_DEPTH,
      'Even if the holdout text demands depth membranes, shells, layered parallax, or nested strata,',
      'generate a simpler composition WITHOUT multi-layer occlusion, parallax strata, or nested shells.',
      'Do not apply any learned visual-depth finding. This is the negative assignment arm.',
    ].join(' ');
  }
  return [
    TRANSFER_TREATMENT_MARKERS.FINDING_BOUND,
    TRANSFER_TREATMENT_MARKERS.DEPTH_CUES,
    'findingDigest is an assignment token only — do not try to decode the hash.',
    'Implement visual-depth with at least two of:',
    `${TRANSFER_DEPTH_CUE_VOCAB[0]}; ${TRANSFER_DEPTH_CUE_VOCAB[1]}; ${TRANSFER_DEPTH_CUE_VOCAB[2]}.`,
    `Assignment token findingDigest=${findingDigest}`,
  ].join(' ');
}

export class LLMDreamTransferProducer implements DreamTransferProducer {
  constructor(private readonly client: LLMClient) {}
  async produce(input: { holdout: string; contextDigest: string;
    findingDigest: string | null }): Promise<DreamCreativeCandidate> {
    const armInstructions = transferArmInstructions(input.findingDigest);
    const response = await this.client.generate(
      `Return strict JSON playable creative source. ${PLAYABLE_SOURCE_CONTRACT} ${armInstructions}`,
      JSON.stringify({ task: 'Create an unseen transfer artifact', holdout: input.holdout,
        contextDigest: input.contextDigest, findingDigest: input.findingDigest,
        armAssignment: input.findingDigest == null ? 'control' : 'treatment',
        armInstructions, sourceContract: PLAYABLE_SOURCE_CONTRACT,
        schema: { id: 'string', source: 'playable source',
          layerIds: ['string'], domains: ['html'] } }),
      undefined, true, undefined, { jsonMode: true, maxTokens: 8_192 });
    if (!response.success) throw new Error(response.error ?? 'DREAM_TRANSFER_PROVIDER_FAILED');
    const item = parseObject(response.code);
    if (typeof item.source !== 'string' || !item.source.trim()
      || !Array.isArray(item.layerIds) || item.layerIds.length === 0
      || item.layerIds.some(value => typeof value !== 'string' || !value.trim())
      || !Array.isArray(item.domains) || item.domains.length === 0
      || item.domains.some(value => typeof value !== 'string' || !value.trim())) {
      throw new Error('DREAM_TRANSFER_CANDIDATE_INVALID');
    }
    assertSelfContainedSource(item.source);
    return { id: typeof item.id === 'string' ? item.id : digest(item.source).slice(0, 16),
      source: item.source, graphDigest: digest(item.source),
      layerIds: item.layerIds as string[], domains: item.domains as string[] };
  }
}

export function assertProductionDreamAdapters(input: {
  operator: DreamCreativeOperator; producer: DreamTransferProducer;
  evaluators: readonly [DreamPairwiseEvaluator & DreamTransferEvaluator,
    DreamPairwiseEvaluator & DreamTransferEvaluator]; observer: { observe: unknown };
  leaseAuthority: { assertActive: unknown } }): void {
  const callable = [input.operator.produce, input.producer.produce,
    input.evaluators[0].compare, input.evaluators[1].compare,
    input.observer.observe, input.leaseAuthority.assertActive];
  if (callable.some(value => typeof value !== 'function')) {
    throw new Error('DREAM_PRODUCTION_HOST_ADAPTERS_NOT_CALLABLE');
  }
  if (input.evaluators[0].identity.identityDigest
    === input.evaluators[1].identity.identityDigest
    || input.evaluators[0].identity.hostDigest === input.evaluators[1].identity.hostDigest) {
    throw new Error('DREAM_PRODUCTION_EVALUATORS_NOT_INDEPENDENT');
  }
}

export class LLMDreamCompoundJudge implements CompoundCreateJudge {
  readonly identityDigest: string;
  constructor(private readonly client: LLMClient, private readonly criterionDigest: string) {
    this.identityDigest = dreamClientIdentity(client).identityDigest;
  }
  async compare(input: { policyDigest: string; taskId: string;
    arms: readonly [CompoundBlindedArm, CompoundBlindedArm] }):
  Promise<CompoundCreateJudgment> {
    const response = await this.client.generate('Return strict JSON blind arm scores from 0 to 1.',
      JSON.stringify({ ...input, schema: { armScores: { armId: 0.5 } } }),
      undefined, true, undefined, { jsonMode: true });
    if (!response.success) throw new Error(response.error ?? 'DREAM_JUDGE_PROVIDER_FAILED');
    const body = parseObject(response.code);
    const armScores = body.armScores as Record<string, number>;
    if (!armScores || input.arms.some(arm => !Number.isFinite(armScores[arm.armId])
      || armScores[arm.armId]! < 0 || armScores[arm.armId]! > 1)) {
      throw new Error('DREAM_JUDGE_RESPONSE_INVALID');
    }
    const unsigned = { judgeIdentityDigest: this.identityDigest,
      criterionDigest: this.criterionDigest, armScores };
    return Object.freeze({ ...unsigned, signature: digest({ unsigned, input,
      identity: dreamClientIdentity(this.client) }) });
  }
  verify(judgment: CompoundCreateJudgment, input: { policyDigest: string; taskId: string;
    arms: readonly [CompoundBlindedArm, CompoundBlindedArm] }): boolean {
    const { signature, ...unsigned } = judgment;
    return signature === digest({ unsigned, input, identity: dreamClientIdentity(this.client) });
  }
}
