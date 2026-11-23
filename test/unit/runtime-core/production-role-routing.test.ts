import { afterEach, describe, expect, it, vi } from 'vitest';
import { LLMClient } from '../../../src/llm/LLMClient.js';
import { spineExplicitClient } from '../../../src/runtime-core/ProductionLiminalRuntime.js';

describe('production clients preserve resolved role routing', () => {
  afterEach(() => vi.restoreAllMocks());

  it.each(['generator', 'evaluator'] as const)('uses the resolved %s endpoint, key and limits', role => {
    const resolved = { provider: 'openai' as const, baseUrl: 'https://rotated.invalid/v1',
      model: 'rotated-model', apiKey: 'test-rotated-key', temperature: 0.4,
      maxTokens: 8192, timeout: 12345, thinking: { enabled: false }, streaming: false };
    vi.spyOn(LLMClient, 'getResolvedRoleConfig').mockImplementation(requested =>
      requested === role ? resolved : null);
    const config = spineExplicitClient(role).getConfig();
    expect(config).toMatchObject({ role, provider: resolved.provider,
      baseUrl: resolved.baseUrl, model: resolved.model, apiKey: resolved.apiKey,
      timeout: resolved.timeout, maxTokens: resolved.maxTokens });
  });

  it('does not restore a stale file key when the resolved endpoint has no key', () => {
    const resolved = { provider: 'openai' as const, baseUrl: 'https://uncredentialed.invalid/v1',
      model: 'new-model', temperature: 0.4, maxTokens: 8192, timeout: 12345,
      thinking: { enabled: false }, streaming: false };
    vi.spyOn(LLMClient, 'getResolvedRoleConfig').mockReturnValue(resolved);
    const config = spineExplicitClient('generator').getConfig();
    expect(config.baseUrl).toBe(resolved.baseUrl);
    expect(config.apiKey ?? '').toBe('');
  });
});
