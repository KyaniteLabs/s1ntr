import { describe, it, expect, beforeEach, afterEach } from 'vitest';
/**
 * Tests for SoupStateManager — persistent soup loop state.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { SoupStateManager } from '../../src/compost/SoupStateManager.js';
import { mergeConfig } from '../../src/compost/defaults.js';
import type { SoupState, CompostFragment } from '../../src/compost/types.js';

describe('SoupStateManager', () => {
  let tmpDir: string;
  let manager: SoupStateManager;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'soup-state-test-'));
    const config = mergeConfig({ seedDir: path.join(tmpDir, 'seeds') });
    manager = new SoupStateManager(config, path.join(tmpDir, 'soup-state.json'));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  describe('load()', () => {
    it('returns default state when no file exists', async () => {
      const state = await manager.load();
      expect(state.generation).toBe(0);
      expect(state.population).toEqual([]);
      expect(state.bestSeed).toBeNull();
      expect(state.totalSeedsPromoted).toBe(0);
    });
  });

  describe('load() with bad state', () => {
    it('quarantines invalid JSON instead of letting the next save destroy it', async () => {
      const statePath = path.join(tmpDir, 'soup-state.json');
      await fs.writeFile(statePath, '{not json', 'utf-8');

      const state = await manager.load();
      const issue = manager.getLastLoadIssue();

      expect(state.generation).toBe(0);
      expect(issue?.kind).toBe('invalid');
      expect(issue?.quarantinedTo).toMatch(/soup-state\.json\.corrupt-\d+$/);
      expect(await fs.readFile(issue!.quarantinedTo!, 'utf-8')).toBe('{not json');
      await expect(fs.access(statePath)).rejects.toMatchObject({ code: 'ENOENT' });
    });

    it('quarantines schema-invalid state', async () => {
      await fs.writeFile(path.join(tmpDir, 'soup-state.json'), JSON.stringify({ generation: 'many' }), 'utf-8');

      await manager.load();

      expect(manager.getLastLoadIssue()?.kind).toBe('invalid');
    });

    it('reports an unreadable non-file state path without moving it', async () => {
      const dirAsState = new SoupStateManager(mergeConfig({}), tmpDir);

      const state = await dirAsState.load();
      const issue = dirAsState.getLastLoadIssue();

      expect(state.generation).toBe(0);
      expect(issue?.kind).toBe('unreadable');
      expect(issue?.detail).toMatch(/EISDIR/);
      expect(issue?.quarantinedTo).toBeUndefined();
      expect((await fs.stat(tmpDir)).isDirectory()).toBe(true);
    });

    it('reports no issue for a missing file or a clean load', async () => {
      await manager.load();
      expect(manager.getLastLoadIssue()).toBeNull();
      await manager.save({ population: [], generation: 3, bestSeed: null, totalSeedsPromoted: 0, domainHeatmap: {}, lastCycleAt: '' });
      expect((await manager.load()).generation).toBe(3);
      expect(manager.getLastLoadIssue()).toBeNull();
    });
  });

  describe('save() + load()', () => {
    it('persists and restores state', async () => {
      const state: SoupState = {
        population: [],
        generation: 42,
        bestSeed: null,
        totalSeedsPromoted: 5,
        domainHeatmap: { 'ceramics-music': 10 },
        lastCycleAt: '2026-03-20T00:00:00Z',
      };
      await manager.save(state);
      const loaded = await manager.load();
      expect(loaded.generation).toBe(42);
      expect(loaded.totalSeedsPromoted).toBe(5);
      expect(loaded.domainHeatmap['ceramics-music']).toBe(10);
    });
  });

  describe('updateGeneration()', () => {
    it('increments generation and updates lastCycleAt', async () => {
      let state = await manager.load();
      state = manager.updateGeneration(state);
      expect(state.generation).toBe(1);
      expect(state.lastCycleAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    });
  });

  describe('recordPromotion()', () => {
    it('increments totalSeedsPromoted and updates bestSeed', async () => {
      const seed: CompostFragment = {
        id: 'best', source: 'x', domain: 'ceramics', layer: 'semantic',
        content: 'Best idea', metadata: { fileType: '', timestamp: '', hash: '', size: 0, extractedAt: '' },
        tags: [], score: 9.5,
      };
      let state = await manager.load();
      state = manager.recordPromotion(state, seed);
      expect(state.totalSeedsPromoted).toBe(1);
      expect(state.bestSeed?.id).toBe('best');
    });
  });

  describe('updateHeatmap()', () => {
    it('updates domain heatmap scores', async () => {
      let state = await manager.load();
      state = manager.updateHeatmap(state, 'ceramics', 'music', 8.5);
      expect(state.domainHeatmap['ceramics-music']).toBe(8.5);
    });
  });

  describe('replaceWorst()', () => {
    it('replaces lowest-scored population member', async () => {
      const worse: CompostFragment = {
        id: 'worst', source: 'x', domain: 'a', layer: 'semantic',
        content: 'bad', metadata: { fileType: '', timestamp: '', hash: '', size: 0, extractedAt: '' },
        tags: [], score: 2,
      };
      const better: CompostFragment = {
        id: 'better', source: 'y', domain: 'b', layer: 'semantic',
        content: 'good', metadata: { fileType: '', timestamp: '', hash: '', size: 0, extractedAt: '' },
        tags: [], score: 8,
      };
      let state = await manager.load();
      state.population = [worse];
      state = manager.replaceWorst(state, better);
      expect(state.population).toHaveLength(1);
      expect(state.population[0].id).toBe('better');
    });
  });

  describe('corrupt state', () => {
    it('handles corrupt state file gracefully', async () => {
      await fs.writeFile(path.join(tmpDir, 'soup-state.json'), 'NOT JSON{{{', 'utf-8');
      const state = await manager.load();
      expect(state.generation).toBe(0);
      expect(state.population).toEqual([]);
    });
  });
});
