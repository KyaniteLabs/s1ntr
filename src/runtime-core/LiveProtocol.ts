import { createHash, createPublicKey, verify as verifySignature } from 'node:crypto';
import { z } from 'zod';
import { isWave8CriticalHarnessModel } from './Wave8CriticalHarness.js';

export const LIVE_PROTOCOL_SCHEMA = 'sinter.wave8-live-protocol' as const;
export const LIVE_PROTOCOL_SCHEMA_VERSION = 1 as const;
export const WAVE8_LIVE_CHECKPOINTS = [
  'preference', 'release-worthiness', 'learning-authorization',
  'promotion', 'merge', 'final-release',
] as const;
export const WAVE8_LIVE_CONJUNCTS = [
  'merged-main', 'forgejo-ci', 'compound-artifacts',
  'leak-audit', 'semantic-audit', 'shared-terminal-truth',
] as const;

export type LiveCheckpointId = (typeof WAVE8_LIVE_CHECKPOINTS)[number];
export type LiveConjunctId = (typeof WAVE8_LIVE_CONJUNCTS)[number];
export type LiveEvidenceClass = 'live-provider' | 'deterministic-proof' | 'execution';

export type LiveAuthorityRole = 'owner' | 'price' | 'sol-approval' | 'product-review';

export interface LiveAuthorityAttestation {
  readonly schema: 'sinter.wave8-live-authority-attestation';
  readonly schemaVersion: 1;
  readonly authorityId: string;
  readonly role: LiveAuthorityRole;
  readonly subjectDigest: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly nonce: string;
  readonly signatureBase64: string;
}

export interface LiveProtocolTrust {
  readonly owner: { readonly authorityId: string; readonly publicKeyPem: string };
  readonly providers: readonly {
    readonly authorityId: string;
    readonly role: Exclude<LiveAuthorityRole, 'owner'>;
    readonly publicKeyPem: string;
  }[];
}

const DIGEST = /^(?:sha256:)?[a-f0-9]{64}$/;
const HEAD = /^[a-f0-9]{40}$/;
const PLACEHOLDER = /(?:unknown|unset|invented|fake|mock|tbd|todo)/i;

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map(key =>
      `${JSON.stringify(key)}:${stable(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function digestLiveProtocol(value: unknown): string {
  return createHash('sha256').update(stable(value)).digest('hex');
}

function validDigest(value: unknown): value is string { return typeof value === 'string' && DIGEST.test(value); }
function validHead(value: unknown): value is string { return typeof value === 'string' && HEAD.test(value); }

function withoutField<T extends object, K extends keyof T>(value: T, key: K): Omit<T, K> {
  const copy = Object.assign({}, value) as Record<PropertyKey, unknown>;
  delete copy[key];
  return copy as Omit<T, K>;
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}

function clone<T>(value: T): T {
  if (Array.isArray(value)) return value.map(item => clone(item)) as T;
  if (value && typeof value === 'object') {
    const copy: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) copy[key] = clone(child);
    return copy as T;
  }
  return value;
}

export function liveAuthorityAttestationPayload(
  attestation: Omit<LiveAuthorityAttestation, 'signatureBase64'>,
): string {
  return stable(attestation);
}

function authoritySubject(receipt: LiveProtocolReceipt, role: LiveAuthorityRole): string | undefined {
  if (role === 'owner') return digestLiveProtocol({
    ownerApproval: receipt.ownerApproval,
    ownerCheckpoints: receipt.ownerCheckpoints,
  });
  if (role === 'price') return receipt.priceReceipt?.receiptDigest;
  if (role === 'sol-approval') return receipt.solApproval
    ? digestLiveProtocol(withoutField(receipt.solApproval, 'approvalDigest')) : undefined;
  return receipt.productReview
    ? digestLiveProtocol(withoutField(receipt.productReview, 'reviewDigest')) : undefined;
}

function fundingMode(receipt: Pick<LiveProtocolReceipt, 'freeze'>): 'metered-api' | 'subscription-seat' {
  return receipt.freeze.budgets.fundingMode ?? 'metered-api';
}

function authorityFailures(receipt: LiveProtocolReceipt, context: LiveProtocolContext): string[] {
  if (!context.trust) return ['authority: trusted owner/provider keys are missing'];
  const failures: string[] = [];
  const now = Date.parse(context.now ?? new Date().toISOString());
  const requiredRoles: readonly LiveAuthorityRole[] = fundingMode(receipt) === 'metered-api'
    ? ['owner', 'price', 'sol-approval', 'product-review']
    : ['owner', 'sol-approval', 'product-review'];
  for (const role of requiredRoles) {
    const matches = receipt.attestations.filter(item => item.role === role);
    if (matches.length !== 1) { failures.push(`authority: exactly one ${role} attestation is required`); continue; }
    const attestation = matches[0]!;
    const trusted = role === 'owner' ? context.trust.owner
      : context.trust.providers.find(item => item.role === role);
    if (!trusted || trusted.authorityId !== attestation.authorityId) {
      failures.push(`authority: ${role} signer is not trusted`); continue;
    }
    const issuedAt = Date.parse(attestation.issuedAt);
    const expiresAt = Date.parse(attestation.expiresAt);
    if (!attestation.nonce.trim() || !Number.isFinite(issuedAt) || !Number.isFinite(expiresAt)
      || issuedAt > now || expiresAt <= now || expiresAt <= issuedAt) failures.push(`authority: ${role} attestation is expired or invalid`);
    if (attestation.subjectDigest !== authoritySubject(receipt, role)) failures.push(`authority: ${role} subject digest mismatch`);
    const unsigned = withoutField(attestation, 'signatureBase64');
    try {
      if (!verifySignature(null, Buffer.from(liveAuthorityAttestationPayload(unsigned)),
        createPublicKey(trusted.publicKeyPem), Buffer.from(attestation.signatureBase64, 'base64'))) {
        failures.push(`authority: ${role} signature is invalid`);
      }
    } catch { failures.push(`authority: ${role} signature is invalid`); }
  }
  for (const attestation of receipt.attestations) {
    if (!requiredRoles.includes(attestation.role)) failures.push(`authority: ${attestation.role} attestation is not permitted`);
  }
  if (new Set(receipt.attestations.map(item => item.nonce)).size !== receipt.attestations.length) {
    failures.push('authority: attestation nonces are duplicated');
  }
  return failures;
}

export interface LiveRoleIdentity {
  readonly role: string;
  readonly provider: string;
  readonly model: string;
  readonly pipe: string;
  readonly effort: string;
  readonly identityVerified: boolean;
  readonly seatId?: string;
  readonly identityId?: string;
}

export interface LiveBriefFreeze {
  readonly id: string;
  readonly briefDigest: string;
  readonly unseen: true;
}

export interface LiveBudgetRow {
  readonly role: string;
  readonly identityId?: string;
  readonly maxCalls: number;
  readonly maxInputTokens: number;
  readonly maxOutputTokens: number;
  readonly maxRetries: number;
}

interface LiveBudgetBase {
  readonly rows: readonly LiveBudgetRow[];
  readonly maxActiveMinutes: number;
  readonly maxTotalCalls: number;
  readonly maxTotalInputTokens: number;
  readonly maxTotalOutputTokens: number;
  readonly maxRetriesPerStage: number;
}

export interface MeteredLiveBudgetFreeze extends LiveBudgetBase {
  /** Omitted on legacy receipts, which remain metered for compatibility. */
  readonly fundingMode?: 'metered-api';
  readonly approvedUsdCeiling: number;
  readonly approvedSeatIds?: never;
}

export interface SubscriptionLiveBudgetFreeze extends LiveBudgetBase {
  readonly fundingMode: 'subscription-seat';
  readonly approvedSeatIds: readonly string[];
  readonly approvedUsdCeiling?: never;
}

export type LiveBudgetFreeze = MeteredLiveBudgetFreeze | SubscriptionLiveBudgetFreeze;

export interface OwnerUsdCeilingApproval {
  readonly schema: 'sinter.owner-usd-ceiling-approval';
  readonly ownerId: string;
  readonly approvedUsdCeiling: number;
  readonly planDigest: string;
  readonly approvedAt: string;
  readonly approvalDigest: string;
}

export interface OwnerSubscriptionSeatApproval {
  readonly schema: 'sinter.owner-subscription-seat-approval';
  readonly ownerId: string;
  readonly fundingMode: 'subscription-seat';
  readonly approvedSeatIds: readonly string[];
  readonly resourceBudgetDigest: string;
  readonly planDigest: string;
  readonly approvedAt: string;
  readonly approvalDigest: string;
}

export type LiveOwnerApproval = OwnerUsdCeilingApproval | OwnerSubscriptionSeatApproval;

/** Pre-spend commitment to the evidence shape, before generated bytes exist. */
export interface LiveArtifactCommitment {
  readonly mode: 'planned';
  readonly evidenceScheduleDigest: string;
  readonly expectedPlayableArtifactCount: number;
}

/** Exact post-generation artifacts. Legacy receipts may omit `mode`. */
export interface LiveArtifactSet {
  readonly mode?: 'materialized';
  readonly contactSheetDigest: string;
  readonly playableArtifactDigests: readonly string[];
}

export interface LiveCheckpoint {
  readonly id: LiveCheckpointId;
  readonly decision: 'winner' | 'tie' | 'reject' | 'release-worthy' | 'not-release-worthy'
    | 'allow' | 'deny' | 'promote' | 'do-not-promote' | 'merge' | 'do-not-merge'
    | 'release' | 'do-not-release';
  readonly contactSheetDigest: string;
  readonly playableArtifactDigests: readonly string[];
  readonly decisionDigest: string;
}

export interface LiveProtocolFreeze {
  readonly schema: typeof LIVE_PROTOCOL_SCHEMA;
  readonly schemaVersion: typeof LIVE_PROTOCOL_SCHEMA_VERSION;
  readonly frozenAt: string;
  readonly exactHead: string;
  readonly planDigest: string;
  readonly schemaDigest: string;
  readonly implementationDigest: string;
  readonly sourceDigest: string;
  readonly roles: readonly LiveRoleIdentity[];
  readonly briefs: readonly LiveBriefFreeze[];
  readonly budgets: LiveBudgetFreeze;
  readonly artifacts: LiveArtifactCommitment | LiveArtifactSet;
  readonly evidenceRequirements: {
    readonly noSpendClass: 'deterministic-proof';
    readonly liveClass: 'live-provider';
    readonly criticalSolApproval: true;
    readonly productReviewBeforeMergeOrRelease: true;
  };
  readonly freezeDigest: string;
}

export interface LivePriceEvidence {
  readonly provider: string;
  readonly model: string;
  readonly inputUsdPerMillion: number;
  readonly outputUsdPerMillion: number;
  readonly sourceUrl: string;
  readonly verifiedAt: string;
}

export interface CurrentPriceReceipt {
  readonly schema: 'sinter.current-price-receipt';
  readonly schemaVersion: 1;
  readonly generatedAt: string;
  readonly prices: readonly LivePriceEvidence[];
  readonly receiptDigest: string;
}

export interface LiveBoundEvidence {
  readonly evidenceClass: LiveEvidenceClass;
  readonly passed: boolean;
  readonly exactHead: string;
  readonly planDigest: string;
  readonly schemaDigest: string;
  readonly implementationDigest: string;
  readonly sourceDigest: string;
  readonly artifactDigests: readonly string[];
}

export interface NoSpendEvidence extends LiveBoundEvidence {
  readonly evidenceClass: 'deterministic-proof';
  readonly providerLedgerCallIds: readonly string[];
}

export interface SolApprovalEvidence extends LiveBoundEvidence {
  readonly evidenceClass: 'live-provider';
  readonly critical: true;
  readonly executor: LiveRoleIdentity;
  readonly approvalDigest: string;
}

export interface ProductReviewEvidence extends LiveBoundEvidence {
  readonly evidenceClass: 'live-provider';
  readonly reviewer: LiveRoleIdentity;
  readonly authorIndependent: boolean;
  readonly reviewDigest: string;
}

export interface LiveConjunctEvidence extends LiveBoundEvidence {
  readonly id: LiveConjunctId;
  readonly detailDigest: string;
}

export interface LiveProtocolInput {
  readonly frozen: Omit<LiveProtocolFreeze, 'freezeDigest'>;
  readonly ownerApproval?: LiveOwnerApproval;
  readonly priceReceipt?: CurrentPriceReceipt;
  readonly noSpendEvidence?: NoSpendEvidence;
  readonly solApproval?: SolApprovalEvidence;
  readonly productReview?: ProductReviewEvidence;
  readonly materializedArtifacts?: LiveArtifactSet;
  readonly ownerCheckpoints?: readonly LiveCheckpoint[];
  readonly conjuncts?: Partial<Record<LiveConjunctId, LiveConjunctEvidence>>;
  readonly attestations?: readonly LiveAuthorityAttestation[];
}

export interface LiveProtocolContext {
  readonly now?: string;
  readonly exactHead?: string;
  readonly planDigest?: string;
  readonly schemaDigest?: string;
  readonly implementationDigest?: string;
  readonly sourceDigest?: string;
  readonly maxPriceAgeMs?: number;
  readonly trust?: LiveProtocolTrust;
  /** Builder-only allowance for validating the receipt before its digest exists. */
  readonly allowProvisionalReceipt?: boolean;
}

export interface LiveProtocolConjunct {
  readonly id: LiveConjunctId;
  readonly passed: boolean;
  readonly failures: readonly string[];
}

export interface LiveProtocolReport {
  readonly schema: typeof LIVE_PROTOCOL_SCHEMA;
  readonly schemaVersion: typeof LIVE_PROTOCOL_SCHEMA_VERSION;
  readonly freezeDigest: string;
  readonly paidExecutionAllowed: boolean;
  readonly mergeAllowed: boolean;
  readonly finalReleaseAllowed: boolean;
  readonly conjuncts: readonly LiveProtocolConjunct[];
  readonly blockers: readonly string[];
}

export interface LiveProtocolReceipt {
  readonly schema: typeof LIVE_PROTOCOL_SCHEMA;
  readonly schemaVersion: typeof LIVE_PROTOCOL_SCHEMA_VERSION;
  readonly freeze: LiveProtocolFreeze;
  readonly ownerApproval?: LiveOwnerApproval;
  readonly priceReceipt?: CurrentPriceReceipt;
  readonly noSpendEvidence?: NoSpendEvidence;
  readonly solApproval?: SolApprovalEvidence;
  readonly productReview?: ProductReviewEvidence;
  readonly materializedArtifacts?: LiveArtifactSet;
  readonly ownerCheckpoints: readonly LiveCheckpoint[];
  readonly conjunctEvidence: Readonly<Partial<Record<LiveConjunctId, LiveConjunctEvidence>>>;
  readonly attestations: readonly LiveAuthorityAttestation[];
  readonly report: LiveProtocolReport;
  readonly receiptDigest: string;
}

const digestSchema = z.string().regex(DIGEST);
const identitySchema = z.object({ role: z.string().min(1), provider: z.string().min(1),
  model: z.string().min(1), pipe: z.string().min(1), effort: z.string().min(1),
  identityVerified: z.literal(true), seatId: z.string().min(1).optional(),
  identityId: z.string().min(1).optional() }).strict();
const boundSchema = z.object({ evidenceClass: z.enum(['live-provider', 'deterministic-proof', 'execution']),
  passed: z.boolean(), exactHead: z.string().regex(HEAD), planDigest: digestSchema,
  schemaDigest: digestSchema, implementationDigest: digestSchema, sourceDigest: digestSchema,
  artifactDigests: z.array(digestSchema).min(1) }).strict();
const checkpointSchema = z.object({ id: z.enum(WAVE8_LIVE_CHECKPOINTS), decision: z.enum([
  'winner', 'tie', 'reject', 'release-worthy', 'not-release-worthy', 'allow', 'deny',
  'promote', 'do-not-promote', 'merge', 'do-not-merge', 'release', 'do-not-release',
]), contactSheetDigest: digestSchema, playableArtifactDigests: z.array(digestSchema).min(1),
decisionDigest: digestSchema }).strict();
const attestationSchema = z.object({ schema: z.literal('sinter.wave8-live-authority-attestation'),
  schemaVersion: z.literal(1), authorityId: z.string().min(1),
  role: z.enum(['owner', 'price', 'sol-approval', 'product-review']), subjectDigest: digestSchema,
  issuedAt: z.string().datetime(), expiresAt: z.string().datetime(), nonce: z.string().min(1),
  signatureBase64: z.string().min(1) }).strict();
const freezeSchema = z.object({ schema: z.literal(LIVE_PROTOCOL_SCHEMA), schemaVersion: z.literal(1),
  frozenAt: z.string().datetime(), exactHead: z.string().regex(HEAD), planDigest: digestSchema,
  schemaDigest: digestSchema, implementationDigest: digestSchema, sourceDigest: digestSchema,
  roles: z.array(identitySchema).min(1), briefs: z.array(z.object({ id: z.string().min(1),
    briefDigest: digestSchema, unseen: z.literal(true) }).strict()).min(1),
  budgets: z.union([z.object({ fundingMode: z.literal('metered-api').optional(),
    rows: z.array(z.object({ role: z.string().min(1), identityId: z.string().min(1).optional(), maxCalls: z.number().int().positive(),
    maxInputTokens: z.number().int().positive(), maxOutputTokens: z.number().int().positive(),
    maxRetries: z.number().int().nonnegative() }).strict()).min(1), maxActiveMinutes: z.number().int().positive(),
    maxTotalCalls: z.number().int().positive(), maxTotalInputTokens: z.number().int().positive(),
    maxTotalOutputTokens: z.number().int().positive(), maxRetriesPerStage: z.number().int().nonnegative(),
    approvedUsdCeiling: z.number().positive().finite() }).strict(), z.object({ fundingMode: z.literal('subscription-seat'),
    rows: z.array(z.object({ role: z.string().min(1), identityId: z.string().min(1).optional(), maxCalls: z.number().int().positive(),
      maxInputTokens: z.number().int().positive(), maxOutputTokens: z.number().int().positive(),
      maxRetries: z.number().int().nonnegative() }).strict()).min(1), maxActiveMinutes: z.number().int().positive(),
    maxTotalCalls: z.number().int().positive(), maxTotalInputTokens: z.number().int().positive(),
    maxTotalOutputTokens: z.number().int().positive(), maxRetriesPerStage: z.number().int().nonnegative(),
    approvedSeatIds: z.array(z.string().min(1)).min(1) }).strict()]),
  artifacts: z.union([
    z.object({ mode: z.literal('planned'), evidenceScheduleDigest: digestSchema,
      expectedPlayableArtifactCount: z.number().int().positive() }).strict(),
    z.object({ mode: z.literal('materialized').optional(), contactSheetDigest: digestSchema,
      playableArtifactDigests: z.array(digestSchema).min(1) }).strict(),
  ]),
  evidenceRequirements: z.object({ noSpendClass: z.literal('deterministic-proof'),
    liveClass: z.literal('live-provider'), criticalSolApproval: z.literal(true),
    productReviewBeforeMergeOrRelease: z.literal(true) }).strict(), freezeDigest: digestSchema }).strict();
const ownerApprovalSchema = z.object({ schema: z.literal('sinter.owner-usd-ceiling-approval'),
  ownerId: z.string().min(1), approvedUsdCeiling: z.number().positive().finite(),
  planDigest: digestSchema, approvedAt: z.string().datetime(), approvalDigest: digestSchema }).strict();
const ownerSubscriptionApprovalSchema = z.object({ schema: z.literal('sinter.owner-subscription-seat-approval'),
  ownerId: z.string().min(1), fundingMode: z.literal('subscription-seat'),
  approvedSeatIds: z.array(z.string().min(1)).min(1), resourceBudgetDigest: digestSchema,
  planDigest: digestSchema, approvedAt: z.string().datetime(), approvalDigest: digestSchema }).strict();
const priceSchema = z.object({ schema: z.literal('sinter.current-price-receipt'), schemaVersion: z.literal(1),
  generatedAt: z.string().datetime(), prices: z.array(z.object({ provider: z.string().min(1), model: z.string().min(1),
    inputUsdPerMillion: z.number().nonnegative().finite(), outputUsdPerMillion: z.number().nonnegative().finite(),
    sourceUrl: z.string().url(), verifiedAt: z.string().datetime() }).strict()).min(1), receiptDigest: digestSchema }).strict();
const noSpendSchema = boundSchema.extend({ evidenceClass: z.literal('deterministic-proof'),
  providerLedgerCallIds: z.array(z.string()) }).strict();
const solApprovalSchema = boundSchema.extend({ evidenceClass: z.literal('live-provider'), critical: z.literal(true),
  executor: identitySchema, approvalDigest: digestSchema }).strict();
const productReviewSchema = boundSchema.extend({ evidenceClass: z.literal('live-provider'), reviewer: identitySchema,
  authorIndependent: z.boolean(), reviewDigest: digestSchema }).strict();
const materializedArtifactsSchema = z.object({ mode: z.literal('materialized').optional(),
  contactSheetDigest: digestSchema, playableArtifactDigests: z.array(digestSchema).min(1) }).strict();
const conjunctEvidenceSchema = boundSchema.extend({ id: z.enum(WAVE8_LIVE_CONJUNCTS), detailDigest: digestSchema }).strict();
const reportSchema = z.object({ schema: z.literal(LIVE_PROTOCOL_SCHEMA), schemaVersion: z.literal(1),
  freezeDigest: digestSchema, paidExecutionAllowed: z.boolean(), mergeAllowed: z.boolean(),
  finalReleaseAllowed: z.boolean(), conjuncts: z.array(z.object({ id: z.enum(WAVE8_LIVE_CONJUNCTS),
    passed: z.boolean(), failures: z.array(z.string()) }).strict()), blockers: z.array(z.string()) }).strict();
const receiptSchema = z.object({ schema: z.literal(LIVE_PROTOCOL_SCHEMA), schemaVersion: z.literal(1),
  freeze: freezeSchema, ownerApproval: z.union([ownerApprovalSchema, ownerSubscriptionApprovalSchema]).optional(), priceReceipt: priceSchema.optional(),
  noSpendEvidence: noSpendSchema.optional(), solApproval: solApprovalSchema.optional(),
  productReview: productReviewSchema.optional(), materializedArtifacts: materializedArtifactsSchema.optional(),
  ownerCheckpoints: z.array(checkpointSchema),
  conjunctEvidence: z.partialRecord(z.enum(WAVE8_LIVE_CONJUNCTS), conjunctEvidenceSchema),
  attestations: z.array(attestationSchema), report: reportSchema, receiptDigest: digestSchema }).strict();

export function parseLiveProtocolReceipt(value: unknown): LiveProtocolReceipt {
  const result = receiptSchema.safeParse(value);
  if (!result.success) throw new Error(`LIVE_PROTOCOL_RECEIPT_INVALID:${result.error.issues[0]?.message ?? 'schema'}`);
  return deepFreeze(result.data as LiveProtocolReceipt);
}

function boundFailures(
  evidence: LiveBoundEvidence | undefined,
  freeze: LiveProtocolFreeze,
  label: string,
  requiredClass: LiveEvidenceClass,
): string[] {
  if (!evidence) return [`${label}: evidence missing`];
  const failures: string[] = [];
  if (evidence.evidenceClass !== requiredClass) failures.push(`${label}: evidence class is ${evidence.evidenceClass}, expected ${requiredClass}`);
  if (!evidence.passed) failures.push(`${label}: evidence did not pass`);
  if (evidence.exactHead !== freeze.exactHead) failures.push(`${label}: exact HEAD mismatch`);
  if (evidence.planDigest !== freeze.planDigest) failures.push(`${label}: plan digest mismatch`);
  if (evidence.schemaDigest !== freeze.schemaDigest) failures.push(`${label}: schema digest mismatch`);
  if (evidence.implementationDigest !== freeze.implementationDigest) failures.push(`${label}: implementation digest mismatch`);
  if (evidence.sourceDigest !== freeze.sourceDigest) failures.push(`${label}: source digest mismatch`);
  if (evidence.artifactDigests.length === 0 || evidence.artifactDigests.some(digest => !validDigest(digest))) {
    failures.push(`${label}: artifact digests are missing or invalid`);
  }
  return failures;
}

function conjunct(id: LiveConjunctId, failures: string[]): LiveProtocolConjunct {
  return { id, passed: failures.length === 0, failures };
}

function roleFailures(roles: readonly LiveRoleIdentity[]): string[] {
  const failures: string[] = [];
  if (roles.length === 0) return ['freeze: no role identities'];
  if (new Set(roles.map(role => `${role.role}:${role.identityId ?? ''}`)).size !== roles.length)
    failures.push('freeze: role identities are duplicated');
  for (const role of roles) {
    for (const [key, value] of Object.entries(role)) {
      if (key === 'identityVerified') continue;
      if (typeof value !== 'string' || value.trim().length === 0 || PLACEHOLDER.test(value.trim())) {
        failures.push(`freeze: ${role.role || 'role'} has no verified ${key}`);
      }
    }
    if (role.identityVerified !== true) failures.push(`freeze: ${role.role || 'role'} identity is unverified`);
  }
  return failures;
}

function freezeFailures(freeze: LiveProtocolFreeze, ownerApproval?: LiveOwnerApproval): string[] {
  const failures: string[] = [];
  if (freeze.schema !== LIVE_PROTOCOL_SCHEMA || freeze.schemaVersion !== LIVE_PROTOCOL_SCHEMA_VERSION) failures.push('freeze: schema mismatch');
  if (!validHead(freeze.exactHead)) failures.push('freeze: exact HEAD is invalid');
  for (const [name, value] of Object.entries({
    planDigest: freeze.planDigest, schemaDigest: freeze.schemaDigest,
    implementationDigest: freeze.implementationDigest, sourceDigest: freeze.sourceDigest,
  })) if (!validDigest(value)) failures.push(`freeze: ${name} is invalid`);
  if (!Number.isFinite(Date.parse(freeze.frozenAt))) failures.push('freeze: frozenAt is invalid');
  failures.push(...roleFailures(freeze.roles));
  if (freeze.briefs.length === 0) failures.push('freeze: no unseen brief is frozen');
  if (new Set(freeze.briefs.map(brief => brief.id)).size !== freeze.briefs.length) failures.push('freeze: brief IDs are duplicated');
  for (const brief of freeze.briefs) {
    if (!brief.id.trim() || !validDigest(brief.briefDigest) || brief.unseen !== true) failures.push(`freeze: brief ${brief.id || 'unknown'} is not sealed unseen evidence`);
  }
  const budget = freeze.budgets;
  if (!Number.isInteger(budget.maxActiveMinutes) || budget.maxActiveMinutes <= 0
    || !Number.isInteger(budget.maxTotalCalls) || budget.maxTotalCalls <= 0
    || !Number.isInteger(budget.maxTotalInputTokens) || budget.maxTotalInputTokens <= 0
    || !Number.isInteger(budget.maxTotalOutputTokens) || budget.maxTotalOutputTokens <= 0
    || !Number.isInteger(budget.maxRetriesPerStage) || budget.maxRetriesPerStage < 0) {
    failures.push('freeze: resource budgets are required');
  }
  if (budget.fundingMode !== 'subscription-seat'
    && (!Number.isFinite(budget.approvedUsdCeiling) || budget.approvedUsdCeiling <= 0)) {
    failures.push('freeze: positive USD ceiling is required for metered API funding');
  }
  if (budget.fundingMode === 'subscription-seat') {
    if (new Set(budget.approvedSeatIds).size !== budget.approvedSeatIds.length) failures.push('freeze: approved seat IDs are duplicated');
    const frozenSeatIds = freeze.roles.map(role => role.seatId);
    if (frozenSeatIds.some(seatId => !seatId || !budget.approvedSeatIds.includes(seatId))) {
      failures.push('freeze: every subscription role must use an approved frozen seat');
    }
  }
  const budgetKeys = budget.rows.map(row => `${row.role}:${row.identityId ?? ''}`);
  if (new Set(budgetKeys).size !== budget.rows.length) failures.push('freeze: budget roles are duplicated');
  for (const role of freeze.roles) {
    const matches = budget.rows.filter(row => row.role === role.role
      && (row.identityId === undefined || row.identityId === role.identityId));
    if (matches.length !== 1) failures.push(`freeze: role ${role.role} has no unambiguous budget row`);
  }
  const rowTotals = budget.rows.reduce((totals, row) => ({
    calls: totals.calls + row.maxCalls,
    input: totals.input + row.maxCalls * row.maxInputTokens,
    output: totals.output + row.maxCalls * row.maxOutputTokens,
  }), { calls: 0, input: 0, output: 0 });
  if (rowTotals.calls > budget.maxTotalCalls || rowTotals.input > budget.maxTotalInputTokens
    || rowTotals.output > budget.maxTotalOutputTokens) failures.push('freeze: row budgets exceed total budgets');
  for (const row of budget.rows) {
    const frozenMatches = freeze.roles.filter(role => role.role === row.role
      && (row.identityId === undefined || role.identityId === row.identityId));
    if (frozenMatches.length !== 1)
      failures.push(`freeze: budget role ${row.role} is not frozen`);
    if (!Number.isInteger(row.maxCalls) || row.maxCalls <= 0 || !Number.isInteger(row.maxInputTokens) || row.maxInputTokens <= 0
      || !Number.isInteger(row.maxOutputTokens) || row.maxOutputTokens <= 0 || !Number.isInteger(row.maxRetries) || row.maxRetries < 0) {
      failures.push(`freeze: budget row ${row.role} is invalid`);
    }
    if (row.maxRetries > budget.maxRetriesPerStage) failures.push(`freeze: budget row ${row.role} exceeds retry cap`);
  }
  if (freeze.artifacts.mode === 'planned') {
    if (!validDigest(freeze.artifacts.evidenceScheduleDigest)
      || !Number.isInteger(freeze.artifacts.expectedPlayableArtifactCount)
      || freeze.artifacts.expectedPlayableArtifactCount <= 0) {
      failures.push('freeze: planned review artifact commitment is invalid');
    }
  } else if (!validDigest(freeze.artifacts.contactSheetDigest)
    || freeze.artifacts.playableArtifactDigests.length === 0
    || freeze.artifacts.playableArtifactDigests.some(digest => !validDigest(digest))) {
    failures.push('freeze: exact review artifacts are missing or invalid');
  }
  if (freeze.evidenceRequirements.noSpendClass !== 'deterministic-proof'
    || freeze.evidenceRequirements.liveClass !== 'live-provider'
    || freeze.evidenceRequirements.criticalSolApproval !== true
    || freeze.evidenceRequirements.productReviewBeforeMergeOrRelease !== true) failures.push('freeze: evidence requirements are weakened');
  if (!validDigest(freeze.freezeDigest) || digestLiveProtocol(withoutField(freeze, 'freezeDigest')) !== freeze.freezeDigest) failures.push('freeze: digest mismatch');
  if (!ownerApproval) failures.push('owner funding authorization: explicit approval is missing');
  else {
    const commonInvalid = !ownerApproval.ownerId.trim() || !validDigest(ownerApproval.planDigest)
      || ownerApproval.planDigest !== freeze.planDigest || !Number.isFinite(Date.parse(ownerApproval.approvedAt))
      || digestLiveProtocol(withoutField(ownerApproval, 'approvalDigest')) !== ownerApproval.approvalDigest;
    const modeInvalid = budget.fundingMode !== 'subscription-seat'
      ? ownerApproval.schema !== 'sinter.owner-usd-ceiling-approval'
        || ownerApproval.approvedUsdCeiling !== budget.approvedUsdCeiling
      : ownerApproval.schema !== 'sinter.owner-subscription-seat-approval'
        || ownerApproval.fundingMode !== 'subscription-seat'
        || JSON.stringify(ownerApproval.approvedSeatIds) !== JSON.stringify(budget.approvedSeatIds)
        || ownerApproval.resourceBudgetDigest !== digestLiveProtocol(budget);
    if (commonInvalid || modeInvalid) failures.push('owner funding authorization: approval is invalid or does not match the freeze');
    if (Number.isFinite(Date.parse(ownerApproval.approvedAt)) && Number.isFinite(Date.parse(freeze.frozenAt))
      && Date.parse(ownerApproval.approvedAt) > Date.parse(freeze.frozenAt)) failures.push('owner funding authorization: approval is after the freeze');
  }
  return failures;
}

function priceFailures(
  receipt: CurrentPriceReceipt | undefined,
  freeze: LiveProtocolFreeze,
  context: LiveProtocolContext,
): { failures: string[]; upperBound: number } {
  if (!receipt) return { failures: ['price: current-price feasibility receipt is missing'], upperBound: 0 };
  const failures: string[] = [];
  const now = Date.parse(context.now ?? new Date().toISOString());
  const generatedAt = Date.parse(receipt.generatedAt);
  if (receipt.schema !== 'sinter.current-price-receipt' || receipt.schemaVersion !== 1 || !Number.isFinite(generatedAt)) failures.push('price: receipt schema or timestamp is invalid');
  if (Number.isFinite(now) && Number.isFinite(generatedAt) && generatedAt > now) failures.push('price: receipt is from the future');
  const maxAge = context.maxPriceAgeMs ?? 24 * 60 * 60 * 1000;
  if (Number.isFinite(now) && Number.isFinite(generatedAt) && now - generatedAt > maxAge) failures.push('price: receipt is stale');
  if (!validDigest(receipt.receiptDigest) || digestLiveProtocol(withoutField(receipt, 'receiptDigest')) !== receipt.receiptDigest) failures.push('price: receipt digest mismatch');
  const prices = new Map<string, LivePriceEvidence>();
  for (const price of receipt.prices) {
    const key = `${price.provider}/${price.model}`;
    if (prices.has(key)) failures.push(`price: duplicate ${key}`);
    prices.set(key, price);
    const verifiedAt = Date.parse(price.verifiedAt);
    if (!price.provider.trim() || !price.model.trim() || !/^https:\/\//.test(price.sourceUrl)
      || !Number.isFinite(verifiedAt) || verifiedAt > generatedAt || !Number.isFinite(price.inputUsdPerMillion)
      || price.inputUsdPerMillion < 0 || !Number.isFinite(price.outputUsdPerMillion) || price.outputUsdPerMillion < 0) {
      failures.push(`price: invalid evidence for ${key}`);
    }
  }
  let upperBound = 0;
  for (const row of freeze.budgets.rows) {
    const roleMatches = freeze.roles.filter(candidate => candidate.role === row.role
      && (row.identityId === undefined || candidate.identityId === row.identityId));
    const role = roleMatches.length === 1 ? roleMatches[0] : undefined;
    const price = role && prices.get(`${role.provider}/${role.model}`);
    if (!price) { failures.push(`price: missing current price for ${row.role}`); continue; }
    upperBound += row.maxCalls * (row.maxInputTokens * price.inputUsdPerMillion
      + row.maxOutputTokens * price.outputUsdPerMillion) / 1_000_000;
  }
  if (freeze.budgets.fundingMode === 'subscription-seat') {
    failures.push('price: receipt is not permitted for subscription-seat funding');
  } else if (upperBound > freeze.budgets.approvedUsdCeiling) failures.push('price: feasibility exceeds the owner ceiling');
  return { failures, upperBound };
}

function identityMatches(actual: LiveRoleIdentity, expected: LiveRoleIdentity): boolean {
  return actual.role === expected.role && actual.provider === expected.provider && actual.model === expected.model
    && actual.pipe === expected.pipe && actual.effort === expected.effort && actual.identityVerified === true
    && actual.seatId === expected.seatId && actual.identityId === expected.identityId;
}

function checkpointFailures(
  checkpoints: readonly LiveCheckpoint[],
  artifacts: LiveArtifactSet | undefined,
  through: number,
): string[] {
  const failures: string[] = [];
  if (!artifacts) failures.push('owner checkpoints: materialized campaign artifacts are missing');
  if (checkpoints.length < through || (through === WAVE8_LIVE_CHECKPOINTS.length
    && checkpoints.length !== through)) {
    failures.push(`owner checkpoints: the first ${through} decisions are required`);
  }
  const relevant = checkpoints.slice(0, through);
  if (relevant.map(checkpoint => checkpoint.id).some((id, index, ids) => ids.indexOf(id) !== index)) {
    failures.push('owner checkpoints: duplicate decision');
  }
  for (const [index, id] of WAVE8_LIVE_CHECKPOINTS.slice(0, through).entries()) {
    const checkpoint = checkpoints[index];
    if (!checkpoint || checkpoint.id !== id) { failures.push(`owner checkpoints: ${id} is missing or out of sequence`); continue; }
    if (!artifacts || checkpoint.contactSheetDigest !== artifacts.contactSheetDigest
      || JSON.stringify(checkpoint.playableArtifactDigests) !== JSON.stringify(artifacts.playableArtifactDigests)) {
      failures.push(`owner checkpoints: ${id} is bound to different artifacts`);
    }
    const allowed: Record<LiveCheckpointId, readonly string[]> = {
      preference: ['winner', 'tie', 'reject'],
      'release-worthiness': ['release-worthy', 'not-release-worthy'],
      'learning-authorization': ['allow', 'deny'], promotion: ['promote', 'do-not-promote'],
      merge: ['merge', 'do-not-merge'], 'final-release': ['release', 'do-not-release'],
    };
    if (!allowed[id].includes(checkpoint.decision)) failures.push(`owner checkpoints: ${id} decision is invalid`);
    if (!validDigest(checkpoint.decisionDigest)
      || digestLiveProtocol(withoutField(checkpoint, 'decisionDigest')) !== checkpoint.decisionDigest) failures.push(`owner checkpoints: ${id} decision digest mismatch`);
  }
  return failures;
}

function materializedArtifacts(receipt: LiveProtocolReceipt): LiveArtifactSet | undefined {
  return receipt.freeze.artifacts.mode === 'planned'
    ? receipt.materializedArtifacts : receipt.freeze.artifacts;
}

function materializedArtifactFailures(receipt: LiveProtocolReceipt): string[] {
  if (receipt.freeze.artifacts.mode !== 'planned' && receipt.materializedArtifacts) {
    return ['artifacts: post-generation artifacts require a planned freeze commitment'];
  }
  const artifacts = materializedArtifacts(receipt);
  if (!artifacts) return ['artifacts: generated contact sheet and playables are missing'];
  const failures: string[] = [];
  if (!validDigest(artifacts.contactSheetDigest)
    || artifacts.playableArtifactDigests.length === 0
    || artifacts.playableArtifactDigests.some(item => !validDigest(item))) {
    failures.push('artifacts: materialized campaign artifact digests are invalid');
  }
  if (receipt.freeze.artifacts.mode === 'planned'
    && artifacts.playableArtifactDigests.length !== receipt.freeze.artifacts.expectedPlayableArtifactCount) {
    failures.push('artifacts: materialized playable count does not match the frozen commitment');
  }
  return failures;
}

function checkpointDecisionFailures(
  checkpoints: readonly LiveCheckpoint[],
  through: number,
): string[] {
  const required: readonly LiveCheckpoint['decision'][] = [
    'winner', 'release-worthy', 'allow', 'promote', 'merge', 'release',
  ];
  return WAVE8_LIVE_CHECKPOINTS.slice(0, through).flatMap((id, index) => {
    const checkpoint = checkpoints[index];
    return checkpoint?.id === id && checkpoint.decision === required[index]
      ? [] : [`owner checkpoints: positive ${id} decision is required`];
  });
}

function solFailures(evidence: SolApprovalEvidence | undefined, freeze: LiveProtocolFreeze): string[] {
  // Role id remains sol-approval for schema stability; identity is Kimi K3 (owner 2026-08-07).
  const failures = boundFailures(evidence, freeze, 'Critical harness approval', 'live-provider');
  if (!evidence) return failures;
  if (evidence.critical !== true) {
    failures.push('Critical harness approval: critical approval is not asserted');
  }
  const harness = freeze.roles.find(role =>
    role.role === 'harness' && isWave8CriticalHarnessModel(role.model));
  if (!harness || !identityMatches(evidence.executor, harness)) {
    failures.push('Critical harness approval: exact frozen Kimi-K3 identity is missing');
  }
  if (!isWave8CriticalHarnessModel(evidence.executor.model) || evidence.executor.effort !== 'high') {
    failures.push('Critical harness approval: high-effort Kimi K3 is required');
  }
  if (!validDigest(evidence.approvalDigest)
    || evidence.approvalDigest !== digestLiveProtocol(withoutField(evidence, 'approvalDigest'))) {
    failures.push('Critical harness approval: approval digest is invalid');
  }
  return failures;
}

function productReviewFailures(evidence: ProductReviewEvidence | undefined, freeze: LiveProtocolFreeze): string[] {
  const failures = boundFailures(evidence, freeze, 'Product review', 'live-provider');
  if (!evidence) return failures;
  const reviewer = evidence.reviewer;
  const frozenReviewer = freeze.roles.find(role => role.role === reviewer.role
    && role.seatId === reviewer.seatId && role.identityId === reviewer.identityId);
  if (!frozenReviewer || !identityMatches(reviewer, frozenReviewer)) failures.push('Product review: reviewer identity is not the frozen role');
  const accepted = (reviewer.model === 'gpt-5.6-terra' && reviewer.effort === 'high')
    || (isWave8CriticalHarnessModel(reviewer.model) && reviewer.effort === 'high'
      && evidence.authorIndependent === true)
    || (reviewer.model === 'gpt-5.6-sol' && reviewer.effort === 'high'
      && evidence.authorIndependent === true);
  if (!accepted) {
    failures.push(
      'Product review: Terra high or author-independent Kimi-K3 high is required',
    );
  }
  if (reviewer.identityVerified !== true || !validDigest(evidence.reviewDigest)
    || evidence.reviewDigest !== digestLiveProtocol(withoutField(evidence, 'reviewDigest'))) {
    failures.push('Product review: reviewer identity or digest is invalid');
  }
  if (isWave8CriticalHarnessModel(reviewer.model) && evidence.authorIndependent !== true) {
    failures.push('Product review: Kimi-K3 review must be author-independent');
  }
  if (reviewer.model === 'gpt-5.6-sol' && evidence.authorIndependent !== true) {
    failures.push('Product review: Sol review must be author-independent');
  }
  return failures;
}

function conjunctFailures(
  conjunctEvidence: Partial<Record<LiveConjunctId, LiveConjunctEvidence>> | undefined,
  freeze: LiveProtocolFreeze,
): { reports: LiveProtocolConjunct[]; failures: string[] } {
  const reports: LiveProtocolConjunct[] = [];
  const failures: string[] = [];
  for (const id of WAVE8_LIVE_CONJUNCTS) {
    const evidence = conjunctEvidence?.[id];
    const evidenceFailures = boundFailures(evidence, freeze, id, 'execution');
    if (evidence && evidence.id !== id) evidenceFailures.push(`${id}: evidence ID mismatch`);
    if (evidence && !validDigest(evidence.detailDigest)) evidenceFailures.push(`${id}: detail digest is invalid`);
    const report = conjunct(id, evidenceFailures);
    reports.push(report);
    failures.push(...report.failures.map(failure => `${id}: ${failure}`));
  }
  return { reports, failures };
}

function protocolWithoutDigest(receipt: LiveProtocolReceipt): Omit<LiveProtocolReceipt, 'receiptDigest'> {
  return withoutField(receipt, 'receiptDigest');
}

export function validateLiveProtocol(
  receipt: LiveProtocolReceipt,
  context: LiveProtocolContext = {},
): LiveProtocolReport {
  const freeze = receipt.freeze;
  const blockers: string[] = [];
  if (receipt.schema !== LIVE_PROTOCOL_SCHEMA || receipt.schemaVersion !== LIVE_PROTOCOL_SCHEMA_VERSION) blockers.push('protocol: schema mismatch');
  if (!receipt.receiptDigest && !context.allowProvisionalReceipt) blockers.push('protocol: receipt digest is missing');
  if (receipt.receiptDigest && (!validDigest(receipt.receiptDigest) || digestLiveProtocol(protocolWithoutDigest(receipt)) !== receipt.receiptDigest)) blockers.push('protocol: receipt digest mismatch');
  blockers.push(...freezeFailures(freeze, receipt.ownerApproval));
  if (receipt.ownerApproval && context.now && Date.parse(receipt.ownerApproval.approvedAt) > Date.parse(context.now)) {
    blockers.push('owner ceiling: approval is from the future');
  }
  const currentBindings = { exactHead: context.exactHead, planDigest: context.planDigest, schemaDigest: context.schemaDigest,
    implementationDigest: context.implementationDigest, sourceDigest: context.sourceDigest };
  for (const [key, value] of Object.entries(currentBindings)) {
    if (value !== undefined && value !== freeze[key as keyof LiveProtocolFreeze]) blockers.push(`protocol: current ${key} is stale`);
  }
  if (fundingMode(receipt) === 'metered-api') {
    blockers.push(...priceFailures(receipt.priceReceipt, freeze, context).failures);
  } else if (receipt.priceReceipt) {
    blockers.push('price: receipt is not permitted for subscription-seat funding');
  }
  const noSpend = boundFailures(receipt.noSpendEvidence, freeze, 'No-spend evidence', 'deterministic-proof');
  if (receipt.noSpendEvidence && receipt.noSpendEvidence.providerLedgerCallIds.length !== 0) noSpend.push('No-spend evidence: provider ledger is not empty');
  blockers.push(...noSpend);
  blockers.push(...authorityFailures(receipt, context));
  const sol = solFailures(receipt.solApproval, freeze);
  const product = productReviewFailures(receipt.productReview, freeze);
  const actualArtifacts = materializedArtifacts(receipt);
  const artifacts = materializedArtifactFailures(receipt);
  const mergeCheckpoints = checkpointFailures(receipt.ownerCheckpoints, actualArtifacts, 5);
  const finalCheckpoints = checkpointFailures(receipt.ownerCheckpoints, actualArtifacts, 6);
  const conjuncts = conjunctFailures(receipt.conjunctEvidence, freeze);
  const paidFailures = [...blockers, ...sol];
  const paidExecutionAllowed = paidFailures.length === 0;
  const mergeFailures = [...paidFailures, ...artifacts, ...product,
    ...mergeCheckpoints,
    ...checkpointDecisionFailures(receipt.ownerCheckpoints, 5),
    ...conjuncts.reports.filter(item => item.id === 'merged-main' || item.id === 'forgejo-ci').flatMap(item => item.failures)];
  const finalReleaseFailures = [...mergeFailures, ...product, ...checkpointDecisionFailures(receipt.ownerCheckpoints, 6),
    ...finalCheckpoints, ...conjuncts.failures];
  blockers.push(...sol, ...artifacts, ...product, ...finalCheckpoints, ...conjuncts.failures);
  return deepFreeze({
    schema: LIVE_PROTOCOL_SCHEMA, schemaVersion: LIVE_PROTOCOL_SCHEMA_VERSION,
    freezeDigest: freeze.freezeDigest, paidExecutionAllowed,
    mergeAllowed: mergeFailures.length === 0, finalReleaseAllowed: finalReleaseFailures.length === 0,
    conjuncts: conjuncts.reports, blockers: [...new Set(blockers)],
  });
}

export function buildLiveProtocol(input: LiveProtocolInput): LiveProtocolReceipt {
  const freezeBody = clone(input.frozen);
  const freeze = deepFreeze({ ...freezeBody, freezeDigest: digestLiveProtocol(freezeBody) });
  const receiptBody = {
    schema: LIVE_PROTOCOL_SCHEMA,
    schemaVersion: LIVE_PROTOCOL_SCHEMA_VERSION,
    freeze,
    ...(input.ownerApproval ? { ownerApproval: clone(input.ownerApproval) } : {}),
    ...(input.priceReceipt ? { priceReceipt: clone(input.priceReceipt) } : {}),
    ...(input.noSpendEvidence ? { noSpendEvidence: clone(input.noSpendEvidence) } : {}),
    ...(input.solApproval ? { solApproval: clone(input.solApproval) } : {}),
    ...(input.productReview ? { productReview: clone(input.productReview) } : {}),
    ...(input.materializedArtifacts
      ? { materializedArtifacts: clone(input.materializedArtifacts) } : {}),
    ownerCheckpoints: clone([...(input.ownerCheckpoints ?? [])]),
    conjunctEvidence: clone({ ...(input.conjuncts ?? {}) }),
    attestations: clone([...(input.attestations ?? [])]),
  } as Omit<LiveProtocolReceipt, 'report' | 'receiptDigest'>;
  const provisional = { ...receiptBody, report: {} as LiveProtocolReport, receiptDigest: '' } as LiveProtocolReceipt;
  const report = validateLiveProtocol({ ...provisional, report: {} as LiveProtocolReport }, {
    now: input.frozen.frozenAt, allowProvisionalReceipt: true,
  });
  const complete = { ...receiptBody, report, receiptDigest: '' } as LiveProtocolReceipt;
  const receipt = deepFreeze({ ...complete, receiptDigest: digestLiveProtocol(protocolWithoutDigest(complete)) });
  return receipt;
}

export function assertLiveProtocolAllowsPaidExecution(
  receipt: LiveProtocolReceipt,
  context: LiveProtocolContext = {},
): LiveProtocolReport {
  const report = validateLiveProtocol(receipt, { ...context, allowProvisionalReceipt: false });
  if (!report.paidExecutionAllowed) throw new Error(`Live protocol blocked paid execution: ${report.blockers.join('; ')}`);
  return report;
}

export function assertLiveProtocolReceiptCurrent(
  receipt: LiveProtocolReceipt,
  context: Required<Pick<LiveProtocolContext, 'exactHead' | 'planDigest' | 'schemaDigest' | 'implementationDigest' | 'sourceDigest' | 'trust'>>
    & Pick<LiveProtocolContext, 'now' | 'maxPriceAgeMs'>,
): LiveProtocolReport {
  return assertLiveProtocolAllowsPaidExecution(parseLiveProtocolReceipt(receipt), context);
}
