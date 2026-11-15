/**
 * Debt wave 2026-11-14: fs failures that used to vanish are now narrowed
 * (ENOENT only) or reported via Logger.warn.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, readFileSync, chmodSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const mockRevideoRender = vi.hoisted(() => vi.fn());
const mockHyperFramesRender = vi.hoisted(() => vi.fn());
vi.mock('../../src/render/RevideoRenderer.js', () => ({
  RevideoRenderer: class { render = mockRevideoRender; },
}));
vi.mock('../../src/render/HyperFramesRenderer.js', () => ({
  HyperFramesRenderer: class { render = mockHyperFramesRender; },
}));

import { Logger } from '../../src/utils/Logger.js';
import { isEnoent } from '../../src/utils/errors.js';
import { DreamQueue } from '../../src/dreaming/DreamQueue.js';
import { publishDiagnosePlan } from '../../src/harness/PlanPublisher.js';
import { clearRunState } from '../../src/harness/RunStateStore.js';
import { VideoPipeline } from '../../src/render/VideoPipeline.js';
import { ensurePurgeResistantBrowserEnv, __resetBrowserPreflightForTests } from '../../src/utils/browserPreflight.js';

describe('silent-catch fixes (wave 2)', () => {
  let dir: string;
  let warn: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'sc2-misc-'));
    warn = vi.spyOn(Logger, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    warn.mockRestore();
    vi.restoreAllMocks();
    try { chmodSync(dir, 0o755); } catch { /* may be gone */ }
    rmSync(dir, { recursive: true, force: true });
  });

  it('isEnoent matches only ENOENT errors', () => {
    expect(isEnoent(Object.assign(new Error('x'), { code: 'ENOENT' }))).toBe(true);
    expect(isEnoent(Object.assign(new Error('x'), { code: 'EACCES' }))).toBe(false);
    expect(isEnoent(null)).toBe(false);
    expect(isEnoent(undefined)).toBe(false);
  });

  describe('DreamQueue', () => {
    it('warns when persisting fails, and the in-memory queue still works', () => {
      const blocker = join(dir, 'not-a-dir');
      writeFileSync(blocker, 'x');
      const q = new DreamQueue({ persistPath: join(blocker, 'queue.json') });
      const id = q.enqueue('artifact' as never, [] as never, 1);
      expect(typeof id).toBe('string');
      // prune() and enqueue() each persist, so each reports the failure once
      expect(warn).toHaveBeenCalledTimes(2);
      expect(warn.mock.calls.map(c => String(c[1]))).toEqual(
        Array(2).fill(`queue persistence failed: ${join(blocker, 'queue.json')}:`));
    });

    it('warns when a corrupt queue cannot be quarantined (rename fails)', () => {
      const file = join(dir, 'queue.json');
      writeFileSync(file, '{broken');
      // Root-proof: a non-empty directory at the quarantine destination makes rename fail (EISDIR) for any uid.
      vi.spyOn(Date, 'now').mockReturnValue(1700000000000);
      mkdirSync(`${file}.corrupt-1700000000000`);
      writeFileSync(join(`${file}.corrupt-1700000000000`, 'keep'), 'x');
      new DreamQueue({ persistPath: file });
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0][1])).toBe(`could not quarantine corrupt queue ${file}:`);
    });

    it('quarantines a corrupt queue silently when the dir is writable', () => {
      const file = join(dir, 'queue.json');
      writeFileSync(file, '{broken');
      new DreamQueue({ persistPath: file });
      expect(readdirSync(dir).filter(f => f.startsWith('queue.json.corrupt-'))).toHaveLength(1);
      expect(warn).not.toHaveBeenCalled();
    });
  });

  describe('PlanPublisher', () => {
    const planText = 'A diagnose plan. '.repeat(20);
    it('rewrites a torn meta file (SyntaxError is expected) without throwing', () => {
      const first = publishDiagnosePlan({ runDir: dir, taskId: 't1', planText });
      writeFileSync(join(dir, 'receipts', 't1-plan.meta.json'), '{torn');
      const again = publishDiagnosePlan({ runDir: dir, taskId: 't1', planText });
      expect(again.planPath).toBe(first.planPath);
      expect(again.reused).toBe(false);
      expect(JSON.parse(readFileSync(join(dir, 'receipts', 't1-plan.meta.json'), 'utf8')).contentDigest).toBe(first.contentDigest);
    });

    it('rethrows a real failure (unreadable meta) instead of swallowing it', () => {
      publishDiagnosePlan({ runDir: dir, taskId: 't2', planText });
      const meta = join(dir, 'receipts', 't2-plan.meta.json');
      // Root-proof: a directory in place of the meta file makes the read fail with EISDIR for any uid.
      rmSync(meta);
      mkdirSync(meta);
      expect(() => publishDiagnosePlan({ runDir: dir, taskId: 't2', planText })).toThrow(/EISDIR/);
    });
  });

  describe('clearRunState', () => {
    it('warns when the run state cannot be cleared (path is a directory)', async () => {
      mkdirSync(join(dir, '.omx', 'run-state.json'), { recursive: true });
      await clearRunState(dir);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0][1])).toBe(`could not clear run state ${join(dir, '.omx', 'run-state.json')}:`);
    });

    it('stays silent when the state directory does not exist (ENOENT)', async () => {
      await clearRunState(dir);
      expect(warn).not.toHaveBeenCalled();
    });

    it('blanks an existing run state silently', async () => {
      mkdirSync(join(dir, '.omx'));
      writeFileSync(join(dir, '.omx', 'run-state.json'), '{"status":"running"}');
      await clearRunState(dir);
      expect(readFileSync(join(dir, '.omx', 'run-state.json'), 'utf8')).toBe('');
      expect(warn).not.toHaveBeenCalled();
    });
  });

  describe('VideoPipeline temp cleanup', () => {
    const result = (outputPath: string) => ({ outputPath, duration: 1, width: 2, height: 2, format: 'mp4' });
    beforeEach(() => { mockRevideoRender.mockReset(); mockHyperFramesRender.mockReset(); });

    it('stays silent when the temp file is already gone (ENOENT)', async () => {
      mockRevideoRender.mockImplementation(async (_c: string, out: string) => result(out));
      mockHyperFramesRender.mockImplementation(async (_c: string, out: string) => result(out));
      await new VideoPipeline().execute(
        [{ type: 'revideo', code: 'a' }, { type: 'hyperframes', code: 'b' }], join(dir, 'out.mp4'));
      expect(warn).not.toHaveBeenCalled();
    });

    it('warns when a temp file cannot be deleted', async () => {
      let tempDir = '';
      mockRevideoRender.mockImplementation(async (_c: string, out: string) => {
        tempDir = out;
        mkdirSync(out); // a directory at the temp path: unlink fails with EISDIR/EPERM
        return result(out);
      });
      mockHyperFramesRender.mockImplementation(async (_c: string, out: string) => result(out));
      try {
        await new VideoPipeline().execute(
          [{ type: 'revideo', code: 'a' }, { type: 'hyperframes', code: 'b' }], join(dir, 'out.mp4'));
        expect(warn).toHaveBeenCalledTimes(1);
        expect(String(warn.mock.calls[0][1])).toBe(`could not delete temp file ${tempDir}:`);
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    });
  });

  describe('browserPreflight mkdir', () => {
    it('warns when the browser cache dirs cannot be created', () => {
      __resetBrowserPreflightForTests();
      const home = join(dir, 'blocked');
      writeFileSync(home, 'x'); // a file where the browsers home should be
      const env: NodeJS.ProcessEnv = {};
      const r = ensurePurgeResistantBrowserEnv(env, { home });
      expect(r.applied).toBe(true);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0][1])).toBe('could not create browser cache directories:');
    });
  });
});
