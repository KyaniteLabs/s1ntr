import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, utimesSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';

// Delete failures are injected at the fs boundary: chmod-based EACCES does not
// fire when the suite runs as root (CI containers), so it proved nothing there.
const fsFault = vi.hoisted(() => ({ failUnlink: new Set<string>() }));
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  const unlinkSync = (p: import('node:fs').PathLike): void => {
    if (fsFault.failUnlink.has(String(p))) {
      throw Object.assign(new Error(`EACCES: permission denied, unlink '${String(p)}'`), { code: 'EACCES' });
    }
    actual.unlinkSync(p);
  };
  return { ...actual, unlinkSync, default: { ...actual, unlinkSync } };
});
import {
  runSinterCompact,
  formatCompactReport,
  isTempFilename,
  isProtectedPath,
  LINEAGE_RETENTION_DAYS,
} from '../../../src/cli/SinterCompact.js';
import { MAX_FAILURE_RECORDS } from '../../../src/harness/FailureLogger.js';
import { EventStore } from '../../../src/compost/EventStore.js';

function touchOld(path: string, daysAgo: number): void {
  const t = (Date.now() - daysAgo * 24 * 60 * 60 * 1000) / 1000;
  utimesSync(path, t, t);
}

describe('SinterCompact', () => {
  it('preserves active failures and reports a conflicting archive honestly', () => {
    const root = mkdtempSync(join(tmpdir(), 'sinter-compact-'));
    mkdirSync(join(root, 'failures', 'archive'), { recursive: true });
    for (let i = 0; i <= MAX_FAILURE_RECORDS; i++) {
      writeFileSync(join(root, 'failures', `${i}-abcdefghi.json`), `original ${i}`);
    }
    writeFileSync(join(root, 'failures', 'archive', '0-abcdefghi.json'), 'conflicting archive');
    const result = runSinterCompact({ root, execute: true, now: new Date() });
    expect(readFileSync(join(root, 'failures', '0-abcdefghi.json'), 'utf8')).toBe('original 0');
    expect(readFileSync(join(root, 'failures', 'archive', '0-abcdefghi.json'), 'utf8')).toBe('conflicting archive');
    expect(result.actions).toContain('failures: 1 record(s) retained active after archive failure');
    expect(result.reclaimedBytes).toBe(0);
    rmSync(root, { recursive: true, force: true });
  });
  it('classifies temp filenames without matching .tmpl', () => {
    expect(isTempFilename('harness-memory.json.tmp-abc')).toBe(true);
    expect(isTempFilename('foo.tmp')).toBe(true);
    expect(isTempFilename('layout.tmpl')).toBe(false);
  });

  it('protects objects, refs, config, and dream queue', () => {
    const root = '/tmp/sinter-root';
    expect(isProtectedPath(root, join(root, 'objects', 'ab', 'cd'))).toBe(true);
    expect(isProtectedPath(root, join(root, 'refs', 'gallery', 'x.json'))).toBe(true);
    expect(isProtectedPath(root, join(root, 'config.json'))).toBe(true);
    expect(isProtectedPath(root, join(root, 'dreams', 'queue.json'))).toBe(true);
    expect(isProtectedPath(root, join(root, 'failures', '1-abc.json'))).toBe(false);
  });

  it('dry-run reports reclaim estimates and writes nothing', () => {
    const root = mkdtempSync(join(tmpdir(), 'sinter-compact-'));
    mkdirSync(join(root, 'failures'));
    mkdirSync(join(root, 'lineage'));
    mkdirSync(join(root, 'objects', 'aa'), { recursive: true });
    mkdirSync(join(root, 'dreams'));
    writeFileSync(join(root, 'config.json'), '{"ok":true}');
    writeFileSync(join(root, 'dreams', 'queue.json'), '[]');
    writeFileSync(join(root, 'objects', 'aa', 'blob'), 'KEEP-ME');
    writeFileSync(join(root, 'memory.tmp-orphan'), 'TMP');
    const oldLineage = join(root, 'lineage', 'old.json');
    writeFileSync(oldLineage, '{"old":true}');
    touchOld(oldLineage, LINEAGE_RETENTION_DAYS + 5);

    // overflow failures beyond cap
    for (let i = 0; i < MAX_FAILURE_RECORDS + 3; i++) {
      const id = `${1000 + i}-abcdefgh${i % 10}`;
      // FailureLogger pattern: /^\d+-[a-z0-9]{9}\.json$/
      const name = `${1000000000000 + i}-abcde${String(i).padStart(4, '0')}`.slice(0, 13 + 9);
    }
    // proper 9-char suffix
    for (let i = 0; i < MAX_FAILURE_RECORDS + 3; i++) {
      const suffix = `a${String(i).padStart(8, '0')}`;
      writeFileSync(join(root, 'failures', `${1000000000000 + i}-${suffix}.json`), `{"i":${i}}`);
    }

    const beforeObjects = readFileSync(join(root, 'objects', 'aa', 'blob'), 'utf8');
    const beforeConfig = readFileSync(join(root, 'config.json'), 'utf8');
    const beforeQueue = readFileSync(join(root, 'dreams', 'queue.json'), 'utf8');

    const result = runSinterCompact({ root, execute: false, now: new Date() });

    expect(result.executed).toBe(false);
    expect(result.reclaimedBytes).toBe(0);
    expect(result.totalReclaimEstimateBytes).toBeGreaterThan(0);
    expect(existsSync(join(root, 'memory.tmp-orphan'))).toBe(true);
    expect(existsSync(oldLineage)).toBe(true);
    expect(readFileSync(join(root, 'objects', 'aa', 'blob'), 'utf8')).toBe(beforeObjects);
    expect(readFileSync(join(root, 'config.json'), 'utf8')).toBe(beforeConfig);
    expect(readFileSync(join(root, 'dreams', 'queue.json'), 'utf8')).toBe(beforeQueue);
    expect(readdirSync(join(root, 'failures')).length).toBe(MAX_FAILURE_RECORDS + 3);

    const protectedStores = result.stores.filter(s => s.protected);
    expect(protectedStores.map(s => s.store)).toEqual(
      expect.arrayContaining(['objects', 'refs', 'config.json', join('dreams', 'queue.json')]),
    );
  });

  it('execute sweeps temps, prunes failures, trims aged lineage, leaves protected paths', () => {
    const root = mkdtempSync(join(tmpdir(), 'sinter-compact-exec-'));
    mkdirSync(join(root, 'failures'));
    mkdirSync(join(root, 'lineage'));
    mkdirSync(join(root, 'reasoning'));
    mkdirSync(join(root, 'objects', 'aa'), { recursive: true });
    mkdirSync(join(root, 'dreams'));
    writeFileSync(join(root, 'config.json'), '{"ok":true}');
    writeFileSync(join(root, 'dreams', 'queue.json'), '[]');
    writeFileSync(join(root, 'objects', 'aa', 'blob'), 'KEEP-ME');
    writeFileSync(join(root, 'scratch.tmp-x'), 'TMP');
    const oldLineage = join(root, 'lineage', 'old.json');
    const newLineage = join(root, 'lineage', 'new.json');
    writeFileSync(oldLineage, '{"old":true}');
    writeFileSync(newLineage, '{"new":true}');
    touchOld(oldLineage, LINEAGE_RETENTION_DAYS + 10);

    for (let i = 0; i < MAX_FAILURE_RECORDS + 5; i++) {
      const suffix = `b${String(i).padStart(8, '0')}`;
      writeFileSync(join(root, 'failures', `${2000000000000 + i}-${suffix}.json`), `{"i":${i}}`);
    }

    const result = runSinterCompact({ root, execute: true, now: new Date() });

    expect(result.executed).toBe(true);
    expect(result.reclaimedBytes).toBeGreaterThan(0);
    expect(existsSync(join(root, 'scratch.tmp-x'))).toBe(false);
    expect(existsSync(oldLineage)).toBe(false);
    expect(existsSync(newLineage)).toBe(true);
    expect(readdirSync(join(root, 'failures')).filter(f => f.endsWith('.json')).length).toBe(MAX_FAILURE_RECORDS);
    expect(readdirSync(join(root, 'failures', 'archive')).length).toBe(5);
    for (let i = 0; i < 5; i++) {
      expect(readFileSync(join(root, 'failures', 'archive', `${2000000000000 + i}-b${String(i).padStart(8, '0')}.json`), 'utf8')).toBe(`{"i":${i}}`);
    }
    expect(result.stores.find(s => s.store === 'failures')?.reclaimEstimateBytes).toBe(0);
    expect(readFileSync(join(root, 'objects', 'aa', 'blob'), 'utf8')).toBe('KEEP-ME');
    expect(readFileSync(join(root, 'config.json'), 'utf8')).toBe('{"ok":true}');
    expect(readFileSync(join(root, 'dreams', 'queue.json'), 'utf8')).toBe('[]');
  });

  it('EventStore retention deletes aged config_change / run_record only', () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'sinter-es-'));
    const store = new EventStore({ projectRoot });
    store.init();
    store.append('config_change', { action: 'old' });
    store.append('run_record', { id: 'old-run' });
    store.append('heap_add', { files: ['x'] });

    // Backdate via SQL
    const oldTs = new Date(Date.now() - 200 * 24 * 60 * 60 * 1000).toISOString();
    const db = (store as unknown as { db: { prepare: (s: string) => { run: (...a: unknown[]) => unknown } } }).db;
    db.prepare(`UPDATE events SET timestamp = ? WHERE type IN ('config_change','run_record')`).run(oldTs);

    const result = store.applyRetention(new Date());
    expect(result.deleted).toBe(2);
    expect(result.deletedByType.config_change).toBe(1);
    expect(result.deletedByType.run_record).toBe(1);

    const stats = store.getStats();
    expect(stats.eventTypes.heap_add).toBe(1);
    expect(stats.eventTypes.config_change).toBeUndefined();
    store.close();
  });

  describe('failed deletes are visible', () => {
    afterEach(() => fsFault.failUnlink.clear());

    it('counts and lists files it could not delete, without over-counting reclaimed bytes', () => {
      const root = mkdtempSync(join(tmpdir(), 'sinter-compact-fail-'));
      const lineage = join(root, 'lineage');
      mkdirSync(lineage, { recursive: true });
      const stuck = join(lineage, 'old.json');
      writeFileSync(stuck, 'x'.repeat(100));
      touchOld(stuck, LINEAGE_RETENTION_DAYS + 5);
      fsFault.failUnlink.add(stuck);
      try {
        const result = runSinterCompact({ root, execute: true, now: new Date() });
        expect(existsSync(stuck)).toBe(true);
        expect(result.reclaimedBytes).toBe(0);
        expect(result.failed.count).toBe(1);
        expect(result.failed.paths).toEqual([stuck]);
        const report = formatCompactReport(result);
        expect(report).toContain('Skipped/failed: 1 operation(s)');
        expect(report).toContain(stuck);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    it('caps listed failure paths but keeps the full count', () => {
      const root = mkdtempSync(join(tmpdir(), 'sinter-compact-cap-'));
      const lineage = join(root, 'lineage');
      mkdirSync(lineage, { recursive: true });
      for (let i = 0; i < 8; i++) {
        const f = join(lineage, `old-${i}.json`);
        writeFileSync(f, 'x');
        touchOld(f, LINEAGE_RETENTION_DAYS + 5);
        fsFault.failUnlink.add(f);
      }
      try {
        const result = runSinterCompact({ root, execute: true, now: new Date() });
        expect(result.failed.count).toBe(8);
        expect(result.failed.paths).toHaveLength(5);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    it('reports no failures on a clean run and when stores are simply absent (ENOENT)', () => {
      const root = mkdtempSync(join(tmpdir(), 'sinter-compact-clean-'));
      const lineage = join(root, 'lineage');
      mkdirSync(lineage, { recursive: true });
      const old = join(lineage, 'old.json');
      writeFileSync(old, 'x'.repeat(10));
      touchOld(old, LINEAGE_RETENTION_DAYS + 5);
      try {
        const result = runSinterCompact({ root, execute: true, now: new Date() });
        expect(existsSync(old)).toBe(false);
        expect(result.reclaimedBytes).toBe(10);
        expect(result.failed).toEqual({ count: 0, paths: [] });
        expect(formatCompactReport(result)).not.toContain('Skipped/failed');
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  });
});
