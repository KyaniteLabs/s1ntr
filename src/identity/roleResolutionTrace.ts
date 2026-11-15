/**
 * Immutable RoleResolutionTrace for W8C-03 (#716).
 *
 * Every role resolution attempt records one trace. The eligibility policy
 * inspects the trace, and the trace digest chains into the next attempt so
 * that skipping a phase, mutating a resolved identity, or hiding a fallback
 * fails closed at the next gate.
 *
 * Spec: W8C-03 acceptance — "The immutable role-resolution trace proves
 * pre/post policy invocation, normalized requested/resolved identities, config
 * source layer, retry/fallback ordinal, and prior digest; mutation, alias
 * ambiguity, or a skipped phase fails closed."
 */

import { createHash } from 'node:crypto';
import type {
  ConfigSourceLayer,
  EligibilityPhase,
  ExecutorIdentity,
  ModelRole,
} from './types.js';

/**
 * Frozen inputs used to construct a trace. The {@link priorDigest} chains
 * attempts; {@link policyInvokedAt} records which phases already ran the
 * eligibility policy.
 */
export interface RoleResolutionTraceInput {
  readonly policyVersion: string;
  readonly phase: EligibilityPhase;
  readonly sourceLayer: ConfigSourceLayer;
  readonly role: ModelRole;
  readonly requestedIdentity: ExecutorIdentity;
  readonly resolvedIdentity: ExecutorIdentity;
  readonly fallbackOrdinal: number;
  readonly retryOrdinal: number;
  readonly priorDigest: string | null;
  readonly policyInvokedAt: readonly EligibilityPhase[];
}

/**
 * Immutable role-resolution trace. Field order is fixed for stable digesting.
 * Use {@link freezeTrace} to construct one; never mutate.
 */
export interface RoleResolutionTrace {
  readonly policyVersion: string;
  readonly phase: EligibilityPhase;
  readonly sourceLayer: ConfigSourceLayer;
  readonly role: ModelRole;
  readonly requestedIdentity: ExecutorIdentity;
  readonly resolvedIdentity: ExecutorIdentity;
  readonly fallbackOrdinal: number;
  readonly retryOrdinal: number;
  readonly priorDigest: string | null;
  readonly policyInvokedAt: readonly EligibilityPhase[];
  readonly digest: string;
}

/**
 * Canonical JSON serialization for stable digests. Keys are emitted in a
 * fixed order; nested objects follow the same rule.
 */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(record[k])}`).join(',')}}`;
}

/**
 * Compute the digest of a trace input. Exposed for testing and for callers
 * that need to predict the digest before construction.
 */
export function computeTraceDigest(input: Omit<RoleResolutionTraceInput, never>): string {
  const payload = {
    policyVersion: input.policyVersion,
    phase: input.phase,
    sourceLayer: input.sourceLayer,
    role: input.role,
    requestedIdentity: input.requestedIdentity,
    resolvedIdentity: input.resolvedIdentity,
    fallbackOrdinal: input.fallbackOrdinal,
    retryOrdinal: input.retryOrdinal,
    priorDigest: input.priorDigest,
    policyInvokedAt: [...input.policyInvokedAt].sort(),
  };
  return createHash('sha256').update(canonicalJson(payload)).digest('hex');
}

/**
 * Construct an immutable trace. The digest is computed eagerly so any later
 * mutation is detectable by recomputing and comparing.
 *
 * `policyInvokedAt` must include the trace's own {@link phase}; omitting it is
 * treated as a skipped phase and fails closed at the eligibility boundary.
 */
export function freezeTrace(input: RoleResolutionTraceInput): RoleResolutionTrace {
  if (!input.policyInvokedAt.includes(input.phase)) {
    throw new Error(
      `ROLE_TRACE_PHASE_SKIPPED: phase ${input.phase} not present in policyInvokedAt`,
    );
  }
  if (input.fallbackOrdinal < 0 || input.retryOrdinal < 0) {
    throw new Error('ROLE_TRACE_ORDINAL_NEGATIVE');
  }
  const digest = computeTraceDigest(input);
  return Object.freeze({
    ...input,
    policyInvokedAt: Object.freeze([...input.policyInvokedAt]),
    digest,
  });
}

/**
 * Verify a trace's digest matches its contents. Used by the eligibility policy
 * as a tamper check before reading any field.
 */
export function verifyTraceDigest(trace: RoleResolutionTrace): boolean {
  const { digest, ...rest } = trace;
  void rest;
  const recomputed = computeTraceDigest({
    policyVersion: trace.policyVersion,
    phase: trace.phase,
    sourceLayer: trace.sourceLayer,
    role: trace.role,
    requestedIdentity: trace.requestedIdentity,
    resolvedIdentity: trace.resolvedIdentity,
    fallbackOrdinal: trace.fallbackOrdinal,
    retryOrdinal: trace.retryOrdinal,
    priorDigest: trace.priorDigest,
    policyInvokedAt: trace.policyInvokedAt,
  });
  return recomputed === digest;
}

/**
 * Extend a trace into the next phase. The new trace's `priorDigest` chains to
 * the previous trace so the lineage is non-repudiable.
 */
export function chainTrace(
  previous: RoleResolutionTrace,
  nextPhase: EligibilityPhase,
  policyInvokedAt: readonly EligibilityPhase[],
): RoleResolutionTrace {
  return freezeTrace({
    policyVersion: previous.policyVersion,
    phase: nextPhase,
    sourceLayer: previous.sourceLayer,
    role: previous.role,
    requestedIdentity: previous.requestedIdentity,
    resolvedIdentity: previous.resolvedIdentity,
    fallbackOrdinal: previous.fallbackOrdinal,
    retryOrdinal: previous.retryOrdinal,
    priorDigest: previous.digest,
    policyInvokedAt: policyInvokedAt,
  });
}
