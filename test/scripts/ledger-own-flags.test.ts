import { spawnSync } from 'node:child_process';
import { rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { expect, it } from 'vitest';
import { isolatedCliEnv } from '../helpers/isolatedCli.js';

it('lets ledger interpret arguments that also spell global flags', () => {
  const { env, home } = isolatedCliEnv({ SINTER_OFFLINE: '1' });
  const run = (...args: string[]) => spawnSync(process.execPath, [path.resolve('bin/sinter'), 'ledger', ...args],
    { cwd: home, env, encoding: 'utf8', timeout: 30_000 });
  try {
    writeFileSync(path.join(home, '--version'), '[]');
    const load = run('load', '--version');
    expect(load.status, load.stderr).toBe(0);
    expect(load.stdout).toMatch(/Loaded 0/i);
    const batch = run('batch', '--max-tasks', '1', '--dry-run');
    expect(batch.status, batch.stderr).toBe(0);
    expect(batch.stdout).toContain('(max 1)');
    const query = run('query', '--limit', 'invalid');
    expect(query.status).not.toBe(0);
    expect(query.stderr).toContain('--limit');
  } finally { rmSync(home, { recursive: true, force: true }); }
});
