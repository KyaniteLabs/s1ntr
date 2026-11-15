/**
 * ADV-MISO-004 — provider truthfulness.
 *
 * `--provider lmstudio` must not silently claim LM Studio while calling a paid
 * cloud provider. Env/flags beat file role config (with one stderr notice per
 * override), and a runtime fallback must emit one stderr notice naming the
 * override (fallback beats requested). The CLI prints Requested + Resolved lines.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { err } from 'neverthrow';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const binPath = path.join(repoRoot, 'bin', 'sinter');
const _userConfigPath = path.join(
  process.env.HOME || process.env.USERPROFILE || '.',
  '.sinter',
  'config.json',
);

const _hoisted = vi.hoisted(() => ({ userConfig: null as string | null }));

vi.mock('fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs/promises')>();
  return {
    ...actual,
    readFile: vi.fn(((...args: [string, ...unknown[]]) => {
      if (args[0] === _userConfigPath) {
        return _hoisted.userConfig != null
          ? Promise.resolve(_hoisted.userConfig)
          : Promise.reject(new Error('mock: no user config for tests'));
      }
      return actual.readFile(...args);
    }) as unknown as typeof actual.readFile),
  };
});

import {
  clearRoleOverrideNoticeCache,
  loadRoleConfig,
} from '../../../src/config/RoleConfig.js';
import { CapabilityRegistry } from '../../../src/llm/CapabilityRegistry.js';
import { LLMClient, LLMRateLimitError } from '../../../src/llm/LLMClient.js';
import { RetryManager } from '../../../src/llm/RetryManager.js';

describe('ADV-MISO-004 CLI provider truthfulness surface', () => {
  it('prints Requested + Resolved provider lines (not a bare "Using LM Studio endpoint" claim)', async () => {
    const source = await fs.readFile(binPath, 'utf-8');

    expect(source).toContain('[CLI] Requested provider:');
    expect(source).toContain('[CLI] Resolved provider:');
    // The old banner claimed the requested flag was the live endpoint.
    expect(source).not.toMatch(/\[CLI\] Using \$\{providerDefaults\.label\} endpoint/);
    expect(source).not.toContain('[CLI] Using ${providerDefaults.label} endpoint');
  });

  it('wires --provider into generator-only env vars for env-over-file resolution', async () => {
    // Static-source contract (ADV-MISO-004): --provider must set the env vars
    // that RoleConfig reads without mutating evaluator, harness, or studio.
    const source = await fs.readFile(binPath, 'utf-8');
    expect(source).toContain("const envPrefix = 'LIMINAL_GENERATOR'");
    expect(source).toContain('providerKey');
    expect(source).toMatch(/\[`\$\{envPrefix\}_PROVIDER`\]\s*=\s*providerKey/);
    expect(source).toMatch(/lmstudio:\s*\{[\s\S]*?baseUrl:\s*['"]http:\/\/localhost:1234\/v1['"]/);
  });
});

describe('ADV-MISO-004 env/flag beats file role config (no silent GLM under --provider lmstudio)', () => {
  const setUserConfig = (cfg: unknown) => {
    _hoisted.userConfig = JSON.stringify(cfg);
  };

  beforeEach(() => {
    CapabilityRegistry.clearOverrides();
    clearRoleOverrideNoticeCache();
    vi.stubEnv('OPENAI_API_KEY', '');
    vi.stubEnv('GLM_API_KEY', '');
    vi.stubEnv('MINIMAX_API_KEY', '');
    vi.stubEnv('ANTHROPIC_API_KEY', '');
    vi.stubEnv('ANTHROPIC_AUTH_TOKEN', '');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    CapabilityRegistry.clearOverrides();
    _hoisted.userConfig = null;
    clearRoleOverrideNoticeCache();
  });

  it('resolves generator to the lmstudio endpoint when file role is paid GLM and env requests lmstudio', async () => {
    setUserConfig({
      roles: {
        generator: {
          provider: 'glm',
          baseUrl: 'https://api.z.ai/api/anthropic',
          model: 'GLM-5v-turbo',
          apiKey: 'fake-glm-key',
        },
      },
    });
    // Same env vars --provider lmstudio sets in bin/sinter.
    vi.stubEnv('LIMINAL_LLM_PROVIDER', 'lmstudio');
    vi.stubEnv('LIMINAL_LLM_BASE_URL', 'http://localhost:1234/v1');
    vi.stubEnv('LIMINAL_LLM_MODEL', 'local-model');
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const config = await loadRoleConfig('/tmp/nonexistent-sinter-adv-miso-004');

    expect(config.generator.baseUrl).toBe('http://localhost:1234/v1');
    expect(config.generator.model).toBe('local-model');
    expect(config.generator.provider).toBe('lmstudio');
    expect(config.generator.apiKey).not.toBe('fake-glm-key');
    // Must not silently keep the paid GLM endpoint under an lmstudio request.
    expect(config.generator.baseUrl).not.toContain('api.z.ai');

    const notices = errSpy.mock.calls.map(c => String(c[0])).filter(m => m.includes('[config] role'));
    expect(notices.some(m => m.includes('LLM_BASE_URL') && m.includes('baseUrl'))).toBe(true);
    expect(notices.some(m => m.includes('LLM_MODEL') && m.includes('model'))).toBe(true);
    // Positive case: the provider-override notice IS emitted (env beats file provider).
    expect(notices.some(m =>
      m.includes('LLM_PROVIDER') && m.includes('overrides file provider')
      && m.includes("'glm'") && m.includes("'lmstudio'"),
    )).toBe(true);
  });
});

describe('ADV-MISO-004 runtime fallback emits stderr notice (fallback beats requested)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('names the resolved provider on fallback success and prints the override notice', async () => {
    const client = new LLMClient({
      baseUrl: 'http://localhost:1234/v1',
      model: 'local-model',
      apiKey: 'unused',
    });
    const primary = {
      name: 'lmstudio',
      getModel: vi.fn(() => 'local-model'),
      getConfig: vi.fn(() => ({ baseUrl: 'http://localhost:1234/v1', model: 'local-model' })),
      generate: vi.fn(async () => err(new LLMRateLimitError('lmstudio'))),
    };
    const fallback = {
      name: 'glm',
      getModel: vi.fn(() => 'GLM-5v-turbo'),
      getConfig: vi.fn(() => ({ baseUrl: 'https://api.z.ai/api/anthropic', model: 'GLM-5v-turbo' })),
      generate: vi.fn(async () => ({
        isErr: () => false,
        value: { content: 'fallback-ok', success: true },
      })),
    };

    vi.spyOn(RetryManager, 'executeWithRetry').mockImplementation(async (fn: () => Promise<unknown>) => fn());
    vi.spyOn(client as never as { resolveModel: () => Promise<string> }, 'resolveModel').mockResolvedValue('local-model');
    vi.spyOn(client as never as { getProvider: () => Promise<unknown> }, 'getProvider').mockResolvedValue(primary);
    vi.spyOn(client as never as { getFallbackProviders: () => unknown[] }, 'getFallbackProviders').mockReturnValue([fallback]);
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const response = await client.complete({ prompt: 'hello' });

    expect(response.success).toBe(true);
    expect(response.provider).toBe('glm');
    expect(response.model).toBe('GLM-5v-turbo');
    expect(response.fallbackUsed).toBe(true);
    expect(response.fallbackFrom).toBe('lmstudio:local-model');
    expect(response.fallbackTo).toBe('glm:GLM-5v-turbo');

    const notices = errSpy.mock.calls.map(c => String(c[0]));
    const fallbackNotice = notices.find(m => m.includes('[config] fallback:') && m.includes('fallback beats requested'));
    expect(fallbackNotice).toMatch(/requested lmstudio:local-model/);
    expect(fallbackNotice).toMatch(/resolved glm:GLM-5v-turbo/);
    // No silent LM Studio banner while the resolved call is GLM.
    expect(notices.some(m => /Using LM Studio endpoint/i.test(m))).toBe(false);
  });
});
