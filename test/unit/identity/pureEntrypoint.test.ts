import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

describe('public entrypoint without executor credentials', () => {
  it('allows pure imports while refusing harness initialization', () => {
    const root = mkdtempSync(join(tmpdir(), 'sinter-pure-entrypoint-'));
    try {
      const preload = join(root, 'homedir.cjs');
      writeFileSync(preload, `require('node:os').homedir = () => ${JSON.stringify(root)};`);
      const script = `
        const { CompositionEngine, metaHarness } = await import('./src/index.ts');
        if (typeof CompositionEngine !== 'function') throw new Error('missing pure API');
        try { await metaHarness.initialize(); throw new Error('authority bypassed'); }
        catch (error) {
          if (!String(error).includes('EXECUTOR_AUTHORITY_UNAVAILABLE')) throw error;
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
