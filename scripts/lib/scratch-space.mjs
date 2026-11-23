// Script-side twin of src/utils/scratchSpace.ts (same env names, same rules): browser profile dirs go to system temp,
// never onto the data volume, and a low-disk host fails with a plain message instead of crashing Chromium mid-render.
//   SINTER_BROWSER_TMP=<dir>  choose the temp dir     SINTER_DATA_VOLUME=<path>  (default /srv/models-nvme)
//   SINTER_MIN_FREE_MB=<n>    threshold (default 512)  SINTER_SKIP_DISK_PREFLIGHT=1  turn the check off
import { mkdirSync, statfsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, sep } from 'node:path';

const under = (p, r) => { p = resolve(p); r = resolve(r); return p === r || p.startsWith(r + sep); };

export function browserTmpDir(env = process.env, current = tmpdir()) {
  const explicit = env.SINTER_BROWSER_TMP?.trim();
  // Chromium adds a profile name and SingletonSocket to the Unix socket path.
  const candidate = resolve(explicit || current);
  if (process.platform !== 'win32' && Buffer.byteLength(candidate) > 40) {
    if (explicit) throw new Error('SINTER_BROWSER_TMP must be at most 40 bytes for a browser socket');
    return '/tmp';
  }
  if (explicit) return candidate;
  return under(current, env.SINTER_DATA_VOLUME?.trim() || '/srv/models-nvme') ? '/tmp' : current;
}

export function prepareBrowserScratch(env = process.env, probe = (d) => { try { const s = statfsSync(d); return Math.floor(Number(s.bavail) * Number(s.bsize) / 1048576); } catch { return null; } }) {
  const cur = env.TMPDIR?.trim() || tmpdir();
  const dir = browserTmpDir(env, cur);
  if (resolve(dir) !== resolve(cur)) { try { mkdirSync(dir, { recursive: true }); } catch {} env.TMPDIR = dir; }
  if (env.SINTER_SKIP_DISK_PREFLIGHT !== '1') {
    const min = Number(env.SINTER_MIN_FREE_MB) > 0 ? Number(env.SINTER_MIN_FREE_MB) : 512;
    const free = probe(dir);
    if (free !== null && free < min) {
      throw new Error(`Not enough free disk space to render: ${free} MB free under ${dir}, need at least ${min} MB. Free some space, or point SINTER_BROWSER_TMP at a roomier directory, or lower SINTER_MIN_FREE_MB. Nothing was started.`);
    }
  }
  return dir;
}
