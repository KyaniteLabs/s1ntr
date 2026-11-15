import { randomUUID } from 'node:crypto';
import type {
  CreativeRunCoordinatorBase, CreativeRunRequest, CampaignRunAdmission,
  CampaignRequestBinding, CampaignEvidenceCheckpoint, VerifiedCampaignSlotExecution,
  CampaignOwnerReviewEvidence,
} from './CreativeRunCoordinatorBase.js';
import { CreativeRunCoordinator } from './CreativeRunCoordinator.js';
import type { ArtistReviewClosureCheckpoint } from './ArtistReviewExperience.js';
import type {
  CampaignExecutionPlan,
  CampaignManifest,
  CampaignManifestInput,
  CampaignRouteFreeze,
  CampaignSlotGraph,
  CampaignCapacity,
  CampaignCeilings,
} from './CampaignManifest.js';
import {
  buildCampaignExecutionPlan, manifestIsCurrent, preflightCampaignBudget,
  preflightCampaignStageBudget, validateCampaignSlotGraph,
} from './CampaignManifest.js';
import {
  assertHostCampaignFundingAdmission,
  resolveRuntimeCampaignFundingAuthority,
  type CampaignFundingReservationAuthority,
  type CampaignFundingReservationV1,
  type OwnerReviewAdmission,
} from './CampaignExecutionAuthority.js';
import {
  createCampaignBlindPreferenceEvidence,
  createCampaignOwnerTerminalDecision,
  DurableCampaignClosureLedger,
  resolveRuntimeCampaignClosureEvidenceAuthority,
  type CampaignRevisionEvidence,
  type CampaignClosureEvidenceAuthority,
  type CampaignOwnerDecisionEvidence,
  type CampaignLearningAuthorizationEvidence,
  type CampaignClosureReceipt,
} from './CampaignClosure.js';
import type { CampaignLedgerPersistence } from './CampaignPersistence.js';
import {
  preflightOwnerReviewAllocations,
  runOwnerReviewLifecycle,
  type OwnerReviewClosureContext,
  type OwnerReviewLifecycleInput,
  type OwnerReviewLifecycleResult,
} from './OwnerReviewLifecycle.js';
import {
  assertWave8GovernedCampaignReservationRoutes,
  isPreSpendInterlockConfigured,
  runWithPreSpendCallContext,
  wave8GovernedCampaignStageIds,
} from '../llm/PreSpendInterlock.js';
import type { PaidProviderCallerClass } from '../llm/ProviderTypes.js';
import { bootstrapCampaignExecutorAuthority } from '../identity/executorAuthorityBootstrap.js';
import type { HarnessTransportAuthority } from '../identity/harnessTransportGuard.js';
import { withHarnessTransportAuthority } from '../llm/LLMClient.js';
import type { CampaignOriginReceiptVerifier } from './CampaignProgressJournal.js';
import type { ArtistReviewPromotionCheckpoint } from './ArtistReviewExperience.js';
import type { CoordinatorOwnerTransferCheckpoint } from './CreativeRunCoordinator.js';
import {
  runNextDreamTask,
  type DreamCampaignAdmission,
  type DreamCampaignAdmissionBoundary,
  type DreamAssimilationGovernance,
  type DreamAssimilationRunner,
} from '../dreaming/DreamTaskRunner.js';
import type { DreamQueue } from '../dreaming/DreamQueue.js';
import type { DreamCampaignProductionSeam } from './DreamAssimilationRun.js';
import type { CampaignActualCandidateManifest } from './CandidateHypothesisProduction.js';
import { blindCandidateSetDigest } from './BlindReviewEvidence.js';
import {
  CampaignContinuation,
  resolveCampaignDreamLesson,
  type CampaignDreamLessonCapability,
  type CampaignTransferEvaluator,
  type CampaignTransferTarget,
  type CampaignTransferTargetInput,
  type CampaignContinuationProjection as ContinuationResult,
} from './CampaignContinuation.js';

export type {
  CampaignTransferEvaluator,
  CampaignTransferTarget,
  CampaignTransferTargetInput,
} from './CampaignContinuation.js';

/** Opaque lease proving a lifecycle was synchronously registered by CampaignService. */
export interface OwnerReviewScopeLease {
  readonly __ownerReviewScopeLeaseBrand: never;
}
const ownerReviewScopeLeaseBindings = new WeakMap<object, {
  readonly service: CampaignService;
  readonly campaign: CampaignRunAdmission;
  readonly admission: OwnerReviewAdmission;
  readonly briefId: string;
  readonly candidateSetDigest: string;
}>();

function mintOwnerReviewScopeLease(service: CampaignService, campaign: CampaignRunAdmission,
  input: OwnerReviewLifecycleInput): OwnerReviewScopeLease {
  const lease = Object.freeze({}) as OwnerReviewScopeLease;
  ownerReviewScopeLeaseBindings.set(lease, { service, campaign, admission: input.admission,
    briefId: input.briefId, candidateSetDigest: input.session.packet.candidateSetDigest });
  return lease;
}

export function assertOwnerReviewScopeLease(lease: OwnerReviewScopeLease,
  service: CampaignService, campaign: CampaignRunAdmission,
  input: OwnerReviewLifecycleInput): void {
  const binding = ownerReviewScopeLeaseBindings.get(lease);
  if (!binding || binding.service !== service || binding.campaign !== campaign
    || binding.admission !== input.admission || binding.briefId !== input.briefId
    || binding.candidateSetDigest !== input.session.packet.candidateSetDigest) {
    throw new Error('OWNER_REVIEW_SCOPE_LEASE_NOT_SERVICE_ISSUED');
  }
}

function revokeOwnerReviewScopeLease(lease: OwnerReviewScopeLease): void {
  ownerReviewScopeLeaseBindings.delete(lease);
}

export interface CampaignServiceOptions {
  readonly fundingAuthority?: CampaignFundingReservationAuthority;
  /** Explicit construction seam for isolated tests; production defaults to authenticated live authority. */
  readonly authorityBoundary?: CampaignAuthorityBoundary;
  /** Construction-only test seam; shipped CLI/Studio composition never supplies it. */
  readonly executorAuthorityFactory?: (binding: Parameters<typeof bootstrapCampaignExecutorAuthority>[0])
    => HarnessTransportAuthority;
  /** Shared durable storage for restart-safe campaign-closeout records. */
  readonly closurePersistence?: CampaignLedgerPersistence;
  readonly closureEvidenceAuthority?: CampaignClosureEvidenceAuthority;
  readonly reservationLifetimeMs?: number;
  readonly now?: () => Date;
  /** Host-owned campaign continuation ledger; callers never supply a raw origin capability. */
  readonly progressPersistence?: CampaignLedgerPersistence;
  readonly originVerifier?: CampaignOriginReceiptVerifier;
  readonly transferEvaluator?: CampaignTransferEvaluator;
}

/** Inputs are receipts, not mutable campaign state; settlement is host-derived. */
export interface CampaignRevisionClosureInput {
  readonly briefId: string;
  readonly revisionEvidenceId: string;
  readonly ownerDecisionEvidenceId: string;
}

export interface CampaignOwnerDecisionSealInput {
  readonly id: string;
  readonly briefId: string;
  readonly checkpoint: ArtistReviewClosureCheckpoint;
  readonly originalOwnerReview: OwnerReviewClosureContext;
}

export interface CampaignLearningAuthorizationSealInput {
  readonly id: string;
  readonly briefId: string;
  readonly checkpoint: ArtistReviewPromotionCheckpoint;
}

/** Surface-safe representation shared by CLI, Studio, and bridge. */
export interface CampaignContinuationProjection extends ContinuationResult {
  readonly projection: CampaignProjection;
}

/** One authenticated terminal decision bound to the exact host-published packet. */
export interface CampaignOwnerDecisionFinalizationInput {
  readonly briefId: string;
  readonly revisionEvidenceId: string;
  readonly ownerDecisionEvidenceId: string;
  readonly checkpoint: ArtistReviewClosureCheckpoint;
  readonly originalOwnerReview: OwnerReviewClosureContext;
}

export interface CampaignRevisionDecisionInput {
  readonly briefId: string;
  readonly revisionEvidenceId: string;
}

export interface CampaignRevisionEvidenceSealInput extends CampaignRevisionDecisionInput {
  readonly plan: import('./AttributableRevision.js').ExperimentPlan;
  readonly revision: import('./AttributableRevision.js').AttributableRevisionReceipt;
  readonly blindPreference: import('./AttributableRevision.js').IndependentBlindTreatmentPreference;
}

export const CAMPAIGN_EXECUTION_INPUT_SCHEMA = 'sinter.campaign-execution-input' as const;
export interface CampaignExecutionInputV1 {
  readonly schema: typeof CAMPAIGN_EXECUTION_INPUT_SCHEMA;
  readonly schemaVersion: 1;
  readonly slotGraphs: readonly CampaignSlotGraph[];
}

export interface CampaignProjection {
  readonly requestKey: string;
  readonly manifestDigest: string;
  readonly planDigest: string;
  readonly routeFreezeDigest: string;
  readonly campaignFundingReservationDigest: string;
  readonly feasibilityDigest: string;
  readonly stageCount: number;
}

export interface CampaignAuthorityBoundary {
  readonly phaseOne: boolean;
  admittedStageIds(plan: CampaignExecutionPlan): readonly string[];
  assertReservation(reservation: CampaignFundingReservationV1): void;
  assertTransport(): void;
}

const productionCampaignAuthorityBoundary: CampaignAuthorityBoundary = Object.freeze({
  phaseOne: true,
  admittedStageIds: (plan: CampaignExecutionPlan) => wave8GovernedCampaignStageIds(plan),
  assertReservation: assertWave8GovernedCampaignReservationRoutes,
  assertTransport: () => { wave8GovernedCampaignStageIds(); },
});

function add(left: CampaignCeilings, right: CampaignCeilings): CampaignCeilings {
  return { providerCalls: left.providerCalls + right.providerCalls,
    inputTokens: left.inputTokens + right.inputTokens,
    outputTokens: left.outputTokens + right.outputTokens,
    activeMinutes: left.activeMinutes + right.activeMinutes };
}

function capacityFromReservation(admission: Awaited<ReturnType<CampaignFundingReservationAuthority['reserve']>>): CampaignCapacity {
  const zero: CampaignCeilings = { providerCalls: 0, inputTokens: 0, outputTokens: 0, activeMinutes: 0 };
  const seats: Record<string, CampaignCeilings> = {};
  let totals = zero;
  for (const item of admission.subject.allocations) {
    const limits = { providerCalls: item.providerCalls, inputTokens: item.inputTokens,
      outputTokens: item.outputTokens, activeMinutes: item.activeSeconds / 60 };
    totals = add(totals, limits);
    seats[item.seat.seatId] = add(seats[item.seat.seatId] ?? zero, limits);
  }
  return { ...totals, seats };
}

/** Shared CLI/Studio finite-campaign admission and transport-context seam. */
export class CampaignService {
  private static readonly instances = new WeakMap<CreativeRunCoordinatorBase, CampaignService>();
  private readonly fundingAuthority: CampaignFundingReservationAuthority | undefined;
  private readonly closureEvidenceAuthority: CampaignClosureEvidenceAuthority | undefined;
  private readonly continuation: CampaignContinuation | undefined;
  private readonly authorityBoundary: CampaignAuthorityBoundary;
  private readonly settledOwnerReviewAdmissions = new WeakMap<object, {
    readonly campaign: CampaignRunAdmission;
    readonly candidateSetDigests: ReadonlyMap<string, string>;
  }>();
  private readonly activeOwnerReviewScopes = new WeakMap<object, {
    readonly mint: (input: {
      readonly reservation: CampaignRunAdmission['fundingReservation'];
      readonly manifest: CampaignManifest;
      readonly briefIds: readonly string[];
      readonly candidateSetDigests: readonly {
        readonly briefId: string;
        readonly digest: string;
      }[];
    }) => OwnerReviewAdmission;
    readonly issued: Set<OwnerReviewAdmission>;
    readonly pending: Set<Promise<unknown>>;
    accepting: boolean;
  }>();

  constructor(
    private readonly coordinator: CreativeRunCoordinatorBase,
    private readonly options: CampaignServiceOptions = {},
  ) {
    this.fundingAuthority = resolveRuntimeCampaignFundingAuthority(options.fundingAuthority);
    this.authorityBoundary = options.authorityBoundary ?? productionCampaignAuthorityBoundary;
    this.closureEvidenceAuthority = resolveRuntimeCampaignClosureEvidenceAuthority(
      options.closureEvidenceAuthority,
    );
    if (options.progressPersistence && options.originVerifier && options.transferEvaluator
      && this.closureEvidenceAuthority) {
      this.continuation = new CampaignContinuation({ persistence: options.progressPersistence,
        learningAuthority: this.closureEvidenceAuthority, evaluator: options.transferEvaluator,
        originVerifier: options.originVerifier, now: options.now ?? (() => new Date()),
        binding: (admission) => this.continuationBinding(admission),
        close: (admission, manifest) => this.closeCampaignClosure(admission, manifest),
        compose: (admission, request, composeOptions, stageId) =>
          this.coordinator.composeCampaignStage(request, {
            ...composeOptions, entryPoint: 'studio-layers',
          }, (_stage, operation) => this.runStageTransport(admission, stageId, 'creative', operation)),
        dream: (admission, queue, runner, governance, dreamOptions) =>
          this.runFundedCampaignDream(admission, queue, runner, governance,
            dreamOptions.requestKey, dreamOptions.causalLesson),
        finalize: (admission, receipts) => this.coordinator.finalizeCampaignOrigin(admission, receipts),
      });
    }
  }

  static shared(coordinator: CreativeRunCoordinatorBase, options?: CampaignServiceOptions): CampaignService {
    const existing = CampaignService.instances.get(coordinator);
    if (existing && (!options || (existing.options.fundingAuthority === options.fundingAuthority
      && existing.options.closurePersistence === options.closurePersistence
      && existing.options.closureEvidenceAuthority === options.closureEvidenceAuthority
      && existing.options.progressPersistence === options.progressPersistence
      && existing.options.originVerifier === options.originVerifier
      && existing.options.transferEvaluator === options.transferEvaluator))) return existing;
    const service = new CampaignService(coordinator, options ?? {});
    CampaignService.instances.set(coordinator, service);
    return service;
  }

  /**
   * Seal an authentic owner-authorized staged transfer for durable campaign
   * evidence. This deliberately does not transfer a learning rule or promote
   * any artifact; only the campaign's precommitted treatment arm may consume
   * the sealed evidence later.
   */
  async sealCampaignLearningAuthorization(
    admission: CampaignRunAdmission,
    input: CampaignLearningAuthorizationSealInput,
  ): Promise<CampaignLearningAuthorizationEvidence> {
    this.assertAdmission(admission);
    if (!this.closureEvidenceAuthority || !(this.coordinator instanceof CreativeRunCoordinator)) {
      throw new Error('CAMPAIGN_LEARNING_EVIDENCE_AUTHORITY_MISSING');
    }
    const checkpoint: CoordinatorOwnerTransferCheckpoint =
      this.coordinator.resolveOwnerTransferCheckpoint(input.checkpoint);
    return this.closureEvidenceAuthority.sealLearningAuthorization({ id: input.id,
      binding: { campaignRunId: admission.creativeRun.requestKey, manifestDigest: admission.manifestDigest },
      briefId: input.briefId, checkpoint });
  }

  /** Host-only transfer target seal. Surfaces retain only the returned opaque handle. */
  sealCampaignTransferTarget(
    manifest: CampaignManifest,
    input: CampaignTransferTargetInput,
  ): CampaignTransferTarget {
    if (!this.continuation) throw new Error('CAMPAIGN_CONTINUATION_HOST_NOT_BOOTSTRAPPED');
    return this.continuation.sealTarget(manifest, input);
  }

  /**
   * Ordered #720 closeout → frozen transfer pair → one Dream → terminal
   * campaign origin. This is the single continuation used by every surface.
   */
  async continueGovernedCampaign(
    admission: CampaignRunAdmission,
    manifest: CampaignManifest,
    checkpoint: CampaignEvidenceCheckpoint,
    learningEvidenceId: string,
    target: CampaignTransferTarget,
    queue: DreamQueue,
    runner: DreamAssimilationRunner,
    governance: Omit<DreamAssimilationGovernance, 'campaignDreamAdmission'>,
  ): Promise<CampaignContinuationProjection> {
    this.assertAdmission(admission);
    if (!this.continuation) throw new Error('CAMPAIGN_CONTINUATION_HOST_NOT_BOOTSTRAPPED');
    const result = await this.continuation.run({ admission, manifest, checkpoint,
      learningEvidenceId, target, queue, runner, governance });
    return Object.freeze({ projection: this.project(admission), ...result });
  }

  freezeManifest(input: CampaignManifestInput): CampaignManifest {
    return this.coordinator.createCampaignManifest(input);
  }

  sealPlan(manifest: CampaignManifest, slotGraphs: readonly CampaignSlotGraph[], freeze: CampaignRouteFreeze): CampaignExecutionPlan {
    return buildCampaignExecutionPlan(manifest, slotGraphs, freeze);
  }

  async startCampaign(
    request: CreativeRunRequest,
    manifest: CampaignManifest,
    plan: CampaignExecutionPlan,
  ): Promise<CampaignRunAdmission> {
    if (!this.fundingAuthority) throw new Error('Campaign funding authority is not host-bootstrapped');
    const allowedStageIds = this.authorityBoundary.admittedStageIds(plan);
    const requestKey = request.requestKey?.trim() || `campaign:${randomUUID()}`;
    const existing = await this.coordinator.read(requestKey);
    if (existing?.record.campaignOrigin
      && (existing.record.campaignOrigin.manifestDigest !== manifest.manifestDigest
        || existing.record.campaignOrigin.planDigest !== plan.planDigest)) {
      throw new Error(`Campaign request key ${requestKey} is already bound to a different campaign origin`);
    }
    const hostAdmission = await this.fundingAuthority.admit({ campaignRunId: requestKey, plan,
      allowedStageIds,
      expiresAt: new Date((this.options.now?.() ?? new Date()).getTime()
        + (this.options.reservationLifetimeMs ?? 86_400_000)).toISOString() });
    const reservation = assertHostCampaignFundingAdmission(hostAdmission);
    this.authorityBoundary.assertReservation(reservation);
    const admittedStages = plan.stages.filter(stage => allowedStageIds.includes(stage.id));
    const feasibility = this.authorityBoundary.phaseOne
      ? preflightCampaignStageBudget(manifest, admittedStages, capacityFromReservation(reservation))
      : preflightCampaignBudget(manifest, admittedStages, capacityFromReservation(reservation));
    if (!feasibility.passed) {
      throw new Error(`Campaign provider reservation was not attempted: ${feasibility.failures.join(', ')}`);
    }
    return this.coordinator.startCampaignPlan(
      { ...request, requestKey }, manifest, plan, feasibility, hostAdmission,
    );
  }

  /** Supply one exact frozen allocation; LLMClient itself burns it before network. */
  runStageTransport<T>(admission: CampaignRunAdmission, stageId: string,
    callerClass: PaidProviderCallerClass, operation: () => Promise<T>): Promise<T> {
    if (!this.fundingAuthority) throw new Error('Campaign funding authority is not host-bootstrapped');
    const allocation = admission.fundingReservation.subject.allocations.find(item => item.stageId === stageId);
    if (!allocation) throw new Error(`CAMPAIGN_STAGE_OUTSIDE_FROZEN_PLAN:${stageId}`);
    this.assertAdmission(admission);
    this.authorityBoundary.assertTransport();
    const authorized = () => isPreSpendInterlockConfigured()
      ? runWithPreSpendCallContext({ slotId: allocation.stageId, purpose: 'product', callerClass }, operation)
      : operation();
    const executor = (this.options.executorAuthorityFactory ?? bootstrapCampaignExecutorAuthority)({ seat: allocation.seat,
      funding: allocation.funding });
    return this.fundingAuthority.runStage(admission.fundingReservation, allocation.stageId,
      () => withHarnessTransportAuthority(executor, authorized));
  }

  releaseUnusedFunding(admission: CampaignRunAdmission): Promise<void> {
    this.assertAdmission(admission);
    if (!this.fundingAuthority) throw new Error('Campaign funding authority is not host-bootstrapped');
    return this.fundingAuthority.releaseUnused(admission.fundingReservation);
  }

  private runFundedCampaignDream(
    admission: CampaignRunAdmission,
    queue: DreamQueue,
    runner: DreamAssimilationRunner,
    governance: Omit<DreamAssimilationGovernance, 'campaignDreamAdmission'>,
    claimKey: string,
    lessonCapability: CampaignDreamLessonCapability,
  ) {
    this.assertAdmission(admission);
    const origin = admission.creativeRun.record.campaignOrigin;
    if (!origin || !admission.planDigest) throw new Error('CAMPAIGN_DREAM_ORIGIN_MISSING');
    let active = false;
    const expected: DreamCampaignAdmission = Object.freeze({
      campaignRunId: admission.creativeRun.requestKey,
      manifestDigest: admission.manifestDigest,
      planDigest: admission.planDigest,
      stageId: 'dream',
    });
    const causalLesson = resolveCampaignDreamLesson(lessonCapability);
    if (causalLesson.campaignRunId !== expected.campaignRunId
      || causalLesson.manifestDigest !== expected.manifestDigest
      || causalLesson.planDigest !== expected.planDigest) {
      throw new Error('CAMPAIGN_DREAM_LESSON_BINDING_INVALID');
    }
    const assertActive = (candidate: DreamCampaignAdmission) => {
      if (!active || candidate !== expected) throw new Error('CAMPAIGN_DREAM_ADMISSION_INVALID');
    };
    const boundary: DreamCampaignAdmissionBoundary = Object.freeze({ admission: expected,
      assertActiveExactCampaignDreamAdmission: assertActive,
      causalLesson,
      origin: Object.freeze({ rootRunId: admission.creativeRun.rootRunId,
        fundingReservationDigest: origin.campaignFundingReservationDigest,
        feasibilityDigest: origin.feasibilityDigest, routeFreezeDigest: origin.routeFreezeDigest }),
      composeFunded: ((request, options) => {
        assertActive(expected);
        return this.coordinator.composeCampaignStage(request, {
          entryPoint: options.entryPoint, requestKey: options.requestKey,
          creativeThesis: options.creativeThesis, candidateCount: options.candidateCount,
          candidateBudget: options.candidateBudget,
        }, (_stage, operation) => this.runStageTransport(admission, 'dream', 'dream', operation),
        admission.creativeRun);
      }) satisfies DreamCampaignProductionSeam['composeFunded'],
    });
    active = true;
    return runNextDreamTask(queue, runner,
      { ...governance, campaignDreamAdmission: boundary },
      { claimKey, persistence: this.options.progressPersistence! })
      .finally(() => { active = false; });
  }

  runOwnerReview(surface: 'studio' | 'cli', admission: CampaignRunAdmission,
    input: OwnerReviewLifecycleInput): Promise<OwnerReviewLifecycleResult> {
    this.assertSettledOwnerReviewInput(admission, input);
    const scope = this.activeOwnerReviewScopes.get(admission);
    if (!scope?.accepting || !scope.issued.has(input.admission)) {
      throw new Error('OWNER_REVIEW_ADMISSION_OUTSIDE_GOVERNED_CALLBACK');
    }
    const lease = mintOwnerReviewScopeLease(this, admission, input);
    const lifecycle = runOwnerReviewLifecycle(surface, this, admission, input, lease);
    scope.pending.add(lifecycle);
    lifecycle.then(
      () => { revokeOwnerReviewScopeLease(lease); scope.pending.delete(lifecycle); },
      () => { revokeOwnerReviewScopeLease(lease); scope.pending.delete(lifecycle); },
    );
    return lifecycle;
  }

  /** Fail closed even when the low-level lifecycle is imported directly. */
  assertSettledOwnerReviewInput(
    admission: CampaignRunAdmission,
    input: OwnerReviewLifecycleInput,
  ): void {
    const settled = this.settledOwnerReviewAdmissions.get(input.admission);
    if (settled?.campaign !== admission) {
      throw new Error('OWNER_REVIEW_ADMISSION_CANDIDATES_UNSETTLED');
    }
    if (settled.candidateSetDigests.get(input.briefId) !== input.session.packet.candidateSetDigest) {
      throw new Error('OWNER_REVIEW_CANDIDATE_SET_MISMATCH');
    }
    this.assertAdmissionOwnerReviewBinding(admission, input);
  }

  /**
   * The only service route that seals terminal owner evidence. The public
   * Artist Review witness is first resolved by this exact coordinator, so a
   * valid session from another coordinator cannot cross into this campaign.
   */
  async sealOwnerDecisionEvidence(
    admission: CampaignRunAdmission,
    manifest: CampaignManifest,
    input: CampaignOwnerDecisionSealInput,
  ): Promise<CampaignOwnerDecisionEvidence> {
    this.assertAdmission(admission);
    if (!manifest.briefs.some((brief) => brief.id === input.briefId)) {
      throw new Error(`CAMPAIGN_CLOSURE_BRIEF_OUTSIDE_MANIFEST:${input.briefId}`);
    }
    if (!this.closureEvidenceAuthority || !(this.coordinator instanceof CreativeRunCoordinator)) {
      throw new Error('CAMPAIGN_CLOSURE_EVIDENCE_AUTHORITY_MISSING');
    }
    const checkpoint = this.coordinator.resolveOwnerClosureCheckpoint(input.checkpoint);
    const authority = this.closureEvidenceAuthority as CampaignClosureEvidenceAuthority & {
      sealOwnerDecision?: (value: {
        readonly id: string; readonly binding: { readonly manifestDigest: string; readonly campaignRunId: string };
        readonly briefId: string;
        readonly checkpoint: ReturnType<CreativeRunCoordinator['resolveOwnerClosureCheckpoint']>;
        readonly originalOwnerReview: OwnerReviewClosureContext;
      }) => Promise<CampaignOwnerDecisionEvidence>;
    };
    if (!authority.sealOwnerDecision) throw new Error('CAMPAIGN_CLOSURE_EVIDENCE_SEAL_UNAVAILABLE');
    return authority.sealOwnerDecision({ id: input.id,
      binding: { manifestDigest: manifest.manifestDigest, campaignRunId: manifest.campaignRunId },
      briefId: input.briefId, checkpoint, originalOwnerReview: input.originalOwnerReview });
  }

  /**
   * Complete one real product owner-decision path. The comparison packet and
   * signed envelope are host-derived from the opaque revision checkpoint.
   */
  async finalizeOwnerDecisionClosure(
    admission: CampaignRunAdmission,
    manifest: CampaignManifest,
    input: CampaignOwnerDecisionFinalizationInput,
  ) {
    await this.sealOwnerDecisionEvidence(admission, manifest, {
      id: input.ownerDecisionEvidenceId, briefId: input.briefId, checkpoint: input.checkpoint,
      originalOwnerReview: input.originalOwnerReview,
    });
    return this.recordRevisionClosure(admission, manifest, {
      briefId: input.briefId, revisionEvidenceId: input.revisionEvidenceId,
      ownerDecisionEvidenceId: input.ownerDecisionEvidenceId,
    });
  }

  /**
   * Resolve an opaque, host-sealed revision witness for a live owner
   * comparison. The method returns only receipts retained by the evidence
   * authority in this process; HTTP and CLI callers supply an ID, never
   * serializable plan/revision objects or authority flags.
   */
  async resolveRevisionDecisionInput(
    admission: CampaignRunAdmission,
    manifest: CampaignManifest,
    input: CampaignRevisionDecisionInput,
  ): Promise<Readonly<{
    readonly plan: import('./AttributableRevision.js').ExperimentPlan;
    readonly revision: import('./AttributableRevision.js').AttributableRevisionReceipt;
    readonly blindPreference: import('./AttributableRevision.js').IndependentBlindTreatmentPreference;
  }>> {
    this.assertAdmission(admission);
    if (!manifest.briefs.some((brief) => brief.id === input.briefId)
      || !this.closureEvidenceAuthority) {
      throw new Error('CAMPAIGN_CLOSURE_REVISION_DECISION_CONTEXT_INVALID');
    }
    const evidence = await this.closureEvidenceAuthority.resolveRevision(input.revisionEvidenceId);
    this.assertRevisionDecisionBinding(evidence, manifest, input);
    const authority = this.closureEvidenceAuthority as CampaignClosureEvidenceAuthority & {
      resolveAuthenticRevisionDecisionInput?: (id: string) => Promise<Readonly<{
        readonly plan: import('./AttributableRevision.js').ExperimentPlan;
        readonly revision: import('./AttributableRevision.js').AttributableRevisionReceipt;
        readonly blindPreference: import('./AttributableRevision.js').IndependentBlindTreatmentPreference;
      }>>;
    };
    if (!authority.resolveAuthenticRevisionDecisionInput) {
      throw new Error('CAMPAIGN_CLOSURE_REVISION_DECISION_INPUT_UNAVAILABLE');
    }
    return authority.resolveAuthenticRevisionDecisionInput(input.revisionEvidenceId);
  }

  /** Seal and retain the live authentic revision witness for the product comparison start. */
  async sealRevisionEvidence(
    admission: CampaignRunAdmission,
    manifest: CampaignManifest,
    input: CampaignRevisionEvidenceSealInput,
  ): Promise<CampaignRevisionEvidence> {
    this.assertAdmission(admission);
    if (!manifest.briefs.some((brief) => brief.id === input.briefId)
      || !this.closureEvidenceAuthority) {
      throw new Error('CAMPAIGN_CLOSURE_REVISION_DECISION_CONTEXT_INVALID');
    }
    const authority = this.closureEvidenceAuthority as CampaignClosureEvidenceAuthority & {
      sealRevision?: (value: {
        readonly id: string; readonly binding: { readonly manifestDigest: string; readonly campaignRunId: string };
        readonly briefId: string;
        readonly plan: import('./AttributableRevision.js').ExperimentPlan;
        readonly revision: import('./AttributableRevision.js').AttributableRevisionReceipt;
        readonly blindPreference: import('./AttributableRevision.js').IndependentBlindTreatmentPreference;
      }) => Promise<CampaignRevisionEvidence>;
    };
    if (!authority.sealRevision) throw new Error('CAMPAIGN_CLOSURE_EVIDENCE_SEAL_UNAVAILABLE');
    return authority.sealRevision({ id: input.revisionEvidenceId,
      binding: { manifestDigest: manifest.manifestDigest, campaignRunId: manifest.campaignRunId },
      briefId: input.briefId, plan: input.plan, revision: input.revision,
      blindPreference: input.blindPreference });
  }

  private assertRevisionDecisionBinding(
    evidence: CampaignRevisionEvidence,
    manifest: CampaignManifest,
    input: CampaignRevisionDecisionInput,
  ): void {
    if (evidence.binding.manifestDigest !== manifest.manifestDigest
      || evidence.binding.campaignRunId !== manifest.campaignRunId
      || evidence.briefId !== input.briefId) {
      throw new Error('CAMPAIGN_CLOSURE_REVISION_DECISION_CONTEXT_INVALID');
    }
  }

  /**
   * The governed product path closes only after every frozen brief received
   * one authenticated terminal decision. It deliberately leaves the ledger
   * unclosed if the owner action set is incomplete.
   */
  async finalizeGovernedOwnerDecisionClosures(
    admission: CampaignRunAdmission,
    manifest: CampaignManifest,
    inputs: readonly CampaignOwnerDecisionFinalizationInput[],
  ): Promise<CampaignClosureReceipt> {
    const expected = manifest.briefs.map((brief) => brief.id);
    if (inputs.length !== expected.length || new Set(inputs.map((input) => input.briefId)).size !== expected.length
      || expected.some((briefId) => !inputs.some((input) => input.briefId === briefId))) {
      throw new Error('CAMPAIGN_CLOSURE_DECISION_COVERAGE_INCOMPLETE');
    }
    for (const input of inputs) await this.finalizeOwnerDecisionClosure(admission, manifest, input);
    return this.closeCampaignClosure(admission, manifest);
  }

  /**
   * Persist the final owner decision without ever mutating the sealed owner
   * packet. The funding settlement is recovered from the signed host ledger,
   * so callers cannot substitute an allocation, debit, or attestation.
   */
  async recordRevisionClosure(
    admission: CampaignRunAdmission,
    manifest: CampaignManifest,
    input: CampaignRevisionClosureInput,
  ) {
    const ledger = this.closureLedger(admission, manifest);
    if (!manifest.briefs.some((brief) => brief.id === input.briefId)) {
      throw new Error(`CAMPAIGN_CLOSURE_BRIEF_OUTSIDE_MANIFEST:${input.briefId}`);
    }
    if (!this.closureEvidenceAuthority) throw new Error('CAMPAIGN_CLOSURE_EVIDENCE_AUTHORITY_MISSING');
    const authority = this.closureEvidenceAuthority;
    const revisionEvidence = await authority.resolveRevision(input.revisionEvidenceId);
    const ownerEvidence = await authority.resolveOwnerDecision(input.ownerDecisionEvidenceId);
    if (revisionEvidence.binding.manifestDigest !== manifest.manifestDigest
      || revisionEvidence.binding.campaignRunId !== manifest.campaignRunId
      || revisionEvidence.briefId !== input.briefId || ownerEvidence.briefId !== input.briefId
      || ownerEvidence.binding.manifestDigest !== manifest.manifestDigest
      || ownerEvidence.binding.campaignRunId !== manifest.campaignRunId
      || revisionEvidence.baselineArtifactDigest !== ownerEvidence.baselineArtifactDigest
      || revisionEvidence.comparisonBaselineArtifactDigest !== ownerEvidence.comparisonBaselineArtifactDigest
      || revisionEvidence.planDigest !== ownerEvidence.planDigest
      || revisionEvidence.treatmentArtifactDigest !== ownerEvidence.treatmentArtifactDigest
      || revisionEvidence.revision.treatmentId !== revisionEvidence.treatmentId
      || revisionEvidence.revision.planDigest !== revisionEvidence.planDigest
      || revisionEvidence.blindPreference.planDigest !== revisionEvidence.planDigest
      || revisionEvidence.revision.blindTreatmentPreferenceDigest !== revisionEvidence.blindPreference.receiptDigest) {
      throw new Error('CAMPAIGN_CLOSURE_EVIDENCE_BINDING_INVALID');
    }
    if (!this.fundingAuthority) throw new Error('Campaign funding authority is not host-bootstrapped');
    const settlement = await this.fundingAuthority.settledStage(
      admission.fundingReservation, `revision-${input.briefId}`,
    );
    const reviewer = revisionEvidence.blindPreference.reviewer;
    if (reviewer.role !== 'specialist' && reviewer.role !== 'holistic') {
      throw new Error('CAMPAIGN_CLOSURE_BLIND_REVIEWER_ROLE_INVALID');
    }
    const blindPreference = createCampaignBlindPreferenceEvidence({
      planDigest: revisionEvidence.blindPreference.planDigest,
      treatmentArtifactDigest: revisionEvidence.blindPreference.treatmentArtifactDigest,
      reviewer: { ...reviewer, role: reviewer.role },
      outcome: revisionEvidence.blindPreference.outcome,
      receiptDigest: revisionEvidence.blindPreference.receiptDigest,
    });
    return ledger.record({
      briefId: input.briefId,
      revision: {
        planDigest: revisionEvidence.revision.planDigest,
        receiptDigest: revisionEvidence.revision.receiptDigest,
        outcome: revisionEvidence.revision.outcome,
        improvementEstablished: revisionEvidence.revision.improvementEstablished,
        blindPreference,
      },
      settlement: {
        stageId: settlement.stageId,
        allocationId: settlement.allocationId,
        reservationDigest: settlement.reservationDigest,
        settlementDigest: settlement.settlementDigest,
      },
      owner: createCampaignOwnerTerminalDecision({
        ownerPacketDigest: ownerEvidence.originalQualityPacket.packetDigest,
        preference: ownerEvidence.preference,
        release: ownerEvidence.release,
      }),
    });
  }

  closeCampaignClosure(
    admission: CampaignRunAdmission,
    manifest: CampaignManifest,
  ): Promise<CampaignClosureReceipt> {
    return this.closureLedger(admission, manifest).close();
  }

  /** Validate every reviewer route and credential before any campaign provider call. */
  preflightOwnerReview(
    admission: CampaignRunAdmission,
    manifest: CampaignManifest,
    briefIds: readonly string[],
  ): void {
    this.assertAdmission(admission);
    preflightOwnerReviewAllocations(admission, manifest, briefIds);
  }

  assertOwnerReviewCoverage(
    manifest: CampaignManifest,
    inputs: readonly OwnerReviewLifecycleInput[],
  ): void {
    this.assertOwnerReviewBriefCoverage(manifest, inputs.map((input) => input.briefId));
  }

  assertOwnerReviewBriefCoverage(
    manifest: CampaignManifest,
    briefIds: readonly string[],
  ): void {
    const expected = manifest.briefs.map((brief) => brief.id);
    const actual = [...briefIds];
    if (expected.length !== actual.length || expected.some((id, index) => id !== actual[index]))
      throw new Error('OWNER_REVIEW_BRIEF_COVERAGE_MISMATCH');
  }

  /** Mint the opaque owner-review authority from the active host only. */
  admitOwnerReview(
    admission: CampaignRunAdmission,
    manifest: CampaignManifest,
    candidates: readonly CampaignActualCandidateManifest[],
  ): OwnerReviewAdmission {
    this.assertAdmission(admission);
    if (!this.fundingAuthority) throw new Error('Campaign funding authority is not host-bootstrapped');
    this.coordinator.assertSettledCampaignCandidateManifests(admission, candidates);
    const briefIds = candidates.map((candidate) => candidate.briefId);
    this.assertOwnerReviewBriefCoverage(manifest, briefIds);
    const scope = this.activeOwnerReviewScopes.get(admission);
    if (!scope?.accepting) throw new Error('OWNER_REVIEW_ADMISSION_OUTSIDE_GOVERNED_CALLBACK');
    const candidateSetDigests = candidates.map((candidate) => ({
      briefId: candidate.briefId,
      digest: blindCandidateSetDigest(candidate.candidates),
    }));
    const ownerAdmission = scope.mint({
      reservation: admission.fundingReservation, manifest, briefIds, candidateSetDigests,
    });
    this.settledOwnerReviewAdmissions.set(ownerAdmission, {
      campaign: admission,
      candidateSetDigests: new Map(candidateSetDigests.map((item) => [item.briefId, item.digest])),
    });
    scope.issued.add(ownerAdmission);
    return ownerAdmission;
  }

  runGovernedCampaign(
    admission: CampaignRunAdmission,
    manifest: CampaignManifest,
    input: CampaignExecutionInputV1,
    options: Parameters<CreativeRunCoordinatorBase['runGovernedCampaignBatch']>[3] = {},
    completeOwnerReviews?: Parameters<CreativeRunCoordinatorBase['runGovernedCampaignBatch']>[5],
  ): ReturnType<CreativeRunCoordinatorBase['runGovernedCampaignBatch']> {
    this.assertAdmission(admission);
    this.authorityBoundary.assertTransport();
    if (!this.fundingAuthority) throw new Error('Campaign funding authority is not host-bootstrapped');
    const verified = this.assertGovernedInput(manifest, admission.plan, input);
    const runProviderStageFor = (binding: CampaignSlotGraph) => {
      const mappings = this.governedStageMappings(admission.plan, binding);
      return <T>(stage: { nodeId: string; attempt: number }, operation: () => Promise<T>) => {
      const mapping = mappings.get(stage.nodeId);
      if (!mapping) throw new Error(`CAMPAIGN_NODE_STAGE_MAPPING_MISSING:${stage.nodeId}`);
      const stageId = stage.attempt === 1 ? mapping.generation : mapping.recovery;
      const callerClass = options.entryPoint === 'cli-compose' ? 'cli' : 'studio';
      const authorized = () => isPreSpendInterlockConfigured()
        ? runWithPreSpendCallContext({ slotId: stageId, purpose: 'product', callerClass }, operation)
        : operation();
      const allocation = admission.fundingReservation.subject.allocations
        .find((item) => item.stageId === stageId);
      if (!allocation) throw new Error(`CAMPAIGN_STAGE_OUTSIDE_FROZEN_PLAN:${stageId}`);
      const executor = (this.options.executorAuthorityFactory ?? bootstrapCampaignExecutorAuthority)({ seat: allocation.seat,
        funding: allocation.funding });
      return this.fundingAuthority!.runStage(admission.fundingReservation, stageId,
        () => withHarnessTransportAuthority(executor, authorized));
      };
    };
    const governedOwnerReviews = completeOwnerReviews && (async (
      manifests: readonly CampaignActualCandidateManifest[],
    ): Promise<readonly CampaignOwnerReviewEvidence[]> => {
      if (this.activeOwnerReviewScopes.has(admission)) {
        throw new Error('OWNER_REVIEW_SCOPE_ALREADY_ACTIVE');
      }
      return this.fundingAuthority!.runOwnerReviewScope(async (mint) => {
        const issued = new Set<OwnerReviewAdmission>();
        const pending = new Set<Promise<unknown>>();
        const scope = { mint, issued, pending, accepting: true };
        this.activeOwnerReviewScopes.set(admission, scope);
        try {
          const result = await completeOwnerReviews(manifests);
          scope.accepting = false;
          await Promise.all([...pending]);
          return result;
        } finally {
          scope.accepting = false;
          await Promise.allSettled([...pending]);
          this.activeOwnerReviewScopes.delete(admission);
          for (const ownerAdmission of issued) {
            this.settledOwnerReviewAdmissions.delete(ownerAdmission);
          }
        }
      });
    });
    return this.coordinator.runGovernedCampaignBatch(
      manifest, verified, admission, options, runProviderStageFor, governedOwnerReviews,
    );
  }

  assertGovernedInput(
    manifest: CampaignManifest,
    plan: CampaignExecutionPlan,
    input: CampaignExecutionInputV1,
  ): readonly VerifiedCampaignSlotExecution[] {
    if (!manifestIsCurrent(manifest)) throw new Error('CAMPAIGN_MANIFEST_V3_REQUIRED');
    if (input.schema !== CAMPAIGN_EXECUTION_INPUT_SCHEMA || input.schemaVersion !== 1
      || !Array.isArray(input.slotGraphs)) throw new Error('CAMPAIGN_EXECUTION_INPUT_INVALID');
    if (manifest.manifestDigest !== plan.manifestDigest
      || manifest.campaignRunId !== plan.campaignRunId) {
      throw new Error('CAMPAIGN_EXECUTION_PLAN_MANIFEST_MISMATCH');
    }
    const expected = manifest.briefs.flatMap((brief) => brief.candidateSlots
      .map((slot) => `${brief.id}:${slot.id}`));
    const actual = input.slotGraphs.map((item) => `${item.briefId}:${item.candidateSlotId}`);
    if (actual.length !== expected.length || new Set(actual).size !== actual.length
      || actual.some((key, index) => key !== expected[index])) {
      throw new Error('CAMPAIGN_EXECUTION_SLOT_ORDER_MISMATCH');
    }
    const verified = input.slotGraphs.map((binding, index): VerifiedCampaignSlotExecution => {
      if (!binding.graph || binding.graph.schemaVersion !== '2.0'
        || !Array.isArray(binding.graph.nodes)) {
        throw new Error('Governed campaign requires a frozen V2 graph for every slot');
      }
      const proof = validateCampaignSlotGraph(
        manifest, binding.briefId, binding.candidateSlotId, binding.graph,
      );
      if (proof.graphDigest !== plan.slotGraphDigests[index]) {
        throw new Error(`CAMPAIGN_EXECUTION_GRAPH_DIGEST_MISMATCH:${binding.candidateSlotId}`);
      }
      const diversity = plan.routeFreeze.candidateDiversity.filter((item) =>
        item.briefId === binding.briefId && item.candidateSlotId === binding.candidateSlotId);
      if (diversity.length !== 1) {
        throw new Error(`CAMPAIGN_EXECUTION_DIVERSITY_BINDING_MISMATCH:${binding.candidateSlotId}`);
      }
      this.governedStageMappings(plan, binding);
      return Object.freeze({ binding, proof, diversity: diversity[0]! });
    });
    return Object.freeze(verified);
  }

  project(admission: CampaignRunAdmission): CampaignProjection {
    const origin = admission.creativeRun.record.campaignOrigin;
    if (!origin || !admission.planDigest) throw new Error('Campaign admission has no sealed origin');
    return Object.freeze({ requestKey: admission.creativeRun.requestKey,
      manifestDigest: origin.manifestDigest, planDigest: origin.planDigest,
      routeFreezeDigest: origin.routeFreezeDigest,
      campaignFundingReservationDigest: origin.campaignFundingReservationDigest,
      feasibilityDigest: origin.feasibilityDigest,
      stageCount: admission.feasibility.requiredStageCount });
  }

  /** Exact binding consumed by #724's host-signed governed campaign origin. */
  governedBinding(admission: CampaignRunAdmission): CampaignRequestBinding {
    this.assertAdmission(admission);
    return Object.freeze({
      campaignRunId: admission.creativeRun.requestKey,
      manifestDigest: admission.manifestDigest,
      campaignFundingReservationDigest: admission.fundingReservation.reservationDigest,
      campaignPlanDigest: admission.planDigest,
      campaignRouteFreezeDigest: admission.fundingReservation.subject.routeFreezeDigest,
    });
  }

  private continuationBinding(admission: CampaignRunAdmission) {
    const binding = this.governedBinding(admission);
    if (!binding.campaignPlanDigest || !binding.campaignRouteFreezeDigest
      || !binding.campaignFundingReservationDigest) {
      throw new Error('CAMPAIGN_CONTINUATION_BINDING_INCOMPLETE');
    }
    return Object.freeze({ campaignRunId: binding.campaignRunId,
      rootRunId: admission.creativeRun.rootRunId, manifestDigest: binding.manifestDigest,
      planDigest: binding.campaignPlanDigest,
      routeFreezeDigest: binding.campaignRouteFreezeDigest,
      campaignFundingReservationDigest: binding.campaignFundingReservationDigest });
  }

  private governedStageMappings(
    plan: CampaignExecutionPlan,
    binding: CampaignSlotGraph,
  ): Map<string, { generation: string; recovery: string }> {
    const spec = binding.graph;
    if (spec.schemaVersion !== '2.0') {
      throw new Error('Governed campaign requires a frozen V2 graph for per-stage execution');
    }
    const mappings = new Map<string, { generation: string; recovery: string }>();
    for (const node of spec.nodes) {
      const generation = plan.stages.filter(stage =>
        stage.kind === 'generation' && stage.nodeId === node.id
        && stage.briefId === binding.briefId
        && stage.candidateSlotId === binding.candidateSlotId);
      if (generation.length !== 1) {
        throw new Error(`CAMPAIGN_NODE_STAGE_MAPPING_${generation.length ? 'AMBIGUOUS' : 'MISSING'}:${node.id}`);
      }
      const stage = generation[0]!;
      const recovery = plan.stages.filter(candidate => candidate.kind === 'recovery'
        && candidate.briefId === stage.briefId
        && candidate.candidateSlotId === stage.candidateSlotId
        && candidate.nodeId === node.id);
      if (recovery.length !== 1) {
        throw new Error(`CAMPAIGN_RECOVERY_STAGE_MAPPING_${recovery.length ? 'AMBIGUOUS' : 'MISSING'}:${node.id}`);
      }
      mappings.set(node.id, { generation: stage.id, recovery: recovery[0]!.id });
    }
    return mappings;
  }

  /**
   * Bind an owner-review admission to a specific campaign admission. Both the
   * campaign run and the host funding reservation digest must match — this
   * prevents an owner-review admission minted for one campaign from being
   * replayed against a different campaign's run.
   */
  assertAdmissionOwnerReviewBinding(
    admission: CampaignRunAdmission,
    ownerReview: { readonly admission: OwnerReviewAdmission },
  ): void {
    this.assertAdmission(admission);
    if (ownerReview.admission.reservation.reservationDigest
      !== admission.fundingReservation.reservationDigest) {
      throw new Error('OWNER_REVIEW_ADMISSION_RESERVATION_MISMATCH');
    }
    if (ownerReview.admission.manifest.manifestDigest
      !== admission.fundingReservation.subject.manifestDigest) {
      throw new Error('OWNER_REVIEW_ADMISSION_MANIFEST_MISMATCH');
    }
  }

  private assertAdmission(admission: CampaignRunAdmission): void {
    if (!this.fundingAuthority?.verify(admission.fundingReservation)) {
      throw new Error('Campaign funding reservation is not signed by the active host authority');
    }
    const origin = admission.creativeRun.record.campaignOrigin;
    if (!origin || origin.manifestDigest !== admission.fundingReservation.subject.manifestDigest
      || origin.planDigest !== admission.fundingReservation.subject.planDigest
      || origin.campaignFundingReservationDigest !== admission.fundingReservation.reservationDigest
      || origin.routeFreezeDigest !== admission.fundingReservation.subject.routeFreezeDigest) {
      throw new Error('Campaign funding admission does not match its persisted origin');
    }
  }

  private closureLedger(admission: CampaignRunAdmission, manifest: CampaignManifest): DurableCampaignClosureLedger {
    this.assertAdmission(admission);
    if (!manifestIsCurrent(manifest)
      || manifest.manifestDigest !== admission.manifestDigest
      || manifest.campaignRunId !== admission.creativeRun.requestKey) {
      throw new Error('CAMPAIGN_CLOSURE_MANIFEST_ADMISSION_MISMATCH');
    }
    if (!this.options.closurePersistence) throw new Error('CAMPAIGN_CLOSURE_PERSISTENCE_MISSING');
    return new DurableCampaignClosureLedger(manifest, this.options.closurePersistence);
  }
}
