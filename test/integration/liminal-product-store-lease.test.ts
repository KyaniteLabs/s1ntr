import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
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
  delete process.env.LIMINAL_PRODUCT_STORE_LEASE_MAX_WAIT_MS;
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

  it('honors a short deadline while another process holds the stale-reclaim mutex', async () => {
    const file = await storeFile();
    const name = (await import('node:crypto')).createHash('sha256').update('dead').digest('hex').slice(0, 16);
    const lease = path.join(`${file}.leases`, `${name}.lease`);
    await mkdir(lease, { recursive: true });
    const old = new Date(Date.now() - 60_000);
    await utimes(lease, old, old);
    await mkdir(`${lease}.reclaim`);

    const store = new FileLiminalProductCommandStore(file, { leaseTimeoutMs: 100 });
    await expect(store.withLease('dead', async () => 'stolen')).rejects.toThrow(/LIMINAL_PRODUCT_STORE_LEASE_TIMEOUT/);
  }, 2_000);

  it('times out with a coded error that names the holder, honoring the env timeout', async () => {
    process.env.LIMINAL_PRODUCT_STORE_LEASE_TIMEOUT_MS = '150';
    process.env.LIMINAL_PRODUCT_STORE_LEASE_MAX_WAIT_MS = '150';
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

  it('waits past the base timeout while the holder is alive and heartbeating (nbe r7 RCA)', async () => {
    const file = await storeFile();
    const a = new FileLiminalProductCommandStore(file, { leaseTimeoutMs: 5_000 });
    const b = new FileLiminalProductCommandStore(file,
      { leaseTimeoutMs: 100, leaseMaxWaitMs: 5_000, onLeaseWait: () => undefined });
    const events: string[] = [];
    const holding = a.withLease('long', async () => { await sleep(500); events.push('a:end'); });
    await sleep(30);
    await b.withLease('long', async () => { events.push('b:start'); });   // 100 ms base timeout, 500 ms holder
    await holding;
    expect(events).toEqual(['a:end', 'b:start']);
  });

  it('reclaims a lease whose holder died, and never evicts a live pid with a stale heartbeat', async () => {
    const file = await storeFile();
    const store = new FileLiminalProductCommandStore(file, { leaseTimeoutMs: 400, leaseMaxWaitMs: 400, onLeaseWait: () => undefined });
    const name = (await import('node:crypto')).createHash('sha256').update('dead').digest('hex').slice(0, 16);
    const lease = path.join(`${file}.leases`, `${name}.lease`);
    await mkdir(lease, { recursive: true });
    await writeFile(path.join(lease, 'owner.json'), JSON.stringify({ token: 'x', pid: 2_147_483_000 }));
    const old = new Date(Date.now() - 60_000);
    await utimes(lease, old, old);
    await expect(store.withLease('dead', async () => 'took over')).resolves.toBe('took over');
    // live pid (this process) but heartbeat older than 20 s: not evicted, waiter times out
    const liveName = (await import('node:crypto')).createHash('sha256').update('live').digest('hex').slice(0, 16);
    const live = path.join(`${file}.leases`, `${liveName}.lease`);
    await mkdir(live, { recursive: true });
    await writeFile(path.join(live, 'owner.json'), JSON.stringify({ token: 'y', pid: process.pid }));
    await utimes(live, old, old);
    await expect(store.withLease('live', async () => 'stolen')).rejects.toThrow(/LIMINAL_PRODUCT_STORE_LEASE_TIMEOUT/);
  });

  it('N parallel generates on one store run the work exactly once and all see its result', async () => {
    const file = await storeFile();
    const stores = Array.from({ length: 8 }, () =>
      new FileLiminalProductCommandStore(file, { leaseTimeoutMs: 100, leaseMaxWaitMs: 20_000, onLeaseWait: () => undefined }));
    let runs = 0;
    const generate = (store: FileLiminalProductCommandStore) => store.withLease('production-create:abc', async () => {
      const done = await store.read('production-create:abc');
      if (done) return done;       // replay, as ProductCommandPort.settle does
      runs += 1;
      await sleep(250);            // longer than every waiter's base timeout
      const made = projection('made');
      await store.write('production-create:abc', made);
      return made;
    });
    const results = await Promise.all(stores.map(generate));
    expect(runs).toBe(1);
    for (const r of results) expect(r).toEqual(projection('made'));
  });

  it('stale-lease reclaim by many waiters never yields two holders', async () => {
    const file = await storeFile();
    const crypto = await import('node:crypto');
    const lease = path.join(`${file}.leases`, `${crypto.createHash('sha256').update('race').digest('hex').slice(0, 16)}.lease`);
    await mkdir(lease, { recursive: true });
    await writeFile(path.join(lease, 'owner.json'), JSON.stringify({ token: 'dead', pid: 2_147_483_000 }));
    const old = new Date(Date.now() - 60_000);
    await utimes(lease, old, old);
    let inside = 0, maxInside = 0;
    await Promise.all(Array.from({ length: 10 }, () =>
      new FileLiminalProductCommandStore(file, { leaseTimeoutMs: 20_000, onLeaseWait: () => undefined })
        .withLease('race', async () => { inside += 1; maxInside = Math.max(maxInside, inside); await sleep(20); inside -= 1; })));
    expect(maxInside).toBe(1);
  });
});
