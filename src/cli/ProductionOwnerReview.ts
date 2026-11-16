import { createHash, createPrivateKey } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { BlindReviewJudgment, CandidateEvidenceAssignment } from '../creative-run/BlindReviewEvidence.js';
import type { CreativeThesis } from '../creative-intelligence/CreativeIntelligence.js';
import { validateCreativeThesis } from '../creative-intelligence/CreativeIntelligence.js';
import { buildCrossModalArtifact } from '../creative-intelligence/CrossModalArtifact.js';
import { captureOwnerEvidence, createProductionOwnerCaptureRenderer, ownerCaptureFromRender,
  type OwnerCaptureRenderer, type OwnerCapturedEvidence, type OwnerCaptures } from './OwnerReviewCapture.js';
import type { CampaignExecutionPlan, CampaignManifest } from '../creative-run/CampaignManifest.js';
import type { CampaignRunAdmission } from '../creative-run/CreativeRunCoordinatorBase.js';
import type { CampaignFundingAllocation } from '../creative-run/CampaignExecutionAuthority.js';
import {
  campaignActualSource,
  campaignCreativeThesisDigest,
  type CampaignActualCandidateManifest,
} from '../creative-run/CandidateHypothesisProduction.js';
import type { CampaignService } from '../creative-run/CampaignService.js';
import { FileCampaignLedgerPersistence } from '../creative-run/CampaignPersistence.js';
import {
  bootstrapCampaignClosureEvidenceAuthority,
  type CampaignClosureEvidenceAuthority,
} from '../creative-run/CampaignClosure.js';
import {
  createCaptureAuthority, createEnvelopeAuthority,
  type OwnerCaptureInputs, type OwnerPacketEnvelope, type OwnerReviewHandle,
  type OwnerReviewPacket, type OwnerReviewPacketRenderer, type OwnerReviewPacketStore,
} from '../creative-run/OwnerQualityReview.js';
import type { OwnerReviewLifecycleInput } from '../creative-run/OwnerReviewLifecycle.js';
import { createBlindReviewSession } from '../creative-run/BlindReviewEvidence.js';
import { writeFileAtomic } from '../utils/atomicWrite.js';

export const PRODUCTION_OWNER_REVIEW_PACKAGE_SCHEMA = 'sinter.owner-review-package' as const;

export type ProductionCandidateEvidenceAssignment =
  Omit<CandidateEvidenceAssignment, 'generationIdentity' | 'sourceCandidateArtifactDigest'> & {
    /** Artifact identity and executor identity are derived after generation. */
    readonly sourceCandidateArtifactDigest?: never;
    readonly generationIdentity?: never;
  };

export type DerivedProductionCandidateEvidenceAssignment =
  Omit<ProductionCandidateEvidenceAssignment, 'crossModalArtifact'> & {
    /** Frozen thesis. Timing evidence is planned from it; the candidate is not run. */
    readonly creativeThesis: CreativeThesis;
    readonly crossModalArtifact?: never;
  };

export type ProductionOwnerCaptureInputs = Omit<OwnerCaptureInputs, 'source'> & {
  /** Exact generated source is derived from the settled candidate artifact. */
  readonly source?: never;
};

export interface ProductionOwnerReviewPackage {
  readonly schema: typeof PRODUCTION_OWNER_REVIEW_PACKAGE_SCHEMA;
  readonly schemaVersion: 1 | 2;
  readonly plan: CampaignExecutionPlan;
  readonly reviews: readonly {
    readonly briefId: string;
    readonly assignments: readonly (ProductionCandidateEvidenceAssignment
      | DerivedProductionCandidateEvidenceAssignment)[];
    readonly evidence?: readonly ProductionOwnerCaptureInputs[];
    readonly evidenceJudgments?: readonly BlindReviewJudgment[];
    readonly rendererFilePath: string;
  }[];
  readonly captureKey: { readonly keyId: string; readonly privateKeyPath: string };
  readonly envelopeKey: { readonly keyId: string; readonly privateKeyPath: string };
  readonly storeDirectory: string;
}

export interface PreparedProductionOwnerReview {
  readonly plan: CampaignExecutionPlan;
  readonly briefIds: readonly string[];
  /** Uses the same host keys, packet store, and durable root as owner review. */
  createClosureEvidenceAuthority(): CampaignClosureEvidenceAuthority;
  assertManifestCoverage(manifest: CampaignManifest): void;
  /** Renders every candidate's own HTML so `buildInputs` can seal what it did. */
  captureEvidence(candidates: readonly CampaignActualCandidateManifest[],
    renderer?: OwnerCaptureRenderer): Promise<OwnerCaptures>;
  /** `captured` comes from `captureEvidence`; a candidate missing from it is sealed as not observed. */
  buildInputs(service: CampaignService, admission: CampaignRunAdmission,
    manifest: CampaignManifest,
    candidates: readonly CampaignActualCandidateManifest[],
    captured?: OwnerCaptures): readonly OwnerReviewLifecycleInput[];
}

class FileOwnerReviewPacketStore implements OwnerReviewPacketStore {
  private readonly persistence: FileCampaignLedgerPersistence;

  constructor(directory: string) {
    this.persistence = new FileCampaignLedgerPersistence(directory);
  }

  async read(briefId: string): Promise<OwnerReviewPacket | null> {
    const raw = await this.persistence.read(briefId);
    if (!raw) return null;
    const value = JSON.parse(raw) as OwnerReviewPacket | { readonly packet: OwnerReviewPacket };
    return 'packet' in value ? value.packet : value;
  }

  async readPublished(briefId: string) {
    const raw = await this.persistence.read(briefId);
    if (!raw) return null;
    const value = JSON.parse(raw) as { readonly packet?: OwnerReviewPacket; readonly envelope?: OwnerPacketEnvelope };
    return value.packet && value.envelope ? { packet: value.packet, envelope: value.envelope } : null;
  }

  async putPublishedIfAbsent(envelope: OwnerPacketEnvelope, packet: OwnerReviewPacket) {
    return this.persistence.claim(packet.briefId, async () => {
      const current = await this.read(packet.briefId);
      if (current) return { packet: current, created: false };
      await this.persistence.write(packet.briefId, `${JSON.stringify({ packet, envelope }, null, 2)}\n`);
      return { packet, created: true };
    });
  }

  async putIfAbsent(packet: OwnerReviewPacket) {
    return this.persistence.claim(packet.briefId, async () => {
      const raw = await this.persistence.read(packet.briefId);
      if (raw) return { packet: JSON.parse(raw) as OwnerReviewPacket, created: false };
      await this.persistence.write(packet.briefId, `${JSON.stringify(packet, null, 2)}\n`);
      return { packet, created: true };
    });
  }

  async compareAndSwap(briefId: string, expectedDigest: string | null, packet: OwnerReviewPacket) {
    return this.persistence.claim(briefId, async () => {
      const raw = await this.persistence.read(briefId);
      const current = raw ? JSON.parse(raw) as OwnerReviewPacket : null;
      if ((current?.packetDigest ?? null) !== expectedDigest) {
        throw new Error('OWNER_PACKET_COMPARE_AND_SWAP_CONFLICT');
      }
      await this.persistence.write(briefId, `${JSON.stringify(packet, null, 2)}\n`);
      return { packet, created: current === null };
    });
  }
}

class DurableOwnerReviewRenderer implements OwnerReviewPacketRenderer {
  constructor(private readonly filePath: string) {}

  async render(html: string): Promise<OwnerReviewHandle> {
    await writeFileAtomic(this.filePath, html);
    return Object.freeze({ url: pathToFileURL(this.filePath).href,
      close: () => Promise.resolve() });
  }

  close(): Promise<void> {
    return Promise.resolve();
  }
}

function requiredText(value: unknown, code: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(code);
  return value;
}

function readPrivateKey(filePath: string, code: string): string {
  try {
    const value = readFileSync(filePath, 'utf8');
    createPrivateKey(value);
    return value;
  } catch {
    throw new Error(code);
  }
}

function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function deriveCrossModalAssignment(
  assignment: DerivedProductionCandidateEvidenceAssignment,
  candidate: CampaignActualCandidateManifest['candidates'][number],
): CandidateEvidenceAssignment {
  const thesis = validateCreativeThesis(assignment.creativeThesis);
  if (campaignCreativeThesisDigest(thesis) !== candidate.thesisDigest) {
    throw new Error('OWNER_REVIEW_DERIVED_THESIS_MISMATCH');
  }
  const { creativeThesis: _creativeThesis, ...base } = assignment;
  return Object.freeze({ ...base,
    sourceCandidateArtifactDigest: candidate.artifact.artifactDigest,
    crossModalArtifact: buildCrossModalArtifact({
      brief: thesis.intendedExperienceMeaning,
      thesis,
      sourceCandidateArtifactDigest: candidate.artifact.artifactDigest,
    }),
  });
}

// Limitations reach the packet digest, the contact sheet and the CLI: short printable names only.
const MAX_LIMITATIONS = 64;
const LIMITATION_PATTERN = /^[^\p{Cc}]{1,200}$/u;
function validLimitations(value: unknown): boolean {
  return Array.isArray(value) && value.length <= MAX_LIMITATIONS
    && value.every((entry) => typeof entry === 'string' && LIMITATION_PATTERN.test(entry));
}

const NOT_OBSERVED = { infraUnavailable: true, candidateFailure: false, timingMs: 0 };

function observedCaptureInputs(
  candidate: CampaignActualCandidateManifest['candidates'][number],
  captured: OwnerCapturedEvidence | undefined,
  sealedAudioRequired: boolean,
): ProductionOwnerCaptureInputs {
  const { inputs, limitations } = captured ?? ownerCaptureFromRender(candidate.id, NOT_OBSERVED, null);
  return Object.freeze({
    ...inputs,
    knownFailures: inputs.knownFailures ?? [], hardFloorFailures: [],
    reviewLimitations: [
      ...(sealedAudioRequired ? ['model-review-audio-payload-withheld'] : []),
      ...limitations,
    ],
  });
}

function deriveEvidenceJudgments(
  session: ReturnType<typeof createBlindReviewSession>,
): readonly BlindReviewJudgment[] {
  return Object.freeze(session.packet.candidates.map((candidate) => {
    const claims = candidate.requiredModalities.flatMap((modality) => {
      const media = candidate.media.find((item) => item.modality === modality);
      return media ? [Object.freeze({ modality, artifactDigest: candidate.artifactDigest,
        evidenceDigest: media.digest,
        claim: `Canonical ${modality} evidence is present and bound to this candidate.` })] : [];
    });
    return Object.freeze({ blindId: candidate.blindId,
      outcome: candidate.missingModalities.length === 0 ? 'pass' as const : 'fail' as const,
      claims: Object.freeze(claims) });
  }));
}

/**
 * Generation provenance is host-owned. The external package may bind evidence
 * to a candidate artifact, but cannot name the executor that produced it.
 */
function generationIdentityFor(
  admission: CampaignRunAdmission,
  manifest: CampaignManifest,
  candidate: CampaignActualCandidateManifest['candidates'][number],
): NonNullable<CandidateEvidenceAssignment['generationIdentity']> {
  const brief = manifest.briefs.find((item) => item.id === candidate.briefId);
  const slot = brief?.candidateSlots.find((item) => item.id === candidate.id);
  if (!brief || !slot || candidate.slotDigest !== slot.ownerEvidence.slotDigest) {
    throw new Error('OWNER_REVIEW_GENERATION_CANDIDATE_BINDING_MISMATCH');
  }
  const stages = admission.plan.stages.filter((stage) => stage.kind === 'generation'
    && stage.briefId === candidate.briefId && stage.candidateSlotId === candidate.id);
  if (stages.length !== slot.graphNodeIds.length || stages.some((stage) => !stage.nodeId
    || !slot.graphNodeIds.includes(stage.nodeId))) {
    throw new Error('OWNER_REVIEW_GENERATION_STAGE_BINDING_MISMATCH');
  }
  const allocations = stages.map((stage) => {
    // Generation identity binds the primary (or stream) allocation — but a
    // retry/fallback allocation with a DIFFERENT identity/route/seat must not
    // be silently ignored: every generator allocation on the stage must agree,
    // else output from the divergent attempt could wear the primary identity
    // (Sol senior-review finding, 2026-08-26).
    const all = admission.fundingReservation.subject.allocations.filter((allocation) =>
      allocation.stageId === stage.id && allocation.role === 'generator');
    const matches = all.filter((allocation) =>
      allocation.purpose === 'primary' || allocation.purpose === 'stream');
    if (matches.length !== 1) throw new Error('OWNER_REVIEW_GENERATION_ALLOCATION_AMBIGUOUS');
    const primary = matches[0]!;
    const divergent = all.filter((allocation) =>
      allocation.identity.provider !== primary.identity.provider
      || allocation.identity.model !== primary.identity.model
      || allocation.identity.effort !== primary.identity.effort
      || allocation.routeDigest !== primary.routeDigest
      || allocation.seat.seatId !== primary.seat.seatId
      || allocation.seat.seatDigest !== primary.seat.seatDigest);
    if (divergent.length > 0) {
      throw new Error('OWNER_REVIEW_GENERATION_ATTEMPT_IDENTITY_DIVERGENT');
    }
    return primary;
  });
  const first = allocations[0];
  if (!first || allocations.some((allocation) => allocation.identity.provider !== first.identity.provider
    || allocation.identity.model !== first.identity.model || allocation.identity.effort !== first.identity.effort
    || allocation.routeDigest !== first.routeDigest)) {
    throw new Error('OWNER_REVIEW_GENERATION_IDENTITY_AMBIGUOUS');
  }
  const canonicalAllocations = allocations.map((allocation: CampaignFundingAllocation) => ({
    allocationId: allocation.allocationId, stageId: allocation.stageId,
    logicalAttemptId: allocation.logicalAttemptId, transportOrdinal: allocation.transportOrdinal,
    requestTemplateDigest: allocation.requestTemplateDigest, routeDigest: allocation.routeDigest,
    identity: allocation.identity, seat: allocation.seat, funding: allocation.funding,
  }));
  return Object.freeze({ role: 'generator', provider: first.identity.provider,
    model: first.identity.model, pipe: first.routeDigest, effort: first.identity.effort,
    contributionLineage: digest({ campaignRunId: manifest.campaignRunId,
      manifestDigest: manifest.manifestDigest, candidate: candidate.id, artifactDigest: candidate.artifact.artifactDigest,
      allocations: canonicalAllocations }),
    assignment: digest({ campaignRunId: manifest.campaignRunId, briefId: candidate.briefId,
      candidateSlotId: candidate.id, slotDigest: candidate.slotDigest,
      allocationIds: canonicalAllocations.map((allocation) => allocation.allocationId) }) });
}

/**
 * Convert the operator's plain-data package into a host-owned input factory.
 * All filesystem and shape checks happen here, before campaign admission or
 * generation. Opaque admissions and executable adapters are created later by
 * this closure, never deserialized from JSON.
 */
export function loadProductionOwnerReviewPackage(filePath: string): PreparedProductionOwnerReview {
  let parsed: ProductionOwnerReviewPackage;
  try {
    parsed = JSON.parse(readFileSync(filePath, 'utf8')) as ProductionOwnerReviewPackage;
  } catch {
    throw new Error('OWNER_REVIEW_PACKAGE_UNREADABLE');
  }
  if (parsed.schema !== PRODUCTION_OWNER_REVIEW_PACKAGE_SCHEMA
    || (parsed.schemaVersion !== 1 && parsed.schemaVersion !== 2))
    throw new Error('OWNER_REVIEW_PACKAGE_SCHEMA_INVALID');
  if (!parsed.plan || !Array.isArray(parsed.reviews) || parsed.reviews.length === 0)
    throw new Error('OWNER_REVIEW_PACKAGE_SHAPE_INVALID');
  const captureKeyId = requiredText(parsed.captureKey?.keyId, 'OWNER_REVIEW_CAPTURE_KEY_ID_REQUIRED');
  const envelopeKeyId = requiredText(parsed.envelopeKey?.keyId, 'OWNER_REVIEW_ENVELOPE_KEY_ID_REQUIRED');
  const capturePem = readPrivateKey(requiredText(parsed.captureKey?.privateKeyPath,
    'OWNER_REVIEW_CAPTURE_KEY_PATH_REQUIRED'), 'OWNER_REVIEW_CAPTURE_KEY_INVALID');
  const envelopePem = readPrivateKey(requiredText(parsed.envelopeKey?.privateKeyPath,
    'OWNER_REVIEW_ENVELOPE_KEY_PATH_REQUIRED'), 'OWNER_REVIEW_ENVELOPE_KEY_INVALID');
  const storeDirectory = path.resolve(requiredText(parsed.storeDirectory,
    'OWNER_REVIEW_STORE_DIRECTORY_REQUIRED'));
  mkdirSync(storeDirectory, { recursive: true, mode: 0o700 });
  const reviews = parsed.reviews.map((review) => {
    const briefId = requiredText(review?.briefId, 'OWNER_REVIEW_PACKAGE_BRIEF_REQUIRED');
    if (!Array.isArray(review.assignments)
      || (parsed.schemaVersion === 1
        && (!Array.isArray(review.evidence) || !Array.isArray(review.evidenceJudgments)))
      || (parsed.schemaVersion === 2
        && (review.evidence !== undefined || review.evidenceJudgments !== undefined))) {
      throw new Error('OWNER_REVIEW_PACKAGE_SHAPE_INVALID');
    }
    if (review.assignments.some((assignment: ProductionCandidateEvidenceAssignment) =>
      assignment?.generationIdentity !== undefined)) {
      throw new Error('OWNER_REVIEW_GENERATION_IDENTITY_CALLER_FORBIDDEN');
    }
    if (review.assignments.some((assignment: ProductionCandidateEvidenceAssignment) =>
      assignment?.sourceCandidateArtifactDigest !== undefined)) {
      throw new Error('OWNER_REVIEW_GENERATED_BINDING_CALLER_FORBIDDEN');
    }
    if (parsed.schemaVersion === 2 && review.assignments.some((assignment:
      ProductionCandidateEvidenceAssignment | DerivedProductionCandidateEvidenceAssignment) =>
      assignment.crossModalArtifact !== undefined)) {
      throw new Error('OWNER_REVIEW_CROSS_MODAL_ARTIFACT_CALLER_FORBIDDEN');
    }
    if (parsed.schemaVersion === 2) {
      for (const assignment of review.assignments) {
        validateCreativeThesis((assignment as DerivedProductionCandidateEvidenceAssignment).creativeThesis);
      }
    }
    if (review.evidence?.some((evidence: unknown) => typeof evidence !== 'object' || evidence === null))
      throw new Error('OWNER_REVIEW_EVIDENCE_INVALID');
    if (review.evidence?.some((evidence: ProductionOwnerCaptureInputs) => evidence.source !== undefined))
      throw new Error('OWNER_REVIEW_GENERATED_SOURCE_CALLER_FORBIDDEN');
    if (review.evidence?.some((evidence: ProductionOwnerCaptureInputs) =>
      evidence.reviewLimitations !== undefined && !validLimitations(evidence.reviewLimitations)))
      throw new Error('OWNER_REVIEW_LIMITATIONS_INVALID');
    const rendererFilePath = path.resolve(requiredText(review.rendererFilePath,
      'OWNER_REVIEW_RENDERER_FILE_REQUIRED'));
    mkdirSync(path.dirname(rendererFilePath), { recursive: true, mode: 0o700 });
    return Object.freeze({ ...review, briefId, rendererFilePath });
  });
  if (new Set(reviews.map((review) => review.briefId)).size !== reviews.length)
    throw new Error('OWNER_REVIEW_PACKAGE_BRIEF_DUPLICATE');
  const captureAuthority = createCaptureAuthority({ keyId: captureKeyId, privateKeyPem: capturePem });
  const envelopeAuthority = createEnvelopeAuthority({ keyId: envelopeKeyId, privateKeyPem: envelopePem });
  const store = new FileOwnerReviewPacketStore(storeDirectory);
  let closureEvidenceAuthority: CampaignClosureEvidenceAuthority | undefined;
  return Object.freeze({
    plan: parsed.plan,
    briefIds: Object.freeze(reviews.map((review) => review.briefId)),
    createClosureEvidenceAuthority(): CampaignClosureEvidenceAuthority {
      closureEvidenceAuthority ??= bootstrapCampaignClosureEvidenceAuthority({
        persistence: new FileCampaignLedgerPersistence(path.join(storeDirectory, 'campaign-closure-evidence')),
        envelopeAuthority, captureAuthority,
      });
      return closureEvidenceAuthority;
    },
    assertManifestCoverage(manifest: CampaignManifest): void {
      const expected = manifest.briefs.map((brief) => brief.id);
      const supplied = reviews.map((review) => review.briefId);
      if (expected.length !== supplied.length || expected.some((id, index) => id !== supplied[index]))
        throw new Error('OWNER_REVIEW_PACKAGE_BRIEF_COVERAGE_MISMATCH');
      if (parsed.schemaVersion === 2) {
        for (const [index, brief] of manifest.briefs.entries()) {
          const assignments = reviews[index]!.assignments;
          for (const slot of brief.candidateSlots) {
            const assignment = assignments.find((item: ProductionCandidateEvidenceAssignment
              | DerivedProductionCandidateEvidenceAssignment) => item.candidateId === slot.id);
            if (slot.ownerEvidence.audioRequirement === 'required'
              && !assignment?.requiredModalities.includes('audio')) {
              throw new Error('OWNER_REVIEW_REQUIRED_AUDIO_MODALITY_MISSING');
            }
          }
        }
      }
    },
    async captureEvidence(candidates: readonly CampaignActualCandidateManifest[],
      renderer?: OwnerCaptureRenderer): Promise<OwnerCaptures> {
      const active = renderer ?? await createProductionOwnerCaptureRenderer();
      const byBrief = new Map<string, ReadonlyMap<string, OwnerCapturedEvidence>>();
      for (const brief of candidates) {
        if (byBrief.has(brief.briefId)) throw new Error('OWNER_REVIEW_ACTUAL_CANDIDATE_BRIEF_DUPLICATE');
        byBrief.set(brief.briefId, await captureOwnerEvidence(brief.candidates, active));
      }
      return byBrief;
    },
    buildInputs(service: CampaignService, admission: CampaignRunAdmission,
      manifest: CampaignManifest,
      candidates: readonly CampaignActualCandidateManifest[],
      captured: OwnerCaptures = new Map()): readonly OwnerReviewLifecycleInput[] {
      if (parsed.plan.campaignRunId !== manifest.campaignRunId
        || parsed.plan.manifestDigest !== manifest.manifestDigest) {
        throw new Error('OWNER_REVIEW_PACKAGE_CAMPAIGN_BINDING_MISMATCH');
      }
      this.assertManifestCoverage(manifest);
      const expected = manifest.briefs.map((brief) => brief.id);
      const actual = candidates.map((candidate) => candidate.briefId);
      if (actual.length !== expected.length || actual.some((id, index) => id !== expected[index])) {
        throw new Error('OWNER_REVIEW_ACTUAL_CANDIDATE_BRIEF_COVERAGE_MISMATCH');
      }
      const ownerAdmission = service.admitOwnerReview(admission, manifest, candidates);
      return Object.freeze(reviews.map((review, index) => {
        const candidatesForBrief = candidates[index]!;
        const assignments = review.assignments.map((rawAssignment:
          ProductionCandidateEvidenceAssignment | DerivedProductionCandidateEvidenceAssignment) => {
          const candidate = candidatesForBrief.candidates.find((item) => item.id === rawAssignment.candidateId);
          if (!candidate) throw new Error('OWNER_REVIEW_GENERATION_CANDIDATE_OUTSIDE_ACTUAL_MANIFEST');
          const assignment = parsed.schemaVersion === 2
            ? deriveCrossModalAssignment(rawAssignment as DerivedProductionCandidateEvidenceAssignment, candidate)
            : rawAssignment as ProductionCandidateEvidenceAssignment;
          return Object.freeze({ ...assignment,
            sourceCandidateArtifactDigest: candidate.artifact.artifactDigest,
            generationIdentity: generationIdentityFor(admission, manifest, candidate) });
        });
        const session = createBlindReviewSession(candidatesForBrief, assignments);
        const captureInputs = parsed.schemaVersion === 2
          ? assignments.map((_assignment: CandidateEvidenceAssignment, candidateIndex: number) => {
              const candidate = candidatesForBrief.candidates[candidateIndex];
              if (!candidate) throw new Error('OWNER_REVIEW_GENERATED_SOURCE_CANDIDATE_MISSING');
              const slot = manifest.briefs[index]?.candidateSlots.find((item) => item.id === candidate.id);
              if (!slot) throw new Error('OWNER_REVIEW_GENERATED_SLOT_MISSING');
              return observedCaptureInputs(candidate, captured.get(candidatesForBrief.briefId)?.get(candidate.id),
                slot.ownerEvidence.audioRequirement === 'required');
            })
          : review.evidence!.map((item: ProductionOwnerCaptureInputs, candidateIndex: number) => {
              const candidate = candidatesForBrief.candidates[candidateIndex];
              if (!candidate) throw new Error('OWNER_REVIEW_GENERATED_SOURCE_CANDIDATE_MISSING');
              const slot = manifest.briefs[index]?.candidateSlots.find((entry) => entry.id === candidate.id);
              if (!slot) throw new Error('OWNER_REVIEW_GENERATED_SLOT_MISSING');
              // Keep the capturer's own limitations: dropping them would let a
              // partial capture conclude.
              return Object.freeze({ ...item, reviewLimitations: Object.freeze([...new Set([
                ...(item.reviewLimitations ?? []),
                ...(slot.ownerEvidence.audioRequirement === 'required'
                  ? ['model-review-audio-payload-withheld'] : []),
              ])]) });
            });
        const evidence = captureInputs.map((item: ProductionOwnerCaptureInputs, candidateIndex: number) => {
          const candidate = candidatesForBrief.candidates[candidateIndex];
          if (!candidate) throw new Error('OWNER_REVIEW_GENERATED_SOURCE_CANDIDATE_MISSING');
          return Object.freeze({ ...item, source: Object.freeze({
            ref: `${candidate.id}.source`, mimeType: 'application/json',
            payload: campaignActualSource(candidate.artifact.layers),
          }) });
        });
        return Object.freeze({
          campaign: { manifest, fundingReservation: admission.fundingReservation },
          admission: ownerAdmission,
          briefId: review.briefId,
          session,
          evidence,
          evidenceJudgments: parsed.schemaVersion === 2
            ? deriveEvidenceJudgments(session) : review.evidenceJudgments!,
          captureAuthority,
          envelopeAuthority,
          store,
          renderer: new DurableOwnerReviewRenderer(review.rendererFilePath),
        });
      }));
    },
  });
}
