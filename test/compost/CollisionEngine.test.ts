import { describe, it, expect, vi, beforeEach } from 'vitest';
/**
 * Tests for CollisionEngine — cross-domain collision pairing.
 */

import { CollisionEngine } from '../../src/compost/CollisionEngine.js';
import { mergeConfig } from '../../src/compost/defaults.js';
import type { CompostFragment } from '../../src/compost/types.js';

function makeFragment(overrides: Partial<CompostFragment> = {}): CompostFragment {
  return {
    id: `frag-${Math.random().toString(36).slice(2, 8)}`,
    source: '/test/file.txt',
    domain: 'ceramics',
    layer: 'semantic',
    content: 'Glaze dynamics in kiln firing.',
    metadata: {
      fileType: 'txt',
      timestamp: '2026-03-20T12:00:00Z',
      hash: 'a'.repeat(64),
      size: 100,
      extractedAt: '2026-03-20T00:00:00Z',
    },
    tags: ['ceramics'],
    ...overrides,
  };
}

describe('CollisionEngine', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let mockLLM: any;
  let engine: CollisionEngine;

  beforeEach(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mockFn: any = vi.fn();
    mockFn.mockResolvedValue({ success: true, code: 'Merged idea' });
    mockLLM = { generate: mockFn };
    engine = new CollisionEngine(mergeConfig(), mockLLM);
  });

  describe('findTimestampCollisions()', () => {
    it('pairs files within 1 hour from different domains', () => {
      const fragments = [
        makeFragment({ domain: 'ceramics', metadata: { ...makeFragment().metadata, timestamp: '2026-03-20T12:00:00Z' } }),
        makeFragment({ domain: 'music', metadata: { ...makeFragment().metadata, timestamp: '2026-03-20T12:30:00Z' } }),
        makeFragment({ domain: 'ceramics', metadata: { ...makeFragment().metadata, timestamp: '2026-03-20T15:00:00Z' } }),
      ];
      const pairs = engine.findTimestampCollisions(fragments);
      expect(pairs.length).toBeGreaterThanOrEqual(1);
      expect(pairs[0].strategy).toBe('timestamp');
    });
  });

  describe('findSizeCollisions()', () => {
    it('pairs files of similar byte size from different types', () => {
      const fragments = [
        makeFragment({ domain: 'image', metadata: { ...makeFragment().metadata, size: 1024 } }),
        makeFragment({ domain: 'audio', metadata: { ...makeFragment().metadata, size: 1025 } }),
        makeFragment({ domain: 'text', metadata: { ...makeFragment().metadata, size: 50000 } }),
      ];
      const pairs = engine.findSizeCollisions(fragments);
      expect(pairs.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('findTagCollisions()', () => {
    it('pairs fragments sharing tags from unrelated domains', () => {
      const fragments = [
        makeFragment({ domain: 'ceramics', tags: ['experimental'] }),
        makeFragment({ domain: 'music', tags: ['experimental'] }),
      ];
      const pairs = engine.findTagCollisions(fragments);
      expect(pairs.length).toBeGreaterThanOrEqual(1);
      expect(pairs[0].strategy).toBe('tag');
    });
  });

  describe('findDomainOpposites()', () => {
    it('pairs most-different domains', () => {
      const fragments = [
        makeFragment({ domain: 'ceramics' }),
        makeFragment({ domain: 'music' }),
        makeFragment({ domain: '3d' }),
      ];
      const pairs = engine.findDomainOpposites(fragments);
      expect(pairs.length).toBeGreaterThanOrEqual(1);
      expect(pairs[0].strategy).toBe('domain-opposite');
    });
  });

  describe('findRandomCollisions()', () => {
    it('returns stochastic sampling without building full pair array', () => {
      const fragments = Array.from({ length: 20 }, (_, i) =>
        makeFragment({ id: `frag-rand-${i}`, domain: i % 2 === 0 ? 'a' : 'b' })
      );
      const pairs = engine.findRandomCollisions(fragments);
      // Capped at min(200, fragments.length * 2) = 40
      expect(pairs.length).toBeGreaterThan(0);
      expect(pairs.length).toBeLessThanOrEqual(40);
      // All pairs should be cross-domain
      for (const pair of pairs) {
        expect(pair.a.domain).not.toBe(pair.b.domain);
      }
    });
  });

  describe('mergePair()', () => {
    it('calls LLM with collision prompt', async () => {
      const a = makeFragment({ domain: 'ceramics', content: 'Clay glazing technique' });
      const b = makeFragment({ domain: 'music', content: 'Rhythmic patterns' });

      const result = await engine.mergePair(a, b);
      expect(result).toBe('Merged idea');
      expect(mockLLM.generate).toHaveBeenCalledWith(
        expect.stringContaining('cross-domain collision engine'),
        expect.stringContaining('[Fragment A — domain: ceramics, layer: semantic]\nClay glazing technique'),
      );
    });
  });

  describe('runAll()', () => {
    it('returns CollisionResult[] from all strategies', async () => {
      const fragments = [
        makeFragment({ domain: 'ceramics', tags: ['experimental'] }),
        makeFragment({ domain: 'music', tags: ['experimental'] }),
        makeFragment({ domain: '3d' }),
        makeFragment({ domain: 'code' }),
      ];
      const results = await engine.runAll(fragments);
      expect(results.length).toBeGreaterThan(0);
      const strategies = results.map(r => r.strategy);
      expect(strategies).toContain('timestamp');
    });
  });

  describe('placeholder honesty', () => {
    const a = makeFragment({ domain: 'ceramics', content: 'Clay' });
    const b = makeFragment({ domain: 'music', content: 'Rhythm' });

    it('flags a merge as a placeholder when there is no LLM', async () => {
      const noLlm = new CollisionEngine(mergeConfig({}));
      expect(await noLlm.mergePairResult(a, b)).toEqual({
        content: '[ceramics + music] Clay ... Rhythm',
        placeholder: true,
        reason: 'no-llm',
      });
    });

    it('flags an unsuccessful LLM merge as a placeholder', async () => {
      const failing = new CollisionEngine(mergeConfig({}), { generate: vi.fn().mockResolvedValue({ success: false, code: '' }) } as never);
      expect(await failing.mergePairResult(a, b)).toEqual({
        content: '[ceramics + music] collision',
        placeholder: true,
        reason: 'llm-unsuccessful',
      });
    });

    it('flags a thrown LLM merge as a placeholder', async () => {
      const throwing = new CollisionEngine(mergeConfig({}), { generate: vi.fn().mockRejectedValue(new Error('boom')) } as never);
      const result = await throwing.mergePairResult(a, b);
      expect(result.placeholder).toBe(true);
      expect(result.reason).toBe('llm-error');
    });

    it('marks runAll results from failed merges as placeholders and real merges as not', async () => {
      const failing = new CollisionEngine(mergeConfig({}), { generate: vi.fn().mockResolvedValue({ success: false, code: '' }) } as never);
      const results = await failing.runAll([
        makeFragment({ domain: 'ceramics' }),
        makeFragment({ domain: 'music' }),
      ]);
      expect(results.length).toBeGreaterThanOrEqual(1);
      expect(results.every(r => r.placeholder === true && r.placeholderReason === 'llm-unsuccessful')).toBe(true);

      const real = await engine.runAll([makeFragment({ domain: 'ceramics' }), makeFragment({ domain: 'music' })]);
      expect(real.every(r => r.placeholder === undefined && r.mergedContent === 'Merged idea')).toBe(true);
    });
  });
});
