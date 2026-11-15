import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

const fixture = fileURLToPath(new URL('../../fixtures/improvement_watch_regressions.py', import.meta.url));

it('streams improvement history with parity and atomic failure handling', () => {
  const result = spawnSync('python3', [fixture, '-v'], {
    encoding: 'utf8', timeout: 30_000,
  });
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
  expect(result.stderr).toContain('Ran 4 tests');
  expect(result.stderr).toContain('OK');
});
