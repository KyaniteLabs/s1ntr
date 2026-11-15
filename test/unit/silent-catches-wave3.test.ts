/**
 * Debt wave 2026-11-14 (pass 3): state reads that silently reset data and
 * best-effort persistence now report through Logger.warn. Missing files stay
 * silent where they are the expected first-run state.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, chmodSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Logger } from '../../src/utils/Logger.js';
import { writeTheorySidecar } from '../../src/utils/theorySidecar.js';
import { PromptOrgan } from '../../src/atelier/PromptOrgan.js';
import { GuiEvolution } from '../../src/atelier/GuiEvolution.js';
import { getMachinePersona } from '../../src/atelier/PersonaFleet.js';
import { loadOrCreate } from '../../src/atelier/RecipeBook.js';
import { Gallery } from '../../src/gallery/Gallery.js';
import { SinterFS } from '../../src/fs/SinterFS.js';
import { GalleryFSAdapter } from '../../src/fs/adapters/GalleryFSAdapter.js';
import { LoopPersistence } from '../../src/core/LoopPersistence.js';

const CONDUCTOR_SEED = 7; // conductor lane fires on the first draw (see PromptOrgan.test.ts)

describe('silent-catch fixes (wave 3)', () => {
  let dir: string;
  let warn: ReturnType<typeof vi.spyOn>;
  const msgs = () => warn.mock.calls.map(c => String(c[1]));
  const gameDir = () => join(dir, '.omx', 'atelier', 'game');

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'sc3-'));
    delete process.env.SINTER_CONDUCTOR_OFF;
    warn = vi.spyOn(Logger, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    warn.mockRestore();
    try { chmodSync(dir, 0o755); } catch { /* may be gone */ }
    rmSync(dir, { recursive: true, force: true });
  });

  describe('writeTheorySidecar (src/index.ts)', () => {
    it('writes the sidecar and returns true', () => {
      const src = join(dir, 'a-final.js');
      expect(writeTheorySidecar(src, 'strudel', ['mode: dorian'])).toBe(true);
      const body = JSON.parse(readFileSync(`${src}.theory.json`, 'utf8'));
      expect(body.domain).toBe('strudel');
      expect(body.theoryAssessment).toEqual(['mode: dorian']);
      expect(warn).not.toHaveBeenCalled();
    });

    it('warns and returns false when the sidecar cannot be written', () => {
      const src = join(dir, 'missing-dir', 'a-final.js');
      expect(writeTheorySidecar(src, 'strudel', ['x'])).toBe(false);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(msgs()[0]).toBe(`theory sidecar not written (${src}.theory.json); artifact still saves:`);
    });
  });

  describe('PromptOrgan conductor lane', () => {
    it('warns when the plan record cannot be written, and the prompt still ships', () => {
      mkdirSync(gameDir(), { recursive: true });
      // a directory where the plan record file should be makes the atomic write fail
      mkdirSync(join(gameDir(), 'conductor-last.json'));
      const p = new PromptOrgan(dir, CONDUCTOR_SEED).next();
      expect(p.source).toBe('conductor');
      expect(msgs()).toContain('conductor plan record write failed (adherence check will not run; prompt still ships):');
    });

    it('warns when a torn conductor.state is ignored (kill switch not honoured)', () => {
      mkdirSync(gameDir(), { recursive: true });
      writeFileSync(join(gameDir(), 'conductor.state'), '{torn');
      new PromptOrgan(dir, CONDUCTOR_SEED).next();
      expect(msgs()).toContain('conductor.state unreadable (kill switch ignored, lane defaults on):');
    });

    it('warns when a torn daily counter resets the budget', () => {
      mkdirSync(gameDir(), { recursive: true });
      writeFileSync(join(gameDir(), 'conductor-count.json'), '{torn');
      new PromptOrgan(dir, CONDUCTOR_SEED).next();
      expect(msgs()).toContain('conductor-count.json unreadable (daily budget treated as fresh):');
      expect(msgs()).toContain('conductor-count.json unreadable (count restarts at 0):');
    });

    it('warns when a torn combination frontier falls back to priors', () => {
      mkdirSync(gameDir(), { recursive: true });
      writeFileSync(join(gameDir(), 'combination-frontier.json'), '{torn');
      const p = new PromptOrgan(dir, CONDUCTOR_SEED).next();
      expect(p.source).toBe('conductor');
      expect(msgs()).toEqual(['combination-frontier.json unreadable (falling back to priors):']);
    });

    it('stays silent on a first run with no state files (ENOENT)', () => {
      new PromptOrgan(dir, CONDUCTOR_SEED).next();
      expect(warn).not.toHaveBeenCalled();
    });
  });

  describe('GuiEvolution.load', () => {
    it('warns when the archive state is corrupt and starts fresh', () => {
      const g = new GuiEvolution();
      g.load('{not json');
      expect(warn).toHaveBeenCalledTimes(1);
      expect(msgs()[0]).toBe('archive state unreadable (starting a fresh archive):');
      expect(g.save()).toBe(JSON.stringify({ entries: [] }, null, 2));
    });

    it('loads an empty valid state silently', () => {
      new GuiEvolution().load('{"entries":[]}');
      expect(warn).not.toHaveBeenCalled();
    });
  });

  describe('getMachinePersona', () => {
    it('warns when active-persona.json is corrupt and a persona is reassigned', () => {
      const pdir = join(dir, '.omx', 'atelier', 'personas');
      mkdirSync(pdir, { recursive: true });
      const file = join(pdir, 'active-persona.json');
      writeFileSync(file, '{torn');
      const persona = getMachinePersona(dir);
      expect(typeof persona?.id).toBe('string');
      expect(msgs()).toEqual([`active-persona.json unreadable (reassigning persona): ${file}:`]);
    });

    it('is silent on first run', () => {
      getMachinePersona(dir);
      expect(warn).not.toHaveBeenCalled();
    });
  });

  describe('RecipeBook.loadOrCreate', () => {
    it('warns when a torn recipes.json is reseeded', () => {
      mkdirSync(gameDir(), { recursive: true });
      const file = join(gameDir(), 'recipes.json');
      writeFileSync(file, '{torn');
      const book = loadOrCreate(dir);
      expect(book.schema).toBe('sinter.recipes/0.1');
      expect(msgs()).toEqual([`recipes.json unreadable (reseeding, learned recipes lost): ${file}:`]);
    });

    it('reseeds silently when the file is absent (ENOENT)', () => {
      expect(loadOrCreate(dir).version).toBe(1);
      expect(existsSync(join(gameDir(), 'recipes.json'))).toBe(true);
      expect(warn).not.toHaveBeenCalled();
    });
  });

  describe('LoopPersistence SinterFS ref failure', () => {
    it('warns but still saves the gallery iteration', async () => {
      const galleryDir = mkdtempSync(join(tmpdir(), 'sc3-gallery-'));
      const fs = SinterFS.open(dir);
      const gallery = new Gallery(galleryDir);
      const refSpy = vi.spyOn(GalleryFSAdapter.prototype, 'writeGalleryVersionRef')
        .mockImplementation(() => { throw new Error('ref store down'); });
      try {
        const persistence = new LoopPersistence(gallery, { project: 'p' } as never, fs);
        await persistence.saveIteration(1, 'const x = 1;');
        expect(msgs()).toEqual(['SinterFS gallery version ref not written:']);
        const history = await gallery.loadHistory('p');
        expect(history).toHaveLength(1);
      } finally {
        refSpy.mockRestore();
        fs.close();
        rmSync(galleryDir, { recursive: true, force: true });
      }
    });
  });
});
