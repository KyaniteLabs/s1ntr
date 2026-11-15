import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

const regression = fileURLToPath(new URL('./test_p1_art_adapter.py', import.meta.url));

it('enforces the native P1 Product adapter security and evidence contract', () => {
  const result = spawnSync('python3', [regression, '-v'], {
    encoding: 'utf8', timeout: 30_000,
  });
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
  expect(result.stderr).toContain('Ran 16 tests');
  expect(result.stderr).toContain('OK');
});
