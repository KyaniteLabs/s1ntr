import { describe, it, expect } from 'vitest';
import {
  islandsFromPoints,
  ringNeighbor,
  migrateOnce,
  runMigration,
  islandSummary,
} from '../../../src/evolution/Islands.js';
import type { TrendScorePoint } from '../../../src/evolution/PhaseTransitions.js';

function point(seq: number, domain: string, artifact: string, score: number): TrendScorePoint {
  return { seq, domain, score, artifact: `/out/artifacts/${artifact}` };
}

function samplePopulation(): TrendScorePoint[] {
  return [
    // p5 island — 4 residents, rescored duplicate (b5 appears twice, later wins)
    point(0, 'p5', 'b5', 3.1),
    point(1, 'p5', 'b2', 4.2),
    point(2, 'p5', 'b9', 2.4),
    point(3, 'p5', 'b5', 3.9), // rescore: b5 keeps 3.9
    // tone island — 2 residents
    point(4, 'tone', 't1', 4.8),
    point(5, 'tone', 't2', 2.9),
    // hydra island — 1 resident
    point(6, 'hydra', 'h1', 3.5),
    // rows without an artifact dir are skipped
    { seq: 7, domain: 'glsl', score: 4.0 },
  ];
}

// ═══ islandsFromPoints — domain partition ═══

describe('islandsFromPoints', () => {
  it('partitions the population by domain with no cross-domain residents', () => {
    const islands = islandsFromPoints(samplePopulation());
    expect(islands.map((i) => i.domain)).toEqual(['hydra', 'p5', 'tone']); // sorted
    for (const island of islands) {
      expect(island.residents.every((r) => r.domain === island.domain)).toBe(true);
    }
    expect(islands.find((i) => i.domain === 'glsl')).toBeUndefined(); // no-artifact row skipped
  });

  it('sorts residents best-first and keeps the latest score for rescored ids', () => {
    const p5 = islandsFromPoints(samplePopulation()).find((i) => i.domain === 'p5')!;
    expect(p5.residents.map((r) => r.id)).toEqual(['b2', 'b5', 'b9']); // 4.2, 3.9, 2.4
    expect(p5.residents.find((r) => r.id === 'b5')?.score).toBe(3.9);
  });
});

// ═══ ringNeighbor ═══

describe('ringNeighbor', () => {
  it('links each island to its successor and wraps the last to the first', () => {
    const islands = islandsFromPoints(samplePopulation()); // hydra, p5, tone
    expect(ringNeighbor(islands, islands[0]).domain).toBe('p5');
    expect(ringNeighbor(islands, islands[1]).domain).toBe('tone');
    expect(ringNeighbor(islands, islands[2]).domain).toBe('hydra'); // wrap
  });

  it('returns the island itself when there is nowhere to migrate', () => {
    const single = islandsFromPoints([point(0, 'p5', 'b1', 3.0)]);
    expect(ringNeighbor(single, single[0])).toBe(single[0]);
  });
});

// ═══ migration — top-k moves, partition respected ═══

describe('migrateOnce', () => {
  it('copies exactly the top-k residents into the ring neighbor as immigrants', () => {
    const islands = islandsFromPoints(samplePopulation());
    const records = migrateOnce(islands, 2, 1);
    expect(records).toHaveLength(3); // one movement per non-empty island

    const hydra = islands.find((i) => i.domain === 'hydra')!;
    const p5 = islands.find((i) => i.domain === 'p5')!;
    const tone = islands.find((i) => i.domain === 'tone')!;

    // hydra's single resident seeded into p5
    const hydraRec = records.find((r) => r.from === 'hydra')!;
    expect(hydraRec.to).toBe('p5');
    expect(hydraRec.migrants.map((m) => m.id)).toEqual(['h1']);
    expect(p5.immigrants.map((m) => m.id)).toEqual(['h1']);
    expect(p5.immigrants[0].domain).toBe('hydra'); // origin preserved

    // p5's top-2 (b2 4.2, b5 3.9) seeded into tone
    const p5Rec = records.find((r) => r.from === 'p5')!;
    expect(p5Rec.migrants.map((m) => m.id)).toEqual(['b2', 'b5']);
    expect(tone.immigrants.map((m) => m.id)).toEqual(['b2', 'b5']);

    // tone's top-2 seeded into hydra (wrap)
    expect(records.find((r) => r.from === 'tone')!.to).toBe('hydra');
    expect(hydra.immigrants.map((m) => m.id)).toEqual(['t1', 't2']);
  });

  it('never moves residents — the domain partition is immutable', () => {
    const islands = islandsFromPoints(samplePopulation());
    const before = islands.map((i) => [i.domain, i.residents.map((r) => r.id)]);
    migrateOnce(islands, 2, 1);
    for (const [domain, ids] of before) {
      const island = islands.find((i) => i.domain === domain)!;
      expect(island.residents.map((r) => r.id)).toEqual(ids);
      expect(island.residents.every((r) => r.domain === domain)).toBe(true);
    }
    // no island gained residents from another domain
    expect(islands.find((i) => i.domain === 'p5')!.residents.every((r) => r.domain === 'p5')).toBe(true);
  });

  it('does not duplicate an exemplar migrated in a previous epoch', () => {
    const islands = islandsFromPoints(samplePopulation());
    migrateOnce(islands, 2, 1);
    const tone = islands.find((i) => i.domain === 'tone')!;
    expect(tone.immigrants).toHaveLength(2); // b2, b5
    migrateOnce(islands, 2, 2); // same top-k — first seeding wins
    expect(tone.immigrants).toHaveLength(2);
  });

  it('emits no records for a single island', () => {
    const islands = islandsFromPoints([point(0, 'p5', 'b1', 3.0)]);
    expect(migrateOnce(islands, 2, 1)).toEqual([]);
    expect(islands[0].immigrants).toEqual([]);
  });
});

// ═══ runMigration + summary ═══

describe('runMigration', () => {
  it('accumulates immigrant exemplars across epochs', () => {
    const islands = islandsFromPoints(samplePopulation());
    const records = runMigration(islands, 3, 1);
    expect(records.map((r) => r.epoch)).toEqual([1, 1, 1, 2, 2, 2, 3, 3, 3]);
    const hydra = islands.find((i) => i.domain === 'hydra')!;
    // epoch 1 seeds t1 into hydra; epochs 2-3 re-migrate the same top-1 (t1)
    // and hydra's own h1 stays deduped in p5 — first seeding wins, no growth
    const summary = islandSummary(hydra);
    expect(summary.residents).toBe(1);
    expect(summary.immigrants).toBe(1);
    expect(summary.top?.id).toBe('h1'); // best resident unchanged by migration
  });
});

describe('islandSummary', () => {
  it('summarizes population, immigrants, and best resident', () => {
    const islands = islandsFromPoints(samplePopulation());
    runMigration(islands, 1, 2);
    const s = islandSummary(islands.find((i) => i.domain === 'tone')!);
    expect(s).toMatchObject({ domain: 'tone', residents: 2, immigrants: 2 });
    expect(s.top?.id).toBe('t1');
  });
});
