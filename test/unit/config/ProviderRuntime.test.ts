import { describe, expect, it } from 'vitest';
import {
  PROVIDER_DEFAULTS,
  apiKeyEnvNamesForEndpoint,
  apiKeyEnvNamesForProvider,
  detectProviderAdapter,
  detectProviderLabel,
  detectRoleProviderType,
  detectRuntimeProviderFromUrl,
  inferProviderVisionSupport,
  normalizeProviderBaseUrl,
  resolveProviderAlias,
  resolveProviderRuntime,
  selectRuntimeApiKey,
} from '../../../src/config/ProviderRuntime.js';

describe('ProviderRuntime', () => {
  it('centralizes provider aliases and defaults used by model switching', () => {
    expect(resolveProviderAlias('openai')).toBe('openai');
    expect(resolveProviderAlias('gpt')).toBe('openai');
    expect(resolveProviderAlias('z')).toBe('glm');
    expect(PROVIDER_DEFAULTS.glm).toMatchObject({
      baseUrl: 'https://api.z.ai/api/anthropic',
      model: 'GLM-5v-turbo',
      requiresKey: true,
    });
  });

  it('normalizes deprecated provider endpoints without changing supported custom endpoints', () => {
    expect(normalizeProviderBaseUrl('glm', 'https://api.z.ai/api/coding/paas')).toBe('https://api.z.ai/api/anthropic');
    expect(normalizeProviderBaseUrl('minimax', 'https://api.minimax.io/v1')).toBe('https://api.minimax.io/anthropic');
    expect(normalizeProviderBaseUrl('glm', 'https://custom.example/v1')).toBe('https://custom.example/v1');
  });

  it('detects status labels separately from provider adapters', () => {
    expect(detectProviderLabel('https://api.z.ai/api/anthropic', 'glm-5.1')).toBe('glm');
    expect(detectProviderLabel('http://127.0.0.1:11434', 'llama3.2')).toBe('ollama');
    // Cliproxy :8317 must not be mislabeled lmstudio (F1 residual / wave-1)
    expect(detectProviderLabel('http://localhost:8317/v1', 'gemini-3.1-pro-low')).toBe('custom');
    expect(detectProviderLabel('http://127.0.0.1:1234/v1', 'local-model')).toBe('lmstudio');
    expect(detectProviderAdapter({ baseUrl: 'https://api.z.ai/api/anthropic', model: 'glm-5.1' })).toBe('anthropic');
    expect(detectRoleProviderType('https://api.z.ai/api/anthropic', 'glm-5.1')).toBe('anthropic');
  });

  it('keeps API key env order provider-specific', () => {
    expect(apiKeyEnvNamesForProvider('glm')).toEqual(['GLM_API_KEY', 'Z_AI_API_KEY', 'ANTHROPIC_AUTH_TOKEN']);
    expect(apiKeyEnvNamesForProvider('moonshot')).toEqual(['MOONSHOT_API_KEY', 'KIMI_API_KEY']);
    expect(apiKeyEnvNamesForProvider('custom')).toEqual(['OPENAI_API_KEY']);
    expect(apiKeyEnvNamesForProvider('lmstudio')).toEqual([]);
    expect(apiKeyEnvNamesForEndpoint('https://api.anthropic.com/v1', 'claude-sonnet')).toEqual(['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN']);
    expect(apiKeyEnvNamesForEndpoint('https://generativelanguage.googleapis.com/v1beta', 'gemini-2.5-flash')).toEqual(['GOOGLE_API_KEY', 'GEMINI_API_KEY']);
    expect(apiKeyEnvNamesForEndpoint('https://api.x.ai/v1', 'grok-4.5')).toEqual(['XAI_API_KEY', 'GROK_API_KEY']);

  });

  it('accepts the canonical Pushing Dispatch Z.ai credential name', () => {
    expect(selectRuntimeApiKey({
      provider: 'glm',
      baseUrl: 'https://api.z.ai/api/anthropic',
      model: 'glm-5.2',
      env: { Z_AI_API_KEY: 'zai-dispatch-key' },
    })).toBe('zai-dispatch-key');
  });

  it('keeps KIMI_API_KEY as a Moonshot compatibility fallback', () => {
    expect(selectRuntimeApiKey({
      provider: 'moonshot',
      baseUrl: 'https://api.moonshot.ai/v1',
      env: { KIMI_API_KEY: 'sk-kimi-legacy' },
    })).toBe('sk-kimi-legacy');

    expect(selectRuntimeApiKey({
      provider: 'moonshot',
      baseUrl: 'https://api.moonshot.ai/v1',
      env: {
        MOONSHOT_API_KEY: 'sk-moonshot-primary',
        KIMI_API_KEY: 'sk-kimi-legacy',
      },
    })).toBe('sk-moonshot-primary');
  });

  it('prefers endpoint-specific keys over the custom provider OpenAI fallback', () => {
    // A custom endpoint pointing at Anthropic must never send the OpenAI key.
    expect(selectRuntimeApiKey({
      provider: 'custom',
      baseUrl: 'https://api.anthropic.com/v1',
      model: 'claude-sonnet-4-6',
      env: {
        OPENAI_API_KEY: 'sk-openai-generic',
        ANTHROPIC_API_KEY: 'sk-ant-endpoint',
      },
    })).toBe('sk-ant-endpoint');

    expect(selectRuntimeApiKey({
      provider: 'custom',
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
      model: 'gemini-2.5-flash',
      env: {
        OPENAI_API_KEY: 'sk-openai-generic',
        GOOGLE_API_KEY: 'g-endpoint',
      },
    })).toBe('g-endpoint');

    // Plain OpenAI-compatible custom endpoints keep the OPENAI_API_KEY fallback.
    expect(selectRuntimeApiKey({
      provider: 'custom',
      baseUrl: 'http://localhost:8000/v1',
      env: { OPENAI_API_KEY: 'sk-openai-generic' },
    })).toBe('sk-openai-generic');
  });

  it('reports GLM 5V as vision-capable but ordinary GLM as text-only', () => {
    expect(inferProviderVisionSupport('glm', 'GLM-5v-turbo')).toBe('yes');
    expect(inferProviderVisionSupport('glm', 'glm-5.1')).toBe('no');
  });

  it('resolves runtime selection with usable current keys and status labels', () => {
    const runtime = resolveProviderRuntime({
      provider: 'openai',
      model: 'gpt-5.4-mini',
      configuredApiKey: 'YOUR_OPENAI_API_KEY_HERE',
      current: {
        provider: 'openai',
        apiKey: 'sk-live',
      },
      env: {},
    });

    expect(runtime).toMatchObject({
      provider: 'openai',
      statusProvider: 'openai',
      adapter: 'openai',
      label: 'OpenAI',
      apiKey: 'sk-live',
      model: 'gpt-5.4-mini',
      apiStyle: 'openai',
    });
  });

  it('promotes Anthropic to a first-class menu key while Google stays adapter-only', () => {
    // Anthropic is the product's default provider — now a first-class menu entry.
    expect(detectRuntimeProviderFromUrl('https://api.anthropic.com/v1')).toBe('anthropic');
    // Google has no menu entry; it routes via the wire-format adapter layer only.
    expect(detectRuntimeProviderFromUrl('https://generativelanguage.googleapis.com/v1beta')).toBe('custom');

    // Wire-format layer: detectProviderAdapter routes both to dedicated adapters.
    expect(detectProviderAdapter({ baseUrl: 'https://api.anthropic.com/v1', model: 'claude-sonnet-4-6' })).toBe('anthropic');
    expect(detectProviderAdapter({ baseUrl: 'https://generativelanguage.googleapis.com/v1beta', model: 'gemini-2.5-flash' })).toBe('google');

    // A bare custom selection at the Anthropic endpoint auto-promotes to the
    // anthropic provider via URL detection and reads ANTHROPIC_API_KEY.
    const anthropic = resolveProviderRuntime({
      provider: 'custom',
      configuredBaseUrl: 'https://api.anthropic.com/v1',
      model: 'claude-sonnet-4-6',
      env: { ANTHROPIC_API_KEY: 'sk-ant-live' },
    });
    expect(anthropic).toMatchObject({
      statusProvider: 'anthropic',
      adapter: 'anthropic',
      apiStyle: 'anthropic',
      apiKey: 'sk-ant-live',
    });

    const google = resolveProviderRuntime({
      provider: 'custom',
      configuredBaseUrl: 'https://generativelanguage.googleapis.com/v1beta',
      model: 'gemini-2.5-flash',
      env: { GEMINI_API_KEY: 'gm-live' },
    });
    expect(google).toMatchObject({
      statusProvider: 'custom',
      adapter: 'google',
      apiKey: 'gm-live',
    });
  });

  it('keeps unknown custom endpoints custom while reporting official OpenAI as OpenAI', () => {
    const custom = resolveProviderRuntime({ provider: 'custom', env: {} });
    const openaiCompatible = resolveProviderRuntime({
      provider: 'custom',
      configuredBaseUrl: 'https://api.openai.com/v1',
      env: {},
    });

    expect(custom.statusProvider).toBe('custom');
    expect(openaiCompatible.statusProvider).toBe('openai');
  });
});
