import { describe, it, expect } from 'vitest';
import {
  ROLE_ELIGIBILITY_POLICY_VERSION,
  decideRoleEligibility,
  isHarnessEligibleIdentity,
  requiredHarnessPhases,
} from '../../../src/identity/roleEligibilityPolicy.js';
import { CURRENT_LUNA_MODEL_ID, LUNA_MODEL_ID } from '../../../src/identity/canonicalAlias.js';
import type {
  ConfigSourceLayer,
  EligibilityPhase,
  ExecutorIdentity,
  ModelRole,
} from '../../../src/identity/types.js';

const sol: ExecutorIdentity = { provider: 'anthropic', model: 'claude-opus-4-1', effort: 'high' };
const luna: ExecutorIdentity = { provider: 'openai', model: LUNA_MODEL_ID, effort: 'max' };
const lunaViaAlias: ExecutorIdentity = {
  provider: 'openai',
  model: LUNA_MODEL_ID,
  effort: 'max',
  alias: 'openai/gpt-5.6-luna',
};

function request(input: {
  role: ModelRole;
  requested: ExecutorIdentity;
  resolved?: ExecutorIdentity;
  sourceLayer?: ConfigSourceLayer;
  phase?: EligibilityPhase;
  substitutionAllowed?: boolean;
  policyInvokedAt?: readonly EligibilityPhase[];
}) {
  return {
    role: input.role,
    sourceLayer: input.sourceLayer ?? 'project-config',
    phase: input.phase ?? 'pre-primary-transport',
    requestedIdentity: input.requested,
    resolvedIdentity: input.resolved ?? input.requested,
    fallbackOrdinal: 0,
    retryOrdinal: 0,
    priorDigest: null,
    policyInvokedAt: input.policyInvokedAt ?? ['config-mutation', 'pre-primary-transport'],
    substitutionAllowed: input.substitutionAllowed,
  };
}

describe('RoleEligibilityPolicy — Luna never harness', () => {
  it('Luna is allowed in generator/evaluator/studio fixtures', () => {
    for (const role of ['generator', 'evaluator', 'studio'] as ModelRole[]) {
      const decision = decideRoleEligibility(request({ role, requested: luna }));
      expect(decision.ok, `${role} should be allowed`).toBe(true);
    }
  });

  it('Luna is forbidden for harness via requested identity (direct harness config)', () => {
    const decision = decideRoleEligibility(request({ role: 'harness', requested: luna }));
    expect(decision.ok).toBe(false);
    if (!decision.ok) {
      expect(decision.reason).toBe('role-luna-harness-forbidden');
    }
  });

  it('current Luna is a generator seat but never a harness seat', () => {
    const current: ExecutorIdentity = { provider: 'openai', model: CURRENT_LUNA_MODEL_ID, effort: 'high' };
    expect(decideRoleEligibility(request({ role: 'generator', requested: current })).ok).toBe(true);
    const harness = decideRoleEligibility(request({ role: 'harness', requested: current }));
    expect(harness.ok).toBe(false);
    if (!harness.ok) expect(harness.reason).toBe('role-luna-harness-forbidden');
  });

  it('Luna is forbidden for harness via resolved identity (request Sol, resolve Luna)', () => {
    const decision = decideRoleEligibility(
      request({ role: 'harness', requested: sol, resolved: luna }),
    );
    expect(decision.ok).toBe(false);
    if (!decision.ok) {
      expect(decision.reason).toBe('role-luna-harness-forbidden');
    }
  });

  it('Luna is forbidden for harness through provider-qualified alias', () => {
    const decision = decideRoleEligibility(
      request({ role: 'harness', requested: lunaViaAlias }),
    );
    expect(decision.ok).toBe(false);
    if (!decision.ok) {
      expect(decision.reason).toBe('role-luna-harness-forbidden');
    }
  });

  it('harness with substitutionAllowed=true is rejected (substitution-capable route is harness-ineligible)', () => {
    const decision = decideRoleEligibility(
      request({ role: 'harness', requested: sol, substitutionAllowed: true }),
    );
    expect(decision.ok).toBe(false);
    if (!decision.ok) {
      expect(decision.reason).toBe('substitution-allowed');
    }
  });

  it('rejects every documented source-layer path when it resolves Luna into harness', () => {
    const layers: ConfigSourceLayer[] = [
      'project-config',
      'user-config',
      'role-specific-env-override',
      'generic-env-override',
      'default-inheritance',
      'generator-to-harness-inheritance',
      'fallbacks-harness',
      'internal-retry',
      'persisted-restart-hydration',
      'explicit-harness-client',
      'legacy-config-conversion',
    ];
    for (const sourceLayer of layers) {
      const decision = decideRoleEligibility(
        request({ role: 'harness', requested: luna, sourceLayer }),
      );
      expect(decision.ok, `layer ${sourceLayer} should reject`).toBe(false);
      if (!decision.ok) {
        expect(decision.reason).toBe('role-luna-harness-forbidden');
        expect(decision.trace.digest).toMatch(/^[a-f0-9]{64}$/);
      }
    }
  });

  it('unknown resolved identity blocks the transport (critical-role / independent-review gate)', () => {
    const unknown: ExecutorIdentity = { provider: 'unknown', model: 'mystery', effort: 'high' };
    const decision = decideRoleEligibility(request({ role: 'generator', requested: unknown }));
    expect(decision.ok).toBe(false);
    if (!decision.ok) {
      expect(decision.reason).toBe('unknown-resolved-identity');
    }
  });

  it('caller-asserted identity via mismatched alias fails closed (ambiguity)', () => {
    const asserted: ExecutorIdentity = {
      provider: 'openai',
      model: 'gpt-5.1', // canonical
      effort: 'high',
      alias: 'openai/gpt-5.6-luna', // alias resolves to Luna, not gpt-5.1
    };
    const decision = decideRoleEligibility(request({ role: 'generator', requested: asserted }));
    expect(decision.ok).toBe(false);
    if (!decision.ok) {
      expect(decision.reason).toBe('identity-ambiguous');
    }
  });

  it('effort downgrade from requested to resolved is rejected', () => {
    const resolvedLower: ExecutorIdentity = { ...sol, effort: 'medium' };
    const decision = decideRoleEligibility(
      request({ role: 'harness', requested: sol, resolved: resolvedLower }),
    );
    expect(decision.ok).toBe(false);
    if (!decision.ok) {
      expect(decision.reason).toBe('effort-downgraded');
    }
  });

  it('unrecognized resolved effort fails closed instead of counting as no downgrade (#1311)', () => {
    const resolvedOdd = { ...sol, effort: 'turbo' } as unknown as ExecutorIdentity;
    const decision = decideRoleEligibility(
      request({ role: 'harness', requested: sol, resolved: resolvedOdd }),
    );
    expect(decision.ok).toBe(false);
    if (!decision.ok) {
      expect(decision.reason).toBe('effort-unknown');
    }
  });

  it('unrecognized requested effort fails closed even when resolved matches it (#1311)', () => {
    const odd = { ...sol, effort: 'xhigh' } as unknown as ExecutorIdentity;
    const decision = decideRoleEligibility(request({ role: 'harness', requested: odd, resolved: odd }));
    expect(decision.ok).toBe(false);
    if (!decision.ok) {
      expect(decision.reason).toBe('effort-unknown');
    }
  });

  it('missing effort fails closed (#1311)', () => {
    const noEffort = { provider: sol.provider, model: sol.model } as unknown as ExecutorIdentity;
    const decision = decideRoleEligibility(request({ role: 'harness', requested: sol, resolved: noEffort }));
    expect(decision.ok).toBe(false);
    if (!decision.ok) {
      expect(decision.reason).toBe('effort-unknown');
    }
  });

  it('effort upgrade on the canonical scale is still allowed', () => {
    const upgraded: ExecutorIdentity = { ...sol, effort: 'max' };
    const decision = decideRoleEligibility(request({ role: 'harness', requested: sol, resolved: upgraded }));
    expect(decision.ok).toBe(true);
  });

  it('skipped phase fails closed', () => {
    const decision = decideRoleEligibility({
      role: 'harness',
      sourceLayer: 'project-config',
      phase: 'pre-primary-transport',
      requestedIdentity: sol,
      resolvedIdentity: sol,
      fallbackOrdinal: 0,
      retryOrdinal: 0,
      priorDigest: null,
      // current phase missing from policyInvokedAt
      policyInvokedAt: ['config-mutation'],
    });
    expect(decision.ok).toBe(false);
    if (!decision.ok) {
      expect(decision.reason).toBe('trace-skipped-phase');
    }
  });

  it('policy decision stamps current policy version into the trace', () => {
    const decision = decideRoleEligibility(request({ role: 'harness', requested: sol }));
    expect(decision.ok).toBe(true);
    if (decision.ok) {
      expect(decision.trace.policyVersion).toBe(ROLE_ELIGIBILITY_POLICY_VERSION);
    }
  });

  it('requiredHarnessPhases enumerates every enforced phase', () => {
    expect(requiredHarnessPhases()).toContain('config-mutation');
    expect(requiredHarnessPhases()).toContain('pre-harness-client-construction');
    expect(requiredHarnessPhases()).toContain('pre-restart-hydration');
    expect(requiredHarnessPhases()).toContain('pre-fallback-transport');
    expect(requiredHarnessPhases()).toContain('pre-retry-transport');
  });

  it('isHarnessEligibleIdentity predicate agrees with the full policy for Luna', () => {
    expect(isHarnessEligibleIdentity(sol)).toBe(true);
    expect(isHarnessEligibleIdentity(luna)).toBe(false);
  });
});
