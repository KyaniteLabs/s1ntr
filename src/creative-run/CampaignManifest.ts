import { createHash } from 'node:crypto';
import type { ModelRole, ProviderFamily } from '../identity/types.js';
import { resolveExecutorAlias } from '../identity/canonicalAlias.js';
import { planCompositionGraph, type CompositionGraph } from '../composition/CompositionGraph.js';

export const CAMPAIGN_MANIFEST_SCHEMA = 'sinter.creative-campaign-manifest' as const;
export const CAMPAIGN_MANIFEST_VERSION = 3 as const;
const DIGEST = /^[a-f0-9]{64}$/;

export interface CampaignCeilings {
  readonly providerCalls: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly activeMinutes: number;
}

export interface CampaignCandidateSlot {
  readonly id: string;
  readonly graphNodeIds: readonly string[];
  readonly ownerEvidence: CampaignOwnerEvidenceSlot;
}

export type CampaignAudioRequirement = 'required' | 'not-applicable';
export type CampaignEvidenceModality = 'source' | 'visual' | 'temporal' | 'audio'
  | 'interaction' | 'runtime' | 'clock' | 'accessibility';

/** Pre-spend owner-evidence commitment. Actual output digests are post-execution evidence. */
export interface CampaignOwnerEvidenceSlot {
  readonly campaignRunId: string;
  readonly briefId: string;
  readonly candidateId: string;
  readonly nodeId: string;
  readonly audioRequirement: CampaignAudioRequirement;
  readonly requiredEvidenceClasses: readonly CampaignEvidenceModality[];
  readonly evidenceScheduleDigest: string;
  readonly slotDigest: string;
}

export interface CampaignBrief {
  readonly id: string;
  readonly sealedBriefDigest: string;
  readonly unseenAt: string;
  readonly exampleFree: boolean;
  readonly candidateSlots: readonly CampaignCandidateSlot[];
}

export interface CampaignTransferFreeze {
  readonly mode: 'sealed-brief' | 'sealed-pool';
  readonly sealedBriefDigest?: string;
  readonly poolDigests?: readonly string[];
  readonly selectorDigest?: string;
  readonly unseenAt: string;
  readonly treatmentControlAllocation: string;
  readonly routeDigest: string;
  readonly randomSourceDigest: string;
  readonly evidenceScheduleDigest: string;
  readonly nonOverlapDigest: string;
}

export interface CampaignManifestInput {
  readonly campaignRunId: string;
  readonly owner: { readonly authorityId: string; readonly selectionMethod: string };
  readonly briefs: readonly CampaignBrief[];
  readonly transfer: CampaignTransferFreeze;
  readonly rolesDigest: string;
  readonly executorRequirementsDigest: string;
  readonly evidenceModalitiesDigest: string;
  readonly ownerCheckpointsDigest: string;
  readonly qualityRubricVersion: string;
  readonly randomSourceDigest: string;
  readonly evidenceScheduleDigest: string;
  readonly requiredReviewStageIds: readonly string[];
  readonly stopStates: readonly string[];
  readonly ceilings: CampaignCeilings;
}

export interface CampaignManifest extends CampaignManifestInput {
  readonly schema: typeof CAMPAIGN_MANIFEST_SCHEMA;
  readonly schemaVersion: typeof CAMPAIGN_MANIFEST_VERSION;
  readonly manifestDigest: string;
}

export type CampaignStageKind =
  | 'generation' | 'recovery' | 'revision' | 'transfer-treatment'
  | 'transfer-control' | 'review' | 'dream';

export type CampaignTransportPurpose = 'primary' | 'retry' | 'fallback' | 'tool-turn' | 'stream';

export interface CampaignTransportBudget {
  readonly retries: number;
  readonly fallbacks: number;
  readonly toolTurns: number;
  readonly primaryMode: 'generate' | 'stream';
}

export interface CampaignTransportTemplate {
  readonly ordinal: number;
  readonly purpose: CampaignTransportPurpose;
  readonly phase: 'pre-primary-transport' | 'pre-retry-transport' | 'pre-fallback-transport';
  readonly mode: 'generate' | 'stream';
}

export interface CampaignExecutionStage {
  readonly id: string;
  readonly kind: CampaignStageKind;
  readonly briefId?: string;
  readonly candidateSlotId?: string;
  readonly nodeId?: string;
  readonly seatId: string;
  readonly transports: readonly CampaignTransportTemplate[];
  readonly providerCalls: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly activeMinutes: number;
}

export type CampaignSeatCapacity = CampaignCeilings;

export interface CampaignCapacity extends CampaignCeilings {
  readonly seats: Readonly<Record<string, CampaignSeatCapacity>>;
}

export interface CampaignBudgetFeasibility {
  readonly passed: boolean;
  readonly failures: readonly string[];
  readonly requiredStageCount: number;
  readonly totals: CampaignCeilings;
  readonly feasibilityDigest: string;
}

export interface CampaignCandidateInsertion {
  readonly briefId: string;
  readonly candidateSlotId: string;
  readonly artifactDigest: string;
  readonly status: 'completed' | 'failed' | 'rejected';
}

export function ownerReviewStageIds(manifest: Pick<CampaignManifest, 'briefs'>): readonly string[] {
  return manifest.briefs.flatMap((brief) => brief.candidateSlots.flatMap((slot) => [
    `specialist-review-${brief.id}-${slot.id}`,
    `holistic-review-${brief.id}-${slot.id}`,
  ]));
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stable(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function digest(value: unknown): string {
  return createHash('sha256').update(stable(value)).digest('hex');
}

function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  return Object.freeze(value);
}

function validId(value: string): boolean {
  return value.trim().length > 0;
}

function validDigest(value: string | undefined): value is string {
  return typeof value === 'string' && DIGEST.test(value);
}

function validTimestamp(value: string): boolean {
  return Number.isFinite(Date.parse(value));
}

function validNonNegative(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function requireDigest(value: string | undefined, label: string): void {
  if (!validDigest(value)) throw new Error(`Campaign manifest requires valid ${label}`);
}

function validateBriefs(briefs: readonly CampaignBrief[]): void {
  if (briefs.length === 0) throw new Error('Campaign manifest requires at least one sealed brief');
  if (new Set(briefs.map((brief) => brief.id)).size !== briefs.length) {
    throw new Error('Campaign manifest brief IDs must be unique');
  }
  const campaignSlotIds = new Set<string>();
  for (const brief of briefs) {
    if (!validId(brief.id) || !brief.exampleFree || !validTimestamp(brief.unseenAt)) {
      throw new Error(`Campaign brief ${brief.id || '<unknown>'} must be example-free and unseen`);
    }
    requireDigest(brief.sealedBriefDigest, `sealed brief digest for ${brief.id}`);
    if (brief.candidateSlots.length === 0) {
      throw new Error(`Campaign brief ${brief.id} requires at least one candidate slot`);
    }
    if (new Set(brief.candidateSlots.map((slot) => slot.id)).size !== brief.candidateSlots.length) {
      throw new Error(`Campaign brief ${brief.id} candidate slots must be unique`);
    }
    for (const slot of brief.candidateSlots) {
      if (!validId(slot.id) || slot.graphNodeIds.length === 0
        || new Set(slot.graphNodeIds).size !== slot.graphNodeIds.length
        || slot.graphNodeIds.some((nodeId) => !validId(nodeId))
        || campaignSlotIds.has(slot.id)) {
        throw new Error(`Campaign candidate slot in ${brief.id} has invalid graph topology`);
      }
      campaignSlotIds.add(slot.id);
      const evidence = slot.ownerEvidence;
      const expectedClasses: CampaignEvidenceModality[] = evidence?.audioRequirement === 'required'
        ? ['source', 'visual', 'temporal', 'audio', 'interaction', 'runtime', 'clock', 'accessibility']
        : ['source', 'visual', 'temporal', 'interaction', 'runtime', 'clock', 'accessibility'];
      const body = evidence && {
        campaignRunId: evidence.campaignRunId, briefId: evidence.briefId,
        candidateId: evidence.candidateId, nodeId: evidence.nodeId,
        audioRequirement: evidence.audioRequirement,
        requiredEvidenceClasses: evidence.requiredEvidenceClasses,
        evidenceScheduleDigest: evidence.evidenceScheduleDigest,
      };
      if (!evidence || evidence.briefId !== brief.id || evidence.candidateId !== slot.id
        || !slot.graphNodeIds.includes(evidence.nodeId)
        || !validId(evidence.campaignRunId)
        || !validDigest(evidence.evidenceScheduleDigest) || !validDigest(evidence.slotDigest)
        || evidence.slotDigest !== digest(body)
        || evidence.requiredEvidenceClasses.length !== expectedClasses.length
        || expectedClasses.some((item, index) => evidence.requiredEvidenceClasses[index] !== item)) {
        throw new Error(`Campaign owner evidence slot ${brief.id}/${slot.id} is invalid`);
      }
    }
  }
}

function validateTransfer(transfer: CampaignTransferFreeze): void {
  if (!validTimestamp(transfer.unseenAt) || !validId(transfer.treatmentControlAllocation)) {
    throw new Error('Campaign transfer freeze is incomplete');
  }
  requireDigest(transfer.routeDigest, 'transfer route digest');
  requireDigest(transfer.randomSourceDigest, 'transfer random-source digest');
  requireDigest(transfer.evidenceScheduleDigest, 'transfer evidence-schedule digest');
  requireDigest(transfer.nonOverlapDigest, 'transfer non-overlap digest');
  if (transfer.mode === 'sealed-brief') requireDigest(transfer.sealedBriefDigest, 'transfer brief digest');
  if (transfer.mode === 'sealed-pool') {
    if (!validDigest(transfer.selectorDigest) || !transfer.poolDigests?.length
      || transfer.poolDigests.some((value) => !validDigest(value))) {
      throw new Error('Campaign transfer pool is incomplete');
    }
  }
}

function validateCeilings(ceilings: CampaignCeilings): void {
  // activeMinutes max raised for multi-node fixtures + slow coding seats (gen/recovery=12 each).
  const expected: CampaignCeilings = {
    providerCalls: 128, inputTokens: 6_000_000, outputTokens: 2_000_000, activeMinutes: 2_400,
  };
  for (const key of Object.keys(expected) as Array<keyof CampaignCeilings>) {
    if (!validNonNegative(ceilings[key]) || ceilings[key] > expected[key]) {
      throw new Error(`Campaign ceiling ${key} must be a safe non-negative value at or below ${expected[key]}`);
    }
  }
}

function manifestBody(manifest: CampaignManifest): Omit<CampaignManifest, 'manifestDigest'> {
  const { manifestDigest: _manifestDigest, ...body } = manifest;
  return body;
}

export function createCampaignManifest(input: CampaignManifestInput): CampaignManifest {
  if (!validId(input.campaignRunId)) throw new Error('Campaign manifest campaign run ID is incomplete');
  if (!validId(input.owner.authorityId) || !validId(input.owner.selectionMethod)) {
    throw new Error('Campaign manifest owner authority is incomplete');
  }
  validateBriefs(input.briefs);
  if (input.briefs.some((brief) => brief.candidateSlots.some((slot) =>
    slot.ownerEvidence.campaignRunId !== input.campaignRunId))) {
    throw new Error('Campaign owner evidence slot campaign run ID mismatch');
  }
  validateTransfer(input.transfer);
  requireDigest(input.rolesDigest, 'roles digest');
  requireDigest(input.executorRequirementsDigest, 'executor requirements digest');
  requireDigest(input.evidenceModalitiesDigest, 'evidence modalities digest');
  requireDigest(input.ownerCheckpointsDigest, 'owner checkpoints digest');
  requireDigest(input.randomSourceDigest, 'random-source digest');
  requireDigest(input.evidenceScheduleDigest, 'evidence-schedule digest');
  if (!validId(input.qualityRubricVersion) || input.stopStates.length === 0
    || input.stopStates.some((state) => !validId(state)) || input.requiredReviewStageIds.length === 0
    || new Set(input.requiredReviewStageIds).size !== input.requiredReviewStageIds.length
    || input.requiredReviewStageIds.some((stageId) => !validId(stageId))) {
    throw new Error('Campaign manifest quality or stop-state freeze is incomplete');
  }
  validateCeilings(input.ceilings);
  const body = { schema: CAMPAIGN_MANIFEST_SCHEMA, schemaVersion: CAMPAIGN_MANIFEST_VERSION, ...input };
  return deepFreeze({ ...body, manifestDigest: digest(body) });
}

export function manifestIsCurrent(manifest: CampaignManifest): boolean {
  try {
    return Boolean(manifest && typeof manifest === 'object'
      && validDigest(manifest.manifestDigest)
      && manifest.schema === CAMPAIGN_MANIFEST_SCHEMA
      && manifest.schemaVersion === CAMPAIGN_MANIFEST_VERSION
      && Array.isArray(manifest.briefs) && manifest.briefs.length > 0
      && manifest.ceilings && typeof manifest.ceilings === 'object'
      && digest(manifestBody(manifest)) === manifest.manifestDigest);
  } catch {
    return false;
  }
}

function totalStages(stages: readonly CampaignExecutionStage[]): CampaignCeilings {
  return stages.reduce<CampaignCeilings>((totals, stage) => ({
    providerCalls: totals.providerCalls + stage.providerCalls,
    inputTokens: totals.inputTokens + stage.inputTokens,
    outputTokens: totals.outputTokens + stage.outputTokens,
    activeMinutes: totals.activeMinutes + stage.activeMinutes,
  }), { providerCalls: 0, inputTokens: 0, outputTokens: 0, activeMinutes: 0 });
}

function stageValid(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const stage = value as Partial<CampaignExecutionStage>;
  const kinds: readonly CampaignStageKind[] = [
    'generation', 'recovery', 'revision', 'transfer-treatment',
    'transfer-control', 'review', 'dream',
  ];
  const purposes: readonly CampaignTransportPurpose[] = [
    'primary', 'retry', 'fallback', 'tool-turn', 'stream',
  ];
  const phases = ['pre-primary-transport', 'pre-retry-transport', 'pre-fallback-transport'];
  const transports = Array.isArray(stage.transports) ? stage.transports : [];
  return typeof stage.id === 'string' && validId(stage.id)
    && typeof stage.seatId === 'string' && validId(stage.seatId)
    && typeof stage.kind === 'string' && kinds.includes(stage.kind as CampaignStageKind)
    && validNonNegative(stage.providerCalls as number)
    && validNonNegative(stage.inputTokens as number)
    && validNonNegative(stage.outputTokens as number)
    && validNonNegative(stage.activeMinutes as number)
    && stage.providerCalls === transports.length && transports.length > 0
    && transports.every((item, ordinal) => item && typeof item === 'object'
      && item.ordinal === ordinal && purposes.includes(item.purpose)
      && phases.includes(item.phase) && (item.mode === 'generate' || item.mode === 'stream'))
    && (stage.kind !== 'review' || transports.every((item) => item.mode === 'generate'));
}

function stageKey(stage: CampaignExecutionStage): string {
  return `${stage.kind}:${stage.briefId ?? ''}:${stage.candidateSlotId ?? ''}:${stage.nodeId ?? ''}`;
}

function requiredGenerationKeys(manifest: CampaignManifest): string[] {
  return manifest.briefs.flatMap((brief) => brief.candidateSlots.flatMap((slot) =>
    slot.graphNodeIds.map((nodeId) => `generation:${brief.id}:${slot.id}:${nodeId}`)));
}

function expectedSingletonKeys(manifest: CampaignManifest): string[] {
  return [
    ...manifest.briefs.flatMap((brief) => brief.candidateSlots.flatMap((slot) =>
      slot.graphNodeIds.map((nodeId) => `recovery:${brief.id}:${slot.id}:${nodeId}`))),
    ...manifest.briefs.map((brief) => `revision:${brief.id}::`),
    'transfer-treatment:::', 'transfer-control:::', 'dream:::',
  ];
}

function addCapacityFailures(
  stages: readonly CampaignExecutionStage[], capacity: CampaignCapacity, failures: string[],
): void {
  const totals = totalStages(stages);
  for (const key of Object.keys(totals) as Array<keyof CampaignCeilings>) {
    if (!validNonNegative(totals[key])) failures.push(`campaign-budget-feasible: ${key} arithmetic overflow`);
    if (!validNonNegative(capacity[key])) failures.push(`campaign-budget-feasible: ${key} capacity is unknown`);
    else if (totals[key] > capacity[key]) failures.push(`campaign-budget-feasible: ${key} exceeds current capacity`);
  }
  const seatStages = new Map<string, CampaignExecutionStage[]>();
  for (const stage of stages) seatStages.set(stage.seatId, [...(seatStages.get(stage.seatId) ?? []), stage]);
  for (const [seatId, assigned] of seatStages) {
    const seat = capacity.seats?.[seatId];
    if (!seat) {
      failures.push(`campaign-budget-feasible: seat capacity is unknown for ${seatId}`);
      continue;
    }
    const totalsForSeat = totalStages(assigned);
    for (const key of Object.keys(totalsForSeat) as Array<keyof CampaignCeilings>) {
      if (!validNonNegative(seat[key])) failures.push(`campaign-budget-feasible: ${key} seat capacity is unknown for ${seatId}`);
      else if (totalsForSeat[key] > seat[key]) failures.push(`campaign-budget-feasible: ${key} exceeds seat capacity for ${seatId}`);
    }
  }
}

function addManifestCeilingFailures(
  stages: readonly CampaignExecutionStage[], manifest: CampaignManifest, failures: string[],
): void {
  const totals = totalStages(stages);
  for (const key of Object.keys(totals) as Array<keyof CampaignCeilings>) {
    if (totals[key] > manifest.ceilings[key]) failures.push(`campaign-budget-feasible: ${key} exceeds manifest ceiling`);
  }
}

function preflightCampaignBudgetInternal(
  manifest: CampaignManifest,
  stages: readonly CampaignExecutionStage[],
  capacity: CampaignCapacity,
): CampaignBudgetFeasibility {
  const failures: string[] = [];
  if (!manifestIsCurrent(manifest)) failures.push('campaign-budget-feasible: manifest digest is invalid');
  if (new Set(stages.map((stage) => stage.id)).size !== stages.length) {
    failures.push('campaign-budget-feasible: execution stage IDs must be unique');
  }
  for (const stage of stages) {
    if (!stageValid(stage)) failures.push(`campaign-budget-feasible: stage ${stage.id || '<unknown>'} has unknown cost`);
  }
  const keys = stages.map(stageKey);
  for (const key of requiredGenerationKeys(manifest)) {
    if (keys.filter((value) => value === key).length !== 1) {
      const [, , candidateSlotId, nodeId] = key.split(':');
      failures.push(`campaign-budget-feasible: missing generation stage for ${candidateSlotId}/${nodeId}`);
    }
  }
  for (const key of expectedSingletonKeys(manifest)) {
    const count = keys.filter((value) => value === key).length;
    if (count !== 1) {
      const [kind, , candidateSlotId] = key.split(':');
      if (kind === 'recovery' && count > 1) failures.push(`campaign-budget-feasible: candidate ${candidateSlotId} node has more than one recovery stage`);
      else failures.push(`campaign-budget-feasible: ${kind} stage is missing or duplicated`);
    }
  }
  const expectedKeys = new Set([...requiredGenerationKeys(manifest), ...expectedSingletonKeys(manifest)]);
  for (const stage of stages) {
    if (stage.kind !== 'review' && !expectedKeys.has(stageKey(stage))) {
      failures.push(`campaign-budget-feasible: ${stage.kind} stage ${stage.id} is outside the frozen topology`);
    }
  }
  for (const reviewId of manifest.requiredReviewStageIds) {
    if (stages.filter((stage) => stage.kind === 'review' && stage.id === reviewId).length !== 1) {
      failures.push(`campaign-budget-feasible: required review stage ${reviewId} is missing or duplicated`);
    }
  }
  addManifestCeilingFailures(stages, manifest, failures);
  addCapacityFailures(stages, capacity, failures);
  const totals = totalStages(stages);
  return deepFreeze({ passed: failures.length === 0, failures, requiredStageCount: stages.length, totals,
    feasibilityDigest: digest({ manifestDigest: manifest.manifestDigest, stages, capacity, failures }) });
}

/** Runtime callers receive a deterministic fail-closed report for every malformed shape. */
export function preflightCampaignBudget(
  manifest: CampaignManifest,
  stages: readonly CampaignExecutionStage[],
  capacity: CampaignCapacity,
): CampaignBudgetFeasibility {
  try {
    return preflightCampaignBudgetInternal(manifest, stages, capacity);
  } catch (error) {
    const failures = [`campaign-budget-feasible: malformed campaign input: ${
      error instanceof Error ? error.message : 'unknown shape'}`];
    const totals = { providerCalls: 0, inputTokens: 0, outputTokens: 0, activeMinutes: 0 };
    return deepFreeze({ passed: false, failures,
      requiredStageCount: Array.isArray(stages) ? stages.length : 0, totals,
      feasibilityDigest: digest({ schema: 'campaign-preflight-failure.v1', failures, totals }) });
  }
}

/** Validate the funded phase subset without pretending deferred topology is absent. */
export function preflightCampaignStageBudget(
  manifest: CampaignManifest,
  stages: readonly CampaignExecutionStage[],
  capacity: CampaignCapacity,
): CampaignBudgetFeasibility {
  try {
    const failures: string[] = [];
    if (!manifestIsCurrent(manifest)) failures.push('campaign-budget-feasible: manifest digest is invalid');
    if (new Set(stages.map(stage => stage.id)).size !== stages.length) {
      failures.push('campaign-budget-feasible: execution stage IDs must be unique');
    }
    for (const stage of stages) {
      if (!stageValid(stage)) failures.push(`campaign-budget-feasible: stage ${stage.id || '<unknown>'} has unknown cost`);
    }
    addManifestCeilingFailures(stages, manifest, failures);
    addCapacityFailures(stages, capacity, failures);
    const totals = totalStages(stages);
    return deepFreeze({ passed: failures.length === 0, failures, requiredStageCount: stages.length,
      totals, feasibilityDigest: digest({ manifestDigest: manifest.manifestDigest, stages, capacity, failures }) });
  } catch (error) {
    const failures = [`campaign-budget-feasible: malformed campaign input: ${
      error instanceof Error ? error.message : 'unknown shape'}`];
    const totals = { providerCalls: 0, inputTokens: 0, outputTokens: 0, activeMinutes: 0 };
    return deepFreeze({ passed: false, failures,
      requiredStageCount: Array.isArray(stages) ? stages.length : 0, totals,
      feasibilityDigest: digest({ schema: 'campaign-stage-preflight-failure.v1', failures, totals }) });
  }
}

export class CampaignCandidateLedger {
  readonly #slots = new Map<string, CampaignBrief>();
  readonly #insertions = new Map<string, CampaignCandidateInsertion>();

  constructor(readonly manifest: CampaignManifest) {
    if (!manifestIsCurrent(manifest)) throw new Error('Campaign candidate ledger requires a valid frozen manifest');
    for (const brief of manifest.briefs) {
      for (const slot of brief.candidateSlots) this.#slots.set(`${brief.id}:${slot.id}`, brief);
    }
  }

  insert(insertion: CampaignCandidateInsertion): CampaignCandidateInsertion {
    const key = `${insertion.briefId}:${insertion.candidateSlotId}`;
    const brief = this.#slots.get(key);
    if (!brief) throw new Error(`Campaign candidate slot ${key} is not frozen in this manifest`);
    if (!validDigest(insertion.artifactDigest)) throw new Error('Campaign candidate artifact digest is invalid');
    const existing = this.#insertions.get(key);
    if (existing) {
      if (stable(existing) !== stable(insertion)) throw new Error(`Campaign candidate slot ${key} already has an immutable result`);
      return existing;
    }
    const stored = deepFreeze({ ...insertion });
    this.#insertions.set(key, stored);
    return stored;
  }

  records(): readonly CampaignCandidateInsertion[] {
    return this.manifest.briefs.flatMap((brief) => brief.candidateSlots.flatMap((slot) => {
      const record = this.#insertions.get(`${brief.id}:${slot.id}`);
      return record ? [record] : [];
    }));
  }

  isComplete(): boolean {
    return this.#insertions.size === this.#slots.size;
  }
}

// ============================================================================
// W8C-05 repair: sealed canonical execution plan and host-owned funding truth,
// canonical per-slot CompositionGraphV2, role-safe frozen routes,
// durable per-stage counters, and durable atomic candidate insertion.
//
// The original commit let the caller declare feasibility by passing arbitrary
// `stages` and `capacity` into `startCampaign`. The repair binds a *sealed*
// canonical execution plan (derived from the manifest) and a verified W8C-03
// exact seat/funding allocations enforced at the provider boundary.
// ============================================================================

/** Frozen per-role route binding a seat to an exact provider, model, seed, and retry budget. */
export interface CampaignRoleRoute {
  readonly role: ModelRole;
  readonly seatId: string;
  readonly provider: ProviderFamily;
  readonly model: string;
  readonly seed: string;
  readonly retryBudget: number;
}

/** A diversity dimension that candidate hypotheses must differ along (not only seed/style). */
export interface CampaignDiversityDimension {
  readonly id: string;
  readonly description: string;
}

export interface CampaignCandidateDiversityFreeze {
  readonly briefId: string;
  readonly candidateSlotId: string;
  readonly thesisDigest: string;
  readonly dimensions: Readonly<Record<string, string>>;
}

/**
 * Frozen campaign routes, unseen transfer target, and diversity dimensions.
 * Freezes exact routes/models/seeds/targets/retries and diversity dimensions.
 */
export interface CampaignRouteFreeze {
  readonly routes: readonly CampaignRoleRoute[];
  /** Ordered one-call transport allowances, sealed by stage kind. */
  readonly transportBudgets: Readonly<Partial<Record<CampaignStageKind, CampaignTransportBudget>>>;
  readonly transferTargetDigest: string;
  readonly diversityDimensions: readonly CampaignDiversityDimension[];
  readonly candidateDiversity: readonly CampaignCandidateDiversityFreeze[];
}

export function computeRouteFreezeDigest(freeze: CampaignRouteFreeze): string {
  return digest({
    routes: freeze.routes,
    transportBudgets: freeze.transportBudgets,
    transferTargetDigest: freeze.transferTargetDigest,
    diversityDimensions: freeze.diversityDimensions,
    candidateDiversity: freeze.candidateDiversity,
  });
}

function transportTemplates(budget?: CampaignTransportBudget): readonly CampaignTransportTemplate[] {
  const policy = budget ?? { retries: 0, fallbacks: 0, toolTurns: 0, primaryMode: 'generate' as const };
  if (policy.primaryMode !== 'generate' && policy.primaryMode !== 'stream') {
    throw new Error('Campaign transport primary mode must be generate or stream');
  }
  if (![policy.retries, policy.fallbacks, policy.toolTurns]
    .every(value => Number.isSafeInteger(value) && value >= 0)) {
    throw new Error('Campaign transport budget must be finite and non-negative');
  }
  const specs: Array<Omit<CampaignTransportTemplate, 'ordinal'>> = [{
    purpose: policy.primaryMode === 'stream' ? 'stream' : 'primary',
    phase: 'pre-primary-transport', mode: policy.primaryMode,
  }];
  for (let i = 0; i < policy.toolTurns; i += 1) {
    specs.push({ purpose: 'tool-turn', phase: 'pre-primary-transport', mode: 'generate' });
  }
  for (let i = 0; i < policy.retries; i += 1) {
    specs.push({ purpose: 'retry', phase: 'pre-retry-transport', mode: 'generate' });
  }
  for (let i = 0; i < policy.fallbacks; i += 1) {
    specs.push({ purpose: 'fallback', phase: 'pre-fallback-transport', mode: 'generate' });
  }
  return deepFreeze(specs.map((spec, ordinal) => ({ ordinal, ...spec })));
}

/** Luna may generate or evaluate, but it may never be a harness or Dream executor. */
export function isLunaModel(model: string): boolean {
  const resolution = resolveExecutorAlias(model);
  return resolution.ok && resolution.isLuna;
}

/** A canonical CompositionGraphV2 bound to a candidate slot. The digest is sealed canonically. */
export interface CampaignSlotGraph {
  readonly briefId: string;
  readonly candidateSlotId: string;
  readonly graph: CompositionGraph;
}

export interface CampaignSlotGraphProof {
  readonly briefId: string;
  readonly candidateSlotId: string;
  readonly nodeCount: number;
  readonly graphDigest: string;
}

/**
 * Validate a canonical CompositionGraphV2 for one candidate slot.
 *
 * Covers the arbitrary-N semantics required by the W8C-05 spec: 1, 2, 3, 5+,
 * and 8 node graphs; nested groups; multi-scene; shared controls; clock
 * bridges; and resource-constrained teardown. Rejects cycles, dangling
 * dependencies, multiple unbridged clock authorities, and resources declared
 * without a complete teardown order (resource stop without cleanup).
 */
export function validateCampaignSlotGraph(
  manifest: CampaignManifest,
  briefId: string,
  candidateSlotId: string,
  graph: CompositionGraph,
): CampaignSlotGraphProof {
  const brief = manifest.briefs.find((candidate) => candidate.id === briefId);
  if (!brief) throw new Error(`Campaign slot graph references unknown brief ${briefId}`);
  const slot = brief.candidateSlots.find((candidate) => candidate.id === candidateSlotId);
  if (!slot) throw new Error(`Campaign slot graph references unknown candidate slot ${candidateSlotId}`);
  const graphNodeIds = graph.nodes.map((node) => node.id).sort();
  const manifestNodeIds = [...slot.graphNodeIds].sort();
  if (graphNodeIds.length !== manifestNodeIds.length
    || graphNodeIds.some((id, index) => id !== manifestNodeIds[index])) {
    throw new Error(
      `Campaign slot graph node topology does not match the manifest slot ${briefId}/${candidateSlotId}`,
    );
  }
  // Delegate structural validation to the shared V2 planner: it catches cycles
  // ("unbounded cycle"), dangling edge references, invalid groups/scenes/
  // phases, and runtime-contract violations.
  planCompositionGraph(graph);
  // Multiple clock authorities: distinct clocks across timing islands must be
  // bridged into a single connected component (multi-clock bridge is allowed;
  // unbridged multiple clock authorities are rejected).
  const islands = graph.timingIslands ?? [];
  const distinctClocks = new Set(islands.map((island) => island.clock));
  if (distinctClocks.size > 1) {
    const bridges = graph.bridges ?? [];
    const parent = new Map(islands.map((island) => [island.id, island.id]));
    const find = (id: string): string => {
      let current = id;
      while (parent.get(current) !== current) {
        current = parent.get(current)!;
        parent.set(id, current);
      }
      return current;
    };
    const union = (a: string, b: string): void => { parent.set(find(a), find(b)); };
    for (const bridge of bridges) union(bridge.fromIslandId, bridge.toIslandId);
    if (new Set(islands.map((island) => find(island.id))).size > 1) {
      throw new Error('Campaign slot graph declares multiple unbridged clock authorities');
    }
  }
  // Resource-constrained stop: any declared resource requires a complete,
  // valid teardown order so no owned resource is left running.
  const resources = graph.resources ?? [];
  if (resources.length > 0) {
    const nodeIds = new Set(graph.nodes.map((node) => node.id));
    const teardown = graph.lifecycle?.teardownOrder;
    if (!teardown
      || teardown.length !== graph.nodes.length
      || new Set(teardown).size !== teardown.length
      || teardown.some((id) => !nodeIds.has(id))) {
      throw new Error('Campaign slot graph declares resources without a complete teardown order');
    }
  }
  const graphDigest = digest(graph);
  return deepFreeze({ briefId, candidateSlotId, nodeCount: graph.nodes.length, graphDigest });
}

/** Conservative worst-case cost profile per stage kind (frozen by the canonical plan). */
/** A002 envelope law — DESIGN OF RECORD, NOT YET ENFORCED (Sol senior verdict
 * 2026-08-26; implementation deferred: requires migrating the test corpus to
 * per-transport accounting — ledger task A002, rejected round 1). Until
 * enforced, the flat 26k envelope below is the operative law. Per-plan:
 * E = min(GENERATION_ENVELOPE_MAX, floor((CAMPAIGN_OUTPUT_CEILING_HARD - R) / (G*T)))
 * with fail-closed rejection below GENERATION_ENVELOPE_FLOOR.
 * A002 envelope law (Sol senior verdict 2026-08-26): per-plan generation
 * envelope E = min(GEN_ENVELOPE_MAX, floor((OUTPUT_CEILING - R) / (G*T)))
 * where R = output budgets of all non-generation-class stages, G = generation+
 * recovery stages, T = transports per stage. Fail closed when E would fall
 * below the proven no-truncation floor (observed real peak 22.2k; 26k is the
 * largest value the legacy mega-plans fit under the 2M law). */
export const CAMPAIGN_OUTPUT_CEILING_HARD = 2_000_000;
export const GENERATION_ENVELOPE_MAX = 30_000;
export const GENERATION_ENVELOPE_FLOOR = 26_000;

const STAGE_COST_PROFILE: Readonly<Record<CampaignStageKind, CampaignCeilings>> = Object.freeze({
  // generation/recovery: slow coding seats need wall-clock headroom (activeMinutes)
  // and enough max_tokens so reasoning_content + code content both fit (Moonshot).
  generation: { providerCalls: 1, inputTokens: 40_000, outputTokens: 26_000, activeMinutes: 12 },
  recovery: { providerCalls: 1, inputTokens: 40_000, outputTokens: 26_000, activeMinutes: 12 },
  revision: { providerCalls: 1, inputTokens: 50_000, outputTokens: 15_000, activeMinutes: 10 },
  'transfer-treatment': { providerCalls: 1, inputTokens: 50_000, outputTokens: 15_000, activeMinutes: 10 },
  'transfer-control': { providerCalls: 1, inputTokens: 50_000, outputTokens: 15_000, activeMinutes: 10 },
  review: { providerCalls: 1, inputTokens: 128_000, outputTokens: 10_000, activeMinutes: 15 },
  dream: { providerCalls: 1, inputTokens: 40_000, outputTokens: 12_000, activeMinutes: 5 },
});

/**
 * A sealed canonical execution plan derived from the manifest — never caller-
 * declared. Every generation node, bounded recovery, revision opportunity,
 * transfer/control pair, required review, and the single Dream slot is
 * expanded here and bound to a frozen route seat.
 */
export interface CampaignExecutionPlan {
  readonly schema: 'sinter.campaign-execution-plan';
  readonly schemaVersion: 1;
  readonly manifestDigest: string;
  readonly campaignRunId: string;
  readonly routeFreeze: CampaignRouteFreeze;
  readonly routeFreezeDigest: string;
  readonly slotGraphDigests: readonly string[];
  readonly stages: readonly CampaignExecutionStage[];
  readonly planDigest: string;
}

function routeSeatFor(
  freeze: CampaignRouteFreeze,
  role: CampaignRoleRoute['role'],
  seatId?: string,
): string {
  const route = seatId !== undefined
    ? freeze.routes.find((candidate) => candidate.role === role && candidate.seatId === seatId)
    : freeze.routes.find((candidate) => candidate.role === role);
  if (!route) {
    throw new Error(
      `Campaign route freeze is missing a ${role} route${seatId !== undefined ? ` for seat ${seatId}` : ''}`,
    );
  }
  return route.seatId;
}

/**
 * Derive the sealed canonical execution plan from the manifest.
 *
 * @param manifest The frozen campaign manifest.
 * @param slotGraphs Canonical CompositionGraphV2 per candidate slot.
 * @param freeze Frozen routes/models/seeds/targets/retries and diversity dimensions.
 * @param extraStages Optional caller-supplied stages; any stage outside the
 *   canonical topology is rejected (reject unlisted stages).
 */
export function buildCampaignExecutionPlan(
  manifest: CampaignManifest,
  slotGraphs: readonly CampaignSlotGraph[],
  freeze: CampaignRouteFreeze,
  extraStages: readonly CampaignExecutionStage[] = [],
): CampaignExecutionPlan {
  if (!manifestIsCurrent(manifest)) {
    throw new Error('Campaign execution plan requires a valid frozen manifest');
  }
  if (freeze.routes.length === 0) {
    throw new Error('Campaign route freeze must bind at least one route');
  }
  if (freeze.transportBudgets.review?.primaryMode === 'stream') {
    throw new Error('Campaign owner review transport must be complete-only');
  }
  if (!validDigest(freeze.transferTargetDigest)) {
    throw new Error('Campaign route freeze requires a sealed unseen transfer-target digest');
  }
  if (freeze.diversityDimensions.length < 3) {
    throw new Error('Campaign route freeze requires at least three diversity dimensions');
  }
  const routeSeats = freeze.routes.map((route) => route.seatId);
  if (new Set(routeSeats).size !== routeSeats.length
    || freeze.routes.filter((route) => route.role === 'generator').length !== 1
    || freeze.routes.filter((route) => route.role === 'harness').length !== 1
    || freeze.routes.filter((route) => route.role === 'studio').length > 0) {
    throw new Error('Campaign route freeze contains ambiguous or unused role routes');
  }
  // Durable role law: Luna is allowed only in generator/evaluator-shaped roles.
  for (const route of freeze.routes) {
    if (!validId(route.seatId) || !validId(route.provider) || !validId(route.model)
      || !validId(route.seed) || route.retryBudget !== 1) {
      throw new Error(`Campaign route freeze route for seat ${route.seatId} is incomplete`);
    }
    if (isLunaModel(route.model) && route.role !== 'generator' && route.role !== 'evaluator') {
      throw new Error(
        `Campaign route freeze prohibits Luna model ${route.model} for ${route.role} on seat ${route.seatId}`,
      );
    }
  }
  const expectedDiversityKeys = manifest.briefs.flatMap((brief) => brief.candidateSlots
    .map((slot) => `${brief.id}:${slot.id}`));
  const actualDiversityKeys = freeze.candidateDiversity
    .map((candidate) => `${candidate.briefId}:${candidate.candidateSlotId}`);
  if (new Set(actualDiversityKeys).size !== actualDiversityKeys.length
    || actualDiversityKeys.length !== expectedDiversityKeys.length
    || expectedDiversityKeys.some((key) => !actualDiversityKeys.includes(key))) {
    throw new Error('Campaign route freeze requires exact candidate diversity bindings');
  }
  const dimensionIds = freeze.diversityDimensions.map((dimension) => dimension.id);
  for (const brief of manifest.briefs) {
    const candidates = freeze.candidateDiversity.filter((candidate) => candidate.briefId === brief.id);
    if (new Set(candidates.map((candidate) => candidate.thesisDigest)).size !== candidates.length
      || candidates.some((candidate) => !validDigest(candidate.thesisDigest)
        || dimensionIds.some((id) => !validId(candidate.dimensions[id] ?? '')))) {
      throw new Error(`Campaign candidates for ${brief.id} require distinct sealed theses and complete diversity dimensions`);
    }
    for (const dimensionId of dimensionIds) {
      if (new Set(candidates.map((candidate) => candidate.dimensions[dimensionId])).size !== candidates.length) {
        throw new Error(`Campaign candidates for ${brief.id} are not distinct along ${dimensionId}`);
      }
    }
  }
  // Validate and bind each canonical slot graph; collect sealed digests.
  const expectedSlotKeys = new Set(manifest.briefs.flatMap((brief) => brief.candidateSlots
    .map((slot) => `${brief.id}:${slot.id}`)));
  const suppliedSlotKeys = slotGraphs.map((binding) => `${binding.briefId}:${binding.candidateSlotId}`);
  if (new Set(suppliedSlotKeys).size !== suppliedSlotKeys.length
    || suppliedSlotKeys.length !== expectedSlotKeys.size
    || suppliedSlotKeys.some((key) => !expectedSlotKeys.has(key))) {
    throw new Error('Campaign execution plan requires exactly one canonical graph for every frozen candidate slot');
  }
  const slotGraphDigests: string[] = [];
  for (const binding of slotGraphs) {
    const proof = validateCampaignSlotGraph(
      manifest, binding.briefId, binding.candidateSlotId, binding.graph,
    );
    slotGraphDigests.push(proof.graphDigest);
  }
  const generatorSeat = routeSeatFor(freeze, 'generator');
  const dreamSeat = routeSeatFor(freeze, 'harness');
  const stages: CampaignExecutionStage[] = [];
  const pushStage = (
    id: string, kind: CampaignStageKind, seatId: string,
    refs?: { briefId?: string; candidateSlotId?: string; nodeId?: string },
  ): void => {
    const budget = freeze.transportBudgets[kind];
    const route = freeze.routes.find(candidate => candidate.seatId === seatId);
    if (!route || (budget?.retries ?? 0) > route.retryBudget) {
      throw new Error(`Campaign transport retry budget exceeds frozen route ${seatId}`);
    }
    const transports = transportTemplates(budget);
    stages.push({
      id, kind, seatId, ...STAGE_COST_PROFILE[kind],
      transports, providerCalls: transports.length,
      ...(refs?.briefId ? { briefId: refs.briefId } : {}),
      ...(refs?.candidateSlotId ? { candidateSlotId: refs.candidateSlotId } : {}),
      ...(refs?.nodeId ? { nodeId: refs.nodeId } : {}),
    });
  };
  // Generation: one stage per graph node across every candidate slot.
  for (const brief of manifest.briefs) {
    for (const slot of brief.candidateSlots) {
      for (const nodeId of slot.graphNodeIds) {
        pushStage(`generate-${brief.id}-${slot.id}-${nodeId}`, 'generation', generatorSeat,
          { briefId: brief.id, candidateSlotId: slot.id, nodeId });
      }
    }
  }
  // Recovery: exactly one node-bound recovery allowance per generation node.
  for (const brief of manifest.briefs) {
    for (const slot of brief.candidateSlots) {
      for (const nodeId of slot.graphNodeIds) {
        pushStage(`recover-${brief.id}-${slot.id}-${nodeId}`, 'recovery', generatorSeat,
          { briefId: brief.id, candidateSlotId: slot.id, nodeId });
      }
    }
  }
  // Revision: exactly one preregistered revision opportunity per brief.
  for (const brief of manifest.briefs) {
    pushStage(`revision-${brief.id}`, 'revision', generatorSeat, { briefId: brief.id });
  }
  // Transfer: one provisional treatment/control pair.
  pushStage('transfer-treatment', 'transfer-treatment', generatorSeat);
  pushStage('transfer-control', 'transfer-control', generatorSeat);
  const expectedReviewIds = ownerReviewStageIds(manifest);
  if (manifest.requiredReviewStageIds.length !== expectedReviewIds.length
    || expectedReviewIds.some((id) => !manifest.requiredReviewStageIds.includes(id))) {
    throw new Error('Campaign owner review stages do not fund every specialist and holistic call');
  }
  // Required reviews: each candidate/role call has a frozen reviewer route.
  for (const reviewId of manifest.requiredReviewStageIds) {
    const seatId = reviewId.startsWith('specialist-review-') ? 'specialist-review'
      : reviewId.startsWith('holistic-review-') ? 'holistic-review' : reviewId;
    routeSeatFor(freeze, 'evaluator', seatId);
    pushStage(reviewId, 'review', seatId);
  }
  // Dream: exactly one campaign-scoped recommendation opportunity.
  pushStage('dream', 'dream', dreamSeat);
  // Reject unlisted extra stages.
  const canonicalKeys = new Set(stages.map(stageKey));
  for (const extra of extraStages) {
    if (extra.kind === 'review') {
      if (!manifest.requiredReviewStageIds.includes(extra.id)) {
        throw new Error(`Campaign execution stage ${extra.id} is outside the frozen topology`);
      }
      continue;
    }
    if (!canonicalKeys.has(stageKey(extra))) {
      throw new Error(`Campaign execution stage ${extra.id} is outside the frozen topology`);
    }
  }
  const routeFreezeDigest = computeRouteFreezeDigest(freeze);
  const body = {
    schema: 'sinter.campaign-execution-plan' as const,
    schemaVersion: 1 as const,
    manifestDigest: manifest.manifestDigest,
    campaignRunId: manifest.campaignRunId,
    routeFreeze: freeze,
    routeFreezeDigest,
    slotGraphDigests,
    stages,
  };
  const planDigest = digest(body);
  return deepFreeze({ ...body, planDigest });
}
