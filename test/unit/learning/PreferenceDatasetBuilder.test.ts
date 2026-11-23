/**
 * Unit tests for PreferenceDatasetBuilder — Phase 15
 *
 * Tests training pair construction from preference records.
 */

import { describe, it, expect } from 'vitest';
import { PreferenceDatasetBuilder } from '../../../src/learning/PreferenceDatasetBuilder.js';
import type { ArchiveEntry } from '../../../src/emergence/types.js';

function makeDescriptor(values: number[]): import('../../../src/emergence/types.js').BehaviorDescriptor {
  const axes = ['order-chaos', 'sparse-dense', 'symmetry-asymmetry'];
  return {
    values: values.map((v, i) => ({ axis: axes[i] as any, value: v })),
    source: 'test',
    extractedAt: new Date().toISOString(),
  };
}

function makeEntry(
  id: string,
  descValues: number[],
  quality: number,
  preference?: ArchiveEntry['preference'],
): ArchiveEntry {
  return {
    id,
    artifactRef: { kind: 'test', path: `test/${id}` },
    descriptor: makeDescriptor(descValues),
    lineage: { artifactId: id, parentIds: [], provenance: 'fresh-generation', createdAt: new Date().toISOString() },
    qualityScore: quality,
    signals: { novelty: 0.5, structure: 0.5, temporalRichness: 0.5, perturbationResilience: 0.5, fertility: 0.5, aesthetic: 0.5 },
    preference,
    archivedAt: new Date().toISOString(),
  };
}

describe('PreferenceDatasetBuilder', () => {
  it('returns empty dataset when entries have no preferences', () => {
    const builder = new PreferenceDatasetBuilder();
    const entries = [
      makeEntry('a', [0.5], 0.6),
      makeEntry('b', [0.7], 0.7),
    ];
    const dataset = builder.build(entries);
    expect(dataset.pairs).toHaveLength(0);
  });

  it('creates pairs from pairwise comparisons', () => {
    const builder = new PreferenceDatasetBuilder();
    const entries = [
      makeEntry('a', [0.7], 0.7, {
        action: 'pairwise-a',
        artifactId: 'a',
        comparedTo: 'b',
        capturedAt: new Date().toISOString(),
      }),
      makeEntry('b', [0.3], 0.4),
    ];
    const dataset = builder.build(entries);
    expect(dataset.pairs.length).toBeGreaterThanOrEqual(1);
    // Winner should have higher quality
    expect(dataset.pairs[0].winner.quality).toBeGreaterThan(dataset.pairs[0].loser.quality);
  });

  it('a rejected high scorer loses to its neighbours and never wins a score-gap pair (F11)', () => {
    const builder = new PreferenceDatasetBuilder();
    const entries = [
      makeEntry('rejected-high', [0.5], 0.95, { action: 'reject', artifactId: 'rejected-high', capturedAt: new Date().toISOString() }),
      makeEntry('n1', [0.52], 0.5),
      makeEntry('n2', [0.2], 0.2),
    ];
    const { pairs } = builder.build(entries);
    expect(pairs.some((p) => p.winner.id === 'rejected-high')).toBe(false);
    const human = pairs.filter((p) => p.loser.id === 'rejected-high' && p.channel === 'human');
    expect(human.length).toBeGreaterThanOrEqual(1);
    expect(human[0].source).toBe('reject');
  });

  it('addSyntheticPair returns a pseudo-label pair, never a human pairwise label', () => {
    const builder = new PreferenceDatasetBuilder();
    const winner = makeEntry('winner', [0.9], 0.9);
    const loser = makeEntry('loser', [0.2], 0.2);
    const pair = builder.addSyntheticPair(winner, loser, 0.95);
    expect(pair.confidence).toBe(0.95);
    expect(pair.winner.id).toBe('winner');
    expect(pair.loser.id).toBe('loser');
    expect(pair.winner.quality).toBe(0.9);
    expect(pair.loser.quality).toBe(0.2);
    expect(pair.source).toBe('score-gap');
    expect(pair.channel).toBe('pseudo');
  });

  it('excludes inferred pairs when includeInferred is false', () => {
    const builder = new PreferenceDatasetBuilder({ includeInferred: false });
    const entries = [
      makeEntry('a', [0.7], 0.7, {
        action: 'pin',
        artifactId: 'a',
        capturedAt: new Date().toISOString(),
      }),
      makeEntry('b', [0.3], 0.4),
    ];
    const dataset = builder.build(entries);
    // Pin is inferred, not a direct comparison
    expect(dataset.pairs).toHaveLength(0);
  });

  it('filters by minConfidence', () => {
    const builder = new PreferenceDatasetBuilder({ minConfidence: 0.8 });
    const entries = [
      makeEntry('a', [0.7], 0.7, {
        action: 'pairwise-a',
        artifactId: 'a',
        comparedTo: 'b',
        capturedAt: new Date().toISOString(),
      }),
      makeEntry('b', [0.3], 0.4),
    ];
    const dataset = builder.build(entries);
    // Only pairs meeting the confidence threshold should be included
    for (const pair of dataset.pairs) {
      expect(pair.confidence).toBeGreaterThanOrEqual(0.8);
    }
  });

  describe('score-gap auto-feed (audit F7)', () => {
    it('builds pairs from evaluator score gaps when no human preference exists', () => {
      const builder = new PreferenceDatasetBuilder();
      const dataset = builder.build([
        makeEntry('hi', [0.2], 0.95),
        makeEntry('mid', [0.5], 0.7),
        makeEntry('lo', [0.8], 0.4),
      ]);
      // hi beats lo and mid (gaps 0.55, 0.25); mid beats lo (gap 0.3).
      expect(dataset.pairs).toHaveLength(3);
      for (const pair of dataset.pairs) {
        expect(pair.source).toBe('score-gap');
        expect(pair.confidence).toBe(0.4);
        expect(pair.winner.quality).toBeGreaterThan(pair.loser.quality);
      }
      expect(dataset.stats.sources['score-gap']).toBe(3);
    });

    it('respects the gap threshold and the per-winner cap', () => {
      const strict = new PreferenceDatasetBuilder({ scoreGapThreshold: 0.3 });
      const close = strict.build([makeEntry('a', [0.1], 0.8), makeEntry('b', [0.9], 0.65)]);
      expect(close.pairs).toHaveLength(0); // gap 0.15 < 0.3

      const many = new PreferenceDatasetBuilder().build([
        makeEntry('top', [0.1], 0.95),
        makeEntry('l1', [0.3], 0.3),
        makeEntry('l2', [0.5], 0.35),
        makeEntry('l3', [0.7], 0.4),
      ]);
      // top pairs with at most 2 losers despite 3 qualifying.
      expect(many.pairs.filter(p => p.winner.id === 'top')).toHaveLength(2);
    });

    it('can be disabled, restoring the human-only behavior', () => {
      const builder = new PreferenceDatasetBuilder({ includeScoreGapPairs: false });
      const dataset = builder.build([
        makeEntry('hi', [0.2], 0.95),
        makeEntry('lo', [0.8], 0.3),
      ]);
      expect(dataset.pairs).toHaveLength(0);
    });

    it('never adds a pseudo pair over an artifact pair a human already labeled', () => {
      const builder = new PreferenceDatasetBuilder();
      const dataset = builder.build([
        makeEntry('pinned', [0.2], 0.6, { action: 'pin', artifactId: 'pinned', capturedAt: new Date().toISOString() }),
        makeEntry('other', [0.8], 0.9),
      ]);
      expect(dataset.pairs.map(p => [p.source, p.channel, p.confidence])).toEqual([['pin', 'human', 0.6]]);
    });

    it('caps total pseudo-label mass relative to human mass', () => {
      const builder = new PreferenceDatasetBuilder();
      const now = new Date().toISOString();
      const entries = [
        makeEntry('h1', [0.5], 0.5, { action: 'pairwise-a', artifactId: 'h1', comparedTo: 'h2', capturedAt: now }),
        makeEntry('h2', [0.5], 0.5),
        ...Array.from({ length: 10 }, (_, i) => makeEntry(`s${i}`, [i / 10], i / 10)),
      ];
      const dataset = builder.build(entries);
      // Human mass 1.0 → pseudo budget 0.5 → one 0.4-confidence pseudo pair.
      expect(dataset.stats.channels).toEqual({ human: 1, pseudo: 1 });
      expect(dataset.stats.pseudoMassFraction).toBeCloseTo(0.4 / 1.4, 10);
      const pseudo = dataset.pairs.find(p => p.channel === 'pseudo');
      // Largest gap wins the budget: 0.9 over 0.0.
      expect([pseudo?.winner.id, pseudo?.loser.id]).toEqual(['s9', 's0']);
    });

    it('leaves the pseudo channel uncapped when no human pairs exist', () => {
      const dataset = new PreferenceDatasetBuilder().build(
        Array.from({ length: 10 }, (_, i) => makeEntry(`s${i}`, [i / 10], i / 10)),
      );
      expect(dataset.stats.channels.human).toBe(0);
      expect(dataset.stats.channels.pseudo).toBe(dataset.pairs.length);
      expect(dataset.stats.pseudoMassFraction).toBe(1);
    });
  });

  describe('nearest-niche neighbors', () => {
    const now = new Date().toISOString();
    it('pairs a pin with its nearest unpinned neighbors, not the first entries', () => {
      const dataset = new PreferenceDatasetBuilder({ includeScoreGapPairs: false }).build([
        makeEntry('far1', [0.0, 0.0], 0.5),
        makeEntry('far2', [0.05, 0.0], 0.5),
        makeEntry('far3', [0.1, 0.0], 0.5),
        makeEntry('near1', [0.9, 0.9], 0.5),
        makeEntry('near2', [0.85, 0.9], 0.5),
        makeEntry('near3', [0.8, 0.9], 0.5),
        makeEntry('pinned', [0.9, 0.95], 0.5, { action: 'pin', artifactId: 'pinned', capturedAt: now }),
      ]);
      expect(dataset.pairs.map(p => p.loser.id)).toEqual(['near1', 'near2', 'near3']);
    });

    it('pairs a branch with its two nearest-niche neighbors', () => {
      const dataset = new PreferenceDatasetBuilder({ includeScoreGapPairs: false }).build([
        makeEntry('far', [0.0], 0.5),
        makeEntry('near', [0.6], 0.5),
        makeEntry('nearer', [0.7], 0.5),
        makeEntry('b', [0.72], 0.5, { action: 'branch', artifactId: 'b', capturedAt: now }),
      ]);
      expect(dataset.pairs.map(p => p.loser.id)).toEqual(['nearer', 'near']);
      expect(dataset.pairs.every(p => p.channel === 'human')).toBe(true);
    });
  });
});
