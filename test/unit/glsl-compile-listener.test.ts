import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

describe('shader compiler module lifecycle', () => {
  it('does not accumulate process exit listeners on repeated imports', () => {
    const script = `
      const before = process.listenerCount('exit');
      for (let i = 0; i < 12; i++) await import('./src/utils/glsl-compile-check.ts?instance=' + i);
      console.log(process.listenerCount('exit') - before);
    `;
    const result = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], {
      cwd: process.cwd(), env: { PATH: process.env.PATH, NODE_ENV: 'test' }, encoding: 'utf8', timeout: 15_000,
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe('0');
  });
});
