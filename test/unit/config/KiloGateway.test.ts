import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  detectProviderAdapter,
  detectProviderLabel,
  apiKeyEnvNamesForEndpoint,
  PROVIDER_DEFAULTS,
  PROVIDER_ALIASES,
} from '../../../src/config/ProviderRuntime.js';
import {
  KILO_GATEWAY_BASE_URL,
  KILO_SEAT_MODELS,
  KILO_SEAT_FALLBACKS,
  MINIMAX_REPAIR_LANE,
  MINIMAX_EVALUATOR_SEAT,
  OLLAMA_CLOUD_BASE_URL,
  CODEX_PROXY_HARNESS_SEAT,
  CODEX_PROXY_GENERATOR_SEAT,
  CODEX_PROXY_EVALUATOR_SEAT,
  CODEX_PROXY_FALLBACK_SEAT,
  DEFAULT_CODEX_PROXY_BASE_URL,
  isKiloGatewayUrl,
  isOllamaCloudUrl,
  isCodexProxyUrl,
  getCodexProxyBaseUrl,
  getCodexProxyApiKey,
  getCodexProxyApiKeyFromEnv,
} from '../../../src/config/KiloGateway.js';
import { loadRoleConfig } from '../../../src/config/RoleConfig.js';
import { CapabilityRegistry } from '../../../src/llm/CapabilityRegistry.js';
import { createProvider } from '../../../src/llm/ProviderFactory.js';
import { KiloGatewayProvider } from '../../../src/llm/providers/KiloGatewayProvider.js';
import { OpenAIProvider } from '../../../src/llm/providers/OpenAIProvider.js';
import { LLMClient } from '../../../src/llm/LLMClient.js';
import type { BaseProvider } from '../../../src/llm/providers/BaseProvider.js';

const ENV_KEYS = [
  'KILO_API_KEY', 'GLM_API_KEY', 'MINIMAX_API_KEY', 'OLLAMA_API_KEY',
  'CODEX_PROXY_BASE_URL', 'CODEX_PROXY_API_KEY',
  'SINTER_CODEX_PROXY_BASE_URL', 'LIMINAL_CODEX_PROXY_BASE_URL',
  'SINTER_CODEX_PROXY_API_KEY', 'LIMINAL_CODEX_PROXY_API_KEY',
  'SINTER_CONFIG_PATH', 'LIMINAL_CONFIG_PATH',
  'SINTER_LLM_BASE_URL', 'LIMINAL_LLM_BASE_URL', 'SINTER_LLM_MODEL', 'LIMINAL_LLM_MODEL',
  'SINTER_LLM_PROVIDER', 'LIMINAL_LLM_PROVIDER', 'SINTER_LLM_API_KEY', 'LIMINAL_LLM_API_KEY',
  'SINTER_EVALUATOR_BASE_URL', 'LIMINAL_EVALUATOR_BASE_URL',
  'SINTER_EVALUATOR_MODEL', 'LIMINAL_EVALUATOR_MODEL',
  'SINTER_EVALUATOR_API_KEY', 'LIMINAL_EVALUATOR_API_KEY',
  'SINTER_HARNESS_BASE_URL', 'LIMINAL_HARNESS_BASE_URL',
  'SINTER_HARNESS_MODEL', 'LIMINAL_HARNESS_MODEL',
  'SINTER_HARNESS_API_KEY', 'LIMINAL_HARNESS_API_KEY',
  'SINTER_STUDIO_BASE_URL', 'LIMINAL_STUDIO_BASE_URL',
  'SINTER_STUDIO_MODEL', 'LIMINAL_STUDIO_MODEL',
  'SINTER_STUDIO_API_KEY', 'LIMINAL_STUDIO_API_KEY',
];

let savedEnv: Record<string, string | undefined> = {};
let configDir: string;
let projectDir: string;

beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map(k => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
  configDir = mkdtempSync(join(tmpdir(), 'kilo-cfg-'));
  projectDir = mkdtempSync(join(tmpdir(), 'kilo-proj-'));
  LLMClient.clearGlobalCache();
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  LLMClient.clearGlobalCache();
});

function writeRoleConfig(config: unknown): void {
  const configPath = join(configDir, 'config.json');
  writeFileSync(configPath, JSON.stringify(config));
  process.env.SINTER_CONFIG_PATH = configPath;
}

describe('Kilo gateway detection', () => {
  it('detects the kilo adapter from the gateway base URL', () => {
    expect(detectProviderAdapter({ baseUrl: KILO_GATEWAY_BASE_URL, model: 'anthropic/claude-opus-5' })).toBe('kilo');
    expect(detectProviderLabel(KILO_GATEWAY_BASE_URL)).toBe('kilo');
    expect(isKiloGatewayUrl(KILO_GATEWAY_BASE_URL)).toBe(true);
  });

  it('resolves KILO_API_KEY as the endpoint key env name', () => {
    expect(apiKeyEnvNamesForEndpoint(KILO_GATEWAY_BASE_URL)).toContain('KILO_API_KEY');
  });

  it('resolves MINIMAX_API_KEY for the repair-lane endpoint only', () => {
    expect(apiKeyEnvNamesForEndpoint(MINIMAX_REPAIR_LANE.baseUrl, MINIMAX_REPAIR_LANE.model)).toContain('MINIMAX_API_KEY');
    expect(detectProviderAdapter({ baseUrl: MINIMAX_REPAIR_LANE.baseUrl, model: MINIMAX_REPAIR_LANE.model })).toBe('minimax');
    // Deprecated alias still points at the repair lane (not an evaluator seat).
    expect(MINIMAX_EVALUATOR_SEAT).toEqual(MINIMAX_REPAIR_LANE);
  });

  it('registers the kilo provider defaults and alias (Opus 5 reserved default)', () => {
    expect(PROVIDER_DEFAULTS.kilo.baseUrl).toBe(KILO_GATEWAY_BASE_URL);
    expect(PROVIDER_DEFAULTS.kilo.model).toBe('anthropic/claude-opus-5');
    expect(PROVIDER_DEFAULTS.kilo.requiresKey).toBe(true);
    expect(PROVIDER_ALIASES.kilo).toBe('kilo');
  });

  it('createProvider builds a KiloGatewayProvider for the gateway URL', () => {
    const provider = createProvider({
      baseUrl: KILO_GATEWAY_BASE_URL,
      model: 'anthropic/claude-opus-5',
      apiKey: 'test-key',
    });
    expect(provider).toBeInstanceOf(KiloGatewayProvider);
    expect(provider.name).toBe('kilo');
  });

  it('does not list kimi-k3 or gpt-5.6-luna as Kilo seat models', () => {
    expect(Object.values(KILO_SEAT_MODELS)).not.toContain('moonshotai/kimi-k3');
    expect(Object.values(KILO_SEAT_MODELS)).not.toContain('openai/gpt-5.6-luna');
    expect(Object.values(KILO_SEAT_MODELS)).not.toContain('kimi-k3');
    expect(Object.values(KILO_SEAT_MODELS)).not.toContain('gpt-5.6-luna');
    expect(KILO_SEAT_MODELS.harness).toBe('anthropic/claude-opus-5');
    expect(KILO_SEAT_MODELS.generator).toBe('anthropic/claude-opus-5');
  });
});

describe('Doctrine seat endpoints (cliproxy + Codex proxy)', () => {
  it('still detects Ollama Cloud for explicit endpoints (not a doctrine seat)', () => {
    expect(isOllamaCloudUrl(OLLAMA_CLOUD_BASE_URL)).toBe(true);
    expect(detectProviderAdapter({ baseUrl: OLLAMA_CLOUD_BASE_URL, model: 'kimi-k3' })).toBe('openai');
    expect(detectProviderLabel(OLLAMA_CLOUD_BASE_URL)).toBe('ollama');
    expect(apiKeyEnvNamesForEndpoint(OLLAMA_CLOUD_BASE_URL, 'kimi-k3')).toEqual(['OLLAMA_API_KEY']);
  });

  it('createProvider builds OpenAIProvider for cliproxy harness endpoint', () => {
    const provider = createProvider({
      baseUrl: DEFAULT_CODEX_PROXY_BASE_URL,
      model: CODEX_PROXY_HARNESS_SEAT.model,
      apiKey: 'test-proxy-key',
    });
    expect(provider).toBeInstanceOf(OpenAIProvider);
  });

  it('detects the Codex/cliproxy endpoint and CODEX_PROXY_API_KEY', () => {
    expect(isCodexProxyUrl(DEFAULT_CODEX_PROXY_BASE_URL)).toBe(true);
    expect(getCodexProxyBaseUrl()).toBe(DEFAULT_CODEX_PROXY_BASE_URL);
    expect(getCodexProxyApiKey()).toBeUndefined();
    expect(getCodexProxyApiKeyFromEnv()).toBeUndefined();
    expect(apiKeyEnvNamesForEndpoint(DEFAULT_CODEX_PROXY_BASE_URL, 'gpt-5.6-luna')).toEqual(['CODEX_PROXY_API_KEY']);
    expect(apiKeyEnvNamesForEndpoint(DEFAULT_CODEX_PROXY_BASE_URL, 'kimi-k3')).toEqual(['CODEX_PROXY_API_KEY']);
    expect(detectProviderAdapter({ baseUrl: DEFAULT_CODEX_PROXY_BASE_URL, model: 'gpt-5.6-luna' })).toBe('openai');
  });

  it('rejects proxy lookalikes and credential-bearing URLs', () => {
    expect(isCodexProxyUrl('https://evil.example/localhost:8317/v1')).toBe(false);
    expect(isCodexProxyUrl('http://localhost:8317.evil.example/v1')).toBe(false);
    expect(isCodexProxyUrl('http://user@localhost:8317/v1')).toBe(false);
    expect(isCodexProxyUrl('http://localhost:8317/v1?redirect=evil')).toBe(false);
  });

  it('honors CODEX_PROXY_BASE_URL and CODEX_PROXY_API_KEY env overrides', () => {
    process.env.CODEX_PROXY_BASE_URL = 'http://127.0.0.1:9000/v1';
    process.env.CODEX_PROXY_API_KEY = 'custom-proxy-key';
    expect(getCodexProxyBaseUrl()).toBe('http://127.0.0.1:9000/v1');
    expect(getCodexProxyApiKey()).toBe('custom-proxy-key');
    expect(getCodexProxyApiKeyFromEnv()).toBe('custom-proxy-key');
    expect(isCodexProxyUrl('http://127.0.0.1:9000/v1')).toBe(true);
    expect(apiKeyEnvNamesForEndpoint('http://127.0.0.1:9000/v1')).toEqual(['CODEX_PROXY_API_KEY']);
  });
});

describe('Doctrine seat capability flags', () => {
  it('registers the repair-lane MiniMax-M3 as vision-capable', () => {
    expect(CapabilityRegistry.supportsVision('MiniMax-M3')).toBe(true);
    expect(CapabilityRegistry.getCapabilities('MiniMax-M3').toolUse).toBe(true);
  });

  it('registers gpt-5.6-luna, kimi-k3, and official Gemini seat ids as vision', () => {
    expect(CapabilityRegistry.supportsVision('gpt-5.6-luna')).toBe(true);
    expect(CapabilityRegistry.supportsVision('openai/gpt-5.6-luna')).toBe(true);
    expect(CapabilityRegistry.supportsVision('kimi-k3')).toBe(true);
    expect(CapabilityRegistry.supportsVision('moonshotai/kimi-k3')).toBe(true);
    expect(CapabilityRegistry.supportsVision('gemini-3.6-flash-high')).toBe(true);
    expect(CapabilityRegistry.supportsVision('gemini-3.1-pro-low')).toBe(true);
  });

  it('registers tools + thinking for official seat models', () => {
    expect(CapabilityRegistry.getCapabilities('kimi-k3').toolUse).toBe(true);
    expect(CapabilityRegistry.getCapabilities('kimi-k3').thinking).toBe(true);
    expect(CapabilityRegistry.getCapabilities('gpt-5.6-luna').maxContextTokens).toBe(1050000);
    expect(CapabilityRegistry.getCapabilities('openai/gpt-5.6-luna').maxContextTokens).toBe(1050000);
    expect(CapabilityRegistry.getCapabilities('gemini-3.6-flash-high').thinking).toBe(true);
    expect(CapabilityRegistry.getCapabilities('gemini-3.1-pro-low').thinking).toBe(true);
  });

  it('registers vision for Kilo-reserved models', () => {
    expect(CapabilityRegistry.supportsVision('google/gemini-3.5-flash')).toBe(true);
    expect(CapabilityRegistry.supportsVision('anthropic/claude-opus-5')).toBe(true);
  });
});

describe('Doctrine seat defaults in role resolution', () => {
  it('defaults generator→flash-high, harness→kimi-k3, evaluator→pro-low, studio→flash-high on cliproxy', async () => {
    process.env.CODEX_PROXY_API_KEY = 'test-proxy-key';
    writeRoleConfig({
      roles: { generator: { baseUrl: DEFAULT_CODEX_PROXY_BASE_URL } },
    });

    const roles = await loadRoleConfig(projectDir);
    expect(roles.generator.baseUrl).toBe(DEFAULT_CODEX_PROXY_BASE_URL);
    expect(roles.generator.model).toBe(CODEX_PROXY_GENERATOR_SEAT.model);
    expect(roles.generator.model).toBe('gemini-3.6-flash-high');
    expect(roles.generator.apiKey).toBe('test-proxy-key');

    expect(roles.harness.baseUrl).toBe(DEFAULT_CODEX_PROXY_BASE_URL);
    expect(roles.harness.model).toBe(CODEX_PROXY_HARNESS_SEAT.model);
    expect(roles.harness.model).toBe('kimi-k3');
    expect(roles.harness.apiKey).toBe('test-proxy-key');

    expect(roles.evaluator.baseUrl).toBe(DEFAULT_CODEX_PROXY_BASE_URL);
    expect(roles.evaluator.model).toBe(CODEX_PROXY_EVALUATOR_SEAT.model);
    expect(roles.evaluator.model).toBe('gemini-3.1-pro-low');
    expect(roles.evaluator.provider).toBe('openai'); // loopback proxy doctrine
    expect(roles.evaluator.apiKey).toBe('test-proxy-key');

    expect(roles.studio.baseUrl).toBe(DEFAULT_CODEX_PROXY_BASE_URL);
    expect(roles.studio.model).toBe('gemini-3.6-flash-high');
  });

  it('when generator is on Kilo, still diverts harness/evaluator/studio to cliproxy seats', async () => {
    process.env.KILO_API_KEY = 'test-kilo-key';
    process.env.CODEX_PROXY_API_KEY = 'test-proxy-key';
    writeRoleConfig({
      roles: { generator: { baseUrl: KILO_GATEWAY_BASE_URL } },
    });

    const roles = await loadRoleConfig(projectDir);
    expect(roles.generator.model).toBe(KILO_SEAT_MODELS.generator);
    expect(roles.generator.model).toBe('anthropic/claude-opus-5');
    expect(roles.generator.provider).toBe('kilo');

    expect(roles.harness.baseUrl).toBe(DEFAULT_CODEX_PROXY_BASE_URL);
    expect(roles.harness.model).toBe('kimi-k3');
    expect(roles.harness.apiKey).toBe('test-proxy-key');

    expect(roles.evaluator.baseUrl).toBe(DEFAULT_CODEX_PROXY_BASE_URL);
    expect(roles.evaluator.model).toBe('gemini-3.1-pro-low');
    expect(roles.evaluator.apiKey).toBe('test-proxy-key');

    expect(roles.studio.baseUrl).toBe(DEFAULT_CODEX_PROXY_BASE_URL);
    expect(roles.studio.model).toBe('gemini-3.6-flash-high');
  });

  it('never leaks KILO_API_KEY to cliproxy harness/evaluator when CODEX_PROXY unset', async () => {
    // Key-leak negative: generator on Kilo with only KILO_API_KEY → harness +
    // evaluator doctrine seats point at cliproxy with apiKey undefined.
    process.env.KILO_API_KEY = 'test-kilo-key';
    delete process.env.OLLAMA_API_KEY;
    delete process.env.MINIMAX_API_KEY;
    delete process.env.CODEX_PROXY_API_KEY;
    delete process.env.SINTER_CODEX_PROXY_API_KEY;
    delete process.env.LIMINAL_CODEX_PROXY_API_KEY;
    writeRoleConfig({
      roles: { generator: { baseUrl: KILO_GATEWAY_BASE_URL } },
    });

    const roles = await loadRoleConfig(projectDir);
    expect(roles.generator.apiKey).toBe('test-kilo-key');
    expect(roles.harness.baseUrl).toBe(DEFAULT_CODEX_PROXY_BASE_URL);
    expect(roles.harness.model).toBe('kimi-k3');
    expect(roles.harness.apiKey).toBeUndefined();
    expect(roles.harness.apiKey).not.toBe('test-kilo-key');
    expect(roles.evaluator.baseUrl).toBe(DEFAULT_CODEX_PROXY_BASE_URL);
    expect(roles.evaluator.apiKey).toBeUndefined();
    expect(roles.evaluator.apiKey).not.toBe('test-kilo-key');
  });

  it('never sends MINIMAX_API_KEY or a dummy key from the generator to cliproxy', async () => {
    // The generation path fails closed without CODEX_PROXY_API_KEY.
    process.env.MINIMAX_API_KEY = 'test-minimax-key';
    writeRoleConfig({
      roles: { generator: { baseUrl: DEFAULT_CODEX_PROXY_BASE_URL } },
    });

    await expect(loadRoleConfig(projectDir)).rejects.toThrow('CODEX_PROXY_API_KEY_REQUIRED');
    // Repair lane constants still document MiniMax direct.
    expect(MINIMAX_REPAIR_LANE.model).toBe('MiniMax-M3');
  });

  it('explicit role models override the seat defaults', async () => {
    process.env.KILO_API_KEY = 'test-kilo-key';
    writeRoleConfig({
      roles: {
        generator: { baseUrl: KILO_GATEWAY_BASE_URL },
        evaluator: { baseUrl: KILO_GATEWAY_BASE_URL, model: 'anthropic/claude-opus-5-fast' },
      },
    });

    const roles = await loadRoleConfig(projectDir);
    expect(roles.evaluator.model).toBe('anthropic/claude-opus-5-fast');
  });

  it('an evaluator explicitly pointed at Kilo without a model gets the free Kilo-side default', async () => {
    process.env.KILO_API_KEY = 'test-kilo-key';
    writeRoleConfig({
      roles: {
        generator: { baseUrl: KILO_GATEWAY_BASE_URL },
        evaluator: { baseUrl: KILO_GATEWAY_BASE_URL },
      },
    });

    const roles = await loadRoleConfig(projectDir);
    expect(roles.evaluator.model).toBe('google/gemini-3.5-flash');
    expect(roles.evaluator.provider).toBe('kilo');
  });

  it('does not apply seat defaults for non-seat endpoints', async () => {
    writeRoleConfig({
      roles: { generator: { baseUrl: 'https://openrouter.ai/api/v1', model: 'some/model' } },
    });

    const roles = await loadRoleConfig(projectDir);
    expect(roles.evaluator.model).toBe('some/model'); // inherits generator, not a seat
    expect(roles.harness.model).toBe('some/model');
  });
});

describe('Doctrine seat fallback defaults', () => {
  function fallbacksFor(role: 'generator' | 'evaluator' | 'harness'): BaseProvider[] {
    const client = new LLMClient({ role });
    return (client as unknown as { getFallbackProviders(): BaseProvider[] }).getFallbackProviders();
  }

  it('uses cliproxy luna fallbacks when the file has none (Codex-fronted)', async () => {
    process.env.CODEX_PROXY_API_KEY = 'test-proxy-key';
    writeRoleConfig({
      roles: { generator: { baseUrl: DEFAULT_CODEX_PROXY_BASE_URL } },
    });
    await LLMClient.loadRoles(projectDir);

    const generatorFallbacks = fallbacksFor('generator');
    expect(generatorFallbacks).toHaveLength(1);
    expect(generatorFallbacks[0].getModel()).toBe(CODEX_PROXY_FALLBACK_SEAT.model);
    expect(generatorFallbacks[0].getModel()).toBe('gpt-5.6-luna');
    expect(generatorFallbacks[0].getConfig().baseUrl).toBe(DEFAULT_CODEX_PROXY_BASE_URL);
    expect(generatorFallbacks[0].getConfig().apiKey).toBe('test-proxy-key');
    expect(generatorFallbacks[0]).toBeInstanceOf(OpenAIProvider);

    const evaluatorFallbacks = fallbacksFor('evaluator');
    expect(evaluatorFallbacks).toHaveLength(1);
    expect(evaluatorFallbacks[0].getModel()).toBe('gpt-5.6-luna');
    expect(evaluatorFallbacks[0].getConfig().baseUrl).toBe(DEFAULT_CODEX_PROXY_BASE_URL);
    expect(evaluatorFallbacks[0].getConfig().apiKey).toBe('test-proxy-key');
    expect(evaluatorFallbacks[0]).toBeInstanceOf(OpenAIProvider);

    // Harness has no fallback (Kilo credits scarce; not a kimi-k3 backup).
    const harnessFallbacks = fallbacksFor('harness');
    expect(harnessFallbacks).toHaveLength(0);
    expect(KILO_SEAT_FALLBACKS.harness).toBeUndefined();
  });

  it('file-defined fallbacks beat the seat defaults', async () => {
    process.env.KILO_API_KEY = 'test-kilo-key';
    process.env.CODEX_PROXY_API_KEY = 'test-proxy-key';
    writeRoleConfig({
      roles: { generator: { baseUrl: DEFAULT_CODEX_PROXY_BASE_URL } },
      fallbacks: {
        evaluator: [{ baseUrl: KILO_GATEWAY_BASE_URL, model: 'anthropic/claude-opus-5' }],
      },
    });
    await LLMClient.loadRoles(projectDir);

    const evaluatorFallbacks = fallbacksFor('evaluator');
    expect(evaluatorFallbacks.map(p => p.getModel())).toEqual(['anthropic/claude-opus-5']);
    expect(evaluatorFallbacks[0]).toBeInstanceOf(KiloGatewayProvider);
  });

  it('registers no seat fallbacks for non-seat endpoints', async () => {
    writeRoleConfig({
      roles: { generator: { baseUrl: 'https://openrouter.ai/api/v1', model: 'some/model' } },
    });
    await LLMClient.loadRoles(projectDir);

    expect(fallbacksFor('generator')).toHaveLength(0);
    expect(fallbacksFor('evaluator')).toHaveLength(0);
    expect(KILO_SEAT_FALLBACKS.generator).toHaveLength(1);
  });
});
