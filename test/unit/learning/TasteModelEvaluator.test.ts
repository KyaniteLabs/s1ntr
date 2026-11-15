import { describe, expect, it } from 'vitest';
import {
  TasteModelEvaluator,
  lineageRootOf,
  splitEntriesByRoot,
} from '../../../src/learning/TasteModelEvaluator.js';
import type { PreferencePair } from '../../../src/learning/PreferenceDatasetBuilder.js';
import type { TasteModelWeights } from '../../../src/learning/TasteModelTrainer.js';
import type { ArchiveEntry } from '../../../src/emergence/types.js';

function entry(id: string, parentIds: string[] = []): ArchiveEntry {
  return { id, lineage: { artifactId: id, parentIds, provenance: 'branch', createdAt: '' } } as unknown as ArchiveEntry;
}

function pair(w: number[], wq: number, l: number[], lq: number): PreferencePair {
  return {
    winner: { id: 'w', descriptor: w, quality: wq },
    loser: { id: 'l', descriptor: l, quality: lq },
    source: 'pairwise-a', confidence: 1, capturedAt: '',
  };
}

const weights: TasteModelWeights = {
  axisWeights: [1, 0], qualityWeight: 0, trainedAt: '', pairCount: 1, trainingAgreement: 1,
};

describe('lineageRootOf', () => {
  it('walks first-parent lineage to the oldest known ancestor', () => {
    const all = [entry('a'), entry('b', ['a']), entry('c', ['b'])];
    const byId = new Map(all.map(e => [e.id, e]));
    expect(lineageRootOf(all[2], byId)).toBe('a');
  });

  it('uses an unknown parent id as the root and survives cycles', () => {
    const orphan = entry('x', ['missing']);
    expect(lineageRootOf(orphan, new Map([['x', orphan]]))).toBe('missing');
    const p = entry('p', ['q']);
    const q = entry('q', ['p']);
    const byId = new Map([['p', p], ['q', q]]);
    expect(['p', 'q']).toContain(lineageRootOf(p, byId));
  });
});

describe('splitEntriesByRoot', () => {
  it('never puts descendants of one root on both sides', () => {
    const all: ArchiveEntry[] = [];
    for (let r = 0; r < 10; r++) {
      all.push(entry(`r${r}`), entry(`r${r}-c`, [`r${r}`]), entry(`r${r}-g`, [`r${r}-c`]));
    }
    const { train, test, rootCount } = splitEntriesByRoot(all, 0.2);
    expect(rootCount).toBe(10);
    expect(test).toHaveLength(6);
    expect(train).toHaveLength(24);
    const rootsOf = (xs: ArchiveEntry[]) => new Set(xs.map(e => e.id.split('-')[0]));
    const overlap = [...rootsOf(test)].filter(r => rootsOf(train).has(r));
    expect(overlap).toEqual([]);
  });

  it('holds nothing out below the minimum root count', () => {
    const all = [entry('a'), entry('b'), entry('c')];
    expect(splitEntriesByRoot(all, 0.2, 5).test).toEqual([]);
    expect(splitEntriesByRoot([entry('solo')]).test).toEqual([]);
    expect(splitEntriesByRoot([]).train).toEqual([]);
  });
});

describe('TasteModelEvaluator.evaluatePairs', () => {
  it('counts ties as ties, not as correct predictions', () => {
    const tied = [pair([0.5, 0.1], 0.5, [0.5, 0.9], 0.5), pair([0.3, 0], 0.2, [0.3, 1], 0.8)];
    const result = new TasteModelEvaluator().evaluatePairs(tied, weights);
    expect(result.agreement).toBe(0);
    expect(result.tieRate).toBe(1);
    expect(result.kendallTau).toBe(0);
  });

  it('scores strict agreement on the given pairs', () => {
    const pairs = [pair([0.9, 0], 0.5, [0.1, 0], 0.5), pair([0.1, 0], 0.5, [0.9, 0], 0.5)];
    const result = new TasteModelEvaluator().evaluatePairs(pairs, weights);
    expect(result.agreement).toBe(0.5);
    expect(result.tieRate).toBe(0);
    expect(result.pairCount).toBe(2);
  });

  it('returns an empty result for no pairs', () => {
    expect(new TasteModelEvaluator().evaluatePairs([], weights)).toEqual({
      agreement: 0, tieRate: 0, kendallTau: 0, calibration: 0, pairCount: 0, beatsBaseline: false,
    });
  });
});
