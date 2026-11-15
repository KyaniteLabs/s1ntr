/**
 * SinterCompact — reclaim local `~/.sinter` state safely.
 *
 * Dry-run by default. Explicit execute runs:
 * - orphaned tmp-file sweep (refusal boundaries for objects/refs/dreams/config)
 * - FailureLogger retention (newest 500)
 * - HarnessMemory episode trim on save
 * - EventStore per-type retention + conditional VACUUM (when project.sinter present)
 * - lineage / reasoning / thinking-traces age trim (90 days)
 *
 * @module cli/SinterCompact
 */

import {
  existsSync,
  readdirSync,
  statSync,
  unlinkSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { join, relative, sep } from 'node:path';
import { homedir } from 'node:os';
import { EventStore } from '../compost/EventStore.js';
import {
  MAX_RETAINED_EPISODES,
  MAX_EPISODE_CODE_BYTES,
  truncateEpisodeCodeForCompact,
  type HarnessMemoryState,
} from '../harness/HarnessMemory.js';
import { MAX_FAILURE_RECORDS, archiveFailureRecord } from '../harness/FailureLogger.js';

export const LINEAGE_RETENTION_DAYS = 90;

/** Path segments (under the compact root) that must never be written/deleted. */
export const PROTECTED_SEGMENTS = ['objects', 'refs'] as const;

/** Files under the compact root that must never be written/deleted. */
export const PROTECTED_FILES = [
  'config.json',
  join('dreams', 'queue.json'),
] as const;

export interface CompactStoreReport {
  store: string;
  path: string;
  currentBytes: number;
  policy: string;
  reclaimEstimateBytes: number;
  protected?: boolean;
  detail?: string;
}

export interface CompactOptions {
  /** Absolute path to the state root (default: ~/.sinter). */
  root?: string;
  /** When false (default), only estimate. When true, perform deletes. */
  execute?: boolean;
  /** Clock override for tests. */
  now?: Date;
}

/** Failures hit while compacting; ENOENT races are not failures. */
export interface CompactFailures {
  count: number;
  /** First few failing paths (capped at MAX_REPORTED_FAILURE_PATHS). */
  paths: string[];
}

export const MAX_REPORTED_FAILURE_PATHS = 5;

export interface CompactResult {
  root: string;
  executed: boolean;
  stores: CompactStoreReport[];
  totalReclaimEstimateBytes: number;
  reclaimedBytes: number;
  actions: string[];
  failed: CompactFailures;
}

function isEnoent(err: unknown): boolean {
  return (err as NodeJS.ErrnoException | null)?.code === 'ENOENT';
}

/**
 * Record a failed fs operation. ENOENT means the file vanished under us (a
 * concurrent writer or sweep), which is expected and stays silent; anything
 * else is counted and its path kept for the summary.
 */
function recordFailure(failed: CompactFailures, path: string, err: unknown): void {
  if (isEnoent(err)) return;
  failed.count += 1;
  if (failed.paths.length < MAX_REPORTED_FAILURE_PATHS) failed.paths.push(path);
}

export function defaultSinterRoot(): string {
  return join(homedir(), '.sinter');
}

export function isTempFilename(name: string): boolean {
  // Harness/atomic temps: foo.tmp-XXXX, .tmp-*, trailing .tmp — not .tmpl templates.
  if (name.endsWith('.tmpl')) return false;
  return /\.tmp-/i.test(name) || name.endsWith('.tmp') || name.startsWith('.tmp-');
}

export function isProtectedPath(root: string, absolutePath: string): boolean {
  const rel = relative(root, absolutePath);
  if (rel.startsWith('..')) return true;
  const parts = rel.split(sep).filter(Boolean);
  if (parts.some(p => (PROTECTED_SEGMENTS as readonly string[]).includes(p))) {
    return true;
  }
  const normalized = parts.join('/');
  if ((PROTECTED_FILES as readonly string[]).includes(normalized)) {
    return true;
  }
  if (parts.length === 1 && parts[0].startsWith('config.json')) {
    return true;
  }
  return false;
}

function dirSizeBytes(dir: string, failed: CompactFailures): number {
  if (!existsSync(dir)) return 0;
  let total = 0;
  const walk = (d: string): void => {
    let entries: string[];
    try {
      entries = readdirSync(d);
    } catch (err) {
      recordFailure(failed, d, err);
      return;
    }
    for (const name of entries) {
      const p = join(d, name);
      try {
        const st = statSync(p);
        if (st.isDirectory()) walk(p);
        else total += st.size;
      } catch (err) {
        recordFailure(failed, p, err);
      }
    }
  };
  walk(dir);
  return total;
}

function fileSizeBytes(path: string, failed: CompactFailures): number {
  try {
    return statSync(path).size;
  } catch (err) {
    recordFailure(failed, path, err);
    return 0;
  }
}

function listFilesRecursive(dir: string, failed: CompactFailures): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  const walk = (d: string): void => {
    let entries: string[];
    try {
      entries = readdirSync(d);
    } catch (err) {
      recordFailure(failed, d, err);
      return;
    }
    for (const name of entries) {
      const p = join(d, name);
      try {
        const st = statSync(p);
        if (st.isDirectory()) walk(p);
        else out.push(p);
      } catch (err) {
        recordFailure(failed, p, err);
      }
    }
  };
  walk(dir);
  return out;
}

function ageCutoffMs(days: number, now: Date): number {
  return now.getTime() - days * 24 * 60 * 60 * 1000;
}

function estimateAgeTrim(dir: string, days: number, now: Date, failed: CompactFailures): { bytes: number; count: number } {
  const cutoff = ageCutoffMs(days, now);
  let bytes = 0;
  let count = 0;
  for (const p of listFilesRecursive(dir, failed)) {
    try {
      const st = statSync(p);
      if (st.mtimeMs < cutoff) {
        bytes += st.size;
        count += 1;
      }
    } catch (err) {
      recordFailure(failed, p, err);
    }
  }
  return { bytes, count };
}

function applyAgeTrim(dir: string, days: number, now: Date, failed: CompactFailures): { bytes: number; count: number } {
  const cutoff = ageCutoffMs(days, now);
  let bytes = 0;
  let count = 0;
  for (const p of listFilesRecursive(dir, failed)) {
    try {
      const st = statSync(p);
      if (st.mtimeMs < cutoff) {
        unlinkSync(p);
        bytes += st.size;
        count += 1;
      }
    } catch (err) {
      recordFailure(failed, p, err);
    }
  }
  return { bytes, count };
}

function collectTempFiles(root: string, failed: CompactFailures): { path: string; size: number }[] {
  const found: { path: string; size: number }[] = [];
  const walk = (d: string): void => {
    let entries: string[];
    try {
      entries = readdirSync(d);
    } catch (err) {
      recordFailure(failed, d, err);
      return;
    }
    for (const name of entries) {
      const p = join(d, name);
      try {
        const st = statSync(p);
        if (st.isDirectory()) {
          if ((PROTECTED_SEGMENTS as readonly string[]).includes(name)) continue;
          walk(p);
        } else if (isTempFilename(name) && !isProtectedPath(root, p)) {
          found.push({ path: p, size: st.size });
        }
      } catch (err) {
        recordFailure(failed, p, err);
      }
    }
  };
  if (existsSync(root)) walk(root);
  return found;
}

function listOwnedFailureFiles(failuresDir: string): string[] {
  if (!existsSync(failuresDir)) return [];
  return readdirSync(failuresDir)
    .filter(filename => /^\d+-[a-z0-9]{9}\.json$/.test(filename))
    .sort((a, b) => {
      const timeDifference = Number(a.split('-', 1)[0]) - Number(b.split('-', 1)[0]);
      return timeDifference || a.localeCompare(b);
    });
}

function estimateFailurePrune(failuresDir: string, failed: CompactFailures): { bytes: number; count: number; total: number } {
  const owned = listOwnedFailureFiles(failuresDir);
  const drop = owned.slice(0, Math.max(0, owned.length - MAX_FAILURE_RECORDS));
  let bytes = 0;
  for (const f of drop) {
    bytes += fileSizeBytes(join(failuresDir, f), failed);
  }
  return { bytes, count: drop.length, total: owned.length };
}

function applyFailurePrune(failuresDir: string, failed: CompactFailures): { bytes: number; count: number } {
  const owned = listOwnedFailureFiles(failuresDir);
  const drop = owned.slice(0, Math.max(0, owned.length - MAX_FAILURE_RECORDS));
  let count = 0;
  for (const f of drop) {
    try {
      archiveFailureRecord(failuresDir, f);
      count += 1;
    } catch (err) {
      recordFailure(failed, join(failuresDir, f), err);
    }
  }
  return { bytes: 0, count }; // Archiving preserves bytes rather than reclaiming disk.
}

function estimateMemoryTrim(memoryFile: string, failed: CompactFailures): { bytes: number; detail: string } {
  if (!existsSync(memoryFile)) return { bytes: 0, detail: 'absent' };
  try {
    const raw = readFileSync(memoryFile, 'utf8');
    const before = Buffer.byteLength(raw, 'utf8');
    const state = JSON.parse(raw) as HarnessMemoryState;
    const episodes = Array.isArray(state.episodes) ? state.episodes : [];
    const trimmed = episodes
      .map(ep => ({ ...ep, code: truncateEpisodeCodeForCompact(ep.code) }))
      .slice(-MAX_RETAINED_EPISODES);
    const next: HarnessMemoryState = { ...state, episodes: trimmed };
    const after = Buffer.byteLength(JSON.stringify(next, null, 2), 'utf8');
    return {
      bytes: Math.max(0, before - after),
      detail: `${episodes.length} episodes → cap ${MAX_RETAINED_EPISODES}, code ≤ ${MAX_EPISODE_CODE_BYTES}B`,
    };
  } catch (err) {
    recordFailure(failed, memoryFile, err);
    return { bytes: 0, detail: 'unreadable' };
  }
}

function applyMemoryTrim(memoryFile: string, failed: CompactFailures): { bytes: number } {
  if (!existsSync(memoryFile)) return { bytes: 0 };
  const before = fileSizeBytes(memoryFile, failed);
  try {
    const state = JSON.parse(readFileSync(memoryFile, 'utf8')) as HarnessMemoryState;
    const episodes = Array.isArray(state.episodes) ? state.episodes : [];
    state.episodes = episodes
      .map(ep => ({ ...ep, code: truncateEpisodeCodeForCompact(ep.code) }))
      .slice(-MAX_RETAINED_EPISODES);
    state.lastUpdated = new Date().toISOString();
    writeFileSync(memoryFile, JSON.stringify(state, null, 2), 'utf8');
    const after = fileSizeBytes(memoryFile, failed);
    return { bytes: Math.max(0, before - after) };
  } catch (err) {
    recordFailure(failed, memoryFile, err);
    return { bytes: 0 };
  }
}

/**
 * Plan and optionally execute a compact of a Sinter state root.
 */
export function runSinterCompact(options: CompactOptions = {}): CompactResult {
  const root = options.root ?? defaultSinterRoot();
  const execute = options.execute === true;
  const now = options.now ?? new Date();
  const stores: CompactStoreReport[] = [];
  const actions: string[] = [];
  let reclaimedBytes = 0;
  const failed: CompactFailures = { count: 0, paths: [] };

  for (const seg of PROTECTED_SEGMENTS) {
    const p = join(root, seg);
    stores.push({
      store: seg,
      path: p,
      currentBytes: dirSizeBytes(p, failed),
      policy: 'protected — compact refuses to touch',
      reclaimEstimateBytes: 0,
      protected: true,
    });
  }
  for (const rel of PROTECTED_FILES) {
    const p = join(root, rel);
    stores.push({
      store: rel,
      path: p,
      currentBytes: fileSizeBytes(p, failed),
      policy: 'protected — compact refuses to touch',
      reclaimEstimateBytes: 0,
      protected: true,
    });
  }

  const temps = collectTempFiles(root, failed);
  const tmpBytes = temps.reduce((s, t) => s + t.size, 0);
  stores.push({
    store: 'tmp-sweep',
    path: root,
    currentBytes: tmpBytes,
    policy: 'delete orphaned *.tmp-* / *.tmp (never objects/refs/dreams queue/config)',
    reclaimEstimateBytes: tmpBytes,
    detail: `${temps.length} temp file(s)`,
  });
  if (execute && temps.length > 0) {
    for (const t of temps) {
      try {
        unlinkSync(t.path);
        reclaimedBytes += t.size;
      } catch (err) {
        recordFailure(failed, t.path, err);
      }
    }
    actions.push(`tmp-sweep: removed ${temps.length} file(s)`);
  }

  const failuresDir = join(root, 'failures');
  const failEst = estimateFailurePrune(failuresDir, failed);
  stores.push({
    store: 'failures',
    path: failuresDir,
    currentBytes: dirSizeBytes(failuresDir, failed),
    policy: `keep newest ${MAX_FAILURE_RECORDS} active FailureLogger records; archive older originals`,
    reclaimEstimateBytes: 0,
    detail: `${failEst.total} active records, archive ${failEst.count}; retained bytes included`,
  });
  if (execute) {
    const r = applyFailurePrune(failuresDir, failed);
    reclaimedBytes += r.bytes;
    if (r.count > 0) actions.push(`failures: archived ${r.count} record(s)`);
    if (r.count < failEst.count) actions.push(`failures: ${failEst.count - r.count} record(s) retained active after archive failure`);
  }

  const memoryDir = join(root, 'memory');
  const memoryFile = join(memoryDir, 'harness-memory.json');
  const memEst = estimateMemoryTrim(memoryFile, failed);
  stores.push({
    store: 'memory',
    path: memoryFile,
    currentBytes: fileSizeBytes(memoryFile, failed),
    policy: `episodes cap ${MAX_RETAINED_EPISODES}, code ≤ ${MAX_EPISODE_CODE_BYTES}B + tmp sweep`,
    reclaimEstimateBytes: memEst.bytes,
    detail: memEst.detail,
  });
  if (execute) {
    const r = applyMemoryTrim(memoryFile, failed);
    reclaimedBytes += r.bytes;
    const memTemps = collectTempFiles(memoryDir, failed);
    for (const t of memTemps) {
      try {
        unlinkSync(t.path);
        reclaimedBytes += t.size;
      } catch (err) {
        recordFailure(failed, t.path, err);
      }
    }
    if (r.bytes > 0 || memTemps.length > 0) {
      actions.push(`memory: trimmed episodes/code, swept ${memTemps.length} tmp file(s)`);
    }
  }

  for (const name of ['lineage', 'reasoning', 'thinking-traces'] as const) {
    const dir = join(root, name);
    const est = estimateAgeTrim(dir, LINEAGE_RETENTION_DAYS, now, failed);
    stores.push({
      store: name,
      path: dir,
      currentBytes: dirSizeBytes(dir, failed),
      policy: `delete files older than ${LINEAGE_RETENTION_DAYS} days (mtime)`,
      reclaimEstimateBytes: est.bytes,
      detail: `${est.count} file(s) past retention`,
    });
    if (execute) {
      const r = applyAgeTrim(dir, LINEAGE_RETENTION_DAYS, now, failed);
      reclaimedBytes += r.bytes;
      if (r.count > 0) {
        actions.push(`${name}: removed ${r.count} file(s) older than ${LINEAGE_RETENTION_DAYS}d`);
      }
    }
  }

  const dbPath = join(root, 'project.sinter');
  if (existsSync(dbPath)) {
    let store: EventStore | null = null;
    try {
      store = new EventStore({
        projectRoot: root,
        dataDir: '.',
        dbFilename: 'project.sinter',
        createDirs: false,
      });
      store.init();
      if (execute) {
        const result = store.applyRetention(now);
        const reclaimed = Math.max(0, result.bytesBefore - result.bytesAfter);
        reclaimedBytes += reclaimed;
        stores.push({
          store: 'event-store',
          path: dbPath,
          currentBytes: result.bytesAfter,
          policy: 'config_change 30d, run_record 180d, VACUUM if >50MB; assets/objects untouched',
          reclaimEstimateBytes: reclaimed,
          detail: `deleted ${result.deleted} event(s)${result.vacuumed ? ', VACUUM' : ''}`,
        });
        if (result.deleted > 0 || result.vacuumed) {
          actions.push(
            `event-store: deleted ${result.deleted} event(s)${result.vacuumed ? ', VACUUM' : ''}`,
          );
        }
      } else {
        const est = store.estimateRetention(now);
        stores.push({
          store: 'event-store',
          path: dbPath,
          currentBytes: est.dbSizeBytes,
          policy: 'config_change 30d, run_record 180d, VACUUM if >50MB; assets/objects untouched',
          reclaimEstimateBytes: 0,
          detail: `~${est.deleteCount} event row(s)${est.wouldVacuum ? ', would VACUUM' : ''}`,
        });
      }
    } catch (err) {
      stores.push({
        store: 'event-store',
        path: dbPath,
        currentBytes: fileSizeBytes(dbPath, failed),
        policy: 'config_change 30d, run_record 180d, VACUUM if >50MB',
        reclaimEstimateBytes: 0,
        detail: `skipped: ${err instanceof Error ? err.message : String(err)}`,
      });
    } finally {
      try {
        store?.close();
      } catch (err) {
        recordFailure(failed, dbPath, err);
      }
    }
  } else {
    stores.push({
      store: 'event-store',
      path: dbPath,
      currentBytes: 0,
      policy: 'config_change 30d, run_record 180d, VACUUM if >50MB',
      reclaimEstimateBytes: 0,
      detail: 'no project.sinter in this root',
    });
  }

  const totalReclaimEstimateBytes = stores.reduce((s, r) => s + r.reclaimEstimateBytes, 0);

  return {
    root,
    executed: execute,
    stores,
    totalReclaimEstimateBytes,
    reclaimedBytes: execute ? reclaimedBytes : 0,
    actions,
    failed,
  };
}

export function formatCompactReport(result: CompactResult): string {
  const lines: string[] = [];
  lines.push('');
  lines.push(result.executed ? 'Sinter compact — EXECUTE' : 'Sinter compact — DRY-RUN (no writes)');
  lines.push(`Root: ${result.root}`);
  lines.push('');
  lines.push(
    'Store'.padEnd(18) +
      'Size'.padStart(12) +
      'Reclaim~'.padStart(12) +
      '  Policy',
  );
  lines.push('-'.repeat(72));
  for (const s of result.stores) {
    const flag = s.protected ? ' [protected]' : '';
    lines.push(
      s.store.padEnd(18) +
        formatBytes(s.currentBytes).padStart(12) +
        formatBytes(s.reclaimEstimateBytes).padStart(12) +
        `  ${s.policy}${flag}`,
    );
    if (s.detail) {
      lines.push(`${''.padEnd(18)}  ${s.detail}`);
    }
  }
  lines.push('-'.repeat(72));
  lines.push(
    `Total reclaim estimate: ${formatBytes(result.totalReclaimEstimateBytes)}` +
      (result.executed ? ` | reclaimed this run: ${formatBytes(result.reclaimedBytes)}` : ''),
  );
  if (result.actions.length > 0) {
    lines.push('');
    lines.push('Actions:');
    for (const a of result.actions) lines.push(`  - ${a}`);
  }
  if (result.failed.count > 0) {
    lines.push('');
    lines.push(`Skipped/failed: ${result.failed.count} operation(s); first ${result.failed.paths.length}:`);
    for (const p of result.failed.paths) lines.push(`  - ${p}`);
  }
  if (!result.executed) {
    lines.push('');
    lines.push('Re-run with --execute to apply. Protected: objects, refs, dreams/queue.json, config.json.');
  }
  lines.push('');
  return lines.join('\n');
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}
