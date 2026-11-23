import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Each case spawns the real CLI (cold node start + dist import); the 5s default timed out under host load.
vi.setConfig({ testTimeout: 90_000 });

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const binPath = path.join(repoRoot, 'bin', 'sinter');

describe('CLI config writers', () => {
  let home: string;
  let configPath: string;

  beforeEach(async () => {
    home = await fs.mkdtemp(path.join(os.tmpdir(), 'sinter-config-writer-'));
    configPath = path.join(home, '.sinter', 'config.json');
    await fs.mkdir(path.dirname(configPath), { recursive: true });
    await fs.writeFile(configPath, JSON.stringify({
      defaultProvider: 'glm',
      providers: { glm: { model: 'glm-5.2', apiKey: 'keep-key' } },
      roles: { evaluator: { provider: 'glm', model: 'glm-5.2' } },
      fallbacks: { evaluator: ['minimax'] },
      capabilities: { 'glm-5.2': { vision: true } },
    }));
  });

  afterEach(async () => fs.rm(home, { recursive: true, force: true }));

  it.each([
    ['provider set-key', ['provider', 'set-key', 'openai', 'sk-test-new', '--model', 'gpt-5.4', '--use']],
    ['--configure', ['--configure', '--provider', 'openai', '--model', 'gpt-5.4']],
  ])('%s preserves unrelated config sections through the canonical writer', async (_name, args) => {
    await execFileAsync(process.execPath, [binPath, ...args], {
      cwd: repoRoot,
      env: { ...process.env, HOME: home, NODE_ENV: 'test', DOTENV_CONFIG_QUIET: 'true' },
      timeout: 80_000,
    });

    const config = JSON.parse(await fs.readFile(configPath, 'utf-8'));
    expect(config.defaultProvider).toBe('openai');
    expect(config.providers.glm.apiKey).toBe('keep-key');
    expect(config.roles.evaluator.model).toBe('glm-5.2');
    expect(config.fallbacks.evaluator).toEqual(['minimax']);
    expect(config.capabilities['glm-5.2'].vision).toBe(true);
    expect((await fs.stat(configPath)).mode & 0o777).toBe(0o600);
  });
});
