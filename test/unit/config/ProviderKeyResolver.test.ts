import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  apiKeyEnvNamesForEndpoint,
  readProviderEnvKey,
  selectApiKeyForEndpoint,
} from '../../../src/config/ProviderKeyResolver.js';

describe('ProviderKeyResolver', () => {
  afterEach(() => { vi.unstubAllEnvs(); });

  it('maps well-known endpoints to their dedicated key env names', () => {
    expect(apiKeyEnvNamesForEndpoint('https://ollama.com/api')).toEqual(['OLLAMA_API_KEY']);
    expect(apiKeyEnvNamesForEndpoint('https://api.x.ai/v1')).toEqual(['XAI_API_KEY', 'GROK_API_KEY']);
    expect(apiKeyEnvNamesForEndpoint('https://api.deepinfra.com/v1/openai')).toEqual(['DEEPINFRA_API_KEY']);
  });

  it('readProviderEnvKey prefers the bare key, then the LIMINAL_ prefixed one', () => {
    vi.stubEnv('TEST_PROVIDER_KEY_X', '');
    vi.stubEnv('LIMINAL_TEST_PROVIDER_KEY_X', 'prefixed');
    expect(readProviderEnvKey('TEST_PROVIDER_KEY_X')).toBe('prefixed');
    vi.stubEnv('TEST_PROVIDER_KEY_X', 'bare');
    expect(readProviderEnvKey('TEST_PROVIDER_KEY_X')).toBe('bare');
  });

  it('readProviderEnvKey returns undefined when neither form is set', () => {
    vi.stubEnv('TEST_PROVIDER_KEY_Y', undefined);
    vi.stubEnv('LIMINAL_TEST_PROVIDER_KEY_Y', undefined);
    expect(readProviderEnvKey('TEST_PROVIDER_KEY_Y')).toBeUndefined();
  });

  it('selects the endpoint-specific key from the environment', () => {
    vi.stubEnv('DEEPINFRA_API_KEY', 'di-secret');
    expect(selectApiKeyForEndpoint('https://api.deepinfra.com/v1/openai', 'deepseek-ai/deepseek-v4-flash-0731')).toBe('di-secret');
  });

  it('returns undefined when no endpoint or fallback key is present', () => {
    vi.stubEnv('XAI_API_KEY', '');
    vi.stubEnv('GROK_API_KEY', '');
    vi.stubEnv('LIMINAL_XAI_API_KEY', '');
    vi.stubEnv('LIMINAL_GROK_API_KEY', '');
    vi.stubEnv('LLM_API_KEY', '');
    expect(selectApiKeyForEndpoint('https://api.x.ai/v1', 'grok')).toBeUndefined();
  });

  it('falls back to a caller-supplied key bound to the same endpoint', () => {
    for (const name of ['XAI_API_KEY', 'GROK_API_KEY']) {
      for (const prefix of ['', 'SINTER_', 'LIMINAL_']) vi.stubEnv(prefix + name, '');
    }
    const endpoint = 'https://api.x.ai/v1';
    const fallbackKeys = ['TEST_GENERIC_API_KEY'];
    vi.stubEnv('TEST_GENERIC_API_KEY', 'generic-secret');
    expect(selectApiKeyForEndpoint(endpoint, undefined, fallbackKeys)).toBeUndefined();
    vi.stubEnv('TEST_GENERIC_BASE_URL', 'https://elsewhere.invalid/v1');
    expect(selectApiKeyForEndpoint(endpoint, undefined, fallbackKeys)).toBeUndefined();
    vi.stubEnv('TEST_GENERIC_BASE_URL', endpoint);
    expect(selectApiKeyForEndpoint(endpoint, undefined, fallbackKeys)).toBe('generic-secret');
  });
});
