import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { resolveUserConfigPath } from '../../src/config/RoleConfig.js';
import { fakeProviderEnv, runSinterAsync } from '../helpers/fakeProviderServer.js';

const home = () => mkdtempSync(path.join(tmpdir(), 'proof-'));
const forbidden = path.join(userInfo().homedir, '..proof-fixture', 'no-config.json');
const cli = path.resolve('bin/sinter');
afterEach(() => vi.unstubAllEnvs());

it('rejects config under the account home before a read or CLI migration', () => {
  const dir = home();
  try {
    vi.stubEnv('SINTER_CONFIG_PATH', forbidden);
    vi.stubEnv('SINTER_PROOF_ISOLATION', '1');
    expect(() => resolveUserConfigPath()).toThrow(/PROOF_ISOLATION_REAL_STATE_FORBIDDEN/);
    const run = spawnSync(process.execPath, [cli, '--version'], {
      cwd: dir, env: { ...process.env, HOME: dir }, encoding: 'utf8',
    });
    expect(run.status).toBe(2);
    expect(run.stderr).toContain('PROOF_ISOLATION_REAL_STATE_FORBIDDEN');
    vi.stubEnv('SINTER_PROOF_ISOLATION', '0');
    expect(resolveUserConfigPath()).toBe(forbidden);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

it('rejects a config beneath a linked home even if the config does not exist', () => {
  const dir = home();
  try {
    symlinkSync(userInfo().homedir, path.join(dir, 'linked'), 'dir');
    vi.stubEnv('SINTER_PROOF_ISOLATION', '1');
    vi.stubEnv('SINTER_CONFIG_PATH', path.join(dir, 'linked', '..proof-fixture', 'absent'));
    expect(() => resolveUserConfigPath()).toThrow(/PROOF_ISOLATION_REAL_STATE_FORBIDDEN/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

it('requires an isolated spawn home and permits an explicit opt-out', async () => {
  const dir = home();
  try {
    const env = fakeProviderEnv({ baseUrl: 'about:blank' },
      { home: dir, stateRoot: path.join(dir, 'state') });
    expect(env.SINTER_PROOF_ISOLATION).toBe('1');
    expect(() => runSinterAsync(['--version'], { ...env, HOME: userInfo().homedir }, dir)).toThrow(/PROOF_ISOLATION_REAL_STATE_FORBIDDEN/);
    expect((await runSinterAsync(['--version'], env, dir)).status).toBe(0);
    expect((await runSinterAsync(['--version'], { ...env, SINTER_CONFIG_PATH: forbidden, SINTER_PROOF_REAL_STATE: '1' }, dir)).status).toBe(0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
