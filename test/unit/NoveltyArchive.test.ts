import { describe, it, expect } from 'vitest';
/**
 * NoveltyArchive unit tests
 */

import { NoveltyArchive } from '../../src/evolution/NoveltyArchive.js';

describe('NoveltyArchive', () => {
  describe('noveltyScore', () => {
    it('should return 1.0 for empty archive', () => {
      const archive = new NoveltyArchive();
      expect(archive.noveltyScore([0.5, 0.5])).toBe(1.0);
    });

    it('should return low score for similar items', () => {
      const archive = new NoveltyArchive();
      archive.add([0.5, 0.5]);
      archive.add([0.5, 0.5]);
      archive.add([0.5, 0.5]);
      // New item is very similar to existing ones
      expect(archive.noveltyScore([0.5, 0.5])).toBeCloseTo(0, 1);
    });

    it('should return high score for novel item', () => {
      const archive = new NoveltyArchive();
      archive.add([0.0, 0.0]);
      archive.add([0.1, 0.1]);
      archive.add([0.2, 0.2]);
      // New item is far from existing
      expect(archive.noveltyScore([0.9, 0.9])).toBeGreaterThan(0.3);
    });
  });

  describe('sparseness', () => {
    it('should be same as noveltyScore', () => {
      const archive = new NoveltyArchive();
      archive.add([0.5, 0.5]);
      archive.add([0.1, 0.9]);
      const novelty = archive.noveltyScore([0.7, 0.3]);
      const sparseness = archive.sparseness([0.7, 0.3]);
      expect(sparseness).toBe(novelty);
    });
  });

  describe('capacity', () => {
    it('should evict oldest items when at capacity', () => {
      const archive = new NoveltyArchive(3, 5);
      archive.add([1.0, 0.0]);
      archive.add([2.0, 0.0]);
      archive.add([3.0, 0.0]);
      archive.add([4.0, 0.0]); // evicts [1.0, 0.0]
      expect(archive.size()).toBe(3);
      // Novelty should be higher since [1.0, 0.0] was evicted
      expect(archive.noveltyScore([1.0, 0.0])).toBeGreaterThan(0);
    });
  });

  describe('k neighbors', () => {
    it('should use fewer neighbors when archive is small', () => {
      const archive = new NoveltyArchive(100, 10);
      archive.add([0.0, 0.0]);
      archive.add([1.0, 1.0]);
      // Only 2 items, so k=min(10, 2)=2
      const score = archive.noveltyScore([0.5, 0.5]);
      expect(score).toBeGreaterThan(0);
    });
  });

  describe('clear', () => {
    it('should remove all items', () => {
      const archive = new NoveltyArchive();
      archive.add([0.5, 0.5]);
      archive.add([0.5, 0.5]);
      archive.clear();
      expect(archive.size()).toBe(0);
      expect(archive.noveltyScore([0.5, 0.5])).toBe(1.0);
    });
  });

  describe('different dimensions', () => {
    it('scores a missing-axis query as 0 instead of padding it to look novel', () => {
      const archive = new NoveltyArchive();
      archive.add([0.5, 0.5, 0.5]);
      expect(archive.noveltyScore([0.0, 0.0])).toBe(0);
      expect(archive.add([0.0, 0.0])).toBe(false);
      expect(archive.size()).toBe(1);
    });
  });

  describe('attribution and insufficiency (#1270)', () => {
    it('flags empty and non-finite descriptors as insufficient with score 0', () => {
      const archive = new NoveltyArchive();
      archive.add([0.1, 0.1]);
      expect(archive.assess([])).toEqual({ score: 0, sufficient: false, reason: 'invalid-descriptor', neighborRoots: 0 });
      expect(archive.assess([Number.NaN, 0.5])).toEqual({ score: 0, sufficient: false, reason: 'invalid-descriptor', neighborRoots: 0 });
      expect(archive.noveltyScore([])).toBe(0);
      expect(archive.add([Number.POSITIVE_INFINITY, 0])).toBe(false);
      expect(archive.size()).toBe(1);
    });

    it('flags missing-axis input against the fixed descriptor schema', () => {
      const archive = new NoveltyArchive();
      archive.add([0.2, 0.4, 0.6]);
      expect(archive.assess([0.9, 0.9])).toEqual({ score: 0, sufficient: false, reason: 'missing-axis', neighborRoots: 0 });
    });

    it('keeps the empty-archive default score but marks it insufficient', () => {
      const archive = new NoveltyArchive();
      expect(archive.assess([0.5, 0.5])).toEqual({ score: 1, sufficient: false, reason: 'empty-archive', neighborRoots: 0 });
    });

    it('does not double-count a re-added artifact and flags it as duplicate', () => {
      const archive = new NoveltyArchive();
      expect(archive.add([0.1, 0.9], { artifactId: 'a1', rootId: 'r1' })).toBe(true);
      expect(archive.add([0.1, 0.9], { artifactId: 'a1', rootId: 'r1' })).toBe(false);
      expect(archive.size()).toBe(1);
      expect(archive.assess([0.1, 0.9], { artifactId: 'a1' })).toEqual({ score: 0, sufficient: false, reason: 'duplicate-artifact', neighborRoots: 0 });
    });

    it('reports distinct neighbour roots for a sufficient assessment', () => {
      const archive = new NoveltyArchive(10, 3);
      archive.add([0, 0], { artifactId: 'a', rootId: 'r1' });
      archive.add([0, 1], { artifactId: 'b', rootId: 'r1' });
      archive.add([1, 0], { artifactId: 'c', rootId: 'r2' });
      const result = archive.assess([0, 0], { artifactId: 'new' });
      expect(result.sufficient).toBe(true);
      expect(result.neighborRoots).toBe(2);
      expect(result.score).toBeCloseTo((0 + Math.SQRT1_2 + Math.SQRT1_2) / 3, 10);
    });

    it('clear() resets the descriptor schema and attribution', () => {
      const archive = new NoveltyArchive();
      archive.add([0.1, 0.2], { artifactId: 'a' });
      archive.clear();
      expect(archive.add([0.1, 0.2, 0.3], { artifactId: 'a' })).toBe(true);
      expect(archive.size()).toBe(1);
    });
  });
});
