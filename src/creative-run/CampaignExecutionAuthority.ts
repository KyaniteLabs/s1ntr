import { randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import type { ExecutorAttestationV2, ExecutorAttestationV3 } from '../identity/executorAttestation.js';
import { verifyExecutorAttestation } from '../identity/executorAttestation.js';
import type { HostAdapterRegistry } from '../identity/hostAdapterRegistry.js';
import { mintNonce, sha256Hex } from '../identity/hostAdapterRegistry.js';
import { bootstrapHostAuthority, classifyProviderSurface, loadPinnedProductionHostAuthority,
  type BootstrapOptions } from '../identity/executorAuthorityBootstrap.js';
import type { ExecutorIdentity, FundingTruth, ModelRole, ProviderSurface, SeatBinding } from '../identity/types.js';
import { assertGLMCodingPlanCapacity, assertGLMCodingPlanTransport,
  currentGLMCodingPlanTransportTestTrust } from '../identity/GLMCodingPlanSeat.js';
import type {
  CampaignExecutionPlan, CampaignManifest, CampaignRoleRoute, CampaignTransportPurpose,
} from './CampaignManifest.js';
import { manifestIsCurrent } from './CampaignManifest.js';
import { FileCampaignLedgerPersistence } from './CampaignPersistence.js';

type ExactExecutorAttestation = ExecutorAttestationV2 | ExecutorAttestationV3;

export interface CampaignFundingLimits {
  readonly providerCalls: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly activeSeconds: number;
}

export interface CampaignFundingAllocation extends CampaignFundingLimits {
  readonly allocationId: string;
  readonly stageId: string;
  readonly logicalAttemptId: string;
  readonly transportOrdinal: number;
  readonly purpose: CampaignTransportPurpose;
  readonly phase: 'pre-primary-transport' | 'pre-retry-transport' | 'pre-fallback-transport';
  readonly mode: 'generate' | 'stream';
  readonly requestTemplateDigest: string;
  readonly role: ModelRole;
  readonly routeDigest: string;
  readonly identity: ExecutorIdentity;
  readonly seat: SeatBinding;
  readonly funding: FundingTruth;
  readonly surface: ProviderSurface;
  readonly endpointDigest: string;
}

export interface CampaignFundingReservationSubject {
  readonly schemaVersion: 'campaign-funding-reservation.v1';
  readonly reservationId: string;
  readonly campaignRunId: string;
  readonly manifestDigest: string;
  readonly planDigest: string;
  readonly routeFreezeDigest: string;
  readonly allocations: readonly CampaignFundingAllocation[];
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly nonce: string;
  readonly keyId: string;
}

export interface CampaignFundingReservationV1 {
  readonly subject: CampaignFundingReservationSubject;
  readonly signature: string;
  readonly reservationDigest: string;
}

export interface CampaignFundingCapacity {
  readonly seat: SeatBinding;
  readonly funding: FundingTruth;
  readonly identity: ExecutorIdentity;
  readonly surface: ProviderSurface;
  readonly endpointDigest: string;
  readonly remaining: CampaignFundingLimits;
}

/** Host-owned source. It is installed when the authority boots, never supplied by a campaign caller. */
export interface CampaignFundingCapacitySource {
  resolve(route: CampaignRoleRoute): CampaignFundingCapacity;
}

export interface CampaignFundingDebitRequest {
  readonly stageId: string;
  readonly logicalAttemptId: string;
  readonly routeDigest: string;
  readonly executorRouteDigest: string;
  readonly requestDigest: string;
  readonly transportOrdinal: number;
  readonly requestTemplateDigest: string;
  readonly role: ModelRole;
  readonly identity: ExecutorIdentity;
  readonly phase: CampaignFundingAllocation['phase'];
  readonly mode: CampaignFundingAllocation['mode'];
  readonly attemptOrdinal: number;
  readonly fallbackOrdinal: number;
  readonly retryOrdinal: number;
  readonly maxInputTokens: number;
  readonly maxOutputTokens: number;
}

export interface CampaignFundingDebitReceipt {
  readonly reservationDigest: string;
  readonly allocationId: string;
  readonly transportOrdinal: number;
  readonly requestTemplateDigest: string;
  readonly requestDigest: string;
  readonly executorRouteDigest: string;
  readonly attemptOrdinal: number;
  readonly fallbackOrdinal: number;
  readonly retryOrdinal: number;
  readonly debitedAt: string;
  readonly debitDigest: string;
}

/** A host-verified, immutable settlement reference for one exact frozen stage. */
export interface CampaignStageSettlement {
  readonly stageId: string;
  readonly allocationId: string;
  readonly reservationDigest: string;
  readonly debitDigest: string;
  readonly attestationDigest: string;
  readonly settlementDigest: string;
}

export interface CampaignSuccessfulStageGroup {
  readonly nodeId: string;
  readonly stageIds: readonly string[];
}

interface StoredReservation {
  readonly reservation: CampaignFundingReservationV1;
  readonly consumed: Readonly<Record<string, CampaignFundingDebitReceipt>>;
  readonly settled: Readonly<Record<string, ExactExecutorAttestation>>;
  readonly release?: {
    readonly schemaVersion: 'campaign-funding-release.v1';
    readonly reservationDigest: string;
    readonly campaignRunId: string;
    readonly releasedAt: string;
    readonly consumedAllocationIds?: readonly string[];
    readonly keyId: string;
    readonly nonce: string;
    readonly signature: string;
  };
}

interface FundingLedger {
  readonly schemaVersion: 'campaign-funding-ledger.v1';
  readonly reservations: Readonly<Record<string, StoredReservation>>;
}

const LEDGER_KEY = 'campaign-funding-global';
const admittedCampaigns = new WeakSet<object>();
const admittedCampaignAuthorities = new WeakMap<object, CampaignFundingReservationAuthority>();
const runtimeCampaignContexts = new WeakSet<object>();
const campaignFundingContexts = new AsyncLocalStorage<RuntimeCampaignFundingContext>();

export interface HostCampaignFundingAdmission {
  readonly reservation: CampaignFundingReservationV1;
}

/**
 * Opaque, module-branded, host-issued admission that authorizes an owner
 * review over a specific (reservation, manifest, briefs) tuple. Constructed
 * only inside `CampaignFundingReservationAuthority.runOwnerReviewScope` after
 * cryptographically verifying the signed reservation, confirming the manifest
 * is current, and asserting the reservation binds to that manifest. External
 * callers cannot forge this object: the internal WeakSet brand is the trust
 * anchor, and only the authority instance can add to it.
 */
export interface OwnerReviewAdmission {
  readonly reservation: CampaignFundingReservationV1;
  readonly manifest: CampaignManifest;
  readonly briefIds: readonly string[];
  readonly candidateSetDigests: readonly { readonly briefId: string; readonly digest: string }[];
  readonly activeIssuerId: string;
  readonly activeIssuerKeyFingerprint: string;
}

const ownerReviewAdmissions = new WeakSet<object>();
interface OwnerReviewAdmissionBinding {
  readonly issuer: CampaignFundingReservationAuthority;
  readonly keyId: string;
  readonly reservationDigest: string;
  readonly campaignRunId: string;
  readonly manifestDigest: string;
  readonly candidateSetsDigest: string;
}
const ownerReviewAdmissionBindings = new WeakMap<object, OwnerReviewAdmissionBinding>();
type OwnerReviewAdmissionInput = {
  readonly reservation: CampaignFundingReservationV1;
  readonly manifest: CampaignManifest;
  readonly briefIds: readonly string[];
  readonly candidateSetDigests: readonly { readonly briefId: string; readonly digest: string }[];
};
type OwnerReviewAdmissionMint = (input: OwnerReviewAdmissionInput) => OwnerReviewAdmission;
const bootstrappedCampaignAuthorities = new WeakSet<object>();
let activeCampaignAuthority: CampaignFundingReservationAuthority | undefined;

interface RuntimeCampaignFundingContext {
  readonly authority: CampaignFundingReservationAuthority;
  readonly reservation: CampaignFundingReservationV1;
  readonly stageId: string;
  readonly logicalAttemptId: string;
  readonly claimedTransportOrdinals: Set<number>;
  readonly preflightBindings: Map<number, { requestDigest: string; mode: 'generate' | 'stream' }>;
  readonly pendingDebits: Map<number, CampaignFundingDebitReceipt>;
}

export function assertHostCampaignFundingAdmission(
  admission: HostCampaignFundingAdmission,
): CampaignFundingReservationV1 {
  if (!admittedCampaigns.has(admission)) throw new Error('CAMPAIGN_FUNDING_ADMISSION_NOT_HOST_ISSUED');
  return admission.reservation;
}

/** Verify exact successful stages through the authority that minted this host admission. */
export function assertHostCampaignSuccessfulStageGroups(
  admission: HostCampaignFundingAdmission,
  groups: readonly CampaignSuccessfulStageGroup[],
): Promise<void> {
  const authority = admittedCampaignAuthorities.get(admission);
  if (!admittedCampaigns.has(admission) || !authority) {
    throw new Error('CAMPAIGN_FUNDING_ADMISSION_NOT_HOST_ISSUED');
  }
  return authority.assertSuccessfulStageGroups(admission.reservation, groups);
}

/**
 * Assert an `OwnerReviewAdmission` was minted by a host
 * `CampaignFundingReservationAuthority` and is therefore safe to consume as a
 * trust anchor for owner-review packet creation. Forged plain objects fail
 * this assertion because they are not branded in the module-private WeakSet.
 */
export function assertOwnerReviewAdmission(admission: OwnerReviewAdmission): OwnerReviewAdmission {
  const binding = ownerReviewAdmissionBindings.get(admission);
  if (!ownerReviewAdmissions.has(admission) || !binding
    || !bootstrappedCampaignAuthorities.has(binding.issuer)
    || binding.issuer !== activeCampaignAuthority
    || admission.activeIssuerId !== binding.keyId
    || admission.activeIssuerKeyFingerprint !== sha256Hex(binding.keyId)
    || binding.keyId !== admission.reservation.subject.keyId
    || binding.reservationDigest !== admission.reservation.reservationDigest
    || binding.campaignRunId !== admission.manifest.campaignRunId
    || binding.manifestDigest !== admission.manifest.manifestDigest
    || binding.candidateSetsDigest !== sha256Hex(stable(admission.candidateSetDigests))
    || !binding.issuer.verify(admission.reservation)) {
    throw new Error('OWNER_REVIEW_ADMISSION_NOT_HOST_ISSUED');
  }
  return admission;
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort()
      .filter(key => record[key] !== undefined)
      .map(key => `${JSON.stringify(key)}:${stable(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested);
    Object.freeze(value);
  }
  return value;
}

function sameIdentity(left: ExecutorIdentity, right: ExecutorIdentity): boolean {
  return left.provider === right.provider && left.model === right.model && left.effort === right.effort;
}

function sameFundingAuthority(left: FundingTruth, right: FundingTruth): boolean {
  return left.mode === right.mode && left.quotaSurface === right.quotaSurface
    && left.seatDigest === right.seatDigest
    && left.meteredReceiptDigest === right.meteredReceiptDigest
    && left.approvedUsdCeiling === right.approvedUsdCeiling;
}

function validLimit(value: number): boolean {
  return Number.isFinite(value) && value >= 0;
}

/** Canonical digest for the exact provider API root authorized by the host. */
export function digestCampaignProviderEndpoint(baseUrl: string): string {
  let endpoint: URL;
  try { endpoint = new URL(baseUrl); }
  catch { throw new Error('CAMPAIGN_FUNDING_ENDPOINT_INVALID'); }
  if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password
    || endpoint.search || endpoint.hash) throw new Error('CAMPAIGN_FUNDING_ENDPOINT_INVALID');
  const pathname = endpoint.pathname.replace(/\/+$/, '') || '/';
  return sha256Hex(`${endpoint.protocol}//${endpoint.host.toLowerCase()}${pathname}`);
}

export function resolveCampaignAllocationSurface(allocation: CampaignFundingAllocation,
  provider: string, baseUrl: string): ProviderSurface {
  if (allocation.surface !== 'glm-coding-plan-seat') return classifyProviderSurface(provider, baseUrl);
  const testTrust = currentGLMCodingPlanTransportTestTrust();
  return assertGLMCodingPlanTransport({ provider, model: allocation.identity.model, baseUrl,
    seatId: allocation.seat.seatId, seatDigest: allocation.seat.seatDigest,
    ...(testTrust ?? { registry: loadPinnedProductionHostAuthority().registry }) });
}

function roleFor(route: CampaignRoleRoute): ModelRole {
  return route.role;
}

export function computeCampaignRouteDigest(route: Pick<CampaignRoleRoute, 'role' | 'provider' | 'model' | 'seatId'>): string {
  return sha256Hex(stable({ role: route.role, provider: route.provider, model: route.model, seatId: route.seatId }));
}

function emptyLedger(): FundingLedger {
  return { schemaVersion: 'campaign-funding-ledger.v1', reservations: {} };
}

/**
 * Host-signed, durable finite-campaign funding authority. The reservation is
 * issued once and each exact transport allocation is burned atomically before
 * network access. No caller-minted capability or caller-declared capacity is trusted.
 */
export class CampaignFundingReservationAuthority {
  readonly #persistence: FileCampaignLedgerPersistence;

  constructor(
    private readonly registry: HostAdapterRegistry,
    private readonly capacitySource: CampaignFundingCapacitySource,
    directory: string,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.#persistence = new FileCampaignLedgerPersistence(directory);
  }

  async admit(input: {
    readonly campaignRunId: string;
    readonly plan: CampaignExecutionPlan;
    readonly expiresAt: string;
    readonly allowedStageIds?: readonly string[];
  }): Promise<HostCampaignFundingAdmission> {
    const reservation = await this.reserve(input);
    if (!this.verify(reservation)) throw new Error('CAMPAIGN_FUNDING_SIGNATURE_INVALID');
    const admission = deepFreeze({ reservation });
    admittedCampaigns.add(admission);
    admittedCampaignAuthorities.set(admission, this);
    return admission;
  }

  /**
   * Mint an opaque, host-branded `OwnerReviewAdmission` for owner-review
   * packet creation. Verifies the reservation's cryptographic signature,
   * confirms the manifest is current and sealed, asserts the reservation
   * binds to that manifest (campaignRunId + manifestDigest), and validates
   * every requested brief exists in the manifest. The returned admission is
   * the ONLY acceptable proof of owner-review authorization: external callers
   * cannot forge the WeakSet brand, so a forged plain object fails
   * `assertOwnerReviewAdmission` regardless of its contents.
   */
  #admitOwnerReview(input: OwnerReviewAdmissionInput): OwnerReviewAdmission {
    if (!bootstrappedCampaignAuthorities.has(this)) {
      throw new Error('OWNER_REVIEW_ADMISSION_ISSUER_NOT_HOST_BOOTSTRAPPED');
    }
    if (!this.verify(input.reservation)) {
      throw new Error('OWNER_REVIEW_FUNDING_SIGNATURE_INVALID');
    }
    if (!manifestIsCurrent(input.manifest)) {
      throw new Error('OWNER_REVIEW_MANIFEST_LEGACY_OR_INVALID');
    }
    if (input.reservation.subject.manifestDigest !== input.manifest.manifestDigest
      || input.reservation.subject.campaignRunId !== input.manifest.campaignRunId) {
      throw new Error('OWNER_REVIEW_FUNDING_MANIFEST_BINDING_MISMATCH');
    }
    const manifestBriefIds = new Set(input.manifest.briefs.map((brief) => brief.id));
    if (new Set(input.briefIds).size !== input.briefIds.length) {
      throw new Error('OWNER_REVIEW_BRIEF_IDS_DUPLICATED');
    }
    for (const briefId of input.briefIds) {
      if (!manifestBriefIds.has(briefId)) {
        throw new Error(`OWNER_REVIEW_BRIEF_OUTSIDE_MANIFEST:${briefId}`);
      }
    }
    if (!Array.isArray(input.candidateSetDigests)
      || input.candidateSetDigests.length !== input.briefIds.length
      || input.briefIds.some((briefId, index) => {
        const item = input.candidateSetDigests[index];
        return item?.briefId !== briefId || !/^[a-f0-9]{64}$/.test(item.digest);
      })) throw new Error('OWNER_REVIEW_CANDIDATE_SET_DIGESTS_INVALID');
    const admission = deepFreeze({
      reservation: input.reservation,
      manifest: input.manifest,
      briefIds: Object.freeze([...input.briefIds]),
      candidateSetDigests: input.candidateSetDigests.map((item) => ({ ...item })),
      activeIssuerId: input.reservation.subject.keyId,
      activeIssuerKeyFingerprint: sha256Hex(input.reservation.subject.keyId),
    });
    ownerReviewAdmissions.add(admission);
    ownerReviewAdmissionBindings.set(admission, Object.freeze({
      issuer: this,
      keyId: input.reservation.subject.keyId,
      reservationDigest: input.reservation.reservationDigest,
      campaignRunId: input.manifest.campaignRunId,
      manifestDigest: input.manifest.manifestDigest,
      candidateSetsDigest: sha256Hex(stable(input.candidateSetDigests)),
    }));
    return admission;
  }

  /**
   * Run owner-review work inside a host-owned authority scope. The mint
   * capability never escapes this callback and every admission issued through
   * it is revoked when the callback settles, including exceptional exits.
   */
  async runOwnerReviewScope<T>(
    operation: (mint: OwnerReviewAdmissionMint) => Promise<T>,
  ): Promise<T> {
    const issued = new Set<OwnerReviewAdmission>();
    let active = true;
    const mint: OwnerReviewAdmissionMint = (input) => {
      if (!active) throw new Error('OWNER_REVIEW_ADMISSION_SCOPE_INACTIVE');
      const admission = this.#admitOwnerReview(input);
      issued.add(admission);
      return admission;
    };
    try {
      return await operation(mint);
    } finally {
      active = false;
      for (const admission of issued) this.#revokeOwnerReview(admission);
    }
  }

  /** Revoke a scoped owner-review admission after its governing callback settles. */
  #revokeOwnerReview(admission: OwnerReviewAdmission): void {
    const binding = ownerReviewAdmissionBindings.get(admission);
    if (binding?.issuer !== this) throw new Error('OWNER_REVIEW_ADMISSION_ISSUER_MISMATCH');
    ownerReviewAdmissions.delete(admission);
    ownerReviewAdmissionBindings.delete(admission);
  }

  runStage<T>(
    reservation: CampaignFundingReservationV1,
    stageId: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    if (!this.verify(reservation)) throw new Error('CAMPAIGN_FUNDING_SIGNATURE_INVALID');
    if (!reservation.subject.allocations.some(item => item.stageId === stageId)) {
      throw new Error(`CAMPAIGN_STAGE_OUTSIDE_FROZEN_PLAN:${stageId}`);
    }
    const context: RuntimeCampaignFundingContext = Object.freeze({
      authority: this, reservation, stageId,
      logicalAttemptId: `${reservation.subject.campaignRunId}:${stageId}`,
      claimedTransportOrdinals: new Set<number>(),
      preflightBindings: new Map<number, { requestDigest: string; mode: 'generate' | 'stream' }>(),
      pendingDebits: new Map<number, CampaignFundingDebitReceipt>(),
    });
    runtimeCampaignContexts.add(context);
    return campaignFundingContexts.run(context, operation);
  }

  async reserve(input: {
    readonly campaignRunId: string;
    readonly plan: CampaignExecutionPlan;
    readonly expiresAt: string;
    readonly allowedStageIds?: readonly string[];
  }): Promise<CampaignFundingReservationV1> {
    if (input.campaignRunId !== input.plan.campaignRunId)
      throw new Error('CAMPAIGN_FUNDING_MANIFEST_RUN_BINDING_MISMATCH');
    const { planDigest, ...planBody } = input.plan;
    if (planDigest !== sha256Hex(stable(planBody))) throw new Error('CAMPAIGN_FUNDING_PLAN_DIGEST_INVALID');
    const allowed = input.allowedStageIds ? new Set(input.allowedStageIds) : undefined;
    if (allowed && (allowed.size === 0 || allowed.size !== input.allowedStageIds!.length
      || [...allowed].some(id => !input.plan.stages.some(stage => stage.id === id)))) {
      throw new Error('CAMPAIGN_FUNDING_STAGE_ALLOWLIST_INVALID');
    }
    const reservedStages = allowed
      ? input.plan.stages.filter(stage => allowed.has(stage.id)) : input.plan.stages;
    const reservedStageIds = [...new Set(reservedStages.map(stage => stage.id))].sort();
    return this.#persistence.claim(LEDGER_KEY, async () => {
      const ledger = await this.readLedger();
      const existing = Object.values(ledger.reservations).find(item =>
        item.reservation.subject.campaignRunId === input.campaignRunId
        && !item.release
        && Date.parse(item.reservation.subject.expiresAt) > this.now().getTime());
      if (existing) {
        if (!this.verify(existing.reservation)) throw new Error('CAMPAIGN_FUNDING_LEDGER_SIGNATURE_INVALID');
        const existingStageIds = [...new Set(existing.reservation.subject.allocations
          .map(allocation => allocation.stageId))].sort();
        if (existing.reservation.subject.planDigest !== input.plan.planDigest
          || stable(existingStageIds) !== stable(reservedStageIds)) {
          throw new Error('CAMPAIGN_FUNDING_RESERVATION_CONFLICT');
        }
        return existing.reservation;
      }
      const issuedAt = this.now().toISOString();
      const expiryMs = Date.parse(input.expiresAt);
      // NaN expiry (unparseable date) must fail closed: NaN <= issuedAt is
      // false, which would mint a never-expiring reservation invisible to
      // cross-reservation capacity sums (non-author review finding, 2026-08-26).
      if (!Number.isFinite(expiryMs) || expiryMs <= Date.parse(issuedAt)) {
        throw new Error('CAMPAIGN_FUNDING_EXPIRY_INVALID');
      }
      const allocations = reservedStages.flatMap(stage => {
        const route = input.plan.routeFreeze.routes.find(candidate => candidate.seatId === stage.seatId);
        if (!route) throw new Error(`CAMPAIGN_FUNDING_ROUTE_MISSING:${stage.seatId}`);
        const capacity = this.capacitySource.resolve(route);
        if (capacity.seat.seatId !== route.seatId || capacity.identity.model !== route.model
          || capacity.identity.provider !== route.provider || !/^[a-f0-9]{64}$/.test(capacity.endpointDigest)) {
          throw new Error(`CAMPAIGN_FUNDING_HOST_BINDING_MISMATCH:${route.seatId}`);
        }
        const routeDigest = computeCampaignRouteDigest(route);
        const logicalAttemptId = `${input.campaignRunId}:${stage.id}`;
        return stage.transports.map(transport => deepFreeze({
          allocationId: `${stage.id}:transport-${transport.ordinal}`, stageId: stage.id,
          logicalAttemptId,
          transportOrdinal: transport.ordinal, purpose: transport.purpose,
          phase: transport.phase, mode: transport.mode,
          requestTemplateDigest: sha256Hex(stable({ campaignRunId: input.campaignRunId,
            stageId: stage.id, logicalAttemptId, transportOrdinal: transport.ordinal,
            purpose: transport.purpose, phase: transport.phase, mode: transport.mode,
            role: roleFor(route), routeDigest, identity: capacity.identity,
            seatId: capacity.seat.seatId, endpointDigest: capacity.endpointDigest })),
          role: roleFor(route), routeDigest,
          identity: { ...capacity.identity }, seat: { ...capacity.seat },
          funding: { ...capacity.funding, quotaCounters: { ...capacity.funding.quotaCounters } },
          surface: capacity.surface, endpointDigest: capacity.endpointDigest, providerCalls: 1,
          // Per-ATTEMPT envelope: every transport (primary, retry, fallback) may
          // use the full stage budget. Worst-case honesty lives in the summed
          // seat totals (totalsBySeat below), not by shrinking an attempt's cap —
          // a halved cap rejects real requests (req>alloc) before transport.
          inputTokens: stage.inputTokens,
          outputTokens: stage.outputTokens,
          activeSeconds: stage.activeMinutes * 60,
        }));
      });
      const totalsBySeat = new Map<string, CampaignFundingLimits>();
      for (const allocation of allocations) {
        const total = totalsBySeat.get(allocation.seat.seatId) ?? { providerCalls: 0, inputTokens: 0, outputTokens: 0, activeSeconds: 0 };
        totalsBySeat.set(allocation.seat.seatId, {
          providerCalls: total.providerCalls + allocation.providerCalls,
          inputTokens: total.inputTokens + allocation.inputTokens,
          outputTokens: total.outputTokens + allocation.outputTokens,
          activeSeconds: total.activeSeconds + allocation.activeSeconds,
        });
      }
      for (const [seatId, required] of totalsBySeat) {
        const allocation = allocations.find(item => item.seat.seatId === seatId)!;
        const route = input.plan.routeFreeze.routes.find(item => item.seatId === seatId)!;
        const remaining = this.capacitySource.resolve(route).remaining;
        const reserved = Object.values(ledger.reservations)
          .filter(item => Date.parse(item.reservation.subject.expiresAt) > this.now().getTime())
          .flatMap(item => item.release
            ? item.reservation.subject.allocations.filter(candidate => item.consumed[candidate.allocationId])
            : item.reservation.subject.allocations)
          .filter(item => item.seat.seatId === seatId)
          .reduce((sum, item) => ({ providerCalls: sum.providerCalls + item.providerCalls,
            inputTokens: sum.inputTokens + item.inputTokens, outputTokens: sum.outputTokens + item.outputTokens,
            activeSeconds: sum.activeSeconds + item.activeSeconds }),
          { providerCalls: 0, inputTokens: 0, outputTokens: 0, activeSeconds: 0 });
        for (const key of Object.keys(required) as Array<keyof CampaignFundingLimits>) {
          if (!validLimit(remaining[key]) || required[key] + reserved[key] > remaining[key]) {
            throw new Error(`CAMPAIGN_FUNDING_EXHAUSTED:${allocation.seat.seatId}:${key}`);
          }
        }
      }
      const subject: CampaignFundingReservationSubject = deepFreeze({
        schemaVersion: 'campaign-funding-reservation.v1', reservationId: `campaign-funding-${randomUUID()}`,
        campaignRunId: input.campaignRunId, manifestDigest: input.plan.manifestDigest,
        planDigest: input.plan.planDigest, routeFreezeDigest: input.plan.routeFreezeDigest,
        allocations, issuedAt, expiresAt: input.expiresAt, nonce: mintNonce(), keyId: this.registry.keyId,
      });
      const signature = this.registry.issueCampaignFundingSignature(subject);
      const reservation = deepFreeze({ subject, signature,
        reservationDigest: sha256Hex(stable({ subject, signature })) });
      const next = { ...ledger, reservations: { ...ledger.reservations,
        [reservation.reservationDigest]: { reservation, consumed: {}, settled: {} } } };
      await this.writeLedger(next);
      return reservation;
    });
  }

  verify(reservation: CampaignFundingReservationV1): boolean {
    return reservation.subject.schemaVersion === 'campaign-funding-reservation.v1'
      && reservation.subject.keyId === this.registry.keyId
      && reservation.reservationDigest === sha256Hex(stable({ subject: reservation.subject, signature: reservation.signature }))
      && this.registry.verify(reservation.subject, reservation.signature);
  }

  /** Close the reservation and release only allocations that never reached a provider debit. */
  async releaseUnused(reservation: CampaignFundingReservationV1): Promise<void> {
    if (!this.verify(reservation)) throw new Error('CAMPAIGN_FUNDING_SIGNATURE_INVALID');
    await this.#persistence.claim(LEDGER_KEY, async () => {
      const ledger = await this.readLedger();
      const stored = ledger.reservations[reservation.reservationDigest];
      if (!stored) throw new Error('CAMPAIGN_FUNDING_RESERVATION_MISSING_OR_EXPIRED');
      if (stored.release) return;
      const consumedAllocationIds = Object.keys(stored.consumed).sort();
      const body = { schemaVersion: 'campaign-funding-release.v1' as const,
        reservationDigest: reservation.reservationDigest,
        campaignRunId: reservation.subject.campaignRunId,
        consumedAllocationIds,
        releasedAt: this.now().toISOString(), keyId: this.registry.keyId, nonce: mintNonce() };
      const release = { ...body, signature: this.registry.issueCampaignFundingSignature(body) };
      await this.writeLedger({ ...ledger, reservations: { ...ledger.reservations,
        [reservation.reservationDigest]: { ...stored, release } } });
    });
  }

  async debit(reservation: CampaignFundingReservationV1, request: CampaignFundingDebitRequest): Promise<CampaignFundingDebitReceipt> {
    if (!this.verify(reservation)) throw new Error('CAMPAIGN_FUNDING_SIGNATURE_INVALID');
    return this.#persistence.claim(LEDGER_KEY, async () => {
      const ledger = await this.readLedger();
      const stored = ledger.reservations[reservation.reservationDigest];
      if (!stored || stored.release
        || Date.parse(reservation.subject.expiresAt) <= this.now().getTime()) {
        throw new Error('CAMPAIGN_FUNDING_RESERVATION_MISSING_OR_EXPIRED');
      }
      const allocation = reservation.subject.allocations.find(item =>
        item.stageId === request.stageId
        && item.logicalAttemptId === request.logicalAttemptId
        && item.transportOrdinal === request.transportOrdinal);
      if (!allocation || stored.consumed[allocation.allocationId]) {
        throw new Error('CAMPAIGN_FUNDING_ALLOCATION_UNAVAILABLE');
      }
      const stageAllocations = reservation.subject.allocations
        .filter(item => item.stageId === request.stageId);
      const consumedPurpose = (purpose: CampaignTransportPurpose) => stageAllocations
        .filter(item => item.purpose === purpose)
        .every(item => stored.consumed[item.allocationId]);
      const earlierSamePurpose = stageAllocations.filter(item => item.purpose === allocation.purpose
        && item.transportOrdinal < allocation.transportOrdinal);
      const primaryConsumed = stageAllocations.some(item =>
        (item.purpose === 'primary' || item.purpose === 'stream') && stored.consumed[item.allocationId]);
      const sequenceInvalid = (allocation.purpose === 'retry' && (!primaryConsumed
          || earlierSamePurpose.some(item => !stored.consumed[item.allocationId])))
        || (allocation.purpose === 'fallback' && (!primaryConsumed || !consumedPurpose('retry')
          || earlierSamePurpose.some(item => !stored.consumed[item.allocationId])))
        || (allocation.purpose === 'tool-turn' && (!primaryConsumed
          || earlierSamePurpose.some(item => !stored.consumed[item.allocationId])));
      if (allocation.routeDigest !== request.routeDigest || allocation.role !== request.role
        || !sameIdentity(allocation.identity, request.identity)
        || allocation.requestTemplateDigest !== request.requestTemplateDigest
        || allocation.phase !== request.phase || allocation.mode !== request.mode || sequenceInvalid
        || request.maxInputTokens > allocation.inputTokens || request.maxOutputTokens > allocation.outputTokens
        || ((allocation.purpose === 'primary' || allocation.purpose === 'stream')
          && (request.retryOrdinal !== 0 || request.fallbackOrdinal !== 0))
        || (allocation.purpose === 'retry' && (request.retryOrdinal < 1 || request.fallbackOrdinal !== 0))
        || (allocation.purpose === 'fallback' && request.fallbackOrdinal < 1)) {
        throw new Error('CAMPAIGN_FUNDING_TRANSPORT_MISMATCH');
      }
      const body = { reservationDigest: reservation.reservationDigest, allocationId: allocation.allocationId,
        transportOrdinal: allocation.transportOrdinal,
        requestTemplateDigest: allocation.requestTemplateDigest,
        requestDigest: request.requestDigest, executorRouteDigest: request.executorRouteDigest,
        attemptOrdinal: request.attemptOrdinal, fallbackOrdinal: request.fallbackOrdinal,
        retryOrdinal: request.retryOrdinal,
        debitedAt: this.now().toISOString() };
      const receipt = Object.freeze({ ...body, debitDigest: sha256Hex(stable(body)) });
      const nextStored = { ...stored, consumed: { ...stored.consumed, [allocation.allocationId]: receipt } };
      await this.writeLedger({ ...ledger, reservations: { ...ledger.reservations,
        [reservation.reservationDigest]: nextStored } });
      return receipt;
    });
  }

  async settle(receipt: CampaignFundingDebitReceipt, attestation: ExactExecutorAttestation): Promise<void> {
    await this.#persistence.claim(LEDGER_KEY, async () => {
      const ledger = await this.readLedger();
      const stored = ledger.reservations[receipt.reservationDigest];
      const consumed = stored?.consumed[receipt.allocationId];
      const allocation = stored?.reservation.subject.allocations
        .find(item => item.allocationId === receipt.allocationId);
      if (!stored || !consumed || !allocation) throw new Error('CAMPAIGN_FUNDING_DEBIT_MISSING');
      const { debitDigest: _providedDigest, ...providedBody } = receipt;
      if (receipt.debitDigest !== sha256Hex(stable(providedBody))
        || stable(receipt) !== stable(consumed)) throw new Error('CAMPAIGN_FUNDING_DEBIT_TAMPERED');
      if (stored.settled[receipt.allocationId]) throw new Error('CAMPAIGN_FUNDING_SETTLEMENT_IMMUTABLE');
      const verification = verifyExecutorAttestation(this.registry, attestation, this.now().toISOString());
      if (!verification.ok) {
        throw new Error(`CAMPAIGN_FUNDING_ATTESTATION_INVALID:${verification.reason}`);
      }
      this.assertSettlementBinding(allocation, receipt, attestation);
      await this.writeLedger({ ...ledger, reservations: { ...ledger.reservations,
        [receipt.reservationDigest]: { ...stored, settled: { ...stored.settled,
          [receipt.allocationId]: attestation } } } });
    });
  }

  /**
   * Return the sole successfully settled transport for a stage. A stage may
   * reserve retry/fallback transports, but closeout may use exactly one signed
   * success and fails closed if multiple successful transports are present.
   */
  async settledStage(
    reservation: CampaignFundingReservationV1,
    stageId: string,
  ): Promise<CampaignStageSettlement> {
    if (!this.verify(reservation)) throw new Error('CAMPAIGN_FUNDING_SIGNATURE_INVALID');
    return this.#persistence.claim(LEDGER_KEY, async () => {
      const ledger = await this.readLedger();
      const stored = ledger.reservations[reservation.reservationDigest];
      if (!stored) throw new Error('CAMPAIGN_FUNDING_RESERVATION_MISSING_OR_EXPIRED');
      const allocations = stored.reservation.subject.allocations.filter((item) => item.stageId === stageId);
      const successful = allocations.filter((item) =>
        stored.settled[item.allocationId]?.subject.success === true);
      if (successful.length !== 1) {
        throw new Error(`CAMPAIGN_FUNDING_STAGE_SETTLEMENT_${successful.length ? 'AMBIGUOUS' : 'MISSING'}:${stageId}`);
      }
      const allocation = successful[0]!;
      const debit = stored.consumed[allocation.allocationId];
      const attestation = stored.settled[allocation.allocationId];
      if (!debit || !attestation || !attestation.subject.success) {
        throw new Error(`CAMPAIGN_FUNDING_STAGE_SETTLEMENT_MISSING:${stageId}`);
      }
      this.assertSettlementBinding(allocation, debit, attestation);
      const body = {
        stageId, allocationId: allocation.allocationId,
        reservationDigest: reservation.reservationDigest, debitDigest: debit.debitDigest,
        attestationDigest: sha256Hex(stable(attestation)),
      };
      return deepFreeze({ ...body, settlementDigest: sha256Hex(stable(body)) });
    });
  }

  /** Fail closed unless every generated node has a signed successful transport settlement. */
  async assertSuccessfulStageGroups(
    reservation: CampaignFundingReservationV1,
    groups: readonly CampaignSuccessfulStageGroup[],
  ): Promise<void> {
    if (!this.verify(reservation)) throw new Error('CAMPAIGN_FUNDING_SIGNATURE_INVALID');
    const nodeIds = groups.map((group) => group.nodeId);
    if (groups.length === 0 || new Set(nodeIds).size !== nodeIds.length
      || groups.some((group) => !group.nodeId.trim() || group.stageIds.length === 0
        || new Set(group.stageIds).size !== group.stageIds.length)) {
      throw new Error('CAMPAIGN_GENERATION_SETTLEMENT_GROUPS_INVALID');
    }
    await this.#persistence.claim(LEDGER_KEY, async () => {
      const ledger = await this.readLedger();
      const stored = ledger.reservations[reservation.reservationDigest];
      if (!stored) throw new Error('CAMPAIGN_FUNDING_RESERVATION_MISSING_OR_EXPIRED');
      for (const group of groups) {
        const allocations = stored.reservation.subject.allocations
          .filter((item) => group.stageIds.includes(item.stageId));
        const consumed = allocations.filter((item) => stored.consumed[item.allocationId]);
        if (consumed.some((item) => !stored.settled[item.allocationId])) {
          throw new Error(`CAMPAIGN_GENERATION_SETTLEMENT_MISSING:${group.nodeId}`);
        }
        if (!consumed.some((item) => stored.settled[item.allocationId]?.subject.success === true)) {
          throw new Error(`CAMPAIGN_GENERATION_SUCCESS_MISSING:${group.nodeId}`);
        }
      }
    });
  }

  private assertSettlementBinding(
    allocation: CampaignFundingAllocation,
    receipt: CampaignFundingDebitReceipt,
    attestation: ExactExecutorAttestation,
  ): void {
    const subject = attestation.subject;
    const delta = subject.quotaCounterDelta;
    const mismatches = [
      subject.requestDigest !== receipt.requestDigest && 'request',
      subject.routeDigest !== receipt.executorRouteDigest && 'route',
      subject.attemptOrdinal !== receipt.attemptOrdinal && 'attempt',
      subject.fallbackOrdinal !== receipt.fallbackOrdinal && 'fallback',
      subject.retryOrdinal !== receipt.retryOrdinal && 'retry',
      !sameIdentity(subject.resolvedIdentity, allocation.identity) && 'identity',
      stable(subject.seat) !== stable(allocation.seat) && 'seat',
      !sameFundingAuthority(subject.funding, allocation.funding) && 'funding',
      subject.surface !== allocation.surface && 'surface',
      subject.quotaSurface !== allocation.funding.quotaSurface && 'quota-surface',
      delta.calls !== allocation.providerCalls && 'calls',
      delta.inputTokens > allocation.inputTokens && 'input-tokens',
      delta.outputTokens > allocation.outputTokens && 'output-tokens',
      delta.activeSeconds > allocation.activeSeconds && `active-seconds(${delta.activeSeconds}>${allocation.activeSeconds})`,
    ].filter((item): item is string => Boolean(item));
    if (mismatches.length > 0) {
      throw new Error(`CAMPAIGN_FUNDING_SETTLEMENT_MISMATCH:${mismatches.join(',')}`);
    }
  }

  private async readLedger(): Promise<FundingLedger> {
    const raw = await this.#persistence.read(LEDGER_KEY);
    if (!raw) return emptyLedger();
    const parsed = JSON.parse(raw) as FundingLedger;
    if (parsed.schemaVersion !== 'campaign-funding-ledger.v1') throw new Error('CAMPAIGN_FUNDING_LEDGER_INVALID');
    for (const stored of Object.values(parsed.reservations)) {
      if (stored.release) {
        const { signature, ...body } = stored.release;
        const releasedConsumed = stored.release.consumedAllocationIds ?? [];
        if (body.reservationDigest !== stored.reservation.reservationDigest
          || body.campaignRunId !== stored.reservation.subject.campaignRunId
          || body.keyId !== this.registry.keyId || !Number.isFinite(Date.parse(body.releasedAt))
          || !this.registry.verify(body, signature)
          || stable(releasedConsumed) !== stable(Object.keys(stored.consumed).sort())) {
          throw new Error('CAMPAIGN_FUNDING_RELEASE_INVALID');
        }
      }
      for (const [allocationId, attestation] of Object.entries(stored.settled)) {
        const receipt = stored.consumed[allocationId];
        const allocation = stored.reservation.subject.allocations
          .find(item => item.allocationId === allocationId);
        const verification = verifyExecutorAttestation(
          this.registry, attestation, attestation.subject.issuedAt, { historical: true },
        );
        if (!receipt || !allocation || !verification.ok) {
          throw new Error(`CAMPAIGN_FUNDING_LEDGER_ATTESTATION_INVALID:${
            !receipt ? 'receipt' : !allocation ? 'allocation'
              : verification.ok ? 'unknown' : verification.reason}`);
        }
        this.assertSettlementBinding(allocation, receipt, attestation);
      }
    }
    return parsed;
  }

  private writeLedger(ledger: FundingLedger): Promise<void> {
    return this.#persistence.write(LEDGER_KEY, `${JSON.stringify(ledger, null, 2)}\n`);
  }
}

export type CampaignFundingAttemptRequest = Omit<CampaignFundingDebitRequest,
  'stageId' | 'logicalAttemptId' | 'routeDigest'>;
export type CampaignFundingAttemptProfile = Omit<CampaignFundingAttemptRequest,
  'transportOrdinal' | 'requestTemplateDigest'>;
export type CampaignFundingTransportProfile = CampaignFundingAttemptProfile & {
  readonly baseUrl: string;
  readonly credentialDigest: string;
  readonly transportProvider: string;
  readonly transportModel: string;
};

/** @internal Claim the exact frozen template for the actual LLM attempt tuple. */
export function claimCurrentCampaignTransportProof(
  request: CampaignFundingTransportProfile,
): Pick<CampaignFundingAttemptRequest, 'transportOrdinal' | 'requestTemplateDigest'> | undefined {
  const context = campaignFundingContexts.getStore();
  if (!context) return undefined;
  if (!runtimeCampaignContexts.has(context)) throw new Error('CAMPAIGN_FUNDING_CONTEXT_NOT_HOST_ISSUED');
  const eligible = context.reservation.subject.allocations.filter(item => item.stageId === context.stageId
    && item.role === request.role && sameIdentity(item.identity, request.identity)
    && item.phase === request.phase && item.mode === request.mode);
  const byPurpose = (purpose: CampaignTransportPurpose) => eligible
    .filter(item => item.purpose === purpose)
    .sort((left, right) => left.transportOrdinal - right.transportOrdinal);
  let allocation: CampaignFundingAllocation | undefined;
  if (request.phase === 'pre-retry-transport') allocation = byPurpose('retry')[request.retryOrdinal - 1];
  else if (request.phase === 'pre-fallback-transport') allocation = byPurpose('fallback')[request.fallbackOrdinal - 1];
  else if (request.mode === 'stream') allocation = byPurpose('stream')[0];
  else allocation = byPurpose('primary').find(item => !context.claimedTransportOrdinals.has(item.transportOrdinal))
    ?? byPurpose('tool-turn').find(item => !context.claimedTransportOrdinals.has(item.transportOrdinal));
  if (!allocation || context.claimedTransportOrdinals.has(allocation.transportOrdinal)) {
    throw new Error('CAMPAIGN_FUNDING_TRANSPORT_PROFILE_UNAVAILABLE');
  }
  if (allocation.surface !== resolveCampaignAllocationSurface(allocation, request.identity.provider, request.baseUrl)
    || allocation.identity.provider !== request.transportProvider
    || allocation.identity.model !== request.transportModel
    || allocation.endpointDigest !== digestCampaignProviderEndpoint(request.baseUrl)
    || (allocation.funding.mode === 'subscription-seat'
      && (allocation.seat.seatDigest !== request.credentialDigest
        || allocation.funding.seatDigest !== allocation.seat.seatDigest))) {
    throw new Error('CAMPAIGN_FUNDING_TRANSPORT_BINDING_MISMATCH');
  }
  context.claimedTransportOrdinals.add(allocation.transportOrdinal);
  context.preflightBindings.set(allocation.transportOrdinal, {
    requestDigest: request.requestDigest, mode: request.mode,
  });
  return { transportOrdinal: allocation.transportOrdinal,
    requestTemplateDigest: allocation.requestTemplateDigest };
}

interface CampaignFundingDebitHandle {
  readonly context: RuntimeCampaignFundingContext;
  readonly receipt: CampaignFundingDebitReceipt;
}

const campaignDebitHandles = new WeakSet<object>();

/** @internal Detect a host-issued context without exposing it. */
export function hasCurrentCampaignFundingContext(): boolean {
  const context = campaignFundingContexts.getStore();
  if (!context) return false;
  if (!runtimeCampaignContexts.has(context)) throw new Error('CAMPAIGN_FUNDING_CONTEXT_NOT_HOST_ISSUED');
  return true;
}

declare const CAMPAIGN_SUBSCRIPTION_BINDING: unique symbol;
export interface CampaignSubscriptionBinding {
  readonly [CAMPAIGN_SUBSCRIPTION_BINDING]: true;
}
const campaignSubscriptionBindings = new WeakMap<object,
  { context: RuntimeCampaignFundingContext; transportOrdinal: number }>();

/** Validate without consuming an exact host-minted subscription debit. */
export function validateCurrentSubscriptionCampaignBinding(input: {
  readonly stageId: string; readonly provider: string; readonly model: string; readonly seatId: string;
  readonly requestDigest: string; readonly mode: 'generate' | 'stream';
  readonly baseUrl: string; readonly credentialDigest: string;
}): CampaignSubscriptionBinding {
  const context = campaignFundingContexts.getStore();
  if (!context || !runtimeCampaignContexts.has(context)) {
    throw new Error('CAMPAIGN_SUBSCRIPTION_CONTEXT_NOT_HOST_ISSUED');
  }
  const allocation = context.reservation.subject.allocations.find(item => item.stageId === context.stageId
    && item.mode === input.mode && context.pendingDebits.get(item.transportOrdinal)?.requestDigest === input.requestDigest);
  if (!allocation || context.stageId !== input.stageId || allocation.identity.provider !== input.provider
    || allocation.identity.model !== input.model || allocation.seat.seatId !== input.seatId
    || allocation.seat.seatDigest !== input.credentialDigest
    || allocation.surface !== resolveCampaignAllocationSurface(allocation, input.provider, input.baseUrl)
    || allocation.endpointDigest !== digestCampaignProviderEndpoint(input.baseUrl)
    || allocation.funding.mode !== 'subscription-seat'
    || allocation.funding.seatDigest !== allocation.seat.seatDigest) {
    throw new Error('CAMPAIGN_SUBSCRIPTION_HOST_BINDING_MISMATCH');
  }
  const capability = Object.freeze({}) as CampaignSubscriptionBinding;
  campaignSubscriptionBindings.set(capability, { context, transportOrdinal: allocation.transportOrdinal });
  return capability;
}

/** Consume only the exact debit validated for this synchronous provider authorization. */
export function consumeCurrentSubscriptionCampaignBinding(capability: CampaignSubscriptionBinding): void {
  const binding = capability && typeof capability === 'object'
    ? campaignSubscriptionBindings.get(capability) : undefined;
  if (!binding || campaignFundingContexts.getStore() !== binding.context
    || !binding.context.pendingDebits.has(binding.transportOrdinal)) {
    throw new Error('CAMPAIGN_SUBSCRIPTION_BINDING_INVALID_OR_CONSUMED');
  }
  binding.context.pendingDebits.delete(binding.transportOrdinal);
  campaignSubscriptionBindings.delete(capability);
}

/** @internal LLM transport boundary only; callers cannot install this context. */
export async function debitCurrentCampaignFunding(
  request: CampaignFundingAttemptRequest,
): Promise<CampaignFundingDebitHandle | undefined> {
  const context = campaignFundingContexts.getStore();
  if (!context) return undefined;
  if (!runtimeCampaignContexts.has(context)) throw new Error('CAMPAIGN_FUNDING_CONTEXT_NOT_HOST_ISSUED');
  const allocation = context.reservation.subject.allocations.find(item =>
    item.stageId === context.stageId && item.role === request.role
    && item.transportOrdinal === request.transportOrdinal
    && sameIdentity(item.identity, request.identity));
  if (!allocation) throw new Error('CAMPAIGN_FUNDING_STAGE_ROUTE_MISMATCH');
  const preflight = context.preflightBindings.get(request.transportOrdinal);
  if (!preflight || preflight.requestDigest !== request.requestDigest || preflight.mode !== request.mode) {
    throw new Error('CAMPAIGN_FUNDING_TRANSPORT_PREFLIGHT_MISMATCH');
  }
  const receipt = await context.authority.debit(context.reservation, {
    ...request, stageId: context.stageId, logicalAttemptId: context.logicalAttemptId,
    routeDigest: computeCampaignRouteDigest({ role: request.role,
      provider: request.identity.provider, model: request.identity.model,
      seatId: allocation.seat.seatId }),
  });
  context.preflightBindings.delete(receipt.transportOrdinal);
  context.pendingDebits.set(receipt.transportOrdinal, receipt);
  const handle = Object.freeze({ context, receipt });
  campaignDebitHandles.add(handle);
  return handle;
}

/** @internal Settle only the exact debit handle minted at the transport boundary. */
export async function settleCurrentCampaignFunding(
  handle: CampaignFundingDebitHandle,
  attestation: ExactExecutorAttestation,
): Promise<void> {
  if (!campaignDebitHandles.has(handle)) throw new Error('CAMPAIGN_FUNDING_DEBIT_HANDLE_INVALID');
  await handle.context.authority.settle(handle.receipt, attestation);
}

/** Boot the campaign authority from the same protected trust root as #716. */
export function bootstrapCampaignFundingAuthority(options?: BootstrapOptions): CampaignFundingReservationAuthority {
  if (options && process.env.NODE_ENV !== 'test') {
    throw new Error('CAMPAIGN_FUNDING_TEST_BOOTSTRAP_FORBIDDEN');
  }
  if (!options && activeCampaignAuthority) return activeCampaignAuthority;
  const bootstrapOptions = process.env.NODE_ENV === 'test' ? options : undefined;
  const { rootDir, registry } = bootstrapOptions
    ? bootstrapHostAuthority(bootstrapOptions)
    : loadPinnedProductionHostAuthority();
  const runtimeEnv = bootstrapOptions?.env ?? process.env;
  let configured: Readonly<Record<string, CampaignFundingCapacity>>;
  try {
    configured = JSON.parse(runtimeEnv.SINTER_CAMPAIGN_CAPACITY_JSON ?? '{}') as Readonly<Record<string, CampaignFundingCapacity>>;
  } catch {
    throw new Error('CAMPAIGN_FUNDING_CAPACITY_CONFIG_INVALID');
  }
  const source: CampaignFundingCapacitySource = {
    resolve(route) {
      const capacity = configured[route.seatId];
      if (!capacity) throw new Error(`CAMPAIGN_FUNDING_CAPACITY_UNKNOWN:${route.seatId}`);
      assertGLMCodingPlanCapacity(capacity, registry);
      return capacity;
    },
  };
  const authority = new CampaignFundingReservationAuthority(
    registry, source, `${rootDir}/campaign-funding`, bootstrapOptions?.now,
  );
  bootstrappedCampaignAuthorities.add(authority);
  activeCampaignAuthority = authority;
  return authority;
}

export function resolveRuntimeCampaignFundingAuthority(
  explicit?: CampaignFundingReservationAuthority,
): CampaignFundingReservationAuthority | undefined {
  if (process.env.NODE_ENV === 'test' && !process.env.SINTER_EXECUTOR_AUTHORITY_ROOT) return explicit;
  if (explicit && !bootstrappedCampaignAuthorities.has(explicit)) {
    throw new Error('CAMPAIGN_FUNDING_AUTHORITY_NOT_HOST_BOOTSTRAPPED');
  }
  return explicit ?? bootstrapCampaignFundingAuthority();
}
