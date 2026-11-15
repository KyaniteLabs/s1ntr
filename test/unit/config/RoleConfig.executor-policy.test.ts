import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadRoleConfig } from '../../../src/config/RoleConfig.js';
import { LUNA_MODEL_ID } from '../../../src/identity/canonicalAlias.js';

const roots: string[] = [];
const touched = [
  'SINTER_CONFIG_PATH', 'LIMINAL_HARNESS_MODEL', 'LIMINAL_HARNESS_BASE_URL',
  'LIMINAL_LLM_MODEL', 'LIMINAL_LLM_BASE_URL', 'LIMINAL_LLM_API_KEY',
  'CODEX_PROXY_API_KEY',
] as const;
const before = Object.fromEntries(touched.map(key => [key, process.env[key]]));

afterEach(() => {
  for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true });
  for (const key of touched) {
    const value = before[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe('harness role policy at configuration ingress', () => {
  it('rejects persisted Luna harness configuration during load', async () => {
    const root = mkdtempSync(join(tmpdir(), 'role-policy-'));
    roots.push(root);
    const configPath = join(root, 'config.json');
    writeFileSync(configPath, JSON.stringify({ roles: {
      generator: { baseUrl: 'http://localhost:8317/v1', model: 'claude-opus-4-1' },
      harness: { baseUrl: 'http://localhost:8317/v1', model: LUNA_MODEL_ID },
    } }));
    process.env.SINTER_CONFIG_PATH = configPath;
    process.env.CODEX_PROXY_API_KEY = 'test-proxy-key';
    await expect(loadRoleConfig(root)).rejects.toThrow(/HARNESS_ROLE_CONFIG_REJECTED.*Luna.*harness-ineligible/i);
  });

  it('rejects role-specific env and inherited generic Luna before client construction', async () => {
    const root = mkdtempSync(join(tmpdir(), 'role-policy-'));
    roots.push(root);
    mkdirSync(join(root, 'config'));
    process.env.SINTER_CONFIG_PATH = join(root, 'absent.json');
    process.env.LIMINAL_HARNESS_BASE_URL = 'https://api.openai.com/v1';
    process.env.LIMINAL_HARNESS_MODEL = LUNA_MODEL_ID;
    await expect(loadRoleConfig(root)).rejects.toThrow(/HARNESS_ROLE_CONFIG_REJECTED/);

    delete process.env.LIMINAL_HARNESS_BASE_URL;
    delete process.env.LIMINAL_HARNESS_MODEL;
    process.env.LIMINAL_LLM_BASE_URL = 'https://api.openai.com/v1';
    process.env.LIMINAL_LLM_MODEL = LUNA_MODEL_ID;
    process.env.LIMINAL_LLM_API_KEY = 'test-only';
    await expect(loadRoleConfig(root)).rejects.toThrow(/HARNESS_ROLE_CONFIG_REJECTED/);
  });
});
