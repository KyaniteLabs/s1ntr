import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

it('recalculates with immutable originals, verified receipts and bounded admission', () => {
  const harness = fileURLToPath(new URL('../../fixtures/legacy_recalculation_regressions.py', import.meta.url));
  const result = spawnSync('python3', [harness, '-v'], {
    encoding: 'utf8', timeout: 15_000,
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
  });
  expect(result.status, result.stderr).toBe(0);
  expect(result.stderr).toMatch(/\nOK\s*$/);
});
