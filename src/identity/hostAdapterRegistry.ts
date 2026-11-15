/**
 * HostAdapterRegistry for W8C-03 (#716).
 *
 * The host-owned adapter registry is the *only* entity that may sign
 * {@link ExecutorReservationV1} and {@link ExecutorAttestationV1} records.
 * Caller-requested or provider-self-reported identity cannot establish
 * execution identity — only this signature can.
 *
 * Spec: W8C-03 product change — "signed only by the host-owned adapter
 * registry".
 */

import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { ProviderFamily, ProviderSurface } from './types.js';

/**
 * Adapter descriptor. An adapter is eligible to sign reservations for a route
 * only if `canEnforceNoSubstitution` is true. Routes whose adapter cannot
 * guarantee the actual executor (e.g. an open proxy that may rewrite the
 * model) are harness-ineligible.
 */
export interface HostAdapterDescriptor {
  readonly adapterId: string;
  readonly surface: ProviderSurface;
  readonly provider: ProviderFamily;
  readonly canEnforceNoSubstitution: boolean;
}

/**
 * Immutable trust key. The registry holds one; signatures bind to its
 * `keyId` so rotation is auditable.
 */
export interface HostTrustKey {
  readonly keyId: string;
  readonly secret: Uint8Array;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(record[k])}`).join(',')}}`;
}

/**
 * Compute a deterministic HMAC-SHA256 signature over canonical JSON. Used for
 * both reservations and attestations. Returns base64url.
 */
function signJson(key: HostTrustKey, payload: unknown): string {
  return createHmac('sha256', key.secret).update(canonicalJson(payload)).digest('base64url');
}

/**
 * Verify a signature produced by {@link signJson}. Constant-time.
 */
function verifyJsonSignature(key: HostTrustKey, payload: unknown, signature: string): boolean {
  const expected = Buffer.from(signJson(key, payload), 'base64url');
  const supplied = Buffer.from(signature, 'base64url');
  if (expected.byteLength !== supplied.byteLength) return false;
  return timingSafeEqual(expected, supplied);
}

/**
 * Hash arbitrary textual content. Used for run/attempt digests that feed the
 * signed payloads.
 */
export function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/**
 * Mint a fresh one-use nonce. Nonces are burned by the attestation ledger
 * before a completion is accepted.
 */
export function mintNonce(): string {
  return randomBytes(16).toString('base64url');
}

/**
 * Mint a fresh trust key. Used in tests and in process bootstrap; in
 * production the key is loaded from the operator environment.
 */
export function mintTrustKey(keyId: string): HostTrustKey {
  return { keyId, secret: randomBytes(32) };
}

/**
 * Host-owned adapter registry. Holds the trust key and the registered adapters.
 * Issues reservations for routes whose adapter can enforce no-substitution.
 */
export class HostAdapterRegistry {
  readonly #key: HostTrustKey;
  readonly #adapters: ReadonlyMap<string, HostAdapterDescriptor>;

  constructor(key: HostTrustKey, adapters: readonly HostAdapterDescriptor[]) {
    this.#key = key;
    const map = new Map<string, HostAdapterDescriptor>();
    for (const adapter of adapters) {
      map.set(adapter.adapterId, Object.freeze({ ...adapter }));
    }
    this.#adapters = map;
  }

  get keyId(): string {
    return this.#key.keyId;
  }

  listAdapters(): readonly HostAdapterDescriptor[] {
    return [...this.#adapters.values()];
  }

  adapterForSurface(surface: ProviderSurface): HostAdapterDescriptor | undefined {
    for (const adapter of this.#adapters.values()) {
      if (adapter.surface === surface) return adapter;
    }
    return undefined;
  }

  /**
   * Return whether the adapter for `surface` can enforce no-substitution. A
   * harness transport must refuse to issue a reservation when this is false.
   */
  canEnforceNoSubstitution(surface: ProviderSurface): boolean {
    return this.adapterForSurface(surface)?.canEnforceNoSubstitution ?? false;
  }

  /**
   * Sign a payload using the registry's trust key. Only the registry may call
   * this — reservations and attestations are constructed inside the registry
   * module so callers cannot mint unsigned records.
   */
  /** @internal Accepts only the canonical reservation envelope schema. */
  issueReservationSignature(payload: { readonly schemaVersion: 'executor-reservation.v1' }): string {
    if (payload.schemaVersion !== 'executor-reservation.v1') throw new Error('INVALID_RESERVATION_ENVELOPE');
    return signJson(this.#key, payload);
  }

  /** @internal Accepts only the canonical attestation envelope schema. */
  issueAttestationSignature(payload: {
    readonly schemaVersion: 'executor-attestation.v1' | 'executor-attestation.v2'
      | 'executor-attestation.v3';
  }): string {
    if (payload.schemaVersion !== 'executor-attestation.v1'
      && payload.schemaVersion !== 'executor-attestation.v2'
      && payload.schemaVersion !== 'executor-attestation.v3') {
      throw new Error('INVALID_ATTESTATION_ENVELOPE');
    }
    return signJson(this.#key, payload);
  }

  /** @internal Accepts only the host-owned finite-campaign funding schema. */
  issueCampaignFundingSignature(payload: {
    readonly schemaVersion: 'campaign-funding-reservation.v1' | 'campaign-funding-release.v1';
  }): string {
    if (payload.schemaVersion !== 'campaign-funding-reservation.v1'
      && payload.schemaVersion !== 'campaign-funding-release.v1') {
      throw new Error('INVALID_CAMPAIGN_FUNDING_ENVELOPE');
    }
    return signJson(this.#key, payload);
  }

  /** @internal Sign only the dedicated GLM Coding Plan seat envelope. */
  issueGLMCodingPlanSeatSignature(payload: {
    readonly schemaVersion: 'glm-coding-plan-seat.v1' | 'glm-coding-plan-invocation.v1';
  }): string {
    if (payload.schemaVersion !== 'glm-coding-plan-seat.v1'
      && payload.schemaVersion !== 'glm-coding-plan-invocation.v1') {
      throw new Error('INVALID_GLM_CODING_PLAN_SEAT_ENVELOPE');
    }
    return signJson(this.#key, payload);
  }

  /**
   * Verify a signature against the registry's trust key.
   */
  verify(payload: unknown, signature: string): boolean {
    return verifyJsonSignature(this.#key, payload, signature);
  }
}
