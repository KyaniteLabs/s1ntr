/**
 * CompostRehydrator — selection and score carry-through (#1304).
 * Real module, no mocks.
 */
import { describe, it, expect } from 'vitest';
import { CompostRehydrator } from '../../../src/compost/CompostRehydrator.js';
import type { CompostFragment } from '../../../src/compost/types.js';

const DENSE = 'function draw() { if (x > 10) { render(10, 20); } for (let i = 0; i < 5; i++) { update(i); } }';

function frag(id: string, overrides: Partial<CompostFragment> = {}): CompostFragment {
  return {
    id,
    source: `${id}.ts`,
    domain: 'code',
    layer: 'semantic',
    content: DENSE,
    metadata: { fileType: 'text', timestamp: '2026-04-04T00:00:00Z', hash: id, size: DENSE.length, extractedAt: '2026-04-04T00:00:00Z' },
    tags: ['code'],
    ...overrides,
  };
}

describe('CompostRehydrator', () => {
  it('breaks motif-density ties by promotion score so computed scores drive selection (#1304)', () => {
    const r = new CompostRehydrator({ maxPerBatch: 1, minMotifDensity: 0 });
    const picked = r.findRehydratable([frag('low', { score: 1 }), frag('high', { score: 9 }), frag('mid', { score: 5 })]);
    expect(picked.map(f => f.id)).toEqual(['high']);
  });

  it('carries source fragment scores onto rehydrated candidates in sourceIds order (#1304)', () => {
    const r = new CompostRehydrator({ minMotifDensity: 0 });
    const candidates = r.rehydrate([frag('a', { score: 8.5 }), frag('b', { score: 2 })]);
    expect(candidates).toHaveLength(1);
    expect(candidates[0].sourceIds).toEqual(['a', 'b']);
    expect(candidates[0].sourceScores).toEqual([8.5, 2]);
  });

  it('reports 0 for unscored fragments and includes cross-domain candidate scores', () => {
    const r = new CompostRehydrator({ minMotifDensity: 0 });
    const candidates = r.rehydrate([frag('a'), frag('b', { domain: 'music', score: 3 })]);
    expect(candidates.map(c => c.sourceScores)).toEqual([[0], [3], [0, 3]]);
  });

  it('returns nothing for empty input or fragments below the motif threshold', () => {
    const r = new CompostRehydrator();
    expect(r.findRehydratable([])).toEqual([]);
    expect(r.rehydrate([])).toEqual([]);
    expect(r.findRehydratable([frag('plain', { content: 'just some plain prose words here', score: 9 })])).toEqual([]);
  });
});
