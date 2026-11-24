import { createHash } from 'node:crypto';
import type { CampaignManifest } from './CampaignManifest.js';
import {
  assertAuthenticAttributableRevision, resolveAuthenticRevisionArtifacts,
  type AttributableRevisionReceipt, type ExperimentPlan, type IndependentBlindTreatmentPreference,
} from './AttributableRevision.js';
import {
  hasIntactOwnerReviewPacketDigest, verifyOwnerReviewPacket,
  type CaptureAuthority, type EnvelopeAuthority, type OwnerPacketEnvelope, type OwnerReviewPacket,
} from './OwnerQualityReview.js';
import { resolveOwnerReviewClosureContext, type OwnerReviewClosureContext } from './OwnerReviewLifecycle.js';
import { hasIntactBlindReviewPacketDigest, type BlindReviewPacket } from './BlindReviewEvidence.js';
import {
  assertAuthenticOwnerDecisionReceipts,
  resolveCoordinatorOwnerClosureCheckpoint,
  type CoordinatorOwnerClosureCheckpoint, type PreferenceDecisionReceipt, type ReleaseDecisionReceipt,
} from './CreativeRunCoordinator.js';
import { DurableCampaignLearningAuthorizationLifecycle,
  type CampaignLearningAuthorizationAuthority,
  type CampaignLearningAuthorizationEvidence, type CampaignLearningAuthorizationExecution,
  type CampaignLearningAuthorizationScope, type CampaignLearningAuthorizationState,
  type CampaignLearningComparisonArm } from './CampaignLearningAuthorization.js';

export type { CampaignLearningAuthorizationEvidence, CampaignLearningAuthorizationExecution,
  CampaignLearningAuthorizationScope, CampaignLearningAuthorizationState,
  CampaignLearningComparisonArm } from './CampaignLearningAuthorization.js';

export type CampaignExperimentOutcome =
  | 'experiment-improved'
  | 'experiment-inconclusive'
  | 'experiment-regressed';

export type CampaignOwnerPreference = 'treatment-preferred' | 'baseline-preferred' | 'tie';
export type CampaignReleaseDecision = 'release-worthy' | 'not-release-worthy';

export interface CampaignClosureBinding {
  readonly manifestDigest: string;
  readonly campaignRunId: string;
}

/** The small persistence seam implemented by CampaignPersistence after #719 lands. */
export interface CampaignClosurePersistence {
  read(key: string): Promise<string | null>;
  write(key: string, data: string): Promise<void>;
  claim<T>(key: string, operation: () => Promise<T>): Promise<T>;
}

export interface CampaignRevisionEvidence {
  readonly id: string; readonly binding: CampaignClosureBinding; readonly briefId: string;
  readonly planDigest: string; readonly treatmentId: string; readonly baselineArtifactDigest: string;
  readonly comparisonBaselineArtifactDigest: string;
  readonly treatmentArtifactDigest: string; readonly revisedArtifactDigest: string;
  readonly revision: AttributableRevisionReceipt; readonly blindPreference: IndependentBlindTreatmentPreference;
  readonly signatureBase64: string; readonly evidenceDigest: string;
}

export interface CampaignOwnerDecisionEvidence {
  readonly id: string; readonly binding: CampaignClosureBinding; readonly briefId: string;
  /** Original three-candidate quality packet, atomically published before revision. */
  readonly originalQualityEnvelope: OwnerPacketEnvelope; readonly originalQualityPacket: OwnerReviewPacket;
  /** Fresh, exact two-arm baseline/treatment comparison packet. */
  readonly comparisonEnvelope: OwnerPacketEnvelope; readonly comparisonPacket: BlindReviewPacket;
  readonly planDigest: string; readonly sourceBlindPacketDigest: string;
  readonly baselineArtifactDigest: string; readonly comparisonBaselineArtifactDigest: string;
  readonly treatmentArtifactDigest: string; readonly preference: CampaignOwnerPreference;
  readonly release: CampaignReleaseDecision; readonly signatureBase64: string; readonly evidenceDigest: string;
  readonly preferenceReceipt: PreferenceDecisionReceipt; readonly releaseReceipt: ReleaseDecisionReceipt;
}

export interface CampaignClosureEvidenceAuthority extends CampaignLearningAuthorizationAuthority {
  resolveRevision(id: string): Promise<CampaignRevisionEvidence>;
  resolveOwnerDecision(id: string): Promise<CampaignOwnerDecisionEvidence>;
}
const BOOTSTRAPPED_CLOSURE_EVIDENCE_AUTHORITIES = new WeakSet<object>();
let activeClosureEvidenceAuthority: DurableCampaignClosureEvidenceRegistry | undefined;

export function assertAuthenticCampaignClosureEvidenceAuthority(
  authority: CampaignClosureEvidenceAuthority,
): CampaignClosureEvidenceAuthority {
  if (!BOOTSTRAPPED_CLOSURE_EVIDENCE_AUTHORITIES.has(authority)
    || authority !== activeClosureEvidenceAuthority) {
    throw new Error('CAMPAIGN_CLOSURE_EVIDENCE_AUTHORITY_PROVENANCE_INVALID');
  }
  return authority;
}

export interface CampaignBlindPreferenceReviewer {
  readonly role: 'specialist' | 'holistic';
  readonly provider: string;
  readonly model: string;
  readonly pipe: string;
  readonly effort: string;
  readonly contributionLineage: string;
  readonly assignment: string;
}

export interface CampaignBlindPreferenceEvidence {
  readonly planDigest: string;
  readonly treatmentArtifactDigest: string;
  readonly reviewer: CampaignBlindPreferenceReviewer;
  readonly outcome: CampaignOwnerPreference;
  readonly receiptDigest: string;
}

export function createCampaignBlindPreferenceEvidence(
  input: CampaignBlindPreferenceEvidence,
): CampaignBlindPreferenceEvidence {
  return Object.freeze({ ...input, reviewer: Object.freeze({ ...input.reviewer }) });
}

export interface CampaignRevisionOutcome {
  readonly planDigest: string;
  readonly receiptDigest: string;
  readonly outcome: CampaignExperimentOutcome;
  readonly improvementEstablished: boolean;
  readonly blindPreference: CampaignBlindPreferenceEvidence;
}

export interface CampaignRevisionSettlement {
  readonly stageId: string;
  readonly allocationId: string;
  readonly reservationDigest: string;
  readonly settlementDigest: string;
}

export interface CampaignOwnerTerminalDecision {
  readonly ownerPacketDigest: string;
  readonly preference: CampaignOwnerPreference;
  readonly release: CampaignReleaseDecision;
  readonly decisionDigest: string;
}

export function createCampaignOwnerTerminalDecision(input: Omit<CampaignOwnerTerminalDecision, 'decisionDigest'>): CampaignOwnerTerminalDecision {
  const body = { ...input };
  return Object.freeze({ ...body, decisionDigest: digest(body) });
}

export interface CampaignBriefClosureRecord {
  readonly binding: CampaignClosureBinding;
  readonly briefId: string;
  readonly revision: CampaignRevisionOutcome;
  readonly settlement: CampaignRevisionSettlement;
  readonly owner: CampaignOwnerTerminalDecision;
  readonly recordDigest: string;
}

export interface CampaignClosureReceipt {
  readonly binding: CampaignClosureBinding;
  readonly briefIds: readonly string[];
  readonly records: readonly CampaignBriefClosureRecord[];
  readonly improvedBriefCount: number;
  readonly ownerTreatmentPreferenceCount: number;
  readonly ownerReleaseWorthyCount: number;
  readonly status: 'passed' | 'durable-red';
  readonly reasons: readonly string[];
  readonly closureDigest: string;
}

const SHA256 = /^[a-f0-9]{64}$/;
const ARTIFACT_DIGEST = /^(?:[a-f0-9]{16}|[a-f0-9]{64})$/;
const EXPERIMENT_OUTCOMES: readonly CampaignExperimentOutcome[] = [
  'experiment-improved', 'experiment-inconclusive', 'experiment-regressed',
];
const OWNER_PREFERENCES: readonly CampaignOwnerPreference[] = [
  'treatment-preferred', 'baseline-preferred', 'tie',
];
const RELEASE_DECISIONS: readonly CampaignReleaseDecision[] = [
  'release-worthy', 'not-release-worthy',
];

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort()
      .filter(key => record[key] !== undefined)
      .map(key => `${JSON.stringify(key)}:${stable(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function digest(value: unknown): string {
  return createHash('sha256').update(stable(value)).digest('hex');
}

function receiptDigest(value: PreferenceDecisionReceipt | ReleaseDecisionReceipt): string {
  const { receiptDigest: _receiptDigest, ...body } = value;
  return createHash('sha256').update(JSON.stringify(body)).digest('hex');
}

function hasExactArtifactPair(
  candidates: readonly { readonly artifactDigest: string }[], baselineArtifactDigest: string,
  treatmentArtifactDigest: string,
): boolean {
  return baselineArtifactDigest !== treatmentArtifactDigest && candidates.length === 2
    && new Set(candidates.map((candidate) => candidate.artifactDigest)).size === 2
    && candidates.some((candidate) => candidate.artifactDigest === baselineArtifactDigest)
    && candidates.some((candidate) => candidate.artifactDigest === treatmentArtifactDigest);
}

/** @internal Exact two-arm mapping; rejected/tie never masquerade as baseline preference. */
export function deriveCampaignOwnerPreference(
  preference: Pick<PreferenceDecisionReceipt, 'outcome' | 'winnerBlindId' | 'candidates'>,
  baselineArtifactDigest: string,
  treatmentArtifactDigest: string,
): CampaignOwnerPreference {
  if (!hasExactArtifactPair(preference.candidates, baselineArtifactDigest, treatmentArtifactDigest)) {
    throw new Error('CAMPAIGN_CLOSURE_OWNER_PREFERENCE_PAIR_INVALID');
  }
  if (preference.outcome !== 'preferred') return 'tie';
  const winner = preference.winnerBlindId
    ? preference.candidates.find((candidate) => candidate.blindId === preference.winnerBlindId) : undefined;
  if (winner?.artifactDigest === treatmentArtifactDigest) return 'treatment-preferred';
  if (winner?.artifactDigest === baselineArtifactDigest) return 'baseline-preferred';
  throw new Error('CAMPAIGN_CLOSURE_OWNER_PREFERENCE_PAIR_INVALID');
}

function evidenceKey(kind: 'revision' | 'owner', id: string): string {
  return `campaign-closure:evidence:${kind}:${id}`;
}

function evidenceBody<T extends { readonly signatureBase64: string; readonly evidenceDigest: string }>(value: T) {
  const { signatureBase64: _signature, evidenceDigest: _digest, ...body } = value;
  return body;
}

/**
 * Host-owned evidence registry. It is the only bridge from in-process
 * attributable receipts to restart-verifiable, signed closure evidence.
 */
export class DurableCampaignClosureEvidenceRegistry implements CampaignClosureEvidenceAuthority {
  private readonly learningLifecycle: DurableCampaignLearningAuthorizationLifecycle;
  /**
   * Live-only capability handoff for the next owner comparison. Durable
   * evidence deliberately contains no serializable authority substitute, so a
   * restarted host can replay closure records but cannot mint a new review
   * session from caller-provided JSON.
   */
  private readonly authenticRevisionInputs = new Map<string, Readonly<{
    readonly plan: ExperimentPlan;
    readonly revision: AttributableRevisionReceipt;
    readonly blindPreference: IndependentBlindTreatmentPreference;
  }>>();

  constructor(private readonly persistence: CampaignClosurePersistence,
    private readonly envelopeAuthority: EnvelopeAuthority,
    private readonly captureAuthority: CaptureAuthority) {
    this.learningLifecycle = new DurableCampaignLearningAuthorizationLifecycle(persistence, envelopeAuthority);
  }

  async sealRevision(input: { readonly id: string; readonly binding: CampaignClosureBinding;
    readonly briefId: string; readonly plan: ExperimentPlan; readonly revision: AttributableRevisionReceipt;
    readonly blindPreference: IndependentBlindTreatmentPreference }): Promise<CampaignRevisionEvidence> {
    assertAuthenticAttributableRevision(input.plan, input.revision);
    const artifacts = resolveAuthenticRevisionArtifacts(input.plan, input.revision);
    if (input.revision.blindTreatmentPreferenceDigest !== input.blindPreference.receiptDigest
      || input.blindPreference.planDigest !== input.plan.planDigest
      || input.blindPreference.treatmentArtifactDigest !== artifacts.treatment.artifactDigest) {
      throw new Error('CAMPAIGN_CLOSURE_REVISION_ARTIFACT_BINDING_INVALID');
    }
    const unsigned = { id: input.id, binding: input.binding, briefId: input.briefId,
      planDigest: input.plan.planDigest, treatmentId: input.revision.treatmentId,
      // This source digest is the artifact identity published in the original
      // campaign-quality packet; the compact canonical digest stays separate.
      baselineArtifactDigest: artifacts.baseline.sourceArtifactDigest,
      comparisonBaselineArtifactDigest: artifacts.baseline.artifactDigest,
      treatmentArtifactDigest: artifacts.treatment.artifactDigest,
      revisedArtifactDigest: artifacts.treatment.artifactDigest, revision: input.revision,
      blindPreference: input.blindPreference };
    const evidence = Object.freeze({ ...unsigned, signatureBase64: this.envelopeAuthority.signReview(unsigned),
      evidenceDigest: digest(unsigned) });
    await this.putIfAbsent('revision', input.id, evidence);
    this.authenticRevisionInputs.set(input.id, Object.freeze({
      plan: input.plan, revision: input.revision, blindPreference: input.blindPreference,
    }));
    return evidence;
  }

  /**
   * Resolve the original in-process attributable receipts for the authenticated
   * comparison start. This is intentionally unavailable after a process
   * restart: persisted evidence is sufficient to replay a closeout, never to
   * reconstitute an owner-authority witness from untrusted transport data.
   */
  async resolveAuthenticRevisionDecisionInput(id: string): Promise<Readonly<{
    readonly plan: ExperimentPlan;
    readonly revision: AttributableRevisionReceipt;
    readonly blindPreference: IndependentBlindTreatmentPreference;
  }>> {
    const input = this.authenticRevisionInputs.get(id);
    if (!input) throw new Error('CAMPAIGN_CLOSURE_REVISION_DECISION_INPUT_UNAVAILABLE');
    const evidence = await this.resolveRevision(id);
    if (evidence.planDigest !== input.plan.planDigest
      || evidence.revision.receiptDigest !== input.revision.receiptDigest
      || evidence.blindPreference.receiptDigest !== input.blindPreference.receiptDigest) {
      throw new Error('CAMPAIGN_CLOSURE_REVISION_DECISION_INPUT_INVALID');
    }
    assertAuthenticAttributableRevision(input.plan, input.revision);
    return input;
  }

  async sealOwnerDecision(input: { readonly id: string; readonly binding: CampaignClosureBinding;
    readonly briefId: string; readonly checkpoint: CoordinatorOwnerClosureCheckpoint;
    readonly originalOwnerReview: OwnerReviewClosureContext }): Promise<CampaignOwnerDecisionEvidence> {
    const existingRaw = await this.persistence.read(evidenceKey('owner', input.id));
    if (existingRaw) {
      const existing = await this.resolveOwnerDecision(input.id);
      if (stable(existing.binding) !== stable(input.binding) || existing.briefId !== input.briefId) {
        throw new Error('CAMPAIGN_CLOSURE_EVIDENCE_IMMUTABLE');
      }
      return existing;
    }
    const owner = resolveCoordinatorOwnerClosureCheckpoint(input.checkpoint);
    assertAuthenticOwnerDecisionReceipts(owner.authority, owner.preferenceReceipt, owner.releaseReceipt);
    const artifacts = resolveAuthenticRevisionArtifacts(owner.plan, owner.revision);
    const baselineArtifactDigest = artifacts.baseline.sourceArtifactDigest;
    const comparisonBaselineArtifactDigest = artifacts.baseline.artifactDigest;
    const treatmentArtifactDigest = artifacts.treatment.artifactDigest;
    const preference = deriveCampaignOwnerPreference(
      owner.preferenceReceipt, comparisonBaselineArtifactDigest, treatmentArtifactDigest,
    );
    const release = owner.releaseReceipt.decision;
    const comparisonPacket = owner.packet;
    const comparisonEnvelope = this.envelopeAuthority.seal({ campaignRunId: input.binding.campaignRunId,
      manifestDigest: input.binding.manifestDigest, briefId: input.briefId,
      blindPacketDigest: comparisonPacket.packetDigest, packetDigest: comparisonPacket.packetDigest });
    const originalContext = resolveOwnerReviewClosureContext(input.originalOwnerReview);
    const published = await originalContext.store.readPublished?.(input.briefId);
    if (!published) throw new Error('CAMPAIGN_CLOSURE_ORIGINAL_PACKET_NOT_PUBLISHED');
    const { packet: originalQualityPacket, envelope: originalQualityEnvelope } = published;
    if (!this.envelopeAuthority.verify(comparisonEnvelope).valid
      || !this.envelopeAuthority.verify(originalQualityEnvelope).valid
      || originalContext.briefId !== input.briefId || originalContext.packetDigest !== originalQualityPacket.packetDigest
      || !hasIntactBlindReviewPacketDigest(comparisonPacket) || comparisonPacket.candidates.length !== 2
      || originalQualityPacket.briefId !== input.briefId || originalQualityPacket.candidates.length !== 3
      || originalQualityEnvelope.campaignRunId !== input.binding.campaignRunId
      || originalQualityEnvelope.manifestDigest !== input.binding.manifestDigest || originalQualityEnvelope.briefId !== input.briefId
      || originalQualityEnvelope.packetDigest !== originalQualityPacket.packetDigest
      || originalQualityEnvelope.blindPacketDigest !== originalQualityPacket.blindPacketDigest
      || owner.plan.packetDigest !== originalQualityPacket.blindPacketDigest
      || !hasIntactOwnerReviewPacketDigest(originalQualityPacket)
      || !verifyOwnerReviewPacket(originalQualityPacket, this.captureAuthority).conclusive
      || originalQualityPacket.ownerDecisions.preference !== null
      || originalQualityPacket.ownerDecisions.releaseWorthiness !== null
      || comparisonEnvelope.campaignRunId !== input.binding.campaignRunId
      || comparisonEnvelope.manifestDigest !== input.binding.manifestDigest || comparisonEnvelope.briefId !== input.briefId
      || comparisonEnvelope.packetDigest !== comparisonPacket.packetDigest || comparisonEnvelope.blindPacketDigest !== comparisonPacket.packetDigest
      || !originalQualityPacket.candidates.some((candidate) => candidate.artifactDigest === baselineArtifactDigest)
      || owner.preferenceReceipt.packetDigest !== comparisonPacket.packetDigest
      || owner.releaseReceipt.packetDigest !== comparisonPacket.packetDigest
      || owner.releaseReceipt.artifactDigest !== treatmentArtifactDigest
      || owner.preferenceReceipt.receiptDigest !== receiptDigest(owner.preferenceReceipt)
      || owner.releaseReceipt.receiptDigest !== receiptDigest(owner.releaseReceipt)
      || owner.preferenceReceipt.authorityRegistryId !== owner.releaseReceipt.authorityRegistryId
      || owner.preferenceReceipt.applicationBoundary !== owner.releaseReceipt.applicationBoundary
      || !hasExactArtifactPair(owner.preferenceReceipt.candidates, comparisonBaselineArtifactDigest, treatmentArtifactDigest)
      || !hasExactArtifactPair(comparisonPacket.candidates, comparisonBaselineArtifactDigest, treatmentArtifactDigest)
      || (owner.preferenceReceipt.outcome === 'preferred' && !owner.preferenceReceipt.winnerBlindId)) {
      throw new Error('CAMPAIGN_CLOSURE_OWNER_EVIDENCE_INVALID');
    }
    const unsigned = { id: input.id, binding: input.binding, briefId: input.briefId,
      originalQualityEnvelope, originalQualityPacket, comparisonEnvelope, comparisonPacket,
      planDigest: owner.plan.planDigest, sourceBlindPacketDigest: originalQualityPacket.blindPacketDigest,
      baselineArtifactDigest, comparisonBaselineArtifactDigest, treatmentArtifactDigest,
      preference, release, preferenceReceipt: owner.preferenceReceipt, releaseReceipt: owner.releaseReceipt };
    const evidence = Object.freeze({ ...unsigned, signatureBase64: this.envelopeAuthority.signReview(unsigned),
      evidenceDigest: digest(unsigned) });
    await this.putIfAbsent('owner', input.id, evidence);
    return evidence;
  }

  sealLearningAuthorization(...args: Parameters<CampaignLearningAuthorizationAuthority['sealLearningAuthorization']>) {
    return this.learningLifecycle.sealLearningAuthorization(...args);
  }

  async resolveRevision(id: string): Promise<CampaignRevisionEvidence> {
    return this.resolve('revision', id) as Promise<CampaignRevisionEvidence>;
  }

  async resolveOwnerDecision(id: string): Promise<CampaignOwnerDecisionEvidence> {
    return this.resolve('owner', id) as Promise<CampaignOwnerDecisionEvidence>;
  }

  async resolveLearningAuthorization(id: string): Promise<CampaignLearningAuthorizationEvidence> {
    return this.learningLifecycle.resolveLearningAuthorization(id);
  }

  async resolveLearningAuthorizationState(id: string): Promise<CampaignLearningAuthorizationState> {
    return this.learningLifecycle.resolveLearningAuthorizationState(id);
  }

  /** Read-only preflight; provider work must use begin + per-arm resolution. */
  async resolveActiveLearningAuthorization(id: string, scope: CampaignLearningAuthorizationScope):
    Promise<CampaignLearningAuthorizationEvidence> {
    return this.learningLifecycle.resolveActiveLearningAuthorization(id, scope);
  }

  async beginLearningAuthorizationExecution(id: string, input: CampaignLearningAuthorizationScope & {
    readonly executionId: string }): Promise<CampaignLearningAuthorizationExecution> {
    return this.learningLifecycle.beginLearningAuthorizationExecution(id, input);
  }

  async resolveLearningAuthorizationExecution(id: string, execution: CampaignLearningAuthorizationExecution,
    now: string): Promise<CampaignLearningAuthorizationEvidence>;
  async resolveLearningAuthorizationExecution(id: string, execution: CampaignLearningAuthorizationExecution,
    arm: CampaignLearningComparisonArm, now: string): Promise<CampaignLearningAuthorizationEvidence>;
  async resolveLearningAuthorizationExecution(id: string, execution: CampaignLearningAuthorizationExecution,
    armOrNow: CampaignLearningComparisonArm | string, now?: string): Promise<CampaignLearningAuthorizationEvidence> {
    if (now) return this.learningLifecycle.resolveLearningAuthorizationExecution(
      id, execution, armOrNow as CampaignLearningComparisonArm, now,
    );
    return this.learningLifecycle.resolveLearningAuthorizationExecution(id, execution, armOrNow);
  }

  async consumeLearningAuthorization(id: string): Promise<CampaignLearningAuthorizationState> {
    return this.learningLifecycle.consumeLearningAuthorization(id);
  }

  async revokeLearningAuthorization(id: string): Promise<CampaignLearningAuthorizationState> {
    return this.learningLifecycle.revokeLearningAuthorization(id);
  }

  async commitLearningAuthorizationExecution(id: string, execution: CampaignLearningAuthorizationExecution,
    now: string): Promise<CampaignLearningAuthorizationState> {
    return this.learningLifecycle.commitLearningAuthorizationExecution(id, execution, now);
  }

  async abortLearningAuthorizationExecution(id: string, execution: CampaignLearningAuthorizationExecution):
    Promise<CampaignLearningAuthorizationState> {
    return this.learningLifecycle.abortLearningAuthorizationExecution(id, execution);
  }

  private async putIfAbsent(kind: 'revision' | 'owner', id: string,
    value: CampaignRevisionEvidence | CampaignOwnerDecisionEvidence): Promise<void> {
    const key = evidenceKey(kind, id);
    await this.persistence.claim(key, async () => {
      const prior = await this.persistence.read(key);
      if (prior && stable(JSON.parse(prior)) !== stable(value)) throw new Error('CAMPAIGN_CLOSURE_EVIDENCE_IMMUTABLE');
      if (!prior) await this.persistence.write(key, JSON.stringify(value));
    });
  }

  private async resolve(kind: 'revision' | 'owner', id: string): Promise<CampaignRevisionEvidence | CampaignOwnerDecisionEvidence> {
    const raw = await this.persistence.read(evidenceKey(kind, id));
    if (!raw) throw new Error(`CAMPAIGN_CLOSURE_EVIDENCE_MISSING:${kind}:${id}`);
    const value = JSON.parse(raw) as CampaignRevisionEvidence | CampaignOwnerDecisionEvidence;
    const body = evidenceBody(value);
    if (value.id !== id || value.evidenceDigest !== digest(body)
      || !this.envelopeAuthority.verifyReview(body, value.signatureBase64)) {
      throw new Error('CAMPAIGN_CLOSURE_EVIDENCE_SIGNATURE_INVALID');
    }
    if (kind === 'owner') this.assertResolvedOwnerDecision(value as CampaignOwnerDecisionEvidence);
    return Object.freeze(value);
  }

  private assertResolvedOwnerDecision(value: CampaignOwnerDecisionEvidence): void {
    let expectedPreference: CampaignOwnerPreference | undefined;
    try {
      expectedPreference = deriveCampaignOwnerPreference(value.preferenceReceipt,
        value.comparisonBaselineArtifactDigest, value.treatmentArtifactDigest);
    } catch {
      expectedPreference = undefined;
    }
    if (!hasIntactBlindReviewPacketDigest(value.comparisonPacket) || value.comparisonPacket.candidates.length !== 2
      || value.originalQualityPacket.candidates.length !== 3
      || !this.envelopeAuthority.verify(value.originalQualityEnvelope).valid
      || !this.envelopeAuthority.verify(value.comparisonEnvelope).valid
      || value.originalQualityEnvelope.campaignRunId !== value.binding.campaignRunId
      || value.originalQualityEnvelope.manifestDigest !== value.binding.manifestDigest
      || value.originalQualityEnvelope.briefId !== value.briefId
      || value.originalQualityPacket.briefId !== value.briefId
      || value.sourceBlindPacketDigest !== value.originalQualityPacket.blindPacketDigest
      || value.comparisonEnvelope.campaignRunId !== value.binding.campaignRunId
      || value.comparisonEnvelope.manifestDigest !== value.binding.manifestDigest
      || value.comparisonEnvelope.briefId !== value.briefId
      || value.originalQualityEnvelope.packetDigest !== value.originalQualityPacket.packetDigest
      || value.originalQualityEnvelope.blindPacketDigest !== value.originalQualityPacket.blindPacketDigest
      || value.comparisonEnvelope.packetDigest !== value.comparisonPacket.packetDigest
      || value.comparisonEnvelope.blindPacketDigest !== value.comparisonPacket.packetDigest
      || !hasIntactOwnerReviewPacketDigest(value.originalQualityPacket)
      || !verifyOwnerReviewPacket(value.originalQualityPacket, this.captureAuthority).conclusive
      || value.originalQualityPacket.ownerDecisions.preference !== null
      || value.originalQualityPacket.ownerDecisions.releaseWorthiness !== null
      || !value.originalQualityPacket.candidates.some((candidate) => candidate.artifactDigest === value.baselineArtifactDigest)
      || value.preferenceReceipt.receiptDigest !== receiptDigest(value.preferenceReceipt)
      || value.releaseReceipt.receiptDigest !== receiptDigest(value.releaseReceipt)
      || value.preferenceReceipt.packetDigest !== value.comparisonPacket.packetDigest
      || value.releaseReceipt.packetDigest !== value.comparisonPacket.packetDigest
      || value.preferenceReceipt.owner.id !== value.releaseReceipt.owner.id
      || value.preferenceReceipt.owner.assertionDigest !== value.releaseReceipt.owner.assertionDigest
      || value.preferenceReceipt.authorityRegistryId !== value.releaseReceipt.authorityRegistryId
      || value.preferenceReceipt.applicationBoundary !== value.releaseReceipt.applicationBoundary
      || value.releaseReceipt.artifactDigest !== value.treatmentArtifactDigest
      || !hasExactArtifactPair(value.preferenceReceipt.candidates, value.comparisonBaselineArtifactDigest, value.treatmentArtifactDigest)
      || !hasExactArtifactPair(value.comparisonPacket.candidates, value.comparisonBaselineArtifactDigest, value.treatmentArtifactDigest)
      || value.preference !== expectedPreference) {
      throw new Error('CAMPAIGN_CLOSURE_OWNER_EVIDENCE_INVALID');
    }
  }
}

export interface CampaignClosureEvidenceBootstrapOptions {
  readonly persistence: CampaignClosurePersistence;
  readonly envelopeAuthority: EnvelopeAuthority;
  readonly captureAuthority: CaptureAuthority;
}

/**
 * Install the single host-owned durable closure authority at the composition
 * root. Direct construction is intentionally not a closure capability.
 */
export function bootstrapCampaignClosureEvidenceAuthority(
  options: CampaignClosureEvidenceBootstrapOptions,
): CampaignClosureEvidenceAuthority {
  if (process.env.NODE_ENV !== 'test' && activeClosureEvidenceAuthority) {
    throw new Error('CAMPAIGN_CLOSURE_EVIDENCE_AUTHORITY_ALREADY_BOOTSTRAPPED');
  }
  const authority = new DurableCampaignClosureEvidenceRegistry(
    options.persistence, options.envelopeAuthority, options.captureAuthority,
  );
  BOOTSTRAPPED_CLOSURE_EVIDENCE_AUTHORITIES.add(authority);
  activeClosureEvidenceAuthority = authority;
  return authority;
}

/** Resolve only the host-installed registry; structural or subclass fakes fail closed. */
export function resolveRuntimeCampaignClosureEvidenceAuthority(
  explicit?: CampaignClosureEvidenceAuthority,
): CampaignClosureEvidenceAuthority | undefined {
  if (!explicit) return activeClosureEvidenceAuthority;
  return assertAuthenticCampaignClosureEvidenceAuthority(explicit);
}

function requireText(value: string, code: string): void {
  if (!value.trim()) throw new Error(code);
}

function requireDigest(value: string, code: string): void {
  if (!SHA256.test(value)) throw new Error(code);
}

/** Candidate manifests retain legacy full-byte digests while attributable revisions use canonical 16-hex artifact IDs. */
function requireArtifactDigest(value: string, code: string): void {
  if (!ARTIFACT_DIGEST.test(value)) throw new Error(code);
}

function requireMember<T extends string>(value: string, values: readonly T[], code: string): asserts value is T {
  if (!values.includes(value as T)) throw new Error(code);
}

function assertBinding(binding: CampaignClosureBinding): void {
  requireText(binding.campaignRunId, 'CAMPAIGN_CLOSURE_RUN_REQUIRED');
  requireDigest(binding.manifestDigest, 'CAMPAIGN_CLOSURE_MANIFEST_DIGEST_INVALID');
}

function outcomeKey(binding: CampaignClosureBinding, briefId: string): string {
  return `campaign-closure:outcome:${binding.manifestDigest}:${binding.campaignRunId}:${briefId}`;
}

function closureKey(binding: CampaignClosureBinding): string {
  return `campaign-closure:receipt:${binding.manifestDigest}:${binding.campaignRunId}`;
}

function recordBody(record: CampaignBriefClosureRecord): Omit<CampaignBriefClosureRecord, 'recordDigest'> {
  const { recordDigest: _digest, ...body } = record;
  return body;
}

function closureBody(receipt: CampaignClosureReceipt): Omit<CampaignClosureReceipt, 'closureDigest'> {
  const { closureDigest: _digest, ...body } = receipt;
  return body;
}

function validateRecord(record: CampaignBriefClosureRecord, binding: CampaignClosureBinding, briefId: string): void {
  if (stable(record.binding) !== stable(binding) || record.briefId !== briefId
    || record.recordDigest !== digest(recordBody(record))) {
    throw new Error('CAMPAIGN_CLOSURE_RECORD_TAMPERED');
  }
  if (record.settlement.stageId !== `revision-${briefId}`) {
    throw new Error('CAMPAIGN_CLOSURE_REVISION_STAGE_MISMATCH');
  }
  requireText(record.settlement.allocationId, 'CAMPAIGN_CLOSURE_ALLOCATION_REQUIRED');
  requireDigest(record.settlement.reservationDigest, 'CAMPAIGN_CLOSURE_RESERVATION_DIGEST_INVALID');
  requireDigest(record.settlement.settlementDigest, 'CAMPAIGN_CLOSURE_SETTLEMENT_DIGEST_INVALID');
  requireDigest(record.revision.planDigest, 'CAMPAIGN_CLOSURE_PLAN_DIGEST_INVALID');
  requireDigest(record.revision.receiptDigest, 'CAMPAIGN_CLOSURE_REVISION_RECEIPT_INVALID');
  requireMember(record.revision.outcome, EXPERIMENT_OUTCOMES, 'CAMPAIGN_CLOSURE_OUTCOME_INVALID');
  if (record.revision.improvementEstablished !== (record.revision.outcome === 'experiment-improved')) {
    throw new Error('CAMPAIGN_CLOSURE_OUTCOME_INCONSISTENT');
  }
  const preference = record.revision.blindPreference;
  requireMember(preference.outcome, OWNER_PREFERENCES, 'CAMPAIGN_CLOSURE_BLIND_PREFERENCE_OUTCOME_INVALID');
  if (preference.reviewer.role !== 'specialist' && preference.reviewer.role !== 'holistic') {
    throw new Error('CAMPAIGN_CLOSURE_BLIND_REVIEWER_ROLE_INVALID');
  }
  for (const field of ['provider', 'model', 'pipe', 'effort', 'contributionLineage', 'assignment'] as const) {
    requireText(preference.reviewer[field], 'CAMPAIGN_CLOSURE_BLIND_REVIEWER_INCOMPLETE');
  }
  if (preference.planDigest !== record.revision.planDigest
    || preference.receiptDigest !== createHash('sha256').update(JSON.stringify({
      planDigest: preference.planDigest,
      treatmentArtifactDigest: preference.treatmentArtifactDigest,
      reviewer: preference.reviewer,
      outcome: preference.outcome,
    })).digest('hex')) {
    throw new Error('CAMPAIGN_CLOSURE_BLIND_PREFERENCE_INVALID');
  }
  requireArtifactDigest(preference.treatmentArtifactDigest, 'CAMPAIGN_CLOSURE_EVIDENCE_DIGEST_INVALID');
  for (const value of [preference.receiptDigest, record.owner.ownerPacketDigest, record.owner.decisionDigest]) {
    requireDigest(value, 'CAMPAIGN_CLOSURE_EVIDENCE_DIGEST_INVALID');
  }
  if (record.owner.decisionDigest !== digest({
    ownerPacketDigest: record.owner.ownerPacketDigest,
    preference: record.owner.preference,
    release: record.owner.release,
  })) throw new Error('CAMPAIGN_CLOSURE_OWNER_DECISION_INVALID');
  requireMember(record.owner.preference, OWNER_PREFERENCES, 'CAMPAIGN_CLOSURE_OWNER_PREFERENCE_INVALID');
  requireMember(record.owner.release, RELEASE_DECISIONS, 'CAMPAIGN_CLOSURE_OWNER_RELEASE_INVALID');
}

function parseRecord(raw: string | null, binding: CampaignClosureBinding, briefId: string): CampaignBriefClosureRecord | null {
  if (!raw) return null;
  const record = JSON.parse(raw) as CampaignBriefClosureRecord;
  validateRecord(record, binding, briefId);
  return record;
}

function validateClosure(
  receipt: CampaignClosureReceipt,
  binding: CampaignClosureBinding,
  briefIds: readonly [string, string, string],
): void {
  if (stable(receipt.binding) !== stable(binding)
    || receipt.briefIds.join('|') !== briefIds.join('|')
    || receipt.records.length !== 3
    || receipt.closureDigest !== digest(closureBody(receipt))) {
    throw new Error('CAMPAIGN_CLOSURE_RECEIPT_TAMPERED');
  }
  for (const [index, briefId] of briefIds.entries()) {
    const record = receipt.records[index];
    if (!record) throw new Error('CAMPAIGN_CLOSURE_RECEIPT_TAMPERED');
    validateRecord(record, binding, briefId);
  }
  const improvedBriefCount = receipt.records.filter(record => record.revision.outcome === 'experiment-improved').length;
  const ownerTreatmentPreferenceCount = receipt.records.filter(record => record.owner.preference === 'treatment-preferred').length;
  const ownerReleaseWorthyCount = receipt.records.filter(record => record.owner.release === 'release-worthy').length;
  const reasons = [
    ...(improvedBriefCount >= 2 ? [] : ['fewer-than-two-briefs-improved']),
    ...(ownerTreatmentPreferenceCount === 3 ? [] : ['owner-treatment-preference-gate-failed']),
    ...(ownerReleaseWorthyCount === 3 ? [] : ['owner-release-worthiness-gate-failed']),
  ];
  if (receipt.improvedBriefCount !== improvedBriefCount
    || receipt.ownerTreatmentPreferenceCount !== ownerTreatmentPreferenceCount
    || receipt.ownerReleaseWorthyCount !== ownerReleaseWorthyCount
    || receipt.status !== (reasons.length === 0 ? 'passed' : 'durable-red')
    || stable(receipt.reasons) !== stable(reasons)) {
    throw new Error('CAMPAIGN_CLOSURE_RECEIPT_INCONSISTENT');
  }
}

/**
 * Immutable, restart-safe campaign closure ledger. It intentionally stores owner
 * decisions beside (not inside) the immutable owner packet from #719.
 */
export class CampaignClosureLedger {
  constructor(
    private readonly binding: CampaignClosureBinding,
    private readonly briefIds: readonly [string, string, string],
    private readonly persistence: CampaignClosurePersistence,
  ) {
    assertBinding(binding);
    if (new Set(briefIds).size !== 3 || briefIds.some(briefId => !briefId.trim())) {
      throw new Error('CAMPAIGN_CLOSURE_REQUIRES_THREE_DISTINCT_BRIEFS');
    }
  }

  async record(input: Omit<CampaignBriefClosureRecord, 'binding' | 'recordDigest'>): Promise<CampaignBriefClosureRecord> {
    if (!this.briefIds.includes(input.briefId)) throw new Error('CAMPAIGN_CLOSURE_BRIEF_OUTSIDE_MANIFEST');
    const body = { binding: this.binding, ...input };
    const record = Object.freeze({ ...body, recordDigest: digest(body) });
    validateRecord(record, this.binding, input.briefId);
    const key = outcomeKey(this.binding, input.briefId);
    return this.persistence.claim(key, async () => {
      const existing = parseRecord(await this.persistence.read(key), this.binding, input.briefId);
      if (existing) {
        if (stable(existing) !== stable(record)) throw new Error('CAMPAIGN_CLOSURE_OUTCOME_IMMUTABLE');
        return existing;
      }
      await this.persistence.write(key, `${JSON.stringify(record)}\n`);
      return record;
    });
  }

  async close(): Promise<CampaignClosureReceipt> {
    const key = closureKey(this.binding);
    return this.persistence.claim(key, async () => {
      const existingRaw = await this.persistence.read(key);
      if (existingRaw) {
        const existing = JSON.parse(existingRaw) as CampaignClosureReceipt;
        validateClosure(existing, this.binding, this.briefIds);
        return existing;
      }
      const records = await Promise.all(this.briefIds.map(async (briefId) => {
        const record = parseRecord(await this.persistence.read(outcomeKey(this.binding, briefId)), this.binding, briefId);
        if (!record) throw new Error(`CAMPAIGN_CLOSURE_BRIEF_NOT_TERMINAL:${briefId}`);
        return record;
      }));
      const improvedBriefCount = records.filter(record => record.revision.outcome === 'experiment-improved').length;
      const ownerTreatmentPreferenceCount = records.filter(record => record.owner.preference === 'treatment-preferred').length;
      const ownerReleaseWorthyCount = records.filter(record => record.owner.release === 'release-worthy').length;
      const reasons = [
        ...(improvedBriefCount >= 2 ? [] : ['fewer-than-two-briefs-improved']),
        ...(ownerTreatmentPreferenceCount === 3 ? [] : ['owner-treatment-preference-gate-failed']),
        ...(ownerReleaseWorthyCount === 3 ? [] : ['owner-release-worthiness-gate-failed']),
      ];
      const body = {
        binding: this.binding, briefIds: [...this.briefIds], records,
        improvedBriefCount, ownerTreatmentPreferenceCount, ownerReleaseWorthyCount,
        status: reasons.length === 0 ? 'passed' as const : 'durable-red' as const,
        reasons,
      };
      const receipt = Object.freeze({ ...body, closureDigest: digest(body) });
      await this.persistence.write(key, `${JSON.stringify(receipt)}\n`);
      return receipt;
    });
  }
}

/** Durable three-brief outcome/closure ledger keyed by manifest digest and run ID. */
export class DurableCampaignClosureLedger extends CampaignClosureLedger {
  constructor(manifest: CampaignManifest, persistence: CampaignClosurePersistence) {
    if (manifest.briefs.length !== 3) throw new Error('CAMPAIGN_CLOSURE_REQUIRES_THREE_BRIEFS');
    super({ manifestDigest: manifest.manifestDigest, campaignRunId: manifest.campaignRunId },
      [manifest.briefs[0]!.id, manifest.briefs[1]!.id, manifest.briefs[2]!.id], persistence);
  }
}
