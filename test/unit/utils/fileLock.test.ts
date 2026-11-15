import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile, utimes, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withFileLock, withFileLockSync } from '../../../src/utils/fileLock.js';

const exists = (p: string) => access(p).then(() => true, () => false);

describe('withFileLock', () => {
  let dir: string;
  let lock: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'file-lock-'));
    lock = join(dir, 'x.lock');
  });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  it('runs callers one at a time and returns each result', async () => {
    const order: string[] = [];
    const run = (name: string) => withFileLock(lock, async () => {
      order.push(`${name}:in`);
      await new Promise(r => setTimeout(r, 20));
      order.push(`${name}:out`);
      return name;
    });
    const results = await Promise.all([run('a'), run('b'), run('c')]);
    expect(results).toEqual(['a', 'b', 'c']);
    for (let i = 0; i < order.length; i += 2) {
      expect(order[i]!.replace(':in', '')).toBe(order[i + 1]!.replace(':out', ''));
    }
    expect(await exists(lock)).toBe(false);
  });

  it('releases the lock when the callback throws', async () => {
    await expect(withFileLock(lock, async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    expect(await exists(lock)).toBe(false);
    expect(await withFileLock(lock, async () => 7)).toBe(7);
  });

  it('times out while a fresh lock is held', async () => {
    await writeFile(lock, '999\n');
    await expect(withFileLock(lock, async () => 1, { timeoutMs: 60 }))
      .rejects.toThrow(`FILE_LOCK_TIMEOUT: ${lock}`);
    expect(await exists(lock)).toBe(true);
  });

  it('takes over a lock abandoned by a crashed holder', async () => {
    await writeFile(lock, '999\n');
    const old = new Date(Date.now() - 60_000);
    await utimes(lock, old, old);
    expect(await withFileLock(lock, async () => 'taken', { staleMs: 30_000, timeoutMs: 200 })).toBe('taken');
    expect(await exists(lock)).toBe(false);
  });

  it('surfaces errors other than an existing lock', async () => {
    await expect(withFileLock(join(dir, 'missing', 'x.lock'), async () => 1))
      .rejects.toThrow(/ENOENT/);
  });

  describe('withFileLockSync', () => {
    it('returns the result and releases the lock, including after a throw', async () => {
      expect(withFileLockSync(lock, () => 5)).toBe(5);
      expect(await exists(lock)).toBe(false);
      expect(() => withFileLockSync(lock, () => { throw new Error('boom'); })).toThrow('boom');
      expect(await exists(lock)).toBe(false);
    });

    it('times out while a fresh lock is held and leaves it alone', async () => {
      await writeFile(lock, '999\n');
      expect(() => withFileLockSync(lock, () => 1, { timeoutMs: 60 })).toThrow(`FILE_LOCK_TIMEOUT: ${lock}`);
      expect(await exists(lock)).toBe(true);
    });

    it('takes over a stale lock', async () => {
      await writeFile(lock, '999\n');
      const old = new Date(Date.now() - 60_000);
      await utimes(lock, old, old);
      expect(withFileLockSync(lock, () => 'taken', { staleMs: 30_000, timeoutMs: 200 })).toBe('taken');
      expect(await exists(lock)).toBe(false);
    });
  });
});
