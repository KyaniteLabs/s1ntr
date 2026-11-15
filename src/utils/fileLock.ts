/**
 * Cross-process exclusive lock on a sidecar `.lock` file.
 *
 * `open(path, 'wx')` fails when the file exists, so only one process (or one
 * caller in this process) holds the lock at a time. A lock left behind by a
 * crashed holder is taken over once it is older than `staleMs`.
 */

import { open, stat, unlink } from 'node:fs/promises';
import { openSync, closeSync, writeSync, statSync, unlinkSync } from 'node:fs';

export interface FileLockOptions {
  /** Give up waiting after this long (default 10s). */
  timeoutMs?: number;
  /** Treat a lock file older than this as abandoned (default 30s). */
  staleMs?: number;
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

export async function withFileLock<T>(
  lockPath: string,
  fn: () => Promise<T>,
  options: FileLockOptions = {},
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? 10_000;
  const staleMs = options.staleMs ?? 30_000;
  const startedAt = Date.now();
  for (;;) {
    let handle;
    try {
      handle = await open(lockPath, 'wx');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const lockStat = await stat(lockPath).catch(() => null);
      if (lockStat && Date.now() - lockStat.mtimeMs > staleMs) {
        await unlink(lockPath).catch(() => undefined);
        continue;
      }
      if (Date.now() - startedAt >= timeoutMs) {
        throw new Error(`FILE_LOCK_TIMEOUT: ${lockPath}`);
      }
      await sleep(10 + Math.floor(Math.random() * 15));
      continue;
    }
    try {
      await handle.writeFile(`${process.pid}\n`);
      return await fn();
    } finally {
      await handle.close();
      await unlink(lockPath).catch(() => undefined);
    }
  }
}

/**
 * Synchronous variant of {@link withFileLock} for read-modify-write code that
 * cannot be async (e.g. static, synchronous ledgers). Same `wx` lock file and
 * stale-takeover rules; waits by blocking on a short `Atomics.wait`.
 */
export function withFileLockSync<T>(
  lockPath: string,
  fn: () => T,
  options: FileLockOptions = {},
): T {
  const timeoutMs = options.timeoutMs ?? 10_000;
  const staleMs = options.staleMs ?? 30_000;
  const startedAt = Date.now();
  const pause = new Int32Array(new SharedArrayBuffer(4));
  for (;;) {
    let fd: number;
    try {
      fd = openSync(lockPath, 'wx');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      try {
        if (Date.now() - statSync(lockPath).mtimeMs > staleMs) {
          unlinkSync(lockPath);
          continue;
        }
      } catch { /* lock vanished between open and stat: retry */ }
      if (Date.now() - startedAt >= timeoutMs) {
        throw new Error(`FILE_LOCK_TIMEOUT: ${lockPath}`);
      }
      Atomics.wait(pause, 0, 0, 5 + Math.floor(Math.random() * 10));
      continue;
    }
    try {
      writeSync(fd, `${process.pid}\n`);
      return fn();
    } finally {
      closeSync(fd);
      try { unlinkSync(lockPath); } catch { /* already gone */ }
    }
  }
}
