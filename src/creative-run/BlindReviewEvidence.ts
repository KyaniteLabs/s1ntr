import { createHash } from 'node:crypto';
import {
  validateCrossModalCanonicalContent,
  type CrossModalArtifact,
} from '../creative-intelligence/CrossModalArtifact.js';
import {
  campaignCreativeThesisDigest,
  type CandidateArtifactPlan,
  type CandidateManifest,
  type CampaignActualCandidateManifest,
} from './CandidateHypothesisProduction.js';

export const BLIND_REVIEW_PACKET_SCHEMA = 'sinter.blind-review-packet' as const;
export const BLIND_REVIEW_PACKET_VERSION = 1 as const;

export interface BlindReviewCandidate {
  readonly id: string;
  readonly thesisDigest?: string;
  readonly artifact: Pick<CandidateArtifactPlan,
    'html' | 'artifactDigest' | 'successCount' | 'layerCount'>;
}

/** Only the candidate bytes are required to make a blind packet. */
export interface BlindReviewCandidateView {
  readonly candidates: readonly BlindReviewCandidate[];
  readonly creativeThesis?: CandidateManifest['creativeThesis'];
}
export type BlindReviewCandidateManifest = BlindReviewCandidateView | CampaignActualCandidateManifest;

export type ReviewModality = 'visual' | 'audio' | 'motion' | 'interaction';
export type ReviewOutcome = 'pass' | 'fail' | 'inconclusive';

export interface GenerationIdentity {
  readonly role?: 'generator';
  readonly provider?: string;
  readonly model?: string;
  readonly pipe?: string;
  readonly effort?: string;
  readonly contributionLineage?: string;
  readonly assignment?: string;
}

export interface CandidateEvidenceAssignment {
  readonly candidateId: string;
  readonly sourceCandidateArtifactDigest: string;
  readonly requiredModalities: readonly ReviewModality[];
  readonly generationIdentity?: GenerationIdentity;
  readonly crossModalArtifact?: CrossModalArtifact;
  readonly failure?: string;
}

export interface CanonicalMediaReference {
  readonly modality: ReviewModality;
  readonly sourceCandidateArtifactDigest: string;
  readonly digest: string;
  readonly mimeType: string;
  readonly byteLength: number;
  readonly playableUri: string;
}

export interface PlayableMediaManifestEntry {
  readonly blindId: string;
  readonly media: CanonicalMediaReference;
}

export interface BlindCandidateEvidence {
  readonly blindId: string;
  readonly artifactDigest: string;
  readonly status: 'generated' | 'failed';
  readonly failure?: string;
  readonly requiredModalities: readonly ReviewModality[];
  readonly media: readonly CanonicalMediaReference[];
  readonly missingModalities: readonly ReviewModality[];
}

export interface BlindReviewPacket {
  readonly schema: typeof BLIND_REVIEW_PACKET_SCHEMA;
  readonly version: typeof BLIND_REVIEW_PACKET_VERSION;
  readonly candidateSetDigest: string;
  readonly packetDigest: string;
  readonly candidates: readonly BlindCandidateEvidence[];
  readonly contactSheetHtml: string;
  readonly playableMedia: readonly PlayableMediaManifestEntry[];
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) =>
      `${JSON.stringify(key)}:${canonical(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/** Canonical digest for the exact ordered, full candidate bytes admitted to blind review. */
export function blindCandidateSetDigest(
  candidates: readonly BlindReviewCandidate[],
): string {
  return digest(canonical(candidates));
}

export interface ReviewClaim {
  readonly modality: ReviewModality;
  readonly artifactDigest: string;
  readonly evidenceDigest: string;
  readonly claim: string;
}

export interface BlindReviewJudgment {
  readonly blindId: string;
  readonly outcome: Exclude<ReviewOutcome, 'inconclusive'>;
  readonly claims: readonly ReviewClaim[];
}

export interface RecordedBlindJudgment {
  readonly blindId: string;
  readonly outcome: ReviewOutcome;
  readonly claims: readonly ReviewClaim[];
  readonly inconclusiveReasons: readonly string[];
}

export interface BlindReviewRecord {
  readonly packetDigest: string;
  readonly reviewDigest: string;
  readonly judgments: readonly RecordedBlindJudgment[];
}

export interface UnmaskedReview {
  readonly boundary: 'post-review';
  readonly packetDigest: string;
  readonly reviewDigest: string;
  readonly mappings: readonly {
    blindId: string;
    candidateId: string;
    generationIdentity: GenerationIdentity;
  }[];
  readonly auditDigest: string;
}

const MODALITIES: readonly ReviewModality[] = ['visual', 'audio', 'motion', 'interaction'];
const AUTHENTIC_UNMASKS = new WeakMap<object, {
  packet: BlindReviewPacket;
  review: BlindReviewRecord;
}>();
const SESSION_BINDINGS = new WeakMap<BlindReviewSession, ReadonlyArray<{
  readonly blindId: string;
  readonly candidateId: string;
  readonly artifactDigest: string;
  readonly sourceDigest?: string;
  readonly campaignRunId?: string;
  readonly manifestDigest?: string;
  readonly briefId?: string;
  readonly slotDigest?: string;
}>>();

function digest(bytes: string | Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function manifestArtifactDigest(html: string): string {
  return digest(html).slice(0, 16);
}

function freeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) freeze(child);
  }
  return value;
}

function htmlDataUri(html: string): string {
  return `data:text/html;base64,${Buffer.from(html).toString('base64')}`;
}

function canonicalHtml(
  modality: ReviewModality,
  html: string,
  sourceCandidateArtifactDigest: string,
): CanonicalMediaReference {
  return freeze({
    modality,
    sourceCandidateArtifactDigest,
    digest: digest(html),
    mimeType: 'text/html',
    byteLength: Buffer.byteLength(html),
    playableUri: htmlDataUri(html),
  });
}

function canonicalAudio(
  artifact: CrossModalArtifact,
  sourceCandidateArtifactDigest: string,
): CanonicalMediaReference {
  const bytes = Buffer.from(artifact.audioArtifact.audioBase64, 'base64');
  const media = {
    modality: 'audio' as const,
    sourceCandidateArtifactDigest,
    digest: digest(bytes),
    mimeType: artifact.audioArtifact.mimeType,
    byteLength: bytes.byteLength,
    playableUri: `data:${artifact.audioArtifact.mimeType};base64,${bytes.toString('base64')}`,
  };
  if (media.digest !== artifact.audioArtifact.evidence.artifactDigest) {
    throw new Error('CROSS_MODAL_AUDIO_CANONICAL_DIGEST_MISMATCH');
  }
  return freeze(media);
}

function escapeHtml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;').replaceAll('"', '&quot;');
}

function validateRequiredModalities(modalities: readonly ReviewModality[]): readonly ReviewModality[] {
  if (modalities.length === 0 || modalities[0] !== 'visual') {
    throw new Error('REVIEW_REQUIRED_MODALITIES_MUST_START_WITH_VISUAL');
  }
  if (new Set(modalities).size !== modalities.length
    || modalities.some((modality) => !MODALITIES.includes(modality))) {
    throw new Error('REVIEW_REQUIRED_MODALITIES_INVALID');
  }
  return freeze([...modalities]);
}

function evidenceMedia(
  candidate: BlindReviewCandidate,
  assignment: CandidateEvidenceAssignment,
): readonly CanonicalMediaReference[] {
  const actualDigest = digest(candidate.artifact.html);
  if (candidate.artifact.artifactDigest !== actualDigest
    && candidate.artifact.artifactDigest !== manifestArtifactDigest(candidate.artifact.html)) {
    throw new Error(`CANDIDATE_CANONICAL_DIGEST_MISMATCH:${candidate.id}`);
  }
  const media: CanonicalMediaReference[] = [canonicalHtml(
    'visual', candidate.artifact.html, candidate.artifact.artifactDigest,
  )];
  if (!assignment.crossModalArtifact) return freeze(media);
  const crossModal = assignment.crossModalArtifact;
  if (crossModal.thesis.thesisId === '') throw new Error('CROSS_MODAL_THESIS_ID_MISSING');
  validateCrossModalCanonicalContent(crossModal);
  const sourceDigest = crossModal.sourceCandidateArtifactDigest;
  if (!sourceDigest) throw new Error('CROSS_MODAL_SOURCE_CANDIDATE_UNBOUND');
  if (sourceDigest !== assignment.sourceCandidateArtifactDigest
    || sourceDigest !== candidate.artifact.artifactDigest) {
    throw new Error(`CROSS_MODAL_SOURCE_CANDIDATE_MISMATCH:${candidate.id}`);
  }
  media.push(canonicalAudio(crossModal, sourceDigest));
  media.push(canonicalHtml('motion', crossModal.html, sourceDigest));
  media.push(canonicalHtml('interaction', crossModal.html, sourceDigest));
  return freeze(media);
}

function blindId(index: number): string {
  return `candidate-${String(index + 1).padStart(3, '0')}`;
}

function contactSheet(candidates: readonly BlindCandidateEvidence[]): string {
  const figures = candidates.map((candidate) => {
    const visual = candidate.media.find((item) => item.modality === 'visual');
    const frame = visual
      ? `<iframe title="${candidate.blindId}" src="${visual.playableUri}"></iframe>`
      : '<div class="missing">visual media missing</div>';
    const missing = candidate.missingModalities.length > 0
      ? `<p class="missing">missing: ${candidate.missingModalities.join(', ')}</p>`
      : '<p>all required media present</p>';
    const failure = candidate.failure
      ? `<p class="failure">failed: ${escapeHtml(candidate.failure)}</p>`
      : '';
    return `<figure data-blind-id="${candidate.blindId}">${frame}<figcaption>${candidate.blindId}<p>status: ${candidate.status}</p>${failure}${missing}</figcaption></figure>`;
  }).join('');
  return `<!doctype html><html><head><meta charset="utf-8"><title>Blind review contact sheet</title>`
    + '<style>body{background:#090b10;color:#eef;display:grid;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));gap:16px;padding:24px}figure{margin:0;border:1px solid #394050;padding:12px}iframe{width:100%;height:240px;border:0}.missing,.failure{color:#ffb4a8}</style>'
    + `</head><body>${figures}</body></html>`;
}

function packetBody(
  candidateSetDigest: string,
  candidates: readonly BlindCandidateEvidence[],
): Omit<BlindReviewPacket, 'packetDigest'> {
  const contactSheetHtml = contactSheet(candidates);
  return freeze({
    schema: BLIND_REVIEW_PACKET_SCHEMA,
    version: BLIND_REVIEW_PACKET_VERSION,
    candidateSetDigest,
    candidates,
    contactSheetHtml,
    playableMedia: candidates.flatMap((candidate) => candidate.media.map((media) => ({
      blindId: candidate.blindId,
      media,
    }))),
  });
}

function computePacketDigest(packet: Omit<BlindReviewPacket, 'packetDigest'>): string {
  return digest(JSON.stringify({
    schema: packet.schema,
    version: packet.version,
    candidateSetDigest: packet.candidateSetDigest,
    candidates: packet.candidates,
    contactSheetHtml: packet.contactSheetHtml,
    playableMedia: packet.playableMedia,
  }));
}

/** Verify the immutable blind packet before it is carried into durable closure. */
export function hasIntactBlindReviewPacketDigest(packet: BlindReviewPacket): boolean {
  const { packetDigest: claimed, ...body } = packet;
  return computePacketDigest(body) === claimed;
}

function buildCandidates(
  manifest: BlindReviewCandidateManifest,
  assignments: readonly CandidateEvidenceAssignment[],
): readonly BlindCandidateEvidence[] {
  if ('manifestDigest' in manifest && manifest.candidates.some((candidate) =>
    !/^[a-f0-9]{64}$/.test(candidate.artifact.artifactDigest)
      || !/^[a-f0-9]{64}$/.test(candidate.artifact.sourceDigest))) {
    throw new Error('CAMPAIGN_ACTUAL_CANDIDATE_DIGEST_INVALID');
  }
  const expected = manifest.candidates.map((candidate) => candidate.id);
  const actual = assignments.map((assignment) => assignment.candidateId);
  if (new Set(actual).size !== actual.length
    || expected.length !== actual.length
    || expected.some((id) => !actual.includes(id))) {
    throw new Error('BLIND_REVIEW_CANDIDATE_SET_INCOMPLETE');
  }
  return freeze(manifest.candidates.map((candidate, index) => {
    const assignment = assignments.find((item) => item.candidateId === candidate.id)!;
    if (assignment.crossModalArtifact) {
      const supplied = assignment.crossModalArtifact.thesis;
      const thesis = 'creativeThesis' in manifest ? manifest.creativeThesis : undefined;
      const matches = 'thesisDigest' in candidate && candidate.thesisDigest
        ? campaignCreativeThesisDigest(supplied) === candidate.thesisDigest
        : Boolean(thesis) && supplied.thesisId === thesis!.thesisId;
      if (!matches) throw new Error(`CROSS_MODAL_THESIS_MISMATCH:${candidate.id}`);
    }
    const requiredModalities = validateRequiredModalities(assignment.requiredModalities);
    const media = evidenceMedia(candidate, assignment);
    if (assignment.sourceCandidateArtifactDigest !== candidate.artifact.artifactDigest) {
      throw new Error(`CROSS_MODAL_SOURCE_CANDIDATE_MISMATCH:${candidate.id}`);
    }
    const present = new Set(media.map((item) => item.modality));
    const status = assignment.failure || candidate.artifact.successCount < candidate.artifact.layerCount
      ? 'failed' as const : 'generated' as const;
    return {
      blindId: blindId(index), artifactDigest: candidate.artifact.artifactDigest, status,
      ...(assignment.failure ? { failure: assignment.failure } : {}),
      requiredModalities, media,
      missingModalities: requiredModalities.filter((modality) => !present.has(modality)),
    };
  }));
}

function validateClaim(candidate: BlindCandidateEvidence, claim: ReviewClaim): void {
  if (claim.artifactDigest !== candidate.artifactDigest) {
    throw new Error(`REVIEW_CLAIM_ARTIFACT_MISMATCH:${candidate.blindId}:${claim.modality}`);
  }
  const evidence = candidate.media.find((item) => item.modality === claim.modality);
  if (!evidence
    || evidence.digest !== claim.evidenceDigest
    || evidence.sourceCandidateArtifactDigest !== candidate.artifactDigest) {
    throw new Error(`REVIEW_CLAIM_EVIDENCE_MISMATCH:${candidate.blindId}:${claim.modality}`);
  }
  if (!claim.claim.trim()) throw new Error('REVIEW_CLAIM_TEXT_REQUIRED');
}

function recordJudgment(
  candidate: BlindCandidateEvidence,
  judgment: BlindReviewJudgment,
): RecordedBlindJudgment {
  if (judgment.blindId !== candidate.blindId) throw new Error('BLIND_REVIEW_ORDER_MISMATCH');
  const claimed = judgment.claims.map((claim) => claim.modality);
  if (new Set(claimed).size !== claimed.length) throw new Error('REVIEW_CLAIM_MODALITY_DUPLICATE');
  for (const claim of judgment.claims) validateClaim(candidate, claim);
  const reasons = [
    ...candidate.missingModalities.map((modality) => `missing-${modality}-evidence`),
    ...candidate.requiredModalities
      .filter((modality) => !claimed.includes(modality))
      .map((modality) => `unclaimed-${modality}-evidence`),
  ];
  return freeze({
    blindId: candidate.blindId,
    outcome: reasons.length > 0 ? 'inconclusive' : judgment.outcome,
    claims: [...judgment.claims],
    inconclusiveReasons: reasons,
  });
}

function identitiesFor(
  manifest: BlindReviewCandidateManifest,
  assignments: readonly CandidateEvidenceAssignment[],
): ReadonlyArray<UnmaskedReview['mappings'][number]> {
  return freeze(manifest.candidates.map((candidate, index) => {
    const assignment = assignments.find((item) => item.candidateId === candidate.id)!;
    return {
      blindId: blindId(index), candidateId: candidate.id,
      generationIdentity: freeze({ ...(assignment.generationIdentity ?? {}) }),
    };
  }));
}

function decodedMediaPayload(uri: string): string {
  const separator = uri.indexOf(',');
  if (!uri.startsWith('data:') || separator < 0) return uri;
  const metadata = uri.slice(0, separator);
  const payload = uri.slice(separator + 1);
  return metadata.endsWith(';base64')
    ? Buffer.from(payload, 'base64').toString('utf8')
    : decodeURIComponent(payload);
}

/** Match a complete identity token, not incidental text such as `low` in `glow`. */
export function containsIdentityToken(surface: string, identity: string): boolean {
  const escaped = identity.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^a-z0-9])${escaped}($|[^a-z0-9])`, 'i').test(surface);
}

function assertPacketIsBlind(
  packet: BlindReviewPacket,
  mappings: ReadonlyArray<UnmaskedReview['mappings'][number]>,
): void {
  const surfaces = [
    JSON.stringify(packet),
    packet.contactSheetHtml,
    ...packet.candidates.flatMap((candidate) => [
      candidate.failure ?? '',
      ...candidate.media.map((media) => decodedMediaPayload(media.playableUri)),
    ]),
  ];
  const identities = mappings.flatMap(({ generationIdentity }) =>
    Object.values(generationIdentity).filter((value): value is string => Boolean(value)));
  if (identities.some((identity) => surfaces.some((surface) => containsIdentityToken(surface, identity)))) {
    throw new Error('BLIND_REVIEW_GENERATION_IDENTITY_LEAK');
  }
}

export class BlindReviewSession {
  readonly packet: BlindReviewPacket;
  readonly #identities: ReadonlyArray<UnmaskedReview['mappings'][number]>;
  #review?: BlindReviewRecord;
  #unmasked = false;

  constructor(
    manifest: BlindReviewCandidateManifest,
    assignments: readonly CandidateEvidenceAssignment[],
  ) {
    const candidates = buildCandidates(manifest, assignments);
    const candidateSetDigest = blindCandidateSetDigest(manifest.candidates);
    const body = packetBody(candidateSetDigest, candidates);
    this.packet = freeze({ ...body, packetDigest: computePacketDigest(body) });
    this.#identities = identitiesFor(manifest, assignments);
    SESSION_BINDINGS.set(this, freeze(manifest.candidates.map((candidate, index) => {
      const base = { blindId: blindId(index), candidateId: candidate.id,
        artifactDigest: candidate.artifact.artifactDigest };
      if (!('manifestDigest' in manifest) || !('slotDigest' in candidate)
        || !('sourceDigest' in candidate.artifact)) return base;
      return { ...base, sourceDigest: candidate.artifact.sourceDigest,
        campaignRunId: manifest.campaignRunId, manifestDigest: manifest.manifestDigest,
        briefId: candidate.briefId, slotDigest: candidate.slotDigest };
    })));
    assertPacketIsBlind(this.packet, this.#identities);
  }

  submitReview(
    packet: BlindReviewPacket,
    judgments: readonly BlindReviewJudgment[],
  ): BlindReviewRecord {
    if (this.#review) throw new Error('BLIND_REVIEW_ALREADY_SUBMITTED');
    if (computePacketDigest(packet) !== packet.packetDigest
      || packet.packetDigest !== this.packet.packetDigest) {
      throw new Error('BLIND_REVIEW_PACKET_DIGEST_MISMATCH');
    }
    if (judgments.length !== packet.candidates.length
      || new Set(judgments.map((item) => item.blindId)).size !== judgments.length) {
      throw new Error('BLIND_REVIEW_JUDGMENT_SET_INCOMPLETE');
    }
    const ordered = packet.candidates.map((candidate) => {
      const judgment = judgments.find((item) => item.blindId === candidate.blindId);
      if (!judgment) throw new Error('BLIND_REVIEW_JUDGMENT_SET_INCOMPLETE');
      return recordJudgment(candidate, judgment);
    });
    const reviewDigest = digest(JSON.stringify({ packetDigest: packet.packetDigest, judgments: ordered }));
    this.#review = freeze({ packetDigest: packet.packetDigest, reviewDigest, judgments: ordered });
    return this.#review;
  }

  /**
   * Record the display-only blind packet state from an already authenticated
   * independent treatment-preference receipt. It makes no quality judgment and
   * cannot be used as a substitute for a reviewer submission.
   */
  bindIndependentTreatmentPreference(packet: BlindReviewPacket, receiptDigest: string): BlindReviewRecord {
    if (this.#review) throw new Error('BLIND_REVIEW_ALREADY_SUBMITTED');
    if (computePacketDigest(packet) !== packet.packetDigest || packet.packetDigest !== this.packet.packetDigest) {
      throw new Error('BLIND_REVIEW_PACKET_DIGEST_MISMATCH');
    }
    if (!/^[a-f0-9]{64}$/.test(receiptDigest)) {
      throw new Error('BLIND_REVIEW_INDEPENDENT_RECEIPT_INVALID');
    }
    const judgments = packet.candidates.map((candidate) => freeze({
      blindId: candidate.blindId, outcome: 'inconclusive' as const, claims: [],
      inconclusiveReasons: [`independent-treatment-preference:${receiptDigest}`],
    }));
    const reviewDigest = digest(JSON.stringify({ packetDigest: packet.packetDigest, judgments }));
    this.#review = freeze({ packetDigest: packet.packetDigest, reviewDigest, judgments });
    return this.#review;
  }

  unmask(): UnmaskedReview {
    if (!this.#review) throw new Error('BLIND_REVIEW_UNMASK_PREMATURE');
    if (this.#unmasked) throw new Error('BLIND_REVIEW_UNMASK_REPLAYED');
    this.#unmasked = true;
    const audit = {
      boundary: 'post-review' as const,
      packetDigest: this.packet.packetDigest,
      reviewDigest: this.#review.reviewDigest,
      mappings: this.#identities,
    };
    const unmasked = freeze({ ...audit, auditDigest: digest(JSON.stringify(audit)) });
    AUTHENTIC_UNMASKS.set(unmasked, { packet: this.packet, review: this.#review });
    return unmasked;
  }
}

/** Internal host lookup: preserves blindness while binding a funded stage exactly. */
export function resolveBlindCandidateBinding(
  session: BlindReviewSession,
  candidate: BlindCandidateEvidence,
): { readonly candidateId: string; readonly artifactDigest: string } {
  if (session.packet.candidates.find((item) => item.blindId === candidate.blindId) !== candidate) {
    throw new Error('OWNER_REVIEW_CANDIDATE_PROVENANCE_INVALID');
  }
  const matches = (SESSION_BINDINGS.get(session) ?? []).filter((item) =>
    item.blindId === candidate.blindId && item.artifactDigest === candidate.artifactDigest);
  if (matches.length !== 1) throw new Error('OWNER_REVIEW_CANDIDATE_BINDING_AMBIGUOUS');
  return matches[0]!;
}

/** Host-only post-execution binding used to seal owner evidence. */
export interface CampaignBlindCandidateBinding {
  readonly candidateId: string; readonly artifactDigest: string; readonly sourceDigest: string;
  readonly campaignRunId: string; readonly manifestDigest: string; readonly briefId: string;
  readonly slotDigest: string;
}

export function resolveCampaignBlindCandidateBinding(
  session: BlindReviewSession,
  candidate: BlindCandidateEvidence,
): CampaignBlindCandidateBinding {
  resolveBlindCandidateBinding(session, candidate);
  const matches = (SESSION_BINDINGS.get(session) ?? []).filter((item) =>
    item.blindId === candidate.blindId && item.artifactDigest === candidate.artifactDigest
      && item.sourceDigest && item.campaignRunId && item.manifestDigest
      && item.briefId && item.slotDigest);
  if (matches.length !== 1) throw new Error('OWNER_REVIEW_ACTUAL_CANDIDATE_BINDING_MISSING');
  return matches[0] as CampaignBlindCandidateBinding;
}

/** Internal trust boundary: validates provenance without exposing mint authority. */
export function assertAuthenticBlindReviewEvidence(
  packet: BlindReviewPacket,
  review: BlindReviewRecord,
  unmasked: UnmaskedReview,
): void {
  const provenance = AUTHENTIC_UNMASKS.get(unmasked);
  if (unmasked.boundary !== 'post-review'
    || provenance?.packet !== packet || provenance.review !== review) {
    throw new Error('BLIND_REVIEW_UNMASK_PROVENANCE_INVALID');
  }
}

export function createBlindReviewSession(
  manifest: BlindReviewCandidateManifest,
  assignments: readonly CandidateEvidenceAssignment[],
): BlindReviewSession {
  return new BlindReviewSession(manifest, assignments);
}
