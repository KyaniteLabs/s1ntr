/**
 * Role-config integration adapter for W8C-03 (#716).
 *
 * Existing call sites that resolve a {@link ModelRole} from env vars, project
 * config, user config, fallbacks, retry, restart, or legacy conversion feed
 * through this adapter before constructing a provider or transporting a
 * request. The adapter normalizes the raw role-config inputs into a
 * {@link RoleEligibilityRequest} and returns the policy decision.
 *
 * This is the integration seam W8C-04's tool-loop work and W8C-02's coordinator
 * will call. It is intentionally thin: no business logic lives here, only
 * field mapping, so the policy remains the single source of truth.
 *
 * Spec: W8C-03 product change — "Invoke that policy before accepting any role
 * config mutation or constructing a provider ... Rejection emits the immutable
 * trace and typed blocker but no provider request or harness evidence."
 */

import { buildExecutorIdentity } from './canonicalAlias.js';
import { decideRoleEligibility, type RoleEligibilityDecision } from './roleEligibilityPolicy.js';
import type {
  ConfigSourceLayer,
  EligibilityPhase,
  ModelEffort,
  ModelRole,
} from './types.js';

/**
 * Raw inputs collected from a role-config source. The caller identifies which
 * layer and phase the resolution is happening at; this adapter handles the
 * identity normalization.
 */
export interface RoleConfigIntegrationInput {
  readonly role: ModelRole;
  readonly sourceLayer: ConfigSourceLayer;
  readonly phase: EligibilityPhase;
  readonly requestedModelAlias: string;
  readonly requestedEffort: ModelEffort;
  readonly resolvedModelAlias?: string;
  readonly resolvedEffort?: ModelEffort;
  readonly fallbackOrdinal?: number;
  readonly retryOrdinal?: number;
  readonly priorTraceDigest?: string | null;
  readonly policyInvokedAt: readonly EligibilityPhase[];
  readonly substitutionAllowed?: boolean;
  readonly providerHint?: import('./types.js').ProviderFamily;
}

/**
 * Outcome of a role-config integration check. Callers must inspect `decision`
 * and:
 *
 *   - on `ok: true`: proceed with provider construction / transport, persisting
 *     `decision.trace` alongside the request
 *   - on `ok: false`: stop before network, emit the trace + typed reason to
 *     the evidence sink, and DO NOT emit harness evidence
 *
 * Convenience property {@link allowed} is provided for terse call-site guards.
 */
export interface RoleConfigIntegrationResult {
  readonly decision: RoleEligibilityDecision;
  readonly allowed: boolean;
}

/**
 * Resolve a role-config input through the W8C-03 authority boundary. Returns
 * the policy decision plus a convenience boolean.
 *
 *     const { allowed, decision } = resolveRoleConfig(integrationInput);
 *     if (!allowed) {
 *       // emit decision.trace + decision.reason; no provider request, no
 *       // harness evidence; transport spy observes zero calls
 *       return;
 *     }
 *     // proceed with provider construction
 */
export function resolveRoleConfig(input: RoleConfigIntegrationInput): RoleConfigIntegrationResult {
  const requested = buildExecutorIdentity(input.requestedModelAlias, input.requestedEffort, {
    providerHint: input.providerHint,
  });
  if (!requested) {
    // Unknown alias — synthesize an unknown identity so the policy fails closed
    // with `unknown-resolved-identity` rather than crashing.
    const decision = decideRoleEligibility({
      role: input.role,
      sourceLayer: input.sourceLayer,
      phase: input.phase,
      requestedIdentity: {
        provider: 'unknown',
        model: input.requestedModelAlias,
        effort: input.requestedEffort,
      },
      resolvedIdentity: {
        provider: 'unknown',
        model: input.requestedModelAlias,
        effort: input.requestedEffort,
      },
      fallbackOrdinal: input.fallbackOrdinal,
      retryOrdinal: input.retryOrdinal,
      priorDigest: input.priorTraceDigest,
      policyInvokedAt: input.policyInvokedAt,
      substitutionAllowed: input.substitutionAllowed,
    });
    return { decision, allowed: false };
  }
  const resolvedAlias = input.resolvedModelAlias ?? input.requestedModelAlias;
  const resolvedEffort = input.resolvedEffort ?? input.requestedEffort;
  const resolved = buildExecutorIdentity(resolvedAlias, resolvedEffort, {
    providerHint: input.providerHint,
  }) ?? {
    ...requested,
    effort: resolvedEffort,
    alias: resolvedAlias,
  };
  const decision = decideRoleEligibility({
    role: input.role,
    sourceLayer: input.sourceLayer,
    phase: input.phase,
    requestedIdentity: requested,
    resolvedIdentity: resolved,
    fallbackOrdinal: input.fallbackOrdinal,
    retryOrdinal: input.retryOrdinal,
    priorDigest: input.priorTraceDigest,
    policyInvokedAt: input.policyInvokedAt,
    substitutionAllowed: input.substitutionAllowed,
  });
  return { decision, allowed: decision.ok };
}
