import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { CreativeThesis } from '../creative-intelligence/CreativeIntelligence.js';
import {
  assertAuthenticAttributableRevision, assertAuthenticIndependentBlindTreatmentPreference,
  resolveAuthenticRevisionArtifacts,
} from './AttributableRevision.js';
import type {
  AttributableRevisionReceipt, CriticRole, ExperimentPlan, IndependentBlindTreatmentPreference, RevisionScalar,
} from './AttributableRevision.js';
import { assertAuthenticBlindReviewEvidence } from './BlindReviewEvidence.js';
import type {
  BlindReviewPacket, BlindReviewRecord, CanonicalMediaReference, UnmaskedReview,
} from './BlindReviewEvidence.js';
import type { CandidateManifest } from './CandidateHypothesisProduction.js';
import { OWNER_LEARNING_PERSISTENCE_BOUNDARY } from './OwnerLearningAuthority.js';
import type {
  LearningAuthorization, LearningStageReceipt, LearningTransferReceipt,
  OwnerAuthorityCapability, OwnerLearningAuthoritySession,
  PreferenceDecisionReceipt, ReleaseDecisionReceipt,
} from './CreativeRunCoordinator.js';

export const ARTIST_REVIEW_STATE_VERSION = 1 as const;

export type ArtistReviewAction =
  | { readonly kind: 'preference'; readonly blindIds: readonly [string, string];
      readonly outcome: 'preferred' | 'tie' | 'rejected'; readonly winnerBlindId?: string }
  | { readonly kind: 'release'; readonly candidateId: string; readonly artifactDigest: string;
      readonly decision: 'release-worthy' | 'not-release-worthy' }
  | { readonly kind: 'learning'; readonly operation: 'stage' | 'deny';
      readonly ruleId: string; readonly expiresAt: string }
  | { readonly kind: 'learning'; readonly operation: 'transfer' | 'revoke'; readonly ruleId: string;
      readonly authorizationDigest: string };

export interface ArtistReviewActionAuthority {
  readonly ownerCapability: OwnerAuthorityCapability;
  readonly issuerCapability?: OwnerAuthorityCapability;
}

export interface ArtistReviewCandidate {
  readonly blindId: string;
  readonly candidateId: string;
  readonly label: string;
  readonly hypothesis: string;
  readonly materialDifference: string;
  readonly layerRelationships: readonly string[];
  readonly artifactDigest: string;
  readonly status: 'generated' | 'failed';
  readonly failure?: string;
  readonly media: readonly CanonicalMediaReference[];
  readonly missingMedia: readonly string[];
  readonly review: 'pass' | 'fail' | 'inconclusive';
  readonly reviewNotes: readonly string[];
}

export interface ArtistReviewCriticFinding {
  readonly role: CriticRole;
  readonly finding: string;
  readonly intervention: string;
  readonly artifactDigest: string;
}

export interface ArtistReviewLearningState {
  readonly ruleId: string;
  readonly scope: string;
  readonly value: RevisionScalar;
  readonly status: 'not-requested' | 'denied' | 'active' | 'staged'
    | 'transferred' | 'revoked' | 'expired' | 'blocked';
  readonly expiresAt?: string;
  readonly revocable: boolean;
  readonly persistenceBoundary: typeof OWNER_LEARNING_PERSISTENCE_BOUNDARY;
  readonly contextVersion: string;
  readonly laterEffect: string;
}

export interface ArtistReviewState {
  readonly schema: 'sinter.artist-review-state';
  readonly schemaVersion: typeof ARTIST_REVIEW_STATE_VERSION;
  readonly decisionVersion: number;
  readonly stateDigest: string;
  readonly thesis: Pick<CreativeThesis, 'thesisId' | 'intendedExperienceMeaning'
    | 'perceptualEmotionalArc' | 'tensions' | 'uncertaintiesAssumptions'> & {
      readonly principles: readonly { readonly id: string; readonly rationale: string }[];
    };
  readonly candidates: readonly ArtistReviewCandidate[];
  readonly contactSheetHtml: string;
  readonly playableMedia: BlindReviewPacket['playableMedia'];
  readonly critics: readonly ArtistReviewCriticFinding[];
  readonly intervention: string;
  readonly decisions: {
    readonly preference: 'not-decided' | PreferenceDecisionReceipt['outcome'];
    readonly release: 'not-decided' | ReleaseDecisionReceipt['decision'];
    readonly learning: ArtistReviewLearningState;
  };
  readonly blockers: readonly string[];
  readonly readiness: { readonly reviewComplete: boolean; readonly releaseReady: boolean;
    readonly learningReady: boolean };
  readonly details: Readonly<Record<string, string>>;
}

export interface ArtistReviewActionResult {
  readonly accepted: boolean;
  readonly feedback: string;
  readonly state: ArtistReviewState;
}

declare const ARTIST_REVIEW_PROMOTION_CHECKPOINT_BRAND: unique symbol;
/** Opaque proof that the authentic Studio review staged an owner-authorized revision. */
export interface ArtistReviewPromotionCheckpoint {
  readonly [ARTIST_REVIEW_PROMOTION_CHECKPOINT_BRAND]: true;
}

export interface ArtistReviewPromotionBinding {
  readonly manifest: CandidateManifest;
  readonly plan: ExperimentPlan;
  readonly revision: AttributableRevisionReceipt;
  readonly authority: OwnerLearningAuthoritySession;
  readonly authorization: LearningAuthorization;
  readonly stage: LearningStageReceipt;
  readonly ownerCapability: OwnerAuthorityCapability;
  readonly issuerCapability: OwnerAuthorityCapability;
}

const PROMOTION_CHECKPOINTS = new WeakMap<object, ArtistReviewPromotionBinding>();

declare const ARTIST_REVIEW_CLOSURE_CHECKPOINT_BRAND: unique symbol;
/** Opaque proof that one authentic review session recorded both terminal owner actions. */
export interface ArtistReviewClosureCheckpoint {
  readonly [ARTIST_REVIEW_CLOSURE_CHECKPOINT_BRAND]: true;
}

export interface ArtistReviewClosureBinding {
  readonly authority: OwnerLearningAuthoritySession;
  readonly preferenceReceipt: PreferenceDecisionReceipt;
  readonly releaseReceipt: ReleaseDecisionReceipt;
  readonly plan: ExperimentPlan;
  readonly revision: AttributableRevisionReceipt;
  readonly packet: BlindReviewPacket;
}

const CLOSURE_CHECKPOINTS = new WeakMap<object, ArtistReviewClosureBinding>();

/** Internal resolver; a caller-created checkpoint has no binding. */
export function resolveArtistReviewClosureCheckpoint(
  checkpoint: ArtistReviewClosureCheckpoint,
): ArtistReviewClosureBinding {
  const binding = CLOSURE_CHECKPOINTS.get(checkpoint);
  if (!binding) throw new Error('ARTIST_REVIEW_CLOSURE_CHECKPOINT_INVALID');
  return binding;
}

/** Internal resolver used by the coordinator; caller-authored objects fail closed. */
export function resolveArtistReviewPromotionCheckpoint(
  checkpoint: ArtistReviewPromotionCheckpoint,
): ArtistReviewPromotionBinding {
  const binding = PROMOTION_CHECKPOINTS.get(checkpoint);
  if (!binding) throw new Error('ARTIST_REVIEW_PROMOTION_CHECKPOINT_INVALID');
  return binding;
}

export interface ArtistReviewSessionOptions {
  readonly sessionId: string;
  readonly manifest: CandidateManifest | ArtistReviewManifest;
  readonly packet: BlindReviewPacket;
  readonly review: BlindReviewRecord;
  readonly unmasked: UnmaskedReview;
  readonly plan: ExperimentPlan;
  readonly revision: AttributableRevisionReceipt;
  readonly authority: OwnerLearningAuthoritySession;
  /** Opaque coordinator-minted binding for the fresh baseline/revision comparison. */
  readonly revisionDecisionComparison?: RevisionDecisionComparisonContext;
  readonly now?: () => string;
  readonly tokenSecret?: Uint8Array;
  readonly nonce?: () => string;
}

/** Presentation-only manifest for a host-derived revision comparison. */
export interface ArtistReviewManifest {
  readonly intent: string;
  readonly creativeThesis: {
    readonly thesisId: string;
    readonly intendedExperienceMeaning: string;
    readonly perceptualEmotionalArc: string;
    readonly tensions: readonly string[];
    readonly uncertaintiesAssumptions: readonly string[];
    readonly principles: readonly { readonly principleId: string; readonly applicabilityReason: string }[];
  };
  readonly candidates: readonly {
    readonly id: string; readonly label: string; readonly hypothesis: string;
    readonly materialDifference: string;
    readonly artifact: { readonly html: string; readonly artifactDigest: string;
      readonly successCount: number; readonly layerCount: number;
      readonly layers: readonly { readonly domain: string; readonly blendMode?: string; readonly opacity?: number }[] };
  }[];
}

declare const REVISION_DECISION_COMPARISON_BRAND: unique symbol;
/** Non-forgeable binding for the dedicated two-artifact owner decision surface. */
export interface RevisionDecisionComparisonContext {
  readonly [REVISION_DECISION_COMPARISON_BRAND]: true;
}
interface RevisionDecisionComparisonBinding {
  readonly plan: ExperimentPlan;
  readonly revision: AttributableRevisionReceipt;
  readonly preference: IndependentBlindTreatmentPreference;
  readonly packet: BlindReviewPacket;
  readonly review: BlindReviewRecord;
  readonly unmasked: UnmaskedReview;
  readonly baselineArtifactDigest: string;
  readonly treatmentArtifactDigest: string;
}
const REVISION_DECISION_COMPARISONS = new WeakMap<object, RevisionDecisionComparisonBinding>();

/** Internal coordinator seam; callers cannot forge the returned opaque context. */
export function createRevisionDecisionComparisonContext(input: RevisionDecisionComparisonBinding): RevisionDecisionComparisonContext {
  assertAuthenticIndependentBlindTreatmentPreference(input.plan, input.revision, input.preference);
  const artifacts = resolveAuthenticRevisionArtifacts(input.plan, input.revision);
  if (input.packet.candidates.length !== 2
    || input.baselineArtifactDigest !== artifacts.baseline.artifactDigest
    || input.treatmentArtifactDigest !== artifacts.treatment.artifactDigest
    || ![input.baselineArtifactDigest, input.treatmentArtifactDigest]
      .every((artifactDigest) => input.packet.candidates.some((candidate) => candidate.artifactDigest === artifactDigest))) {
    throw new Error('REVISION_DECISION_COMPARISON_BINDING_INVALID');
  }
  const context = freeze({}) as RevisionDecisionComparisonContext;
  REVISION_DECISION_COMPARISONS.set(context, freeze(input));
  return context;
}

function resolveRevisionDecisionComparisonContext(
  context: RevisionDecisionComparisonContext,
): RevisionDecisionComparisonBinding {
  const binding = REVISION_DECISION_COMPARISONS.get(context);
  if (!binding) throw new Error('REVISION_DECISION_COMPARISON_CONTEXT_INVALID');
  return binding;
}

interface ActionTokenBody {
  readonly sessionId: string;
  readonly stateDigest: string;
  readonly decisionVersion: number;
  readonly action: ArtistReviewAction;
  readonly artifactDigest: string;
  readonly planDigest: string;
  readonly revisionReceiptDigest: string;
  readonly authorityBindingDigest: string;
  readonly expiresAt: string;
  readonly nonce: string;
}

interface TokenRecord {
  readonly body: ActionTokenBody;
  readonly authority: ArtistReviewActionAuthority;
}

function freeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) freeze(child);
  }
  return value;
}

function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

function stateWithDigest(body: Omit<ArtistReviewState, 'stateDigest'>): ArtistReviewState {
  return freeze({ ...body, stateDigest: sha256(JSON.stringify(body)) });
}

function tokenPart(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function safeTokenPart(value: string): Buffer | null {
  try { return Buffer.from(value, 'base64url'); } catch { return null; }
}

function assertBindings(options: ArtistReviewSessionOptions): void {
  assertAuthenticBlindReviewEvidence(options.packet, options.review, options.unmasked);
  assertAuthenticAttributableRevision(options.plan, options.revision);
  const comparison = options.revisionDecisionComparison
    ? resolveRevisionDecisionComparisonContext(options.revisionDecisionComparison) : undefined;
  const normalBindingMismatch = !comparison && (options.plan.packetDigest !== options.packet.packetDigest
    || options.plan.reviewDigest !== options.review.reviewDigest
    || options.plan.unmaskAuditDigest !== options.unmasked.auditDigest
    || options.plan.candidateSetDigest !== options.packet.candidateSetDigest);
  const comparisonBindingMismatch = Boolean(comparison) && (comparison!.plan !== options.plan
    || comparison!.revision !== options.revision || comparison!.packet !== options.packet
    || comparison!.review !== options.review || comparison!.unmasked !== options.unmasked
    || options.packet.candidates.length !== 2
    || !hasExactComparisonPair(options.packet, comparison!.baselineArtifactDigest,
      comparison!.treatmentArtifactDigest));
  if (normalBindingMismatch || comparisonBindingMismatch) {
    throw new Error('ARTIST_REVIEW_EVIDENCE_BINDING_MISMATCH');
  }
  const mapped = new Map(options.unmasked.mappings.map((item) => [item.candidateId, item.blindId]));
  if (options.manifest.candidates.length !== options.packet.candidates.length
    || options.manifest.candidates.some((candidate) => {
      const blindId = mapped.get(candidate.id);
      const evidence = options.packet.candidates.find((item) => item.blindId === blindId);
      return !evidence || evidence.artifactDigest !== candidate.artifact.artifactDigest;
    })) throw new Error('ARTIST_REVIEW_CANDIDATE_BINDING_MISMATCH');
}

function hasExactComparisonPair(packet: BlindReviewPacket, baselineArtifactDigest: string,
  treatmentArtifactDigest: string): boolean {
  const values = packet.candidates.map((candidate) => candidate.artifactDigest);
  return new Set(values).size === 2 && values.length === 2
    && values.includes(baselineArtifactDigest) && values.includes(treatmentArtifactDigest);
}

function candidateState(options: ArtistReviewSessionOptions): readonly ArtistReviewCandidate[] {
  return options.packet.candidates.map((evidence) => {
    const mapping = options.unmasked.mappings.find((item) => item.blindId === evidence.blindId)!;
    const candidate = options.manifest.candidates.find((item) => item.id === mapping.candidateId)!;
    const judgment = options.review.judgments.find((item) => item.blindId === evidence.blindId)!;
    return {
      blindId: evidence.blindId,
      candidateId: candidate.id,
      label: candidate.label,
      hypothesis: candidate.hypothesis,
      materialDifference: candidate.materialDifference,
      layerRelationships: candidate.artifact.layers.map((layer, index, layers) => {
        const next = layers[index + 1];
        const relation = next ? `feeds ${next.domain}` : 'completes the work';
        return `${layer.domain} ${relation} (${layer.blendMode ?? 'normal'}, ${layer.opacity ?? 1})`;
      }),
      artifactDigest: evidence.artifactDigest,
      status: evidence.status,
      ...(evidence.failure ? { failure: evidence.failure } : {}),
      media: evidence.media,
      missingMedia: evidence.missingModalities,
      review: judgment.outcome,
      reviewNotes: [...judgment.claims.map((claim) => claim.claim), ...judgment.inconclusiveReasons],
    };
  });
}

function criticState(plan: ExperimentPlan): readonly ArtistReviewCriticFinding[] {
  return plan.critics.map((critic) => ({
    role: critic.identity.role as CriticRole,
    finding: critic.claims.map((claim) => claim.claim).join(' ') || 'No supported finding.',
    intervention: `${critic.treatment.targetId}: ${String(critic.treatment.before)} → ${String(critic.treatment.after)}`,
    artifactDigest: critic.artifactDigest,
  }));
}

function learningStatus(
  authorization: LearningAuthorization | undefined,
  stage: LearningStageReceipt | undefined,
  transfer: LearningTransferReceipt | undefined,
  revoked: boolean,
  now: string,
): ArtistReviewLearningState['status'] {
  if (revoked) return 'revoked';
  if (transfer) return transfer.status === 'transferred' ? 'transferred' : 'blocked';
  if (authorization && Date.parse(now) >= Date.parse(authorization.expiresAt)) return 'expired';
  if (stage) return stage.status === 'staged' ? 'staged' : 'blocked';
  if (authorization) return authorization.decision === 'allow' ? 'active' : 'denied';
  return 'not-requested';
}

export class ArtistReviewSession {
  readonly #options: ArtistReviewSessionOptions;
  readonly #secret: Buffer;
  readonly #now: () => string;
  readonly #nonce: () => string;
  readonly #tokens = new Map<string, TokenRecord>();
  readonly #consumedTokens = new Set<string>();
  #decisionVersion = 0;
  #preference?: PreferenceDecisionReceipt;
  #release?: ReleaseDecisionReceipt;
  #authorization?: LearningAuthorization;
  #stage?: LearningStageReceipt;
  #transfer?: LearningTransferReceipt;
  #stageAuthority?: ArtistReviewActionAuthority;
  #revoked = false;

  constructor(options: ArtistReviewSessionOptions) {
    assertBindings(options);
    if (!options.sessionId.trim()) throw new Error('ARTIST_REVIEW_SESSION_ID_REQUIRED');
    this.#options = options;
    this.#secret = Buffer.from(options.tokenSecret ?? randomBytes(32));
    if (this.#secret.byteLength < 32) throw new Error('ARTIST_REVIEW_TOKEN_SECRET_TOO_SHORT');
    this.#now = options.now ?? (() => new Date().toISOString());
    this.#nonce = options.nonce ?? randomUUID;
  }

  state(): ArtistReviewState {
    const { manifest, packet, review, unmasked, plan, revision, authority } = this.#options;
    const candidates = candidateState(this.#options);
    const critics = criticState(plan);
    const context = authority.createContextSnapshot();
    const ruleId = plan.treatment.targetId;
    const status = learningStatus(
      this.#authorization, this.#stage, this.#transfer, this.#revoked, this.#now(),
    );
    const evidenceBlockers = candidates.flatMap((candidate) => [
      ...(candidate.status === 'failed' ? [`${candidate.label} failed generation`] : []),
      ...candidate.missingMedia.map((media) => `${candidate.label} is missing ${media}`),
      ...(candidate.review === 'inconclusive' ? [`${candidate.label} review is inconclusive`] : []),
    ]);
    const blockers = [...evidenceBlockers,
      ...(this.#release ? [] : ['Release worthiness has not been decided']),
      ...(status === 'blocked' ? ['Learning transfer is blocked'] : []),
    ];

    return stateWithDigest({
      schema: 'sinter.artist-review-state',
      schemaVersion: ARTIST_REVIEW_STATE_VERSION,
      decisionVersion: this.#decisionVersion,
      thesis: {
        thesisId: manifest.creativeThesis.thesisId,
        intendedExperienceMeaning: manifest.creativeThesis.intendedExperienceMeaning,
        perceptualEmotionalArc: typeof manifest.creativeThesis.perceptualEmotionalArc === 'string'
          ? [manifest.creativeThesis.perceptualEmotionalArc]
          : manifest.creativeThesis.perceptualEmotionalArc,
        tensions: manifest.creativeThesis.tensions,
        uncertaintiesAssumptions: manifest.creativeThesis.uncertaintiesAssumptions,
        principles: manifest.creativeThesis.principles.map((principle) => ({
          id: principle.principleId, rationale: principle.applicabilityReason,
        })),
      },
      candidates,
      contactSheetHtml: packet.contactSheetHtml,
      playableMedia: packet.playableMedia,
      critics,
      intervention: `${plan.treatment.targetId}: ${String(plan.treatment.before)} → ${String(plan.treatment.after)}`,
      decisions: {
        preference: this.#preference?.outcome ?? 'not-decided',
        release: this.#release?.decision ?? 'not-decided',
        learning: {
          ruleId,
          scope: `${plan.treatment.targetKind}:${ruleId} for artifact ${revision.revisedState.artifactDigest}`,
          value: revision.revisedState.principles[ruleId] ?? plan.treatment.after,
          status,
          ...(this.#authorization ? { expiresAt: this.#authorization.expiresAt } : {}),
          revocable: status === 'active' || status === 'staged',
          persistenceBoundary: OWNER_LEARNING_PERSISTENCE_BOUNDARY,
          contextVersion: context.contextDigest,
          laterEffect: status === 'transferred'
            ? `This review transaction holds ${ruleId}=${String(context.rules[ruleId])}; ordinary Create does not consume it.`
            : 'Ordinary Create does not consume artist-review rules; no generation consumer is wired.',
        },
      },
      blockers,
      readiness: {
        reviewComplete: evidenceBlockers.length === 0,
        releaseReady: evidenceBlockers.length === 0
          && this.#release?.decision === 'release-worthy',
        learningReady: false,
      },
      details: {
        packet: packet.packetDigest, review: review.reviewDigest, unmask: unmasked.auditDigest,
        plan: plan.planDigest, revision: revision.receiptDigest,
        context: context.contextDigest,
        ...(this.#preference ? { preference: this.#preference.receiptDigest } : {}),
        ...(this.#release ? { release: this.#release.receiptDigest } : {}),
        ...(this.#authorization ? { learningAuthorization: this.#authorization.authorizationDigest } : {}),
        ...(this.#stage ? { learningStage: this.#stage.receiptDigest } : {}),
        ...(this.#transfer ? { learningTransfer: this.#transfer.receiptDigest } : {}),
      },
    });
  }

  issueActionToken(
    action: ArtistReviewAction,
    authority: ArtistReviewActionAuthority,
    expiresAt: string,
  ): string {
    const state = this.state();
    const expiry = Date.parse(expiresAt);
    if (!Number.isFinite(expiry) || expiry <= Date.parse(this.#now())) {
      throw new Error('ARTIST_REVIEW_ACTION_EXPIRY_INVALID');
    }
    if (action.kind === 'learning' && !authority.issuerCapability) {
      throw new Error('ARTIST_REVIEW_ISSUER_PROVENANCE_REQUIRED');
    }
    const authorityBinding = this.#options.authority.bindActionAuthority({
      ownerCapability: authority.ownerCapability,
      ...(action.kind === 'learning'
        ? { issuerCapability: authority.issuerCapability! } : {}),
    });
    const artifactDigest = this.#assertActionScope(action);
    const body: ActionTokenBody = freeze({
      sessionId: this.#options.sessionId,
      stateDigest: state.stateDigest,
      decisionVersion: state.decisionVersion,
      action,
      artifactDigest,
      planDigest: this.#options.plan.planDigest,
      revisionReceiptDigest: this.#options.revision.receiptDigest,
      authorityBindingDigest: authorityBinding.bindingDigest,
      expiresAt,
      nonce: this.#nonce(),
    });
    const payload = tokenPart(body);
    const signature = createHmac('sha256', this.#secret).update(payload).digest('base64url');
    const token = `${payload}.${signature}`;
    this.#tokens.set(token, { body, authority });
    return token;
  }

  /** Server-only scope witness for host-issued action checkpoints. */
  actionCheckpointScope(token: string): string {
    const record = this.#tokens.get(token);
    if (!record) throw new Error('ARTIST_REVIEW_ACTION_CHECKPOINT_UNKNOWN');
    return sha256(JSON.stringify(record.body));
  }

  /**
   * Reveal the release target only after a valid blind preference is recorded.
   * The target comes from the opaque revision comparison context, never a
   * client-supplied candidate-to-treatment mapping.
   */
  hostDerivedReleaseAction(
    decision: Extract<ArtistReviewAction, { readonly kind: 'release' }>['decision'],
  ): Extract<ArtistReviewAction, { readonly kind: 'release' }> {
    const comparison = this.#options.revisionDecisionComparison
      ? resolveRevisionDecisionComparisonContext(this.#options.revisionDecisionComparison) : undefined;
    if (!comparison || !this.#preference) {
      throw new Error('ARTIST_REVIEW_RELEASE_TARGET_NOT_READY');
    }
    const evidence = this.#options.packet.candidates.find((candidate) =>
      candidate.artifactDigest === comparison.treatmentArtifactDigest);
    const mapping = evidence && this.#options.unmasked.mappings.find((item) => item.blindId === evidence.blindId);
    if (!mapping) throw new Error('ARTIST_REVIEW_RELEASE_TARGET_INVALID');
    return freeze({ kind: 'release', candidateId: mapping.candidateId,
      artifactDigest: comparison.treatmentArtifactDigest, decision });
  }

  #assertActionScope(action: ArtistReviewAction): string {
    const { packet, unmasked, plan, revision } = this.#options;
    if (action.kind === 'preference') {
      if (action.blindIds[0] === action.blindIds[1]) throw new Error('ARTIST_REVIEW_PREFERENCE_PAIR_INVALID');
      const candidates = action.blindIds.map((id) => packet.candidates.find((item) => item.blindId === id));
      if (candidates.some((item) => !item)) throw new Error('ARTIST_REVIEW_PREFERENCE_SCOPE_INVALID');
      if (action.outcome === 'preferred' ? !action.winnerBlindId
        || !action.blindIds.includes(action.winnerBlindId) : Boolean(action.winnerBlindId)) {
        throw new Error('ARTIST_REVIEW_PREFERENCE_SCOPE_INVALID');
      }
      return sha256(JSON.stringify(candidates.map((candidate) => candidate!.artifactDigest)));
    }
    if (action.kind === 'release') {
      const mapping = unmasked.mappings.find((item) => item.candidateId === action.candidateId);
      const candidate = packet.candidates.find((item) => item.blindId === mapping?.blindId);
      if (!candidate || candidate.artifactDigest !== action.artifactDigest) {
        throw new Error('ARTIST_REVIEW_RELEASE_SCOPE_INVALID');
      }
      return action.artifactDigest;
    }
    if (action.ruleId !== plan.treatment.targetId) throw new Error('ARTIST_REVIEW_LEARNING_SCOPE_INVALID');
    if ((action.operation === 'revoke' || action.operation === 'transfer')
      && action.authorizationDigest !== this.#authorization?.authorizationDigest) {
      throw new Error('ARTIST_REVIEW_LEARNING_SCOPE_INVALID');
    }
    return revision.revisedState.artifactDigest;
  }

  executeAction(token: string): ArtistReviewActionResult {
    const rejected = (feedback: string): ArtistReviewActionResult => freeze({
      accepted: false, feedback, state: this.state(),
    });
    if (this.#consumedTokens.has(token)) return rejected('That action was already used. Refresh and try again.');
    const [payload, signature, extra] = token.split('.');
    if (!payload || !signature || extra) return rejected('That action is unknown. Refresh and try again.');
    const supplied = safeTokenPart(signature);
    const expected = Buffer.from(
      createHmac('sha256', this.#secret).update(payload).digest('base64url'), 'base64url',
    );
    if (!supplied || supplied.byteLength !== expected.byteLength
      || !timingSafeEqual(supplied, expected)) {
      return rejected('That action does not belong to this review. Nothing changed.');
    }
    const record = this.#tokens.get(token);
    if (!record || tokenPart(record.body) !== payload) {
      return rejected('That action is unknown or was copied from another review. Nothing changed.');
    }
    const state = this.state();
    if (record.body.sessionId !== this.#options.sessionId) {
      return rejected('That action belongs to another Studio session. Nothing changed.');
    }
    if (Date.parse(this.#now()) >= Date.parse(record.body.expiresAt)) {
      return rejected('That action expired. Refresh the review before deciding.');
    }
    if (record.body.decisionVersion !== state.decisionVersion
      || record.body.stateDigest !== state.stateDigest) {
      return rejected('The review changed after this action was prepared. Refresh before deciding.');
    }
    try {
      const scopedDigest = this.#assertActionScope(record.body.action);
      const authorityBinding = this.#options.authority.bindActionAuthority({
        ownerCapability: record.authority.ownerCapability,
        ...(record.body.action.kind === 'learning'
          ? { issuerCapability: record.authority.issuerCapability! } : {}),
      });
      if (scopedDigest !== record.body.artifactDigest
        || record.body.planDigest !== this.#options.plan.planDigest
        || record.body.revisionReceiptDigest !== this.#options.revision.receiptDigest
        || record.body.authorityBindingDigest !== authorityBinding.bindingDigest) {
        return rejected('That action targets different creative evidence. Nothing changed.');
      }
      this.#consumedTokens.add(token);
      const feedback = this.#applyAction(record.body.action, record.authority);
      this.#decisionVersion += 1;
      return freeze({ accepted: true, feedback, state: this.state() });
    } catch {
      return rejected('The owner action could not be verified. Nothing changed; refresh and try again.');
    }
  }

  promotionCheckpoint(): ArtistReviewPromotionCheckpoint {
    if (!this.#authorization || !this.#stage?.provisional || !this.#stageAuthority?.issuerCapability
      || this.#stage.status !== 'staged' || this.#revoked || this.#transfer) {
      throw new Error('ARTIST_REVIEW_PROMOTION_NOT_STAGED');
    }
    if (!('schema' in this.#options.manifest)) {
      throw new Error('ARTIST_REVIEW_PROMOTION_COMPARISON_UNSUPPORTED');
    }
    const checkpoint = freeze({}) as ArtistReviewPromotionCheckpoint;
    PROMOTION_CHECKPOINTS.set(checkpoint, freeze({
      manifest: this.#options.manifest,
      plan: this.#options.plan,
      revision: this.#options.revision,
      authority: this.#options.authority,
      authorization: this.#authorization,
      stage: this.#stage,
      ownerCapability: this.#stageAuthority.ownerCapability,
      issuerCapability: this.#stageAuthority.issuerCapability,
    }));
    return checkpoint;
  }

  /**
   * Mint a closure-only witness after both owner decisions are recorded.
   * The coordinator must still resolve this witness against its active owner
   * authority before a host can seal durable closure evidence.
   */
  closureCheckpoint(): ArtistReviewClosureCheckpoint {
    if (!this.#preference || !this.#release) {
      throw new Error('ARTIST_REVIEW_CLOSURE_DECISIONS_INCOMPLETE');
    }
    const checkpoint = freeze({}) as ArtistReviewClosureCheckpoint;
    CLOSURE_CHECKPOINTS.set(checkpoint, freeze({
      authority: this.#options.authority,
      preferenceReceipt: this.#preference,
      releaseReceipt: this.#release,
      plan: this.#options.plan,
      revision: this.#options.revision,
      packet: this.#options.packet,
    }));
    return checkpoint;
  }

  #applyAction(action: ArtistReviewAction, authority: ArtistReviewActionAuthority): string {
    const now = this.#now();
    if (action.kind === 'preference') {
      this.#preference = this.#options.authority.recordPreference({
        ownerCapability: authority.ownerCapability, blindIds: action.blindIds,
        outcome: action.outcome, ...(action.winnerBlindId ? { winnerBlindId: action.winnerBlindId } : {}),
        decidedAt: now,
      });
      return 'Creative preference recorded. Release and learning are still separate decisions.';
    }
    if (action.kind === 'release') {
      this.#release = this.#options.authority.recordReleaseDecision({
        ownerCapability: authority.ownerCapability, candidateId: action.candidateId,
        artifactDigest: action.artifactDigest, decision: action.decision, decidedAt: now,
      });
      return action.decision === 'release-worthy'
        ? 'Marked release-worthy. This did not teach or persist a rule.'
        : 'Marked not release-worthy. This did not change creative learning.';
    }
    return this.#applyLearningAction(action, authority, now);
  }

  #applyLearningAction(
    action: Extract<ArtistReviewAction, { kind: 'learning' }>,
    authority: ArtistReviewActionAuthority,
    now: string,
  ): string {
    if (action.operation === 'revoke') {
      if (!this.#authorization) throw new Error('ARTIST_REVIEW_AUTHORIZATION_MISSING');
      this.#options.authority.revokeLearningAuthorization(this.#authorization);
      this.#revoked = true;
      return 'Creative learning permission revoked. No durable rule was saved.';
    }
    if (action.operation === 'transfer') {
      if (!this.#stage?.provisional) throw new Error('ARTIST_REVIEW_STAGE_MISSING');
      this.#transfer = this.#options.authority.transferLearning(this.#stage.provisional);
      return this.#transfer.status === 'transferred'
        ? 'Creative rule transferred inside this review transaction only. Ordinary Create will not consume it.'
        : 'Creative learning was blocked. No rule changed.';
    }
    if (!('expiresAt' in action)) throw new Error('ARTIST_REVIEW_LEARNING_SCOPE_INVALID');
    const { plan, revision } = this.#options;
    this.#authorization = this.#options.authority.issueLearningAuthorization({
      decision: action.operation === 'deny' ? 'deny' : 'allow',
      issuerCapability: authority.issuerCapability!,
      ownerCapability: authority.ownerCapability,
      ruleId: action.ruleId,
      artifactDigest: revision.revisedState.artifactDigest,
      planDigest: plan.planDigest,
      revisionReceiptDigest: revision.receiptDigest,
      issuedAt: now,
      expiresAt: action.expiresAt,
    });
    if (action.operation === 'deny') {
      return 'Creative learning declined. Preference and release decisions were not changed.';
    }
    this.#stage = this.#options.authority.stageLearningTransfer(this.#authorization, action.ruleId);
    if (this.#stage.status !== 'staged' || !this.#stage.provisional) {
      return 'Creative learning could not be staged. No rule changed.';
    }
    this.#stageAuthority = authority;
    return 'Creative rule staged for this session. It is not active or saved yet.';
  }
}

export function createArtistReviewSession(options: ArtistReviewSessionOptions): ArtistReviewSession {
  return new ArtistReviewSession(options);
}
