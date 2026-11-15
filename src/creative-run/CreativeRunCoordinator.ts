import { createHash, createPublicKey, randomUUID, verify as verifySignature } from 'node:crypto';
import {
  CreativeRunCoordinatorBase,
  type CoordinatedCompositionResult,
  type CreativeRunCoordinatorOptions,
} from './CreativeRunCoordinatorBase.js';
import type { CompositionRequest } from '../composition/CompositionGraph.js';
import type { CandidateManifest } from './CandidateHypothesisProduction.js';
import {
  runDreamAndAssimilate,
  type DreamAssimilationRequest,
  type DreamAssimilationResult,
} from './DreamAssimilationRun.js';
export * from './CreativeRunCoordinatorBase.js';
import {
  assertAuthenticAttributableRevision,
  assertAuthenticIndependentBlindTreatmentPreference,
  resolveAuthenticRevisionArtifacts,
  type AttributableRevisionReceipt,
  type ExperimentPlan,
  type IndependentBlindTreatmentPreference,
  type RevisionScalar,
} from './AttributableRevision.js';
import {
  createArtistReviewSession,
  createRevisionDecisionComparisonContext,
  resolveArtistReviewClosureCheckpoint,
  resolveArtistReviewPromotionCheckpoint,
  type ArtistReviewClosureCheckpoint,
  type ArtistReviewPromotionCheckpoint,
  type ArtistReviewManifest,
  type ArtistReviewSession,
} from './ArtistReviewExperience.js';
import {
  assertAuthenticBlindReviewEvidence,
  createBlindReviewSession,
  type BlindReviewPacket,
  type BlindReviewRecord,
  type CanonicalMediaReference,
  type UnmaskedReview,
} from './BlindReviewEvidence.js';
import {
  SIMILARITY_DIMENSIONS,
  TRANSFER_PROMOTION_PERSISTENCE_BOUNDARY,
  TRANSFER_PROMOTION_SCHEMA_VERSION,
  type BlindedComparisonJudgment,
  type OwnerComparisonJudgment,
  type PromotionComparisonCandidate,
  type PromotionComparisonPacket,
  type PromotionReviewOutcome,
  type SimilarityDimension,
  type SimilarityDimensionAssessment,
  type SimilarityFingerprint,
  type SealedPromotionBrief,
  type TransferPromotionArtifact,
  type TransferPromotionComparison,
  type TransferPromotionDecision,
  type TransferPromotionDecisionReason,
  type TransferPromotionFreeze,
  type TransferPromotionGateOptions,
  type TransferPromotionOwnerSessionHandle,
  type TransferPromotionReviewerSink,
  type TransferPromotionReceipt,
} from './TransferPromotionGate.js';

export const OWNER_AUTHORITY_SCHEMA_VERSION = 1 as const;
export const OWNER_LEARNING_PERSISTENCE_BOUNDARY = 'in-memory-transaction-only' as const;

export interface AuthorityIdentity {
  readonly id: string;
  readonly role: 'owner' | 'issuer' | 'reviewer';
  readonly assertionDigest: string;
}

export interface AuthorityCapabilityBinding {
  readonly owner: AuthorityIdentity;
  readonly issuer?: AuthorityIdentity;
  readonly authorityRegistryId: string;
  readonly applicationBoundary: string;
  readonly bindingDigest: string;
}

declare const AUTHORITY_CAPABILITY_BRAND: unique symbol;

/** Opaque result of verifying an application-signed authority assertion. */
export interface OwnerAuthorityCapability {
  readonly [AUTHORITY_CAPABILITY_BRAND]: true;
}

export interface TrustedAuthorityAssertion {
  readonly schema: 'sinter.application-authority-assertion';
  readonly schemaVersion: 1;
  readonly registryId: string;
  readonly principalId: string;
  readonly role: 'owner' | 'issuer' | 'reviewer';
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly nonce: string;
  readonly signatureBase64: string;
}

export interface OwnerAuthorityBootstrapConfig {
  /** Identifier assigned by the authenticating application. */
  readonly registryId: string;
  /** Ed25519 public key. Liminal verifies signatures; it does not authenticate login sessions. */
  readonly publicKeyPem: string;
  /** Human-auditable name for the external authentication boundary. */
  readonly applicationBoundary: string;
  /** Deterministic fault injection inside the module-controlled transaction, tests only. */
  readonly testOnlyTransactionFailure?: 'after-mutation';
}

export interface MutationCounters {
  readonly tasteWrites: number;
  readonly modelTrainingWrites: number;
  readonly ruleWrites: number;
  readonly contextWrites: number;
}

export interface PreferenceDecisionReceipt {
  readonly schema: 'sinter.owner-preference-decision';
  readonly schemaVersion: typeof OWNER_AUTHORITY_SCHEMA_VERSION;
  readonly owner: AuthorityIdentity;
  readonly authorityRegistryId: string;
  readonly applicationBoundary: string;
  readonly packetDigest: string;
  readonly candidates: readonly { readonly blindId: string; readonly artifactDigest: string }[];
  readonly outcome: 'preferred' | 'tie' | 'rejected';
  readonly winnerBlindId?: string;
  readonly decidedAt: string;
  readonly mutationCounters: MutationCounters;
  readonly receiptDigest: string;
}

export interface ReleaseDecisionReceipt {
  readonly schema: 'sinter.owner-release-decision';
  readonly schemaVersion: typeof OWNER_AUTHORITY_SCHEMA_VERSION;
  readonly owner: AuthorityIdentity;
  readonly authorityRegistryId: string;
  readonly applicationBoundary: string;
  readonly packetDigest: string;
  readonly reviewDigest: string;
  readonly candidateId: string;
  readonly artifactDigest: string;
  readonly decision: 'release-worthy' | 'not-release-worthy';
  readonly decidedAt: string;
  readonly mutationCounters: MutationCounters;
  readonly receiptDigest: string;
}

export interface LearningAuthorization {
  readonly schema: 'sinter.learning-authorization';
  readonly schemaVersion: typeof OWNER_AUTHORITY_SCHEMA_VERSION;
  readonly decision: 'allow' | 'deny';
  readonly issuer: AuthorityIdentity;
  readonly owner: AuthorityIdentity;
  readonly authorityRegistryId: string;
  readonly applicationBoundary: string;
  readonly ruleId: string;
  readonly artifactDigest: string;
  readonly planDigest: string;
  readonly revisionReceiptDigest: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly maximumTransfers: 1;
  readonly initialRevocationState: 'active';
  readonly authorizationDigest: string;
}

export type LearningTerminalReason =
  | 'AUTHORIZATION_MISSING' | 'AUTHORIZATION_DIGEST_MISMATCH'
  | 'AUTHORIZATION_PROVENANCE_INVALID' | 'AUTHORIZATION_DENIED'
  | 'AUTHORIZATION_NOT_YET_VALID' | 'AUTHORIZATION_EXPIRED' | 'AUTHORIZATION_REVOKED'
  | 'AUTHORIZATION_ALREADY_CONSUMED' | 'AUTHORIZATION_SCOPE_MISMATCH'
  | 'AUTHORIZATION_ARTIFACT_MISMATCH' | 'AUTHORIZATION_PLAN_MISMATCH'
  | 'AUTHORIZATION_RECEIPT_MISMATCH' | 'PRIOR_CONTEXT_TAMPERED'
  | 'PRIOR_CONTEXT_CHANGED' | 'PROVISIONAL_DIGEST_MISMATCH'
  | 'PROVISIONAL_PROVENANCE_INVALID' | 'TRANSFER_FAILED_ROLLED_BACK'
  | 'TRANSFER_ROLLBACK_CATASTROPHIC';

export interface CreateContextSnapshot {
  readonly rules: Readonly<Record<string, RevisionScalar>>;
  readonly contextDigest: string;
}

export interface ProvisionalLearningTransfer {
  readonly schema: 'sinter.provisional-learning-transfer';
  readonly schemaVersion: typeof OWNER_AUTHORITY_SCHEMA_VERSION;
  readonly authorizationDigest: string;
  readonly ruleId: string;
  readonly ruleValue: RevisionScalar;
  readonly artifactDigest: string;
  readonly planDigest: string;
  readonly revisionReceiptDigest: string;
  readonly priorContext: CreateContextSnapshot;
  readonly nextContext: CreateContextSnapshot;
  readonly provisionalDigest: string;
}

export interface LearningStageReceipt {
  readonly schema: 'sinter.learning-stage-receipt';
  readonly schemaVersion: typeof OWNER_AUTHORITY_SCHEMA_VERSION;
  readonly status: 'staged' | 'terminal';
  readonly reason: 'STAGED' | LearningTerminalReason;
  /** Production persistence is unsupported for this ticket. */
  readonly persistenceBoundary: typeof OWNER_LEARNING_PERSISTENCE_BOUNDARY;
  readonly provisional?: ProvisionalLearningTransfer;
  readonly mutationCounters: MutationCounters;
  readonly receiptDigest: string;
}

export interface LearningTransferReceipt {
  readonly schema: 'sinter.learning-transfer-receipt';
  readonly schemaVersion: typeof OWNER_AUTHORITY_SCHEMA_VERSION;
  readonly status: 'transferred' | 'terminal';
  readonly reason: 'TRANSFERRED' | LearningTerminalReason;
  /** Production persistence is unsupported for this ticket. */
  readonly persistenceBoundary: typeof OWNER_LEARNING_PERSISTENCE_BOUNDARY;
  readonly authorizationDigest: string | null;
  readonly priorContextDigest: string | null;
  readonly resultingContextDigest: string;
  readonly mutationCounters: MutationCounters;
  readonly rollbackReceipt?: RollbackReceipt;
  readonly receiptDigest: string;
}

export interface RollbackReceipt {
  /** Production persistence is unsupported for this ticket. */
  readonly persistenceBoundary: typeof OWNER_LEARNING_PERSISTENCE_BOUNDARY;
  readonly priorContextDigest: string;
  readonly restoredContextDigest: string;
  readonly priorMutationCounters: MutationCounters;
  readonly restoredMutationCounters: MutationCounters;
  readonly restored: true;
  readonly receiptDigest: string;
}

export interface OwnerLearningAuthoritySessionOptions {
  readonly packet: BlindReviewPacket;
  readonly review: BlindReviewRecord;
  readonly unmasked: UnmaskedReview;
  readonly experimentPlan: ExperimentPlan;
  readonly revisionReceipt: AttributableRevisionReceipt;
  readonly now?: () => string;
}

export interface OwnerLearningAuthoritySession {
  bindActionAuthority(input: {
    readonly ownerCapability: OwnerAuthorityCapability;
    readonly issuerCapability?: OwnerAuthorityCapability;
  }): AuthorityCapabilityBinding;
  createContextSnapshot(): CreateContextSnapshot;
  mutationCounters(): MutationCounters;
  recordPreference(input: {
    readonly ownerCapability: OwnerAuthorityCapability;
    readonly blindIds: readonly [string, string];
    readonly outcome: 'preferred' | 'tie' | 'rejected';
    readonly winnerBlindId?: string;
    readonly decidedAt: string;
  }): PreferenceDecisionReceipt;
  recordReleaseDecision(input: {
    readonly ownerCapability: OwnerAuthorityCapability;
    readonly candidateId: string;
    readonly artifactDigest: string;
    readonly decision: 'release-worthy' | 'not-release-worthy';
    readonly decidedAt: string;
  }): ReleaseDecisionReceipt;
  issueLearningAuthorization(input: IssueLearningAuthorizationOptions): LearningAuthorization;
  revokeLearningAuthorization(authorization: LearningAuthorization): Readonly<{
    authorizationDigest: string;
    state: 'revoked';
    revokedAt: string;
    priorMutationCounters: MutationCounters;
    resultingMutationCounters: MutationCounters;
    receiptDigest: string;
  }>;
  authorizationState(authorization: LearningAuthorization): 'active' | 'revoked' | 'consumed';
  stageLearningTransfer(
    authorization: LearningAuthorization | undefined,
    ruleId: string,
  ): LearningStageReceipt;
  transferLearning(provisional: ProvisionalLearningTransfer): LearningTransferReceipt;
}

interface CoordinatorOwnerLearningAuthoritySessionOptions
  extends OwnerLearningAuthoritySessionOptions {
  readonly authorityRegistry: CoordinatorOwnerAuthority;
  readonly testOnlyTransactionFailure?: OwnerAuthorityBootstrapConfig['testOnlyTransactionFailure'];
}

export interface IssueLearningAuthorizationOptions {
  readonly decision: 'allow' | 'deny';
  readonly issuerCapability: OwnerAuthorityCapability;
  readonly ownerCapability: OwnerAuthorityCapability;
  readonly ruleId: string;
  readonly artifactDigest: string;
  readonly planDigest: string;
  readonly revisionReceiptDigest: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
}

interface AuthorizationState {
  revoked: boolean;
  consumed: boolean;
}

interface CapabilityBinding {
  readonly registry: symbol;
  readonly identity: AuthorityIdentity;
  readonly expiresAt: number;
}

const AUTHORITY_CAPABILITIES = new WeakMap<object, CapabilityBinding>();
const AUTHENTIC_OWNER_SESSIONS = new WeakMap<object, CoordinatorOwnerAuthority>();
const AUTHENTIC_OWNER_PREFERENCES = new WeakMap<object, OwnerLearningAuthoritySessionImpl>();
const AUTHENTIC_OWNER_RELEASES = new WeakMap<object, OwnerLearningAuthoritySessionImpl>();
declare const COORDINATOR_OWNER_CLOSURE_CHECKPOINT_BRAND: unique symbol;
/** Opaque, coordinator-scoped terminal owner-decision witness. */
export interface CoordinatorOwnerClosureCheckpoint {
  readonly [COORDINATOR_OWNER_CLOSURE_CHECKPOINT_BRAND]: true;
}
interface CoordinatorOwnerClosureBinding {
  readonly authority: OwnerLearningAuthoritySession;
  readonly preferenceReceipt: PreferenceDecisionReceipt;
  readonly releaseReceipt: ReleaseDecisionReceipt;
  readonly plan: ExperimentPlan;
  readonly revision: AttributableRevisionReceipt;
  readonly packet: BlindReviewPacket;
}
const COORDINATOR_OWNER_CLOSURE_CHECKPOINTS = new WeakMap<object, CoordinatorOwnerClosureBinding>();

declare const COORDINATOR_OWNER_TRANSFER_CHECKPOINT_BRAND: unique symbol;
/** Opaque coordinator-scoped proof of a currently usable staged learning transfer. */
export interface CoordinatorOwnerTransferCheckpoint {
  readonly [COORDINATOR_OWNER_TRANSFER_CHECKPOINT_BRAND]: true;
}
interface CoordinatorOwnerTransferBinding {
  readonly manifest: CandidateManifest;
  readonly plan: ExperimentPlan;
  readonly revision: AttributableRevisionReceipt;
  readonly authorization: LearningAuthorization;
  readonly stage: LearningStageReceipt;
  readonly provisional: ProvisionalLearningTransfer;
}
const COORDINATOR_OWNER_TRANSFER_CHECKPOINTS = new WeakMap<object, CoordinatorOwnerTransferBinding>();

/** Internal durable-closure resolver. Caller-constructed witnesses fail closed. */
export function resolveCoordinatorOwnerClosureCheckpoint(
  checkpoint: CoordinatorOwnerClosureCheckpoint,
): CoordinatorOwnerClosureBinding {
  const binding = COORDINATOR_OWNER_CLOSURE_CHECKPOINTS.get(checkpoint);
  if (!binding) throw new Error('CAMPAIGN_CLOSURE_OWNER_CHECKPOINT_INVALID');
  return binding;
}

/** Internal resolver; transport JSON can never reconstitute this witness. */
export function resolveCoordinatorOwnerTransferCheckpoint(
  checkpoint: CoordinatorOwnerTransferCheckpoint,
): CoordinatorOwnerTransferBinding {
  const binding = COORDINATOR_OWNER_TRANSFER_CHECKPOINTS.get(checkpoint);
  if (!binding) throw new Error('CAMPAIGN_TRANSFER_OWNER_CHECKPOINT_INVALID');
  return binding;
}

interface CoordinatorOwnerAuthority {
  readonly config: OwnerAuthorityBootstrapConfig;
  accept(assertion: TrustedAuthorityAssertion): OwnerAuthorityCapability;
  verify(
    capability: OwnerAuthorityCapability,
    role: AuthorityIdentity['role'],
  ): AuthorityIdentity;
  createSession(options: OwnerLearningAuthoritySessionOptions): OwnerLearningAuthoritySession;
  resolveSession(session: OwnerLearningAuthoritySession): OwnerLearningAuthoritySessionImpl;
}

function assertionBody(assertion: TrustedAuthorityAssertion): string {
  return JSON.stringify({
    schema: assertion.schema,
    schemaVersion: assertion.schemaVersion,
    registryId: assertion.registryId,
    principalId: assertion.principalId,
    role: assertion.role,
    issuedAt: assertion.issuedAt,
    expiresAt: assertion.expiresAt,
    nonce: assertion.nonce,
  });
}

/** Internal verifier owned by CreativeRunCoordinator bootstrap; not a public mint. */
class ApplicationOwnerAuthorityRegistry implements CoordinatorOwnerAuthority {
  readonly #registry = Symbol('application-owner-authority');
  readonly #publicKey;
  readonly #acceptedNonces = new Set<string>();

  constructor(
    readonly config: OwnerAuthorityBootstrapConfig,
    readonly now: () => string,
  ) {
    if (!config.registryId.trim() || !config.applicationBoundary.trim()) {
      throw new Error('OWNER_AUTHORITY_BOOTSTRAP_INVALID');
    }
    if (config.testOnlyTransactionFailure !== undefined
      && config.testOnlyTransactionFailure !== 'after-mutation') {
      throw new Error('OWNER_AUTHORITY_TEST_FAULT_INVALID');
    }
    if (config.testOnlyTransactionFailure && process.env.NODE_ENV !== 'test') {
      throw new Error('OWNER_AUTHORITY_TEST_FAULT_INJECTION_DENIED');
    }
    this.#publicKey = createPublicKey(config.publicKeyPem);
  }

  accept(assertion: TrustedAuthorityAssertion): OwnerAuthorityCapability {
    if (assertion.schema !== 'sinter.application-authority-assertion'
      || assertion.schemaVersion !== 1 || assertion.registryId !== this.config.registryId
      || !assertion.principalId.trim() || !assertion.nonce.trim()) {
      throw new Error('OWNER_AUTHORITY_ASSERTION_INVALID');
    }
    const issuedAt = requireTime(assertion.issuedAt, 'OWNER_AUTHORITY_ASSERTION_TIME_INVALID');
    const expiresAt = requireTime(assertion.expiresAt, 'OWNER_AUTHORITY_ASSERTION_TIME_INVALID');
    const now = requireTime(this.now(), 'OWNER_AUTHORITY_CLOCK_INVALID');
    if (issuedAt > now || expiresAt <= now || expiresAt <= issuedAt) {
      throw new Error('OWNER_AUTHORITY_ASSERTION_EXPIRED');
    }
    const signature = Buffer.from(assertion.signatureBase64, 'base64');
    if (!verifySignature(null, Buffer.from(assertionBody(assertion)), this.#publicKey, signature)) {
      throw new Error('OWNER_AUTHORITY_SIGNATURE_INVALID');
    }
    if (this.#acceptedNonces.has(assertion.nonce)) throw new Error('OWNER_AUTHORITY_ASSERTION_REPLAY');
    this.#acceptedNonces.add(assertion.nonce);
    const capability = freeze({}) as OwnerAuthorityCapability;
    AUTHORITY_CAPABILITIES.set(capability, {
      registry: this.#registry,
      identity: freeze({
        id: assertion.principalId.trim(),
        role: assertion.role,
        assertionDigest: sha256(JSON.stringify(assertion)),
      }),
      expiresAt,
    });
    return capability;
  }

  verify(
    capability: OwnerAuthorityCapability,
    role: AuthorityIdentity['role'],
  ): AuthorityIdentity {
    const binding = capability && typeof capability === 'object'
      ? AUTHORITY_CAPABILITIES.get(capability) : undefined;
    if (!binding || binding.registry !== this.#registry) {
      throw new Error('OWNER_AUTHORITY_CAPABILITY_PROVENANCE_INVALID');
    }
    if (binding.identity.role !== role) throw new Error(`OWNER_AUTHORITY_CAPABILITY_ROLE_INVALID:${role}`);
    if (binding.expiresAt <= requireTime(this.now(), 'OWNER_AUTHORITY_CLOCK_INVALID')) {
      throw new Error('OWNER_AUTHORITY_CAPABILITY_EXPIRED');
    }
    return binding.identity;
  }

  createSession(options: OwnerLearningAuthoritySessionOptions): OwnerLearningAuthoritySession {
    const session = new OwnerLearningAuthoritySessionImpl({
      ...options,
      authorityRegistry: this,
      testOnlyTransactionFailure: this.config.testOnlyTransactionFailure,
    });
    AUTHENTIC_OWNER_SESSIONS.set(session, this);
    return session;
  }

  resolveSession(session: OwnerLearningAuthoritySession): OwnerLearningAuthoritySessionImpl {
    if (AUTHENTIC_OWNER_SESSIONS.get(session) !== this
      || !(session instanceof OwnerLearningAuthoritySessionImpl)) {
      throw new Error('TRANSFER_PROMOTION_OWNER_SESSION_PROVENANCE_INVALID');
    }
    return session;
  }
}

/** @internal CreativeRunCoordinator bootstrap only. */
function createCoordinatorOwnerAuthority(
  config: OwnerAuthorityBootstrapConfig,
  now: () => string,
): CoordinatorOwnerAuthority {
  return new ApplicationOwnerAuthorityRegistry(config, now);
}

const AUTHENTIC_AUTHORIZATIONS = new WeakMap<object, AuthorizationState>();
const AUTHENTIC_PROVISIONALS = new WeakSet<object>();
const AUTHENTIC_STAGES = new WeakSet<object>();
const ZERO_COUNTERS = freeze({ tasteWrites: 0, modelTrainingWrites: 0, ruleWrites: 0, contextWrites: 0 });

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function freeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) freeze(child);
  }
  return value;
}

function requireTime(value: string, code: string): number {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) throw new Error(code);
  return timestamp;
}

function orderedRules(rules: Readonly<Record<string, RevisionScalar>>): Record<string, RevisionScalar> {
  return Object.fromEntries(Object.entries(rules).sort(([left], [right]) => left.localeCompare(right)));
}

function contextSnapshot(rules: Readonly<Record<string, RevisionScalar>>): CreateContextSnapshot {
  const ordered = freeze(orderedRules(rules));
  return freeze({ rules: ordered, contextDigest: sha256(JSON.stringify({ rules: ordered })) });
}

function authenticContext(snapshot: CreateContextSnapshot): boolean {
  return snapshot.contextDigest === sha256(JSON.stringify({ rules: orderedRules(snapshot.rules) }));
}

function countersDelta(before: MutationCounters, after: MutationCounters): MutationCounters {
  return freeze({
    tasteWrites: after.tasteWrites - before.tasteWrites,
    modelTrainingWrites: after.modelTrainingWrites - before.modelTrainingWrites,
    ruleWrites: after.ruleWrites - before.ruleWrites,
    contextWrites: after.contextWrites - before.contextWrites,
  });
}

function sealReceipt<T extends object>(body: T): T & { readonly receiptDigest: string } {
  return freeze({ ...body, receiptDigest: sha256(JSON.stringify(body)) });
}

function authorizationDigest(authorization: Omit<LearningAuthorization, 'authorizationDigest'>): string {
  return sha256(JSON.stringify(authorization));
}

function provisionalDigest(provisional: Omit<ProvisionalLearningTransfer, 'provisionalDigest'>): string {
  return sha256(JSON.stringify(provisional));
}

interface TransactionCheckpoint {
  readonly context: CreateContextSnapshot;
  readonly counters: MutationCounters;
}

class CreateContextTransaction {
  #current: CreateContextSnapshot;
  #counters: MutationCounters = { ...ZERO_COUNTERS };
  #failure?: OwnerAuthorityBootstrapConfig['testOnlyTransactionFailure'];

  constructor(
    initialRules: Readonly<Record<string, RevisionScalar>> = {},
    failure?: OwnerAuthorityBootstrapConfig['testOnlyTransactionFailure'],
  ) {
    this.#current = contextSnapshot(initialRules);
    this.#failure = failure;
  }

  snapshot(): CreateContextSnapshot {
    return contextSnapshot(this.#current.rules);
  }

  counters(): MutationCounters {
    return freeze({ ...this.#counters });
  }

  checkpoint(): TransactionCheckpoint {
    return freeze({ context: this.snapshot(), counters: this.counters() });
  }

  applyAtomic(expectedPriorDigest: string, next: CreateContextSnapshot): void {
    if (!authenticContext(next)) throw new Error('NEXT_CONTEXT_TAMPERED');
    if (this.#current.contextDigest !== expectedPriorDigest) throw new Error('PRIOR_CONTEXT_CHANGED');
    this.#current = contextSnapshot(next.rules);
    this.#counters = {
      ...this.#counters,
      ruleWrites: this.#counters.ruleWrites + 1,
      contextWrites: this.#counters.contextWrites + 1,
    };
    if (this.#failure) {
      throw new Error('INJECTED_PARTIAL_TRANSFER_FAILURE');
    }
  }

  restoreExact(checkpoint: TransactionCheckpoint): void {
    // Checkpoints are minted privately before mutation; restoration is total for that type.
    this.#current = contextSnapshot(checkpoint.context.rules);
    this.#counters = { ...checkpoint.counters };
    this.#failure = undefined;
  }
}

class OwnerLearningAuthoritySessionImpl implements OwnerLearningAuthoritySession {
  readonly #packet: BlindReviewPacket;
  readonly #review: BlindReviewRecord;
  readonly #unmasked: UnmaskedReview;
  readonly #plan: ExperimentPlan;
  readonly #revision: AttributableRevisionReceipt;
  readonly #context: CreateContextTransaction;
  readonly #authorityRegistry: CoordinatorOwnerAuthority;
  readonly #now: () => string;
  readonly #authorizations = new Map<string, LearningAuthorization>();

  constructor(options: CoordinatorOwnerLearningAuthoritySessionOptions) {
    if ('context' in options) throw new Error('CREATE_CONTEXT_ADAPTER_UNSUPPORTED');
    assertAuthenticBlindReviewEvidence(options.packet, options.review, options.unmasked);
    assertAuthenticAttributableRevision(options.experimentPlan, options.revisionReceipt);
    if (!options.revisionReceipt.improvementEstablished) {
      throw new Error('LEARNING_REVISION_NOT_ESTABLISHED');
    }
    this.#packet = options.packet;
    this.#review = options.review;
    this.#unmasked = options.unmasked;
    this.#plan = options.experimentPlan;
    this.#revision = options.revisionReceipt;
    this.#authorityRegistry = options.authorityRegistry;
    this.#context = new CreateContextTransaction({}, options.testOnlyTransactionFailure);
    this.#now = options.now ?? (() => new Date().toISOString());
  }

  bindActionAuthority(input: {
    readonly ownerCapability: OwnerAuthorityCapability;
    readonly issuerCapability?: OwnerAuthorityCapability;
  }): AuthorityCapabilityBinding {
    const owner = this.#authorityRegistry.verify(input.ownerCapability, 'owner');
    const issuer = input.issuerCapability
      ? this.#authorityRegistry.verify(input.issuerCapability, 'issuer') : undefined;
    const body = {
      owner,
      ...(issuer ? { issuer } : {}),
      authorityRegistryId: this.#authorityRegistry.config.registryId,
      applicationBoundary: this.#authorityRegistry.config.applicationBoundary,
    };
    return freeze({ ...body, bindingDigest: sha256(JSON.stringify(body)) });
  }

  createContextSnapshot(): CreateContextSnapshot {
    return this.#context.snapshot();
  }

  mutationCounters(): MutationCounters {
    return this.#context.counters();
  }

  recordPreference(input: {
    readonly ownerCapability: OwnerAuthorityCapability;
    readonly blindIds: readonly [string, string];
    readonly outcome: 'preferred' | 'tie' | 'rejected';
    readonly winnerBlindId?: string;
    readonly decidedAt: string;
  }): PreferenceDecisionReceipt {
    const owner = this.#authorityRegistry.verify(input.ownerCapability, 'owner');
    requireTime(input.decidedAt, 'PREFERENCE_DECISION_TIME_INVALID');
    if (input.blindIds[0] === input.blindIds[1]) throw new Error('PREFERENCE_PAIR_INVALID');
    const candidates = input.blindIds.map((blindId) => {
      const candidate = this.#packet.candidates.find((item) => item.blindId === blindId);
      if (!candidate) throw new Error('PREFERENCE_ARTIFACT_MISMATCH');
      return freeze({ blindId, artifactDigest: candidate.artifactDigest });
    });
    if ((input.outcome === 'preferred' && !input.winnerBlindId)
      || (input.outcome !== 'preferred' && input.winnerBlindId)
      || (input.winnerBlindId && !input.blindIds.includes(input.winnerBlindId))) {
      throw new Error('PREFERENCE_OUTCOME_INVALID');
    }
    const receipt = sealReceipt({
      schema: 'sinter.owner-preference-decision' as const,
      schemaVersion: OWNER_AUTHORITY_SCHEMA_VERSION,
      owner,
      authorityRegistryId: this.#authorityRegistry.config.registryId,
      applicationBoundary: this.#authorityRegistry.config.applicationBoundary,
      packetDigest: this.#packet.packetDigest,
      candidates: freeze(candidates),
      outcome: input.outcome,
      ...(input.winnerBlindId ? { winnerBlindId: input.winnerBlindId } : {}),
      decidedAt: input.decidedAt,
      mutationCounters: ZERO_COUNTERS,
    });
    AUTHENTIC_OWNER_PREFERENCES.set(receipt, this);
    return receipt;
  }

  recordReleaseDecision(input: {
    readonly ownerCapability: OwnerAuthorityCapability;
    readonly candidateId: string;
    readonly artifactDigest: string;
    readonly decision: 'release-worthy' | 'not-release-worthy';
    readonly decidedAt: string;
  }): ReleaseDecisionReceipt {
    const owner = this.#authorityRegistry.verify(input.ownerCapability, 'owner');
    requireTime(input.decidedAt, 'RELEASE_DECISION_TIME_INVALID');
    const mapping = this.#unmasked.mappings.find((item) => item.candidateId === input.candidateId);
    const candidate = mapping
      ? this.#packet.candidates.find((item) => item.blindId === mapping.blindId)
      : undefined;
    if (!candidate || candidate.artifactDigest !== input.artifactDigest) {
      throw new Error('RELEASE_ARTIFACT_MISMATCH');
    }
    const receipt = sealReceipt({
      schema: 'sinter.owner-release-decision' as const,
      schemaVersion: OWNER_AUTHORITY_SCHEMA_VERSION,
      owner,
      authorityRegistryId: this.#authorityRegistry.config.registryId,
      applicationBoundary: this.#authorityRegistry.config.applicationBoundary,
      packetDigest: this.#packet.packetDigest,
      reviewDigest: this.#review.reviewDigest,
      candidateId: input.candidateId,
      artifactDigest: input.artifactDigest,
      decision: input.decision,
      decidedAt: input.decidedAt,
      mutationCounters: ZERO_COUNTERS,
    });
    AUTHENTIC_OWNER_RELEASES.set(receipt, this);
    return receipt;
  }

  issueLearningAuthorization(input: IssueLearningAuthorizationOptions): LearningAuthorization {
    const issuer = this.#authorityRegistry.verify(input.issuerCapability, 'issuer');
    const owner = this.#authorityRegistry.verify(input.ownerCapability, 'owner');
    const issuedAt = requireTime(input.issuedAt, 'AUTHORIZATION_ISSUED_AT_INVALID');
    const expiresAt = requireTime(input.expiresAt, 'AUTHORIZATION_EXPIRY_INVALID');
    if (expiresAt <= issuedAt) throw new Error('AUTHORIZATION_EXPIRY_INVALID');
    for (const value of [input.ruleId, input.artifactDigest, input.planDigest,
      input.revisionReceiptDigest]) {
      if (!value.trim()) throw new Error('AUTHORIZATION_SCOPE_INCOMPLETE');
    }
    const body = {
      schema: 'sinter.learning-authorization' as const,
      schemaVersion: OWNER_AUTHORITY_SCHEMA_VERSION,
      decision: input.decision,
      issuer,
      owner,
      authorityRegistryId: this.#authorityRegistry.config.registryId,
      applicationBoundary: this.#authorityRegistry.config.applicationBoundary,
      ruleId: input.ruleId,
      artifactDigest: input.artifactDigest,
      planDigest: input.planDigest,
      revisionReceiptDigest: input.revisionReceiptDigest,
      issuedAt: input.issuedAt,
      expiresAt: input.expiresAt,
      maximumTransfers: 1 as const,
      initialRevocationState: 'active' as const,
    };
    const authorization = freeze({ ...body, authorizationDigest: authorizationDigest(body) });
    if (this.#authorizations.has(authorization.authorizationDigest)) {
      throw new Error('AUTHORIZATION_DUPLICATE');
    }
    AUTHENTIC_AUTHORIZATIONS.set(authorization, { revoked: false, consumed: false });
    this.#authorizations.set(authorization.authorizationDigest, authorization);
    return authorization;
  }

  revokeLearningAuthorization(authorization: LearningAuthorization): Readonly<{
    authorizationDigest: string; state: 'revoked'; revokedAt: string;
    priorMutationCounters: MutationCounters; resultingMutationCounters: MutationCounters;
    receiptDigest: string;
  }> {
    const priorMutationCounters = this.#context.counters();
    const state = this.#authorizationState(authorization);
    if (state.consumed) throw new Error('AUTHORIZATION_ALREADY_CONSUMED');
    state.revoked = true;
    return sealReceipt({
      authorizationDigest: authorization.authorizationDigest,
      state: 'revoked' as const,
      revokedAt: this.#now(),
      priorMutationCounters,
      resultingMutationCounters: this.#context.counters(),
    });
  }

  authorizationState(authorization: LearningAuthorization): 'active' | 'revoked' | 'consumed' {
    const state = this.#authorizationState(authorization);
    return state.consumed ? 'consumed' : state.revoked ? 'revoked' : 'active';
  }

  stageLearningTransfer(
    authorization: LearningAuthorization | undefined,
    ruleId: string,
  ): LearningStageReceipt {
    const reason = this.#validateAuthorization(authorization, ruleId);
    if (reason) return this.#stageTerminal(reason);
    const prior = this.#context.snapshot();
    if (!authenticContext(prior)) return this.#stageTerminal('PRIOR_CONTEXT_TAMPERED');
    const value = this.#revisionValue(ruleId);
    const next = contextSnapshot({ ...prior.rules, [ruleId]: value });
    const body = {
      schema: 'sinter.provisional-learning-transfer' as const,
      schemaVersion: OWNER_AUTHORITY_SCHEMA_VERSION,
      authorizationDigest: authorization!.authorizationDigest,
      ruleId,
      ruleValue: value,
      artifactDigest: this.#revision.revisedState.artifactDigest,
      planDigest: this.#plan.planDigest,
      revisionReceiptDigest: this.#revision.receiptDigest,
      priorContext: prior,
      nextContext: next,
    };
    const provisional = freeze({ ...body, provisionalDigest: provisionalDigest(body) });
    AUTHENTIC_PROVISIONALS.add(provisional);
    const stage = sealReceipt({
      schema: 'sinter.learning-stage-receipt' as const,
      schemaVersion: OWNER_AUTHORITY_SCHEMA_VERSION,
      status: 'staged' as const,
      reason: 'STAGED' as const,
      persistenceBoundary: OWNER_LEARNING_PERSISTENCE_BOUNDARY,
      provisional,
      mutationCounters: ZERO_COUNTERS,
    });
    AUTHENTIC_STAGES.add(stage);
    return stage;
  }

  #stageTerminal(reason: LearningTerminalReason): LearningStageReceipt {
    return sealReceipt({
      schema: 'sinter.learning-stage-receipt' as const,
      schemaVersion: OWNER_AUTHORITY_SCHEMA_VERSION,
      status: 'terminal' as const,
      reason,
      persistenceBoundary: OWNER_LEARNING_PERSISTENCE_BOUNDARY,
      mutationCounters: ZERO_COUNTERS,
    });
  }

  #revisionValue(ruleId: string): RevisionScalar {
    const treatment = this.#plan.treatment;
    if (treatment.targetKind !== 'principle' || treatment.targetId !== ruleId) {
      throw new Error('AUTHORIZATION_SCOPE_MISMATCH');
    }
    const value = this.#revision.revisedState.principles[ruleId];
    if (value === undefined) throw new Error('REVISION_RULE_VALUE_MISSING');
    return value;
  }

  #authorizationState(authorization: LearningAuthorization): AuthorizationState {
    const { authorizationDigest: claimed, ...body } = authorization;
    if (authorizationDigest(body) !== claimed) throw new Error('AUTHORIZATION_DIGEST_MISMATCH');
    const state = AUTHENTIC_AUTHORIZATIONS.get(authorization);
    if (!state || this.#authorizations.get(claimed) !== authorization) {
      throw new Error('AUTHORIZATION_PROVENANCE_INVALID');
    }
    return state;
  }

  #validateAuthorization(
    authorization: LearningAuthorization | undefined,
    ruleId: string,
  ): LearningTerminalReason | null {
    if (!authorization) return 'AUTHORIZATION_MISSING';
    const { authorizationDigest: claimed, ...body } = authorization;
    if (authorizationDigest(body) !== claimed) return 'AUTHORIZATION_DIGEST_MISMATCH';
    const state = AUTHENTIC_AUTHORIZATIONS.get(authorization);
    if (!state || this.#authorizations.get(claimed) !== authorization) {
      return 'AUTHORIZATION_PROVENANCE_INVALID';
    }
    if (authorization.authorityRegistryId !== this.#authorityRegistry.config.registryId
      || authorization.applicationBoundary !== this.#authorityRegistry.config.applicationBoundary) {
      return 'AUTHORIZATION_PROVENANCE_INVALID';
    }
    if (authorization.decision !== 'allow') return 'AUTHORIZATION_DENIED';
    if (state.revoked) return 'AUTHORIZATION_REVOKED';
    if (state.consumed) return 'AUTHORIZATION_ALREADY_CONSUMED';
    if (Date.parse(this.#now()) < Date.parse(authorization.issuedAt)) {
      return 'AUTHORIZATION_NOT_YET_VALID';
    }
    if (Date.parse(this.#now()) >= Date.parse(authorization.expiresAt)) {
      return 'AUTHORIZATION_EXPIRED';
    }
    if (authorization.ruleId !== ruleId || this.#plan.treatment.targetId !== ruleId) {
      return 'AUTHORIZATION_SCOPE_MISMATCH';
    }
    if (authorization.artifactDigest !== this.#revision.revisedState.artifactDigest) {
      return 'AUTHORIZATION_ARTIFACT_MISMATCH';
    }
    if (authorization.planDigest !== this.#plan.planDigest) {
      return 'AUTHORIZATION_PLAN_MISMATCH';
    }
    if (authorization.revisionReceiptDigest !== this.#revision.receiptDigest) {
      return 'AUTHORIZATION_RECEIPT_MISMATCH';
    }
    return null;
  }

  transferLearning(provisional: ProvisionalLearningTransfer): LearningTransferReceipt {
    const before = this.#context.counters();
    const { provisionalDigest: claimed, ...body } = provisional;
    if (provisionalDigest(body) !== claimed) {
      return this.#transferTerminal('PROVISIONAL_DIGEST_MISMATCH', provisional, before);
    }
    if (!AUTHENTIC_PROVISIONALS.has(provisional)) {
      return this.#transferTerminal('PROVISIONAL_PROVENANCE_INVALID', provisional, before);
    }
    const authorization = this.#authorizations.get(provisional.authorizationDigest);
    const authorizationReason = this.#validateAuthorization(authorization, provisional.ruleId);
    if (authorizationReason) {
      if (authorizationReason === 'AUTHORIZATION_REVOKED'
        && provisional.priorContext && authenticContext(provisional.priorContext)) {
        const current = this.#context.snapshot();
        if (current.contextDigest === provisional.priorContext.contextDigest) {
          const rollbackReceipt = sealReceipt({
            persistenceBoundary: OWNER_LEARNING_PERSISTENCE_BOUNDARY,
            priorContextDigest: provisional.priorContext.contextDigest,
            restoredContextDigest: current.contextDigest,
            priorMutationCounters: before,
            restoredMutationCounters: this.#context.counters(),
            restored: true as const,
          });
          return this.#transferTerminal(authorizationReason, provisional, before, rollbackReceipt);
        }
      }
      return this.#transferTerminal(authorizationReason, provisional, before);
    }
    if (provisional.artifactDigest !== this.#revision.revisedState.artifactDigest) {
      return this.#transferTerminal('AUTHORIZATION_ARTIFACT_MISMATCH', provisional, before);
    }
    if (provisional.planDigest !== this.#plan.planDigest) {
      return this.#transferTerminal('AUTHORIZATION_PLAN_MISMATCH', provisional, before);
    }
    if (provisional.revisionReceiptDigest !== this.#revision.receiptDigest) {
      return this.#transferTerminal('AUTHORIZATION_RECEIPT_MISMATCH', provisional, before);
    }
    if (!authenticContext(provisional.priorContext) || !authenticContext(provisional.nextContext)) {
      return this.#transferTerminal('PROVISIONAL_DIGEST_MISMATCH', provisional, before);
    }
    const current = this.#context.snapshot();
    if (!authenticContext(current)) {
      return this.#transferTerminal('PRIOR_CONTEXT_TAMPERED', provisional, before);
    }
    if (current.contextDigest !== provisional.priorContext.contextDigest) {
      return this.#transferTerminal('PRIOR_CONTEXT_CHANGED', provisional, before);
    }
    return this.#commitTransfer(provisional, authorization!, before);
  }

  bindTransferPromotionPrerequisites(input: {
    readonly authorization: LearningAuthorization;
    readonly stage: LearningStageReceipt;
  }): Readonly<{
    provisional: ProvisionalLearningTransfer;
    authorization: LearningAuthorization;
    plan: ExperimentPlan;
    revision: AttributableRevisionReceipt;
  }> {
    const reason = this.#validateAuthorization(input.authorization, this.#plan.treatment.targetId);
    if (reason) throw new Error(`TRANSFER_PROMOTION_${reason}`);
    const { receiptDigest: claimedStageDigest, ...stageBody } = input.stage;
    if (!AUTHENTIC_STAGES.has(input.stage)
      || sha256(JSON.stringify(stageBody)) !== claimedStageDigest
      || input.stage.status !== 'staged' || !input.stage.provisional) {
      throw new Error('TRANSFER_PROMOTION_STAGE_PROVENANCE_INVALID');
    }
    const provisional = input.stage.provisional;
    const { provisionalDigest: claimedProvisionalDigest, ...provisionalBody } = provisional;
    if (!AUTHENTIC_PROVISIONALS.has(provisional)
      || provisionalDigest(provisionalBody) !== claimedProvisionalDigest) {
      throw new Error('TRANSFER_PROMOTION_PROVISIONAL_PROVENANCE_INVALID');
    }
    if (provisional.authorizationDigest !== input.authorization.authorizationDigest
      || provisional.ruleId !== this.#plan.treatment.targetId
      || provisional.ruleValue !== this.#plan.treatment.after
      || provisional.planDigest !== this.#plan.planDigest
      || provisional.revisionReceiptDigest !== this.#revision.receiptDigest
      || provisional.artifactDigest !== this.#revision.revisedState.artifactDigest) {
      throw new Error('TRANSFER_PROMOTION_PREREQUISITE_BINDING_MISMATCH');
    }
    return freeze({
      provisional,
      authorization: input.authorization,
      plan: this.#plan,
      revision: this.#revision,
    });
  }

  #commitTransfer(
    provisional: ProvisionalLearningTransfer,
    authorization: LearningAuthorization,
    before: MutationCounters,
  ): LearningTransferReceipt {
    const immediateReason = this.#validateAuthorization(authorization, provisional.ruleId);
    if (immediateReason) return this.#transferTerminal(immediateReason, provisional, before);
    const checkpoint = this.#context.checkpoint();
    try {
      this.#context.applyAtomic(provisional.priorContext.contextDigest, provisional.nextContext);
      AUTHENTIC_AUTHORIZATIONS.get(authorization)!.consumed = true;
      const resulting = this.#context.snapshot();
      if (resulting.contextDigest !== provisional.nextContext.contextDigest) {
        throw new Error('TRANSFER_RESULT_MISMATCH');
      }
      return sealReceipt({
        schema: 'sinter.learning-transfer-receipt' as const,
        schemaVersion: OWNER_AUTHORITY_SCHEMA_VERSION,
        status: 'transferred' as const,
        reason: 'TRANSFERRED' as const,
        persistenceBoundary: OWNER_LEARNING_PERSISTENCE_BOUNDARY,
        authorizationDigest: authorization.authorizationDigest,
        priorContextDigest: provisional.priorContext.contextDigest,
        resultingContextDigest: resulting.contextDigest,
        mutationCounters: countersDelta(before, this.#context.counters()),
      });
    } catch {
      AUTHENTIC_AUTHORIZATIONS.get(authorization)!.consumed = false;
      this.#context.restoreExact(checkpoint);
      const restored = this.#context.snapshot();
      const restoredCounters = this.#context.counters();
      if (restored.contextDigest !== checkpoint.context.contextDigest
        || JSON.stringify(restoredCounters) !== JSON.stringify(before)) {
        return this.#transferTerminal(
          'TRANSFER_ROLLBACK_CATASTROPHIC', provisional, before,
        );
      }
      const rollbackReceipt = sealReceipt({
        persistenceBoundary: OWNER_LEARNING_PERSISTENCE_BOUNDARY,
        priorContextDigest: provisional.priorContext.contextDigest,
        restoredContextDigest: restored.contextDigest,
        priorMutationCounters: checkpoint.counters,
        restoredMutationCounters: restoredCounters,
        restored: true as const,
      });
      return this.#transferTerminal(
        'TRANSFER_FAILED_ROLLED_BACK', provisional, before, rollbackReceipt,
      );
    }
  }

  #transferTerminal(
    reason: LearningTerminalReason,
    provisional: ProvisionalLearningTransfer,
    before: MutationCounters,
    rollbackReceipt?: RollbackReceipt,
  ): LearningTransferReceipt {
    const resulting = this.#context.snapshot();
    return sealReceipt({
      schema: 'sinter.learning-transfer-receipt' as const,
      schemaVersion: OWNER_AUTHORITY_SCHEMA_VERSION,
      status: 'terminal' as const,
      reason,
      persistenceBoundary: OWNER_LEARNING_PERSISTENCE_BOUNDARY,
      authorizationDigest: provisional.authorizationDigest || null,
      priorContextDigest: provisional.priorContext?.contextDigest ?? null,
      resultingContextDigest: resulting.contextDigest,
      mutationCounters: countersDelta(before, this.#context.counters()),
      ...(rollbackReceipt ? { rollbackReceipt } : {}),
    });
  }
}

/** Internal provenance boundary for owner actions consumed by durable closure. */
export function assertAuthenticOwnerDecisionReceipts(
  session: OwnerLearningAuthoritySession,
  preference: PreferenceDecisionReceipt,
  release: ReleaseDecisionReceipt,
): void {
  const ownerSession = session instanceof OwnerLearningAuthoritySessionImpl ? session : undefined;
  if (!ownerSession || !AUTHENTIC_OWNER_SESSIONS.has(session) || AUTHENTIC_OWNER_PREFERENCES.get(preference) !== ownerSession
    || AUTHENTIC_OWNER_RELEASES.get(release) !== ownerSession
    || preference.owner.id !== release.owner.id || preference.owner.assertionDigest !== release.owner.assertionDigest
    || preference.packetDigest !== release.packetDigest) {
    throw new Error('CAMPAIGN_CLOSURE_OWNER_ACTION_PROVENANCE_INVALID');
  }
}

// ---------------------------------------------------------------------------
// W8-16 / Forgejo #686 — Transfer Promotion Gate implementation.
// ---------------------------------------------------------------------------

const AUTHENTIC_FREEZES = new WeakSet<object>();
interface PromotionArtifactBinding {
  readonly creativeBytes: string;
  readonly creativeDigest: string;
  readonly artifactDigest: string;
  readonly createRunId: string;
  readonly arm: 'treatment' | 'control';
  readonly sealedBrief: SealedPromotionBrief;
  readonly sourceArtifactDigest: string;
  readonly revisionReceiptDigest: string;
  readonly experimentRunId: string;
  readonly briefDigest: string;
  readonly routeDigest: string;
  readonly budgetDigest: string;
  readonly causalInputDigest: string;
  readonly appliesAuthorizedRevision: boolean;
}
interface TransferOwnerSessionBinding {
  readonly session: OwnerLearningAuthoritySessionImpl;
  readonly authorityRegistry: CoordinatorOwnerAuthority;
  readonly provisional: ProvisionalLearningTransfer;
  readonly authorization: LearningAuthorization;
  readonly plan: ExperimentPlan;
  readonly revision: AttributableRevisionReceipt;
}
interface SealedBriefBinding {
  readonly ownerSession: TransferPromotionOwnerSessionHandle;
  readonly content: string;
  readonly sourceArtifactDigest: string;
  readonly revisionReceiptDigest: string;
}
const AUTHENTIC_TRANSFER_OWNER_HANDLES = new WeakMap<object, TransferOwnerSessionBinding>();
const AUTHENTIC_SEALED_BRIEFS = new WeakMap<object, SealedBriefBinding>();
const AUTHENTIC_PROMOTION_ARTIFACTS = new WeakMap<object, PromotionArtifactBinding>();
const AUTHENTIC_PACKETS = new WeakMap<object, {
  readonly gate: TransferPromotionGateSessionImpl;
  readonly treatment: PromotionArtifactBinding;
  readonly control: PromotionArtifactBinding;
  readonly treatmentBlindId: string;
  readonly controlBlindId: string;
  readonly packetDigest: string;
  readonly evidenceBindings: Readonly<Record<string, string>>;
}>();
const AUTHENTIC_BLINDED_REVIEWS = new WeakMap<object, {
  readonly gate: TransferPromotionGateSessionImpl;
  readonly packet: PromotionComparisonPacket;
  readonly preferredBlindId: string;
}>();
const AUTHENTIC_DECISIONS = new WeakMap<object, TransferPromotionGateSessionImpl>();
const PROMOTED_DECISIONS = new WeakSet<object>();
const AUTHENTIC_GATE_SESSIONS = new WeakSet<object>();
const CONSUMED_PROMOTION_PACKETS = new WeakSet<object>();

function freezeDigestOf(body: Omit<TransferPromotionFreeze, 'freezeDigest'>): string {
  return sha256(JSON.stringify(body));
}

function packetDigestOf(body: Omit<PromotionComparisonPacket, 'packetDigest'>): string {
  return sha256(JSON.stringify(body));
}

function comparisonDigestOf(body: Omit<TransferPromotionComparison, 'comparisonDigest'>): string {
  return sha256(JSON.stringify(body));
}

function decisionDigestOf(body: Omit<TransferPromotionDecision, 'decisionDigest'>): string {
  return sha256(JSON.stringify(body));
}

function promotionDigestOf(body: Omit<TransferPromotionReceipt, 'promotionDigest'>): string {
  return sha256(JSON.stringify(body));
}

function htmlDataUri(html: string): string {
  return `data:text/html;base64,${Buffer.from(html).toString('base64')}`;
}

function validatePromotionArtifact(creativeBytes: string): void {
  if (!creativeBytes.trim() || !/<html\b/i.test(creativeBytes)
    || !/<body\b/i.test(creativeBytes)) {
    throw new Error('TRANSFER_PROMOTION_ARTIFACT_UNSUPPORTED');
  }
}

function visualMediaOf(
  artifact: PromotionArtifactBinding,
  evidenceBinding: string,
): CanonicalMediaReference {
  return freeze({
    modality: 'visual' as const,
    sourceCandidateArtifactDigest: evidenceBinding,
    digest: sha256(`review-media:${evidenceBinding}:${randomUUID()}`),
    mimeType: 'text/html',
    byteLength: Buffer.byteLength(artifact.creativeBytes),
    playableUri: htmlDataUri(artifact.creativeBytes),
  });
}

function comparisonContactSheet(candidates: readonly PromotionComparisonCandidate[]): string {
  const figures = candidates.map((candidate) => {
    const visual = candidate.media.find((media) => media.modality === 'visual');
    const frame = visual
      ? `<iframe title="${candidate.blindId}" src="${visual.playableUri}"></iframe>`
      : '<div class="missing">visual media missing</div>';
    return `<figure data-blind-id="${candidate.blindId}">${frame}<figcaption>${candidate.blindId}</figcaption></figure>`;
  }).join('');
  return '<!doctype html><html><head><meta charset="utf-8"><title>Promotion comparison</title>'
    + '<style>body{background:#090b10;color:#eef;display:grid;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));gap:16px;padding:24px}figure{margin:0;border:1px solid #394050;padding:12px}iframe{width:100%;height:240px;border:0}</style>'
    + `</head><body>${figures}</body></html>`;
}

function effectiveCreativeBytes(bytes: string): string {
  let current = bytes;
  for (let depth = 0; depth < 3; depth += 1) {
    const encoded = /data:text\/html;base64,([A-Za-z0-9+/=]+)/.exec(current)?.[1];
    if (!encoded) break;
    const decoded = Buffer.from(encoded, 'base64').toString('utf8');
    if (!decoded.trim()) break;
    current = decoded;
  }
  return current;
}

/**
 * Deterministic 6-dimension similarity fingerprint for a canonical artifact.
 * Each dimension is a content hash over a distinct facet of the creative bytes:
 * palette (colors), motif (body text signature), geometry (CSS property set),
 * rhythm (animation/timing — static for the supported HTML subset), source
 * (source artifact digest), and graph-topology (DOM tag nesting shape).
 */
function fingerprintOf(artifact: PromotionArtifactBinding): SimilarityFingerprint {
  const bytes = effectiveCreativeBytes(artifact.creativeBytes);
  const tagShape = bytes.replace(/[^<>]/g, '').replace(/<>/g, '<>');
  const bodyMatch = /<body>([\s\S]*?)<\/body>/i.exec(bytes);
  const bodyText = (bodyMatch?.[1] ?? '').replace(/<[^>]*>/g, '').trim();
  const styleMatch = /<style>([\s\S]*?)<\/style>/i.exec(bytes);
  const cssText = styleMatch?.[1] ?? '';
  const geometryProperties = cssText.split(';').map((decl) => {
    const colon = decl.indexOf(':');
    return colon > 0 ? decl.slice(0, colon).trim().toLowerCase() : '';
  }).filter(Boolean).sort();
  const rhythm = /animation|transition|@keyframes/i.test(cssText)
    ? sha256(cssText) : sha256('static-no-animation');
  const dimensions = freeze({
    palette: sha256([...tokensForDimension(artifact, 'palette')].sort().join('|')),
    motif: sha256(bodyText),
    geometry: sha256(geometryProperties.join('|')),
    rhythm,
    source: sha256(bytes.replace(/\s+/g, ' ').trim()),
    'graph-topology': sha256(tagShape),
  }) as Readonly<Record<SimilarityDimension, string>>;
  return freeze({ dimensions, fingerprintDigest: sha256(JSON.stringify(dimensions)) });
}

function tokensForDimension(
  artifact: PromotionArtifactBinding,
  dimension: SimilarityDimension,
): ReadonlySet<string> {
  const html = effectiveCreativeBytes(artifact.creativeBytes).toLowerCase();
  const css = /<style[^>]*>([\s\S]*?)<\/style>/i.exec(html)?.[1] ?? '';
  const body = /<body[^>]*>([\s\S]*?)<\/body>/i.exec(html)?.[1] ?? '';
  const matches = (pattern: RegExp, value = html) => new Set(value.match(pattern) ?? []);
  switch (dimension) {
    case 'palette': return matches(/#[0-9a-f]{3,8}\b|(?:rgb|hsl)a?\([^)]*\)/g);
    case 'motif': return matches(/[a-z0-9]+/g, body.replace(/<[^>]+>/g, ' '));
    case 'geometry': return matches(/(?:display|position|grid|flex|width|height|margin|padding|transform|border-radius)\s*:[^;}]+/g, css);
    case 'rhythm': return matches(/(?:animation|transition)[^;}]*|@keyframes\s+[a-z0-9_-]+|\b\d+(?:\.\d+)?m?s\b/g, css);
    case 'source': return matches(/[a-z][a-z0-9_-]+|#[0-9a-f]{3,8}\b/g);
    case 'graph-topology': return matches(/<\/?[a-z][a-z0-9-]*/g);
  }
}

function jaccard(left: ReadonlySet<string>, right: ReadonlySet<string>): number | null {
  if (left.size === 0 || right.size === 0) return null;
  let intersection = 0;
  for (const value of left) if (right.has(value)) intersection += 1;
  return intersection / new Set([...left, ...right]).size;
}

const SIMILARITY_THRESHOLDS: Readonly<Record<SimilarityDimension, number>> = freeze({
  palette: 0.75, motif: 0.75, geometry: 0.8,
  rhythm: 0.8, source: 1, 'graph-topology': 0.85,
});

function assessSimilarity(
  treatment: PromotionArtifactBinding,
  control: PromotionArtifactBinding,
): readonly SimilarityDimensionAssessment[] {
  return freeze(SIMILARITY_DIMENSIONS.map((dimension) => {
    const left = tokensForDimension(treatment, dimension);
    const right = tokensForDimension(control, dimension);
    const score = jaccard(left, right);
    const threshold = SIMILARITY_THRESHOLDS[dimension];
    const body = {
      dimension, score: score ?? 1, threshold,
      status: score === null ? 'unassessable' as const
        : score >= threshold ? 'near-copy' as const : 'distinct' as const,
    };
    return freeze({ ...body, evidenceDigest: sha256(JSON.stringify({
      ...body, left: [...left].sort(), right: [...right].sort(),
    })) });
  }));
}

function similarityPolicy(assessments: readonly SimilarityDimensionAssessment[]): {
  copied: readonly SimilarityDimension[]; aggregate: number; collapse: boolean;
} {
  const copied = assessments.filter((item) => item.status !== 'distinct')
    .map((item) => item.dimension);
  const aggregate = assessments.reduce((sum, item) => sum + item.score, 0) / assessments.length;
  const unassessable = assessments.some((item) => item.status === 'unassessable');
  return freeze({ copied, aggregate, collapse: unassessable || copied.length >= 4 || aggregate >= 0.8 });
}

function blindedOutcome(
  judgment: BlindedComparisonJudgment,
  mapping: { readonly treatmentBlindId: string; readonly controlBlindId: string },
): PromotionReviewOutcome {
  if (judgment.preferredBlindId === mapping.treatmentBlindId) return 'treatment-preferred';
  if (judgment.preferredBlindId === mapping.controlBlindId) return 'control-preferred';
  return 'inconclusive';
}

function ownerOutcome(judgment: OwnerComparisonJudgment): PromotionReviewOutcome {
  if (judgment.preferredArtifact === 'treatment') return 'treatment-preferred';
  if (judgment.preferredArtifact === 'control') return 'control-preferred';
  return 'inconclusive';
}

class TransferPromotionGateSessionImpl {
  readonly freeze: TransferPromotionFreeze;
  readonly #authorityRegistry: CoordinatorOwnerAuthority;
  readonly #authority: OwnerLearningAuthoritySessionImpl;
  readonly #authorization: LearningAuthorization;
  readonly #provisional: ProvisionalLearningTransfer;
  readonly #treatment: PromotionArtifactBinding;
  readonly #control: PromotionArtifactBinding;
  readonly #applyPromotion: (ruleId: string, value: RevisionScalar) => void;
  readonly #now: () => string;
  #reviewOpened = false;
  #latestDecision?: TransferPromotionDecision;

  constructor(
    options: TransferPromotionGateOptions,
    owner: TransferOwnerSessionBinding,
    brief: SealedBriefBinding,
    treatment: PromotionArtifactBinding,
    control: PromotionArtifactBinding,
    applyPromotion: (ruleId: string, value: RevisionScalar) => void,
    now: () => string,
  ) {
    for (const text of [
      options.sealedBrief.runId, options.sealedBrief.briefDigest, options.applicability,
      options.experimentalScope, options.evidenceProtocol,
    ]) {
      if (!text.trim()) throw new Error('TRANSFER_PROMOTION_FREEZE_INPUT_INCOMPLETE');
    }
    if (brief.ownerSession !== options.ownerSession
      || treatment.sealedBrief !== options.sealedBrief
      || control.sealedBrief !== options.sealedBrief
      || treatment.arm !== 'treatment' || control.arm !== 'control'
      || treatment.createRunId === control.createRunId
      || treatment.experimentRunId !== options.sealedBrief.runId
      || control.experimentRunId !== options.sealedBrief.runId
      || treatment.sourceArtifactDigest !== brief.sourceArtifactDigest
      || control.sourceArtifactDigest !== brief.sourceArtifactDigest
      || treatment.revisionReceiptDigest !== owner.revision.receiptDigest
      || control.revisionReceiptDigest !== owner.revision.receiptDigest
      || treatment.briefDigest !== options.sealedBrief.briefDigest
      || control.briefDigest !== options.sealedBrief.briefDigest
      || treatment.routeDigest !== control.routeDigest
      || treatment.budgetDigest !== control.budgetDigest
      || !treatment.appliesAuthorizedRevision || control.appliesAuthorizedRevision
      || options.treatmentArtifact.causalInputDigest !== treatment.causalInputDigest
      || options.controlArtifact.causalInputDigest !== control.causalInputDigest) {
      throw new Error('TRANSFER_PROMOTION_ARTIFACT_PROVENANCE_INVALID');
    }
    if (treatment.artifactDigest === control.artifactDigest) {
      throw new Error('TRANSFER_PROMOTION_TREATMENT_CONTROL_IDENTICAL');
    }
    const gateSessionId = sha256(`${options.sealedBrief.runId}:${randomUUID()}`);
    const body = {
      schema: 'sinter.transfer-promotion-freeze' as const,
      schemaVersion: TRANSFER_PROMOTION_SCHEMA_VERSION,
      ruleId: owner.provisional.ruleId,
      ruleValue: owner.provisional.ruleValue,
      runId: options.sealedBrief.runId,
      gateSessionId,
      applicability: options.applicability,
      experimentalScope: options.experimentalScope,
      evidenceProtocol: options.evidenceProtocol,
      ownerAuthorizationDigest: owner.authorization.authorizationDigest,
      sealedBriefDigest: options.sealedBrief.briefDigest,
      routeDigest: treatment.routeDigest,
      budgetDigest: treatment.budgetDigest,
      treatmentCausalInputDigest: treatment.causalInputDigest,
      controlCausalInputDigest: control.causalInputDigest,
      transferReceiptDigest: owner.provisional.provisionalDigest,
      planDigest: owner.plan.planDigest,
      revisionReceiptDigest: owner.revision.receiptDigest,
    };
    this.freeze = freeze({ ...body, freezeDigest: freezeDigestOf(body) });
    AUTHENTIC_FREEZES.add(this.freeze);
    this.#authorityRegistry = owner.authorityRegistry;
    this.#authority = owner.session;
    this.#authorization = owner.authorization;
    this.#provisional = owner.provisional;
    this.#treatment = treatment;
    this.#control = control;
    this.#applyPromotion = applyPromotion;
    this.#now = now;
    AUTHENTIC_GATE_SESSIONS.add(this);
  }

  openReviewerSink(reviewerCapability: OwnerAuthorityCapability): TransferPromotionReviewerSink {
    if (this.#reviewOpened) throw new Error('TRANSFER_PROMOTION_REVIEW_ALREADY_OPENED');
    const reviewer = this.#authorityRegistry.verify(reviewerCapability, 'reviewer');
    if (sameAuthority(reviewer, this.#authorization.owner)
      || sameAuthority(reviewer, this.#authorization.issuer)
      || reviewer.id === this.#authorization.owner.id
      || reviewer.id === this.#authorization.issuer.id) {
      throw new Error('TRANSFER_PROMOTION_REVIEWER_NOT_INDEPENDENT');
    }
    const treatmentBlindId = `blind-${sha256(randomUUID()).slice(0, 24)}`;
    const controlBlindId = `blind-${sha256(randomUUID()).slice(0, 24)}`;
    if (treatmentBlindId === controlBlindId) throw new Error('TRANSFER_PROMOTION_BLIND_ID_COLLISION');
    const treatmentEvidence = `evidence-${sha256(randomUUID()).slice(0, 32)}`;
    const controlEvidence = `evidence-${sha256(randomUUID()).slice(0, 32)}`;
    const unordered = [
      freeze({
        blindId: treatmentBlindId, evidenceBinding: treatmentEvidence,
        media: [visualMediaOf(this.#treatment, treatmentEvidence)],
      }),
      freeze({
        blindId: controlBlindId, evidenceBinding: controlEvidence,
        media: [visualMediaOf(this.#control, controlEvidence)],
      }),
    ] as PromotionComparisonCandidate[];
    const orderKey = sha256(randomUUID());
    const candidates = freeze(orderKey.charCodeAt(0) % 2 === 0
      ? unordered : [unordered[1]!, unordered[0]!]);
    const candidateSetDigest = sha256(JSON.stringify(candidates.map((item) => ({
      blindId: item.blindId, evidenceBinding: item.evidenceBinding,
    }))));
    const body = {
      schema: 'sinter.promotion-comparison-packet' as const,
      schemaVersion: TRANSFER_PROMOTION_SCHEMA_VERSION,
      freezeDigest: this.freeze.freezeDigest,
      gateSessionId: this.freeze.gateSessionId,
      candidateSetDigest,
      candidates,
      contactSheetHtml: comparisonContactSheet(candidates),
    };
    const packet = freeze({ ...body, packetDigest: packetDigestOf(body) });
    AUTHENTIC_PACKETS.set(packet, {
      gate: this, treatment: this.#treatment, control: this.#control,
      treatmentBlindId, controlBlindId,
      packetDigest: packet.packetDigest,
      evidenceBindings: freeze({
        [treatmentBlindId]: treatmentEvidence,
        [controlBlindId]: controlEvidence,
      }),
    });
    this.#reviewOpened = true;
    let submitted = false;
    return freeze({
      packet,
      submit: (input: { readonly preferredBlindId: string; readonly claim: string }) => {
        if (submitted) throw new Error('TRANSFER_PROMOTION_REVIEW_REPLAYED');
        const mapping = AUTHENTIC_PACKETS.get(packet);
        const evidenceBinding = mapping?.evidenceBindings[input.preferredBlindId];
        if (!mapping || mapping.gate !== this || !evidenceBinding
          || !input.claim.trim()) {
          throw new Error('TRANSFER_PROMOTION_BLINDED_JUDGMENT_SCOPE_INVALID');
        }
        const reviewBody = {
          schema: 'sinter.blinded-promotion-review' as const,
          reviewer,
          preferredBlindId: input.preferredBlindId,
          packetDigest: packet.packetDigest,
          evidenceBinding,
          claim: input.claim.trim(),
        };
        const review = freeze({
          ...reviewBody, reviewDigest: sha256(JSON.stringify(reviewBody)),
        });
        AUTHENTIC_BLINDED_REVIEWS.set(review, {
          gate: this, packet, preferredBlindId: input.preferredBlindId,
        });
        submitted = true;
        return review;
      },
    });
  }

  evaluate(input: {
    readonly blindedJudgment: BlindedComparisonJudgment;
    readonly ownerCapability: OwnerAuthorityCapability;
    readonly ownerJudgment: Pick<OwnerComparisonJudgment, 'preferredArtifact' | 'claim'>;
  }): TransferPromotionDecision {
    const reviewBinding = AUTHENTIC_BLINDED_REVIEWS.get(input.blindedJudgment);
    if (!reviewBinding || reviewBinding.gate !== this) {
      throw new Error('TRANSFER_PROMOTION_REVIEW_PROVENANCE_INVALID');
    }
    const packet = reviewBinding.packet;
    const mapping = AUTHENTIC_PACKETS.get(packet);
    if (!mapping || mapping.gate !== this) {
      throw new Error('TRANSFER_PROMOTION_REVIEW_PROVENANCE_INVALID');
    }
    if (packetDigestOf(stripDigest(packet)) !== packet.packetDigest) {
      throw new Error('TRANSFER_PROMOTION_PACKET_DIGEST_MISMATCH');
    }
    if (CONSUMED_PROMOTION_PACKETS.has(packet)) {
      throw new Error('TRANSFER_PROMOTION_PACKET_REPLAYED');
    }
    const ownerIdentity = this.#authorityRegistry.verify(input.ownerCapability, 'owner');
    if (!sameAuthority(ownerIdentity, this.#authorization.owner)) {
      throw new Error('TRANSFER_PROMOTION_OWNER_IDENTITY_MISMATCH');
    }
    if (!input.ownerJudgment.claim.trim()) {
      throw new Error('TRANSFER_PROMOTION_OWNER_JUDGMENT_INCOMPLETE');
    }
    const selected = input.ownerJudgment.preferredArtifact === 'treatment'
      ? mapping.treatment : mapping.control;
    const ownerJudgment: OwnerComparisonJudgment = freeze({
      ...input.ownerJudgment,
      treatmentArtifactDigest: mapping.treatment.artifactDigest,
      controlArtifactDigest: mapping.control.artifactDigest,
      evidenceDigest: selected.creativeDigest,
    });
    const treatmentFingerprint = fingerprintOf(mapping.treatment);
    const controlFingerprint = fingerprintOf(mapping.control);
    const assessments = assessSimilarity(mapping.treatment, mapping.control);
    const similarity = similarityPolicy(assessments);
    const copyingDetected = similarity.collapse;
    const blinded = blindedOutcome(input.blindedJudgment, mapping);
    const owner = ownerOutcome(ownerJudgment);
    const evidenceSupports = blinded === 'treatment-preferred'
      && owner === 'treatment-preferred';
    const reason: TransferPromotionDecisionReason = copyingDetected
      ? 'COPYING_DETECTED'
      : !evidenceSupports
        ? blinded !== 'treatment-preferred'
          ? 'BLINDED_REVIEW_REJECTED_TREATMENT'
          : 'OWNER_REJECTED_TREATMENT'
        : 'TREATMENT_PREFERRED';
    const status: 'preferred' | 'rejected' = reason === 'TREATMENT_PREFERRED' ? 'preferred' : 'rejected';
    const comparisonBody = {
      treatmentArtifactDigest: mapping.treatment.artifactDigest,
      controlArtifactDigest: mapping.control.artifactDigest,
      treatmentFingerprint,
      controlFingerprint,
      copiedDimensions: freeze([...similarity.copied]),
      dimensionAssessments: assessments,
      aggregateSimilarity: similarity.aggregate,
      houseStyleCollapse: similarity.collapse,
      copyingDetected,
      blindedReviewOutcome: blinded,
      ownerReviewOutcome: owner,
      evidenceSupportsTreatment: evidenceSupports,
    };
    const comparison = freeze({
      ...comparisonBody,
      comparisonDigest: comparisonDigestOf(comparisonBody),
    });
    const decisionBody = {
      schema: 'sinter.transfer-promotion-decision' as const,
      schemaVersion: TRANSFER_PROMOTION_SCHEMA_VERSION,
      status: status as 'preferred' | 'rejected',
      reason,
      freezeDigest: this.freeze.freezeDigest,
      comparison,
      persistenceBoundary: TRANSFER_PROMOTION_PERSISTENCE_BOUNDARY,
      runId: this.freeze.runId,
      gateSessionId: this.freeze.gateSessionId,
      decidedAt: this.#now(),
    };
    const decision = freeze({
      ...decisionBody, decisionDigest: decisionDigestOf(decisionBody),
    });
    AUTHENTIC_DECISIONS.set(decision, this);
    CONSUMED_PROMOTION_PACKETS.add(packet);
    this.#latestDecision = decision;
    return decision;
  }

  latestDecision(): TransferPromotionDecision | undefined {
    return this.#latestDecision;
  }

  promote(
    decision: TransferPromotionDecision,
    capabilities: {
      readonly ownerCapability: OwnerAuthorityCapability;
      readonly sourceCapability: OwnerAuthorityCapability;
    },
  ): TransferPromotionReceipt {
    const owner = this.#authorityRegistry.verify(capabilities.ownerCapability, 'owner');
    const source = this.#authorityRegistry.verify(capabilities.sourceCapability, 'issuer');
    const decisionSession = AUTHENTIC_DECISIONS.get(decision);
    if (!decisionSession
      || decisionDigestOf(stripDecisionDigest(decision)) !== decision.decisionDigest) {
      return this.#promoteTerminal(decision, owner, source, 'DECISION_PROVENANCE_INVALID');
    }
    if (decisionSession !== this
      || decision.runId !== this.freeze.runId
      || decision.gateSessionId !== this.freeze.gateSessionId) {
      return this.#promoteTerminal(decision, owner, source, 'PROMOTION_CROSS_RUN');
    }
    if (!sameAuthority(owner, this.#authorization.owner)) {
      return this.#promoteTerminal(decision, owner, source, 'OWNER_CAPABILITY_INVALID');
    }
    if (!sameAuthority(source, this.#authorization.issuer)
      || sameAuthority(owner, source) || owner.id === source.id) {
      return this.#promoteTerminal(decision, owner, source, 'SOURCE_CAPABILITY_INVALID');
    }
    if (decision.freezeDigest !== this.freeze.freezeDigest) {
      return this.#promoteTerminal(decision, owner, source, 'FREEZE_DIGEST_MISMATCH');
    }
    if (decision.status !== 'preferred') {
      return this.#promoteTerminal(decision, owner, source, 'DECISION_REJECTED');
    }
    if (PROMOTED_DECISIONS.has(decision)) {
      return this.#promoteTerminal(decision, owner, source, 'PROMOTION_REPLAYED');
    }
    const learningTransfer = this.#authority.transferLearning(this.#provisional);
    if (learningTransfer.status !== 'transferred') {
      return this.#promoteTerminal(
        decision, owner, source, 'LEARNING_TRANSFER_FAILED', learningTransfer,
      );
    }
    this.#applyPromotion(this.freeze.ruleId, this.freeze.ruleValue);
    PROMOTED_DECISIONS.add(decision);
    const body = {
      schema: 'sinter.transfer-promotion-receipt' as const,
      schemaVersion: TRANSFER_PROMOTION_SCHEMA_VERSION,
      status: 'promoted' as const,
      reason: 'PROMOTED' as const,
      persistenceBoundary: TRANSFER_PROMOTION_PERSISTENCE_BOUNDARY,
      decisionDigest: decision.decisionDigest,
      freezeDigest: this.freeze.freezeDigest,
      runId: this.freeze.runId,
      gateSessionId: this.freeze.gateSessionId,
      owner,
      source,
      promotedAt: this.#now(),
      learningTransfer,
    };
    return freeze({ ...body, promotionDigest: promotionDigestOf(body) });
  }

  #promoteTerminal(
    decision: TransferPromotionDecision,
    owner: AuthorityIdentity,
    source: AuthorityIdentity,
    reason: TransferPromotionReceipt['reason'] extends 'PROMOTED' ? never
      : Exclude<TransferPromotionReceipt['reason'], 'PROMOTED'>,
    learningTransfer?: LearningTransferReceipt,
  ): TransferPromotionReceipt {
    const body = {
      schema: 'sinter.transfer-promotion-receipt' as const,
      schemaVersion: TRANSFER_PROMOTION_SCHEMA_VERSION,
      status: 'terminal' as const,
      reason,
      persistenceBoundary: TRANSFER_PROMOTION_PERSISTENCE_BOUNDARY,
      decisionDigest: decision.decisionDigest,
      freezeDigest: this.freeze.freezeDigest,
      runId: this.freeze.runId,
      gateSessionId: this.freeze.gateSessionId,
      owner,
      source,
      promotedAt: this.#now(),
      ...(learningTransfer ? { learningTransfer } : {}),
    };
    return freeze({ ...body, promotionDigest: promotionDigestOf(body) });
  }

}

function sameAuthority(left: AuthorityIdentity, right: AuthorityIdentity): boolean {
  return left.id === right.id && left.role === right.role
    && left.assertionDigest === right.assertionDigest;
}

function stripDigest(packet: PromotionComparisonPacket): Omit<PromotionComparisonPacket, 'packetDigest'> {
  const { packetDigest: _digest, ...body } = packet;
  return body;
}

function stripDecisionDigest(decision: TransferPromotionDecision): Omit<TransferPromotionDecision, 'decisionDigest'> {
  const { decisionDigest: _digest, ...body } = decision;
  return body;
}

export function assertAuthenticTransferPromotionGate(
  value: unknown,
): asserts value is TransferPromotionGateSessionImpl {
  if (!value || typeof value !== 'object' || !AUTHENTIC_GATE_SESSIONS.has(value)) {
    throw new Error('TRANSFER_PROMOTION_GATE_PROVENANCE_INVALID');
  }
}

export interface TransferCandidateGenerationRequest {
  readonly arm: 'treatment' | 'control';
  readonly prompt: string;
  readonly experimentRunId: string;
  readonly causalInputDigest: string;
}

export type TransferCandidateGenerationSeam = (
  request: TransferCandidateGenerationRequest,
) => string | Promise<string>;

export class CreativeRunCoordinator extends CreativeRunCoordinatorBase {
  readonly #ownerAuthority?: CoordinatorOwnerAuthority;
  readonly #ordinaryCreateRules = new Map<string, RevisionScalar>();
  readonly #transferPromotionGates = new Map<string, TransferPromotionGateSessionImpl>();
  readonly #now: () => string;
  readonly #transferCandidateGenerator?: TransferCandidateGenerationSeam;

  constructor(options: CreativeRunCoordinatorOptions & {
    readonly transferCandidateGenerator?: TransferCandidateGenerationSeam;
  } = {}) {
    super(options);
    const now = options.now ?? (() => new Date().toISOString());
    this.#now = now;
    this.#ownerAuthority = options.ownerAuthority
      ? createCoordinatorOwnerAuthority(options.ownerAuthority, now) : undefined;
    this.#transferCandidateGenerator = options.transferCandidateGenerator;
  }

  acceptOwnerAuthorityCapability(
    assertion: TrustedAuthorityAssertion,
  ): OwnerAuthorityCapability {
    if (!this.#ownerAuthority) throw new Error('OWNER_AUTHORITY_BOOTSTRAP_REQUIRED');
    return this.#ownerAuthority.accept(assertion);
  }

  /** Host authentication adapter verification; never mints or serializes capabilities. */
  verifyOwnerAuthorityCapability(
    capability: OwnerAuthorityCapability,
    role: AuthorityIdentity['role'],
  ): AuthorityIdentity {
    if (!this.#ownerAuthority) throw new Error('OWNER_AUTHORITY_BOOTSTRAP_REQUIRED');
    return this.#ownerAuthority.verify(capability, role);
  }

  createOwnerLearningAuthoritySession(
    options: OwnerLearningAuthoritySessionOptions,
  ): OwnerLearningAuthoritySession {
    if (!this.#ownerAuthority) throw new Error('OWNER_AUTHORITY_BOOTSTRAP_REQUIRED');
    return this.#ownerAuthority.createSession(options);
  }

  /**
   * Mint the closure-only owner comparison from the authenticated revision
   * witness. This deliberately creates a new blind two-artifact packet instead
   * of relabelling the original three-candidate quality-review packet.
   */
  createRevisionDecisionArtistReviewSession(input: {
    readonly sessionId: string;
    readonly plan: ExperimentPlan;
    readonly revision: AttributableRevisionReceipt;
    readonly independentBlindPreference: IndependentBlindTreatmentPreference;
    readonly now?: () => string;
    readonly tokenSecret?: Uint8Array;
    readonly nonce?: () => string;
  }): ArtistReviewSession {
    if (!this.#ownerAuthority) throw new Error('OWNER_AUTHORITY_BOOTSTRAP_REQUIRED');
    assertAuthenticIndependentBlindTreatmentPreference(
      input.plan, input.revision, input.independentBlindPreference,
    );
    const artifacts = resolveAuthenticRevisionArtifacts(input.plan, input.revision);
    const opaque = () => `revision-candidate-${randomUUID()}`;
    const pair = [
      { html: artifacts.baseline.creativeBytes, artifactDigest: artifacts.baseline.artifactDigest },
      { html: artifacts.treatment.creativeBytes, artifactDigest: artifacts.treatment.artifactDigest },
    ];
    if (randomUUID().charCodeAt(0) % 2 === 1) pair.reverse();
    const blindedPair = pair.map((artifact, index) => ({ ...artifact, id: opaque(),
      label: `Comparison ${String.fromCharCode(65 + index)}`,
      hypothesis: 'Canonical comparison artifact.' }));
    const manifest = {
      intent: `Revision comparison ${input.plan.planDigest}`,
      creativeThesis: {
        thesisId: `revision-decision:${input.plan.planDigest}`,
        intendedExperienceMeaning: 'Compare the exact baseline and authenticated revision.',
        perceptualEmotionalArc: 'Blind pair comparison.', tensions: [], uncertaintiesAssumptions: [],
        principles: [],
      },
      candidates: blindedPair.map((candidate) => ({
        id: candidate.id, label: candidate.label, hypothesis: candidate.hypothesis,
        materialDifference: 'Authenticated canonical comparison.', artifact: { layers: [], html: candidate.html,
          artifactDigest: candidate.artifactDigest, planDigest: input.plan.planDigest,
          successCount: 1, layerCount: 1 }, qualityScore: 1, qualityBand: 'high' as const,
      })),
    } satisfies ArtistReviewManifest;
    const blind = createBlindReviewSession({ candidates: manifest.candidates }, blindedPair.map((candidate) => ({
      candidateId: candidate.id, sourceCandidateArtifactDigest: candidate.artifactDigest,
      requiredModalities: ['visual'] as const,
      generationIdentity: { role: 'generator' as const, provider: 'host-derived',
        model: 'revision-decision', pipe: input.plan.planDigest, effort: 'fixed',
        contributionLineage: input.revision.receiptDigest, assignment: `revision-pair:${candidate.id}` },
    })));
    const review = blind.bindIndependentTreatmentPreference(
      blind.packet, input.independentBlindPreference.receiptDigest,
    );
    const unmasked = blind.unmask();
    const authority = this.#ownerAuthority.createSession({ packet: blind.packet, review, unmasked,
      experimentPlan: input.plan, revisionReceipt: input.revision, now: input.now });
    const revisionDecisionComparison = createRevisionDecisionComparisonContext({
      plan: input.plan, revision: input.revision, preference: input.independentBlindPreference,
      packet: blind.packet, review, unmasked,
      baselineArtifactDigest: artifacts.baseline.artifactDigest,
      treatmentArtifactDigest: artifacts.treatment.artifactDigest,
    });
    return createArtistReviewSession({ sessionId: input.sessionId, manifest, packet: blind.packet,
      review, unmasked, plan: input.plan, revision: input.revision, authority,
      revisionDecisionComparison, now: input.now, tokenSecret: input.tokenSecret, nonce: input.nonce });
  }

  /**
   * Resolves an opaque Artist Review terminal-decision witness only when its
   * session is owned by this coordinator's active authority registry.
   */
  resolveOwnerClosureCheckpoint(
    checkpoint: ArtistReviewClosureCheckpoint,
  ): CoordinatorOwnerClosureCheckpoint {
    if (!this.#ownerAuthority) throw new Error('OWNER_AUTHORITY_BOOTSTRAP_REQUIRED');
    const review = resolveArtistReviewClosureCheckpoint(checkpoint);
    this.#ownerAuthority.resolveSession(review.authority);
    assertAuthenticOwnerDecisionReceipts(
      review.authority, review.preferenceReceipt, review.releaseReceipt,
    );
    const resolved = Object.freeze({}) as CoordinatorOwnerClosureCheckpoint;
    COORDINATOR_OWNER_CLOSURE_CHECKPOINTS.set(resolved, Object.freeze({ ...review }));
    return resolved;
  }

  /**
   * Resolves a staged learning transfer only while the authenticated owner
   * session is live. The host evidence registry may seal the returned witness
   * for restart verification, but this method never transfers or promotes it.
   */
  resolveOwnerTransferCheckpoint(
    checkpoint: ArtistReviewPromotionCheckpoint,
  ): CoordinatorOwnerTransferCheckpoint {
    if (!this.#ownerAuthority) throw new Error('OWNER_AUTHORITY_BOOTSTRAP_REQUIRED');
    const review = resolveArtistReviewPromotionCheckpoint(checkpoint);
    const session = this.#ownerAuthority.resolveSession(review.authority);
    const prerequisites = session.bindTransferPromotionPrerequisites({
      authorization: review.authorization, stage: review.stage,
    });
    const resolved = Object.freeze({}) as CoordinatorOwnerTransferCheckpoint;
    COORDINATOR_OWNER_TRANSFER_CHECKPOINTS.set(resolved, Object.freeze({
      manifest: review.manifest, plan: prerequisites.plan, revision: prerequisites.revision,
      authorization: prerequisites.authorization, stage: review.stage,
      provisional: prerequisites.provisional,
    }));
    return resolved;
  }

  /**
   * Opens the W8-16 experiment from the authentic Studio review checkpoint.
   * Both arms, their labels, route, budget, brief, and exact causal difference
   * are coordinator-owned; callers cannot supply candidate HTML or relabel arms.
   */
  async openTransferPromotionExperiment(
    checkpoint: ArtistReviewPromotionCheckpoint,
    options: { readonly renderGate?: boolean } = {},
  ): Promise<Readonly<{
    runId: string;
    sealedBrief: SealedPromotionBrief;
    treatment: Readonly<{ composition: CoordinatedCompositionResult;
      artifact: TransferPromotionArtifact }>;
    control: Readonly<{ composition: CoordinatedCompositionResult;
      artifact: TransferPromotionArtifact }>;
    gate: TransferPromotionGateSessionImpl;
  }>> {
    if (!this.#ownerAuthority) throw new Error('OWNER_AUTHORITY_BOOTSTRAP_REQUIRED');
    const review = resolveArtistReviewPromotionCheckpoint(checkpoint);
    const session = this.#ownerAuthority.resolveSession(review.authority);
    const prerequisites = session.bindTransferPromotionPrerequisites({
      authorization: review.authorization, stage: review.stage,
    });
    if (review.manifest.intent.trim().length === 0) {
      throw new Error('TRANSFER_PROMOTION_BRIEF_INCOMPLETE');
    }
    const ownerSession = freeze({}) as TransferPromotionOwnerSessionHandle;
    AUTHENTIC_TRANSFER_OWNER_HANDLES.set(ownerSession, {
      session, authorityRegistry: this.#ownerAuthority, ...prerequisites,
    });
    const runId = `transfer-${randomUUID()}`;
    const sealedBrief = freeze({
      briefDigest: sha256(review.manifest.intent), runId,
    }) as SealedPromotionBrief;
    const revisionArtifacts = resolveAuthenticRevisionArtifacts(review.plan, review.revision);
    AUTHENTIC_SEALED_BRIEFS.set(sealedBrief, {
      ownerSession,
      content: review.manifest.intent,
      sourceArtifactDigest: revisionArtifacts.baseline.artifactDigest,
      revisionReceiptDigest: review.revision.receiptDigest,
    });
    const routeDigest = sha256(JSON.stringify(review.plan.route));
    const renderGate = options.renderGate ?? true;
    const budgetDigest = sha256(JSON.stringify({
      maxProviderCalls: 1, renderGate, entryPoint: 'studio-layers',
    }));
    const composeArm = async (
      arm: 'treatment' | 'control',
    ): Promise<Readonly<{ composition: CoordinatedCompositionResult;
      artifact: TransferPromotionArtifact }>> => {
      const appliesAuthorizedRevision = arm === 'treatment';
      const prompt = appliesAuthorizedRevision
        ? `${review.manifest.intent}\nAuthorized experimental revision: ${review.plan.treatment.targetId}=${JSON.stringify(review.plan.treatment.after)}`
        : review.manifest.intent;
      const causalInputDigest = sha256(JSON.stringify({
        runId, arm, briefDigest: sealedBrief.briefDigest,
        sourceEnvelopeDigest: revisionArtifacts.baseline.envelopeDigest,
        baselineEnvelopeDigest: revisionArtifacts.baseline.envelopeDigest,
        planDigest: review.plan.planDigest,
        revisionReceiptDigest: review.revision.receiptDigest,
        routeDigest, budgetDigest,
        authorizedRevision: appliesAuthorizedRevision ? {
          ruleId: review.plan.treatment.targetId,
          before: review.plan.treatment.before,
          after: review.plan.treatment.after,
          witnessEnvelopeDigest: revisionArtifacts.treatment.envelopeDigest,
        } : null,
      }));
      const generatedCode = this.#transferCandidateGenerator
        ? await this.#transferCandidateGenerator({
          arm, prompt, experimentRunId: runId, causalInputDigest,
        }) : undefined;
      const request: CompositionRequest = {
        title: 'Blind transfer experiment', background: '#000000', renderGate,
        creativeThesis: review.manifest.creativeThesis,
        maxProviderCalls: 1,
        layers: [{ domain: 'html', prompt, ...(generatedCode ? { code: generatedCode } : {}) }],
      };
      const composition = await this.compose(request, {
        requestKey: `${runId}:${arm}`,
        entryPoint: 'studio-layers',
        provider: review.plan.route.provider,
        model: review.plan.route.model,
        creativeThesis: review.manifest.creativeThesis,
      });
      validatePromotionArtifact(composition.html);
      const creativeDigest = sha256(composition.html);
      const artifact = freeze({
        artifactDigest: creativeDigest.slice(0, 16),
        createRunId: composition.creativeRun.rootRunId,
        causalInputDigest,
      }) as TransferPromotionArtifact;
      AUTHENTIC_PROMOTION_ARTIFACTS.set(artifact, {
        creativeBytes: composition.html, creativeDigest,
        artifactDigest: artifact.artifactDigest,
        createRunId: artifact.createRunId, arm, sealedBrief,
        sourceArtifactDigest: revisionArtifacts.baseline.artifactDigest,
        revisionReceiptDigest: review.revision.receiptDigest,
        experimentRunId: runId, briefDigest: sealedBrief.briefDigest,
        routeDigest, budgetDigest, causalInputDigest, appliesAuthorizedRevision,
      });
      return Object.freeze({ composition, artifact });
    };
    const control = await composeArm('control');
    const treatment = await composeArm('treatment');
    const gateOptions: TransferPromotionGateOptions = {
      ownerSession, sealedBrief,
      treatmentArtifact: treatment.artifact,
      controlArtifact: control.artifact,
      applicability: `principle:${review.plan.treatment.targetId} for ${revisionArtifacts.baseline.artifactDigest}`,
      experimentalScope: 'authentic attributable revision vs its exact baseline, same brief/route/budget',
      evidenceProtocol: 'blinded independent review + separate owner review + explicit promotion checkpoint + 6-dimension similarity',
    };
    const gate = this.#createTransferPromotionGateSession(gateOptions);
    return Object.freeze({ runId, sealedBrief, treatment, control, gate });
  }

  #createTransferPromotionGateSession(
    options: TransferPromotionGateOptions,
  ): TransferPromotionGateSessionImpl {
    const owner = AUTHENTIC_TRANSFER_OWNER_HANDLES.get(options.ownerSession);
    const brief = AUTHENTIC_SEALED_BRIEFS.get(options.sealedBrief);
    const treatment = AUTHENTIC_PROMOTION_ARTIFACTS.get(options.treatmentArtifact);
    const control = AUTHENTIC_PROMOTION_ARTIFACTS.get(options.controlArtifact);
    if (!owner || owner.authorityRegistry !== this.#ownerAuthority) {
      throw new Error('TRANSFER_PROMOTION_OWNER_SESSION_PROVENANCE_INVALID');
    }
    if (!brief) throw new Error('TRANSFER_PROMOTION_BRIEF_PROVENANCE_INVALID');
    if (!treatment || !control) throw new Error('TRANSFER_PROMOTION_ARTIFACT_PROVENANCE_INVALID');
    const gate = new TransferPromotionGateSessionImpl(
      options, owner, brief, treatment, control,
      (ruleId, value) => this.#ordinaryCreateRules.set(ruleId, value),
      this.#now,
    );
    this.#transferPromotionGates.set(options.sealedBrief.runId, gate);
    this.#transferPromotionGates.set(treatment.createRunId, gate);
    this.#transferPromotionGates.set(control.createRunId, gate);
    return gate;
  }

  transferPromotionDecision(runId: string): TransferPromotionDecision {
    const decision = this.#transferPromotionGates.get(runId)?.latestDecision();
    if (!decision) throw new Error(`Transfer promotion not found for run: ${runId}`);
    return decision;
  }

  ordinaryCreateContext(): CreateContextSnapshot {
    return contextSnapshot(Object.fromEntries(this.#ordinaryCreateRules));
  }

  runDreamAndAssimilate(request: DreamAssimilationRequest): Promise<DreamAssimilationResult> {
    return runDreamAndAssimilate(this, request);
  }

  protected override prepareOrdinaryCreatePrompt(prompt: string): string {
    if (this.#ordinaryCreateRules.size === 0) return prompt;
    const rules = [...this.#ordinaryCreateRules.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([id, value]) => `${id}=${JSON.stringify(value)}`)
      .join('\n');
    return `${prompt}\n\nAuthorized creative rule context:\n${rules}`;
  }
}

export {
  SIMILARITY_DIMENSIONS,
  TRANSFER_PROMOTION_PERSISTENCE_BOUNDARY,
  TRANSFER_PROMOTION_SCHEMA_VERSION,
};
export { TransferPromotionGateSessionImpl as TransferPromotionGateSession };
export type {
  BlindedComparisonJudgment,
  OwnerComparisonJudgment,
  PromotionComparisonCandidate,
  PromotionComparisonPacket,
  PromotionReviewOutcome,
  SimilarityDimension,
  SimilarityFingerprint,
  SealedPromotionBrief,
  TransferPromotionArtifact,
  TransferPromotionComparison,
  TransferPromotionDecision,
  TransferPromotionDecisionReason,
  TransferPromotionFreeze,
  TransferPromotionGateOptions,
  TransferPromotionOwnerSessionHandle,
  TransferPromotionReviewerSink,
  TransferPromotionReceipt,
} from './TransferPromotionGate.js';
