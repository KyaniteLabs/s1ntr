/**
 * Wave 2 fix: --base-url must not attach Grok JWT to cliproxy or strip studio GLM key.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveBaseUrlCredentials } from '../../../scripts/rotation/cli.mjs';
import { resolveSeatModel } from '../../../scripts/rotation/shared.mjs';

const roles = {
  harness: {
    model: 'gpt-5.6-sol',
    baseUrl: 'http://localhost:8317/v1',
    apiKey: 'cliproxy-harness-key',
    provider: 'openai',
  },
  generator: {
    model: 'grok-4.5',
    baseUrl: 'https://api.x.ai/v1',
    apiKey: 'grok-jwt-not-for-cliproxy',
    provider: 'openai',
  },
  studio: {
    model: 'glm-5.2',
    baseUrl: 'https://api.z.ai/api/anthropic',
    apiKey: 'glm-studio-key',
    provider: 'anthropic',
  },
  evaluator: {
    model: 'moonshotai/kimi-k3',
    baseUrl: 'https://api.kilo.ai/api/gateway',
    apiKey: 'kilo-eval-key',
    provider: 'kilo',
  },
};

describe('resolveBaseUrlCredentials', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('cliproxy uses harness Sol key, not generator Grok JWT', () => {
    const r = resolveBaseUrlCredentials('http://localhost:8317/v1', roles, {
      role: 'studio',
    });
    expect(r.patch.apiKey).toBe('cliproxy-harness-key');
    expect(r.patch.apiKey).not.toBe('grok-jwt-not-for-cliproxy');
    expect(String(r.keySource)).toMatch(/cliproxy/);
  });

  it('z.ai uses RoleConfig.studio GLM key before env', () => {
    const r = resolveBaseUrlCredentials('https://api.z.ai/api/anthropic', roles, {
      role: 'evaluator',
      env: {},
    });
    expect(r.patch.apiKey).toBe('glm-studio-key');
    expect(r.keySource).toMatch(/studio/);
  });

  it('z.ai falls back to env when studio missing', () => {
    const noStudio = { ...roles, studio: { model: 'glm-5.2', baseUrl: 'https://api.z.ai/api/anthropic' } };
    const r = resolveBaseUrlCredentials('https://api.z.ai/api/anthropic', noStudio, {
      role: 'evaluator',
      env: { GLM_API_KEY: 'from-env' },
    });
    expect(r.patch.apiKey).toBe('from-env');
  });

  it('z.ai missing key is explicit missing-glm-key', () => {
    const empty = { harness: {}, generator: {}, studio: {}, evaluator: {} };
    const r = resolveBaseUrlCredentials('https://api.z.ai/api/anthropic', empty, {
      role: 'evaluator',
      env: {},
    });
    expect(r.patch.apiKey).toBe(undefined);
    expect(r.keySource).toBe('missing-glm-key');
  });

  it('uses only an explicit DeepSeek key for the official HTTPS endpoint', () => {
    const r = resolveBaseUrlCredentials('https://api.deepseek.com/v1', roles, {
      role: 'generator',
      env: { DEEPSEEK_API_KEY: 'deepseek-key', DEEPSEEK_PRO_API_KEY: 'older-key' },
    });
    expect(r.patch).toMatchObject({ apiKey: 'deepseek-key', provider: 'openai' });
    expect(r.keySource).toBe('env.deepseek+base-url');
  });

  it('accepts the older explicit DeepSeek key name', () => {
    const r = resolveBaseUrlCredentials('https://api.deepseek.com', roles, {
      env: { DEEPSEEK_PRO_API_KEY: 'older-key' },
    });
    expect(r.patch.apiKey).toBe('older-key');
  });

  it('preserves an explicit key on the same approved DeepSeek role', async () => {
    const configured = { ...roles, generator: {
      model: 'deepseek-chat', baseUrl: 'https://api.deepseek.com/v1',
      apiKey: 'configured-deepseek-key', provider: 'openai',
    } };
    const r = resolveBaseUrlCredentials('https://api.deepseek.com/v1', configured, {
      role: 'generator', env: { DEEPSEEK_API_KEY: 'environment-key' },
    });
    expect(r.patch.apiKey).toBe('configured-deepseek-key');
    expect(r.keySource).toBe('RoleConfig.deepseek+base-url');
    const seat = await resolveSeatModel('generator', { loadRoleConfig: async () => ({
      ...configured, generator: { ...configured.generator, ...r.patch },
    }) });
    expect(seat.apiKey).toBe('configured-deepseek-key');
  });

  it('fails closed without a DeepSeek key', () => {
    const r = resolveBaseUrlCredentials('https://api.deepseek.com/v1', roles, { env: {} });
    expect(r.patch.apiKey).toBe(undefined);
    expect(r.keySource).toBe('missing-deepseek-key');
  });

  it('keeps a missing DeepSeek key missing through seat resolution', async () => {
    for (const name of ['SINTER_LLM_API_KEY', 'LIMINAL_LLM_API_KEY', 'LLM_API_KEY']) {
      vi.stubEnv(name, `${name}-generic`);
    }
    const baseUrl = 'https://api.deepseek.com/v1';
    const { patch } = resolveBaseUrlCredentials(baseUrl, roles, { env: {} });
    const seat = await resolveSeatModel('generator', {
      loadRoleConfig: async () => ({
        generator: { model: 'deepseek-v4-pro', baseUrl, ...patch },
      }),
    });
    expect(seat.apiKey).toBeNull();
    expect(seat.keyPresent).toBe(false);
    expect(seat.keySource).toBe('missing-deepseek-key');
  });

  it('preserves the explicit DeepSeek key through seat resolution', async () => {
    vi.stubEnv('SINTER_LLM_API_KEY', 'generic-key');
    const baseUrl = 'https://api.deepseek.com/v1';
    const { patch } = resolveBaseUrlCredentials(baseUrl, roles, {
      env: { DEEPSEEK_API_KEY: 'explicit-key' },
    });
    const seat = await resolveSeatModel('generator', {
      loadRoleConfig: async () => ({
        generator: { model: 'deepseek-v4-pro', baseUrl, ...patch },
      }),
    });
    expect(seat.apiKey).toBe('explicit-key');
    expect(seat.keySource).toBe('env.deepseek+base-url');
  });

  it('does not send a DeepSeek key to lookalikes, HTTP, or local Ollama', () => {
    const env = { DEEPSEEK_API_KEY: 'deepseek-key' };
    for (const baseUrl of [
      'https://api.deepseek.com.evil/v1',
      'https://attacker.invalid/api.deepseek.com/v1',
      'https://deepseek.com/v1',
      'http://api.deepseek.com/v1',
      'https://api.deepseek.com:8443/v1',
      'http://localhost:11434/v1',
      'http://localhost:3000/v1',
    ]) {
      const r = resolveBaseUrlCredentials(baseUrl, roles, { env });
      expect(r.patch.apiKey).not.toBe('deepseek-key');
    }
  });

  it('rejects HTTPS-to-HTTP downgrade even with a prior DeepSeek role key', () => {
    const deepseekRole = {
      generator: {
        baseUrl: 'https://api.deepseek.com/v1',
        apiKey: 'role-deepseek-key',
        provider: 'openai',
      },
    };
    for (const baseUrl of ['http://api.deepseek.com/v1', 'https://api.deepseek.com:8443/v1']) {
      const r = resolveBaseUrlCredentials(baseUrl, deepseekRole, {
        role: 'generator',
        env: { DEEPSEEK_API_KEY: 'env-deepseek-key' },
      });
      expect(r.patch.apiKey).toBe(undefined);
      expect(r.keySource).toBe('unknown-host-no-credentials');
    }
  });

  it('keeps rejected DeepSeek transports uncredentialed through seat resolution', async () => {
    for (const name of ['SINTER_LLM_API_KEY', 'LIMINAL_LLM_API_KEY', 'LLM_API_KEY']) {
      vi.stubEnv(name, `${name}-generic`);
    }
    const deepseekRole = {
      generator: {
        model: 'deepseek-v4-pro',
        baseUrl: 'https://api.deepseek.com/v1',
        apiKey: 'role-deepseek-key',
      },
    };
    for (const baseUrl of [
      'http://api.deepseek.com/v1',
      'https://api.deepseek.com:8443/v1',
      'https://api.deepseek.com.evil/v1',
      'https://attacker.invalid/api.deepseek.com/v1',
    ]) {
      const { patch } = resolveBaseUrlCredentials(baseUrl, deepseekRole, {
        role: 'generator', env: { DEEPSEEK_API_KEY: 'env-deepseek-key' },
      });
      const seat = await resolveSeatModel('generator', {
        loadRoleConfig: async () => ({
          generator: { ...deepseekRole.generator, baseUrl, ...patch },
        }),
      });
      expect(seat.apiKey).toBeNull();
      expect(seat.keyPresent).toBe(false);
      expect(seat.keySource).toBe('unknown-host-no-credentials');
    }
  });

  it('retains generic fallback for a role with no explicit credential decision', async () => {
    vi.stubEnv('SINTER_LLM_API_KEY', 'generic-key');
    const seat = await resolveSeatModel('generator', {
      loadRoleConfig: async () => ({ generator: {
        model: 'custom-model', baseUrl: 'https://custom.example/v1',
      } }),
    });
    expect(seat.apiKey).toBe('generic-key');
    expect(seat.keySource).toBe('env');
  });

  it('kilo uses evaluator kilo key', () => {
    const r = resolveBaseUrlCredentials('https://api.kilo.ai/api/gateway', roles, {
      role: 'harness',
    });
    expect(r.patch.apiKey).toBe('kilo-eval-key');
    expect(r.patch.provider).toBe('kilo');
  });

  it('path-injected cliproxy-looking URL does not receive cliproxy key (Terra PR#589)', () => {
    const r = resolveBaseUrlCredentials('https://attacker.invalid/127.0.0.1:8317/v1', roles, {
      role: 'studio',
    });
    expect(r.patch.apiKey).toBe(undefined);
    expect(r.keySource).toBe('unknown-host-no-credentials');
  });

  it('lookalike kilo domain does not receive kilo key', () => {
    const r = resolveBaseUrlCredentials('https://api.kilo.ai.evil/v1', roles, {
      role: 'harness',
    });
    expect(r.patch.apiKey).toBe(undefined);
    expect(r.keySource).toBe('unknown-host-no-credentials');
  });

  it('unknown host fails closed without inheriting prev role key', () => {
    const r = resolveBaseUrlCredentials('https://evil.example/v1', roles, {
      role: 'generator',
    });
    expect(r.patch.apiKey).toBe(undefined);
    expect(r.keySource).toBe('unknown-host-no-credentials');
  });
});
