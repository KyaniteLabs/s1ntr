/**
 * Drift guard for the canonical judgeable-dimension contract
 * (wayfinder #1113, story J2).
 *
 * Meta failure class this pins: a judging table that drifts silently — a
 * dimension added, removed, or re-owned without a conscious decision —
 * breaks every consumer that enumerates dimensions (verdict rows, trend
 * schema, domain-rubric overlays, the degraded-panel banner rules) and does
 * so without any test going red. This test FAILS on any change to the
 * dimension space, forcing the change to be made here, consciously, in the
 * same PR that touches the table.
 */
import { describe, expect, it } from 'vitest';
import {
  DIMENSION_OWNERSHIP,
  DIMENSION_SENSES,
  JUDGING_PHASES,
  dimensionById,
  dimensionCount,
  dimensionIds,
  dimensionsForPhase,
  type JudgingPhase,
} from '../../../../src/atelier/judging/dimensions.js';

/**
 * The frozen consensus dimension map (2026-09-02), hard-coded here as the
 * pin. The table in dimensions.ts must match this EXACTLY (same ids, same
 * phase membership). Adding, removing, renaming, or re-owning a dimension
 * must edit BOTH this constant and the table in one reviewed change.
 */
const FROZEN_OWNERSHIP: Readonly<Record<JudgingPhase, readonly string[]>> = Object.freeze({
  R1_PERCEPTUAL: Object.freeze([
    'finish-detail',
    'composition',
    'color-light',
    'typography-readability',
    'spatial-depth-materials',
    'motion-choreography',
    'visual-coherence',
    'aesthetic-impact',
    'audio-musicality',
  ]),
  R2_STRUCTURAL: Object.freeze([
    'brief-fidelity',
    'constraint-adherence',
    'conceptual-intent',
    'domain-idiom',
    'generative-sophistication',
    'code-correctness',
    'maintainability',
    'portability-security',
    'interaction-design',
    'semantic-accessibility',
    'corpus-novelty',
    'cross-domain-integration',
    'remix-fertility',
  ]),
  R3_INSTRUMENTATION: Object.freeze([
    'render-validity',
    'replay-determinism',
    'temporal-stability',
    'performance-efficiency',
    'audio-signals',
    'responsive-behavior',
    'accessibility-checks',
    'asset-network-health',
  ]),
});

function tableIdsFor(phase: JudgingPhase): string[] {
  return dimensionsForPhase(phase).map((d) => d.id);
}

describe('dimension contract: MECE ownership over the enumerated space', () => {
  it('the table covers EXACTLY the frozen consensus map (add/remove/rename fails here)', () => {
    for (const phase of JUDGING_PHASES) {
      expect(
        [...tableIdsFor(phase)].sort(),
        `dimension space changed for ${phase} — update FROZEN_OWNERSHIP in this test consciously (wayfinder #1113)`,
      ).toEqual([...FROZEN_OWNERSHIP[phase]].sort());
    }
  });

  it('every dimension has EXACTLY one owner: no duplicates, no cross-phase splits', () => {
    const ids = dimensionIds();
    expect(new Set(ids).size, 'duplicate dimension ids in the table').toBe(ids.length);
    for (const phase of JUDGING_PHASES) {
      for (const id of FROZEN_OWNERSHIP[phase]) {
        const owners = JUDGING_PHASES.filter((p) => tableIdsFor(p).includes(id));
        expect(owners, `dimension ${id} must have exactly one owner`).toEqual([phase]);
      }
    }
  });

  it('the table is exactly the union of the three phase sets (no orphans)', () => {
    const union = JUDGING_PHASES.flatMap((p) => [...FROZEN_OWNERSHIP[p]]).sort();
    expect([...dimensionIds()].sort()).toEqual(union);
    expect(dimensionIds().length).toBe(union.length);
  });

  it('phase counts are the frozen consensus: R1=9, R2=13, R3=8 (total 30)', () => {
    expect(dimensionCount('R1_PERCEPTUAL')).toBe(9);
    expect(dimensionCount('R2_STRUCTURAL')).toBe(13);
    expect(dimensionCount('R3_INSTRUMENTATION')).toBe(8);
    expect(dimensionIds().length).toBe(30);
  });
});

describe('dimension contract: phase character', () => {
  it('R1 owns perception — never a code-artifact dimension', () => {
    for (const d of dimensionsForPhase('R1_PERCEPTUAL')) {
      expect(d.sense, `${d.id}: R1 is the perceived surface, not the artifact`).not.toBe('code');
    }
  });

  it('R3 is deterministic probes only — no conceptual judging, all probe-worded', () => {
    for (const d of dimensionsForPhase('R3_INSTRUMENTATION')) {
      expect(d.sense, `${d.id}: R3 must not own conceptual judgment`).not.toBe('conceptual');
      expect(d.description.toLowerCase()).toMatch(/probe|probed|measured|deterministic/);
    }
  });

  it('every sense value is from the closed sense union', () => {
    for (const d of DIMENSION_OWNERSHIP) {
      expect(DIMENSION_SENSES).toContain(d.sense);
    }
  });
});

describe('dimension contract: not_applicable semantics', () => {
  it('every auditory dimension documents its explicit not_applicable condition', () => {
    for (const d of DIMENSION_OWNERSHIP.filter((x) => x.sense === 'auditory')) {
      expect(
        d.description.toLowerCase(),
        `${d.id}: auditory dimensions must state explicit not_applicable semantics (silent work = NA, never silently missing)`,
      ).toContain('not_applicable');
    }
  });

  it('the audio-musicality NA example is pinned (audio on silent visual work = explicit NA)', () => {
    const audio = dimensionById('audio-musicality');
    expect(audio?.id).toBe('audio-musicality');
    expect(audio!.description).toMatch(/never silently missing/);
    expect(audio!.description).toMatch(/never scored 0/);
  });
});

describe('dimension contract: rows are well-formed and frozen', () => {
  it('every row is complete: non-empty id, phase, sense, description', () => {
    for (const d of DIMENSION_OWNERSHIP) {
      expect(d.id.trim().length).toBeGreaterThan(0);
      expect(JUDGING_PHASES).toContain(d.phase);
      expect(d.sense.trim().length).toBeGreaterThan(0);
      expect(d.description.trim().length).toBeGreaterThan(20);
    }
  });

  it('the table and every row are runtime-frozen (mutation throws)', () => {
    expect(Object.isFrozen(DIMENSION_OWNERSHIP)).toBe(true);
    for (const d of DIMENSION_OWNERSHIP) {
      expect(Object.isFrozen(d)).toBe(true);
    }
    expect(() => {
      (DIMENSION_OWNERSHIP as unknown as { length: number }).length = 99;
    }).toThrow();
  });

  it('lookup helpers round-trip; unknown ids return undefined', () => {
    for (const id of dimensionIds()) {
      expect(dimensionById(id)?.id).toBe(id);
    }
    expect(dimensionById('no-such-dimension')).toBeUndefined();
    expect(dimensionIds()).toEqual(DIMENSION_OWNERSHIP.map((d) => d.id));
  });
});
