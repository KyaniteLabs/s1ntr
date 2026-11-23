/**
 * mkdir-based cross-process lease shared by the product store and the command journal.
 *
 * RCA (2026-11-18, nbe r7 runs): a creation that legitimately ran longer than the 90 s wait left its waiters failing
 * with LIMINAL_PRODUCT_STORE_LEASE_TIMEOUT although the holder was alive and heartbeating. The wait was a flat
 * deadline; it never asked whether the holder was healthy. Second defect found beside it: two waiters that both saw a
 * stale lease could each `rm` it, and the slower `rm` could delete a lease the faster one had just re-created, giving
 * two holders. Fixes here:
 *  - wait up to maxWaitMs while the holder is healthy (pid alive AND heartbeat fresher than staleMs); an unhealthy
 *    holder gets only timeoutMs. A live pid is never evicted.
 *  - stale reclaim runs under a `<lease>.reclaim` mutex and re-checks staleness inside it.
 *  - a failed owner.json write removes the half-made lease instead of leaving it for staleMs.
 */
import { mkdir, readFile, rm, stat } from 'node:fs/promises';
import { writeFileAtomic } from './atomicWrite.js';

export const LEASE_STALE_MS = 20_000;
const RECLAIM_LOCK_STALE_MS = 10_000;
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const code = (error: unknown) => (error as NodeJS.ErrnoException).code;

export class LeaseTimeoutError extends Error {
  constructor(readonly lease: string, readonly holder: string, readonly waitedMs: number /* the wait budget that ran out */) {
    super(`lease ${lease} held by ${holder} after ${waitedMs}ms`);
    this.name = 'LeaseTimeoutError';
  }
}

export async function leaseHolderPid(lease: string): Promise<number | null> {
  try {
    const owner = JSON.parse(await readFile(`${lease}/owner.json`, 'utf8')) as { pid?: number };
    return Number.isSafeInteger(owner.pid) && owner.pid! > 0 ? owner.pid! : null;
  } catch { return null; }
}

function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (error) { return code(error) === 'EPERM'; }
}

export async function leaseOwnerAlive(lease: string): Promise<boolean> {
  const pid = await leaseHolderPid(lease);
  return pid !== null && pidAlive(pid);
}

export async function leaseHolderLabel(lease: string): Promise<string> {
  const pid = await leaseHolderPid(lease);
  return pid === null ? 'unknown holder' : `pid ${pid}`;
}

async function reclaimIfStale(lease: string, staleMs: number): Promise<boolean> {
  const mutex = `${lease}.reclaim`;
  try {
    await mkdir(mutex);
  } catch (error) {
    if (code(error) !== 'EEXIST') throw error;
    try {
      if (Date.now() - (await stat(mutex)).mtimeMs > RECLAIM_LOCK_STALE_MS) await rm(mutex, { recursive: true, force: true });
    } catch (inner) { if (code(inner) !== 'ENOENT') throw inner; }
    return false;
  }
  try {
    const age = Date.now() - (await stat(lease)).mtimeMs;
    if (age <= staleMs || await leaseOwnerAlive(lease)) return false;
    await rm(lease, { recursive: true, force: true });
    return true;
  } catch (error) {
    if (code(error) !== 'ENOENT') throw error;
    return true;
  } finally {
    await rm(mutex, { recursive: true, force: true });
  }
}

export interface AcquireOptions {
  lease: string;
  token: string;
  pid?: number;
  /** Wait budget when the holder is not healthy. */
  timeoutMs: number;
  /** Wait budget while the holder is healthy (>= timeoutMs). */
  maxWaitMs?: number;
  staleMs?: number;
  pollMs?: number;
  onWait?: (holder: string) => void;
}

/** Take the lease or throw LeaseTimeoutError. The caller owns heartbeat and release. */
export async function acquireDirLease(options: AcquireOptions): Promise<void> {
  const { lease, token, timeoutMs, onWait } = options;
  const staleMs = options.staleMs ?? LEASE_STALE_MS;
  const maxWaitMs = Math.max(options.maxWaitMs ?? timeoutMs, timeoutMs);
  const poll = options.pollMs ?? 25;
  const start = Date.now();
  let announced = false;
  for (;;) {
    try {
      await mkdir(lease);
      try {
        await writeFileAtomic(`${lease}/owner.json`, `${JSON.stringify({ token, pid: options.pid ?? process.pid })}\n`);
      } catch (error) {
        await rm(lease, { recursive: true, force: true });
        throw error;
      }
      return;
    } catch (error) {
      if (code(error) !== 'EEXIST') throw error;
    }
    let healthy = false;
    try {
      const age = Date.now() - (await stat(lease)).mtimeMs;
      const pid = await leaseHolderPid(lease);   // one read: owner.json may appear between two
      const alive = pid !== null && pidAlive(pid);
      if (age > staleMs && !alive && await reclaimIfStale(lease, staleMs)) continue;
      // A fresh lease with no readable owner.json is a holder between mkdir and its owner write: healthy.
      healthy = age <= staleMs && (alive || pid === null);
    } catch (error) {
      if (code(error) !== 'ENOENT') throw error;
      continue;   // released between our mkdir and stat
    }
    const waited = Date.now() - start;
    const budget = healthy ? maxWaitMs : timeoutMs;
    if (waited >= budget) {
      throw new LeaseTimeoutError(lease, await leaseHolderLabel(lease), budget);
    }
    if (!announced) { announced = true; onWait?.(await leaseHolderLabel(lease)); }
    await sleep(poll);
  }
}
