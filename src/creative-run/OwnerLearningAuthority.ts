import type {
  AttributableRevisionReceipt,
  ExperimentPlan,
  RevisionScalar,
} from './AttributableRevision.js';
import type {
  BlindReviewPacket,
  BlindReviewRecord,
  UnmaskedReview,
} from './BlindReviewEvidence.js';

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
