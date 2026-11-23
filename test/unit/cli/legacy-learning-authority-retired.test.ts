import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { isolatedCliEnv } from '../../helpers/isolatedCli.js';

describe('legacy learning authority retirement', () => {
  it('retires consolidate and rejects the removed flag without loading learning stores', async () => {
    const command = spawnSync(process.execPath, ['bin/sinter', 'consolidate'], {
      cwd: process.cwd(), encoding: 'utf8', env: { ...isolatedCliEnv().env, NODE_ENV: 'test' },
    });
    expect(command.status).toBe(2);
    expect(command.stderr).toContain('use governed Dream transfer and activation');
    const flag = spawnSync(process.execPath, ['bin/sinter', '--consolidate'], {
      cwd: process.cwd(), encoding: 'utf8', env: { ...isolatedCliEnv().env, NODE_ENV: 'test' },
    });
    expect(flag.status).toBe(1);
    expect(flag.stderr).toContain('Unknown option: --consolidate');

    const source = await readFile(path.join(process.cwd(), 'bin', 'sinter'), 'utf8');
    const start = source.indexOf("cmd === 'consolidate'");
    const block = source.slice(start, source.indexOf("cmd === 'bridge'", start));
    expect(block).not.toMatch(/HarnessMemory|MemoryConsolidator|qualityScore|\.score/);
  });
});
