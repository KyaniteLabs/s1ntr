import { describe, it, expect } from 'vitest';
import { resolveRoleConfig } from '../../../src/identity/roleIntegration.js';
import type { ConfigSourceLayer, EligibilityPhase } from '../../../src/identity/types.js';

function input(input: {
  role: 'generator' | 'evaluator' | 'harness' | 'studio';
  alias: string;
  sourceLayer?: ConfigSourceLayer;
  phase?: EligibilityPhase;
  resolvedAlias?: string;
}) {
  return {
    role: input.role,
    sourceLayer: input.sourceLayer ?? 'project-config',
    phase: input.phase ?? 'pre-primary-transport',
    requestedModelAlias: input.alias,
    requestedEffort: 'high' as const,
    resolvedModelAlias: input.resolvedAlias,
    policyInvokedAt: ['config-mutation', 'pre-primary-transport'],
  };
}

describe('roleIntegration adapter', () => {
  it('allows the exact verified Dots generator through pre-transport identity validation', () => {
    expect(resolveRoleConfig(input({ role: 'generator',
      alias: 'dots-studio/dots-3-note-preview:free' })).allowed).toBe(true);
  });

  it('allows Sol harness through the existing project-config path', () => {
    const result = resolveRoleConfig(input({ role: 'harness', alias: 'anthropic/claude-opus-4-1' }));
    expect(result.allowed).toBe(true);
  });

  it('rejects Luna harness through every documented source layer', () => {
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
      const result = resolveRoleConfig(input({ role: 'harness', alias: 'gpt-5.6-luna', sourceLayer }));
      expect(result.allowed, `${sourceLayer} should reject`).toBe(false);
      if (!result.allowed && !result.decision.ok) {
        expect(result.decision.reason).toBe('role-luna-harness-forbidden');
      }
    }
  });

  it('request Sol, execute Luna — resolves and is allowed for generator', () => {
    const result = resolveRoleConfig(
      input({ role: 'generator', alias: 'anthropic/claude-opus-4-1', resolvedAlias: 'gpt-5.6-luna' }),
    );
    expect(result.allowed).toBe(true);
    if (result.allowed && result.decision.ok) {
      expect(result.decision.trace.requestedIdentity.model).toBe('claude-opus-4-1');
      expect(result.decision.trace.resolvedIdentity.model).toBe('gpt-5.6-luna');
    }
  });

  it('unknown alias fails closed (no provider request)', () => {
    const result = resolveRoleConfig(input({ role: 'harness', alias: 'nonsense/garbage' }));
    expect(result.allowed).toBe(false);
  });

  it('Luna is allowed as generator/evaluator/studio through the adapter', () => {
    for (const role of ['generator', 'evaluator', 'studio'] as const) {
      const result = resolveRoleConfig(input({ role, alias: 'gpt-5.6-luna' }));
      expect(result.allowed, `${role} should be allowed`).toBe(true);
    }
  });
});
