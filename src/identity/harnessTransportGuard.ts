/**
 * HarnessTransportGuard for W8C-03 (#716).
 *
 * Orchestrates the W8C-03 transport contract:
 *
 *   1. (pre-network) verify the eligibility policy allow decision
 *   2. (pre-network) verify + atomically consume the host-signed reservation
 *   3. (network) the caller performs the actual provider call
 *   4. (post-transport) verify the host-signed attestation against the
 *      consumed reservation, rerun the policy on the signed actual identity,
 *      and burn the attestation nonce
 *
 * Any failure quarantines the route and discards the response with zero
 * harness mutation.
 *
 * Spec: W8C-03 product change — postcondition enforcement.
 */

import { verifyExecutorAttestation, verifyAttestationAgainstReservation, NonceLedger,
  type ExecutorAttestation, type ExecutorAttestationV2, type ExecutorAttestationV3 } from './executorAttestation.js';
import { verifyExecutorReservation, ReservationTracker, type ExecutorReservationV1 } from './executorReservation.js';
import { decideRoleEligibility, ROLE_ELIGIBILITY_POLICY_VERSION, type RoleEligibilityRequest } from './roleEligibilityPolicy.js';
import type { HostAdapterRegistry } from './hostAdapterRegistry.js';
import { sha256Hex } from './hostAdapterRegistry.js';
import type {
  ConfigSourceLayer,
  EligibilityPhase,
  ModelRole,
  PostconditionFailureReason,
  ExecutorIdentity,
  ProviderSurface,
} from './types.js';
import type { FallbackChainEntry } from './executorAttestation.js';

export interface HarnessAttemptContext {
  readonly role: ModelRole;
  readonly requestDigest: string;
  readonly routeDigest: string;
  readonly requestedIdentity: ExecutorIdentity;
  readonly resolvedIdentity: ExecutorIdentity;
  readonly phase: Extract<EligibilityPhase, 'pre-primary-transport' | 'pre-fallback-transport' | 'pre-retry-transport'>;
  readonly fallbackOrdinal: number;
  readonly retryOrdinal: number;
  readonly attemptOrdinal: number;
  readonly priorTraceDigest: string | null;
  readonly policyTraceDigest: string;
  readonly fallbackChain: readonly FallbackChainEntry[];
  readonly surface: ProviderSurface;
  readonly seatDigest: string;
}

export interface HarnessTransportAuthority {
  readonly guard: HarnessTransportGuard;
  readAttemptHistory?(): readonly ExecutorAttemptRecord[];
  reserveAttempt(context: HarnessAttemptContext): ExecutorReservationV1 | Promise<ExecutorReservationV1>;
  attestCompletion(input: {
    readonly context: HarnessAttemptContext;
    readonly reservation?: ExecutorReservationV1;
    readonly response: { readonly model: string; readonly content?: string; readonly success: boolean; readonly usage?: { readonly inputTokens: number; readonly outputTokens: number; readonly thinkingTokens?: number }; readonly durationMs: number; readonly terminalReason?: string };
  }): ExecutorAttestationV2 | ExecutorAttestationV3
    | Promise<ExecutorAttestationV2 | ExecutorAttestationV3>;
}

export type HarnessExecutorProjection =
  | { readonly status: 'idle'; readonly attempts: readonly ExecutorAttemptRecord[] }
  | { readonly status: 'blocked'; readonly attempts: readonly ExecutorAttemptRecord[]; readonly requested: ExecutorIdentity; readonly resolved: ExecutorIdentity; readonly fallbackOrdinal: number; readonly retryOrdinal: number; readonly terminalReason: string }
  | { readonly status: 'verified'; readonly attempts: readonly ExecutorAttemptRecord[]; readonly requested: ExecutorIdentity; readonly resolved: ExecutorIdentity; readonly fallbackChain: ExecutorAttestation['subject']['fallbackChain']; readonly effort: string; readonly seat: ExecutorAttestation['subject']['seat']; readonly funding: ExecutorAttestation['subject']['funding']; readonly quotaSurface: ExecutorAttestation['subject']['quotaSurface']; readonly terminalReason?: string; readonly exhaustionClass?: ExecutorAttestation['subject']['exhaustionClass']; readonly attestationId: string };

export interface ExecutorAttemptRecord {
  readonly attemptOrdinal: number;
  readonly fallbackOrdinal: number;
  readonly retryOrdinal: number;
  readonly priorTraceDigest: string | null;
  readonly policyTraceDigest: string;
  readonly requestDigest: string;
  readonly routeDigest: string;
  readonly attemptDigest: string;
  readonly attestationDigest: string;
  readonly durationMs: number;
  readonly attestation: ExecutorAttestation;
}

/** Canonical raw DTO constructor shared by transport, CLI, and Studio. */
export function toExecutorAttemptRecord(attestation: ExecutorAttestation): ExecutorAttemptRecord {
  const subject = attestation.subject;
  return {
    attemptOrdinal: subject.attemptOrdinal,
    fallbackOrdinal: subject.fallbackOrdinal,
    retryOrdinal: subject.retryOrdinal,
    priorTraceDigest: subject.priorTraceDigest,
    policyTraceDigest: subject.policyTraceDigest,
    requestDigest: subject.requestDigest,
    routeDigest: subject.routeDigest,
    attemptDigest: subject.attemptDigest,
    attestationDigest: sha256Hex(JSON.stringify(attestation)),
    durationMs: subject.durationMs,
    attestation,
  };
}

/**
 * Exact per-provider-transport resource delta signed into the attestation.
 */
export interface QuotaCounterDelta {
  readonly calls: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly activeSeconds: number;
}

/**
 * Narrow immutable ref derived from a verified {@link ExecutorAttemptRecord}.
 * Carries only public binding digests + the signed counter delta — never the
 * attestation envelope itself. Tool-loop telemetry, ledger entries, and
 * transport results propagate this ref so that concurrent calls cannot race on
 * `HarnessExecutorProjection.attempts.at(-1)` (#717 / W8C-04).
 */
export interface ExecutorAttestationRef {
  readonly attestationId: string;
  readonly attestationDigest: string;
  readonly attemptDigest: string;
  readonly requestDigest: string;
  readonly routeDigest: string;
  readonly attemptOrdinal: number;
  readonly fallbackOrdinal: number;
  readonly retryOrdinal: number;
  readonly durationMs: number;
  readonly outcome: 'success' | 'failure';
  readonly quotaCounterDelta: QuotaCounterDelta;
}

/**
 * Derive a narrow immutable {@link ExecutorAttestationRef} from a verified
 * record, including the exact per-transport delta already signed by the host.
 */
export function toExecutorAttestationRef(
  record: ExecutorAttemptRecord,
): ExecutorAttestationRef | null {
  if (record.attestation.subject.schemaVersion === 'executor-attestation.v1') return null;
  const ref: ExecutorAttestationRef = {
    attestationId: record.attestation.subject.attestationId,
    attestationDigest: record.attestationDigest,
    attemptDigest: record.attemptDigest,
    requestDigest: record.requestDigest,
    routeDigest: record.routeDigest,
    attemptOrdinal: record.attemptOrdinal,
    fallbackOrdinal: record.fallbackOrdinal,
    retryOrdinal: record.retryOrdinal,
    durationMs: record.durationMs,
    outcome: record.attestation.subject.success ? 'success' : 'failure',
    quotaCounterDelta: Object.freeze({ ...record.attestation.subject.quotaCounterDelta }),
  };
  return Object.freeze(ref);
}

/** One durable projection builder shared by CLI, Studio, and in-process clients. */
export function projectExecutorAttemptHistory(
  attempts: readonly ExecutorAttemptRecord[],
): HarnessExecutorProjection {
  const latest = attempts.at(-1)?.attestation.subject;
  if (!latest) return { status: 'idle', attempts: [...attempts] };
  return {
    status: 'verified', attempts: [...attempts],
    requested: latest.requestedIdentity, resolved: latest.resolvedIdentity,
    fallbackChain: latest.fallbackChain, effort: latest.effort,
    seat: latest.seat, funding: latest.funding, quotaSurface: latest.quotaSurface,
    terminalReason: latest.terminalReason, exhaustionClass: latest.exhaustionClass,
    attestationId: latest.attestationId,
  };
}

/** One canonical user-facing representation for CLI and Studio surfaces. */
export function formatHarnessExecutorProjection(projection: HarnessExecutorProjection): string {
  return JSON.stringify(projection);
}

/**
 * Outcome of the post-transport verification gate. `ok: true` carries the
 * verified attestation; `ok: false` carries a typed quarantine reason.
 */
export type TransportPostconditionResult =
  | { readonly ok: true; readonly attestation: ExecutorAttestation }
  | { readonly ok: false; readonly reason: PostconditionFailureReason; readonly detail: string };

/**
 * Pre-network check result. Callers must obtain an `ok` decision before any
 * network access.
 */
export type PreNetworkResult =
  | { readonly ok: true; readonly reservation: ExecutorReservationV1; readonly policyTraceDigest: string }
  | { readonly ok: false; readonly reason: 'policy-rejected' | 'reservation-invalid' | 'reservation-consume-failed'; readonly detail: string };

/**
 * Construct the guard. The tracker and ledger are process-local by default;
 * production deployments inject durable implementations.
 */
export class HarnessTransportGuard {
  readonly #registry: HostAdapterRegistry;
  readonly #reservations: ReservationTracker;
  readonly #nonces: NonceLedger;

  constructor(
    registry: HostAdapterRegistry,
    options?: { reservations?: ReservationTracker; nonces?: NonceLedger },
  ) {
    this.#registry = registry;
    this.#reservations = options?.reservations ?? new ReservationTracker();
    this.#nonces = options?.nonces ?? new NonceLedger();
  }

  /**
   * Historical authenticity only: was this completion validly signed and bound
   * when it was issued? Evaluated at `subject.issuedAt`, so it never applies
   * expiry. It is NOT a present-permission decision; use
   * {@link admitPersistedCompletionNow} before acting on a completion (#1312).
   */
  verifyPersistedCompletion(attestation: ExecutorAttestationV2 | ExecutorAttestationV3) {
    return verifyExecutorAttestation(this.#registry, attestation, attestation.subject.issuedAt,
      { historical: true });
  }

  /**
   * Present permission: the completion must be authentic AND still inside its
   * validity window at `now`. An expired completion is historical evidence,
   * never current admission.
   */
  admitPersistedCompletionNow(
    attestation: ExecutorAttestationV2 | ExecutorAttestationV3,
    now: string,
  ) {
    if (!Number.isFinite(Date.parse(now))) {
      return { ok: false as const, reason: 'expired' as const, detail: 'admission time is not a valid timestamp' };
    }
    return verifyExecutorAttestation(this.#registry, attestation, now);
  }

  /**
   * Pre-network gate. Combines the eligibility policy with reservation
   * verification + atomic consume.
   */
  authorizeTransport(input: {
    policy: RoleEligibilityRequest;
    reservation: ExecutorReservationV1;
    now: string;
    expectedRequestDigest?: string;
    expectedRouteDigest?: string;
  }): PreNetworkResult {
    const decision = decideRoleEligibility(input.policy);
    if (!decision.ok) {
      return { ok: false, reason: 'policy-rejected', detail: `${decision.reason}: ${decision.detail}` };
    }
    const verification = verifyExecutorReservation(this.#registry, input.reservation, input.now);
    if (!verification.ok) {
      return { ok: false, reason: 'reservation-invalid', detail: `${verification.reason}: ${verification.detail}` };
    }
    const expectedIdentity = input.policy.resolvedIdentity;
    const reservedIdentity = input.reservation.subject.identity;
    if (expectedIdentity.provider !== reservedIdentity.provider
      || expectedIdentity.model !== reservedIdentity.model
      || expectedIdentity.effort !== reservedIdentity.effort) {
      return { ok: false, reason: 'reservation-invalid', detail: 'reservation identity does not match the resolved route' };
    }
    if (input.expectedRequestDigest !== undefined
      && input.reservation.subject.requestDigest !== input.expectedRequestDigest) {
      return { ok: false, reason: 'reservation-invalid', detail: 'reservation request digest does not match the request' };
    }
    if (input.expectedRouteDigest !== undefined
      && input.reservation.subject.routeDigest !== input.expectedRouteDigest) {
      return { ok: false, reason: 'reservation-invalid', detail: 'reservation route digest does not match the route' };
    }
    const consumed = this.#reservations.consume(input.reservation, input.now);
    if (!consumed.ok) {
      return { ok: false, reason: 'reservation-consume-failed', detail: 'reservation already consumed' };
    }
    return { ok: true, reservation: input.reservation, policyTraceDigest: decision.trace.digest };
  }

  /**
   * Post-transport gate. Verifies the signed attestation, checks it against
   * the consumed reservation, reruns the policy on the signed actual identity,
   * and burns the attestation nonce. Any failure is typed; the caller must
   * quarantine the route and discard the response with zero harness mutation.
   */
  verifyCompletion(input: {
    attestation: ExecutorAttestation;
    reservation?: ExecutorReservationV1;
    role: ModelRole;
    sourceLayer: ConfigSourceLayer;
    phase: EligibilityPhase;
    policyInvokedAt: readonly EligibilityPhase[];
    now: string;
  }): TransportPostconditionResult {
    if (input.role === 'harness' && !input.reservation) {
      return postconditionFail('reservation-not-consumed', 'harness completion has no reservation');
    }
    if (input.reservation && !this.#reservations.isConsumed(input.reservation.subject.reservationId)) {
      return postconditionFail('reservation-not-consumed', 'reservation was not consumed before completion');
    }
    const intrinsic = verifyExecutorAttestation(this.#registry, input.attestation, input.now);
    if (!intrinsic.ok) {
      return postconditionFail(intrinsic.reason, intrinsic.detail);
    }
    if (input.reservation) {
      const against = verifyAttestationAgainstReservation(input.attestation, input.reservation);
      if (!against.ok) return postconditionFail(against.reason, against.detail);
    }
    // Rerun the policy on the signed actual identity.
    const signedActual = input.attestation.subject.resolvedIdentity;
    const signedRequest: RoleEligibilityRequest = {
      role: input.role,
      sourceLayer: input.sourceLayer,
      phase: input.phase,
      requestedIdentity: input.attestation.subject.requestedIdentity,
      resolvedIdentity: signedActual,
      fallbackOrdinal: input.attestation.subject.fallbackOrdinal,
      retryOrdinal: input.attestation.subject.retryOrdinal,
      priorDigest: input.attestation.subject.priorTraceDigest,
      policyInvokedAt: input.policyInvokedAt,
      substitutionAllowed: false,
    };
    const policy = decideRoleEligibility(signedRequest);
    if (!policy.ok) {
      return postconditionFail('attestation-policy-rejection', `${policy.reason}: ${policy.detail}`);
    }
    // Burn the nonce exactly once. Replay is a typed failure.
    const burn = this.#nonces.burn(
      input.attestation.subject.nonce,
      input.attestation.subject.attestationId,
      input.now,
    );
    if (!burn.ok) {
      return postconditionFail('attestation-nonce-burned', `nonce replayed for attestation ${input.attestation.subject.attestationId}`);
    }
    void ROLE_ELIGIBILITY_POLICY_VERSION;
    return { ok: true, attestation: input.attestation };
  }

  /**
   * Exposed for callers that need to inspect the in-memory tracker state.
   */
  isReservationConsumed(reservationId: string): boolean {
    return this.#reservations.isConsumed(reservationId);
  }

  isNonceBurned(nonce: string): boolean {
    return this.#nonces.isBurned(nonce);
  }

  get isDurable(): boolean {
    return this.#reservations.durable && this.#nonces.durable;
  }
}

function postconditionFail(reason: PostconditionFailureReason, detail: string): TransportPostconditionResult {
  return { ok: false, reason, detail };
}
