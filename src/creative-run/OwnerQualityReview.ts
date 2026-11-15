import { createHash, createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';
import {
  assertAuthenticBlindReviewEvidence,
  containsIdentityToken,
  resolveCampaignBlindCandidateBinding,
  type BlindReviewJudgment,
  type BlindReviewRecord,
  type BlindReviewSession,
  type CampaignBlindCandidateBinding,
  type GenerationIdentity,
  type UnmaskedReview,
} from './BlindReviewEvidence.js';
import {
  manifestIsCurrent,
  type CampaignManifest,
  type CampaignOwnerEvidenceSlot,
} from './CampaignManifest.js';
import type { CampaignFundingReservationV1 } from './CampaignExecutionAuthority.js';
import type {
  ExecutorAttestationV2,
  ExecutorAttestationV3,
} from '../identity/executorAttestation.js';
import {
  assertOwnerReviewAdmission,
  type OwnerReviewAdmission,
} from './CampaignExecutionAuthority.js';

export const OWNER_REVIEW_PACKET_SCHEMA = 'sinter.owner-review-packet' as const;
export const OWNER_REVIEW_PACKET_VERSION = 1 as const;
export const CREATIVE_QUALITY_RUBRIC = 'sinter.creative-quality-rubric/v1' as const;
export const OWNER_CAPTURE_SCHEMA = 'sinter.owner-evidence-capture' as const;
export const OWNER_ENVELOPE_SCHEMA = 'sinter.owner-packet-envelope' as const;
export const OWNER_ENVELOPE_VERSION = 1 as const;

// ━━━ Narrow adapters for final W8C-05 campaign-manifest API ━━━━━━━━━━━━━

/** Resolved brief slot from the frozen campaign manifest.
 *  `audioRequirement` is derived from the frozen signed campaign thesis at
 *  seal time, not from caller input at packet-creation time. Every signed
 *  capture binds this exact origin, so every evidence item is durably tied
 *  to the #718 campaign origin and its audio-modality decision. */
export interface BriefSlotArtifact {
  readonly campaignRunId: string;
  readonly manifestDigest: string;
  readonly briefId: string;
  readonly slotId: string;
  readonly artifactDigest: string;
  readonly sourceDigest: string;
  readonly audioRequirement: AudioRequirement;
  readonly requiredEvidenceClasses: readonly OwnerEvidenceClass[];
  readonly evidenceScheduleDigest: string;
  readonly slotDigest: string;
}

/** Persisted host admission; publication derives slots from this sealed value. */
export interface SealedOwnerCampaignRef {
  readonly manifest: CampaignManifest;
  readonly fundingReservation: CampaignFundingReservationV1;
}

// ━━━ Narrow adapter for final W8C-03 executor-attestation API ━━━━━━━━━━

/** Signed host attestation binding independent reviewer identity. */
export interface ReviewerExecutorAttestation {
  readonly schema: 'sinter.reviewer-attestation';
  readonly schemaVersion: 1;
  readonly attestationId: string;
  readonly role: 'specialist' | 'holistic';
  readonly provider: string;
  readonly model: string;
  readonly pipe: string;
  readonly effort: string;
  readonly contributionLineage: string;
  readonly assignment: string;
  readonly keyId: string;
  readonly nonce: string;
  readonly signatureBase64: string;
  readonly resultDigest: string;
  readonly completion?: ExecutorAttestationV2 | ExecutorAttestationV3;
}

export interface ReviewerAttestationVerifier {
  verify(attestation: ReviewerExecutorAttestation, expectedRole: 'specialist' | 'holistic'): {
    readonly valid: boolean;
    readonly reason?: string;
  };
}

/** Verify the production reviewer wrapper against its original signed completion. */
export function createExecutorReviewerAttestationVerifier(
  verifyCompletion: (completion: ExecutorAttestationV2 | ExecutorAttestationV3,
    role: 'specialist' | 'holistic') =>
    { readonly ok: boolean; readonly reason?: string },
): ReviewerAttestationVerifier {
  return Object.freeze({
    verify(attestation: ReviewerExecutorAttestation, expectedRole: 'specialist' | 'holistic') {
      const completion = attestation.completion;
      if (!completion || attestation.role !== expectedRole)
        return { valid: false, reason: 'attestation-not-exact-host-completion' };
      const subject = completion.subject;
      const completionDigest = createHash('sha256').update(JSON.stringify(completion)).digest('hex');
      const exact = attestation.attestationId === subject.attestationId
        && attestation.provider === subject.resolvedIdentity.provider
        && attestation.model === subject.resolvedIdentity.model
        && attestation.pipe === subject.routeDigest
        && attestation.effort === subject.resolvedIdentity.effort
        && attestation.contributionLineage === subject.attemptDigest
        && attestation.assignment === `${expectedRole}:${subject.requestDigest}`
        && attestation.keyId === subject.keyId && attestation.nonce === subject.nonce
        && attestation.signatureBase64 === completion.signature
        && attestation.resultDigest === completionDigest && subject.success;
      const verification = verifyCompletion(completion, expectedRole);
      return exact && verification.ok
        ? { valid: true }
        : { valid: false, reason: verification.ok ? 'completion-binding-mismatch' : verification.reason };
    },
  });
}

// ━━━ Signed canonical capture receipts ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

export type OwnerEvidenceClass = 'source' | 'visual' | 'temporal' | 'audio'
  | 'interaction' | 'runtime' | 'clock' | 'accessibility';
export type CreativeQualityDimension = 'coherence' | 'specificity' | 'surprise'
  | 'emotionalTemporalArc' | 'crossModalCausality' | 'intentionality' | 'revisitDesire';
export type AudioRequirement = 'required' | 'not-applicable';

export interface OwnerEvidenceCapture {
  readonly schema: typeof OWNER_CAPTURE_SCHEMA;
  readonly schemaVersion: 1;
  readonly briefSlot: BriefSlotArtifact;
  readonly blindId: string;
  readonly evidenceClass: OwnerEvidenceClass;
  readonly artifactDigest: string;
  readonly ref: string;
  readonly mimeType: string;
  readonly digest: string;
  readonly byteLength: number;
  readonly payloadUri: string;
  readonly keyId: string;
  readonly signatureBase64: string;
  readonly resultDigest: string;
}

export interface CaptureSealInput {
  readonly briefSlot: BriefSlotArtifact;
  readonly blindId: string;
  readonly evidenceClass: OwnerEvidenceClass;
  readonly artifactDigest: string;
  readonly ref: string;
  readonly mimeType: string;
  readonly payload: string | Uint8Array;
}

export interface CaptureAuthority {
  seal(input: CaptureSealInput): Promise<OwnerEvidenceCapture>;
  verify(capture: OwnerEvidenceCapture): { readonly valid: boolean; readonly reason?: string };
  readonly keyId: string;
}

// ━━━ Signed versioned restart-verifiable envelope ━━━━━━━━━━━━━━━━━━━━━

export interface OwnerPacketEnvelope {
  readonly schema: typeof OWNER_ENVELOPE_SCHEMA;
  readonly schemaVersion: typeof OWNER_ENVELOPE_VERSION;
  readonly campaignRunId: string;
  readonly manifestDigest: string;
  readonly briefId: string;
  readonly blindPacketDigest: string;
  readonly packetDigest: string;
  readonly keyId: string;
  readonly signatureBase64: string;
  readonly envelopeDigest: string;
}

export interface EnvelopeSealInput {
  readonly campaignRunId: string;
  readonly manifestDigest: string;
  readonly briefId: string;
  readonly blindPacketDigest: string;
  readonly packetDigest: string;
}

export interface EnvelopeAuthority {
  seal(input: EnvelopeSealInput): OwnerPacketEnvelope;
  verify(envelope: OwnerPacketEnvelope): { readonly valid: boolean; readonly reason?: string };
  signReview(value: unknown): string;
  verifyReview(value: unknown, signatureBase64: string): boolean;
  readonly keyId: string;
}

// ━━━ Evidence schedule (derived from frozen thesis/blind-review evidence) ━

export interface EvidenceSchedule {
  readonly audioRequirement: AudioRequirement;
  readonly requiredEvidenceClasses: readonly OwnerEvidenceClass[];
}

// ━━━ Packet and quality-review types ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

export interface OwnerCandidatePacket {
  readonly blindId: string;
  readonly artifactDigest: string;
  readonly audioRequirement: AudioRequirement;
  readonly evidence: readonly OwnerEvidenceCapture[];
  readonly evidenceRootDigest: string;
  readonly prohibitedClaims: readonly OwnerEvidenceClass[];
  readonly inconclusiveReasons: readonly string[];
  readonly knownFailures: readonly string[];
  readonly hardFloorFailures: readonly string[];
}

export interface OwnerReviewPacket {
  readonly schema: typeof OWNER_REVIEW_PACKET_SCHEMA;
  readonly schemaVersion: typeof OWNER_REVIEW_PACKET_VERSION;
  readonly briefId: string;
  readonly blindPacketDigest: string;
  readonly candidates: readonly OwnerCandidatePacket[];
  readonly contactSheetHtml: string;
  readonly ownerDecisions: { readonly preference: null; readonly releaseWorthiness: null };
  readonly packetDigest: string;
}

export type CreativeQualityScores = Record<CreativeQualityDimension, number | null>;

export interface EvidenceBackedScore {
  readonly dimension: CreativeQualityDimension;
  readonly score: number | null;
  readonly evidenceDigests: readonly string[];
}

export interface EvidenceBackedFinding {
  readonly text: string;
  readonly evidenceDigests: readonly string[];
}

export interface EvidenceBackedVeto {
  readonly reason: string;
  readonly evidenceDigests: readonly string[];
}

export interface CreativeQualityReviewInput {
  readonly blindId: string;
  readonly packetDigest: string;
  readonly evidenceRootDigest: string;
  readonly attestation: ReviewerExecutorAttestation;
  readonly verdict: 'pass' | 'fail' | 'tie';
  readonly scores: readonly EvidenceBackedScore[];
  readonly finding: EvidenceBackedFinding;
  readonly criticalFlaws: readonly EvidenceBackedVeto[];
  readonly disagreement: readonly string[];
}

export interface CreativeQualityCandidateResult {
  readonly blindId: string;
  readonly candidateId: string;
  readonly artifactDigest: string;
  readonly outcome: 'eligible' | 'below-floor' | 'inconclusive';
  readonly reviews: readonly CreativeQualityReviewInput[];
  readonly failures: readonly string[];
  readonly disagreement: readonly string[];
}

export interface OwnerQualityReviewBundle {
  readonly rubric: typeof CREATIVE_QUALITY_RUBRIC;
  readonly packetDigest: string;
  readonly envelopeDigest: string;
  readonly blindReview: BlindReviewRecord;
  readonly unmasked: UnmaskedReview;
  readonly status: 'eligible-candidate-present' | 'no-eligible-candidate';
  readonly candidates: readonly CreativeQualityCandidateResult[];
  readonly ownerDecisions: OwnerReviewPacket['ownerDecisions'];
  readonly reviewDigest: string;
  readonly keyId: string;
  readonly signatureBase64: string;
}

export interface OwnerReviewPacketRenderer {
  render(html: string): Promise<OwnerReviewHandle>;
  close(): Promise<void>;
}

export interface OwnerReviewHandle {
  readonly url: string;
  close(): Promise<void>;
}

export interface OwnerReviewPacketStore {
  read(briefId: string): Promise<OwnerReviewPacket | null>;
  readPublished?(briefId: string): Promise<{ readonly packet: OwnerReviewPacket; readonly envelope: OwnerPacketEnvelope } | null>;
  putPublishedIfAbsent?(envelope: OwnerPacketEnvelope, packet: OwnerReviewPacket): Promise<{ readonly packet: OwnerReviewPacket; readonly created: boolean }>;
  putIfAbsent(packet: OwnerReviewPacket): Promise<{ readonly packet: OwnerReviewPacket; readonly created: boolean }>;
  compareAndSwap(
    briefId: string,
    expectedDigest: string | null,
    packet: OwnerReviewPacket,
  ): Promise<{ readonly packet: OwnerReviewPacket; readonly created: boolean }>;
}

export interface OwnerPacketVerification {
  readonly conclusive: boolean;
  readonly invalidEvidence: readonly {
    blindId: string;
    evidenceClass: OwnerEvidenceClass | 'packet';
    reason: string;
  }[];
}

const EVIDENCE_CLASSES: readonly OwnerEvidenceClass[] = [
  'source', 'visual', 'temporal', 'audio', 'interaction', 'runtime', 'clock', 'accessibility',
];
const DIMENSIONS: readonly CreativeQualityDimension[] = [
  'coherence', 'specificity', 'surprise', 'emotionalTemporalArc',
  'crossModalCausality', 'intentionality', 'revisitDesire',
];

// ━━━ Stable digest helpers (same canonical form as CampaignOrigin) ━━━━━

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${stable(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function digest(value: unknown): string {
  return createHash('sha256').update(stable(value)).digest('hex');
}

function bytesDigest(value: Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

function sealedSlotFromManifest(
  manifest: CampaignManifest,
  slot: CampaignOwnerEvidenceSlot,
  actual: CampaignBlindCandidateBinding,
): BriefSlotArtifact {
  return freeze({
    campaignRunId: manifest.campaignRunId,
    manifestDigest: manifest.manifestDigest,
    briefId: slot.briefId,
    slotId: slot.candidateId,
    artifactDigest: actual.artifactDigest,
    sourceDigest: actual.sourceDigest,
    audioRequirement: slot.audioRequirement,
    requiredEvidenceClasses: slot.requiredEvidenceClasses,
    evidenceScheduleDigest: slot.evidenceScheduleDigest,
    slotDigest: slot.slotDigest,
  });
}

function freeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) freeze(child);
  }
  return value;
}

function escapeHtml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;').replaceAll('"', '&quot;');
}

function requireText(value: string, code: string): string {
  if (!value.trim()) throw new Error(code);
  return value;
}

// ━━━ Evidence schedule derivation from frozen campaign thesis ━━━━━━━━━━

/** Derive the evidence schedule from the audio requirement frozen into the
 *  brief slot by the campaign thesis, NOT from caller-provided candidate
 *  modalities. This makes the mandatory/optional audio modality a durable
 *  campaign-sealed decision: every signed capture already binds the brief
 *  slot, so every evidence item carries the audio-modality verdict. */
export function deriveEvidenceSchedule(
  audioRequirement: AudioRequirement,
): EvidenceSchedule {
  const audioRequired = audioRequirement === 'required';
  const requiredEvidenceClasses: OwnerEvidenceClass[] = audioRequired
    ? [...EVIDENCE_CLASSES]
    : EVIDENCE_CLASSES.filter((cls) => cls !== 'audio');
  return freeze({
    audioRequirement: audioRequired ? 'required' : 'not-applicable',
    requiredEvidenceClasses: freeze(requiredEvidenceClasses),
  });
}

// ━━━ Capture receipt signing and verification ━━━━━━━━━━━━━━━━━━━━━━━━━

function captureBody(receipt: OwnerEvidenceCapture): Omit<OwnerEvidenceCapture, 'signatureBase64' | 'resultDigest'> {
  const { signatureBase64: _sig, resultDigest: _digest, ...body } = receipt;
  return body;
}

export function createCaptureAuthority(options: {
  readonly keyId: string;
  readonly privateKeyPem: string;
}): CaptureAuthority {
  const privateKey = createPrivateKey(options.privateKeyPem);
  const publicKey = createPublicKey(privateKey);
  const keyId = options.keyId;
  return {
    keyId,
    seal(input: CaptureSealInput): Promise<OwnerEvidenceCapture> {
      requireText(input.ref, 'OWNER_EVIDENCE_REF_REQUIRED');
      requireText(input.mimeType, 'OWNER_EVIDENCE_MIME_REQUIRED');
      const bytes = typeof input.payload === 'string' ? Buffer.from(input.payload) : Buffer.from(input.payload);
      if (bytes.byteLength === 0) throw new Error(`OWNER_EVIDENCE_EMPTY:${input.evidenceClass}`);
      const payloadDigest = digest(bytes);
      const payloadUri = `data:${input.mimeType};base64,${bytes.toString('base64')}`;
      const unsigned = {
        schema: OWNER_CAPTURE_SCHEMA, schemaVersion: 1 as const,
        briefSlot: input.briefSlot, blindId: input.blindId,
        evidenceClass: input.evidenceClass, artifactDigest: input.artifactDigest,
        ref: input.ref, mimeType: input.mimeType,
        digest: payloadDigest, byteLength: bytes.byteLength,
        payloadUri, keyId,
      };
      const signatureBase64 = sign(null, Buffer.from(stable(unsigned)), privateKey).toString('base64');
      return Promise.resolve(freeze({ ...unsigned, signatureBase64, resultDigest: digest(unsigned) }));
    },
    verify(receipt: OwnerEvidenceCapture): { readonly valid: boolean; readonly reason?: string } {
      const body = captureBody(receipt);
      if (receipt.schema !== OWNER_CAPTURE_SCHEMA || receipt.schemaVersion !== 1)
        return { valid: false, reason: 'capture-schema-mismatch' };
      if (receipt.keyId !== keyId) return { valid: false, reason: 'capture-key-id-untrusted' };
      if (receipt.resultDigest !== digest(body)) return { valid: false, reason: 'capture-result-digest-mismatch' };
      if (!verify(null, Buffer.from(stable(body)), publicKey,
        Buffer.from(receipt.signatureBase64, 'base64')))
        return { valid: false, reason: 'capture-signature-invalid' };
      const bytes = decodePayload(receipt.payloadUri);
      if (!bytes || digest(bytes) !== receipt.digest || bytes.byteLength !== receipt.byteLength)
        return { valid: false, reason: 'capture-payload-digest-mismatch' };
      return { valid: true };
    },
  };
}

// ━━━ Envelope signing and verification ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

function envelopeBody(envelope: OwnerPacketEnvelope): Omit<OwnerPacketEnvelope, 'signatureBase64' | 'envelopeDigest'> {
  const { signatureBase64: _sig, envelopeDigest: _digest, ...body } = envelope;
  return body;
}

export function createEnvelopeAuthority(options: {
  readonly keyId: string;
  readonly privateKeyPem: string;
}): EnvelopeAuthority {
  const privateKey = createPrivateKey(options.privateKeyPem);
  const publicKey = createPublicKey(privateKey);
  const keyId = options.keyId;
  return {
    keyId,
    seal(input: EnvelopeSealInput): OwnerPacketEnvelope {
      for (const field of ['campaignRunId', 'manifestDigest', 'briefId', 'blindPacketDigest', 'packetDigest'] as const) {
        requireText(input[field], `OWNER_ENVELOPE_${field.toUpperCase()}_REQUIRED`);
      }
      const unsigned = {
        schema: OWNER_ENVELOPE_SCHEMA, schemaVersion: OWNER_ENVELOPE_VERSION,
        campaignRunId: input.campaignRunId, manifestDigest: input.manifestDigest,
        briefId: input.briefId, blindPacketDigest: input.blindPacketDigest,
        packetDigest: input.packetDigest, keyId,
      };
      const signatureBase64 = sign(null, Buffer.from(stable(unsigned)), privateKey).toString('base64');
      return freeze({ ...unsigned, signatureBase64, envelopeDigest: digest(unsigned) });
    },
    verify(envelope: OwnerPacketEnvelope): { readonly valid: boolean; readonly reason?: string } {
      if (envelope.schema !== OWNER_ENVELOPE_SCHEMA || envelope.schemaVersion !== OWNER_ENVELOPE_VERSION)
        return { valid: false, reason: 'envelope-schema-mismatch' };
      if (envelope.keyId !== keyId) return { valid: false, reason: 'envelope-key-id-untrusted' };
      if (envelope.envelopeDigest !== digest(envelopeBody(envelope)))
        return { valid: false, reason: 'envelope-digest-mismatch' };
      if (!verify(null, Buffer.from(stable(envelopeBody(envelope))), publicKey,
        Buffer.from(envelope.signatureBase64, 'base64')))
        return { valid: false, reason: 'envelope-signature-invalid' };
      return { valid: true };
    },
    signReview(value: unknown): string {
      return sign(null, Buffer.from(stable(value)), privateKey).toString('base64');
    },
    verifyReview(value: unknown, signatureBase64: string): boolean {
      return verify(null, Buffer.from(stable(value)), publicKey, Buffer.from(signatureBase64, 'base64'));
    },
  };
}

export function verifyEnvelopeWithTrustedKey(envelope: OwnerPacketEnvelope, publicKeyPem: string): boolean {
  if (envelope.schema !== OWNER_ENVELOPE_SCHEMA || envelope.schemaVersion !== OWNER_ENVELOPE_VERSION)
    return false;
  return verify(null, Buffer.from(stable(envelopeBody(envelope))),
    createPublicKey(publicKeyPem), Buffer.from(envelope.signatureBase64, 'base64'));
}

// ━━━ Reviewer attestation verification ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

function attestationBody(attestation: ReviewerExecutorAttestation): Omit<ReviewerExecutorAttestation, 'signatureBase64' | 'resultDigest' | 'completion'> {
  const { signatureBase64: _sig, resultDigest: _digest, completion: _completion, ...body } = attestation;
  return body;
}

export function createReviewerAttestationVerifier(options: {
  readonly trustedKeys: ReadonlyMap<string, string>;
  readonly prohibitedPatterns: readonly RegExp[];
}): ReviewerAttestationVerifier {
  return {
    verify(attestation: ReviewerExecutorAttestation, expectedRole: 'specialist' | 'holistic'): {
      readonly valid: boolean; readonly reason?: string;
    } {
      if (attestation.schema !== 'sinter.reviewer-attestation' || attestation.schemaVersion !== 1)
        return { valid: false, reason: 'attestation-schema-mismatch' };
      if (attestation.role !== expectedRole)
        return { valid: false, reason: `attestation-role-mismatch:${attestation.role}` };
      for (const field of ['provider', 'model', 'pipe', 'effort', 'contributionLineage', 'assignment'] as const) {
        if (!attestation[field]?.trim()) return { valid: false, reason: `attestation-field-incomplete:${field}` };
      }
      // Luna prohibition: reject any Luna identity in reviewer/harness-equivalent role
      const identityText = [attestation.provider, attestation.model, attestation.pipe,
        attestation.contributionLineage, attestation.assignment].join(' ').toLowerCase();
      if (options.prohibitedPatterns.some((pattern) => pattern.test(identityText)))
        return { valid: false, reason: 'attestation-luna-prohibited' };
      if (attestation.resultDigest !== digest(attestationBody(attestation)))
        return { valid: false, reason: 'attestation-digest-mismatch' };
      const publicKeyPem = options.trustedKeys.get(attestation.keyId);
      if (!publicKeyPem) return { valid: false, reason: 'attestation-key-untrusted' };
      if (!verify(null, Buffer.from(stable(attestationBody(attestation))),
        createPublicKey(publicKeyPem), Buffer.from(attestation.signatureBase64, 'base64')))
        return { valid: false, reason: 'attestation-signature-invalid' };
      return { valid: true };
    },
  };
}

// ━━━ Contact sheet HTML with all evidence classes visible ━━━━━━━━━━━━━

function ownerHtml(briefId: string, candidates: readonly OwnerCandidatePacket[]): string {
  const cards = candidates.map((candidate) => {
    const visual = candidate.evidence.find((item) => item.evidenceClass === 'visual');
    const audio = candidate.evidence.find((item) => item.evidenceClass === 'audio');
    const temporal = candidate.evidence.find((item) => item.evidenceClass === 'temporal');
    const interaction = candidate.evidence.find((item) => item.evidenceClass === 'interaction');
    const runtime = candidate.evidence.find((item) => item.evidenceClass === 'runtime');
    const accessibility = candidate.evidence.find((item) => item.evidenceClass === 'accessibility');
    const evidenceDetails = candidate.evidence.map((item) =>
      `<li>${escapeHtml(item.evidenceClass)}: <code>${item.digest}</code> (${escapeHtml(item.ref)})</li>`).join('');
    const allFailures = [...candidate.knownFailures, ...candidate.hardFloorFailures];
    const failures = allFailures.length > 0
      ? `<ul class="failures">${allFailures.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ul>`
      : '<p>Known failures: none</p>';
    const temporalHtml = temporal
      ? `<details open class="evidence temporal"><summary>Temporal samples (${escapeHtml(temporal.ref)})</summary><code>${temporal.digest}</code></details>` : '';
    const interactionHtml = interaction
      ? `<details open class="evidence interaction"><summary>Interaction trace (${escapeHtml(interaction.ref)})</summary><code>${interaction.digest}</code></details>` : '';
    const runtimeHtml = runtime
      ? `<details open class="evidence runtime"><summary>Runtime/DOM state (${escapeHtml(runtime.ref)})</summary><code>${runtime.digest}</code></details>` : '';
    const a11yHtml = accessibility
      ? `<details open class="evidence accessibility"><summary>Accessibility results (${escapeHtml(accessibility.ref)})</summary><code>${accessibility.digest}</code></details>` : '';
    return `<article data-blind-id="${escapeHtml(candidate.blindId)}"><h2>${escapeHtml(candidate.blindId)}</h2>`
      + (visual ? `<iframe title="${escapeHtml(candidate.blindId)}" src="${visual.payloadUri}"></iframe>` : '<p>Visual: missing</p>')
      + (audio ? `<audio controls src="${audio.payloadUri}"></audio>` : '<p>Audio: not present</p>')
      + temporalHtml + interactionHtml + runtimeHtml + a11yHtml
      + `${failures}<details><summary>Exact evidence (${candidate.evidence.length})</summary><ul>${evidenceDetails}</ul></details>`
      + '<p>Owner preference: pending</p><p>Release-worthiness: pending</p></article>';
  }).join('');
  return '<!doctype html><html><head><meta charset="utf-8">'
    + `<title>Owner review · ${escapeHtml(briefId)}</title>`
    + '<style>body{background:#0b0d12;color:#f4f5f7;font:16px system-ui;padding:24px}'
    + 'main{display:grid;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));gap:20px}'
    + 'article{border:1px solid #3c4250;padding:16px}iframe{width:100%;height:260px;border:0}'
    + 'audio{width:100%}.failures{color:#ffb4a8}code{overflow-wrap:anywhere}'
    + '.evidence{margin:4px 0;border-left:2px solid #555;padding-left:8px}'
    + '.temporal{border-color:#6ab0ff}.interaction{border-color:#6affb0}'
    + '.runtime{border-color:#ffb06a}.accessibility{border-color:#b06aff}</style></head>'
    + `<body><h1>Owner review: ${escapeHtml(briefId)}</h1><p>Compare exact playable evidence. `
    + `Model review cannot set preference or release-worthiness.</p><main>${cards}</main></body></html>`;
}

// ━━━ Packet digest ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

function packetDigest(packet: Omit<OwnerReviewPacket, 'packetDigest'>): string {
  return digest({
    schema: packet.schema, schemaVersion: packet.schemaVersion,
    briefId: packet.briefId, blindPacketDigest: packet.blindPacketDigest,
    candidates: packet.candidates, contactSheetHtml: packet.contactSheetHtml,
    ownerDecisions: packet.ownerDecisions,
  });
}

/** Lightweight integrity check for durable references that cannot re-verify capture signatures. */
export function hasIntactOwnerReviewPacketDigest(packet: OwnerReviewPacket): boolean {
  const { packetDigest: claimed, ...body } = packet;
  return packetDigest(body) === claimed;
}

function evidenceRoot(evidence: readonly OwnerEvidenceCapture[]): string {
  return digest(evidence.map((item) => ({
    evidenceClass: item.evidenceClass, ref: item.ref, mimeType: item.mimeType,
    digest: item.digest, byteLength: item.byteLength, resultDigest: item.resultDigest,
  })));
}

function decodePayload(uri: string): Uint8Array | null {
  const separator = uri.indexOf(',');
  if (!uri.startsWith('data:') || separator < 0) return null;
  try {
    const metadata = uri.slice(0, separator);
    const payload = uri.slice(separator + 1);
    return metadata.endsWith(';base64') ? Buffer.from(payload, 'base64') : Buffer.from(decodeURIComponent(payload));
  } catch {
    return null;
  }
}

// ━━━ Media capture from blind-review evidence ━━━━━━━━━━━━━━━━━━━━━━━━

function mediaCaptureInput(
  evidenceClass: Extract<OwnerEvidenceClass, 'visual' | 'audio'>,
  media: BlindReviewSession['packet']['candidates'][number]['media'][number],
  slot: BriefSlotArtifact,
  blindId: string,
): CaptureSealInput {
  const bytes = decodePayload(media.playableUri);
  if (!bytes) throw new Error(`OWNER_EVIDENCE_MEDIA_UNREADABLE:${evidenceClass}:${blindId}`);
  return {
    briefSlot: slot, blindId, evidenceClass,
    artifactDigest: media.sourceCandidateArtifactDigest,
    ref: `${media.modality}:${media.digest}`, mimeType: media.mimeType, payload: bytes,
  };
}

// ━━━ Packet creation with signed captures ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

export interface OwnerCaptureInputs {
  readonly source: { readonly ref: string; readonly mimeType: string; readonly payload: string | Uint8Array };
  readonly timeSamples: readonly { readonly ref: string; readonly mimeType: string; readonly payload: string | Uint8Array }[];
  readonly interactionTrace: { readonly ref: string; readonly mimeType: string; readonly payload: string | Uint8Array };
  readonly runtimeState: { readonly ref: string; readonly mimeType: string; readonly payload: string | Uint8Array };
  readonly clockEvents: { readonly ref: string; readonly mimeType: string; readonly payload: string | Uint8Array };
  readonly accessibility: { readonly ref: string; readonly mimeType: string; readonly payload: string | Uint8Array };
  readonly knownFailures: readonly string[];
  readonly hardFloorFailures: readonly string[];
  /** Honest limitations on what the independent model reviewers could inspect. */
  readonly reviewLimitations?: readonly string[];
}

export async function createOwnerReviewPacket(
  session: BlindReviewSession,
  captureAuthority: CaptureAuthority,
  input: {
    readonly campaign: SealedOwnerCampaignRef;
    readonly admission: OwnerReviewAdmission;
    readonly briefId: string;
    readonly evidence: readonly OwnerCaptureInputs[];
  },
): Promise<OwnerReviewPacket> {
  requireText(input.briefId, 'OWNER_REVIEW_BRIEF_REQUIRED');
  const { manifest, fundingReservation } = input.campaign;
  if (!manifestIsCurrent(manifest)) throw new Error('OWNER_REVIEW_MANIFEST_LEGACY_OR_INVALID');
  // The opaque admission is the only trust anchor: it is minted by the host
  // CampaignFundingReservationAuthority after verifying the reservation
  // signature, and a forged plain object cannot pass the WeakSet brand check.
  const admission = assertOwnerReviewAdmission(input.admission);
  if (admission.reservation.reservationDigest !== fundingReservation.reservationDigest
    || admission.reservation.signature !== fundingReservation.signature) {
    throw new Error('OWNER_REVIEW_ADMISSION_RESERVATION_BINDING_MISMATCH');
  }
  if (admission.manifest.manifestDigest !== manifest.manifestDigest
    || admission.manifest.campaignRunId !== manifest.campaignRunId) {
    throw new Error('OWNER_REVIEW_ADMISSION_MANIFEST_BINDING_MISMATCH');
  }
  if (!admission.briefIds.includes(input.briefId)) {
    throw new Error('OWNER_REVIEW_ADMISSION_BRIEF_NOT_ADMITTED');
  }
  const admittedCandidateSet = admission.candidateSetDigests
    .find((item) => item.briefId === input.briefId);
  if (admittedCandidateSet?.digest !== session.packet.candidateSetDigest) {
    throw new Error('OWNER_REVIEW_CANDIDATE_SET_MISMATCH');
  }
  if (fundingReservation.subject.manifestDigest !== manifest.manifestDigest
    || fundingReservation.subject.campaignRunId !== manifest.campaignRunId)
    throw new Error('OWNER_REVIEW_FUNDING_MANIFEST_BINDING_MISMATCH');
  const brief = manifest.briefs.find((item) => item.id === input.briefId);
  if (!brief) throw new Error('OWNER_REVIEW_BRIEF_OUTSIDE_MANIFEST');
  const expected = session.packet.candidates.map((candidate) => candidate.blindId);
  if (input.evidence.length !== expected.length
    || expected.some((_blindId, index) => {
      const evidence = input.evidence[index];
      return !evidence;
    })) {
    throw new Error('OWNER_EVIDENCE_CANDIDATE_SET_INCOMPLETE');
  }
  const candidatePackets: OwnerCandidatePacket[] = [];
  for (let i = 0; i < session.packet.candidates.length; i++) {
    const candidate = session.packet.candidates[i]!;
    const evidenceInput = input.evidence[i]!;
    const sourceBytes = typeof evidenceInput.source.payload === 'string'
      ? Buffer.from(evidenceInput.source.payload) : Buffer.from(evidenceInput.source.payload);
    // Audio modality comes from the frozen signed campaign thesis (brief slot),
    // not from caller-provided candidate modalities.
    const binding = resolveCampaignBlindCandidateBinding(session, candidate);
    const matchingSlots = brief.candidateSlots.filter((item) => item.id === binding.candidateId
      && item.ownerEvidence.candidateId === binding.candidateId
      && item.ownerEvidence.slotDigest === binding.slotDigest
      && item.ownerEvidence.briefId === input.briefId
      && binding.briefId === input.briefId
      && binding.campaignRunId === manifest.campaignRunId
      && binding.manifestDigest === manifest.manifestDigest);
    const sealedSlot = matchingSlots.length === 1 ? matchingSlots[0]!.ownerEvidence : undefined;
    if (!sealedSlot) throw new Error(`OWNER_REVIEW_CANDIDATE_OUTSIDE_MANIFEST:${candidate.blindId}`);
    const slot: BriefSlotArtifact = sealedSlotFromManifest(manifest, sealedSlot, binding);
    const schedule = deriveEvidenceSchedule(slot.audioRequirement);
    const artifactDigest = candidate.artifactDigest;
    if (bytesDigest(sourceBytes) !== slot.sourceDigest)
      throw new Error(`OWNER_EVIDENCE_SOURCE_DIGEST_MISMATCH:${candidate.blindId}`);
    if (artifactDigest !== slot.artifactDigest)
      throw new Error(`OWNER_EVIDENCE_ARTIFACT_DIGEST_MISMATCH:${candidate.blindId}`);
    const captures: OwnerEvidenceCapture[] = [];
    // Source capture
    captures.push(await captureAuthority.seal({
      briefSlot: slot, blindId: candidate.blindId, evidenceClass: 'source',
      artifactDigest, ref: evidenceInput.source.ref, mimeType: evidenceInput.source.mimeType,
      payload: evidenceInput.source.payload,
    }));
    // Visual capture from blind-review frozen evidence
    const visualMedia = candidate.media.find((item) => item.modality === 'visual');
    if (!visualMedia) throw new Error(`OWNER_EVIDENCE_VISUAL_MISSING:${candidate.blindId}`);
    captures.push(await captureAuthority.seal(mediaCaptureInput('visual', visualMedia, slot, candidate.blindId)));
    // Temporal captures
    if (evidenceInput.timeSamples.length === 0)
      throw new Error(`OWNER_EVIDENCE_TEMPORAL_MISSING:${candidate.blindId}`);
    for (const sample of evidenceInput.timeSamples) {
      captures.push(await captureAuthority.seal({
        briefSlot: slot, blindId: candidate.blindId, evidenceClass: 'temporal',
        artifactDigest, ref: sample.ref, mimeType: sample.mimeType, payload: sample.payload,
      }));
    }
    // Audio capture from blind-review frozen evidence (when required)
    const prohibitedClaims: OwnerEvidenceClass[] = [];
    const inconclusiveReasons: string[] = [...(evidenceInput.reviewLimitations ?? [])];
    if (schedule.audioRequirement === 'required') {
      const audioMedia = candidate.media.find((item) => item.modality === 'audio');
      if (!audioMedia) {
        inconclusiveReasons.push('missing-required-audio');
        prohibitedClaims.push('audio');
      } else {
        captures.push(await captureAuthority.seal(mediaCaptureInput('audio', audioMedia, slot, candidate.blindId)));
      }
    } else {
      prohibitedClaims.push('audio');
    }
    // Interaction, runtime, clock, accessibility captures
    for (const [evidenceClass, asset] of [
      ['interaction', evidenceInput.interactionTrace],
      ['runtime', evidenceInput.runtimeState],
      ['clock', evidenceInput.clockEvents],
      ['accessibility', evidenceInput.accessibility],
    ] as const) {
      captures.push(await captureAuthority.seal({
        briefSlot: slot, blindId: candidate.blindId, evidenceClass,
        artifactDigest, ref: asset.ref, mimeType: asset.mimeType, payload: asset.payload,
      }));
    }
    const frozenCaptures = freeze(captures);
    candidatePackets.push(freeze({
      blindId: candidate.blindId, artifactDigest,
      audioRequirement: schedule.audioRequirement,
      evidence: frozenCaptures, evidenceRootDigest: evidenceRoot(frozenCaptures),
      prohibitedClaims: freeze(prohibitedClaims),
      inconclusiveReasons: freeze(inconclusiveReasons),
      knownFailures: freeze([...evidenceInput.knownFailures]),
      hardFloorFailures: freeze([...evidenceInput.hardFloorFailures]),
    }));
  }
  const candidates = freeze(candidatePackets);
  const body = freeze({
    schema: OWNER_REVIEW_PACKET_SCHEMA,
    schemaVersion: OWNER_REVIEW_PACKET_VERSION,
    briefId: input.briefId,
    blindPacketDigest: session.packet.packetDigest,
    candidates,
    contactSheetHtml: ownerHtml(input.briefId, candidates),
    ownerDecisions: freeze({ preference: null, releaseWorthiness: null }),
  });
  return freeze({ ...body, packetDigest: packetDigest(body) });
}

// ━━━ Packet verification ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

export function verifyOwnerReviewPacket(
  packet: OwnerReviewPacket,
  captureAuthority: CaptureAuthority,
): OwnerPacketVerification {
  const invalidEvidence: Array<OwnerPacketVerification['invalidEvidence'][number]> = [];
  // Every capture across every candidate must bind the same campaign origin
  // (brief slot) and the packet's briefId. This durably ties every evidence
  // item to the exact #718 campaign origin, candidate, and artifact digest.
  const expectedBriefId = packet.briefId;
  let campaignOrigin: Pick<BriefSlotArtifact, 'campaignRunId' | 'manifestDigest' | 'briefId'> | null = null;
  for (const candidate of packet.candidates) {
    let candidateSlot: BriefSlotArtifact | null = null;
    for (const item of candidate.evidence) {
      // Verify the capture's brief slot matches the packet's brief id and
      // that all captures share one consistent campaign origin.
      if (item.briefSlot.briefId !== expectedBriefId) {
        invalidEvidence.push({
          blindId: candidate.blindId, evidenceClass: item.evidenceClass,
          reason: 'capture-brief-id-mismatch',
        });
      }
      if (item.artifactDigest !== candidate.artifactDigest) {
        invalidEvidence.push({
          blindId: candidate.blindId, evidenceClass: item.evidenceClass,
          reason: 'capture-artifact-digest-mismatch',
        });
      }
      const origin = { campaignRunId: item.briefSlot.campaignRunId,
        manifestDigest: item.briefSlot.manifestDigest, briefId: item.briefSlot.briefId };
      campaignOrigin ??= origin;
      candidateSlot ??= item.briefSlot;
      if (stable(origin) !== stable(campaignOrigin)
        || stable(item.briefSlot) !== stable(candidateSlot)) {
        invalidEvidence.push({
          blindId: candidate.blindId, evidenceClass: item.evidenceClass,
          reason: 'capture-campaign-origin-mismatch',
        });
      }
      const verification = captureAuthority.verify(item);
      if (!verification.valid) invalidEvidence.push({
        blindId: candidate.blindId, evidenceClass: item.evidenceClass,
        reason: verification.reason ?? 'capture-invalid',
      });
    }
    if (evidenceRoot(candidate.evidence) !== candidate.evidenceRootDigest) {
      for (const item of candidate.evidence) {
        if (!invalidEvidence.some((failure) => failure.blindId === candidate.blindId
          && failure.evidenceClass === item.evidenceClass)) {
          invalidEvidence.push({
            blindId: candidate.blindId, evidenceClass: item.evidenceClass,
            reason: 'evidence-root-mismatch',
          });
        }
      }
    }
    const present = new Set(candidate.evidence.map((item) => item.evidenceClass));
    for (const evidenceClass of EVIDENCE_CLASSES) {
      if (evidenceClass === 'audio' && candidate.audioRequirement !== 'required') continue;
      if (!present.has(evidenceClass)) invalidEvidence.push({
        blindId: candidate.blindId, evidenceClass, reason: 'required-evidence-missing',
      });
    }
  }
  if (!hasIntactOwnerReviewPacketDigest(packet)) invalidEvidence.push({
    blindId: '*', evidenceClass: 'packet', reason: 'packet-digest-mismatch',
  });
  return freeze({ conclusive: invalidEvidence.length === 0, invalidEvidence: freeze(invalidEvidence) });
}

// ━━━ Independent identity validation ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

const IDENTITY_FIELDS = [
  'provider', 'model', 'pipe', 'effort', 'contributionLineage', 'assignment',
] as const;

function assertIndependentIdentities(
  generation: GenerationIdentity,
  reviews: readonly CreativeQualityReviewInput[],
  verifier: ReviewerAttestationVerifier,
): void {
  const generationValues: Record<string, Set<string>> = {};
  for (const field of IDENTITY_FIELDS) {
    const value = (generation[field] ?? '').trim().toLowerCase();
    if (!value) throw new Error(`QUALITY_REVIEW_GENERATION_IDENTITY_INCOMPLETE:${field}`);
    (generationValues[field] ??= new Set()).add(value);
  }
  for (const review of reviews) {
    const result = verifier.verify(review.attestation, review.attestation.role);
    if (!result.valid) throw new Error(`QUALITY_REVIEW_ATTESTATION_INVALID:${result.reason}`);
    for (const field of IDENTITY_FIELDS) {
      const value = review.attestation[field].trim().toLowerCase();
      if (generationValues[field]?.has(value))
        throw new Error(`QUALITY_REVIEW_IDENTITY_OVERLAP:${field}`);
    }
  }
  // Cross-reviewer independence
  for (let i = 0; i < reviews.length; i++) {
    for (let j = i + 1; j < reviews.length; j++) {
      for (const field of IDENTITY_FIELDS) {
        if (reviews[i]!.attestation[field].trim().toLowerCase()
          === reviews[j]!.attestation[field].trim().toLowerCase())
          throw new Error(`QUALITY_REVIEW_REVIEWER_OVERLAP:${field}`);
      }
    }
  }
}

function validateEvidenceBackedScores(
  review: CreativeQualityReviewInput,
  candidate: OwnerCandidatePacket,
): string[] {
  const failures: string[] = [];
  if (!Array.isArray(review.scores)) {
    // eslint-disable-next-line no-console -- intentional validation diagnostic
    console.error(`[validateEvidenceBackedScores] review.scores is not an array (role=${review.attestation?.role}, type=${typeof review.scores}, value=${JSON.stringify(review.scores)?.slice(0, 200)})`);
    failures.push(`${review.attestation.role}:scores-missing-or-invalid`);
    return failures;
  }
  const keys = review.scores.map((item) => item.dimension);
  if (keys.length !== DIMENSIONS.length || DIMENSIONS.some((dimension) => !keys.includes(dimension))) {
    failures.push(`${review.attestation.role}:rubric-dimensions-incomplete`);
  }
  const validDigests = new Set(candidate.evidence.map((item) => item.digest));
  for (const entry of review.scores) {
    if (entry.score !== null && (!Number.isInteger(entry.score) || entry.score < 1 || entry.score > 5))
      failures.push(`${review.attestation.role}:${entry.dimension}:score-out-of-range`);
    // Every non-null score must cite at least one evidence digest
    if (entry.evidenceDigests.length === 0)
      failures.push(`${review.attestation.role}:${entry.dimension}:evidence-backing-missing`);
    for (const evidenceDigest of entry.evidenceDigests) {
      if (!validDigests.has(evidenceDigest))
        failures.push(`${review.attestation.role}:${entry.dimension}:evidence-backing-invalid`);
    }
  }
  if (review.attestation.role === 'holistic') {
    for (const dimension of ['coherence', 'specificity', 'intentionality'] as const) {
      const entry = review.scores.find((item) => item.dimension === dimension);
      if (entry && (entry.score ?? 0) < 4) failures.push(`holistic:${dimension}:below-4`);
    }
  }
  for (const entry of review.scores) {
    if (entry.score !== null && entry.score < 3)
      failures.push(`${review.attestation.role}:${entry.dimension}:below-3`);
  }
  return failures;
}

function validateFindingAndVetoes(
  review: CreativeQualityReviewInput,
  candidate: OwnerCandidatePacket,
): string[] {
  const failures: string[] = [];
  const validDigests = new Set(candidate.evidence.map((item) => item.digest));
  // Finding must be non-empty and cite evidence
  if (!review.finding || typeof review.finding.text !== 'string') {
    failures.push(`${review.attestation.role}:finding-missing`);
    return failures;
  }
  if (!review.finding.text.trim())
    failures.push(`${review.attestation.role}:finding-missing`);
  if (review.finding.evidenceDigests.length === 0)
    failures.push(`${review.attestation.role}:finding-evidence-backing-missing`);
  for (const evidenceDigest of review.finding.evidenceDigests) {
    if (!validDigests.has(evidenceDigest))
      failures.push(`${review.attestation.role}:finding-evidence-backing-invalid`);
  }
  // Every veto must cite evidence
  for (const veto of review.criticalFlaws) {
    if (!veto.reason.trim())
      failures.push(`${review.attestation.role}:veto-reason-missing`);
    if (veto.evidenceDigests.length === 0)
      failures.push(`${review.attestation.role}:veto-evidence-backing-missing`);
    for (const evidenceDigest of veto.evidenceDigests) {
      if (!validDigests.has(evidenceDigest))
        failures.push(`${review.attestation.role}:veto-evidence-backing-invalid`);
    }
  }
  return failures;
}

function candidateQuality(
  packet: OwnerReviewPacket,
  candidate: OwnerCandidatePacket,
  candidateId: string,
  generation: GenerationIdentity,
  inputs: readonly CreativeQualityReviewInput[],
  verification: OwnerPacketVerification,
): CreativeQualityCandidateResult {
  const failures: string[] = [];
  const inconclusive: string[] = [...candidate.inconclusiveReasons];
  const specialist = inputs.filter((review) => review.attestation.role === 'specialist');
  const holistic = inputs.filter((review) => review.attestation.role === 'holistic');
  if (specialist.length !== 1 || holistic.length !== 1 || inputs.length !== 2) {
    inconclusive.push('specialist-holistic-quorum-missing');
  } else {
    assertIndependentIdentities(generation, inputs, verifierHolder.verifier!);
  }
  if (verification.invalidEvidence.some((item) => item.blindId === '*'
    || item.blindId === candidate.blindId)) inconclusive.push('exact-evidence-invalid');
  for (const review of inputs) {
    if (review.blindId !== candidate.blindId || review.packetDigest !== packet.packetDigest
      || review.evidenceRootDigest !== candidate.evidenceRootDigest) {
      inconclusive.push(`${review.attestation.role}:evidence-binding-mismatch`);
    }
    failures.push(...validateEvidenceBackedScores(review, candidate));
    failures.push(...validateFindingAndVetoes(review, candidate));
    // Critical-flaw veto: any evidence-backed critical flaw vetoed eligibility
    // regardless of the verdict field. The verdict 'fail' is an explicit veto
    // signal; criticalFlaws with valid evidence backing are the substantive
    // veto. Both paths produce a hard below-floor outcome.
    if (review.criticalFlaws.length > 0) {
      for (const veto of review.criticalFlaws) {
        if (veto.reason.trim() && veto.evidenceDigests.length > 0) {
          failures.push(`${review.attestation.role}:critical-flaw-veto`);
        }
      }
    }
    if (review.verdict === 'fail') failures.push(`${review.attestation.role}:veto`);
    if (review.verdict === 'tie') inconclusive.push(`${review.attestation.role}:tie`);
  }
  failures.push(...candidate.hardFloorFailures.map((item) => `hard-floor:${item}`));
  const disagreement = [...new Set(inputs.flatMap((review) => review.disagreement))];
  const outcome = inconclusive.length > 0 ? 'inconclusive'
    : failures.length > 0 ? 'below-floor' : 'eligible';
  return freeze({ blindId: candidate.blindId, candidateId, artifactDigest: candidate.artifactDigest,
    outcome, reviews: freeze([...inputs]), failures: freeze([...inconclusive, ...failures]),
    disagreement: freeze(disagreement) });
}

// Internal holder for the attestation verifier passed to sealOwnerQualityReview
const verifierHolder: { verifier: ReviewerAttestationVerifier | null } = { verifier: null };

function assertReviewsWereBlind(
  reviews: readonly CreativeQualityReviewInput[],
  unmasked: UnmaskedReview,
): void {
  for (const mapping of unmasked.mappings) {
    const protectedValues = [mapping.candidateId, ...Object.values(mapping.generationIdentity)]
      .filter((value): value is string => Boolean(value));
    const surfaces = reviews.flatMap((review) => [
      review.finding.text, ...review.disagreement, ...review.criticalFlaws.map((veto) => veto.reason),
    ]);
    if (protectedValues.some((value) => surfaces.some((surface) => containsIdentityToken(surface, value)))) {
      throw new Error('QUALITY_REVIEW_IDENTITY_LEAK');
    }
  }
}

export function sealOwnerQualityReview(input: {
  readonly session: BlindReviewSession;
  readonly packet: OwnerReviewPacket;
  readonly envelope: OwnerPacketEnvelope;
  readonly envelopeAuthority: EnvelopeAuthority;
  readonly captureAuthority: CaptureAuthority;
  readonly attestationVerifier: ReviewerAttestationVerifier;
  readonly evidenceJudgments: readonly BlindReviewJudgment[];
  readonly reviews: readonly CreativeQualityReviewInput[];
}): OwnerQualityReviewBundle {
  // Verify envelope signature and binding
  const envelopeVerification = input.envelopeAuthority.verify(input.envelope);
  if (!envelopeVerification.valid)
    throw new Error(`OWNER_PACKET_ENVELOPE_INVALID:${envelopeVerification.reason}`);
  if (input.envelope.blindPacketDigest !== input.session.packet.packetDigest
    || input.envelope.packetDigest !== input.packet.packetDigest
    || input.envelope.briefId !== input.packet.briefId)
    throw new Error('OWNER_PACKET_ENVELOPE_BINDING_MISMATCH');
  const expected = input.packet.candidates.map((candidate) => candidate.blindId);
  if (input.reviews.length !== expected.length * 2
    || input.reviews.some((review) => !expected.includes(review.blindId))) {
    throw new Error('QUALITY_REVIEW_SET_INCOMPLETE');
  }
  const sealedReviews = freeze(structuredClone(input.reviews)) as readonly CreativeQualityReviewInput[];
  verifierHolder.verifier = input.attestationVerifier;
  try {
    const blindReview = input.session.submitReview(input.session.packet, input.evidenceJudgments);
    const unmasked = input.session.unmask();
    // In-session provenance: WeakMap check (proves session produced this unmask).
    assertAuthenticBlindReviewEvidence(input.session.packet, blindReview, unmasked);
    // Durable provenance: verify the digest chain so the bundle is verifiable
    // on restart without relying on the WeakMap. This binds blindReview to the
    // packet and unmasked to the blindReview via content digests.
    assertDurableBlindReviewProvenance(input.session.packet, blindReview, unmasked);
    assertReviewsWereBlind(sealedReviews, unmasked);
    const verification = verifyOwnerReviewPacket(input.packet, input.captureAuthority);
    const candidates = freeze(input.packet.candidates.map((candidate) => {
      const mapping = unmasked.mappings.find((item) => item.blindId === candidate.blindId)!;
      return candidateQuality(input.packet, candidate, mapping.candidateId,
        mapping.generationIdentity, sealedReviews.filter((review) => review.blindId === candidate.blindId),
        verification);
    }));
    const status = candidates.some((candidate) => candidate.outcome === 'eligible')
      ? 'eligible-candidate-present' as const : 'no-eligible-candidate' as const;
    const body = {
      rubric: CREATIVE_QUALITY_RUBRIC,
      packetDigest: input.packet.packetDigest,
      envelopeDigest: input.envelope.envelopeDigest,
      blindReview, unmasked, status, candidates,
      ownerDecisions: input.packet.ownerDecisions,
    };
    const reviewDigest = digest(body);
    const signed = { ...body, reviewDigest, keyId: input.envelopeAuthority.keyId };
    return freeze({ ...signed, signatureBase64: input.envelopeAuthority.signReview(signed) });
  } finally {
    verifierHolder.verifier = null;
  }
}

// ━━━ Durable restart-safe provenance ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/** Recompute the blind-review reviewDigest using the same canonical form as
 *  BlindReviewEvidence (JSON.stringify of the {packetDigest, judgments} body).
 *  This lets us verify the blind-review chain durably, without the WeakMap. */
function recomputeBlindReviewDigest(
  packetDigest: string,
  judgments: BlindReviewRecord['judgments'],
): string {
  return createHash('sha256').update(JSON.stringify({
    packetDigest,
    judgments,
  })).digest('hex');
}

/** Recompute the unmasked audit digest using the same canonical form as
 *  BlindReviewEvidence (JSON.stringify of the audit body). */
function recomputeUnmaskedAuditDigest(
  packetDigest: string,
  reviewDigest: string,
  mappings: UnmaskedReview['mappings'],
): string {
  return createHash('sha256').update(JSON.stringify({
    boundary: 'post-review',
    packetDigest,
    reviewDigest,
    mappings,
  })).digest('hex');
}

/** Durable provenance: verify that blindReview and unmasked are internally
 *  consistent via their content digests and bind to the exact packet. This
 *  does NOT use the WeakMap — it verifies the digest chain that
 *  BlindReviewEvidence bakes into every record. */
export function assertDurableBlindReviewProvenance(
  packet: { readonly packetDigest: string },
  review: BlindReviewRecord,
  unmasked: UnmaskedReview,
): void {
  if (review.packetDigest !== packet.packetDigest)
    throw new Error('BLIND_REVIEW_PACKET_DIGEST_BINDING_MISMATCH');
  const expectedReviewDigest = recomputeBlindReviewDigest(packet.packetDigest, review.judgments);
  if (review.reviewDigest !== expectedReviewDigest)
    throw new Error('BLIND_REVIEW_DIGEST_RECOMPUTE_MISMATCH');
  if (unmasked.boundary !== 'post-review')
    throw new Error('BLIND_REVIEW_UNMASK_BOUNDARY_INVALID');
  if (unmasked.packetDigest !== packet.packetDigest)
    throw new Error('UNMASKED_PACKET_DIGEST_BINDING_MISMATCH');
  if (unmasked.reviewDigest !== review.reviewDigest)
    throw new Error('UNMASKED_REVIEW_DIGEST_BINDING_MISMATCH');
  const expectedAuditDigest = recomputeUnmaskedAuditDigest(
    packet.packetDigest, review.reviewDigest, unmasked.mappings);
  if (unmasked.auditDigest !== expectedAuditDigest)
    throw new Error('UNMASKED_AUDIT_DIGEST_RECOMPUTE_MISMATCH');
}

export interface OwnerQualityReviewVerification {
  readonly valid: boolean;
  readonly reasons: readonly string[];
}

/** Restart-safe holistic verification of an OwnerQualityReviewBundle without
 *  any in-memory state. Verifies: packet digest chain, capture signatures,
 *  envelope binding, blind-review digest chain, and review-bundle digest. */
export function verifyOwnerQualityReviewBundle(
  bundle: OwnerQualityReviewBundle,
  packet: OwnerReviewPacket,
  envelope: OwnerPacketEnvelope,
  options: {
    readonly captureAuthority: CaptureAuthority;
    readonly envelopeAuthority: EnvelopeAuthority;
    readonly attestationVerifier: ReviewerAttestationVerifier;
  },
): OwnerQualityReviewVerification {
  const reasons: string[] = [];
  // 1. Packet digest recompute
  if (recomputePacketDigest(packet) !== packet.packetDigest)
    reasons.push('packet-digest-recompute-mismatch');
  // 2. Capture signatures and campaign-origin binding
  const packetVerification = verifyOwnerReviewPacket(packet, options.captureAuthority);
  if (!packetVerification.conclusive)
    reasons.push(...packetVerification.invalidEvidence.map((item) => `capture:${item.reason}`));
  // 3. Envelope signature and binding
  const envelopeVerification = options.envelopeAuthority.verify(envelope);
  if (!envelopeVerification.valid)
    reasons.push(`envelope:${envelopeVerification.reason ?? 'invalid'}`);
  if (envelope.packetDigest !== packet.packetDigest
    || envelope.briefId !== packet.briefId
    || envelope.envelopeDigest !== bundle.envelopeDigest)
    reasons.push('envelope-binding-mismatch');
  // 4. Bundle references the same packet digest
  if (bundle.packetDigest !== packet.packetDigest)
    reasons.push('bundle-packet-digest-mismatch');
  const expectedBlindIds = new Set(packet.candidates.map((candidate) => candidate.blindId));
  if (bundle.candidates.length !== expectedBlindIds.size)
    reasons.push('review-candidate-count-mismatch');
  for (const candidate of bundle.candidates) {
    const packetCandidate = packet.candidates.find((item) => item.blindId === candidate.blindId);
    if (!packetCandidate || packetCandidate.artifactDigest !== candidate.artifactDigest)
      reasons.push('review-candidate-binding-mismatch');
    for (const role of ['specialist', 'holistic'] as const) {
      const matching = candidate.reviews.filter((review) => review.attestation.role === role);
      if (matching.length !== 1) {
        reasons.push(`review-attestation-count:${candidate.blindId}:${role}`);
        continue;
      }
      const review = matching[0]!;
      if (review.blindId !== candidate.blindId || review.packetDigest !== packet.packetDigest
        || review.evidenceRootDigest !== packetCandidate?.evidenceRootDigest)
        reasons.push(`review-binding-mismatch:${candidate.blindId}:${role}`);
      const verification = options.attestationVerifier.verify(review.attestation, role);
      if (!verification.valid)
        reasons.push(`review-attestation:${candidate.blindId}:${role}:${verification.reason ?? 'invalid'}`);
    }
  }
  for (const blindId of expectedBlindIds) {
    if (bundle.candidates.filter((candidate) => candidate.blindId === blindId).length !== 1)
      reasons.push(`review-candidate-count:${blindId}`);
  }
  // 5. Durable blind-review provenance (no WeakMap)
  try {
    assertDurableBlindReviewProvenance(
      { packetDigest: envelope.blindPacketDigest },
      bundle.blindReview, bundle.unmasked,
    );
  } catch (err) {
    reasons.push(`blind-review-provenance:${(err as Error).message}`);
  }
  // 6. Bundle review digest recompute
  const { reviewDigest: _claimed, keyId: _keyId, signatureBase64: _signature, ...bundleBody } = bundle;
  if (digest(bundleBody) !== bundle.reviewDigest)
    reasons.push('bundle-review-digest-recompute-mismatch');
  const { signatureBase64: _sig, ...signedBundle } = bundle;
  if (bundle.keyId !== options.envelopeAuthority.keyId
    || !options.envelopeAuthority.verifyReview(signedBundle, bundle.signatureBase64))
    reasons.push('bundle-signature-invalid');
  return freeze({ valid: reasons.length === 0, reasons: freeze(reasons) });
}

// ━━━ Rendering ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

export async function renderOwnerReviewPacket(
  packet: OwnerReviewPacket,
  envelope: OwnerPacketEnvelope,
  envelopeAuthority: EnvelopeAuthority,
  renderer: OwnerReviewPacketRenderer,
): Promise<OwnerReviewHandle> {
  const verification = envelopeAuthority.verify(envelope);
  if (!verification.valid) throw new Error(`OWNER_PACKET_ENVELOPE_INVALID:${verification.reason}`);
  if (envelope.packetDigest !== packet.packetDigest || envelope.briefId !== packet.briefId)
    throw new Error('OWNER_PACKET_ENVELOPE_BINDING_MISMATCH');
  try {
    return await renderer.render(packet.contactSheetHtml);
  } catch (error) {
    await renderer.close();
    throw error;
  }
}

// ━━━ Atomic publication ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/** Recompute the packet digest from its canonical body and verify it matches
 *  the claimed digest. This detects any post-seal tampering with packet
 *  content before the atomic store publication. */
function recomputePacketDigest(packet: OwnerReviewPacket): string {
  const { packetDigest: _claimed, ...body } = packet;
  return packetDigest(body);
}

export async function publishOwnerReviewPacket(
  envelope: OwnerPacketEnvelope,
  envelopeAuthority: EnvelopeAuthority,
  packet: OwnerReviewPacket,
  store: OwnerReviewPacketStore,
): Promise<{ readonly packet: OwnerReviewPacket; readonly created: boolean }> {
  const verification = envelopeAuthority.verify(envelope);
  if (!verification.valid) throw new Error(`OWNER_PACKET_ENVELOPE_INVALID:${verification.reason}`);
  if (envelope.packetDigest !== packet.packetDigest || envelope.briefId !== packet.briefId)
    throw new Error('OWNER_PACKET_ENVELOPE_BINDING_MISMATCH');
  // Recompute content digest: the packet digest must match a fresh digest
  // computed from the canonical body. This catches any mutation between
  // sealing and publication.
  if (recomputePacketDigest(packet) !== packet.packetDigest)
    throw new Error('OWNER_PACKET_DIGEST_RECOMPUTE_MISMATCH');
  const result = store.putPublishedIfAbsent
    ? await store.putPublishedIfAbsent(envelope, packet)
    : await store.putIfAbsent(packet);
  if (result.packet.packetDigest !== packet.packetDigest)
    throw new Error('OWNER_PACKET_PUT_IF_ABSENT_CONFLICT');
  return result;
}

export async function recomputeAndPublishOwnerReviewPacket(
  session: BlindReviewSession,
  captureAuthority: CaptureAuthority,
  envelopeAuthority: EnvelopeAuthority,
  input: {
    readonly campaign: SealedOwnerCampaignRef;
    readonly admission: OwnerReviewAdmission;
    readonly briefId: string;
    readonly evidence: readonly OwnerCaptureInputs[];
  },
  store: OwnerReviewPacketStore,
): Promise<{ readonly packet: OwnerReviewPacket; readonly envelope: OwnerPacketEnvelope; readonly created: boolean }> {
  const freshPacket = await createOwnerReviewPacket(session, captureAuthority, input);
  const envelope = envelopeAuthority.seal({
    campaignRunId: input.campaign.manifest.campaignRunId,
    manifestDigest: input.campaign.manifest.manifestDigest,
    briefId: input.briefId,
    blindPacketDigest: session.packet.packetDigest,
    packetDigest: freshPacket.packetDigest,
  });
  const result = store.putPublishedIfAbsent
    ? await store.putPublishedIfAbsent(envelope, freshPacket)
    : await store.putIfAbsent(freshPacket);
  if (result.packet.packetDigest !== freshPacket.packetDigest)
    throw new Error('OWNER_PACKET_PUT_IF_ABSENT_CONFLICT');
  return freeze({ packet: result.packet, envelope, created: result.created });
}
