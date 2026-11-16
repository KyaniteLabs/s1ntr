import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

describe('public entrypoint without executor credentials', () => {
  it('keeps pure imports free of trust material and binds initialization to the host key', () => {
    const root = mkdtempSync(join(tmpdir(), 'sinter-pure-entrypoint-'));
    try {
      const preload = join(root, 'homedir.cjs');
      writeFileSync(preload, `require('node:os').homedir = () => ${JSON.stringify(root)};`);
      const script = `
        const { existsSync, statSync } = await import('node:fs');
        const keyPath = ${JSON.stringify(join(root, '.sinter', 'executor-authority', 'trust-key.json'))};
        const { CompositionEngine, metaHarness } = await import('./src/index.ts');
        if (typeof CompositionEngine !== 'function') throw new Error('missing pure API');
        if (existsSync(keyPath)) throw new Error('pure import wrote trust material');
        await metaHarness.initialize();
        if (!existsSync(keyPath) || (statSync(keyPath).mode & 0o777) !== 0o600) {
          throw new Error('initialization did not bind a private host trust key');
        }
        console.log('pure import and authority check passed');
      `;
      const result = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], {
        cwd: process.cwd(),
        env: { PATH: process.env.PATH, NODE_ENV: 'production', NODE_OPTIONS: `--require=${preload}` },
        encoding: 'utf8', timeout: 30_000,
      });
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain('pure import and authority check passed');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 35_000);
});
