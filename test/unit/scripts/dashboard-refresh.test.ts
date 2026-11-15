import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const regression = fileURLToPath(new URL('../atelier/test_dashboard_refresh.py', import.meta.url));

describe('S1NTR dashboard refresh safety', () => {
  it('preserves the served generation and enforces single-writer/no-cache behavior', () => {
    const result = spawnSync('python3', [regression, '-v'], {
      encoding: 'utf8', timeout: 15_000,
      env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
    });
    expect(result.error, result.stderr).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toMatch(/Ran [1-9]\d* tests/);
    expect(result.stderr).toMatch(/\nOK(?: \(skipped=\d+\))?\s*$/);
  }, 30_000);
});
