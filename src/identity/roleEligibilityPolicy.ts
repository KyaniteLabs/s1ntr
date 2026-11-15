/**
 * RoleEligibilityPolicy for W8C-03 (#716).
 *
 * The policy is the single boundary that decides whether a resolved role may
 * proceed to provider transport. It is invoked before accepting any role
 * config mutation, before constructing a provider, after merged role
 * resolution, before each primary/fallback/retry transport, before
 * MetaHarnessIntegration constructs its explicit harness-environment client,
 * and before restart hydration reuses or reconstructs a harness client.
 *
 * The non-negotiable rule: Luna (`gpt-5.6-luna`) is never harness. This
 * includes inheritance, fallback, retry, migration, restart, explicit client
 * construction, and legacy configuration conversion. Luna is eligible for the
 * `generator`, `evaluator`, and `studio` (chat) roles only.
 *
 * Spec: W8C-03 product change + section 3 of the test spec.
 */

import {
  LUNA_MODEL_ID,
  isLunaIdentity,
  resolveExecutorAlias,
} from './canonicalAlias.js';
import type {
  ConfigSourceLayer,
  EligibilityPhase,
  ExecutorIdentity,
  ModelRole,
} from './types.js';
import {
  freezeTrace,
  verifyTraceDigest,
  type RoleResolutionTrace,
  type RoleResolutionTraceInput,
} from './roleResolutionTrace.js';

/**
 * Current policy version. Bumped whenever the rule set changes. Burned into
 * every trace so historical evidence cannot be silently re-evaluated under a
 * new policy.
 */
export const ROLE_ELIGIBILITY_POLICY_VERSION = 'w8c-03.role-eligibility.v1';

/**
 * Typed rejection reasons. Callers must surface the matching trace + reason;
 * they must not retry silently.
 */
export type RoleEligibilityRejectionReason =
  | 'role-luna-harness-forbidden'
  | 'identity-unknown'
  | 'identity-ambiguous'
  | 'identity-not-resolved'
  | 'identity-requested-resolved-mismatch'
  | 'effort-downgraded'
  | 'effort-unknown'
  | 'seat-mismatch'
  | 'trace-skipped-phase'
  | 'trace-tampered'
  | 'trace-policy-version-mismatch'
  | 'substitution-allowed'
  | 'unknown-resolved-identity';

/**
 * Policy decision. {@link RoleEligibilityAllow} carries the trace the caller
 * should persist; {@link RoleEligibilityReject} carries a typed reason plus
 * the same trace for evidence.
 */
export interface RoleEligibilityAllow {
  readonly ok: true;
  readonly trace: RoleResolutionTrace;
  readonly identity: ExecutorIdentity;
}

export interface RoleEligibilityReject {
  readonly ok: false;
  readonly reason: RoleEligibilityRejectionReason;
  readonly trace: RoleResolutionTrace;
  readonly detail: string;
}

export type RoleEligibilityDecision = RoleEligibilityAllow | RoleEligibilityReject;

/**
 * Input to {@link decideRoleEligibility}. The caller supplies the resolved
 * identities, source layer, phase, and the ordered list of phases the policy
 * has already been invoked at.
 *
 * `substitutionAllowed` defaults to `false`. Any caller that asks the policy
 * to accept a route where the host adapter cannot guarantee the resolved
 * identity must set it to `true`, which the policy always rejects.
 */
export interface RoleEligibilityRequest {
  readonly role: ModelRole;
  readonly sourceLayer: ConfigSourceLayer;
  readonly phase: EligibilityPhase;
  readonly requestedIdentity: ExecutorIdentity;
  readonly resolvedIdentity: ExecutorIdentity;
  readonly fallbackOrdinal?: number;
  readonly retryOrdinal?: number;
  readonly priorDigest?: string | null;
  readonly policyInvokedAt: readonly EligibilityPhase[];
  readonly substitutionAllowed?: boolean;
}

function isUnknownIdentity(identity: ExecutorIdentity): boolean {
  if (identity.provider === 'unknown') return true;
  if (!identity.model || identity.model === 'unknown') return true;
  return false;
}

function isAmbiguousAlias(identity: ExecutorIdentity): boolean {
  if (!identity.alias) return false;
  const resolution = resolveExecutorAlias(identity.alias, { providerHint: identity.provider });
  if (!resolution.ok) return false;
  // Ambiguity: alias resolves to a different canonical model than the
  // resolved identity advertises. This catches caller-asserted identity.
  return resolution.canonicalModel !== identity.model;
}

const EFFORT_ORDER: Readonly<Record<string, number>> = { low: 0, medium: 1, high: 2, max: 3 };

/**
 * Effort values arrive from attestations and config as plain strings at
 * runtime, so the {@link ModelEffort} type is not a guarantee. A value off the
 * canonical scale cannot be compared, and an incomparable effort must fail
 * closed rather than count as "no downgrade" (sinter-gap #1311).
 */
function isUnknownEffort(identity: ExecutorIdentity): boolean {
  return !Object.prototype.hasOwnProperty.call(EFFORT_ORDER, identity.effort);
}

function isEffortDowngrade(requested: ExecutorIdentity, resolved: ExecutorIdentity): boolean {
  return EFFORT_ORDER[resolved.effort] < EFFORT_ORDER[requested.effort];
}

/**
 * Decide whether a resolved role may proceed to transport. Always returns a
 * decision — never throws — so callers can route both branches through one
 * path. Rejections carry the immutable trace and typed reason.
 *
 * Invariants enforced:
 *  1. Trace integrity (phase present, digest valid, policy version current).
 *  2. Luna is never harness, regardless of source layer.
 *  3. Unknown resolved identity blocks independent-review / critical-role
 *     claims (here: blocks the transport outright).
 *  4. Alias ambiguity (caller-asserted identity) blocks transport.
 *  5. Effort downgrade blocks transport; an effort off the canonical scale
 *     blocks transport too (fail closed, #1311).
 *  6. Substitution-capable routes block transport for harness.
 */
export function decideRoleEligibility(request: RoleEligibilityRequest): RoleEligibilityDecision {
  const traceInput: RoleResolutionTraceInput = {
    policyVersion: ROLE_ELIGIBILITY_POLICY_VERSION,
    phase: request.phase,
    sourceLayer: request.sourceLayer,
    role: request.role,
    requestedIdentity: request.requestedIdentity,
    resolvedIdentity: request.resolvedIdentity,
    fallbackOrdinal: request.fallbackOrdinal ?? 0,
    retryOrdinal: request.retryOrdinal ?? 0,
    priorDigest: request.priorDigest ?? null,
    policyInvokedAt: request.policyInvokedAt,
  };
  let trace: RoleResolutionTrace;
  try {
    trace = freezeTrace(traceInput);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return reject(
      'trace-skipped-phase',
      traceInput,
      message,
    );
  }
  if (!verifyTraceDigest(trace)) {
    return reject('trace-tampered', traceInput, 'trace digest did not match contents');
  }
  if (trace.policyVersion !== ROLE_ELIGIBILITY_POLICY_VERSION) {
    return reject(
      'trace-policy-version-mismatch',
      traceInput,
      `trace policy ${trace.policyVersion} != current ${ROLE_ELIGIBILITY_POLICY_VERSION}`,
    );
  }
  if (isUnknownIdentity(request.resolvedIdentity)) {
    return reject(
      'unknown-resolved-identity',
      traceInput,
      `resolved identity ${request.resolvedIdentity.provider}/${request.resolvedIdentity.model} is unknown`,
    );
  }
  if (isAmbiguousAlias(request.resolvedIdentity)) {
    return reject(
      'identity-ambiguous',
      traceInput,
      `alias ${request.resolvedIdentity.alias} does not canonicalize to ${request.resolvedIdentity.model}`,
    );
  }
  if (request.role === 'harness') {
    if (isLunaIdentity(request.resolvedIdentity) || request.resolvedIdentity.model === LUNA_MODEL_ID) {
      return reject(
        'role-luna-harness-forbidden',
        traceInput,
        `resolved identity ${request.resolvedIdentity.model} is Luna; Luna is permanently harness-ineligible (source=${request.sourceLayer})`,
      );
    }
    if (isLunaIdentity(request.requestedIdentity) || request.requestedIdentity.model === LUNA_MODEL_ID) {
      return reject(
        'role-luna-harness-forbidden',
        traceInput,
        `requested identity ${request.requestedIdentity.model} is Luna; Luna may not be requested for the harness role (source=${request.sourceLayer})`,
      );
    }
    if (request.substitutionAllowed === true) {
      return reject(
        'substitution-allowed',
        traceInput,
        'harness routes must forbid substitution; a substitution-capable route is harness-ineligible',
      );
    }
  }
  if (isUnknownEffort(request.requestedIdentity) || isUnknownEffort(request.resolvedIdentity)) {
    return reject(
      'effort-unknown',
      traceInput,
      `effort ${String(request.requestedIdentity.effort)} -> ${String(request.resolvedIdentity.effort)} is not on the canonical scale; cannot prove no downgrade`,
    );
  }
  if (isEffortDowngrade(request.requestedIdentity, request.resolvedIdentity)) {
    return reject(
      'effort-downgraded',
      traceInput,
      `effort ${request.requestedIdentity.effort} downgraded to ${request.resolvedIdentity.effort}`,
    );
  }
  return {
    ok: true,
    trace,
    identity: request.resolvedIdentity,
  };
}

function reject(
  reason: RoleEligibilityRejectionReason,
  traceInput: RoleResolutionTraceInput,
  detail: string,
): RoleEligibilityReject {
  // For skipped-phase the freezeTrace call inside the wrapper has already
  // failed; reconstruct a best-effort trace envelope so callers still receive
  // a trace object. We never throw here.
  let trace: RoleResolutionTrace;
  try {
    trace = freezeTrace({ ...traceInput, policyInvokedAt: Array.from(new Set([...traceInput.policyInvokedAt, traceInput.phase])) });
  } catch {
    // Last-resort fallback envelope; digest is recomputed consistently.
    const fallbackInput = { ...traceInput, policyInvokedAt: [traceInput.phase] as const };
    trace = freezeTrace(fallbackInput);
  }
  return { ok: false, reason, trace, detail };
}

/**
 * Predicate form of the Luna-never-harness rule. Pure check with no trace
 * construction; useful for early filters and tests.
 */
export function isHarnessEligibleIdentity(identity: ExecutorIdentity): boolean {
  if (isLunaIdentity(identity)) return false;
  if (isUnknownIdentity(identity)) return false;
  return true;
}

/**
 * Return the canonical set of phases the policy must be invoked at for a
 * harness-bound role. Skipping any of these is a `trace-skipped-phase`
 * rejection at the next gate.
 */
export function requiredHarnessPhases(): readonly EligibilityPhase[] {
  return [
    'config-mutation',
    'provider-construction',
    'post-merged-resolution',
    'pre-primary-transport',
    'pre-fallback-transport',
    'pre-retry-transport',
    'pre-harness-client-construction',
    'pre-restart-hydration',
  ] as const;
}
