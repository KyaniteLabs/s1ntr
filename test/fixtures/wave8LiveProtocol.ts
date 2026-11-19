import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createPreSpendFeasibilityProof,
  type PaidCallSlot,
  type PreSpendInterlockPolicy,
} from '../../src/llm/PreSpendInterlock.js';
import {
  buildLiveProtocol,
  digestLiveProtocol,
  liveAuthorityAttestationPayload,
  type LiveAuthorityAttestation,
  type LiveProtocolInput,
  type LiveRoleIdentity,
} from '../../src/runtime-core/LiveProtocol.js';
import {
  createWave8EvidenceReceipt,
  createWave8ReleaseRoot,
} from '../../src/runtime-core/Wave8ReleaseRoot.js';
import {
  computeProofSourceFingerprint,
  readCurrentGitCommit,
} from '../../src/runtime-core/ProofReceiptValidator.js';

const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);
const HASH_C = 'c'.repeat(64);
const HASH_D = 'd'.repeat(64);

export interface Wave8LiveProtocolFixture {
  readonly configPath: string;
  readonly trustStorePath: string;
  readonly planPath: string;
  readonly releaseRootPath: string;
  readonly authorizationLedgerPath: string;
  readonly campaignArtifacts: { readonly manifest: string; readonly execution: string;
    readonly ownerReviewPackage: string; readonly subscriptionRouteAttestation: string;
    readonly phaseOneEnforcement: string };
  cleanup(): void;
}

export interface Wave8LiveProtocolFixtureOptions {
  /** The checkout whose source fingerprint and HEAD are bound into the receipt. */
  readonly repoRoot?: string;
  /**
   * Exact paid calls to admit. Slots for each frozen role must share its token caps,
   * because the production protocol freezes caps at the role level.
   */
  readonly declaredSlots?: readonly Wave8FixturePaidCallSlot[];
  /** Exercise subscription authority without inventing metered pricing. */
  readonly fundingMode?: 'metered-api' | 'subscription-seat';
  /** Remove the Studio-only slot mapping for a governed CLI campaign fixture. */
  readonly includeCanonicalStudioSlot?: boolean;
  /** Bind the Sol bootstrap slot to one exact provider request. */
  readonly bootstrapRequestDigest?: string;
  /** Exact governed CLI inputs to sign before the live receipt is issued. */
  readonly campaignArtifactContents?: {
    readonly manifest: string; readonly execution: string; readonly ownerReviewPackage: string;
    readonly subscriptionRouteAttestation?: string; readonly phaseOneEnforcement?: string;
  };
}

export interface Wave8FixturePaidCallSlot extends PaidCallSlot {
  readonly pipe: string;
  readonly effort: string;
}

const DEFAULT_DECLARED_SLOTS: readonly Wave8FixturePaidCallSlot[] = [
  { id: 'sol-approval', purpose: 'sol-review-bootstrap',
    // Provider string matches BoundaryProvider test double name; model is Kimi K3.
    provider: 'openai', model: 'kimi-k3', role: 'harness',
    subscriptionTransport: 'campaign-host',
    pipe: 'kimi-k3', effort: 'high',
    minCalls: 1, maxCalls: 1, maxInputTokens: 4_000, maxOutputTokens: 2_000,
    minActiveMinutes: 2 },
  { id: 'create-1', purpose: 'product',
    provider: 'openai', model: 'gpt-5.6-sol', role: 'generator',
    subscriptionTransport: 'host-adapter',
    pipe: 'sol-high', effort: 'high',
    minCalls: 1, maxCalls: 2, maxInputTokens: 8_000, maxOutputTokens: 8_000,
    minActiveMinutes: 3, releaseRunSlotId: 'create-evidence' },
  { id: 'product-review', purpose: 'product',
    provider: 'openai', model: 'gpt-5.6-terra', role: 'critic',
    subscriptionTransport: 'campaign-host',
    pipe: 'terra-high', effort: 'high',
    minCalls: 1, maxCalls: 1, maxInputTokens: 4_000, maxOutputTokens: 2_000,
    minActiveMinutes: 1 },
];

function attestation(input: {
  role: LiveAuthorityAttestation['role']; authorityId: string; subjectDigest: string;
  issuedAt: string; expiresAt: string; privateKey: ReturnType<typeof generateKeyPairSync>['privateKey'];
}): LiveAuthorityAttestation {
  const unsigned = { schema: 'sinter.wave8-live-authority-attestation' as const, schemaVersion: 1 as const,
    authorityId: input.authorityId, role: input.role, subjectDigest: input.subjectDigest,
    issuedAt: input.issuedAt, expiresAt: input.expiresAt, nonce: `${input.role}-${input.issuedAt}` };
  return { ...unsigned, signatureBase64: sign(null,
    Buffer.from(liveAuthorityAttestationPayload(unsigned)), input.privateKey).toString('base64') };
}

function publicPem(key: ReturnType<typeof generateKeyPairSync>['publicKey']): string {
  return key.export({ type: 'spki', format: 'pem' }).toString();
}

function livePolicy(planHash: string, sourceFingerprint: string, slots: readonly PaidCallSlot[],
  fundingMode: 'metered-api' | 'subscription-seat'): PreSpendInterlockPolicy {
  const budgetRows = slots.map(slot => ({ slotId: slot.id, maxCalls: slot.maxCalls,
    maxInputTokens: slot.maxInputTokens, maxOutputTokens: slot.maxOutputTokens,
    minActiveMinutes: slot.minActiveMinutes }));
  const feasibilityProof = fundingMode === 'subscription-seat'
    ? createPreSpendFeasibilityProof({ fundingMode, planHash, sourceFingerprint,
      declaredSlots: [...slots], budgetRows, approvedSeatIds: [...new Set(slots.map(slot => slot.seatId!))] })
    : createPreSpendFeasibilityProof({ planHash, sourceFingerprint, priceReceiptDigest: HASH_D,
      declaredSlots: [...slots], budgetRows: budgetRows.map(row => ({ ...row,
        inputUsdPerMillion: 1, outputUsdPerMillion: 2 })), approvedUsdCeiling: 10 });
  return {
    expectedPlanHash: planHash, expectedSourceFingerprint: sourceFingerprint,
    declaredSlots: slots,
    noSpendProof: { gate: 'noSpendCirculationProof', passed: true, planHash,
      sourceFingerprint, artifactDigest: HASH_C, evidenceClass: 'deterministic-proof' },
    solApproval: { gate: 'solHighPreSpendApproval', passed: true, planHash,
      sourceFingerprint, artifactDigest: HASH_C, evidenceClass: 'live-provider',
      executor: { model: 'kimi-k3', effort: 'high', identityVerified: true } },
    feasibilityProof,
  };
}

function frozenRolesAndBudgetRows(slots: readonly Wave8FixturePaidCallSlot[]): {
  readonly roles: readonly LiveRoleIdentity[];
  readonly rows: readonly { role: string; identityId?: string; maxCalls: number; maxInputTokens: number;
    maxOutputTokens: number; maxRetries: number }[];
} {
  for (const required of ['harness', 'critic', 'generator']) {
    if (!slots.some((slot) => slot.role === required)) {
      throw new Error(`Wave 8 live fixture requires a ${required} slot`);
    }
  }
  const groups = new Map<string, Wave8FixturePaidCallSlot[]>();
  for (const slot of slots) {
    const key = `${slot.role}:${slot.identityId ?? ''}`;
    groups.set(key, [...(groups.get(key) ?? []), slot]);
  }
  const roles: LiveRoleIdentity[] = [];
  const rows = [...groups.values()].map((matching) => {
    const first = matching[0]!;
    if (matching.some(slot => slot.provider !== first.provider || slot.model !== first.model
      || slot.pipe !== first.pipe || slot.effort !== first.effort
      || slot.seatId !== first.seatId
      || slot.maxInputTokens !== first.maxInputTokens || slot.maxOutputTokens !== first.maxOutputTokens)) {
      throw new Error(`Wave 8 live fixture ${first.role}/${first.identityId ?? 'default'} slots must share one identity and token caps`);
    }
    roles.push({ role: first.role, provider: first.provider, model: first.model,
      pipe: first.pipe, effort: first.effort, identityVerified: true,
      ...(first.identityId ? { identityId: first.identityId } : {}),
      ...(first.seatId ? { seatId: first.seatId } : {}) });
    return { role: first.role, ...(first.identityId ? { identityId: first.identityId } : {}),
      maxCalls: matching.reduce((sum, slot) => sum + slot.maxCalls, 0),
      maxInputTokens: first.maxInputTokens, maxOutputTokens: first.maxOutputTokens,
      maxRetries: 0 };
  });
  return { roles, rows };
}

/** Creates a current-source-bound, owner-signed live protocol in disposable storage. */
export function createWave8LiveProtocolFixture(
  options: Wave8LiveProtocolFixtureOptions = {},
): Wave8LiveProtocolFixture {
  const repoRoot = options.repoRoot ?? process.cwd();
  const fundingMode = options.fundingMode ?? 'metered-api';
  const declared = (options.declaredSlots ?? DEFAULT_DECLARED_SLOTS).map(slot => {
    const configured = slot.purpose === 'sol-review-bootstrap' && options.bootstrapRequestDigest
      ? { ...slot, requestDigest: options.bootstrapRequestDigest } : slot;
    return options.includeCanonicalStudioSlot === false
      ? { ...configured, releaseRunSlotId: undefined, subscriptionTransport: 'campaign-host' as const }
      : configured;
  });
  const slots = fundingMode === 'subscription-seat'
    ? declared.map(slot => ({ ...slot, subscriptionTransport: slot.subscriptionTransport ?? 'campaign-host',
      seatId: slot.seatId ?? `seat-${slot.id}` }))
    : declared.map(({ subscriptionTransport: _transport, ...slot }) => slot);
  const { roles, rows: budgetRows } = frozenRolesAndBudgetRows(slots);
  const root = path.join(repoRoot, 'test', `.tmp-wave8-live-${process.pid}-${Date.now()}`);
  // Keep the external trust fixture on the repository filesystem so hard-link
  // security tests remain portable across split-mount CI runners.
  const trustRoot = mkdtempSync(path.join(path.dirname(repoRoot), '.sinter-wave8-trust-'));
  mkdirSync(root, { recursive: true });
  const planPath = path.join(root, 'plan.md');
  writeFileSync(planPath, 'frozen live plan\n');
  const planDigest = createHash('sha256').update('frozen live plan\n').digest('hex');
  const campaignArtifacts = { manifest: path.join(root, 'campaign-manifest.json'),
    execution: path.join(root, 'campaign-execution.json'),
    ownerReviewPackage: path.join(root, 'owner-review-package.json'),
    subscriptionRouteAttestation: path.join(root, 'subscription-routes.json'),
    phaseOneEnforcement: path.join(root, 'phase-one-enforcement.md') };
  for (const [name, file] of Object.entries(campaignArtifacts)) {
    writeFileSync(file, options.campaignArtifactContents?.[name as keyof typeof campaignArtifacts]
      ?? JSON.stringify({ name }));
  }
  const artifactFiles = Object.fromEntries(Object.entries(campaignArtifacts).map(([name, file]) =>
    [name, { path: file, digest: createHash('sha256').update(
      options.campaignArtifactContents?.[name as keyof typeof campaignArtifacts]
        ?? JSON.stringify({ name })).digest('hex') }]));
  const artifactBindings = { ...artifactFiles,
    productStageIdsDigest: digestLiveProtocol(slots.filter(slot => slot.purpose === 'product')
      .map(slot => slot.id).sort()) };
  const artifactBindingsDigest = digestLiveProtocol(artifactBindings);
  const exactHead = readCurrentGitCommit(repoRoot)!;
  const sourceDigest = computeProofSourceFingerprint(repoRoot)!.replace(/^sha256:/, '');
  const now = new Date();
  const frozenAt = now.toISOString();
  const approvedAt = new Date(now.getTime() - 1_000).toISOString();
  // Attestations must outlive the slowest consumer of this fixture: the spawned
  // CLI validates them against its own wall clock deep inside a governed campaign
  // (deadline up to 150s in real-browser mode), long after mint. Keep the TTL
  // finite so `authorityFailures` still rejects stale attestations, but bounded
  // above every consumer's maximum runtime instead of a fixed 60s that the
  // campaign can outlive. 10 minutes = 4x the largest child deadline.
  const expiresAt = new Date(now.getTime() + 600_000).toISOString();
  const owner = generateKeyPairSync('ed25519');
  const price = generateKeyPairSync('ed25519');
  const solAuthority = generateKeyPairSync('ed25519');
  const review = generateKeyPairSync('ed25519');
  const approvedSeatIds = [...new Set(slots.map(slot => slot.seatId).filter((id): id is string => Boolean(id)))];
  const resourceBudget = { rows: budgetRows,
    maxActiveMinutes: slots.reduce((sum, slot) => sum + slot.minActiveMinutes, 0),
    maxTotalCalls: slots.reduce((sum, slot) => sum + slot.maxCalls, 0),
    maxTotalInputTokens: slots.reduce((sum, slot) => sum + slot.maxCalls * slot.maxInputTokens, 0),
    maxTotalOutputTokens: slots.reduce((sum, slot) => sum + slot.maxCalls * slot.maxOutputTokens, 0),
    maxRetriesPerStage: 0 };
  const ownerBody = fundingMode === 'subscription-seat'
    ? { schema: 'sinter.owner-subscription-seat-approval' as const, ownerId: 'owner', fundingMode,
      approvedSeatIds, resourceBudgetDigest: digestLiveProtocol({ ...resourceBudget, fundingMode,
        approvedSeatIds }), planDigest, approvedAt }
    : { schema: 'sinter.owner-usd-ceiling-approval' as const, ownerId: 'owner',
      approvedUsdCeiling: 10, planDigest, approvedAt };
  const ownerApproval = { ...ownerBody, approvalDigest: digestLiveProtocol(ownerBody) };
  const priceBody = { schema: 'sinter.current-price-receipt' as const, schemaVersion: 1 as const,
    generatedAt: frozenAt, prices: roles.filter((role, index) => roles.findIndex(candidate =>
      candidate.provider === role.provider && candidate.model === role.model) === index).map(role => ({ provider: role.provider, model: role.model,
      inputUsdPerMillion: 1, outputUsdPerMillion: 1,
      sourceUrl: 'https://pricing.example/current', verifiedAt: frozenAt })) };
  const priceReceipt = { ...priceBody, receiptDigest: digestLiveProtocol(priceBody) };
  const bound = { passed: true, exactHead, planDigest, schemaDigest: HASH_C,
    implementationDigest: HASH_D, sourceDigest,
    artifactDigests: [HASH_A, artifactBindingsDigest] };
  const solExecutor = roles.find((role) =>
    role.role === 'harness' && (role.model === 'kimi-k3' || role.model === 'moonshotai/kimi-k3')
    && role.effort === 'high');
  const terraReviewer = roles.find((role) => role.model === 'gpt-5.6-terra' && role.effort === 'high');
  if (!solExecutor || !terraReviewer) {
    throw new Error('Wave 8 live fixture requires Kimi-K3 harness and Terra-high identities');
  }
  const solBody = { ...bound, evidenceClass: 'live-provider' as const, critical: true as const,
    executor: solExecutor };
  const solApproval = { ...solBody, approvalDigest: digestLiveProtocol(solBody) };
  const reviewBody = { ...bound, evidenceClass: 'live-provider' as const, reviewer: terraReviewer,
    authorIndependent: false };
  const productReview = { ...reviewBody, reviewDigest: digestLiveProtocol(reviewBody) };
  const input: LiveProtocolInput = { frozen: { schema: 'sinter.wave8-live-protocol', schemaVersion: 1,
    frozenAt, exactHead, planDigest, schemaDigest: HASH_C, implementationDigest: HASH_D, sourceDigest,
    roles, briefs: [{ id: 'unseen', briefDigest: HASH_A, unseen: true }],
    budgets: fundingMode === 'subscription-seat'
      ? { ...resourceBudget, fundingMode, approvedSeatIds }
      : { ...resourceBudget, approvedUsdCeiling: 10 },
    artifacts: { contactSheetDigest: HASH_A, playableArtifactDigests: [HASH_B] },
    evidenceRequirements: { noSpendClass: 'deterministic-proof', liveClass: 'live-provider',
      criticalSolApproval: true, productReviewBeforeMergeOrRelease: true } },
    ownerApproval, ...(fundingMode === 'metered-api' ? { priceReceipt } : {}),
    noSpendEvidence: { ...bound, evidenceClass: 'deterministic-proof', providerLedgerCallIds: [] },
    solApproval, productReview, ownerCheckpoints: [], conjuncts: {} };
  (input as { attestations?: readonly LiveAuthorityAttestation[] }).attestations = [
    attestation({ role: 'owner', authorityId: 'owner',
      subjectDigest: digestLiveProtocol({ ownerApproval, ownerCheckpoints: [] }), issuedAt: frozenAt, expiresAt, privateKey: owner.privateKey }),
    ...(fundingMode === 'metered-api' ? [attestation({ role: 'price', authorityId: 'price',
      subjectDigest: priceReceipt.receiptDigest, issuedAt: frozenAt, expiresAt,
      privateKey: price.privateKey })] : []),
    attestation({ role: 'sol-approval', authorityId: 'sol', subjectDigest: solApproval.approvalDigest,
      issuedAt: frozenAt, expiresAt, privateKey: solAuthority.privateKey }),
    attestation({ role: 'product-review', authorityId: 'review', subjectDigest: productReview.reviewDigest,
      issuedAt: frozenAt, expiresAt, privateKey: review.privateKey }),
  ];
  const receiptPath = path.join(root, 'live-protocol.json');
  writeFileSync(receiptPath, JSON.stringify(buildLiveProtocol(input)));
  const releaseRootPath = path.join(root, 'release-root.json');
  const releaseEvidence = createWave8EvidenceReceipt({ receiptId: 'schema-invalidation', kind: 'schema-invalidation',
    generatedAt: frozenAt, sourceFingerprint: sourceDigest, evidenceClass: 'execution', passed: true,
    deterministic: false, spendUsd: 0, providerCalls: 0, artifactDigests: [HASH_A],
    schemaDigest: HASH_C, implementationDigest: HASH_D, payload: { plantedNegatives: true } });
  writeFileSync(releaseRootPath, JSON.stringify(createWave8ReleaseRoot({ generatedAt: frozenAt,
    releaseHead: exactHead, sourceFingerprint: sourceDigest,
    activeDigests: { schema: HASH_C, implementation: HASH_D }, receipts: [releaseEvidence] })));
  const configPath = path.join(root, 'config.json');
  const trustStorePath = path.join(trustRoot, 'trust.json');
  const credentialBindings = slots.map(slot => ({ bindingId: `binding-${slot.id}`,
    provider: slot.provider, model: slot.model, seatId: slot.seatId! }));
  writeFileSync(trustStorePath, JSON.stringify({ schema: 'sinter.wave8-live-trust-store', schemaVersion: 1, keys: [
    { keyId: 'owner-key', authorityId: 'owner', role: 'owner', publicKeyPem: publicPem(owner.publicKey) },
    ...(fundingMode === 'metered-api' ? [{ keyId: 'price-key', authorityId: 'price',
      role: 'price', publicKeyPem: publicPem(price.publicKey) }] : []),
    { keyId: 'sol-key', authorityId: 'sol', role: 'sol-approval', publicKeyPem: publicPem(solAuthority.publicKey) },
    { keyId: 'review-key', authorityId: 'review', role: 'product-review', publicKeyPem: publicPem(review.publicKey) },
  ], ...(fundingMode === 'subscription-seat' ? { credentialBindings } : {}) }), { mode: 0o600 });
  chmodSync(trustStorePath, 0o600);
  const authorizationLedgerPath = path.join(root, 'authorization-ledger.json');
  writeFileSync(configPath, JSON.stringify({ schema: 'sinter.wave8-live-execution-config', schemaVersion: 1,
    repoRoot, receiptPath, releaseRootPath, planPath, authorizationLedgerPath,
    campaignArtifacts: artifactBindings,
    trustRefs: { ownerKeyId: 'owner-key', providerKeyIds: {
      ...(fundingMode === 'metered-api' ? { price: 'price-key' } : {}),
      'sol-approval': 'sol-key', 'product-review': 'review-key',
    } }, ...(fundingMode === 'subscription-seat' ? { credentialBindingRefs:
      Object.fromEntries(slots.map(slot => [slot.id, `binding-${slot.id}`])) } : {}),
    preSpendPolicy: livePolicy(planDigest, sourceDigest, slots, fundingMode) }));
  return { configPath, trustStorePath, planPath, releaseRootPath, authorizationLedgerPath,
    campaignArtifacts, cleanup: () => {
    rmSync(root, { recursive: true, force: true });
    rmSync(trustRoot, { recursive: true, force: true });
  } };
}
