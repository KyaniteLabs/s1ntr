import { createHash } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import {
  closeSync, mkdirSync, openSync, readFileSync, renameSync,
  existsSync, realpathSync, statSync, unlinkSync, writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { homedir } from 'node:os';
import type { PreSpendCallContext, ProviderRequest } from './ProviderTypes.js';
import {
  assertLiveProtocolReceiptCurrent, digestLiveProtocol, parseLiveProtocolReceipt,
  type LiveProtocolTrust,
} from '../runtime-core/LiveProtocol.js';
import { assertWave8PreSpendReleaseRoot,
  parseWave8ReleaseRoot } from '../runtime-core/Wave8ReleaseRoot.js';
import { computeProofSourceFingerprint, readCurrentGitCommit } from '../runtime-core/ProofReceiptValidator.js';
import { isWave8CriticalHarnessModel } from '../runtime-core/Wave8CriticalHarness.js';
import { consumeCurrentSubscriptionCampaignBinding,
  digestCampaignProviderEndpoint,
  validateCurrentSubscriptionCampaignBinding,
  type CampaignFundingReservationV1,
  type CampaignSubscriptionBinding } from '../creative-run/CampaignExecutionAuthority.js';
import { providerRequestDigest } from './ProviderRequestDigest.js';
import type { CampaignExecutionPlan } from '../creative-run/CampaignManifest.js';

const SHA256 = /^[a-f0-9]{64}$/;

export function canonicalWave8TrustStorePath(): string {
  return path.join(homedir(), '.sinter', 'wave8-authority', 'trust.json');
}

export interface PaidCallSlot {
  id: string;
  releaseRunSlotId?: string;
  /** Required for subscription seats; selects the host-owned transport authority. */
  subscriptionTransport?: 'host-adapter' | 'campaign-host';
  purpose: 'product' | 'sol-review-bootstrap';
  provider: string;
  model: string;
  role: 'harness' | 'generator' | 'evaluator' | 'critic';
  /** Distinguishes multiple frozen executors serving the same logical role. */
  identityId?: string;
  minCalls: number;
  maxCalls: number;
  maxInputTokens: number;
  maxOutputTokens: number;
  minActiveMinutes: number;
  requestDigest?: string;
  /** Required when this slot is backed by a subscription rather than metered API billing. */
  seatId?: string;
}

export interface PreSpendBudgetRow {
  slotId: string;
  maxCalls: number;
  maxInputTokens: number;
  maxOutputTokens: number;
  minActiveMinutes: number;
  inputUsdPerMillion?: number;
  outputUsdPerMillion?: number;
}

interface PreSpendFeasibilityProofBase {
  gate: 'preSpendFeasibilityProof';
  passed: boolean;
  planHash: string;
  sourceFingerprint: string;
  budgetRows: PreSpendBudgetRow[];
  totals: { calls: number; tokens: number; activeMinutes: number; usdUpperBound?: number };
  failures: string[];
}

export interface MeteredPreSpendFeasibilityProof extends PreSpendFeasibilityProofBase {
  fundingMode?: 'metered-api';
  priceReceiptDigest: string;
  approvedUsdCeiling: number;
  approvedSeatIds?: never;
}

export interface SubscriptionPreSpendFeasibilityProof extends PreSpendFeasibilityProofBase {
  fundingMode: 'subscription-seat';
  approvedSeatIds: string[];
  priceReceiptDigest?: never;
  approvedUsdCeiling?: never;
}

export type PreSpendFeasibilityProof = MeteredPreSpendFeasibilityProof | SubscriptionPreSpendFeasibilityProof;

interface BoundProofBase {
  passed: boolean;
  planHash: string;
  sourceFingerprint: string;
  artifactDigest: string;
  evidenceClass: 'deterministic-proof' | 'live-provider';
}

export interface NoSpendCirculationProof extends BoundProofBase {
  gate: 'noSpendCirculationProof';
  evidenceClass: 'deterministic-proof';
}

export interface SolHighPreSpendApproval extends BoundProofBase {
  gate: 'solHighPreSpendApproval';
  evidenceClass: 'live-provider';
  executor: { model: string; effort: 'high'; identityVerified: boolean };
}

export interface PreSpendInterlockPolicy {
  expectedPlanHash: string;
  expectedSourceFingerprint: string;
  declaredSlots: PaidCallSlot[];
  noSpendProof?: NoSpendCirculationProof;
  solApproval?: SolHighPreSpendApproval;
  feasibilityProof: PreSpendFeasibilityProof;
  /** W8 callers set this to require the frozen live protocol at the provider boundary. */
  requireLiveProtocol?: boolean;
}

export interface Wave8LiveExecutionConfig {
  readonly schema: 'sinter.wave8-live-execution-config';
  readonly schemaVersion: 1;
  readonly repoRoot: string;
  readonly receiptPath: string;
  readonly releaseRootPath: string;
  readonly planPath: string;
  readonly authorizationLedgerPath: string;
  readonly campaignArtifacts: {
    readonly manifest: { readonly path: string; readonly digest: string };
    readonly execution: { readonly path: string; readonly digest: string };
    readonly ownerReviewPackage: { readonly path: string; readonly digest: string };
    readonly subscriptionRouteAttestation: { readonly path: string; readonly digest: string };
    readonly phaseOneEnforcement: { readonly path: string; readonly digest: string };
    readonly productStageIdsDigest: string;
  };
  readonly trustRefs: {
    readonly ownerKeyId: string;
    readonly providerKeyIds: Readonly<Record<'sol-approval' | 'product-review', string>
      & Partial<Record<'price', string>>>;
  };
  readonly credentialBindingRefs?: Readonly<Record<string, string>>;
  readonly preSpendPolicy: PreSpendInterlockPolicy;
}

interface Wave8LiveTrustStore {
  readonly schema: 'sinter.wave8-live-trust-store';
  readonly schemaVersion: 1;
  readonly keys: readonly { readonly keyId: string; readonly authorityId: string;
    readonly role: 'owner' | 'price' | 'sol-approval' | 'product-review'; readonly publicKeyPem: string }[];
  readonly credentialBindings?: readonly { readonly bindingId: string; readonly provider: string;
    readonly model: string; readonly seatId: string }[];
}

export interface ProviderInvocation {
  provider: string;
  model: string;
  request: ProviderRequest;
  mode?: 'generate' | 'stream';
  transport?: { baseUrl: string; credentialDigest: string };
}

declare const CANONICAL_PRE_SPEND_CAPABILITY: unique symbol;
export interface CanonicalPreSpendCapability {
  readonly [CANONICAL_PRE_SPEND_CAPABILITY]: true;
}

interface CanonicalCapabilityBinding {
  readonly authorizationId: string;
  readonly provider: string;
  readonly model: string;
  readonly maxTotalTokens: number;
  readonly credentialBindingId?: string;
  state: 'available' | 'in-flight' | 'consumed';
}

const canonicalCapabilities = new WeakMap<object, CanonicalCapabilityBinding>();

interface ActivePolicy {
  policy: PreSpendInterlockPolicy;
  callsBySlot: Map<string, number>;
  ledger: ProviderCallLedgerReceipt[];
  liveProtocol?: Wave8LiveProtocolAuthority;
  hostAdapters?: SubscriptionHostAdapterRegistry;
  campaignArtifacts?: Wave8LiveExecutionConfig['campaignArtifacts'];
}

export interface SubscriptionHostAdapter {
  invoke(request: unknown): Promise<unknown>;
}

export class SubscriptionHostAdapterRegistry {
  readonly #adapters: ReadonlyMap<string, SubscriptionHostAdapter>;
  constructor(adapters: ReadonlyMap<string, SubscriptionHostAdapter>) {
    this.#adapters = new Map(adapters);
  }
  invoke(bindingId: string, request: unknown): Promise<unknown> {
    const adapter = this.#adapters.get(bindingId);
    if (!adapter) throw new Error('Pre-spend blocked: host credential adapter is unavailable');
    return adapter.invoke(request);
  }
  has(bindingId: string): boolean { return this.#adapters.has(bindingId); }
}

export interface ProviderCallLedgerReceipt {
  id: string;
  slotId: string;
  callerClass: PreSpendCallContext['callerClass'];
  provider: string;
  model: string;
  credentialBindingId?: string;
  requestDigest: string;
  startedAt: string;
  completedAt?: string;
  status: 'authorized' | 'success' | 'error';
  usage?: { inputTokens: number; outputTokens: number };
}

let active: ActivePolicy | undefined;
const callContext = new AsyncLocalStorage<PreSpendCallContext>();

function readJson(filePath: string): unknown {
  return JSON.parse(readFileSync(filePath, 'utf8')) as unknown;
}

function requireRepoFile(repoRoot: string, candidate: string, label: string,
  allowMissing = false): string {
  if (!path.isAbsolute(candidate)) {
    throw new Error(`Pre-spend blocked: ${label} must be an absolute repository path`);
  }
  const root = realpathSync(repoRoot);
  const resolved = path.resolve(candidate);
  if (!allowMissing && !existsSync(resolved)) {
    throw new Error(`Pre-spend blocked: ${label} must be an existing repository file`);
  }
  const canonical = existsSync(resolved)
    ? realpathSync(resolved)
    : allowMissing ? path.join(realpathSync(path.dirname(resolved)), path.basename(resolved)) : resolved;
  const relative = path.relative(root, canonical);
  const info = existsSync(canonical) ? statSync(canonical) : undefined;
  if (relative.startsWith('..') || path.isAbsolute(relative)
    || (info && (!info.isFile() || info.nlink !== 1))) {
    throw new Error(`Pre-spend blocked: ${label} must be a non-aliased repository file`);
  }
  return canonical;
}

function parseTrustStore(value: unknown): Wave8LiveTrustStore {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Pre-spend blocked: trust store is invalid');
  const store = value as Wave8LiveTrustStore;
  if (store.schema !== 'sinter.wave8-live-trust-store' || store.schemaVersion !== 1
    || !Array.isArray(store.keys) || ![3, 4].includes(store.keys.length)
    || new Set(store.keys.map(key => key.keyId)).size !== store.keys.length
    || new Set(store.keys.map(key => key.role)).size !== store.keys.length
    || !['owner', 'sol-approval', 'product-review'].every(role => store.keys.some(key => key.role === role))
    || store.keys.some(key => !key.keyId?.trim() || !key.authorityId?.trim() || !key.publicKeyPem?.trim()
      || !['owner', 'price', 'sol-approval', 'product-review'].includes(key.role))) {
    throw new Error('Pre-spend blocked: trust store is invalid');
  }
  if (store.credentialBindings && (new Set(store.credentialBindings.map(item => item.bindingId)).size
    !== store.credentialBindings.length || store.credentialBindings.some(item => !item.bindingId?.trim()
      || !item.provider?.trim() || !item.model?.trim() || !item.seatId?.trim()))) {
    throw new Error('Pre-spend blocked: credential binding registry is invalid');
  }
  return store;
}

interface LoadedLiveTrust {
  trust: LiveProtocolTrust;
  credentialBindings: readonly { bindingId: string; provider: string; model: string; seatId: string }[];
}

export function validateSubscriptionCredentialBindings(slots: readonly PaidCallSlot[],
  refs: Readonly<Record<string, string>>, registry: LoadedLiveTrust['credentialBindings'],
  approvedSeatIds: readonly string[]): ReadonlyMap<string, string> {
  if (Object.keys(refs).sort().join('\0') !== slots.map(slot => slot.id).sort().join('\0')) {
    throw new Error('Pre-spend blocked: every subscription slot requires one credential binding reference');
  }
  const resolved = new Map<string, string>();
  for (const slot of slots) {
    const binding = registry.find(item => item.bindingId === refs[slot.id]);
    if (!binding || binding.provider !== slot.provider || binding.model !== slot.model
      || binding.seatId !== slot.seatId || !approvedSeatIds.includes(binding.seatId)) {
      throw new Error('Pre-spend blocked: host credential binding does not match the approved subscription seat');
    }
    resolved.set(slot.id, binding.bindingId);
  }
  return resolved;
}

function loadPinnedTrust(repoRoot: string, trustStorePath: string, refs: Wave8LiveExecutionConfig['trustRefs'],
  fundingMode: 'metered-api' | 'subscription-seat', expectedTrustStorePath: string): LoadedLiveTrust {
  const resolved = realpathSync(path.resolve(trustStorePath));
  const expected = realpathSync(path.resolve(expectedTrustStorePath));
  const relative = path.relative(repoRoot, resolved);
  const info = statSync(resolved);
  if (resolved !== expected || !path.isAbsolute(trustStorePath)
    || (!relative.startsWith('..') && !path.isAbsolute(relative))
    || !info.isFile() || info.nlink !== 1 || (info.mode & 0o077) !== 0
    || (process.getuid && info.uid !== process.getuid())) {
    throw new Error('Pre-spend blocked: trust store must be owner-only and outside the repository');
  }
  const store = parseTrustStore(readJson(resolved));
  const resolve = (role: Wave8LiveTrustStore['keys'][number]['role'], keyId: string) => {
    const key = store.keys.find(item => item.role === role && item.keyId === keyId);
    if (!key) throw new Error(`Pre-spend blocked: pinned ${role} key is unavailable`);
    return key;
  };
  const owner = resolve('owner', refs.ownerKeyId);
  const providerRoles = fundingMode === 'metered-api'
    ? ['price', 'sol-approval', 'product-review'] as const
    : ['sol-approval', 'product-review'] as const;
  return { trust: { owner: { authorityId: owner.authorityId, publicKeyPem: owner.publicKeyPem },
    providers: providerRoles.map(role => {
      const keyId = refs.providerKeyIds[role];
      if (!keyId) throw new Error(`Pre-spend blocked: pinned ${role} key reference is unavailable`);
      const key = resolve(role, keyId);
      return { authorityId: key.authorityId, role, publicKeyPem: key.publicKeyPem };
    }) }, credentialBindings: store.credentialBindings ?? [] };
}

interface DurableAuthorizationLedger {
  schema: 'sinter.wave8-live-authorization-ledger';
  schemaVersion: 1;
  claims: string[];
  runStartedAt: string;
  runDeadline: string;
}

function claimDurableAuthorization(ledgerPath: string, claim: string, runStartedAt: string, runDeadline: string): void {
  mkdirSync(path.dirname(ledgerPath), { recursive: true, mode: 0o700 });
  const lockPath = `${ledgerPath}.lock`;
  const tempPath = `${ledgerPath}.tmp-${process.pid}-${Date.now()}`;
  let lock: number | undefined;
  let failure: Error | undefined;
  try {
    lock = openSync(lockPath, 'wx', 0o600);
    let ledger: DurableAuthorizationLedger = {
      schema: 'sinter.wave8-live-authorization-ledger', schemaVersion: 1, claims: [],
      runStartedAt, runDeadline,
    };
    try {
      const info = statSync(ledgerPath);
      if (!info.isFile() || (info.mode & 0o077) !== 0 || (process.getuid && info.uid !== process.getuid())) {
        throw new Error('durable authorization ledger permissions are invalid');
      }
      ledger = readJson(ledgerPath) as DurableAuthorizationLedger;
    }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    if (ledger.schema !== 'sinter.wave8-live-authorization-ledger' || ledger.schemaVersion !== 1
      || !Array.isArray(ledger.claims) || ledger.claims.some(item => typeof item !== 'string')
      || ledger.runStartedAt !== runStartedAt || ledger.runDeadline !== runDeadline
      || Date.now() > Date.parse(ledger.runDeadline)) {
      throw new Error('durable authorization ledger is invalid');
    }
    if (ledger.claims.includes(claim)) throw new Error('live protocol authorization replay');
    writeFileSync(tempPath, `${JSON.stringify({ ...ledger, claims: [...ledger.claims, claim] })}\n`,
      { flag: 'wx', mode: 0o600 });
    renameSync(tempPath, ledgerPath);
  } catch (error) {
    try { unlinkSync(tempPath); } catch { /* absent temp */ }
    failure = new Error(`Pre-spend blocked: ${error instanceof Error ? error.message : 'durable authorization ledger failure'}`);
  } finally {
    if (lock !== undefined) {
      try { closeSync(lock); } catch (error) {
        failure ??= new Error('Pre-spend blocked: durable authorization ledger close failed', { cause: error });
      }
      try { unlinkSync(lockPath); } catch (error) {
        failure ??= new Error('Pre-spend blocked: durable authorization ledger unlock failed', { cause: error });
      }
    }
  }
  if (failure) throw failure;
}

class Wave8LiveProtocolAuthority {
  private readonly callsByRole = new Map<string, number>();
  private readonly inputByRole = new Map<string, number>();
  private readonly outputByRole = new Map<string, number>();
  private readonly retriesByRole = new Map<string, number>();
  constructor(
    private readonly config: Omit<Wave8LiveExecutionConfig, 'preSpendPolicy'>,
    private readonly trust: LiveProtocolTrust,
    private readonly credentialBindings: LoadedLiveTrust['credentialBindings'],
  ) {}

  private currentReceipt() {
    const receipt = parseLiveProtocolReceipt(readJson(this.config.receiptPath));
    const release = parseWave8ReleaseRoot(readJson(this.config.releaseRootPath));
    const head = readCurrentGitCommit(this.config.repoRoot);
    const source = computeProofSourceFingerprint(this.config.repoRoot)?.replace(/^sha256:/, '') ?? null;
    const plan = createHash('sha256').update(readFileSync(this.config.planPath)).digest('hex');
    if (!head || !source || release.releaseHead !== head || release.sourceFingerprint !== source) {
      throw new Error('Pre-spend blocked: Wave 8 release root is not current');
    }
    assertWave8PreSpendReleaseRoot(release, source);
    assertLiveProtocolReceiptCurrent(receipt, { exactHead: head, planDigest: plan,
      schemaDigest: release.activeDigests.schema, implementationDigest: release.activeDigests.implementation,
      sourceDigest: source, trust: this.trust, now: new Date().toISOString() });
    const artifactBindingsDigest = digestLiveProtocol(this.config.campaignArtifacts);
    if (!receipt.solApproval?.artifactDigests.includes(artifactBindingsDigest)
      || !receipt.productReview?.artifactDigests.includes(artifactBindingsDigest)) {
      throw new Error('Pre-spend blocked: campaign artifact bindings are not independently signed');
    }
    return receipt;
  }

  validateConfiguration(slots: readonly PaidCallSlot[]): void {
    const receipt = this.currentReceipt();
    const productStageIdsDigest = digestLiveProtocol(slots.filter(slot => slot.purpose === 'product')
      .map(slot => slot.id).sort());
    if (productStageIdsDigest !== this.config.campaignArtifacts.productStageIdsDigest) {
      throw new Error('Pre-spend blocked: executable product stages do not match signed authority');
    }
    for (const row of receipt.freeze.budgets.rows) {
      const matches = slots.filter(slot => slot.role === row.role
        && (row.identityId === undefined || slot.identityId === row.identityId));
      if (matches.length === 0 || matches.reduce((sum, slot) => sum + slot.maxCalls, 0) !== row.maxCalls
        || matches.some(slot => slot.maxInputTokens !== row.maxInputTokens
          || slot.maxOutputTokens !== row.maxOutputTokens)) {
        throw new Error(`Pre-spend blocked: executable slots do not exactly match frozen budget for ${row.role}`);
      }
    }
    if (slots.some(slot => !receipt.freeze.budgets.rows.some(row => row.role === slot.role
      && (row.identityId === undefined || row.identityId === slot.identityId)))) {
      throw new Error('Pre-spend blocked: executable slot has no frozen budget row');
    }
    if (receipt.freeze.budgets.fundingMode === 'subscription-seat') {
      const refs = this.config.credentialBindingRefs;
      if (!refs) throw new Error('Pre-spend blocked: subscription credential binding references are missing');
      validateSubscriptionCredentialBindings(slots, refs, this.credentialBindings,
        receipt.freeze.budgets.approvedSeatIds);
    } else if (this.config.credentialBindingRefs) {
      throw new Error('Pre-spend blocked: subscription credential bindings are not permitted in metered mode');
    }
  }

  campaignCanonicalBinding(): Pick<import('../runtime-core/CampaignOrigin.js').CampaignManifestBinding,
    'releaseHead' | 'sourceFingerprint' | 'schemaDigest' | 'implementationDigest' | 'wave8ReleaseRootDigest'> {
    this.currentReceipt();
    const release = parseWave8ReleaseRoot(readJson(this.config.releaseRootPath));
    return { releaseHead: release.releaseHead, sourceFingerprint: release.sourceFingerprint,
      schemaDigest: release.activeDigests.schema, implementationDigest: release.activeDigests.implementation,
      wave8ReleaseRootDigest: release.releaseRootDigest };
  }

  private resolveCredential(slot: PaidCallSlot, approvedSeatIds: readonly string[]) {
    const refs = this.config.credentialBindingRefs ?? {};
    validateSubscriptionCredentialBindings([slot], { [slot.id]: refs[slot.id]! },
      this.credentialBindings, approvedSeatIds);
    return this.credentialBindings.find(item => item.bindingId === refs[slot.id])!;
  }

  authorize(slot: PaidCallSlot, ordinal: number, estimatedInputTokens: number,
    maxOutputTokens: number): string | undefined {
    const receipt = this.currentReceipt();
    const elapsedMinutes = (Date.now() - Date.parse(receipt.freeze.frozenAt)) / 60_000;
    if (!Number.isFinite(elapsedMinutes) || elapsedMinutes < 0
      || elapsedMinutes > receipt.freeze.budgets.maxActiveMinutes) {
      throw new Error('Pre-spend blocked: live protocol active-time cap exceeded');
    }
    const roleKey = `${slot.role}:${slot.identityId ?? ''}`;
    if (receipt.freeze.budgets.fundingMode === 'subscription-seat') {
      const role = receipt.freeze.roles.find(candidate => candidate.role === slot.role
        && (slot.identityId === undefined || candidate.identityId === slot.identityId));
      if (!slot.seatId || !role || role.provider !== slot.provider || role.model !== slot.model
        || role.seatId !== slot.seatId || !receipt.freeze.budgets.approvedSeatIds.includes(slot.seatId)) {
        throw new Error('Pre-spend blocked: provider invocation is not bound to an approved subscription seat');
      }
    }
    const row = receipt.freeze.budgets.rows.find(candidate => candidate.role === slot.role
      && (candidate.identityId === undefined || candidate.identityId === slot.identityId))!;
    const calls = (this.callsByRole.get(roleKey) ?? 0) + 1;
    const input = (this.inputByRole.get(roleKey) ?? 0) + estimatedInputTokens;
    const output = (this.outputByRole.get(roleKey) ?? 0) + maxOutputTokens;
    const retries = Math.max(this.retriesByRole.get(roleKey) ?? 0, ordinal - 1);
    const aggregate = [...this.callsByRole.values()].reduce((sum, value) => sum + value, 0) + 1;
    const aggregateInput = [...this.inputByRole.values()].reduce((sum, value) => sum + value, 0) + estimatedInputTokens;
    const aggregateOutput = [...this.outputByRole.values()].reduce((sum, value) => sum + value, 0) + maxOutputTokens;
    if (calls > row.maxCalls || input > row.maxCalls * row.maxInputTokens
      || output > row.maxCalls * row.maxOutputTokens || retries > Math.max(row.maxRetries, receipt.freeze.budgets.maxRetriesPerStage ?? 0)
      || aggregate > receipt.freeze.budgets.maxTotalCalls
      || aggregateInput > receipt.freeze.budgets.maxTotalInputTokens
      || aggregateOutput > receipt.freeze.budgets.maxTotalOutputTokens) {
      throw new Error(`Pre-spend blocked: frozen resource budget exceeded for ${slot.role}`);
    }
    const nonceDigest = createHash('sha256').update(receipt.attestations
      .map(item => item.nonce).sort().join(':')).digest('hex');
    const deadline = new Date(Date.parse(receipt.freeze.frozenAt)
      + receipt.freeze.budgets.maxActiveMinutes * 60_000).toISOString();
    claimDurableAuthorization(this.config.authorizationLedgerPath,
      `${receipt.receiptDigest}:${nonceDigest}:${slot.id}:${ordinal}`, receipt.freeze.frozenAt, deadline);
    this.callsByRole.set(roleKey, calls); this.inputByRole.set(roleKey, input);
    this.outputByRole.set(roleKey, output); this.retriesByRole.set(roleKey, retries);
    return receipt.freeze.budgets.fundingMode === 'subscription-seat'
      ? this.resolveCredential(slot, receipt.freeze.budgets.approvedSeatIds).bindingId : undefined;
  }
}

export function createPreSpendFeasibilityProof(input: {
  planHash: string; sourceFingerprint: string; declaredSlots: PaidCallSlot[]; budgetRows: PreSpendBudgetRow[];
} & ({ fundingMode?: 'metered-api'; priceReceiptDigest: string; approvedUsdCeiling: number;
  approvedSeatIds?: never } | { fundingMode: 'subscription-seat'; approvedSeatIds: string[];
  priceReceiptDigest?: never; approvedUsdCeiling?: never })): PreSpendFeasibilityProof {
  const mode = input.fundingMode ?? 'metered-api';
  const subscriptionSeats = input.fundingMode === 'subscription-seat' ? input.approvedSeatIds : [];
  const priceReceiptDigest = input.fundingMode === 'subscription-seat' ? undefined : input.priceReceiptDigest;
  const approvedUsdCeiling = input.fundingMode === 'subscription-seat' ? undefined : input.approvedUsdCeiling;
  const failures: string[] = [];
  const slotIds = input.declaredSlots.map(slot => slot.id);
  const rowIds = input.budgetRows.map(row => row.slotId);
  if (new Set(slotIds).size !== slotIds.length || new Set(rowIds).size !== rowIds.length) {
    failures.push('slot IDs must be unique');
  }
  const omitted = slotIds.filter(id => !rowIds.includes(id));
  const extra = rowIds.filter(id => !slotIds.includes(id));
  if (omitted.length) failures.push(`omitted budget slots: ${omitted.join(', ')}`);
  if (extra.length) failures.push(`extra budget slots: ${extra.join(', ')}`);
  if (mode === 'metered-api' && !SHA256.test(priceReceiptDigest ?? '')) failures.push('price receipt digest is invalid');
  if (mode === 'subscription-seat' && (subscriptionSeats.length === 0
    || new Set(subscriptionSeats).size !== subscriptionSeats.length
    || subscriptionSeats.some(id => !id.trim()))) failures.push('approved subscription seat IDs are invalid');
  if (mode === 'subscription-seat') {
    const slotSeats = input.declaredSlots.map(slot => slot.seatId).filter((id): id is string => Boolean(id));
    if ([...subscriptionSeats].sort().join('\0') !== [...new Set(slotSeats)].sort().join('\0')) {
      failures.push('approved subscription seats do not exactly match declared slots');
    }
    if (input.budgetRows.some(row => row.inputUsdPerMillion !== undefined || row.outputUsdPerMillion !== undefined)
      || (input as Record<string, unknown>).priceReceiptDigest !== undefined
      || (input as Record<string, unknown>).approvedUsdCeiling !== undefined) {
      failures.push('metered pricing fields are not permitted in subscription-seat mode');
    }
  } else if ((input as Record<string, unknown>).approvedSeatIds !== undefined
    || input.declaredSlots.some(slot => slot.seatId !== undefined)) {
    failures.push('subscription seat fields are not permitted in metered-api mode');
  }

  let calls = 0;
  let tokens = 0;
  let activeMinutes = 0;
  let usdUpperBound = 0;
  for (const row of input.budgetRows) {
    const slot = input.declaredSlots.find(candidate => candidate.id === row.slotId);
    if (slot && (
      row.maxCalls !== slot.maxCalls
      || row.maxInputTokens !== slot.maxInputTokens
      || row.maxOutputTokens !== slot.maxOutputTokens
      || row.minActiveMinutes !== slot.minActiveMinutes
    )) failures.push(`budget row does not match declared slot ${row.slotId}`);
    if (mode === 'metered-api' && (row.inputUsdPerMillion === undefined || row.outputUsdPerMillion === undefined)) {
      failures.push(`unknown price for ${row.slotId}`);
      continue;
    }
    if (mode === 'subscription-seat' && (!slot?.seatId || !subscriptionSeats.includes(slot.seatId))) {
      failures.push(`slot ${row.slotId} has no approved subscription seat`);
    }
    calls += row.maxCalls;
    tokens += row.maxCalls * (row.maxInputTokens + row.maxOutputTokens);
    activeMinutes += row.minActiveMinutes;
    if (mode === 'metered-api') usdUpperBound += row.maxCalls * (
      row.maxInputTokens * row.inputUsdPerMillion!
      + row.maxOutputTokens * row.outputUsdPerMillion!
    ) / 1_000_000;
  }
  if (calls > 120) failures.push('wave call cap exceeded');
  if (tokens > 7_000_000) failures.push('wave token cap exceeded');
  if (activeMinutes > 48 * 60) failures.push('wave active-time cap exceeded');
  if (mode === 'metered-api' && (!Number.isFinite(approvedUsdCeiling) || approvedUsdCeiling! < 0)) {
    failures.push('owner-approved USD ceiling is missing');
  } else if (mode === 'metered-api' && usdUpperBound > approvedUsdCeiling!) {
    failures.push('owner-approved USD ceiling exceeded');
  }

  const common = {
    gate: 'preSpendFeasibilityProof',
    passed: failures.length === 0,
    planHash: input.planHash,
    sourceFingerprint: input.sourceFingerprint,
    budgetRows: input.budgetRows.map(row => ({ ...row })),
    totals: mode === 'metered-api' ? { calls, tokens, activeMinutes, usdUpperBound }
      : { calls, tokens, activeMinutes },
    failures,
  };
  if (mode === 'metered-api') {
    return { ...common, fundingMode: input.fundingMode, priceReceiptDigest: priceReceiptDigest!,
      approvedUsdCeiling: approvedUsdCeiling! } as MeteredPreSpendFeasibilityProof;
  }
  return { ...common, fundingMode: 'subscription-seat',
    approvedSeatIds: [...subscriptionSeats] } as SubscriptionPreSpendFeasibilityProof;
}

export function digestProviderRequest(req: ProviderRequest): string {
  return providerRequestDigest(req);
}

function parseWave8LiveExecutionConfig(value: unknown): Wave8LiveExecutionConfig {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Pre-spend blocked: Wave 8 live config is invalid');
  const config = value as Record<string, unknown>;
  const keys = ['schema', 'schemaVersion', 'repoRoot', 'receiptPath', 'releaseRootPath', 'planPath',
    'authorizationLedgerPath', 'campaignArtifacts', 'trustRefs', 'preSpendPolicy', 'credentialBindingRefs'];
  const requiredKeys = keys.filter(key => key !== 'credentialBindingRefs');
  if (Object.keys(config).some(key => !keys.includes(key)) || requiredKeys.some(key => !(key in config))
    || config.schema !== 'sinter.wave8-live-execution-config' || config.schemaVersion !== 1
    || typeof config.repoRoot !== 'string' || !path.isAbsolute(config.repoRoot)
    || typeof config.receiptPath !== 'string' || typeof config.releaseRootPath !== 'string'
    || typeof config.planPath !== 'string' || typeof config.authorizationLedgerPath !== 'string'
    || !config.campaignArtifacts || typeof config.campaignArtifacts !== 'object'
    || !config.trustRefs || typeof config.trustRefs !== 'object'
    || !config.preSpendPolicy || typeof config.preSpendPolicy !== 'object') {
    throw new Error('Pre-spend blocked: Wave 8 live config is invalid');
  }
  const refs = config.trustRefs as Wave8LiveExecutionConfig['trustRefs'];
  const policy = config.preSpendPolicy as PreSpendInterlockPolicy;
  const mode = policy.feasibilityProof?.fundingMode ?? 'metered-api';
  const expectedProviderRefKeys = mode === 'metered-api' ? 'price,product-review,sol-approval'
    : 'product-review,sol-approval';
  if (!refs.ownerKeyId?.trim() || !refs.providerKeyIds
    || Object.keys(refs.providerKeyIds).sort().join(',') !== expectedProviderRefKeys
    || Object.values(refs.providerKeyIds).some(keyId => typeof keyId !== 'string' || !keyId.trim())) {
    throw new Error('Pre-spend blocked: Wave 8 trust references are invalid');
  }
  if (config.credentialBindingRefs !== undefined && (!config.credentialBindingRefs
    || typeof config.credentialBindingRefs !== 'object' || Array.isArray(config.credentialBindingRefs)
    || Object.entries(config.credentialBindingRefs).some(([slotId, bindingId]) => !slotId.trim()
      || typeof bindingId !== 'string' || !bindingId.trim()))) {
    throw new Error('Pre-spend blocked: credential binding references are invalid');
  }
  const repoRoot = realpathSync(path.resolve(config.repoRoot));
  const artifacts = config.campaignArtifacts as Wave8LiveExecutionConfig['campaignArtifacts'];
  const productStageIdsDigest = artifacts.productStageIdsDigest;
  const fileArtifacts = Object.fromEntries(Object.entries(artifacts)
    .filter(([key]) => key !== 'productStageIdsDigest')) as Record<string, { path: string; digest: string }>;
  if (Object.keys(artifacts).sort().join(',') !== 'execution,manifest,ownerReviewPackage,phaseOneEnforcement,productStageIdsDigest,subscriptionRouteAttestation'
    || typeof productStageIdsDigest !== 'string' || !SHA256.test(productStageIdsDigest)
    || Object.values(fileArtifacts).some(item => !item || typeof item.path !== 'string'
      || typeof item.digest !== 'string' || !SHA256.test(item.digest))) {
    throw new Error('Pre-spend blocked: campaign artifact bindings are invalid');
  }
  const campaignArtifacts = Object.fromEntries(Object.entries(fileArtifacts).map(([key, item]) => {
    const artifactPath = requireRepoFile(repoRoot, item.path, `campaignArtifacts.${key}`);
    if (createHash('sha256').update(readFileSync(artifactPath)).digest('hex') !== item.digest) {
      throw new Error(`Pre-spend blocked: campaignArtifacts.${key} digest mismatch`);
    }
    return [key, { path: artifactPath, digest: item.digest }];
  })) as unknown as Omit<Wave8LiveExecutionConfig['campaignArtifacts'], 'productStageIdsDigest'>;
  return { ...(config as unknown as Wave8LiveExecutionConfig), repoRoot,
    receiptPath: requireRepoFile(repoRoot, config.receiptPath, 'receiptPath'),
    releaseRootPath: requireRepoFile(repoRoot, config.releaseRootPath, 'releaseRootPath'),
    planPath: requireRepoFile(repoRoot, config.planPath, 'planPath'),
    authorizationLedgerPath: requireRepoFile(
      repoRoot, config.authorizationLedgerPath, 'authorizationLedgerPath', true),
    campaignArtifacts: { ...campaignArtifacts, productStageIdsDigest } };
}

function installPreSpendInterlock(
  policy: PreSpendInterlockPolicy,
  liveProtocol?: Wave8LiveProtocolAuthority,
  hostAdapters?: SubscriptionHostAdapterRegistry,
  liveCapability?: symbol,
  campaignArtifacts?: Wave8LiveExecutionConfig['campaignArtifacts'],
): () => void {
  if (active) throw new Error('Pre-spend interlock already has an active governed run');
  if (policy.feasibilityProof.fundingMode === 'subscription-seat'
    && liveCapability !== AUTHENTICATED_SUBSCRIPTION_CAPABILITY) {
    throw new Error('Pre-spend blocked: subscription-seat requires authenticated Wave 8 host configuration');
  }
  const installed = { policy, callsBySlot: new Map<string, number>(),
    ledger: [] as ProviderCallLedgerReceipt[], ...(liveProtocol ? { liveProtocol } : {}),
    ...(hostAdapters ? { hostAdapters } : {}), ...(campaignArtifacts ? { campaignArtifacts } : {}) };
  active = installed;
  return () => {
    if (active === installed) active = undefined;
  };
}

const AUTHENTICATED_SUBSCRIPTION_CAPABILITY = Symbol('authenticated-subscription-capability');

export function configurePreSpendInterlock(policy: PreSpendInterlockPolicy): () => void {
  return installPreSpendInterlock(policy);
}

function adapterSubscriptionBindingIds(config: Wave8LiveExecutionConfig): string[] {
  if (config.preSpendPolicy.feasibilityProof.fundingMode !== 'subscription-seat') return [];
  const refs = config.credentialBindingRefs ?? {};
  return config.preSpendPolicy.declaredSlots
    .filter(slot => slot.subscriptionTransport === 'host-adapter')
    .map(slot => refs[slot.id]!)
    .filter(Boolean);
}

function validateSubscriptionTransports(policy: PreSpendInterlockPolicy): void {
  const subscription = policy.feasibilityProof.fundingMode === 'subscription-seat';
  for (const slot of policy.declaredSlots) {
    if (!subscription && slot.subscriptionTransport !== undefined) {
      throw new Error('Pre-spend blocked: subscription transport is not permitted in metered mode');
    }
    if (subscription && !['host-adapter', 'campaign-host'].includes(slot.subscriptionTransport ?? '')) {
      throw new Error('Pre-spend blocked: subscription transport authority is missing or invalid');
    }
    if (slot.subscriptionTransport === 'campaign-host' && slot.releaseRunSlotId !== undefined) {
      throw new Error('Pre-spend blocked: campaign-host slot cannot claim a Studio release mapping');
    }
  }
}

function configureWave8LivePreSpendInterlockWithTrust(configPath: string, trustStorePath: string,
  expectedTrustStorePath: string, hostAdapters?: SubscriptionHostAdapterRegistry): () => void {
  const config = parseWave8LiveExecutionConfig(readJson(path.resolve(configPath)));
  const { preSpendPolicy, ...authorityConfig } = config;
  const loaded = loadPinnedTrust(config.repoRoot, trustStorePath, config.trustRefs,
    preSpendPolicy.feasibilityProof.fundingMode ?? 'metered-api', expectedTrustStorePath);
  const authority = new Wave8LiveProtocolAuthority(authorityConfig, loaded.trust, loaded.credentialBindings);
  validateSubscriptionTransports(preSpendPolicy);
  authority.validateConfiguration(preSpendPolicy.declaredSlots);
  const adapterBindings = adapterSubscriptionBindingIds(config);
  if (adapterBindings.length > 0
    && (!hostAdapters || adapterBindings.some(bindingId => !hostAdapters.has(bindingId)))) {
    throw new Error('Pre-spend blocked: subscription host adapter registry is incomplete');
  }
  return installPreSpendInterlock({ ...preSpendPolicy, requireLiveProtocol: true },
    authority, hostAdapters, AUTHENTICATED_SUBSCRIPTION_CAPABILITY, config.campaignArtifacts);
}

export function configureWave8LivePreSpendInterlock(configPath: string, trustStorePath: string,
  hostAdapters?: SubscriptionHostAdapterRegistry): () => void {
  return configureWave8LivePreSpendInterlockWithTrust(
    configPath, trustStorePath, canonicalWave8TrustStorePath(), hostAdapters);
}

export function configureWave8LivePreSpendInterlockForTests(configPath: string,
  trustStorePath: string, hostAdapters?: SubscriptionHostAdapterRegistry): () => void {
  if (!process.env.VITEST) throw new Error('Test-only trust override is unavailable');
  return configureWave8LivePreSpendInterlockWithTrust(
    configPath, trustStorePath, trustStorePath, hostAdapters);
}

export function ensureWave8LivePreSpendInterlockConfigured(configPath?: string, trustStorePath?: string,
  hostAdapters?: SubscriptionHostAdapterRegistry): void {
  if (active?.liveProtocol) return;
  if (active) throw new Error('Pre-spend blocked: active policy has no authenticated Wave 8 live protocol');
  const resolved = configPath ?? process.env.SINTER_WAVE8_LIVE_EXECUTION_CONFIG;
  if (!resolved?.trim()) throw new Error('Pre-spend blocked: SINTER_WAVE8_LIVE_EXECUTION_CONFIG is required');
  const pinnedTrust = trustStorePath ?? process.env.SINTER_WAVE8_LIVE_TRUST_STORE;
  if (!pinnedTrust?.trim()) throw new Error('Pre-spend blocked: SINTER_WAVE8_LIVE_TRUST_STORE is required');
  configureWave8LivePreSpendInterlock(resolved, pinnedTrust, hostAdapters);
}

export function resetPreSpendInterlockForTests(): void {
  active = undefined;
  callContext.disable();
}

export function assertPreSpendInterlockConfigured(): void {
  if (!active) throw new Error('Pre-spend blocked: governed paid execution has no active policy');
}

export function isPreSpendInterlockConfigured(): boolean {
  return active !== undefined;
}

export function isWave8LivePreSpendInterlockConfigured(): boolean {
  return active?.liveProtocol !== undefined;
}

/** Read-only product admission. It validates current live authority without minting a call ledger row. */
export function assertWave8GovernedCampaignPreflight(): Pick<import('../runtime-core/CampaignOrigin.js').CampaignManifestBinding,
  'releaseHead' | 'sourceFingerprint' | 'schemaDigest' | 'implementationDigest' | 'wave8ReleaseRootDigest'> {
  if (!active?.liveProtocol) {
    throw new Error('Pre-spend blocked: governed campaign requires authenticated Wave 8 live protocol');
  }
  active.liveProtocol.validateConfiguration(active.policy.declaredSlots);
  if (active.policy.feasibilityProof.fundingMode === 'subscription-seat'
    && active.policy.declaredSlots.some(slot => slot.subscriptionTransport === 'host-adapter')
    && !active.hostAdapters) {
    throw new Error('Pre-spend blocked: governed campaign subscription adapters are unavailable');
  }
  return active.liveProtocol.campaignCanonicalBinding();
}

/** Exact phase-one stage allowlist from the authenticated live authority. */
export function wave8GovernedCampaignStageIds(plan?: CampaignExecutionPlan): readonly string[] {
  assertWave8GovernedCampaignPreflight();
  const stageIds = active!.policy.declaredSlots
    .filter(slot => slot.purpose === 'product')
    .map(slot => slot.id);
  if (plan) {
    const phaseKinds = new Set(['generation', 'recovery', 'review']);
    const byId = new Map(plan.stages.map(stage => [stage.id, stage]));
    if (stageIds.some(id => !byId.has(id) || !phaseKinds.has(byId.get(id)!.kind))) {
      throw new Error('Pre-spend blocked: product slot is outside the phase-one stage topology');
    }
    const required = plan.stages
      .filter(stage => stage.kind === 'generation' || stage.kind === 'review')
      .map(stage => stage.id);
    if (required.some(id => !stageIds.includes(id))) {
      throw new Error('Pre-spend blocked: phase-one stage allowlist is incomplete');
    }
  }
  return Object.freeze(stageIds);
}

/** Bind host-resolved campaign routes to the independently reviewed route artifact. */
export function assertWave8GovernedCampaignReservationRoutes(
  reservation: CampaignFundingReservationV1,
): void {
  assertWave8GovernedCampaignPreflight();
  const routePath = active!.campaignArtifacts?.subscriptionRouteAttestation.path;
  if (!routePath) throw new Error('Pre-spend blocked: subscription route attestation is unavailable');
  const attestation = readJson(routePath) as { schema?: string; schemaVersion?: number;
    campaignRunId?: string; fundingMode?: string; meteredApiSpendAuthorizedUsd?: number;
    failClosed?: boolean; fallbacks?: unknown[]; routes?: Array<{ roles?: string[];
      models?: string[]; baseUrl?: string }> };
  if (attestation.schema !== 'sinter.wave8-subscription-route-attestation'
    || attestation.schemaVersion !== 1 || attestation.campaignRunId !== reservation.subject.campaignRunId
    || attestation.fundingMode !== 'subscription-seat' || attestation.meteredApiSpendAuthorizedUsd !== 0
    || attestation.failClosed !== true || attestation.fallbacks?.length !== 0
    || !Array.isArray(attestation.routes)) {
    throw new Error('Pre-spend blocked: subscription route attestation is invalid');
  }
  for (const allocation of reservation.subject.allocations) {
    const matched = attestation.routes.filter(route => route.roles?.includes(allocation.role)
      && route.models?.includes(allocation.identity.model)
      && typeof route.baseUrl === 'string'
      && digestCampaignProviderEndpoint(route.baseUrl) === allocation.endpointDigest);
    if ((allocation.funding.mode !== 'subscription-seat' && allocation.funding.mode !== 'metered-api') || matched.length !== 1) {
      throw new Error(`Pre-spend blocked: campaign route is not attested for ${allocation.stageId}`);
    }
  }
}

/** Bind the CLI's caller-supplied campaign inputs to the independently reviewed authority. */
export function assertWave8GovernedCampaignArtifacts(input: {
  manifestPath: string; executionPath: string; ownerReviewPackagePath: string;
}): void {
  if (!active?.liveProtocol || !active.campaignArtifacts) {
    throw new Error('Pre-spend blocked: governed campaign artifact authority is unavailable');
  }
  const supplied = { manifest: input.manifestPath, execution: input.executionPath,
    ownerReviewPackage: input.ownerReviewPackagePath };
  for (const [key, candidate] of Object.entries(supplied)) {
    const expected = active.campaignArtifacts[key as keyof typeof supplied];
    const canonical = realpathSync(path.resolve(candidate));
    const digest = createHash('sha256').update(readFileSync(canonical)).digest('hex');
    if (canonical !== expected.path || digest !== expected.digest) {
      throw new Error(`Pre-spend blocked: governed campaign ${key} does not match reviewed authority`);
    }
  }
}

export function runWithPreSpendCallContext<T>(
  context: PreSpendCallContext,
  callback: () => T,
): T {
  return callContext.run(context, callback);
}

function requireBoundProof(
  proof: BoundProofBase | undefined,
  gate: string,
  policy: PreSpendInterlockPolicy,
): asserts proof is BoundProofBase {
  if (!proof?.passed) throw new Error(`Pre-spend blocked: ${gate} is missing or failed`);
  if ((proof as BoundProofBase & { gate?: string }).gate !== gate) {
    throw new Error(`Pre-spend blocked: ${gate} gate identity is invalid`);
  }
  if (proof.planHash !== policy.expectedPlanHash) {
    throw new Error(`Pre-spend blocked: ${gate} plan hash is stale`);
  }
  if (proof.sourceFingerprint !== policy.expectedSourceFingerprint) {
    throw new Error(`Pre-spend blocked: ${gate} source fingerprint is stale`);
  }
  if (!SHA256.test(proof.artifactDigest)) {
    throw new Error(`Pre-spend blocked: ${gate} artifact digest is invalid`);
  }
}

function requireFeasibility(policy: PreSpendInterlockPolicy): void {
  const proof = policy.feasibilityProof;
  const allowedProofKeys = proof.fundingMode === 'subscription-seat'
    ? ['gate', 'passed', 'fundingMode', 'planHash', 'sourceFingerprint', 'budgetRows', 'totals', 'approvedSeatIds', 'failures']
    : ['gate', 'passed', 'fundingMode', 'planHash', 'sourceFingerprint', 'priceReceiptDigest', 'budgetRows', 'totals', 'approvedUsdCeiling', 'failures'];
  if (Object.keys(proof).some(key => !allowedProofKeys.includes(key))) {
    throw new Error('Pre-spend blocked: preSpendFeasibilityProof mixes funding modes');
  }
  const common = { planHash: proof.planHash, sourceFingerprint: proof.sourceFingerprint,
    declaredSlots: policy.declaredSlots, budgetRows: proof.budgetRows };
  const recomputed = proof.fundingMode === 'subscription-seat'
    ? createPreSpendFeasibilityProof({ ...common, fundingMode: 'subscription-seat',
      approvedSeatIds: proof.approvedSeatIds })
    : createPreSpendFeasibilityProof({ ...common, fundingMode: proof.fundingMode,
      priceReceiptDigest: proof.priceReceiptDigest, approvedUsdCeiling: proof.approvedUsdCeiling });
  const totalsMatch = Object.entries(recomputed.totals).every(
    ([key, value]) => proof.totals[key as keyof typeof proof.totals] === value,
  );
  if (proof.gate !== 'preSpendFeasibilityProof'
    || !proof.passed
    || proof.failures.length > 0
    || !recomputed.passed
    || !totalsMatch) {
    throw new Error('Pre-spend blocked: preSpendFeasibilityProof failed');
  }
  if (proof.planHash !== policy.expectedPlanHash) {
    throw new Error('Pre-spend blocked: preSpendFeasibilityProof plan hash is stale');
  }
  if (proof.sourceFingerprint !== policy.expectedSourceFingerprint) {
    throw new Error('Pre-spend blocked: preSpendFeasibilityProof source fingerprint is stale');
  }
}

export function authorizeProviderInvocation(invocation: ProviderInvocation): string | undefined {
  return authorizeProviderInvocationAtBoundary(invocation, false);
}

function authorizeProviderInvocationAtBoundary(
  invocation: ProviderInvocation,
  canonicalHostAdapter: boolean,
): string | undefined {
  if (!active) {
    if (invocation.request.preSpend ?? callContext.getStore()) {
      throw new Error('Pre-spend blocked: authorization context has no active policy');
    }
    return undefined;
  }
  const { policy, callsBySlot } = active;
  const context = invocation.request.preSpend ?? callContext.getStore();
  if (!context) throw new Error('Pre-spend blocked: provider call has no authorization context');
  const slot = policy.declaredSlots.find(candidate => candidate.id === context.slotId);
  if (!slot) throw new Error(`Pre-spend blocked: undeclared slot ${context.slotId}`);
  if (slot.purpose !== context.purpose) throw new Error('Pre-spend blocked: slot purpose mismatch');
  if (slot.provider !== invocation.provider) throw new Error('Pre-spend blocked: provider mismatch');
  if (slot.model !== invocation.model) throw new Error('Pre-spend blocked: model mismatch');
  if (policy.feasibilityProof.fundingMode === 'subscription-seat') {
    if (slot.subscriptionTransport === 'host-adapter' && !canonicalHostAdapter) {
      throw new Error('Pre-spend blocked: adapter-bound subscription slot cannot use direct provider transport');
    }
  }
  if (!Number.isInteger(invocation.request.maxTokens) || invocation.request.maxTokens! < 1
    || invocation.request.maxTokens! > slot.maxOutputTokens) {
    throw new Error(`Pre-spend blocked: ${slot.id} output token cap is missing or exceeded`);
  }
  const estimatedInputTokens = Math.ceil((invocation.request.systemPrompt.length
    + invocation.request.userPrompt.length
    + JSON.stringify(invocation.request.imageInputs ?? []).length
    + JSON.stringify(invocation.request.toolResults ?? []).length) / 4);
  if (estimatedInputTokens > slot.maxInputTokens) {
    throw new Error(`Pre-spend blocked: ${slot.id} input token cap exceeded`);
  }

  requireBoundProof(policy.noSpendProof, 'noSpendCirculationProof', policy);
  if (policy.noSpendProof.evidenceClass !== 'deterministic-proof') {
    throw new Error('Pre-spend blocked: noSpendCirculationProof evidence class is invalid');
  }
  requireFeasibility(policy);
  const used = callsBySlot.get(slot.id) ?? 0;
  if (policy.requireLiveProtocol && !active.liveProtocol) {
    throw new Error('Pre-spend blocked: authenticated live protocol is missing');
  }
  if (context.purpose === 'sol-review-bootstrap') {
    if (slot.role !== 'harness' || !isWave8CriticalHarnessModel(invocation.model)) {
      throw new Error('Pre-spend blocked: bootstrap requires the Kimi-K3 harness role');
    }
    if (invocation.request.thinking?.effort !== 'high') {
      throw new Error('Pre-spend blocked: bootstrap requires Kimi-K3 high');
    }
    if (!slot.requestDigest || digestProviderRequest(invocation.request) !== slot.requestDigest) {
      throw new Error('Pre-spend blocked: bootstrap request digest mismatch');
    }
  } else {
    requireBoundProof(policy.solApproval, 'solHighPreSpendApproval', policy);
    if (policy.solApproval.evidenceClass !== 'live-provider'
      || !isWave8CriticalHarnessModel(policy.solApproval.executor.model)
      || policy.solApproval.executor.effort !== 'high'
      || !policy.solApproval.executor.identityVerified) {
      throw new Error('Pre-spend blocked: Kimi-K3 critical harness identity is invalid');
    }
  }

  if (used >= slot.maxCalls) throw new Error(`Pre-spend blocked: ${slot.id} call cap exceeded`);
  let campaignBinding: CampaignSubscriptionBinding | undefined;
  if (slot.subscriptionTransport === 'campaign-host') {
    try {
      if (!invocation.mode || !invocation.transport) throw new Error('campaign transport metadata is missing');
      campaignBinding = validateCurrentSubscriptionCampaignBinding({ stageId: slot.id, provider: slot.provider,
        model: slot.model, seatId: slot.seatId ?? '', requestDigest: digestProviderRequest(invocation.request),
        mode: invocation.mode, baseUrl: invocation.transport.baseUrl,
        credentialDigest: invocation.transport.credentialDigest });
    } catch (error) {
      throw new Error('Pre-spend blocked: subscription CLI transport requires an exact host-issued campaign binding',
        { cause: error });
    }
  }
  const credentialBindingId = active.liveProtocol?.authorize(slot, used + 1, estimatedInputTokens,
    invocation.request.maxTokens!);
  if (campaignBinding) consumeCurrentSubscriptionCampaignBinding(campaignBinding);
  callsBySlot.set(slot.id, used + 1);
  const requestDigest = digestProviderRequest(invocation.request);
  const id = createHash('sha256').update(`${policy.expectedPlanHash}:${slot.id}:${used + 1}:${requestDigest}`).digest('hex');
  active.ledger.push({
    id, slotId: slot.id, callerClass: context.callerClass, provider: invocation.provider,
    model: invocation.model, ...(credentialBindingId ? { credentialBindingId } : {}),
    requestDigest, startedAt: new Date().toISOString(), status: 'authorized',
  });
  return id;
}

export function authorizeCanonicalStudioInvocation(releaseRunSlotId: string): CanonicalPreSpendCapability {
  if (!active?.liveProtocol) throw new Error('Pre-spend blocked: canonical Studio live protocol is not active');
  const matches = active.policy.declaredSlots.filter(slot => slot.releaseRunSlotId === releaseRunSlotId);
  if (matches.length !== 1) throw new Error(`Pre-spend blocked: Studio slot ${releaseRunSlotId} is not uniquely declared`);
  const slot = matches[0]!;
  if (slot.purpose !== 'product') throw new Error('Pre-spend blocked: Studio slot purpose is invalid');
  if (active.policy.feasibilityProof.fundingMode === 'subscription-seat'
    && slot.subscriptionTransport !== 'host-adapter') {
    throw new Error('Pre-spend blocked: Studio subscription slot is not adapter-bound');
  }
  const request: ProviderRequest = { systemPrompt: 'Sinter canonical Studio governed invocation',
    userPrompt: releaseRunSlotId, maxTokens: slot.maxOutputTokens,
    preSpend: { slotId: slot.id, purpose: 'product', callerClass: 'studio' } };
  const authorizationId = authorizeProviderInvocationAtBoundary(
    { provider: slot.provider, model: slot.model, request }, true);
  if (!authorizationId) throw new Error('Pre-spend blocked: canonical Studio authorization was not issued');
  const capability = Object.freeze({}) as CanonicalPreSpendCapability;
  canonicalCapabilities.set(capability, { authorizationId, provider: slot.provider, model: slot.model,
    maxTotalTokens: slot.maxInputTokens + slot.maxOutputTokens,
    ...(getPreSpendCallLedger().find(item => item.id === authorizationId)?.credentialBindingId
      ? { credentialBindingId: getPreSpendCallLedger().find(item => item.id === authorizationId)!.credentialBindingId }
      : {}), state: 'available' });
  return capability;
}

/** Authorize one host-adapter call using the active campaign stage context. */
export function authorizeSubscriptionHostAdapterInvocation(request: ProviderRequest): CanonicalPreSpendCapability {
  if (!active?.liveProtocol) throw new Error('Pre-spend blocked: authenticated live protocol is missing');
  const context = request.preSpend ?? callContext.getStore();
  if (!context) throw new Error('Pre-spend blocked: host-adapter call has no stage context');
  const slot = active.policy.declaredSlots.find(item => item.id === context.slotId);
  if (!slot || slot.subscriptionTransport !== 'host-adapter') {
    throw new Error('Pre-spend blocked: stage is not bound to a subscription host adapter');
  }
  const authorizationId = authorizeProviderInvocationAtBoundary(
    { provider: slot.provider, model: slot.model, request }, true);
  if (!authorizationId) throw new Error('Pre-spend blocked: host-adapter authorization was not issued');
  const credentialBindingId = getPreSpendCallLedger().find(item => item.id === authorizationId)
    ?.credentialBindingId;
  if (!credentialBindingId) throw new Error('Pre-spend blocked: host-adapter credential binding is missing');
  const capability = Object.freeze({}) as CanonicalPreSpendCapability;
  canonicalCapabilities.set(capability, { authorizationId, provider: slot.provider,
    model: slot.model, maxTotalTokens: slot.maxInputTokens + slot.maxOutputTokens,
    credentialBindingId, state: 'available' });
  return capability;
}

export async function invokeCanonicalStudioProvider<T>(capability: CanonicalPreSpendCapability,
  request: unknown, meteredInvoke: () => Promise<T>): Promise<T> {
  const binding = capability && typeof capability === 'object' ? canonicalCapabilities.get(capability) : undefined;
  if (!binding || binding.state !== 'available') {
    throw new Error('Pre-spend blocked: canonical Studio capability is invalid, in-flight, or consumed');
  }
  binding.state = 'in-flight';
  if (!binding.credentialBindingId) return meteredInvoke();
  if (!active?.hostAdapters) throw new Error('Pre-spend blocked: subscription host adapter registry is unavailable');
  return active.hostAdapters.invoke(binding.credentialBindingId, request) as Promise<T>;
}

export function completeCanonicalStudioInvocation(capability: CanonicalPreSpendCapability,
  response: { provider: string; model: string; usage: { tokens: number; inputTokens?: number;
    outputTokens?: number } }, status: 'success' | 'error'): void {
  const binding = capability && typeof capability === 'object' ? canonicalCapabilities.get(capability) : undefined;
  if (!binding || binding.state !== 'in-flight') {
    throw new Error('Pre-spend blocked: canonical Studio capability is not in-flight');
  }
  binding.state = 'consumed';
  if (response.provider !== binding.provider || response.model !== binding.model
    || !Number.isFinite(response.usage.tokens) || response.usage.tokens < 0
    || response.usage.tokens > binding.maxTotalTokens) {
    completeProviderInvocation(binding.authorizationId, 'error');
    throw new Error('Pre-spend blocked: canonical Studio transport response exceeded its capability');
  }
  const splitUsage = response.usage.inputTokens !== undefined && response.usage.outputTokens !== undefined
    ? { inputTokens: response.usage.inputTokens, outputTokens: response.usage.outputTokens } : undefined;
  if (binding.credentialBindingId && (!splitUsage
    || splitUsage.inputTokens + splitUsage.outputTokens !== response.usage.tokens)) {
    completeProviderInvocation(binding.authorizationId, 'error');
    throw new Error('Pre-spend blocked: subscription transport must report governed split usage');
  }
  completeProviderInvocation(binding.authorizationId, status, splitUsage);
}

export function failCanonicalStudioInvocation(capability: CanonicalPreSpendCapability): void {
  const binding = capability && typeof capability === 'object' ? canonicalCapabilities.get(capability) : undefined;
  if (!binding || binding.state !== 'in-flight') {
    throw new Error('Pre-spend blocked: canonical Studio capability is not in-flight');
  }
  binding.state = 'consumed';
  completeProviderInvocation(binding.authorizationId, 'error');
}

export const invokeSubscriptionHostAdapterProvider = invokeCanonicalStudioProvider;
export const completeSubscriptionHostAdapterInvocation = completeCanonicalStudioInvocation;
export const failSubscriptionHostAdapterInvocation = failCanonicalStudioInvocation;

export function completeProviderInvocation(
  id: string | undefined,
  status: 'success' | 'error',
  usage?: { inputTokens: number; outputTokens: number },
): void {
  if (!id || !active) return;
  const receipt = active.ledger.find(item => item.id === id);
  if (!receipt || receipt.status !== 'authorized') throw new Error('Provider ledger completion is unknown or duplicated');
  const slot = active.policy.declaredSlots.find(item => item.id === receipt.slotId);
  if (!slot) throw new Error('Provider ledger completion has no declared slot');
  if (usage && (!Number.isInteger(usage.inputTokens) || usage.inputTokens < 0
    || !Number.isInteger(usage.outputTokens) || usage.outputTokens < 0
    || usage.inputTokens > slot.maxInputTokens || usage.outputTokens > slot.maxOutputTokens)) {
    throw new Error(`Provider ledger completion exceeded token cap for ${slot.id}: input ${usage.inputTokens}/${slot.maxInputTokens}, output ${usage.outputTokens}/${slot.maxOutputTokens}`);
  }
  receipt.status = status;
  receipt.completedAt = new Date().toISOString();
  if (usage) receipt.usage = { ...usage };
}

export function getPreSpendCallLedger(): ProviderCallLedgerReceipt[] {
  return active?.ledger.map(item => ({ ...item, usage: item.usage ? { ...item.usage } : undefined })) ?? [];
}
