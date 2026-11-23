/**
 * Where browsers put their temporary profile, and a free-space check before they start.
 *
 * Why (2026-11-18): the data volume (/srv/models-nvme) hit 100%, and Chromium crashed mid-render because its
 * profile directory (puppeteer and playwright both create it under os.tmpdir()) sat on that volume.
 *
 *  - useSystemTmpForBrowsers(): when os.tmpdir() resolves under the data volume, point TMPDIR at system temp
 *    instead. Override: SINTER_BROWSER_TMP=<dir> picks the directory explicitly (any location, including the volume).
 *  - assertFreeSpace(dir): throws LowDiskError with a plain message when the free space under the threshold
 *    (SINTER_MIN_FREE_MB, default 512) instead of letting Chromium crash halfway through a render.
 *    SINTER_SKIP_DISK_PREFLIGHT=1 turns the check off.
 *  - prepareBrowserScratch(): both, called before every browser launch.
 */
import { mkdirSync, statfsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, sep } from 'node:path';

export const DEFAULT_DATA_VOLUME = '/srv/models-nvme';
export const DEFAULT_MIN_FREE_MB = 512;
const SYSTEM_TMP = '/tmp';

export class LowDiskError extends Error {
  constructor(
    readonly dir: string,
    readonly freeMb: number,
    readonly minMb: number,
  ) {
    super(
      `Not enough free disk space to render: ${freeMb} MB free under ${dir}, need at least ${minMb} MB. `
      + `Free some space, or point SINTER_BROWSER_TMP at a roomier directory, `
      + `or lower SINTER_MIN_FREE_MB. Nothing was started.`,
    );
    this.name = 'LowDiskError';
  }
}

function under(path: string, root: string): boolean {
  const p = resolve(path), r = resolve(root);
  return p === r || p.startsWith(r + sep);
}

/** The directory browsers should use for their temp profile. Pure: reads env only. */
export function browserTmpDir(env: NodeJS.ProcessEnv = process.env, current: string = tmpdir()): string {
  const explicit = env.SINTER_BROWSER_TMP?.trim();
  // Chromium adds a profile name and SingletonSocket to the Unix socket path.
  const candidate = resolve(explicit || current);
  if (process.platform !== 'win32' && Buffer.byteLength(candidate) > 40) {
    if (explicit) throw new Error('SINTER_BROWSER_TMP must be at most 40 bytes for a browser socket');
    return '/tmp';
  }
  if (explicit) return candidate;
  const volume = env.SINTER_DATA_VOLUME?.trim() || DEFAULT_DATA_VOLUME;
  return under(current, volume) ? SYSTEM_TMP : current;
}

/** Redirect TMPDIR away from the data volume (or to SINTER_BROWSER_TMP). Idempotent. Returns the directory in force. */
export function useSystemTmpForBrowsers(env: NodeJS.ProcessEnv = process.env): string {
  const dir = browserTmpDir(env, env.TMPDIR?.trim() || tmpdir());
  if (resolve(dir) !== resolve(env.TMPDIR?.trim() || tmpdir())) {
    try { mkdirSync(dir, { recursive: true }); } catch { /* the free-space check reports an unusable dir */ }
    env.TMPDIR = dir;
  }
  return dir;
}

export function freeMb(dir: string): number | null {
  try {
    const s = statfsSync(dir);
    return Math.floor((Number(s.bavail) * Number(s.bsize)) / (1024 * 1024));
  } catch {
    return null;
  }
}

export function assertFreeSpace(dir: string, env: NodeJS.ProcessEnv = process.env, probe: (d: string) => number | null = freeMb): number | null {
  if (env.SINTER_SKIP_DISK_PREFLIGHT === '1') return null;
  const minMb = Number(env.SINTER_MIN_FREE_MB) > 0 ? Number(env.SINTER_MIN_FREE_MB) : DEFAULT_MIN_FREE_MB;
  const free = probe(dir);
  if (free !== null && free < minMb) throw new LowDiskError(dir, free, minMb);
  return free;
}

export function prepareBrowserScratch(env: NodeJS.ProcessEnv = process.env): string {
  const dir = useSystemTmpForBrowsers(env);
  assertFreeSpace(dir, env);
  return dir;
}
