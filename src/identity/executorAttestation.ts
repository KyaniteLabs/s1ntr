/**
 * Versioned executor attestations for W8C-03/W8C-04 (#716/#717).
 *
 * Signed only by the host-owned adapter registry. Its subject binds run/
 * request/attempt digests, requested and resolved provider/model/effort,
 * complete fallback chain, seat/credential binding, funding mode, quota
 * surface/counters, issued/expiry timestamps, and one-use nonce. The durable
 * authorization ledger burns the nonce before accepting completion.
 *
 * Spec: W8C-03 product change.
 */

import type { HostAdapterRegistry } from './hostAdapterRegistry.js';
import { closeSync, mkdirSync, openSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import type {
  ExecutorIdentity,
  ExhaustionClass,
  FundingTruth,
  ProviderSurface,
  QuotaSurface,
  SeatBinding,
} from './types.js';
import { isFundingTruthComplete } from './fundingTruth.js';

/**
 * A single entry in the complete fallback chain. The full chain is recorded;
 * hidden fallbacks are a typed verification failure.
 */
export interface FallbackChainEntry {
  readonly ordinal: number;
  readonly identity: ExecutorIdentity;
  readonly reason?: string;
}

/**
 * Attestation subject. Field order is stable for signing.
 */
export interface ExecutorAttestationSubjectV1 {
  readonly schemaVersion: 'executor-attestation.v1';
  readonly attestationId: string;
  readonly runDigest: string;
  readonly requestDigest: string;
  readonly attemptDigest: string;
  readonly routeDigest: string;
  readonly attemptOrdinal: number;
  readonly fallbackOrdinal: number;
  readonly retryOrdinal: number;
  readonly priorTraceDigest: string | null;
  readonly policyTraceDigest: string;
  readonly requestedIdentity: ExecutorIdentity;
  readonly resolvedIdentity: ExecutorIdentity;
  readonly effort: string;
  readonly fallbackChain: readonly FallbackChainEntry[];
  readonly seat: SeatBinding;
  readonly funding: FundingTruth;
  readonly quotaSurface: QuotaSurface;
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly nonce: string;
  readonly keyId: string;
  readonly adapterId: string;
  readonly surface: ProviderSurface;
  readonly durationMs: number;
  readonly terminalReason?: string;
  readonly exhaustionClass?: ExhaustionClass;
}

export interface ExecutorAttestationSubjectV2
  extends Omit<ExecutorAttestationSubjectV1, 'schemaVersion'> {
  readonly schemaVersion: 'executor-attestation.v2';
  readonly success: boolean;
  readonly quotaCounterDelta: {
    readonly calls: number;
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly activeSeconds: number;
  };
}

export interface ExecutorAttestationSubjectV3
  extends Omit<ExecutorAttestationSubjectV2, 'schemaVersion'> {
  readonly schemaVersion: 'executor-attestation.v3';
  /** SHA-256 of the exact response content returned by the executor. */
  readonly responseDigest: string;
}

/**
 * Signed attestation envelope.
 */
export interface ExecutorAttestationV1 {
  readonly subject: ExecutorAttestationSubjectV1;
  readonly signature: string;
}

export interface ExecutorAttestationV2 {
  readonly subject: ExecutorAttestationSubjectV2;
  readonly signature: string;
}

export interface ExecutorAttestationV3 {
  readonly subject: ExecutorAttestationSubjectV3;
  readonly signature: string;
}

export type ExecutorAttestation = ExecutorAttestationV1 | ExecutorAttestationV2 | ExecutorAttestationV3;

/**
 * Issue options. The registry's `keyId` and the adapter descriptor's
 * `adapterId` are stamped in by this function; the caller does not supply
 * them.
 */
export interface IssueAttestationOptions {
  readonly attestationId: string;
  readonly runDigest: string;
  readonly requestDigest: string;
  readonly attemptDigest: string;
  readonly routeDigest?: string;
  readonly attemptOrdinal?: number;
  readonly fallbackOrdinal?: number;
  readonly retryOrdinal?: number;
  readonly priorTraceDigest?: string | null;
  readonly policyTraceDigest?: string;
  readonly requestedIdentity: ExecutorIdentity;
  readonly resolvedIdentity: ExecutorIdentity;
  readonly effort: string;
  readonly fallbackChain: readonly FallbackChainEntry[];
  readonly seat: SeatBinding;
  readonly funding: FundingTruth;
  readonly quotaSurface: QuotaSurface;
  readonly issuedAt: string;
  readonly ttlMs?: number;
  readonly nonce: string;
  readonly surface: ProviderSurface;
  readonly durationMs: number;
  readonly success: boolean;
  readonly quotaCounterDelta: ExecutorAttestationSubjectV2['quotaCounterDelta'];
  readonly responseDigest?: string;
  readonly terminalReason?: string;
  readonly exhaustionClass?: ExhaustionClass;
}

function buildSubject(input: {
  attestationId: string;
  runDigest: string;
  requestDigest: string;
  attemptDigest: string;
  routeDigest: string;
  attemptOrdinal: number;
  fallbackOrdinal: number;
  retryOrdinal: number;
  priorTraceDigest: string | null;
  policyTraceDigest: string;
  requestedIdentity: ExecutorIdentity;
  resolvedIdentity: ExecutorIdentity;
  effort: string;
  fallbackChain: readonly FallbackChainEntry[];
  seat: SeatBinding;
  funding: FundingTruth;
  quotaSurface: QuotaSurface;
  issuedAt: string;
  expiresAt: string;
  nonce: string;
  keyId: string;
  adapterId: string;
  surface: ProviderSurface;
  durationMs: number;
  success: boolean;
  quotaCounterDelta: ExecutorAttestationSubjectV2['quotaCounterDelta'];
  responseDigest?: string;
  terminalReason?: string;
  exhaustionClass?: ExhaustionClass;
}): ExecutorAttestationSubjectV2 | ExecutorAttestationSubjectV3 {
  return {
    schemaVersion: input.responseDigest ? 'executor-attestation.v3' : 'executor-attestation.v2',
    attestationId: input.attestationId,
    runDigest: input.runDigest,
    requestDigest: input.requestDigest,
    attemptDigest: input.attemptDigest,
    routeDigest: input.routeDigest,
    attemptOrdinal: input.attemptOrdinal,
    fallbackOrdinal: input.fallbackOrdinal,
    retryOrdinal: input.retryOrdinal,
    priorTraceDigest: input.priorTraceDigest,
    policyTraceDigest: input.policyTraceDigest,
    requestedIdentity: input.requestedIdentity,
    resolvedIdentity: input.resolvedIdentity,
    effort: input.effort,
    fallbackChain: input.fallbackChain,
    seat: input.seat,
    funding: input.funding,
    quotaSurface: input.quotaSurface,
    issuedAt: input.issuedAt,
    expiresAt: input.expiresAt,
    nonce: input.nonce,
    keyId: input.keyId,
    adapterId: input.adapterId,
    surface: input.surface,
    durationMs: input.durationMs,
    success: input.success,
    quotaCounterDelta: input.quotaCounterDelta,
    ...(input.responseDigest ? { responseDigest: input.responseDigest } : {}),
    ...(input.terminalReason !== undefined ? { terminalReason: input.terminalReason } : {}),
    ...(input.exhaustionClass !== undefined ? { exhaustionClass: input.exhaustionClass } : {}),
  } as ExecutorAttestationSubjectV2 | ExecutorAttestationSubjectV3;
}

/**
 * Issue a host-signed attestation. Only the registry may sign.
 */
export function issueExecutorAttestation(
  registry: HostAdapterRegistry,
  options: IssueAttestationOptions,
): ExecutorAttestationV2 | ExecutorAttestationV3 {
  const delta = options.quotaCounterDelta;
  if (!Number.isFinite(options.durationMs) || options.durationMs < 0
    || typeof options.success !== 'boolean'
    || !delta || delta.calls !== 1
    || !Number.isSafeInteger(delta.inputTokens) || delta.inputTokens < 0
    || !Number.isSafeInteger(delta.outputTokens) || delta.outputTokens < 0
    || !Number.isFinite(delta.activeSeconds) || delta.activeSeconds < 0) {
    throw new Error('ATTESTATION_EXACT_OUTCOME_REQUIRED');
  }
  const adapter = registry.adapterForSurface(options.surface);
  if (!adapter) {
    throw new Error(`ATTESTATION_ADAPTER_UNKNOWN: surface ${options.surface}`);
  }
  const expiresAtMs = Date.parse(options.issuedAt) + (options.ttlMs ?? 300_000);
  const expiresAt = new Date(expiresAtMs).toISOString();
  const subject = JSON.parse(JSON.stringify(buildSubject({
    ...options,
    routeDigest: options.routeDigest ?? options.attemptDigest,
    attemptOrdinal: options.attemptOrdinal ?? Math.max(0, options.fallbackChain.length - 1),
    fallbackOrdinal: options.fallbackOrdinal ?? Math.max(0, options.fallbackChain.length - 1),
    retryOrdinal: options.retryOrdinal ?? 0,
    priorTraceDigest: options.priorTraceDigest ?? null,
    policyTraceDigest: options.policyTraceDigest ?? 'legacy-policy-trace',
    durationMs: options.durationMs,
    success: options.success,
    quotaCounterDelta: options.quotaCounterDelta,
    expiresAt,
    keyId: registry.keyId,
    adapterId: adapter.adapterId,
  }))) as ExecutorAttestationSubjectV2 | ExecutorAttestationSubjectV3;
  const signature = registry.issueAttestationSignature(subject);
  return Object.freeze({ subject, signature }) as ExecutorAttestationV2 | ExecutorAttestationV3;
}

/**
 * Typed verification failures.
 */
export type AttestationVerificationFailure =
  | 'signature-invalid'
  | 'schema-version-mismatch'
  | 'wrong-trust-key'
  | 'expired'
  | 'wrong-adapter'
  | 'wrong-surface'
  | 'effort-mismatch'
  | 'seat-mismatch'
  | 'identity-mismatch'
  | 'fallback-chain-incomplete'
  | 'hidden-fallback';

/**
 * Verify an attestation against the registry. This only checks the
 * attestation's intrinsic integrity — it does not compare it against a
 * reservation. Use {@link verifyAttestationAgainstReservation} for the
 * transport postcondition.
 */
/**
 * Surfaces renamed after records were already signed under the old name, keyed
 * by the sha256 of the retired name so that name never ships in the package.
 * The value is the successor surface. Only historical ledger replay consults
 * this table; nothing new can be issued or admitted on a retired surface (#1591).
 */
interface RetiredSurface {
  readonly successor: ProviderSurface;
  /** sha256 of the adapter id the old records were signed with. */
  readonly adapterIdSha256: string;
}
const RETIRED_SURFACES: ReadonlyMap<string, RetiredSurface> = new Map([
  ['77544920b504cd11a8833fa2c43d052c09f0ba14199bc10a50632a910f8944ad',
    { successor: 'lan-gateway-litellm', adapterIdSha256: '641f76b4343f61cc690b9a34487b772bf9e966a687b4b0d3e10794e9a8adc3c2' }],
]);

const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');

/** The successor of a retired surface name, or undefined when it is not retired. */
export function retiredSurfaceSuccessor(surface: string): ProviderSurface | undefined {
  return RETIRED_SURFACES.get(sha256(surface))?.successor;
}

export interface VerifyAttestationOptions {
  /**
   * Replaying a persisted ledger record: a signature-valid record signed under
   * a retired surface name verifies against its successor's adapter. Never set
   * this for issuance or present admission.
   */
  readonly historical?: boolean;
}

export function verifyExecutorAttestation(
  registry: HostAdapterRegistry,
  attestation: ExecutorAttestation,
  now: string,
  options: VerifyAttestationOptions = {},
): { ok: true } | { ok: false; reason: AttestationVerificationFailure; detail: string } {
  const schemaVersion: unknown = attestation.subject.schemaVersion;
  if (schemaVersion !== 'executor-attestation.v1'
    && schemaVersion !== 'executor-attestation.v2'
    && schemaVersion !== 'executor-attestation.v3') {
    return { ok: false, reason: 'schema-version-mismatch', detail: `unexpected schema ${String(schemaVersion)}` };
  }
  if (attestation.subject.keyId !== registry.keyId) {
    return { ok: false, reason: 'wrong-trust-key', detail: `key ${attestation.subject.keyId} != ${registry.keyId}` };
  }
  if (!registry.verify(attestation.subject, attestation.signature)) {
    return { ok: false, reason: 'signature-invalid', detail: 'attestation signature does not verify' };
  }
  if (Date.parse(now) >= Date.parse(attestation.subject.expiresAt)) {
    return { ok: false, reason: 'expired', detail: `expired at ${attestation.subject.expiresAt}` };
  }
  const surface = attestation.subject.surface;
  let adapter = registry.adapterForSurface(surface);
  let expectedAdapterId = adapter?.adapterId;
  if (!adapter && options.historical) {
    // The signature already verified above, so the record is authentic. A record
    // signed under a retired surface name binds the successor's adapter under
    // that old name (#1591).
    // The old adapter id is pinned by hash, not derived from the successor's.
    const retired = RETIRED_SURFACES.get(sha256(surface));
    const successorAdapter = retired ? registry.adapterForSurface(retired.successor) : undefined;
    if (retired && successorAdapter) {
      adapter = successorAdapter;
      expectedAdapterId = sha256(attestation.subject.adapterId) === retired.adapterIdSha256
        ? attestation.subject.adapterId
        : '<retired adapter id>';
    }
  }
  if (!adapter) {
    return { ok: false, reason: 'wrong-surface', detail: `surface ${surface} has no adapter` };
  }
  if (expectedAdapterId !== attestation.subject.adapterId) {
    return { ok: false, reason: 'wrong-adapter', detail: `adapter ${attestation.subject.adapterId} != ${expectedAdapterId}` };
  }
  if (attestation.subject.effort !== attestation.subject.resolvedIdentity.effort) {
    return { ok: false, reason: 'effort-mismatch', detail: 'effort field does not match resolved identity effort' };
  }
  if (!isFundingTruthComplete(attestation.subject.funding)) {
    return { ok: false, reason: 'identity-mismatch', detail: 'signed funding truth is incomplete' };
  }
  if (attestation.subject.quotaSurface !== attestation.subject.funding.quotaSurface) {
    return { ok: false, reason: 'identity-mismatch', detail: 'quota surface differs from signed funding truth' };
  }
  if (!Number.isFinite(attestation.subject.durationMs) || attestation.subject.durationMs < 0) {
    return { ok: false, reason: 'identity-mismatch', detail: 'attempt duration is invalid' };
  }
  if (attestation.subject.schemaVersion !== 'executor-attestation.v1') {
    if (typeof attestation.subject.success !== 'boolean') {
      return { ok: false, reason: 'identity-mismatch', detail: 'attempt success flag is invalid' };
    }
    const delta = attestation.subject.quotaCounterDelta;
    if (!delta || delta.calls !== 1
      || !Number.isSafeInteger(delta.inputTokens) || delta.inputTokens < 0
      || !Number.isSafeInteger(delta.outputTokens) || delta.outputTokens < 0
      || !Number.isFinite(delta.activeSeconds) || delta.activeSeconds < 0) {
      return { ok: false, reason: 'identity-mismatch', detail: 'attempt quota delta is invalid' };
    }
    if (attestation.subject.schemaVersion === 'executor-attestation.v3'
      && !/^[a-f0-9]{64}$/.test(attestation.subject.responseDigest)) {
      return { ok: false, reason: 'identity-mismatch', detail: 'response digest is invalid' };
    }
  }
  // Validate the fallback chain is well-formed: ordinals are 0..N-1 in order.
  const chain = attestation.subject.fallbackChain;
  for (let i = 0; i < chain.length; i++) {
    if (chain[i].ordinal !== i) {
      return { ok: false, reason: 'fallback-chain-incomplete', detail: `fallback ordinal ${chain[i].ordinal} != ${i}` };
    }
  }
  return { ok: true };
}

/**
 * Compare an attestation against the reservation that authorized its transport.
 * Used immediately after harness transport to confirm the actual executor
 * matches the consumed reservation. Any mismatch is quarantine-worthy.
 */
export function verifyAttestationAgainstReservation(
  attestation: ExecutorAttestation,
  reservation: { subject: { runDigest: string; requestDigest: string; seat: SeatBinding; surface: ProviderSurface; identity: ExecutorIdentity; funding: FundingTruth } },
): { ok: true } | { ok: false; reason: AttestationVerificationFailure; detail: string } {
  if (attestation.subject.runDigest !== reservation.subject.runDigest) {
    return { ok: false, reason: 'identity-mismatch', detail: 'run digest mismatch' };
  }
  if (attestation.subject.requestDigest !== reservation.subject.requestDigest) {
    return { ok: false, reason: 'identity-mismatch', detail: 'request digest mismatch' };
  }
  if (attestation.subject.surface !== reservation.subject.surface) {
    return { ok: false, reason: 'identity-mismatch', detail: 'surface mismatch' };
  }
  // Identity is checked before seat — identity is the more fundamental
  // contract and the one the W8C-03 "request Sol / execute Luna" acceptance
  // exercises. Seat binding is the next layer of defense.
  if (
    attestation.subject.resolvedIdentity.model !== reservation.subject.identity.model ||
    attestation.subject.resolvedIdentity.provider !== reservation.subject.identity.provider ||
    attestation.subject.resolvedIdentity.effort !== reservation.subject.identity.effort
  ) {
    return { ok: false, reason: 'identity-mismatch', detail: 'resolved identity differs from reservation' };
  }
  if (attestation.subject.seat.seatDigest !== reservation.subject.seat.seatDigest) {
    return { ok: false, reason: 'seat-mismatch', detail: 'seat binding digest mismatch' };
  }
  const reservedFunding = reservation.subject.funding;
  const completedFunding = attestation.subject.funding;
  if (completedFunding.mode !== reservedFunding.mode
    || completedFunding.quotaSurface !== reservedFunding.quotaSurface
    || completedFunding.seatDigest !== reservedFunding.seatDigest
    || completedFunding.meteredReceiptDigest !== reservedFunding.meteredReceiptDigest
    || completedFunding.approvedUsdCeiling !== reservedFunding.approvedUsdCeiling) {
    return { ok: false, reason: 'identity-mismatch', detail: 'funding authority differs from reservation' };
  }
  const before = reservedFunding.quotaCounters;
  const after = completedFunding.quotaCounters;
  if (after.calls < before.calls || after.inputTokens < before.inputTokens
    || after.outputTokens < before.outputTokens || after.activeSeconds < before.activeSeconds) {
    return { ok: false, reason: 'identity-mismatch', detail: 'completion quota counters regressed' };
  }
  if (attestation.subject.quotaSurface !== attestation.subject.funding.quotaSurface) {
    return { ok: false, reason: 'identity-mismatch', detail: 'quota surface differs from signed funding truth' };
  }
  // Hidden fallback: if the attested resolved identity is not present in the
  // fallback chain, it was reached through an unrecorded step.
  const declared = attestation.subject.fallbackChain.some(
    (entry) =>
      entry.identity.model === attestation.subject.resolvedIdentity.model &&
      entry.identity.provider === attestation.subject.resolvedIdentity.provider &&
      entry.identity.effort === attestation.subject.resolvedIdentity.effort,
  );
  if (!declared && (
    attestation.subject.resolvedIdentity.model !== attestation.subject.requestedIdentity.model ||
    attestation.subject.resolvedIdentity.provider !== attestation.subject.requestedIdentity.provider
  )) {
    return { ok: false, reason: 'hidden-fallback', detail: 'resolved identity absent from fallback chain' };
  }
  return { ok: true };
}

/**
 * In-memory nonce ledger. Production deployments back this with the durable
 * authorization ledger; the contract is identical.
 */
export class NonceLedger {
  readonly #burned = new Map<string, { burnedAt: string; attestationId: string }>();
  readonly #directory: string | undefined;

  constructor(directory?: string) {
    this.#directory = directory;
    if (directory) mkdirSync(directory, { recursive: true });
  }

  get durable(): boolean { return this.#directory !== undefined; }

  #path(nonce: string): string {
    return join(this.#directory!, createHash('sha256').update(nonce).digest('hex'));
  }

  /**
   * Burn a nonce. A nonce can be burned at most once. Returns `ok: false` on
   * replay.
   */
  burn(nonce: string, attestationId: string, now: string): { ok: true } | { ok: false; reason: 'nonce-replayed' } {
    if (this.#directory) {
      let fd: number | undefined;
      try {
        fd = openSync(this.#path(nonce), 'wx', 0o600);
        writeFileSync(fd, JSON.stringify({ burnedAt: now, attestationId, nonce }));
        closeSync(fd);
        return { ok: true };
      } catch (error) {
        if (fd !== undefined) closeSync(fd);
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') return { ok: false, reason: 'nonce-replayed' };
        throw error;
      }
    }
    if (this.#burned.has(nonce)) {
      return { ok: false, reason: 'nonce-replayed' };
    }
    this.#burned.set(nonce, { burnedAt: now, attestationId });
    return { ok: true };
  }

  isBurned(nonce: string): boolean {
    if (this.#directory) return existsSync(this.#path(nonce));
    return this.#burned.has(nonce);
  }

  clear(): void {
    this.#burned.clear();
  }
}
