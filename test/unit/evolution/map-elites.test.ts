import { describe, it, expect, vi } from 'vitest';
/**
 * MAP-Elites tests
 */

import { MapElites } from '../../../src/evolution/MapElites.js';
import { createExplorationDecisionAdmission } from
  '../../../src/evolution/ExplorationDecisionAdmission.js';

const digest = (char: string) => char.repeat(64);
const admitted = (artifactId: string, purpose: 'parent-selection' | 'evolution-reward') =>
  createExplorationDecisionAdmission({ purpose, artifactId, role: 'generator', domain: 'p5',
    ownerDecision: 'accepted',
    criterionScore: 0.8, artifactDigest: digest('a'), evidenceDigest: digest('b'),
    decisionDigest: digest('c'), criterionDigest: digest('d'), rendered: true,
    identityValid: true, digestMatched: true, degraded: false });

describe('MapElites', () => {
  it('constructor defaults to 10x10', () => {
    const me = new MapElites();
    expect(me.size()).toBe(0);
    // 10x10 grid => coverage denominator is 100
    me.insert('a', [0, 0], 1);
    expect(me.coverage()).toBe(1 / 100);
  });

  it('constructor accepts custom dims', () => {
    const me = new MapElites([5, 5]);
    me.insert('a', [0, 0], 1);
    expect(me.coverage()).toBe(1 / 25);
  });

  it('insert adds to empty cell and returns true', () => {
    const me = new MapElites();
    const result = me.insert('a', [0.5, 0.5], 0.8);
    expect(result).toBe(true);
    expect(me.size()).toBe(1);
  });

  it('retains scalar exploration without granting parent eligibility', () => {
    const me = new MapElites();
    me.insert('scalar-only', [0.5, 0.5], 1);
    expect(me.getAllCells()).toHaveLength(1);
    expect(me.getParentElites(3, { role: 'generator', domain: 'p5' })).toEqual([]);
    me.insertAdmitted('parent', [0.8, 0.8], admitted('parent', 'parent-selection'));
    expect(me.getParentElites(3, { role: 'generator', domain: 'p5' })
      .map(cell => cell.creationId)).toEqual(['parent']);
  });

  it('returns detached projections while MapElites remains the writer', () => {
    const me = new MapElites();
    me.insert('original', [0.5, 0.5], 0.4);
    const projected = me.getAllCells();
    projected[0]!.fitness = 1;
    projected[0]!.behavior[0] = 0;
    const stored = me.get(5, 5)!;
    expect(stored.fitness).toBe(0.4);
    expect(stored.behavior[0]).toBe(0.5);
  });

  it('insert replaces if higher fitness and returns true', () => {
    const me = new MapElites();
    me.insert('a', [0.3, 0.3], 0.5);
    const result = me.insert('b', [0.3, 0.3], 0.9);
    expect(result).toBe(true);
    expect(me.size()).toBe(1);
    // [0.3, 0.3] -> Math.floor(0.3 * 10) = 3
    const cell = me.get(3, 3);
    expect(cell?.creationId).toBe('b');
    expect(cell?.fitness).toBe(0.9);
  });

  it('insert rejects if lower fitness and returns false', () => {
    const me = new MapElites();
    me.insert('a', [0.3, 0.3], 0.9);
    const result = me.insert('b', [0.3, 0.3], 0.5);
    expect(result).toBe(false);
    expect(me.size()).toBe(1);
    expect(me.get(3, 3)?.creationId).toBe('a');
  });

  it('get returns cell at coordinates', () => {
    const me = new MapElites();
    me.insert('a', [0.0, 0.0], 0.7);
    const cell = me.get(0, 0);
    expect(cell!.creationId).toBe('a');
    expect(cell!.fitness).toBe(0.7);
  });

  it('get returns null for empty cell', () => {
    const me = new MapElites();
    expect(me.get(5, 5)).toBeNull();
  });

  it('getElites returns top N sorted by fitness desc', () => {
    const me = new MapElites();
    me.insert('low', [0.0, 0.0], 0.1);
    me.insert('mid', [0.5, 0.5], 0.5);
    me.insert('high', [1.0, 1.0], 0.9);
    const elites = me.getElites(2);
    expect(elites).toHaveLength(2);
    expect(elites[0].creationId).toBe('high');
    expect(elites[0].fitness).toBe(0.9);
    expect(elites[1].creationId).toBe('mid');
    expect(elites[1].fitness).toBe(0.5);
  });

  it('coverage calculates correctly (0 when empty, increases with inserts)', () => {
    const me = new MapElites([4, 4]);
    expect(me.coverage()).toBe(0);
    me.insert('a', [0.0, 0.0], 1);
    expect(me.coverage()).toBe(1 / 16);
    me.insert('b', [1.0, 1.0], 1);
    expect(me.coverage()).toBe(2 / 16);
  });

  it('size returns occupied cell count', () => {
    const me = new MapElites();
    expect(me.size()).toBe(0);
    me.insert('a', [0.0, 0.0], 1);
    expect(me.size()).toBe(1);
    me.insert('b', [1.0, 1.0], 1);
    expect(me.size()).toBe(2);
    // Same cell doesn't increase size
    me.insert('c', [0.0, 0.0], 2);
    expect(me.size()).toBe(2);
  });

  it('clear empties the grid', () => {
    const me = new MapElites();
    me.insert('a', [0.5, 0.5], 1);
    expect(me.size()).toBe(1);
    me.clear();
    expect(me.size()).toBe(0);
    expect(me.coverage()).toBe(0);
    expect(me.get(5, 5)).toBeNull();
  });

  it('behaviorToCell clamps behavior values to valid range', () => {
    const me = new MapElites([10, 10]);
    // Values outside [0, 1] should be clamped
    me.insert('neg', [-1, -1], 1);
    expect(me.get(0, 0)?.creationId).toBe('neg');

    me.insert('pos', [2, 2], 1);
    expect(me.get(9, 9)?.creationId).toBe('pos');

    me.insert('mid', [0.5, 0.5], 1);
    expect(me.get(5, 5)?.creationId).toBe('mid');
  });

  it('last bin is reachable for b < 1, not only at the endpoint (#1266)', () => {
    const me = new MapElites([10, 10]);
    me.insert('high', [0.95, 0.95], 1);
    expect(me.get(9, 9)?.creationId).toBe('high');
    expect(me.get(8, 8)).toBeNull();
  });

  it('bins are equal width: 1000 evenly spaced samples fill each of 10 bins 100 times (#1266)', () => {
    const counts = new Array(10).fill(0);
    for (let i = 0; i < 1000; i++) {
      const me = new MapElites([10, 10]);
      me.insert('x', [(i + 0.5) / 1000, 0], 1);
      const bin = counts.findIndex((_, x) => me.get(x, 0) !== null);
      expect(bin).not.toBe(-1);
      counts[bin]++;
    }
    expect(counts).toEqual(new Array(10).fill(100));
  });

  it('load re-keys cells saved under the old binning formula (#1266)', async () => {
    const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { tmpdir } = await import('node:os');
    const dir = mkdtempSync(join(tmpdir(), 'mapelites-rekey-'));
    try {
      const file = join(dir, 'archive.json');
      // Old formula put 0.5 at bin 4 and both 0.95 and 0.85 at bin 7/8.
      writeFileSync(file, JSON.stringify({
        dims: [10, 10],
        cells: [
          ['4,4', { creationId: 'mid', fitness: 0.5, behavior: [0.5, 0.5] }],
          ['8,8', { creationId: 'hi-weak', fitness: 0.2, behavior: [0.95, 0.95] }],
          ['7,7', { creationId: 'hi-strong', fitness: 0.9, behavior: [0.96, 0.96] }],
        ],
      }));
      const me = new MapElites([10, 10]);
      await me.load(file);
      expect(me.get(4, 4)).toBeNull();
      expect(me.get(5, 5)?.creationId).toBe('mid');
      expect(me.get(9, 9)?.creationId).toBe('hi-strong');
      expect(me.size()).toBe(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('uses equal-width bins so the last bin is reachable below 1 (#1267)', () => {
    const me = new MapElites([10, 10]);
    me.insert('high', [0.95, 0.95], 1);
    expect(me.get(9, 9)?.creationId).toBe('high');
    me.insert('low', [0.05, 0.05], 1);
    expect(me.get(0, 0)?.creationId).toBe('low');
    me.insert('edge', [0.1, 0.1], 1);
    expect(me.get(1, 1)?.creationId).toBe('edge');
  });

  it('getDiverseElite compares blended scores, not raw fitness (#1267)', () => {
    const me = new MapElites([10, 10]);
    me.insert('stronger', [0.15, 0.15], 0.95);
    me.insert('weaker', [0.85, 0.85], 0.9);
    // Math.random() = 0 shuffles 'weaker' into the first tournament slot. The old
    // code seeded bestScore with its raw fitness (0.9), which the blended score of
    // 'stronger' (0.95 * 0.7 + 0.5 * 0.3 = 0.815) could never beat.
    const random = vi.spyOn(Math, 'random').mockReturnValue(0);
    try {
      expect(me.getDiverseElite(1).map(cell => cell.creationId)).toEqual(['stronger']);
    } finally {
      random.mockRestore();
    }
  });

  it('getAllCells returns all occupied cells', () => {
    const me = new MapElites();
    me.insert('a', [0.0, 0.0], 0.3);
    me.insert('b', [1.0, 1.0], 0.8);
    const cells = me.getAllCells();
    expect(cells).toHaveLength(2);
    const ids = cells.map((c) => c.creationId).sort();
    expect(ids).toEqual(['a', 'b']);
  });

  describe('insertWithEmbedding derives behavior by coordinate sampling, not reduction (#1269)', () => {
    it('reads evenly spaced coordinates mapped from [-1, 1] to [0, 1]', () => {
      const me = new MapElites([10, 10]);
      // len 4, 2 dims -> samples indices 0 and 2
      expect(me.insertWithEmbedding('a', 1, [1, 0.3, -1, 0.9])).toBe(true);
      expect(me.getAllCells()[0].behavior).toEqual([1, 0]);
    });

    it('ignores unsampled coordinates entirely (no projection mixes them in)', () => {
      const a = new MapElites([10, 10]);
      const b = new MapElites([10, 10]);
      a.insertWithEmbedding('a', 1, [0.2, -1, 0.6, -1]);
      b.insertWithEmbedding('b', 1, [0.2, 1, 0.6, 1]);
      expect(a.getAllCells()[0].behavior).toEqual(b.getAllCells()[0].behavior);
      expect(a.getAllCells()[0].behavior[0]).toBeCloseTo(0.6, 10);
      expect(a.getAllCells()[0].behavior[1]).toBeCloseTo(0.8, 10);
    });

    it('clamps out-of-range coordinates instead of extrapolating', () => {
      const me = new MapElites([10, 10]);
      me.insertWithEmbedding('a', 1, [3, 0, -5, 0]);
      expect(me.getAllCells()[0].behavior).toEqual([1, 0]);
    });
  });
});

