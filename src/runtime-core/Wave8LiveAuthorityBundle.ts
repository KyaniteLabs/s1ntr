import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import {
  loadPinnedProductionHostAuthority,
  type HostAuthorityBootstrap,
} from '../identity/executorAuthorityBootstrap.js';
import {
  verifyExecutorAttestation,
  type ExecutorAttestation,
} from '../identity/executorAttestation.js';
import {
  createPreSpendFeasibilityProof,
  canonicalWave8TrustStorePath,
  type PaidCallSlot,
  type PreSpendInterlockPolicy,
  type Wave8LiveExecutionConfig,
} from '../llm/PreSpendInterlock.js';
import {
  assertLiveProtocolReceiptCurrent,
  buildLiveProtocol,
  digestLiveProtocol,
  type LiveAuthorityAttestation,
  type LiveProtocolInput,
  type LiveProtocolReceipt,
  type LiveRoleIdentity,
  type OwnerSubscriptionSeatApproval,
} from './LiveProtocol.js';
import { deriveUltraQAActiveDigests } from './DeterministicUltraQA.js';
import { createWave8EvidenceReceipt, createWave8ReleaseRoot,
  type Wave8ReleaseRoot } from './Wave8ReleaseRoot.js';
import { computeProofSourceFingerprint, readCurrentGitCommit, readGitRef } from './ProofReceiptValidator.js';
import {
  WAVE8_CRITICAL_HARNESS_MODEL,
  isWave8CriticalHarnessModel,
  wave8CriticalHarnessModelFromExecutor,
} from './Wave8CriticalHarness.js';

const digestSchema = z.string().regex(/^[a-f0-9]{64}$/);
const headSchema = z.string().regex(/^[a-f0-9]{40}$/);

export interface LiveAuthoritySlot extends PaidCallSlot {
  readonly seatId: string;
  readonly pipe: string;
  readonly effort: string;
}

const slotSchema = z.object({
  id: z.string().min(1), releaseRunSlotId: z.string().min(1).optional(),
  subscriptionTransport: z.enum(['host-adapter', 'campaign-host']),
  purpose: z.enum(['product', 'sol-review-bootstrap']), provider: z.string().min(1),
  model: z.string().min(1), role: z.enum(['harness', 'generator', 'evaluator', 'critic']),
  identityId: z.string().min(1).optional(), minCalls: z.number().int().min(0),
  maxCalls: z.number().int().positive(), maxInputTokens: z.number().int().positive(),
  maxOutputTokens: z.number().int().positive(), minActiveMinutes: z.number().int().positive(),
  requestDigest: digestSchema.optional(), seatId: z.string().min(1),
  pipe: z.string().min(1), effort: z.string().min(1),
}).strict();

export const liveAuthoritySpecSchema = z.object({
  schema: z.literal('sinter.wave8-live-authority-spec'), schemaVersion: z.literal(1),
  planPath: z.string().min(1), ownerApprovalPath: z.string().min(1),
  trustStorePath: z.string().min(1),
  noSpendEvidencePath: z.string().min(1), evidenceSchedulePath: z.string().min(1),
  requiredGitRef: z.literal('refs/remotes/origin/main').optional(),
  expectedPlayableArtifactCount: z.number().int().positive(),
  campaignArtifacts: z.object({
    manifestPath: z.string().min(1), executionPath: z.string().min(1),
    ownerReviewPackagePath: z.string().min(1), subscriptionRouteAttestationPath: z.string().min(1),
    phaseOneEnforcementPath: z.string().min(1),
  }).strict(),
  maxActiveMinutes: z.number().int().positive(), maxRetriesPerStage: z.number().int().min(0),
  briefs: z.array(z.object({ id: z.string().min(1), path: z.string().min(1) }).strict()).min(1),
  slots: z.array(slotSchema).min(3),
}).strict();

export type LiveAuthoritySpec = z.infer<typeof liveAuthoritySpecSchema>;

const identitySchema = z.object({
  role: z.string().min(1), provider: z.string().min(1), model: z.string().min(1),
  pipe: z.string().min(1), effort: z.string().min(1), identityVerified: z.literal(true),
  seatId: z.string().min(1).optional(), identityId: z.string().min(1).optional(),
}).strict();

const attestationSchema = z.object({
  schema: z.literal('sinter.wave8-live-authority-attestation'), schemaVersion: z.literal(1),
  authorityId: z.string().min(1), role: z.enum(['owner', 'price', 'sol-approval', 'product-review']),
  subjectDigest: digestSchema, issuedAt: z.string().datetime(), expiresAt: z.string().datetime(),
  nonce: z.string().min(1), signatureBase64: z.string().min(1),
}).strict();

export const externalReviewSchema = z.object({
  schema: z.literal('sinter.wave8-external-review'), schemaVersion: z.literal(1),
  kind: z.enum(['sol-approval', 'product-review']), decision: z.literal('approve'),
  contextDigest: digestSchema, exactHead: headSchema, sourceDigest: digestSchema,
  planDigest: digestSchema, specDigest: digestSchema,
  schemaDigest: digestSchema, implementationDigest: digestSchema,
  reviewer: identitySchema, authorIndependent: z.boolean(),
  reviewedArtifactDigests: z.array(digestSchema).min(1),
  workerId: z.string().regex(/^w-[a-z0-9-]+$/), workerReceiptPath: z.string().min(1),
  executorAttestationPath: z.string().min(1), reviewArtifactPath: z.string().min(1),
  findings: z.array(z.string()).length(0), attestation: attestationSchema,
}).strict();

export type ExternalReview = z.infer<typeof externalReviewSchema>;

const ownerApprovalSchema = z.object({
  schema: z.literal('sinter.owner-subscription-seat-approval'), ownerId: z.string().min(1),
  fundingMode: z.literal('subscription-seat'), approvedSeatIds: z.array(z.string().min(1)).min(1),
  resourceBudgetDigest: digestSchema, planDigest: digestSchema,
  approvedAt: z.string().datetime(), approvalDigest: digestSchema,
}).strict();

const ownerAuthoritySchema = z.object({
  schema: z.literal('sinter.wave8-owner-authority'), schemaVersion: z.literal(1),
  approval: ownerApprovalSchema, attestation: attestationSchema,
}).strict();

const trustStoreSchema = z.object({
  schema: z.literal('sinter.wave8-live-trust-store'), schemaVersion: z.literal(1),
  keys: z.array(z.object({ keyId: z.string().min(1), authorityId: z.string().min(1),
    role: z.enum(['owner', 'sol-approval', 'product-review']), publicKeyPem: z.string().min(1) }).strict()).length(3),
  credentialBindings: z.array(z.object({ bindingId: z.string().min(1), provider: z.string().min(1),
    model: z.string().min(1), seatId: z.string().min(1) }).strict()).min(1),
}).strict();

export interface LiveAuthorityReviewContext {
  readonly schema: 'sinter.wave8-live-authority-review-context';
  readonly schemaVersion: 1;
  readonly exactHead: string;
  readonly sourceDigest: string;
  readonly planDigest: string;
  readonly specDigest: string;
  readonly schemaDigest: string;
  readonly implementationDigest: string;
  readonly campaignArtifactBindingsDigest: string;
  readonly artifactDigests: readonly string[];
  readonly contextDigest: string;
}

export interface Wave8LiveAuthorityBundle {
  readonly context: LiveAuthorityReviewContext;
  readonly releaseRoot: Wave8ReleaseRoot;
  readonly receipt: LiveProtocolReceipt;
  readonly config: Wave8LiveExecutionConfig;
  readonly trustStorePath: string;
}

function fileDigest(filePath: string): string {
  return createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function repoFile(repoRoot: string, candidate: string, label: string): string {
  const resolved = path.resolve(repoRoot, candidate);
  const canonicalRoot = fs.realpathSync(repoRoot);
  const canonical = fs.realpathSync(resolved);
  const relative = path.relative(canonicalRoot, canonical);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative) || !fs.statSync(canonical).isFile()) {
    throw new Error(`Wave 8 live authority ${label} must be an existing repository file`);
  }
  return canonical;
}

function externalTrust(repoRoot: string, candidate: string, expectedPath: string) {
  if (!path.isAbsolute(candidate)) throw new Error('Wave 8 trust store path must be absolute');
  const canonicalRoot = fs.realpathSync(repoRoot);
  const canonical = fs.realpathSync(candidate);
  const expected = fs.realpathSync(expectedPath);
  const relative = path.relative(canonicalRoot, canonical);
  const info = fs.statSync(canonical);
  if (canonical !== expected || (!relative.startsWith('..') && !path.isAbsolute(relative)) || !info.isFile()
    || info.nlink !== 1 || (info.mode & 0o077) !== 0
    || (process.getuid && info.uid !== process.getuid())) {
    throw new Error('Wave 8 trust store must be owner-only and outside the repository');
  }
  const store = trustStoreSchema.parse(JSON.parse(fs.readFileSync(canonical, 'utf8')));
  if (new Set(store.keys.map(key => key.role)).size !== 3
    || new Set(store.keys.map(key => key.keyId)).size !== 3
    || new Set(store.credentialBindings.map(item => item.bindingId)).size
      !== store.credentialBindings.length) {
    throw new Error('Wave 8 trust store authorities or credential bindings are duplicated');
  }
  const owner = store.keys.find(key => key.role === 'owner')!;
  return { path: canonical, store, trust: { owner: { authorityId: owner.authorityId,
    publicKeyPem: owner.publicKeyPem }, providers: store.keys.filter(
      (key): key is typeof key & { role: 'sol-approval' | 'product-review' } => key.role !== 'owner')
      .map(key => ({ authorityId: key.authorityId, role: key.role,
        publicKeyPem: key.publicKeyPem })) } };
}

function externalOwnedFile(repoRoot: string, candidate: string, label: string): string {
  if (!path.isAbsolute(candidate)) throw new Error(`Wave 8 ${label} path must be absolute`);
  const canonical = fs.realpathSync(candidate);
  const relative = path.relative(fs.realpathSync(repoRoot), canonical);
  const info = fs.statSync(canonical);
  if ((!relative.startsWith('..') && !path.isAbsolute(relative)) || !info.isFile()
    || info.nlink !== 1 || (process.getuid && info.uid !== process.getuid())) {
    throw new Error(`Wave 8 ${label} must be an owner-controlled file outside the repository`);
  }
  return canonical;
}

function verifyReviewExecutor(repoRoot: string, review: ExternalReview,
  context: LiveAuthorityReviewContext, now: string,
  hostAuthority: HostAuthorityBootstrap): string {
  const receiptPath = externalOwnedFile(repoRoot, review.executorAttestationPath,
    'executor attestation');
  const attestation = JSON.parse(fs.readFileSync(receiptPath, 'utf8')) as ExecutorAttestation;
  const { registry } = hostAuthority;
  const verified = verifyExecutorAttestation(registry, attestation, now);
  if (!verified.ok) {
    throw new Error(`Wave 8 ${review.kind} executor attestation is invalid: ${verified.reason}`);
  }
  const subject = attestation.subject;
  const artifactPath = externalOwnedFile(repoRoot, review.reviewArtifactPath, 'review artifact');
  const successful = subject.schemaVersion === 'executor-attestation.v3' && subject.success;
  const identity = subject.resolvedIdentity;
  if (!successful || subject.requestDigest !== context.contextDigest
    || identity.provider !== review.reviewer.provider || identity.model !== review.reviewer.model
    || identity.effort !== review.reviewer.effort || subject.effort !== review.reviewer.effort
    || subject.seat.seatId !== review.reviewer.seatId
    || subject.funding.mode !== 'subscription-seat'
    || (subject.schemaVersion === 'executor-attestation.v3'
      && subject.responseDigest !== fileDigest(artifactPath))) {
    throw new Error(`Wave 8 ${review.kind} executor attestation does not bind the review identity`);
  }
  return artifactPath;
}

function dispatchReviewArtifact(repoRoot: string, review: ExternalReview,
  context: LiveAuthorityReviewContext, now: string,
  hostAuthority: HostAuthorityBootstrap): string {
  const reviewArtifact = verifyReviewExecutor(repoRoot, review, context, now, hostAuthority);
  const statusPath = externalOwnedFile(repoRoot, review.workerReceiptPath, 'dispatch receipt');
  const status = JSON.parse(fs.readFileSync(statusPath, 'utf8')) as Record<string, unknown>;
  const dispatchReceipt = status.schema_version === 3 && status.worker_id === review.workerId
    && status.current_phase === 'done' && status.exit_code === 0;
  const collaborationReceipt = status.schema === 'sinter.codex-collaboration-review-receipt'
    && status.schemaVersion === 1 && status.workerId === review.workerId
    && status.status === 'done' && status.exitCode === 0
    && status.exactHead === context.exactHead && status.contextDigest === context.contextDigest
    && externalOwnedFile(repoRoot, String(status.reviewArtifactPath ?? ''),
      'collaboration review artifact') === reviewArtifact;
  if (!dispatchReceipt && !collaborationReceipt) {
    throw new Error(`Wave 8 ${review.kind} review receipt is incomplete or failed`);
  }
  const expectedModel = status.executor === 'codex-terra' ? 'gpt-5.6-terra'
    : (process.env.SINTER_WAVE8_ALLOW_MINIMAX_PRODUCT_REVIEW === '1'
      && typeof status.executor === 'string'
      && status.executor === review.reviewer.model
      && (review.reviewer.model === 'minimax-m3' || review.reviewer.model === 'glm-5.2'
        || review.reviewer.model === 'google/gemini-3.5-flash'
        || review.reviewer.model === 'gemini-3.1-pro-low'
        || review.reviewer.model === 'gemini-3.6-flash-high'))
      ? review.reviewer.model
    : wave8CriticalHarnessModelFromExecutor(status.executor, review.reviewer.model)
      ?? (status.executor === 'codex-sol' ? 'gpt-5.6-sol' : undefined);
  // codex-sol kept only for legacy product-review fixtures; critical harness is Kimi K3.
  if (!expectedModel || review.reviewer.model !== expectedModel) {
    throw new Error(`Wave 8 ${review.kind} identity does not match its review receipt`);
  }
  const logPath = collaborationReceipt ? reviewArtifact
    : externalOwnedFile(repoRoot, String(status.log_path ?? ''), 'dispatch review log');
  const log = fs.readFileSync(logPath, 'utf8');
  const verdicts = [...log.matchAll(/^\s*(APPROVE|REQUEST_CHANGES)\s*$/gm)].map(match => match[1]);
  if (!log.includes(context.exactHead) || verdicts.at(-1) !== 'APPROVE') {
    throw new Error(`Wave 8 ${review.kind} dispatch log lacks exact-head approval`);
  }
  const artifact = fs.readFileSync(reviewArtifact, 'utf8');
  const artifactVerdicts = [...artifact.matchAll(/^\s*(APPROVE|REQUEST_CHANGES)\s*$/gm)]
    .map(match => match[1]);
  if (!artifact.includes(context.exactHead) || artifactVerdicts.at(-1) !== 'APPROVE') {
    throw new Error(`Wave 8 ${review.kind} executor response lacks exact-head approval`);
  }
  return reviewArtifact;
}

function contextBody(context: Omit<LiveAuthorityReviewContext, 'contextDigest'>): string {
  return digestLiveProtocol(context);
}

export function prepareLiveAuthorityReviewContext(
  repoRoot: string,
  rawSpec: unknown,
): LiveAuthorityReviewContext {
  const spec = liveAuthoritySpecSchema.parse(rawSpec);
  const exactHead = readCurrentGitCommit(repoRoot);
  const sourceDigest = computeProofSourceFingerprint(repoRoot)?.replace(/^sha256:/, '');
  if (!exactHead || !sourceDigest) throw new Error('Wave 8 live authority source binding is unavailable');
  if (spec.requiredGitRef && readGitRef(repoRoot, spec.requiredGitRef) !== exactHead) {
    throw new Error(`Wave 8 live authority HEAD is not merged at ${spec.requiredGitRef}`);
  }
  const active = deriveUltraQAActiveDigests(repoRoot);
  const artifacts = [repoFile(repoRoot, spec.planPath, 'plan'),
    repoFile(repoRoot, spec.evidenceSchedulePath, 'evidence schedule'),
    repoFile(repoRoot, spec.noSpendEvidencePath, 'no-spend evidence'),
    ...spec.briefs.map(brief => repoFile(repoRoot, brief.path, `brief ${brief.id}`)),
    repoFile(repoRoot, spec.campaignArtifacts.manifestPath, 'campaign manifest'),
    repoFile(repoRoot, spec.campaignArtifacts.executionPath, 'campaign execution'),
    repoFile(repoRoot, spec.campaignArtifacts.ownerReviewPackagePath, 'owner review package'),
    repoFile(repoRoot, spec.campaignArtifacts.subscriptionRouteAttestationPath, 'subscription route attestation'),
    repoFile(repoRoot, spec.campaignArtifacts.phaseOneEnforcementPath, 'phase-one enforcement')];
  const campaignArtifactBindingsDigest = digestLiveProtocol({
    manifest: { path: repoFile(repoRoot, spec.campaignArtifacts.manifestPath, 'campaign manifest'),
      digest: fileDigest(repoFile(repoRoot, spec.campaignArtifacts.manifestPath, 'campaign manifest')) },
    execution: { path: repoFile(repoRoot, spec.campaignArtifacts.executionPath, 'campaign execution'),
      digest: fileDigest(repoFile(repoRoot, spec.campaignArtifacts.executionPath, 'campaign execution')) },
    ownerReviewPackage: { path: repoFile(repoRoot,
      spec.campaignArtifacts.ownerReviewPackagePath, 'owner review package'),
    digest: fileDigest(repoFile(repoRoot,
      spec.campaignArtifacts.ownerReviewPackagePath, 'owner review package')) },
    subscriptionRouteAttestation: { path: repoFile(repoRoot,
      spec.campaignArtifacts.subscriptionRouteAttestationPath, 'subscription route attestation'),
    digest: fileDigest(repoFile(repoRoot,
      spec.campaignArtifacts.subscriptionRouteAttestationPath, 'subscription route attestation')) },
    phaseOneEnforcement: { path: repoFile(repoRoot,
      spec.campaignArtifacts.phaseOneEnforcementPath, 'phase-one enforcement'),
      digest: fileDigest(repoFile(repoRoot,
      spec.campaignArtifacts.phaseOneEnforcementPath, 'phase-one enforcement')) },
    productStageIdsDigest: digestLiveProtocol(spec.slots.filter(slot => slot.purpose === 'product')
      .map(slot => slot.id).sort()),
  });
  const body = { schema: 'sinter.wave8-live-authority-review-context' as const, schemaVersion: 1 as const,
    exactHead, sourceDigest, planDigest: fileDigest(artifacts[0]!),
    specDigest: digestLiveProtocol(spec),
    schemaDigest: active.schema, implementationDigest: active.implementation,
    campaignArtifactBindingsDigest,
    artifactDigests: artifacts.map(fileDigest) };
  return { ...body, contextDigest: contextBody(body) };
}

function frozenRoles(slots: readonly LiveAuthoritySlot[]): {
  roles: LiveRoleIdentity[];
  rows: Array<{ role: string; identityId?: string; maxCalls: number;
    maxInputTokens: number; maxOutputTokens: number; maxRetries: number }>;
} {
  const groups = new Map<string, LiveAuthoritySlot[]>();
  for (const slot of slots) {
    const key = `${slot.role}:${slot.identityId ?? ''}`;
    groups.set(key, [...(groups.get(key) ?? []), slot]);
  }
  const roles: LiveRoleIdentity[] = [];
  const rows = [...groups.values()].map(group => {
    const first = group[0]!;
    const identity = ['provider', 'model', 'pipe', 'effort', 'seatId', 'maxInputTokens',
      'maxOutputTokens'] as const;
    if (group.some(slot => identity.some(key => slot[key] !== first[key]))) {
      throw new Error(`Wave 8 live authority role ${first.role} has conflicting slot identities or caps`);
    }
    roles.push({ role: first.role, provider: first.provider, model: first.model,
      pipe: first.pipe, effort: first.effort, identityVerified: true, seatId: first.seatId,
      ...(first.identityId ? { identityId: first.identityId } : {}) });
    return { role: first.role, ...(first.identityId ? { identityId: first.identityId } : {}),
      maxCalls: group.reduce((sum, slot) => sum + slot.maxCalls, 0),
      maxInputTokens: first.maxInputTokens, maxOutputTokens: first.maxOutputTokens,
      maxRetries: 0 };
  });
  return { roles, rows };
}

function sameIdentity(actual: LiveRoleIdentity, expected: LiveRoleIdentity): boolean {
  return ['role', 'provider', 'model', 'pipe', 'effort', 'identityVerified', 'seatId',
    'identityId'].every(key => actual[key as keyof LiveRoleIdentity]
      === expected[key as keyof LiveRoleIdentity]);
}

function validateReview(raw: unknown, kind: ExternalReview['kind'], context: LiveAuthorityReviewContext,
  roles: readonly LiveRoleIdentity[]): ExternalReview {
  const review = externalReviewSchema.parse(raw);
  if (review.kind !== kind || review.contextDigest !== context.contextDigest
    || review.attestation.role !== kind
    || review.exactHead !== context.exactHead || review.sourceDigest !== context.sourceDigest
    || review.planDigest !== context.planDigest || review.specDigest !== context.specDigest
    || review.schemaDigest !== context.schemaDigest
    || review.implementationDigest !== context.implementationDigest
    || JSON.stringify(review.reviewedArtifactDigests) !== JSON.stringify(context.artifactDigests)) {
    throw new Error(`Wave 8 ${kind} is not bound to the exact review context`);
  }
  const frozen = roles.find(role => sameIdentity(role, review.reviewer));
  if (!frozen) throw new Error(`Wave 8 ${kind} reviewer is not a frozen identity`);
  if (kind === 'sol-approval'
    && (review.reviewer.role !== 'harness'
      || !isWave8CriticalHarnessModel(review.reviewer.model)
      || review.reviewer.effort !== 'high')) {
    throw new Error(
      'Wave 8 critical approval requires the frozen Kimi-K3 harness identity (owner: replaces Sol)',
    );
  }
  if (kind === 'product-review') {
    const altHour = process.env.SINTER_WAVE8_ALLOW_MINIMAX_PRODUCT_REVIEW === '1'
      && review.authorIndependent === true
      && (review.reviewer.model === 'minimax-m3' || review.reviewer.model === 'glm-5.2'
        || review.reviewer.model === 'google/gemini-3.5-flash'
        || review.reviewer.model === 'gemini-3.1-pro-low'
        || review.reviewer.model === 'gemini-3.6-flash-high');
    const critical = review.reviewer.effort === 'high'
      && (review.reviewer.model === 'gpt-5.6-terra'
        || (isWave8CriticalHarnessModel(review.reviewer.model) && review.authorIndependent)
        || (review.reviewer.model === 'gpt-5.6-sol' && review.authorIndependent)
        || altHour);
    if (!critical) {
      throw new Error(
        'Wave 8 product review requires Terra-high or author-independent Kimi-K3 (or legacy Sol-high)',
      );
    }
  }
  return review;
}

function policy(spec: LiveAuthoritySpec, context: LiveAuthorityReviewContext,
  noSpendDigest: string, solDigest: string): PreSpendInterlockPolicy {
  const slots = spec.slots as LiveAuthoritySlot[];
  const budgetRows = slots.map(slot => ({ slotId: slot.id, maxCalls: slot.maxCalls,
    maxInputTokens: slot.maxInputTokens, maxOutputTokens: slot.maxOutputTokens,
    minActiveMinutes: slot.minActiveMinutes }));
  const approvedSeatIds = [...new Set(slots.map(slot => slot.seatId))];
  return { expectedPlanHash: context.planDigest, expectedSourceFingerprint: context.sourceDigest,
    declaredSlots: slots, noSpendProof: { gate: 'noSpendCirculationProof', passed: true,
      planHash: context.planDigest, sourceFingerprint: context.sourceDigest,
      artifactDigest: noSpendDigest, evidenceClass: 'deterministic-proof' },
    solApproval: { gate: 'solHighPreSpendApproval', passed: true,
      planHash: context.planDigest, sourceFingerprint: context.sourceDigest,
      artifactDigest: solDigest, evidenceClass: 'live-provider',
      executor: { model: WAVE8_CRITICAL_HARNESS_MODEL, effort: 'high', identityVerified: true } },
    feasibilityProof: createPreSpendFeasibilityProof({ fundingMode: 'subscription-seat',
      planHash: context.planDigest, sourceFingerprint: context.sourceDigest,
      declaredSlots: slots, budgetRows, approvedSeatIds }) };
}

function validateNoSpend(repoRoot: string, spec: LiveAuthoritySpec,
  context: LiveAuthorityReviewContext): { path: string; digest: string } {
  const noSpendPath = repoFile(repoRoot, spec.noSpendEvidencePath, 'no-spend evidence');
  const evidence = JSON.parse(fs.readFileSync(noSpendPath, 'utf8')) as Record<string, unknown>;
  const sentinel = evidence.transportSentinel as Record<string, unknown> | undefined;
  if (evidence.gate !== 'noSpendCirculationProof' || evidence.passed !== true
    || evidence.evidenceClass !== 'deterministic-proof' || evidence.livePass !== false
    || evidence.head !== context.exactHead || evidence.sourceFingerprint !== context.sourceDigest
    || sentinel?.networkCalls !== 0 || sentinel?.ledgerReservations !== 0 || sentinel?.spendUsd !== 0) {
    throw new Error('Wave 8 no-spend evidence is invalid or stale');
  }
  return { path: noSpendPath, digest: fileDigest(noSpendPath) };
}

function bootstrapRoot(context: LiveAuthorityReviewContext, generatedAt: string): Wave8ReleaseRoot {
  const receipt = createWave8EvidenceReceipt({ receiptId: 'live-schema-invalidation',
    kind: 'schema-invalidation', generatedAt, sourceFingerprint: context.sourceDigest,
    evidenceClass: 'deterministic-proof', passed: true, deterministic: true,
    spendUsd: 0, providerCalls: 0,
    artifactDigests: [context.schemaDigest, context.implementationDigest],
    schemaDigest: context.schemaDigest, implementationDigest: context.implementationDigest,
    payload: { canonicalSchemaSource: 'src/runtime-core/Wave8ReleaseRoot.ts',
      canonicalImplementationSource: 'src/runtime-core/DeterministicUltraQA.ts' } });
  return createWave8ReleaseRoot({ generatedAt, releaseHead: context.exactHead,
    sourceFingerprint: context.sourceDigest,
    activeDigests: { schema: context.schemaDigest, implementation: context.implementationDigest },
    receipts: [receipt] });
}

export function buildWave8LiveAuthorityBundle(input: {
  repoRoot: string;
  outputDir: string;
  spec: unknown;
  solReviewPath: string;
  productReviewPath: string;
  now?: Date;
  /** Injected only by Vitest; production always uses fixed host authority paths. */
  testHostAuthority?: HostAuthorityBootstrap;
  testTrustStorePath?: string;
}): Wave8LiveAuthorityBundle {
  if ((input.testHostAuthority || input.testTrustStorePath) && !process.env.VITEST) {
    throw new Error('Wave 8 live authority test override is unavailable');
  }
  const hostAuthority = input.testHostAuthority ?? loadPinnedProductionHostAuthority();
  const expectedTrust = input.testTrustStorePath ?? canonicalWave8TrustStorePath();
  const spec = liveAuthoritySpecSchema.parse(input.spec);
  const context = prepareLiveAuthorityReviewContext(input.repoRoot, spec);
  const slots = spec.slots as LiveAuthoritySlot[];
  if (new Set(slots.map(slot => slot.id)).size !== slots.length) {
    throw new Error('Wave 8 live authority slot IDs must be unique');
  }
  const harnessSlots = slots.filter(slot => slot.role === 'harness');
  if (harnessSlots.some(slot => !isWave8CriticalHarnessModel(slot.model))) {
    throw new Error('Wave 8 live authority reserves the harness role for Kimi K3 (Sol replacement)');
  }
  if (harnessSlots.length !== 1 || harnessSlots[0]!.effort !== 'high') {
    throw new Error('Wave 8 live authority requires exactly one Kimi-K3-high harness slot');
  }
  const { roles, rows } = frozenRoles(slots);
  const harnesses = roles.filter(role => role.role === 'harness');
  if (harnesses.length !== 1 || !isWave8CriticalHarnessModel(harnesses[0]!.model)
    || harnesses[0]!.effort !== 'high') {
    throw new Error('Wave 8 live authority requires exactly one Kimi-K3-high harness identity');
  }
  const hasIndependentReview = roles.some(role =>
    role.role === 'critic' || role.role === 'evaluator');
  if (!roles.some(role => role.role === 'generator') || !hasIndependentReview) {
    throw new Error('Wave 8 live authority requires generator and independent review identities');
  }
  const solPath = repoFile(input.repoRoot, input.solReviewPath, 'Sol review evidence');
  const productPath = repoFile(input.repoRoot, input.productReviewPath, 'product review evidence');
  const sol = validateReview(JSON.parse(fs.readFileSync(solPath, 'utf8')),
    'sol-approval', context, roles);
  const product = validateReview(JSON.parse(fs.readFileSync(productPath, 'utf8')),
    'product-review', context, roles);
  const noSpend = validateNoSpend(input.repoRoot, spec, context);
  const pinned = externalTrust(input.repoRoot, spec.trustStorePath, expectedTrust);
  const now = input.now ?? new Date();
  const frozenAt = now.toISOString();
  const approvedSeatIds = [...new Set(slots.map(slot => slot.seatId))];
  const budgets = { fundingMode: 'subscription-seat' as const, approvedSeatIds, rows,
    maxActiveMinutes: spec.maxActiveMinutes,
    maxTotalCalls: slots.reduce((sum, slot) => sum + slot.maxCalls, 0),
    maxTotalInputTokens: slots.reduce((sum, slot) => sum + slot.maxCalls * slot.maxInputTokens, 0),
    maxTotalOutputTokens: slots.reduce((sum, slot) => sum + slot.maxCalls * slot.maxOutputTokens, 0),
    maxRetriesPerStage: spec.maxRetriesPerStage };

  const ownerPath = repoFile(input.repoRoot, spec.ownerApprovalPath, 'owner approval');
  const ownerEnvelope = ownerAuthoritySchema.parse(JSON.parse(fs.readFileSync(ownerPath, 'utf8')));
  const ownerApproval = ownerEnvelope.approval as OwnerSubscriptionSeatApproval;
  const campaignArtifacts: Wave8LiveExecutionConfig['campaignArtifacts'] = {
    manifest: { path: repoFile(input.repoRoot, spec.campaignArtifacts.manifestPath, 'campaign manifest'),
      digest: fileDigest(repoFile(input.repoRoot, spec.campaignArtifacts.manifestPath, 'campaign manifest')) },
    execution: { path: repoFile(input.repoRoot, spec.campaignArtifacts.executionPath, 'campaign execution'),
      digest: fileDigest(repoFile(input.repoRoot, spec.campaignArtifacts.executionPath, 'campaign execution')) },
    ownerReviewPackage: { path: repoFile(input.repoRoot,
      spec.campaignArtifacts.ownerReviewPackagePath, 'owner review package'),
    digest: fileDigest(repoFile(input.repoRoot,
      spec.campaignArtifacts.ownerReviewPackagePath, 'owner review package')) },
    subscriptionRouteAttestation: { path: repoFile(input.repoRoot,
      spec.campaignArtifacts.subscriptionRouteAttestationPath, 'subscription route attestation'),
    digest: fileDigest(repoFile(input.repoRoot,
      spec.campaignArtifacts.subscriptionRouteAttestationPath, 'subscription route attestation')) },
    phaseOneEnforcement: { path: repoFile(input.repoRoot,
      spec.campaignArtifacts.phaseOneEnforcementPath, 'phase-one enforcement'),
    digest: fileDigest(repoFile(input.repoRoot,
      spec.campaignArtifacts.phaseOneEnforcementPath, 'phase-one enforcement')) },
    productStageIdsDigest: digestLiveProtocol(slots.filter(slot => slot.purpose === 'product')
      .map(slot => slot.id).sort()),
  };
  const campaignArtifactBindingsDigest = digestLiveProtocol(campaignArtifacts);
  if (campaignArtifactBindingsDigest !== context.campaignArtifactBindingsDigest) {
    throw new Error('Wave 8 campaign artifact bindings drifted after independent review');
  }
  const bound = { passed: true, exactHead: context.exactHead, planDigest: context.planDigest,
    schemaDigest: context.schemaDigest, implementationDigest: context.implementationDigest,
    sourceDigest: context.sourceDigest };
  const solArtifact = dispatchReviewArtifact(input.repoRoot, sol, context, frozenAt, hostAuthority);
  const productArtifact = dispatchReviewArtifact(input.repoRoot, product, context, frozenAt, hostAuthority);
  const solBody = { ...bound, evidenceClass: 'live-provider' as const, critical: true as const,
    executor: sol.reviewer,
    artifactDigests: [fileDigest(solArtifact), context.contextDigest, campaignArtifactBindingsDigest] };
  const solApproval = { ...solBody, approvalDigest: digestLiveProtocol(solBody) };
  const reviewBody = { ...bound, evidenceClass: 'live-provider' as const,
    reviewer: product.reviewer, authorIndependent: product.authorIndependent,
    artifactDigests: [fileDigest(productArtifact), context.contextDigest, campaignArtifactBindingsDigest] };
  const productReview = { ...reviewBody, reviewDigest: digestLiveProtocol(reviewBody) };
  const evidenceSchedule = repoFile(input.repoRoot, spec.evidenceSchedulePath, 'evidence schedule');
  const releaseRoot = bootstrapRoot(context, frozenAt);

  const protocolInput: LiveProtocolInput = { frozen: {
    schema: 'sinter.wave8-live-protocol', schemaVersion: 1, frozenAt,
    exactHead: context.exactHead, planDigest: context.planDigest,
    schemaDigest: context.schemaDigest, implementationDigest: context.implementationDigest,
    sourceDigest: context.sourceDigest, roles,
    briefs: spec.briefs.map(brief => ({ id: brief.id,
      briefDigest: fileDigest(repoFile(input.repoRoot, brief.path, `brief ${brief.id}`)),
      unseen: true as const })), budgets,
    artifacts: { mode: 'planned', evidenceScheduleDigest: fileDigest(evidenceSchedule),
      expectedPlayableArtifactCount: spec.expectedPlayableArtifactCount },
    evidenceRequirements: { noSpendClass: 'deterministic-proof', liveClass: 'live-provider',
      criticalSolApproval: true, productReviewBeforeMergeOrRelease: true } },
    ownerApproval,
    noSpendEvidence: { ...bound, evidenceClass: 'deterministic-proof',
      artifactDigests: [noSpend.digest], providerLedgerCallIds: [] },
    solApproval, productReview, ownerCheckpoints: [], conjuncts: {},
    attestations: [ownerEnvelope.attestation as LiveAuthorityAttestation,
      sol.attestation as LiveAuthorityAttestation,
      product.attestation as LiveAuthorityAttestation] };
  const receipt = buildLiveProtocol(protocolInput);

  const outputDir = path.resolve(input.outputDir);
  const bindingRefs = Object.fromEntries(slots.map(slot => {
    const matching = pinned.store.credentialBindings.filter(binding => binding.provider === slot.provider
      && binding.model === slot.model && binding.seatId === slot.seatId);
    if (matching.length !== 1) {
      throw new Error(`Wave 8 trust store must bind slot ${slot.id} to exactly one credential`);
    }
    return [slot.id, matching[0]!.bindingId];
  }));
  const keyId = (role: 'owner' | 'sol-approval' | 'product-review') =>
    pinned.store.keys.find(key => key.role === role)!.keyId;
  const config: Wave8LiveExecutionConfig = {
    schema: 'sinter.wave8-live-execution-config', schemaVersion: 1,
    repoRoot: path.resolve(input.repoRoot),
    receiptPath: path.join(outputDir, 'live-protocol.json'),
    releaseRootPath: path.join(outputDir, 'bootstrap-release-root.json'),
    planPath: repoFile(input.repoRoot, spec.planPath, 'plan'),
    authorizationLedgerPath: path.join(outputDir, 'authorization-ledger.json'),
    campaignArtifacts,
    trustRefs: { ownerKeyId: keyId('owner'), providerKeyIds: {
      'sol-approval': keyId('sol-approval'), 'product-review': keyId('product-review') } },
    credentialBindingRefs: bindingRefs,
    preSpendPolicy: policy(spec, context, noSpend.digest, fileDigest(solPath)),
  };
  assertLiveProtocolReceiptCurrent(receipt, { exactHead: context.exactHead,
    planDigest: context.planDigest, schemaDigest: context.schemaDigest,
    implementationDigest: context.implementationDigest, sourceDigest: context.sourceDigest,
    trust: pinned.trust, now: frozenAt });
  return { context, releaseRoot, receipt, config, trustStorePath: pinned.path };
}
