import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FileLiminalProductCommandStore, type LiminalProductProjection }
  from '../../src/runtime-core/LiminalProductCommandPort.js';

const projection = (id: string) => ({ id }) as unknown as LiminalProductProjection;
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const dirs: string[] = [];
const storeFile = async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'liminal-lease-'));
  dirs.push(dir);
  return path.join(dir, 'products.json');
};

afterEach(async () => {
  delete process.env.LIMINAL_PRODUCT_STORE_LEASE_TIMEOUT_MS;
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

describe('FileLiminalProductCommandStore lease (#707)', () => {
  it('queues a second concurrent acquirer, announces the holder, and keeps single-writer order', async () => {
    const file = await storeFile();
    const waits: string[] = [];
    const a = new FileLiminalProductCommandStore(file, { leaseTimeoutMs: 5_000 });
    const b = new FileLiminalProductCommandStore(file,
      { leaseTimeoutMs: 5_000, onLeaseWait: holder => waits.push(holder) });
    const events: string[] = [];
    const first = a.withLease('k1', async () => {
      events.push('a:start'); await sleep(300); events.push('a:end');
    });
    await sleep(50);
    const second = b.withLease('k1', async () => {
      events.push('b:start'); events.push('b:end');
    });
    await Promise.all([first, second]);
    expect(events).toEqual(['a:start', 'a:end', 'b:start', 'b:end']);
    expect(waits).toEqual([`pid ${process.pid}`]);
  });

  it('runs different keys concurrently even when the wait timeout is below the operation time', async () => {
    const file = await storeFile();
    const a = new FileLiminalProductCommandStore(file, { leaseTimeoutMs: 150 });
    const b = new FileLiminalProductCommandStore(file, { leaseTimeoutMs: 150, onLeaseWait: () => undefined });
    const slow = a.withLease('k1', async () => {
      await sleep(300);
      await a.write('k1', projection('one'));
    });
    await sleep(50);
    const fast = b.withLease('k2', async () => { await b.write('k2', projection('two')); });
    await Promise.all([slow, fast]);
    expect(await a.read('k1')).toEqual(projection('one'));
    expect(await a.read('k2')).toEqual(projection('two'));
  });

  it('single-flights the same key across instances: the waiter sees the persisted result', async () => {
    const file = await storeFile();
    const a = new FileLiminalProductCommandStore(file, { leaseTimeoutMs: 5_000 });
    const b = new FileLiminalProductCommandStore(file,
      { leaseTimeoutMs: 5_000, onLeaseWait: () => undefined });
    let runs = 0;
    const settle = (store: FileLiminalProductCommandStore) => store.withLease('same', async () => {
      const persisted = await store.read('same');
      if (persisted) return persisted;
      runs += 1;
      await sleep(200);
      const made = projection(`run-${runs}`);
      await store.write('same', made);
      return made;
    });
    const first = settle(a);
    await sleep(50);
    const [r1, r2] = await Promise.all([first, settle(b)]);
    expect(runs).toBe(1);
    expect(r1).toEqual(projection('run-1'));
    expect(r2).toEqual(projection('run-1'));
  });

  it('keeps both keys when two instances write different keys at once', async () => {
    const file = await storeFile();
    const stores = [new FileLiminalProductCommandStore(file), new FileLiminalProductCommandStore(file)];
    for (let round = 0; round < 10; round += 1) {
      await Promise.all(stores.map((store, i) => store.write(`r${round}-${i}`, projection(`${round}-${i}`))));
    }
    for (let round = 0; round < 10; round += 1) {
      expect(await stores[0].read(`r${round}-0`)).toEqual(projection(`${round}-0`));
      expect(await stores[0].read(`r${round}-1`)).toEqual(projection(`${round}-1`));
    }
  });

  it('times out with a coded error that names the holder, honoring the env timeout', async () => {
    process.env.LIMINAL_PRODUCT_STORE_LEASE_TIMEOUT_MS = '150';
    const file = await storeFile();
    const a = new FileLiminalProductCommandStore(file, { leaseTimeoutMs: 5_000 });
    const b = new FileLiminalProductCommandStore(file, { onLeaseWait: () => undefined });
    const holding = a.withLease('k1', () => sleep(1_000));
    await sleep(50);
    const error = await b.withLease('k1', async () => 'never').catch((e: Error) => e);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/^LIMINAL_PRODUCT_STORE_LEASE_TIMEOUT: /);
    expect((error as Error).message).toContain(`held by pid ${process.pid}`);
    expect((error as Error).message).toContain('after 150ms');
    await holding;
  });
});
