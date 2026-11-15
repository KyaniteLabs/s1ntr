import { createHash } from 'node:crypto';
import type { CompositionRequest } from '../composition/CompositionGraph.js';
import type { DreamQueue } from '../dreaming/DreamQueue.js';
import type {
  DreamCampaignCausalLesson,
  DreamAssimilationGovernance,
  DreamAssimilationRunner,
} from '../dreaming/DreamTaskRunner.js';
import type { CampaignOriginReceipt } from '../runtime-core/CampaignOrigin.js';
import type {
  CampaignLearningAuthorizationEvidence,
  CampaignLearningAuthorizationExecution,
  CampaignClosureEvidenceAuthority,
  CampaignClosureReceipt,
} from './CampaignClosure.js';
import type { CampaignLedgerPersistence } from './CampaignPersistence.js';
import type {
  CampaignEvidenceCheckpoint,
  CampaignRunAdmission,
  CoordinatedCompositionResult,
} from './CreativeRunCoordinatorBase.js';
import type { CampaignManifest } from './CampaignManifest.js';
import {
  CampaignProgressJournal,
  type CampaignOriginReceiptVerifier,
  type CampaignProgressReceiptRequirement,
} from './CampaignProgressJournal.js';

const DIGEST = /^[a-f0-9]{64}$/;

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) =>
      `${JSON.stringify(key)}:${stable(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function digest(value: unknown): string {
  return createHash('sha256').update(typeof value === 'string' ? value : stable(value)).digest('hex');
}

function mintDreamLesson(
  binding: ContinuationBinding,
  evidence: CampaignLearningAuthorizationEvidence,
  outcome: CampaignTransferOutcome,
  evaluationDigest: string,
): CampaignDreamLessonCapability {
  const ruleId = evidence.provisional.ruleId;
  const ruleValue = evidence.provisional.ruleValue;
  const safeString = typeof ruleValue !== 'string'
    || /^[A-Za-z0-9 .,#%()+\-_/]{1,128}$/.test(ruleValue);
  if (!/^[A-Za-z0-9_.:-]{1,128}$/.test(ruleId)
    || !['string', 'number', 'boolean'].includes(typeof ruleValue) || !safeString
    || (typeof ruleValue === 'number' && !Number.isFinite(ruleValue))
    || !DIGEST.test(evidence.evidenceDigest)
    || !DIGEST.test(evidence.revisionReceiptDigest) || !DIGEST.test(evaluationDigest)) {
    throw new Error('CAMPAIGN_DREAM_LESSON_INVALID');
  }
  const capability = Object.freeze({}) as CampaignDreamLessonCapability;
  dreamLessonCapabilities.set(capability, Object.freeze({
    campaignRunId: binding.campaignRunId, manifestDigest: binding.manifestDigest,
    planDigest: binding.planDigest, outcome, ruleId, ruleValue,
    authorizationEvidenceDigest: evidence.evidenceDigest,
    revisionReceiptDigest: evidence.revisionReceiptDigest, evaluationDigest,
  }));
  return capability;
}

export type CampaignTransferOutcome = 'improved' | 'inconclusive' | 'regressed';

export interface CampaignTransferTargetInput {
  readonly mode: 'sealed-brief' | 'sealed-pool';
  readonly brief?: string;
  readonly pool?: readonly string[];
}

/** Opaque, process-local handle. The selected target is never projected to a surface. */
export interface CampaignTransferTarget {
  readonly campaignRunId: string;
  readonly manifestDigest: string;
  readonly targetDigest: string;
}

interface ResolvedCampaignTransferTarget extends CampaignTransferTarget {
  readonly target: string;
  readonly selectionDigest: string;
}

const targetCapabilities = new WeakMap<object, ResolvedCampaignTransferTarget>();

/** Opaque process-local proof that a causal lesson came from this continuation. */
export interface CampaignDreamLessonCapability {
  readonly __campaignDreamLessonCapabilityBrand: never;
}

interface ResolvedCampaignDreamLesson extends DreamCampaignCausalLesson {
  readonly campaignRunId: string;
  readonly manifestDigest: string;
  readonly planDigest: string;
}

const dreamLessonCapabilities = new WeakMap<object, ResolvedCampaignDreamLesson>();

export function resolveCampaignDreamLesson(
  capability: CampaignDreamLessonCapability,
): ResolvedCampaignDreamLesson {
  const lesson = dreamLessonCapabilities.get(capability);
  if (!lesson) throw new Error('CAMPAIGN_DREAM_LESSON_CAPABILITY_INVALID');
  return lesson;
}

/** Host-persisted target material. This type must never be projected to a product surface. */
export interface CampaignTransferTargetSeal extends ResolvedCampaignTransferTarget {
  readonly schema: 'sinter.campaign-transfer-target-seal';
  readonly schemaVersion: 1;
  readonly sealDigest: string;
}

function targetSealBody(seal: CampaignTransferTargetSeal): Omit<CampaignTransferTargetSeal, 'sealDigest'> {
  const { sealDigest: _sealDigest, ...body } = seal;
  return body;
}

export interface CampaignTransferEvaluationInput {
  /** Stable retry key. Evaluators must return the same decision for the same id. */
  readonly evaluationId: string;
  readonly campaignRunId: string;
  readonly manifestDigest: string;
  readonly planDigest: string;
  readonly targetDigest: string;
  readonly treatmentArtifactDigest: string;
  readonly controlArtifactDigest: string;
  readonly surfaceCopyingDetected: boolean;
}

export interface CampaignTransferEvaluation {
  readonly outcome: CampaignTransferOutcome;
  readonly rationaleDigest: string;
}

export interface CampaignTransferEvaluator {
  evaluate(input: CampaignTransferEvaluationInput): Promise<CampaignTransferEvaluation>;
}

const evaluatorAuthorities = new WeakSet<object>();

/** Host bootstrap seam for an evaluator independent from the generator. */
export function bootstrapCampaignTransferEvaluator(
  evaluate: CampaignTransferEvaluator['evaluate'],
): CampaignTransferEvaluator {
  const authority = Object.freeze({ evaluate });
  evaluatorAuthorities.add(authority);
  return authority;
}

export interface CampaignContinuationProjection {
  readonly closureDigest: string;
  readonly transferTargetDigest: string;
  readonly transferTreatmentDigest: string;
  readonly transferControlDigest: string;
  readonly transferEvaluationDigest: string;
  readonly transferOutcome: CampaignTransferOutcome;
  readonly dreamRecommendationDigest: string;
  readonly campaignOriginDigest: string;
}

type PhaseName = 'closure' | 'treatment' | 'control' | 'evaluation' | 'dream' | 'origin';
type PhaseStatus = 'pending' | 'running' | 'completed';

interface CampaignContinuationRecord {
  readonly schema: 'sinter.campaign-continuation';
  readonly schemaVersion: 1;
  readonly campaignRunId: string;
  readonly ownerAuthorityId: string;
  readonly manifestDigest: string;
  readonly checkpointDigest: string;
  readonly targetDigest: string;
  readonly learningEvidenceId: string;
  readonly learningExecution?: CampaignLearningAuthorizationExecution;
  readonly learningCommitted?: true;
  readonly phases: Readonly<Record<PhaseName, PhaseStatus>>;
  readonly closureDigest?: string;
  readonly treatmentHtml?: string;
  readonly controlHtml?: string;
  readonly outcome?: CampaignTransferOutcome;
  readonly evaluationDigest?: string;
  readonly dreamRecommendationDigest?: string;
  readonly originDigest?: string;
  readonly recordDigest: string;
}

interface ContinuationBinding {
  readonly campaignRunId: string;
  readonly rootRunId: string;
  readonly manifestDigest: string;
  readonly planDigest: string;
  readonly routeFreezeDigest: string;
  readonly campaignFundingReservationDigest: string;
}

export interface CampaignContinuationHost {
  readonly persistence: CampaignLedgerPersistence;
  readonly learningAuthority: CampaignClosureEvidenceAuthority;
  readonly evaluator: CampaignTransferEvaluator;
  readonly originVerifier: CampaignOriginReceiptVerifier;
  readonly now: () => Date;
  binding(admission: CampaignRunAdmission): ContinuationBinding;
  close(admission: CampaignRunAdmission, manifest: CampaignManifest): Promise<CampaignClosureReceipt>;
  compose(admission: CampaignRunAdmission, request: CompositionRequest, options: {
    readonly requestKey: string;
    readonly provider: string;
    readonly model: string;
  }, stageId: 'transfer-treatment' | 'transfer-control'): Promise<CoordinatedCompositionResult>;
  dream(admission: CampaignRunAdmission, queue: DreamQueue, runner: DreamAssimilationRunner,
    governance: Omit<DreamAssimilationGovernance, 'campaignDreamAdmission'>,
    options: { readonly requestKey: string;
      readonly causalLesson: CampaignDreamLessonCapability }): Promise<{
      readonly generation: { readonly recommendation: { readonly recommendationDigest: string } };
    } | null>;
  finalize(admission: CampaignRunAdmission,
    receipts: readonly import('../runtime-core/CampaignOrigin.js').CampaignEvidenceReceipt[]):
    Promise<CampaignOriginReceipt>;
}

function checkpointBody(checkpoint: CampaignEvidenceCheckpoint): Omit<CampaignEvidenceCheckpoint, 'checkpointDigest'> {
  const { checkpointDigest: _checkpointDigest, ...body } = checkpoint;
  return body;
}

function assertCheckpoint(checkpoint: CampaignEvidenceCheckpoint, binding: ContinuationBinding): void {
  if (checkpoint.schema !== 'sinter.campaign-evidence-checkpoint'
    || checkpoint.schemaVersion !== 1 || checkpoint.originPending !== true
    || checkpoint.campaignRunId !== binding.campaignRunId
    || checkpoint.rootRunId !== binding.rootRunId
    || checkpoint.manifestDigest !== binding.manifestDigest
    || checkpoint.campaignPlanDigest !== binding.planDigest
    || checkpoint.campaignRouteFreezeDigest !== binding.routeFreezeDigest
    || checkpoint.campaignFundingReservationDigest !== binding.campaignFundingReservationDigest
    || checkpoint.checkpointDigest !== digest(checkpointBody(checkpoint))) {
    throw new Error('CAMPAIGN_CONTINUATION_CHECKPOINT_INVALID');
  }
}

function selectTarget(manifest: CampaignManifest, input: CampaignTransferTargetInput): ResolvedCampaignTransferTarget {
  if (input.mode !== manifest.transfer.mode) throw new Error('CAMPAIGN_TRANSFER_TARGET_MODE_INVALID');
  let target: string;
  let selectionDigest: string;
  if (input.mode === 'sealed-brief') {
    if (typeof input.brief !== 'string' || input.pool !== undefined
      || digest(input.brief) !== manifest.transfer.sealedBriefDigest) {
      throw new Error('CAMPAIGN_TRANSFER_TARGET_SEAL_INVALID');
    }
    target = input.brief;
    selectionDigest = digest({ mode: input.mode, targetDigest: digest(target) });
  } else {
    const pool = input.pool;
    const expected = manifest.transfer.poolDigests;
    if (!pool?.length || !expected || pool.length !== expected.length
      || pool.some((item, index) => digest(item) !== expected[index])) {
      throw new Error('CAMPAIGN_TRANSFER_POOL_SEAL_INVALID');
    }
    const selector = manifest.transfer.selectorDigest;
    if (!selector) throw new Error('CAMPAIGN_TRANSFER_SELECTOR_MISSING');
    const entropy = digest(`${selector}:${manifest.transfer.randomSourceDigest}`);
    const index = Number.parseInt(entropy.slice(0, 12), 16) % pool.length;
    target = pool[index]!;
    selectionDigest = digest({ mode: input.mode, selector, entropy, index,
      targetDigest: digest(target) });
  }
  return Object.freeze({ campaignRunId: manifest.campaignRunId,
    manifestDigest: manifest.manifestDigest, targetDigest: digest(target), target,
    selectionDigest });
}

export function validateCampaignTransferTargetSeal(
  manifest: CampaignManifest,
  seal: CampaignTransferTargetSeal,
): CampaignTransferTargetSeal {
  let expectedSelectionDigest: string | undefined;
  if (manifest.transfer.mode === 'sealed-brief'
    && manifest.transfer.sealedBriefDigest === seal.targetDigest) {
    expectedSelectionDigest = digest({ mode: manifest.transfer.mode,
      targetDigest: seal.targetDigest });
  } else if (manifest.transfer.mode === 'sealed-pool') {
    const selector = manifest.transfer.selectorDigest;
    const pool = manifest.transfer.poolDigests;
    if (selector && pool?.length) {
      const entropy = digest(`${selector}:${manifest.transfer.randomSourceDigest}`);
      const index = Number.parseInt(entropy.slice(0, 12), 16) % pool.length;
      if (pool[index] === seal.targetDigest) {
        expectedSelectionDigest = digest({ mode: manifest.transfer.mode, selector, entropy, index,
          targetDigest: seal.targetDigest });
      }
    }
  }
  if (seal.schema !== 'sinter.campaign-transfer-target-seal' || seal.schemaVersion !== 1
    || seal.campaignRunId !== manifest.campaignRunId
    || seal.manifestDigest !== manifest.manifestDigest || digest(seal.target) !== seal.targetDigest
    || seal.selectionDigest !== expectedSelectionDigest
    || seal.sealDigest !== digest(targetSealBody(seal))) {
    throw new Error('CAMPAIGN_TRANSFER_TARGET_SEAL_INVALID');
  }
  return seal;
}

/** Export an opaque handle's private material only for protected host persistence. */
export function exportCampaignTransferTargetSeal(target: CampaignTransferTarget): CampaignTransferTargetSeal {
  const resolved = targetCapabilities.get(target);
  if (!resolved) throw new Error('CAMPAIGN_TRANSFER_TARGET_CAPABILITY_INVALID');
  const body = { schema: 'sinter.campaign-transfer-target-seal' as const, schemaVersion: 1 as const,
    ...resolved };
  return Object.freeze({ ...body, sealDigest: digest(body) });
}

/** Validate protected durable material and mint a fresh process-opaque handle after restart. */
export function restoreCampaignTransferTarget(
  manifest: CampaignManifest,
  seal: CampaignTransferTargetSeal,
): CampaignTransferTarget {
  validateCampaignTransferTargetSeal(manifest, seal);
  const resolved = Object.freeze({ campaignRunId: seal.campaignRunId,
    manifestDigest: seal.manifestDigest, targetDigest: seal.targetDigest,
    target: seal.target, selectionDigest: seal.selectionDigest });
  const handle = Object.freeze({ campaignRunId: resolved.campaignRunId,
    manifestDigest: resolved.manifestDigest, targetDigest: resolved.targetDigest });
  targetCapabilities.set(handle, resolved);
  return handle;
}

export function campaignTransferRouteDigest(route: {
  readonly provider: string;
  readonly model: string;
  readonly pipe?: string;
  readonly effort?: string;
}): string {
  return digest({ provider: route.provider, model: route.model,
    ...(route.pipe ? { pipe: route.pipe } : {}), ...(route.effort ? { effort: route.effort } : {}) });
}

export function campaignTransferNonOverlapDigest(
  targetDigest: string,
  sourceDigests: readonly string[],
): string {
  return digest({ targetDigest, sourceDigests: [...new Set(sourceDigests)].sort() });
}

function withoutRecordDigest(record: CampaignContinuationRecord): Omit<CampaignContinuationRecord, 'recordDigest'> {
  const { recordDigest: _recordDigest, ...body } = record;
  return body;
}

function sealRecord(body: Omit<CampaignContinuationRecord, 'recordDigest'>): CampaignContinuationRecord {
  return Object.freeze({ ...body, phases: Object.freeze({ ...body.phases }), recordDigest: digest(body) });
}

function parseRecord(raw: string): CampaignContinuationRecord {
  const value = JSON.parse(raw) as CampaignContinuationRecord;
  const statuses = value?.phases && Object.values(value.phases);
  const completedMarkerMissing = value?.phases && (
    (value.phases.closure === 'completed' && !value.closureDigest)
    || (value.phases.treatment === 'completed' && !value.treatmentHtml)
    || (value.phases.control === 'completed' && !value.controlHtml)
    || (value.phases.evaluation === 'completed' && (!value.outcome || !value.evaluationDigest))
    || (value.phases.dream === 'completed' && !value.dreamRecommendationDigest)
    || (value.phases.origin === 'completed' && !value.originDigest));
  if (value?.schema !== 'sinter.campaign-continuation' || value.schemaVersion !== 1
    || !value.ownerAuthorityId?.trim()
    || !DIGEST.test(value.manifestDigest) || !DIGEST.test(value.checkpointDigest)
    || !DIGEST.test(value.targetDigest) || !Array.isArray(statuses)
    || statuses.length !== 6 || statuses.some((status) =>
      !['pending', 'running', 'completed'].includes(status))
    || Boolean(completedMarkerMissing)
    || (value.closureDigest !== undefined && !DIGEST.test(value.closureDigest))
    || (value.evaluationDigest !== undefined && !DIGEST.test(value.evaluationDigest))
    || (value.dreamRecommendationDigest !== undefined
      && !DIGEST.test(value.dreamRecommendationDigest))
    || (value.originDigest !== undefined && !DIGEST.test(value.originDigest))
    || (value.outcome !== undefined
      && !['improved', 'inconclusive', 'regressed'].includes(value.outcome))
    || (value.learningCommitted === true && value.phases.evaluation !== 'completed')
    || value.recordDigest !== digest(withoutRecordDigest(value))) {
    throw new Error('CAMPAIGN_CONTINUATION_RECORD_INVALID');
  }
  return Object.freeze(structuredClone(value));
}

function initialRecord(input: {
  readonly binding: ContinuationBinding;
  readonly ownerAuthorityId: string;
  readonly checkpointDigest: string;
  readonly targetDigest: string;
  readonly learningEvidenceId: string;
  readonly learningExecution?: CampaignLearningAuthorizationExecution;
}): CampaignContinuationRecord {
  return sealRecord({ schema: 'sinter.campaign-continuation', schemaVersion: 1,
    campaignRunId: input.binding.campaignRunId, ownerAuthorityId: input.ownerAuthorityId,
    manifestDigest: input.binding.manifestDigest,
    checkpointDigest: input.checkpointDigest, targetDigest: input.targetDigest,
    learningEvidenceId: input.learningEvidenceId,
    ...(input.learningExecution ? { learningExecution: input.learningExecution } : {}),
    phases: { closure: 'pending', treatment: 'pending', control: 'pending',
      evaluation: 'pending', dream: 'pending', origin: 'pending' } });
}

function updateRecord(
  record: CampaignContinuationRecord,
  phase: PhaseName,
  status: PhaseStatus,
  extra: Partial<Omit<CampaignContinuationRecord, 'schema' | 'schemaVersion' | 'phases' | 'recordDigest'>> = {},
): CampaignContinuationRecord {
  return sealRecord({ ...withoutRecordDigest(record), ...extra,
    phases: { ...record.phases, [phase]: status } });
}

function surfaceCopyingDetected(html: string, source: string): boolean {
  const normalize = (value: string) => value.toLowerCase().replace(/\s+/g, ' ').trim();
  const normalizedSource = normalize(source);
  return normalizedSource.length >= 16 && normalize(html).includes(normalizedSource);
}

export class CampaignContinuation {
  constructor(private readonly host: CampaignContinuationHost) {
    if (!evaluatorAuthorities.has(host.evaluator)) {
      throw new Error('CAMPAIGN_TRANSFER_EVALUATOR_PROVENANCE_INVALID');
    }
  }

  sealTarget(manifest: CampaignManifest, input: CampaignTransferTargetInput): CampaignTransferTarget {
    const resolved = selectTarget(manifest, input);
    const handle = Object.freeze({ campaignRunId: resolved.campaignRunId,
      manifestDigest: resolved.manifestDigest, targetDigest: resolved.targetDigest });
    targetCapabilities.set(handle, resolved);
    return handle;
  }

  async run(input: {
    readonly admission: CampaignRunAdmission;
    readonly manifest: CampaignManifest;
    readonly checkpoint: CampaignEvidenceCheckpoint;
    readonly learningEvidenceId: string;
    readonly target: CampaignTransferTarget;
    readonly queue: DreamQueue;
    readonly runner: DreamAssimilationRunner;
    readonly governance: Omit<DreamAssimilationGovernance, 'campaignDreamAdmission'>;
  }): Promise<CampaignContinuationProjection> {
    const binding = this.host.binding(input.admission);
    assertCheckpoint(input.checkpoint, binding);
    const target = targetCapabilities.get(input.target);
    if (!target || target.campaignRunId !== binding.campaignRunId
      || target.manifestDigest !== binding.manifestDigest
      || input.manifest.manifestDigest !== binding.manifestDigest
      || input.manifest.campaignRunId !== binding.campaignRunId) {
      throw new Error('CAMPAIGN_TRANSFER_TARGET_CAPABILITY_INVALID');
    }
    const key = `campaign-continuation:${binding.campaignRunId}:${binding.manifestDigest}`;
    return this.host.persistence.claim(key, async () => this.runClaimed(key, input, binding, target));
  }

  private async runClaimed(
    key: string,
    input: Parameters<CampaignContinuation['run']>[0],
    binding: ContinuationBinding,
    target: ResolvedCampaignTransferTarget,
  ): Promise<CampaignContinuationProjection> {
    const prepared = await this.prepareRecord(key, input, binding, target);
    let record = prepared.record;
    const evidence = prepared.evidence;
    const journal = await this.openEvidenceJournal(binding, input.checkpoint);
    record = await this.recoverInterruptedPhases(key, record, binding, journal);
    if (record.phases.closure !== 'completed') {
      record = await this.phase(key, record, 'closure', async (running) => {
        const closure = await this.host.close(input.admission, input.manifest);
        await this.write(key, updateRecord(running, 'closure', 'running', {
          closureDigest: closure.closureDigest }));
        await this.appendReceiptIfMissing(journal, { receiptId: `${binding.campaignRunId}:campaign-closure`,
          kind: 'campaign-closure', resultDigest: closure.closureDigest });
        return { closureDigest: closure.closureDigest };
      });
    }
    return this.runTransferAndDream(key, record, input, binding, target, evidence, journal);
  }

  private async prepareRecord(
    key: string,
    input: Parameters<CampaignContinuation['run']>[0],
    binding: ContinuationBinding,
    target: ResolvedCampaignTransferTarget,
  ): Promise<{ readonly record: CampaignContinuationRecord;
    readonly evidence: CampaignLearningAuthorizationEvidence }> {
    const raw = await this.host.persistence.read(key);
    if (!raw) {
      const evidence = await this.validateFreeze(input.manifest, binding, target,
        input.learningEvidenceId, true);
      let created = initialRecord({ binding, ownerAuthorityId: input.manifest.owner.authorityId,
        checkpointDigest: input.checkpoint.checkpointDigest,
        targetDigest: target.targetDigest, learningEvidenceId: input.learningEvidenceId });
      await this.write(key, created);
      const executionId = this.executionId(binding, evidence.id, target.targetDigest);
      const learningExecution = await this.host.learningAuthority.beginLearningAuthorizationExecution(
        evidence.id, { binding: evidence.binding, briefId: evidence.briefId,
          now: this.host.now().toISOString(), executionId });
      created = sealRecord({ ...withoutRecordDigest(created), learningExecution });
      await this.write(key, created);
      return { record: created, evidence };
    }
    const existing = parseRecord(raw);
    if (existing.campaignRunId !== binding.campaignRunId
      || existing.ownerAuthorityId !== input.manifest.owner.authorityId
      || existing.manifestDigest !== binding.manifestDigest
      || existing.checkpointDigest !== input.checkpoint.checkpointDigest
      || existing.targetDigest !== target.targetDigest
      || existing.learningEvidenceId !== input.learningEvidenceId) {
      throw new Error('CAMPAIGN_CONTINUATION_BINDING_IMMUTABLE');
    }
    const evidence = await this.validateFreeze(input.manifest, binding, target,
      input.learningEvidenceId, false);
    let record = existing;
    if (record.phases.evaluation !== 'completed') {
      const state = await this.host.learningAuthority.resolveLearningAuthorizationState(evidence.id);
      if (state.state === 'active') {
        const resumed = await this.host.learningAuthority.beginLearningAuthorizationExecution(
          evidence.id, { binding: evidence.binding, briefId: evidence.briefId,
            now: this.host.now().toISOString(),
            executionId: this.executionId(binding, evidence.id, target.targetDigest) });
        record = sealRecord({ ...withoutRecordDigest(record), learningExecution: resumed });
        await this.write(key, record);
      } else if (state.state !== 'executing' || !record.learningExecution
        || state.execution?.executionDigest !== record.learningExecution.executionDigest) {
        throw new Error('CAMPAIGN_CONTINUATION_EXECUTION_MISSING');
      }
    }
    return { record, evidence };
  }

  private executionId(binding: ContinuationBinding, learningEvidenceId: string,
    targetDigest: string): string {
    return digest({ campaignRunId: binding.campaignRunId,
      manifestDigest: binding.manifestDigest, learningEvidenceId, targetDigest });
  }

  private async validateFreeze(
    manifest: CampaignManifest,
    binding: ContinuationBinding,
    target: ResolvedCampaignTransferTarget,
    learningEvidenceId: string,
    requireActive: boolean,
  ): Promise<CampaignLearningAuthorizationEvidence> {
    const now = this.host.now().toISOString();
    const sealed = await this.host.learningAuthority.resolveLearningAuthorization(learningEvidenceId);
    if (!manifest.briefs.some((brief) => brief.id === sealed.briefId)) {
      throw new Error('CAMPAIGN_TRANSFER_EVIDENCE_BRIEF_INVALID');
    }
    const scope = { binding: { campaignRunId: binding.campaignRunId,
      manifestDigest: binding.manifestDigest }, briefId: sealed.briefId, now };
    const evidence = requireActive
      ? await this.host.learningAuthority.resolveActiveLearningAuthorization(learningEvidenceId, scope)
      : sealed;
    if (evidence.binding.campaignRunId !== scope.binding.campaignRunId
      || evidence.binding.manifestDigest !== scope.binding.manifestDigest
      || evidence.briefId !== scope.briefId) {
      throw new Error('CAMPAIGN_TRANSFER_EVIDENCE_BINDING_INVALID');
    }
    const sources = [...manifest.briefs.map((brief) => brief.sealedBriefDigest),
      evidence.manifestIntentDigest];
    if (sources.includes(target.targetDigest)
      || manifest.transfer.nonOverlapDigest !== campaignTransferNonOverlapDigest(target.targetDigest, sources)
      || manifest.transfer.evidenceScheduleDigest !== manifest.evidenceScheduleDigest
      || manifest.transfer.randomSourceDigest !== manifest.randomSourceDigest
      || manifest.transfer.routeDigest !== campaignTransferRouteDigest(evidence.route)
      || !['treatment-first', 'control-first'].includes(manifest.transfer.treatmentControlAllocation)) {
      throw new Error('CAMPAIGN_TRANSFER_FREEZE_BINDING_INVALID');
    }
    return evidence;
  }

  private async openEvidenceJournal(
    binding: ContinuationBinding,
    checkpoint: CampaignEvidenceCheckpoint,
  ): Promise<CampaignProgressJournal> {
    const suffix: readonly CampaignProgressReceiptRequirement[] = [
      { receiptId: `${binding.campaignRunId}:campaign-closure`, kind: 'campaign-closure' },
      { receiptId: `${binding.campaignRunId}:transfer-treatment`, kind: 'transfer-treatment' },
      { receiptId: `${binding.campaignRunId}:transfer-control`, kind: 'transfer-control' },
      { receiptId: `${binding.campaignRunId}:transfer-evaluation`, kind: 'transfer-evaluation' },
      { receiptId: `${binding.campaignRunId}:dream`, kind: 'dream-recommendation' },
    ];
    const journal = new CampaignProgressJournal(this.host.persistence, {
      binding, requiredReceipts: [...checkpoint.receipts.map(({ receiptId, kind }) =>
        ({ receiptId, kind })), ...suffix],
    });
    const opened = await journal.open();
    const persisted = new Set(opened.receipts.map((receipt) => receipt.receiptId));
    for (const receipt of checkpoint.receipts) {
      if (!persisted.has(receipt.receiptId)) await journal.append(receipt);
    }
    return journal;
  }

  private async recoverInterruptedPhases(
    key: string,
    initial: CampaignContinuationRecord,
    binding: ContinuationBinding,
    journal: CampaignProgressJournal,
  ): Promise<CampaignContinuationRecord> {
    let record = initial;
    const reconcile = async (phase: PhaseName, marker: string | undefined,
      receipt?: CampaignProgressReceiptRequirement): Promise<void> => {
      if (record.phases[phase] === 'completed') return;
      if (marker && receipt) {
        await this.appendReceiptIfMissing(journal, { ...receipt, resultDigest: marker });
        record = updateRecord(record, phase, 'completed');
      } else if (record.phases[phase] === 'running') {
        record = updateRecord(record, phase, 'pending');
      } else {
        return;
      }
      await this.write(key, record);
    };
    await reconcile('closure', record.closureDigest,
      { receiptId: `${binding.campaignRunId}:campaign-closure`, kind: 'campaign-closure' });
    await reconcile('treatment', record.treatmentHtml ? digest(record.treatmentHtml) : undefined,
      { receiptId: `${binding.campaignRunId}:transfer-treatment`, kind: 'transfer-treatment' });
    await reconcile('control', record.controlHtml ? digest(record.controlHtml) : undefined,
      { receiptId: `${binding.campaignRunId}:transfer-control`, kind: 'transfer-control' });
    await reconcile('evaluation', record.evaluationDigest,
      { receiptId: `${binding.campaignRunId}:transfer-evaluation`, kind: 'transfer-evaluation' });
    await reconcile('dream', record.dreamRecommendationDigest,
      { receiptId: `${binding.campaignRunId}:dream`, kind: 'dream-recommendation' });
    if (record.phases.origin !== 'completed') {
      const persisted = await journal.read();
      if (persisted?.origin) {
        if (record.originDigest && record.originDigest !== persisted.origin.resultDigest) {
          throw new Error('CAMPAIGN_CONTINUATION_ORIGIN_IMMUTABLE');
        }
        record = updateRecord(record, 'origin', 'completed', {
          originDigest: persisted.origin.resultDigest });
        await this.write(key, record);
      } else if (record.phases.origin === 'running') {
        record = updateRecord(record, 'origin', 'pending');
        await this.write(key, record);
      }
    }
    return record;
  }

  private async appendReceiptIfMissing(
    journal: CampaignProgressJournal,
    receipt: { readonly receiptId: string; readonly kind: string; readonly resultDigest: string },
  ): Promise<void> {
    const persisted = await journal.read();
    const existing = persisted?.receipts.find((item) => item.receiptId === receipt.receiptId);
    if (existing) {
      if (existing.kind !== receipt.kind || existing.resultDigest !== receipt.resultDigest) {
        throw new Error('CAMPAIGN_CONTINUATION_RECEIPT_IMMUTABLE');
      }
      return;
    }
    await journal.append(receipt);
  }

  private async phase(
    key: string,
    record: CampaignContinuationRecord,
    name: PhaseName,
    operation: (running: CampaignContinuationRecord) => Promise<Partial<Omit<CampaignContinuationRecord,
      'schema' | 'schemaVersion' | 'phases' | 'recordDigest'>>>,
  ): Promise<CampaignContinuationRecord> {
    const running = updateRecord(record, name, 'running');
    await this.write(key, running);
    try {
      const extra = await operation(running);
      const completed = updateRecord(running, name, 'completed', extra);
      await this.write(key, completed);
      return completed;
    } catch (error) {
      const persisted = await this.host.persistence.read(key);
      const latest = persisted ? parseRecord(persisted) : running;
      await this.write(key, updateRecord(latest, name, 'pending'));
      throw error;
    }
  }

  private async runTransferAndDream(
    key: string,
    initial: CampaignContinuationRecord,
    input: Parameters<CampaignContinuation['run']>[0],
    binding: ContinuationBinding,
    target: ResolvedCampaignTransferTarget,
    evidence: CampaignLearningAuthorizationEvidence,
    journal: CampaignProgressJournal,
  ): Promise<CampaignContinuationProjection> {
    let record = initial;
    const execution = record.learningCommitted ? undefined : record.learningExecution;
    if (!record.learningCommitted && !execution) {
      throw new Error('CAMPAIGN_CONTINUATION_EXECUTION_MISSING');
    }
    try {
      if (execution && record.phases.evaluation !== 'completed') {
        record = await this.runArms(key, record, input, binding, target, evidence, execution, journal);
      }
      record = await this.runEvaluation(key, record, binding, target, evidence, journal);
      if (execution && !record.learningCommitted && record.phases.evaluation === 'completed') {
        await this.host.learningAuthority.commitLearningAuthorizationExecution(
          evidence.id, execution, this.host.now().toISOString());
        record = sealRecord({ ...withoutRecordDigest(record), learningCommitted: true });
        await this.write(key, record);
      }
      record = await this.runDream(key, record, input, binding, evidence, journal);
      return this.runOrigin(key, record, input.admission, journal);
    } catch (error) {
      if (execution && record.phases.evaluation !== 'completed') {
        const persisted = await this.host.persistence.read(key);
        const latest = persisted ? parseRecord(persisted) : record;
        if (!latest.treatmentHtml && !latest.controlHtml) {
          await this.host.learningAuthority.abortLearningAuthorizationExecution(evidence.id, execution)
            .catch(() => undefined);
        }
      }
      throw error;
    }
  }

  private async runArms(
    key: string,
    initial: CampaignContinuationRecord,
    input: Parameters<CampaignContinuation['run']>[0],
    binding: ContinuationBinding,
    target: ResolvedCampaignTransferTarget,
    evidence: CampaignLearningAuthorizationEvidence,
    execution: CampaignLearningAuthorizationExecution,
    journal: CampaignProgressJournal,
  ): Promise<CampaignContinuationRecord> {
    let record = initial;
    const allocation = input.manifest.transfer.treatmentControlAllocation;
    const order = allocation === 'treatment-first'
      ? ['treatment', 'control'] as const : ['control', 'treatment'] as const;
    for (const arm of order) {
      if (record.phases[arm] === 'completed') continue;
      record = await this.runArm(key, record, input.admission, arm, binding, target,
        evidence, execution, journal);
    }
    return record;
  }

  private async runArm(
    key: string,
    record: CampaignContinuationRecord,
    admission: CampaignRunAdmission,
    arm: 'treatment' | 'control',
    binding: ContinuationBinding,
    target: ResolvedCampaignTransferTarget,
    evidence: CampaignLearningAuthorizationEvidence,
    execution: CampaignLearningAuthorizationExecution,
    journal: CampaignProgressJournal,
  ): Promise<CampaignContinuationRecord> {
    const active = await this.host.learningAuthority.resolveLearningAuthorizationExecution(
      evidence.id, execution, arm, this.host.now().toISOString());
    const stageId = `transfer-${arm}` as const;
    const instruction = arm === 'treatment'
      ? `Apply only this authorized experimental rule: ${active.provisional.ruleId}=${JSON.stringify(active.provisional.ruleValue)}`
      : 'Do not apply any learned rule or experimental revision.';
    const request: CompositionRequest = { title: 'Sealed transfer comparison',
      background: '#000000', renderGate: true, maxProviderCalls: 1,
      layers: [{ domain: 'html', prompt: `${target.target}\n${instruction}` }] };
    return this.phase(key, record, arm, async (running) => {
      const composition = await this.host.compose(
        admission, request,
        { requestKey: `${binding.campaignRunId}:${stageId}`,
          provider: active.route.provider, model: active.route.model }, stageId,
      );
      const resultDigest = digest(composition.html);
      const marker = arm === 'treatment'
        ? { treatmentHtml: composition.html } : { controlHtml: composition.html };
      await this.write(key, updateRecord(running, arm, 'running', marker));
      await this.appendReceiptIfMissing(journal, { receiptId: `${binding.campaignRunId}:${stageId}`,
        kind: stageId, resultDigest });
      return marker;
    });
  }

  private async runEvaluation(
    key: string,
    record: CampaignContinuationRecord,
    binding: ContinuationBinding,
    target: ResolvedCampaignTransferTarget,
    evidence: CampaignLearningAuthorizationEvidence,
    journal: CampaignProgressJournal,
  ): Promise<CampaignContinuationRecord> {
    if (record.phases.evaluation === 'completed') return record;
    if (!record.treatmentHtml || !record.controlHtml) {
      throw new Error('CAMPAIGN_TRANSFER_PAIR_INCOMPLETE');
    }
    return this.phase(key, record, 'evaluation', async (running) => {
      const treatmentArtifactDigest = digest(record.treatmentHtml!);
      const controlArtifactDigest = digest(record.controlHtml!);
      const copied = surfaceCopyingDetected(record.treatmentHtml!, evidence.manifest.intent)
        || surfaceCopyingDetected(record.controlHtml!, evidence.manifest.intent);
      const evaluationId = digest({ campaignRunId: binding.campaignRunId,
        manifestDigest: binding.manifestDigest, planDigest: binding.planDigest,
        targetDigest: target.targetDigest, treatmentArtifactDigest, controlArtifactDigest });
      const evaluation = await this.host.evaluator.evaluate({
        evaluationId, campaignRunId: binding.campaignRunId, manifestDigest: binding.manifestDigest,
        planDigest: binding.planDigest, targetDigest: target.targetDigest,
        treatmentArtifactDigest, controlArtifactDigest,
        surfaceCopyingDetected: copied,
      });
      if (!['improved', 'inconclusive', 'regressed'].includes(evaluation.outcome)
        || !DIGEST.test(evaluation.rationaleDigest) || copied) {
        throw new Error(copied ? 'CAMPAIGN_TRANSFER_SURFACE_COPYING_DETECTED'
          : 'CAMPAIGN_TRANSFER_EVALUATION_INVALID');
      }
      const evaluationDigest = digest({ ...evaluation, evaluationId,
        campaignRunId: binding.campaignRunId,
        manifestDigest: binding.manifestDigest, planDigest: binding.planDigest,
        targetDigest: target.targetDigest, treatmentArtifactDigest, controlArtifactDigest,
        surfaceCopyingDetected: copied });
      await this.write(key, updateRecord(running, 'evaluation', 'running', {
        outcome: evaluation.outcome, evaluationDigest }));
      await this.appendReceiptIfMissing(journal, { receiptId: `${binding.campaignRunId}:transfer-evaluation`,
        kind: 'transfer-evaluation', resultDigest: evaluationDigest });
      return { outcome: evaluation.outcome, evaluationDigest };
    });
  }

  private async runDream(
    key: string,
    record: CampaignContinuationRecord,
    input: Parameters<CampaignContinuation['run']>[0],
    binding: ContinuationBinding,
    evidence: CampaignLearningAuthorizationEvidence,
    journal: CampaignProgressJournal,
  ): Promise<CampaignContinuationRecord> {
    if (record.phases.dream === 'completed') return record;
    return this.phase(key, record, 'dream', async (running) => {
      if (!record.outcome || !record.evaluationDigest) {
        throw new Error('CAMPAIGN_DREAM_LESSON_EVIDENCE_MISSING');
      }
      const causalLesson = mintDreamLesson(
        binding, evidence, record.outcome, record.evaluationDigest,
      );
      const result = await this.host.dream(input.admission, input.queue, input.runner,
        input.governance, { requestKey: `${binding.campaignRunId}:dream`, causalLesson });
      if (!result) throw new Error('CAMPAIGN_DREAM_REQUIRED');
      const dreamRecommendationDigest = result.generation.recommendation.recommendationDigest;
      await this.write(key, updateRecord(running, 'dream', 'running', { dreamRecommendationDigest }));
      await this.appendReceiptIfMissing(journal, { receiptId: `${binding.campaignRunId}:dream`,
        kind: 'dream-recommendation',
        resultDigest: dreamRecommendationDigest });
      return { dreamRecommendationDigest };
    });
  }

  private async runOrigin(
    key: string,
    record: CampaignContinuationRecord,
    admission: CampaignRunAdmission,
    journal: CampaignProgressJournal,
  ): Promise<CampaignContinuationProjection> {
    let origin: CampaignOriginReceipt;
    if (record.phases.origin === 'completed') {
      const persisted = await journal.read();
      if (!persisted?.origin) throw new Error('CAMPAIGN_CONTINUATION_ORIGIN_MISSING');
      origin = persisted.origin;
      if (record.originDigest !== origin.resultDigest) {
        throw new Error('CAMPAIGN_CONTINUATION_ORIGIN_IMMUTABLE');
      }
    } else {
      const running = updateRecord(record, 'origin', 'running');
      await this.write(key, running);
      const complete = await journal.assertComplete();
      origin = await this.host.finalize(admission, complete.receipts);
      await this.write(key, updateRecord(running, 'origin', 'running', {
        originDigest: origin.resultDigest }));
      await journal.recordFinalOrigin(origin, this.host.originVerifier);
      record = updateRecord(running, 'origin', 'completed', { originDigest: origin.resultDigest });
      await this.write(key, record);
    }
    const complete = await journal.assertComplete();
    const byKind = new Map(complete.receipts.map((receipt) => [receipt.kind, receipt.resultDigest]));
    const closureDigest = byKind.get('campaign-closure');
    const treatment = byKind.get('transfer-treatment');
    const control = byKind.get('transfer-control');
    const evaluation = byKind.get('transfer-evaluation');
    const dream = byKind.get('dream-recommendation');
    if (!closureDigest || !treatment || !control || !evaluation || !dream
      || !record.outcome || record.evaluationDigest !== evaluation) {
      throw new Error('CAMPAIGN_CONTINUATION_RECEIPTS_INCOMPLETE');
    }
    return Object.freeze({ closureDigest, transferTargetDigest: record.targetDigest,
      transferTreatmentDigest: treatment, transferControlDigest: control,
      transferEvaluationDigest: evaluation, transferOutcome: record.outcome,
      dreamRecommendationDigest: dream, campaignOriginDigest: origin.resultDigest });
  }

  private write(key: string, record: CampaignContinuationRecord): Promise<void> {
    return this.host.persistence.write(key, `${JSON.stringify(record, null, 2)}\n`);
  }
}
