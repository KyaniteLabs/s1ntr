/** F13: a malformed canonical project config must fail clearly, never fall through to an older file's provider. */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadRoleConfig } from '../../../src/config/RoleConfig.js';
import { LLMClient } from '../../../src/llm/LLMClient.js';

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

describe('F13: project config fallback', () => {
  it('throws PROJECT_CONFIG_MALFORMED instead of using liminal.json', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'proj-cfg-')); dirs.push(dir);
    mkdirSync(path.join(dir, 'config'));
    writeFileSync(path.join(dir, 'config', 'sinter.json'), '{ "llm": { broken');
    writeFileSync(path.join(dir, 'config', 'liminal.json'), JSON.stringify({ llm: { baseUrl: 'http://127.0.0.1:9/v1', model: 'legacy-model' } }));
    await expect(loadRoleConfig(dir)).rejects.toThrow(/PROJECT_CONFIG_MALFORMED/);
  });
  it('still falls back to a legacy name when the canonical file is simply absent', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'proj-cfg-')); dirs.push(dir);
    mkdirSync(path.join(dir, 'config'));
    writeFileSync(path.join(dir, 'config', 'liminal.json'), JSON.stringify({ llm: { baseUrl: 'http://127.0.0.1:9/v1', model: 'legacy-model' } }));
    const cfg = await loadRoleConfig(dir);
    expect(cfg.generator.model).toBe('legacy-model');
  });
});

describe('F13: generic LLM_PROVIDER does not relabel a pinned non-generator seat', () => {
  it('evaluator keeps its file provider; generator still follows the env label', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'role-prov-')); dirs.push(dir);
    const file = path.join(dir, 'config.json');
    writeFileSync(file, JSON.stringify({ roles: {
      generator: { provider: 'ollama', baseUrl: 'http://127.0.0.1:11434/v1', model: 'g' },
      evaluator: { provider: 'ollama', baseUrl: 'http://127.0.0.1:11435/v1', model: 'e' },
    } }));
    const saved = { c: process.env.SINTER_CONFIG_PATH, p: process.env.LIMINAL_LLM_PROVIDER, sp: process.env.SINTER_LLM_PROVIDER };
    process.env.SINTER_CONFIG_PATH = file; process.env.SINTER_LLM_PROVIDER = 'minimax'; delete process.env.LIMINAL_LLM_PROVIDER;
    try {
      const roles = await loadRoleConfig(dir);
      expect(roles.evaluator.provider).toBe('ollama');
      expect(roles.evaluator.baseUrl).toBe('http://127.0.0.1:11435/v1');
    } finally {
      for (const [k, v] of [['SINTER_CONFIG_PATH', saved.c], ['LIMINAL_LLM_PROVIDER', saved.p], ['SINTER_LLM_PROVIDER', saved.sp]] as const) {
        if (v === undefined) delete process.env[k]; else process.env[k] = v;
      }
    }
  });
});

describe('G09: project config roles schema is consumed as written', () => {
  const withProject = (cfg: unknown) => {
    const dir = mkdtempSync(path.join(tmpdir(), 'proj-roles-')); dirs.push(dir);
    mkdirSync(path.join(dir, 'config'));
    writeFileSync(path.join(dir, 'config', 'sinter.json'), JSON.stringify(cfg));
    return dir;
  };
  const isolate = async <T>(fn: () => Promise<T>): Promise<T> => {
    const keys = ['SINTER_CONFIG_PATH', 'LIMINAL_CONFIG_PATH', 'SINTER_LLM_BASE_URL', 'LIMINAL_LLM_BASE_URL', 'SINTER_LLM_PROVIDER', 'LIMINAL_LLM_PROVIDER'];
    const saved = keys.map((k) => [k, process.env[k]] as const);
    for (const k of keys) delete process.env[k];
    process.env.SINTER_CONFIG_PATH = path.join(tmpdir(), 'no-such-sinter-config.json');
    try { return await fn(); } finally { for (const [k, v] of saved) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } }
  };

  it('a project with only roles.generator selects that endpoint and model', async () => {
    const dir = withProject({ roles: { generator: { provider: 'ollama', baseUrl: 'http://127.0.0.1:18080/v1', model: 'proj-gen' } } });
    const roles = await isolate(() => loadRoleConfig(dir));
    expect(roles.generator.baseUrl).toBe('http://127.0.0.1:18080/v1');
    expect(roles.generator.model).toBe('proj-gen');
  });

  it.each([
    ['user role', { roles: { generator: { provider: 'openai', baseUrl: 'https://api.openai.com/v1', model: 'user-gen', apiKey: 'user-secret' } } }, {}],
    ['legacy project', {}, { llm: { baseUrl: 'https://api.openai.com/v1', model: 'legacy-gen', apiKey: 'user-secret' } }],
  ])('does not move a %s credential to a project endpoint', async (_source, user, legacy) => {
    const target = 'http://127.0.0.1:18080/v1';
    const dir = withProject({ ...legacy, roles: { generator: { baseUrl: target, model: 'proj-gen' } } });
    const userPath = path.join(dir, 'user.json');
    writeFileSync(userPath, JSON.stringify(user));
    await isolate(async () => {
      process.env.SINTER_CONFIG_PATH = userPath;
      const roles = await loadRoleConfig(dir);
      expect(roles.generator).toMatchObject({ baseUrl: target, model: 'proj-gen' });
      expect(roles.generator.apiKey).not.toBe('user-secret');
    });
  });

  it.each(['', 'https://project-runtime.invalid/v1'])('keeps existing credentials off a project-selected endpoint %j', async target => {
    const dir = withProject({ roles: { generator: { baseUrl: target, model: 'gpt-5.4' } } });
    const userPath = path.join(dir, 'user.json');
    writeFileSync(userPath, JSON.stringify({ roles: {
      generator: { provider: 'openai', baseUrl: 'https://api.openai.com/v1', model: 'gpt-5.4', apiKey: 'saved-test-marker' },
    } }));
    try {
      vi.stubEnv('SINTER_GENERATOR_API_KEY', 'role-test-marker');
      vi.stubEnv('SINTER_LLM_API_KEY', 'generic-test-marker');
      vi.stubEnv('ANTHROPIC_API_KEY', 'vendor-test-marker');
      await isolate(async () => {
        process.env.SINTER_CONFIG_PATH = userPath;
        const roles = await loadRoleConfig(dir);
        expect(roles.generator.baseUrl).toBe(target || 'https://api.anthropic.com/v1');
        expect(roles.generator.apiKey).toBeUndefined();
        expect(roles.studio.apiKey).toBeUndefined();
      });
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('keeps model-only overrides on the pinned route and drops keys on changed inherited routes', async () => {
    const generatorTarget = 'https://project-generator.invalid/v1';
    const evaluatorEndpoint = 'https://saved-evaluator.invalid/v1';
    const dir = withProject({ roles: {
      generator: { baseUrl: generatorTarget },
      evaluator: { model: 'project-eval' },
    } });
    const userPath = path.join(dir, 'user.json');
    writeFileSync(userPath, JSON.stringify({ roles: {
      generator: { baseUrl: 'https://saved-generator.invalid/v1', model: 'saved-gen' },
      evaluator: { baseUrl: evaluatorEndpoint, model: 'saved-eval', apiKey: 'saved-evaluator-key' },
      harness: { model: 'saved-harness', apiKey: 'saved-harness-key' },
    } }));
    await isolate(async () => {
      process.env.SINTER_CONFIG_PATH = userPath;
      const roles = await loadRoleConfig(dir);
      expect(roles.evaluator).toMatchObject({
        baseUrl: evaluatorEndpoint, model: 'project-eval', apiKey: 'saved-evaluator-key',
      });
      expect(roles.harness.baseUrl).toBe(generatorTarget);
      expect(roles.harness.apiKey).toBeUndefined();
    });
  });

  it('a project roles.evaluator is applied beside the generator', async () => {
    const dir = withProject({ roles: { evaluator: { provider: 'ollama', baseUrl: 'http://127.0.0.1:18081/v1', model: 'proj-eval' } } });
    const roles = await isolate(() => loadRoleConfig(dir));
    expect(roles.evaluator.baseUrl).toBe('http://127.0.0.1:18081/v1');
    expect(roles.evaluator.model).toBe('proj-eval');
  });

  it('keeps pinned seats and project fallbacks when a legacy generator is inferred', async () => {
    const fallback = { provider: 'ollama', baseUrl: 'http://127.0.0.1:18082/v1', model: 'proj-fallback' };
    const evaluator = { provider: 'ollama', baseUrl: 'http://127.0.0.1:18081/v1', model: 'proj-eval' };
    const dir = withProject({ roles: { evaluator }, fallbacks: { evaluator: [fallback] } });
    const userConfig = path.join(dir, 'user.json');
    writeFileSync(userConfig, JSON.stringify({
      defaultProvider: 'openai',
      providers: { openai: { apiKey: 'fake-key', baseUrl: 'https://api.openai.com/v1', model: 'legacy-gen' } },
    }));
    await isolate(async () => {
      process.env.SINTER_CONFIG_PATH = userConfig;
      await LLMClient.loadRoles(dir);
      expect(LLMClient.getResolvedRoleConfig('generator')?.model).toBe('legacy-gen');
      expect(LLMClient.getResolvedRoleConfig('evaluator')?.model).toBe('proj-eval');
      expect(LLMClient.getRawRoleConfig()?.fallbacks?.evaluator).toEqual([fallback]);
    });
    LLMClient.clearGlobalCache();
  });

  it('a malformed roles block fails before any model call', async () => {
    const dir = withProject({ roles: { generator: 'not-an-object' } });
    await expect(isolate(() => LLMClient.loadRoles(dir))).rejects.toThrow(/PROJECT_CONFIG_MALFORMED/);
  });
});
