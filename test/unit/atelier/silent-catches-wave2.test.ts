/**
 * Debt wave 2026-11-14: fs failures in atelier best-effort paths must be
 * reported through Logger.warn, while the documented fallback still happens.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, readFileSync, chmodSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Logger } from '../../../src/utils/Logger.js';
import { checkAdherence, expireStalePlan } from '../../../src/atelier/ConductorCheck.js';
import { EloTable } from '../../../src/atelier/EloTable.js';
import { LessonBandit } from '../../../src/atelier/LessonBandit.js';
import { sweepRejects } from '../../../src/atelier/RejectRescue.js';

const plan = { primary: 'p5', secondary: 'glsl', ts: '2026-11-14T00:00:00Z' };

describe('atelier silent-catch fixes', () => {
  let dir: string;
  let warn: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'sc2-atelier-'));
    warn = vi.spyOn(Logger, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    warn.mockRestore();
    vi.restoreAllMocks();
    try { chmodSync(dir, 0o755); } catch { /* may be gone */ }
    rmSync(dir, { recursive: true, force: true });
  });

  describe('ConductorCheck', () => {
    it('warns when the verdict log cannot be appended, and still returns the verdict', () => {
      // no .omx/atelier/game directory: appendFileSync fails with ENOENT on the parent
      const verdict = checkAdherence(dir, plan, { domains: ['glsl', 'p5'] });
      expect(verdict).toEqual({ adhered: false, declared: ['glsl', 'p5'] });
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0][1]).toBe('verdict log append failed (verdict not recorded):');
    });

    it('stays quiet when the verdict log is writable', () => {
      mkdirSync(join(dir, '.omx', 'atelier', 'game'), { recursive: true });
      checkAdherence(dir, plan, { domains: ['glsl', 'p5'] });
      const log = readFileSync(join(dir, '.omx', 'atelier', 'game', 'conductor-verdicts.jsonl'), 'utf8');
      expect(JSON.parse(log.trim()).adhered).toBe(false);
      expect(warn).not.toHaveBeenCalled();
    });

    it('warns when an expired-plan verdict cannot be appended', () => {
      expireStalePlan(dir, plan);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0][1]).toBe('expired-plan verdict append failed:');
    });
  });

  describe('quarantine rename of corrupt state', () => {
    it('EloTable warns when the corrupt file cannot be renamed (rename fails)', () => {
      const file = join(dir, 'elo.json');
      writeFileSync(file, '{not json');
      // Root-proof: a non-empty directory at the quarantine destination makes rename fail (EISDIR) for any uid.
      vi.spyOn(Date, 'now').mockReturnValue(1700000000000);
      mkdirSync(`${file}.corrupt-1700000000000`);
      writeFileSync(join(`${file}.corrupt-1700000000000`, 'keep'), 'x');
      new EloTable(file);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0][1])).toBe(`could not quarantine corrupt table ${file}:`);
    });

    it('EloTable quarantines silently when the dir is writable', () => {
      const file = join(dir, 'elo.json');
      writeFileSync(file, '{not json');
      new EloTable(file);
      expect(readdirSync(dir).filter(f => f.startsWith('elo.json.corrupt-'))).toHaveLength(1);
      expect(warn).not.toHaveBeenCalled();
    });

    it('LessonBandit warns when the corrupt file cannot be renamed (rename fails)', () => {
      const file = join(dir, 'bandit.json');
      writeFileSync(file, 'garbage');
      // Root-proof: a non-empty directory at the quarantine destination makes rename fail (EISDIR) for any uid.
      vi.spyOn(Date, 'now').mockReturnValue(1700000000000);
      mkdirSync(`${file}.corrupt-1700000000000`);
      writeFileSync(join(`${file}.corrupt-1700000000000`, 'keep'), 'x');
      new LessonBandit(file);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0][1])).toBe(`could not quarantine corrupt state ${file}:`);
    });

    it('LessonBandit quarantines silently when the dir is writable', () => {
      const file = join(dir, 'bandit.json');
      writeFileSync(file, 'garbage');
      new LessonBandit(file);
      expect(readdirSync(dir).filter(f => f.startsWith('bandit.json.corrupt-'))).toHaveLength(1);
      expect(warn).not.toHaveBeenCalled();
    });
  });

  describe('RejectRescue lesson staging', () => {
    it('warns when the staging file is unusable but the sweep still completes', async () => {
      const failures = join(dir, 'failures');
      const cwd = join(dir, 'cwd');
      mkdirSync(failures, { recursive: true });
      mkdirSync(join(cwd, '.omx', 'atelier', 'lessons'), { recursive: true });
      const stagingAsDir = join(dir, 'staging-is-a-dir');
      mkdirSync(stagingAsDir);
      for (let i = 1; i <= 3; i++) {
        writeFileSync(join(failures, `g${i}.json`), JSON.stringify({
          id: `gfail-${i}`, timestamp: `2026-08-29T2${i}:00:00Z`, domain: 'glsl',
          code: 'precision mediump float;\nvoid main() { float t = u_time; gl_FragColor = vec4(t); }',
          error: "GLSL: 'u_time' is used but never declared as a uniform", errorType: 'generation',
        }));
      }
      const r = await sweepRejects(cwd, { failuresDir: failures, llm: false, stagingPath: stagingAsDir });
      expect(r.scanned).toBe(3);
      expect(r.stagedLessonIds).toEqual([]);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0][1])).toContain(`lesson staging failed (sweep continues): ${stagingAsDir}`);
    });
  });
});
