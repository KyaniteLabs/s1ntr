import { execFile } from 'child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { promisify } from 'util';
import { fileURLToPath } from 'url';
import { afterEach, describe, expect, it } from 'vitest';

const run = promisify(execFile);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const binPath = path.join(repoRoot, 'bin', 'sinter');

describe('bin/sinter config path', () => {
  let dir = '';
  afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

  async function providerStatus(env: Record<string, string>): Promise<{ code: number; out: string }> {
    try {
      const { stdout, stderr } = await run(process.execPath, [binPath, 'provider', 'status'], {
        cwd: repoRoot, env: { ...process.env, NODE_ENV: 'test', DOTENV_CONFIG_QUIET: 'true', ...env },
      });
      return { code: 0, out: stdout + stderr };
    } catch (e) {
      const err = e as { code: number; stdout: string; stderr: string };
      return { code: err.code, out: err.stdout + err.stderr };
    }
  }

  it('reads the config named by SINTER_CONFIG_PATH, not ~/.sinter/config.json', async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'sinter-cfg-'));
    const cfg = path.join(dir, 'override.json');
    writeFileSync(cfg, '{ not json');
    const r = await providerStatus({ HOME: path.join(dir, 'home'), SINTER_CONFIG_PATH: cfg });
    expect(r.code).toBe(1);
    expect(r.out).toContain(`${cfg} is not valid JSON`);
  });

  it('falls back to HOME/.sinter/config.json when no override is set', async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'sinter-cfg-'));
    const env = { HOME: dir, SINTER_CONFIG_PATH: '', LIMINAL_CONFIG_PATH: '' };
    const r = await providerStatus(env);
    expect(r.code).toBe(0);
    expect(r.out).toContain('Sinter provider readiness:');
  });
});
