import { afterAll, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { home } = vi.hoisted(() => ({ home: { value: '' } }));
vi.mock('os', async importOriginal => ({ ...await importOriginal<typeof import('os')>(), homedir: () => home.value }));
home.value = mkdtempSync(join(tmpdir(), 'sinter-retention-'));
afterAll(() => rmSync(home.value, { recursive: true, force: true }));

it('retains every original byte across pruning and repeated construction', async () => {
  const dir = join(home.value, '.sinter/failures');
  mkdirSync(dir, { recursive: true });
  for (let i = 0; i < 502; i++) writeFileSync(join(dir, `${i}-abcdefghi.json`), `original ${i}\n`);
  const { FailureLogger } = await import('../../../src/harness/FailureLogger.js');
  new FailureLogger();
  new FailureLogger();
  expect(readdirSync(dir).filter(f => f.endsWith('.json'))).toHaveLength(500);
  for (let i = 0; i < 502; i++) {
    expect(readFileSync(join(dir, i < 2 ? 'archive' : '', `${i}-abcdefghi.json`), 'utf8')).toBe(`original ${i}\n`);
  }
});
