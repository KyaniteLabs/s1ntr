/**
 * Capability probe classification for W8C-03 (#716).
 *
 * Capability probes distinguish web/account balance, gateway entitlement, CLI
 * entitlement, proxy seat, reset time, and exhaustion class. Kilo, in
 * particular, exposes four distinct surfaces — denial on one must not demote
 * the others.
 *
 * Spec: W8C-03 product change — "Capability probes distinguish web/account
 * balance, gateway entitlement, CLI entitlement, proxy seat, reset time, and
 * exhaustion class."
 *
 * Scope: this module does NOT perform probes. It classifies results that a
 * caller already holds. A `state: 'available'` entry is only the caller's
 * claim; it does not attest a live endpoint or a deployed identity. Use
 * {@link isSurfaceAttestedAvailable} when a decision needs evidence: it
 * requires probe evidence (probe class + timestamp) no older than a bound.
 * A healthy port is never identity proof.
 */

import type { ExhaustionClass, ProviderSurface, QuotaSurface } from './types.js';

/**
 * Result of a single surface probe. `capabilityUnknown` is distinct from
 * `denied`: an unknown probe cannot satisfy critical-role claims, but it also
 * cannot demote unrelated surfaces.
 */
export interface CapabilityProbeResult {
  readonly surface: ProviderSurface;
  readonly state: 'available' | 'denied' | 'capability-unknown';
  readonly exhaustionClass?: ExhaustionClass;
  readonly resetTime?: string;
  readonly detail?: string;
  /** Evidence from an actual probe run. Absent = unattested classification. */
  readonly evidence?: CapabilityProbeEvidence;
}

/**
 * Evidence that a probe actually ran. Supplied by whatever performed the
 * probe; this module only checks that it is present and fresh.
 */
export interface CapabilityProbeEvidence {
  /** What kind of probe ran, e.g. 'http-health', 'auth-check', 'model-list'. */
  readonly probeClass: string;
  /** ISO timestamp of when the probe ran. */
  readonly probedAt: string;
  /** Endpoint or surface address that was probed, if any. */
  readonly endpoint?: string;
}

/**
 * Aggregated capability snapshot. Surfaces recorded here are independent — a
 * denial on the Kilo gateway does not demote the Kilo web balance or CLI.
 */
export interface CapabilitySnapshot {
  readonly results: readonly CapabilityProbeResult[];
}

/**
 * Look up a single surface's result.
 */
export function probeResult(snapshot: CapabilitySnapshot, surface: ProviderSurface): CapabilityProbeResult | undefined {
  return snapshot.results.find((r) => r.surface === surface);
}

/**
 * Convenience: is a specific surface *reported* available? This reads the
 * supplied state only; it does not check that a probe ran. Prefer
 * {@link isSurfaceAttestedAvailable} for admission or critical-role decisions.
 */
export function isSurfaceAvailable(snapshot: CapabilitySnapshot, surface: ProviderSurface): boolean {
  return probeResult(snapshot, surface)?.state === 'available';
}

/**
 * Is a surface available AND backed by fresh probe evidence? Returns false
 * when the result has no evidence, an empty probe class, an unparseable or
 * future `probedAt`, or evidence older than `maxAgeMs`. An unattested
 * 'available' therefore cannot satisfy a claim that needs proof.
 */
export function isSurfaceAttestedAvailable(
  snapshot: CapabilitySnapshot,
  surface: ProviderSurface,
  options: { now: Date; maxAgeMs: number },
): boolean {
  const result = probeResult(snapshot, surface);
  if (result?.state !== 'available' || !result.evidence) return false;
  if (!Number.isFinite(options.maxAgeMs) || options.maxAgeMs < 0) return false;
  const { probeClass, probedAt } = result.evidence;
  if (probeClass.trim() === '') return false;
  const probedMs = Date.parse(probedAt);
  if (!Number.isFinite(probedMs)) return false;
  const ageMs = options.now.getTime() - probedMs;
  return ageMs >= 0 && ageMs <= options.maxAgeMs;
}

/**
 * Convenience: was a specific surface explicitly denied? (capability-unknown
 * is not denial.)
 */
export function isSurfaceDenied(snapshot: CapabilitySnapshot, surface: ProviderSurface): boolean {
  return probeResult(snapshot, surface)?.state === 'denied';
}

/**
 * Build a snapshot. Duplicates of the same surface are rejected: each surface
 * appears at most once so reports cannot be split.
 */
export function buildCapabilitySnapshot(results: readonly CapabilityProbeResult[]): CapabilitySnapshot {
  const seen = new Set<ProviderSurface>();
  for (const result of results) {
    if (seen.has(result.surface)) {
      throw new Error(`CAPABILITY_PROBE_DUPLICATE: surface ${result.surface} appears twice`);
    }
    seen.add(result.surface);
  }
  return { results: Object.freeze([...results]) };
}

/**
 * Map a {@link ProviderSurface} to its {@link QuotaSurface}. Kilo web balance
 * is *not* a quota surface, but the gateway/CLI are.
 */
export function quotaSurfaceFor(providerSurface: ProviderSurface): QuotaSurface | null {
  switch (providerSurface) {
    case 'cliproxy-seat':
      return 'cliproxy-seat';
    case 'kilo-gateway-entitlement':
      return 'kilo-gateway-entitlement';
    case 'kilo-cli-entitlement':
      return 'kilo-cli-entitlement';
    case 'kilo-web-balance':
      return 'kilo-web-balance';
    case 'glm-coding-plan-seat':
      return 'glm-coding-plan-seat';
    case 'minimax-token-plan-seat':
      return 'minimax-token-plan-seat';
    case 'openai-direct':
    case 'anthropic-direct':
    case 'google-direct':
    case 'glm-direct':
    case 'minimax-direct':
    case 'moonshot-direct':
      return 'metered-api';
    case 'lmstudio-local':
    case 'ollama-cloud':
      return 'local';
    default:
      return null;
  }
}

/**
 * Reproduce the spec's "Kilo gateway denial preserving unknown/available
 * status for other Kilo surfaces" case. The returned snapshot records the
 * gateway as denied with the supplied exhaustion class while leaving the
 * other Kilo surfaces in their supplied state.
 */
export function kiloGatewayDenied(options: {
  gatewayExhaustionClass?: ExhaustionClass;
  resetTime?: string;
  webBalanceState?: 'available' | 'denied' | 'capability-unknown';
  cliState?: 'available' | 'denied' | 'capability-unknown';
}): CapabilitySnapshot {
  return buildCapabilitySnapshot([
    { surface: 'kilo-web-balance', state: options.webBalanceState ?? 'capability-unknown' },
    {
      surface: 'kilo-gateway-entitlement',
      state: 'denied',
      exhaustionClass: options.gatewayExhaustionClass ?? 'subscription-quota-exhausted',
      resetTime: options.resetTime,
    },
    { surface: 'kilo-cli-entitlement', state: options.cliState ?? 'capability-unknown' },
  ]);
}
