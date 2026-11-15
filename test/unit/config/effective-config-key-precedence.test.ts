import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getEffectiveConfig } from '../../../src/config/ConfigLoader.js';

const ENV_KEYS = [
  'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN',
  'OPENAI_API_KEY', 'LLM_API_KEY', 'LLM_PROVIDER', 'LLM_BASE_URL', 'LLM_MODEL',
  'SINTER_ANTHROPIC_API_KEY', 'SINTER_OPENAI_API_KEY', 'SINTER_LLM_API_KEY', 'SINTER_LLM_BASE_URL', 'SINTER_LLM_MODEL',
  'LIMINAL_ANTHROPIC_API_KEY', 'LIMINAL_OPENAI_API_KEY', 'LIMINAL_LLM_API_KEY',
] as const;

describe('effective config key selection', () => {
  const original = new Map<string, string | undefined>();
  for (const key of ENV_KEYS) original.set(key, process.env[key]);

  afterEach(() => {
    for (const key of ENV_KEYS) {
      const value = original.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('never pairs an Anthropic endpoint with an OpenAI key when both are exported', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'liminal-config-'));
    try {
      for (const key of ENV_KEYS) delete process.env[key];
      process.env.ANTHROPIC_API_KEY = 'sk-ant-SENTINEL';
      process.env.OPENAI_API_KEY = 'sk-openai-SENTINEL';

      const config = await getEffectiveConfig(join(dir, 'config.json'));

      expect(config.provider).toBe('anthropic');
      expect(config.baseUrl).toContain('anthropic');
      expect(config.apiKey).toBe('sk-ant-SENTINEL');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });


  it('does not admit an OpenAI key for a custom endpoint on a foreign vendor host', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'liminal-config-'));
    try {
      for (const key of ENV_KEYS) delete process.env[key];
      process.env.SINTER_LLM_PROVIDER = 'custom';
      process.env.SINTER_LLM_BASE_URL = 'https://api.anthropic.com/v1';
      process.env.OPENAI_API_KEY = 'sk-openai-SENTINEL';

      const config = await getEffectiveConfig(join(dir, 'config.json'));

      expect(config.apiKey).not.toBe('sk-openai-SENTINEL');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('does not admit an OpenAI key through the hybrid branch', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'liminal-config-'));
    try {
      for (const key of ENV_KEYS) delete process.env[key];
      process.env.SINTER_LLM_PROVIDER = 'hybrid';
      process.env.SINTER_LLM_BASE_URL = 'https://api.anthropic.com/v1';
      process.env.OPENAI_API_KEY = 'sk-openai-SENTINEL';

      const config = await getEffectiveConfig(join(dir, 'config.json'));

      expect(config.apiKey).not.toBe('sk-openai-SENTINEL');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });


  it('keeps an OpenAI key for a genuine OpenAI endpoint through hybrid', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'liminal-config-'));
    try {
      for (const key of ENV_KEYS) delete process.env[key];
      process.env.SINTER_LLM_PROVIDER = 'hybrid';
      process.env.SINTER_LLM_BASE_URL = 'https://api.openai.com/v1';
      process.env.OPENAI_API_KEY = 'sk-openai-SENTINEL';

      const config = await getEffectiveConfig(join(dir, 'config.json'));

      expect(config.apiKey).toBe('sk-openai-SENTINEL');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('suppresses an OpenAI key for an explicit openai provider on a foreign host', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'liminal-config-'));
    try {
      for (const key of ENV_KEYS) delete process.env[key];
      process.env.SINTER_LLM_PROVIDER = 'openai';
      process.env.SINTER_LLM_BASE_URL = 'https://api.anthropic.com/v1';
      process.env.OPENAI_API_KEY = 'sk-openai-SENTINEL';

      const config = await getEffectiveConfig(join(dir, 'config.json'));

      expect(config.apiKey).not.toBe('sk-openai-SENTINEL');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });


  it('never returns an OpenAI key for any provider on a foreign-vendor host', async () => {
    const foreignHosts = [
      'https://api.anthropic.com/v1',
      'https://generativelanguage.googleapis.com/v1beta',
      'https://api.minimax.io/anthropic',
      'https://api.z.ai/api/anthropic',
      'https://api.moonshot.ai/v1',
      'https://api.moonshot.cn/v1',
      'https://api.x.ai/v1',
      'https://openrouter.ai/api/v1',
      'https://api.deepinfra.com/v1/openai',
    ];
    const providers = [
      'anthropic', 'openai', 'google', 'minimax', 'glm', 'kimi', 'moonshot',
      'openrouter', 'custom', 'hybrid', 'lmstudio', 'ollama',
    ];
    const leaks: string[] = [];
    const dir = await mkdtemp(join(tmpdir(), 'liminal-config-'));
    try {
      for (const key of ENV_KEYS) delete process.env[key];
      process.env.OPENAI_API_KEY = 'sk-openai-MATRIX';
      for (const provider of providers) {
        for (const baseUrl of foreignHosts) {
          process.env.SINTER_LLM_PROVIDER = provider;
          process.env.SINTER_LLM_BASE_URL = baseUrl;
          const config = await getEffectiveConfig(join(dir, 'config.json'));
          if (String(config.apiKey ?? '').includes('sk-openai-MATRIX')) {
            leaks.push(`${provider} @ ${baseUrl}`);
          }
        }
      }
      expect(leaks).toEqual([]);
    } finally {
      delete process.env.SINTER_LLM_PROVIDER;
      delete process.env.SINTER_LLM_BASE_URL;
      delete process.env.OPENAI_API_KEY;
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('still honors an explicit generic SINTER/LLM key for a custom endpoint', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'liminal-config-'));
    try {
      for (const key of ENV_KEYS) delete process.env[key];
      process.env.SINTER_LLM_PROVIDER = 'minimax';
      process.env.LLM_API_KEY = 'sk-generic-SENTINEL';

      const config = await getEffectiveConfig(join(dir, 'config.json'));

      expect(config.provider).toBe('minimax');
      expect(config.apiKey).toBe('sk-generic-SENTINEL');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
