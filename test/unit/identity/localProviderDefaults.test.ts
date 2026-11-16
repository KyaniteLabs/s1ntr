import { describe, expect, it } from 'vitest';
import { resolveRoleConfig } from '../../../src/identity/roleIntegration.js';
import type { ProviderFamily } from '../../../src/identity/types.js';

// The README tells local users to pick LM Studio or Ollama, whose shipped
// default models are `local-model` and `llama3.2`. A local server names its
// models freely, so the chosen local provider must vouch for the name.

const generator = (alias: string, providerHint?: ProviderFamily) => resolveRoleConfig({
  role: 'generator',
  sourceLayer: 'default-inheritance',
  phase: 'pre-primary-transport',
  requestedModelAlias: alias,
  requestedEffort: 'high',
  policyInvokedAt: ['config-mutation', 'pre-primary-transport'],
  providerHint,
});

describe('local provider defaults', () => {
  it('accepts the LM Studio default model', () => {
    expect(generator('local-model', 'lmstudio').allowed).toBe(true);
  });

  it('accepts the Ollama default model', () => {
    expect(generator('llama3.2', 'ollama').allowed).toBe(true);
  });

  it('still fails closed for an unrecognized name without a local provider', () => {
    expect(generator('local-model').allowed).toBe(false);
    expect(generator('local-model', 'openai').allowed).toBe(false);
  });
});
