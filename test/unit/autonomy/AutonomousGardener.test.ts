/**
 * Unit tests for AutonomousGardener lifecycle and cycle logic
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { AutonomousGardener } from '../../../src/autonomy/AutonomousGardener.js';
import type { GardenerCycleResult } from '../../../src/autonomy/AutonomousGardener.js';
import { DreamArchiveSourceAdmission } from
  '../../../src/dreaming/research/DreamArchiveSourceAdmission.js';
import { createDreamRenderedEvidenceAuthority,
  type DreamRenderedEvidenceIssuer } from
  '../../../src/dreaming/research/DreamResearchEvidence.js';
import type { ArchiveCell, ArchiveEntry, DescriptorAxis } from '../../../src/emergence/types.js';
import { admitDreamEntry } from '../../fixtures/dreamArchiveAdmission.js';

function makeEntry(id: string, quality: number, descriptorValue = 0.5): ArchiveEntry {
  return {
    id,
    artifactRef: { kind: 'test' as const, path: `test/${id}` },
    descriptor: {
      values: [{ axis: 'order-chaos' as const, value: descriptorValue }],
      source: 'test',
      extractedAt: new Date().toISOString(),
    },
    lineage: { artifactId: id, parentIds: [], provenance: 'fresh-generation' as const, createdAt: new Date().toISOString() },
    qualityScore: quality,
    signals: { novelty: 0.5, structure: 0.5, temporalRichness: 0.5, perturbationResilience: 0.5, fertility: 0.5, aesthetic: 0.5 },
    archivedAt: new Date().toISOString(),
  };
}

function makeCell(id: string, quality: number, descriptorValue = 0.5): ArchiveCell {
  return {
    cellId: `cell-${id}`,
    coordinates: [{ axis: 'order-chaos' as const, value: descriptorValue }],
    elite: makeEntry(id, quality, descriptorValue),
    nearElites: [],
    capacity: 5,
  };
}

function admit(cells: ArchiveCell[], authority: DreamArchiveSourceAdmission,
  evidenceIssuer: DreamRenderedEvidenceIssuer): ArchiveCell[] {
  for (const entry of cells.map(cell => cell.elite).filter(Boolean) as ArchiveEntry[]) {
    admitDreamEntry(entry, authority, evidenceIssuer);
  }
  return cells;
}

const emptyCells: ArchiveCell[] = [];
const axes: DescriptorAxis[] = ['order-chaos'];

describe('AutonomousGardener', () => {
  it('runs a single cycle and returns structured result', () => {
    const gardener = new AutonomousGardener({ totalBudget: 100 });
    const result = gardener.cycle([makeCell('a', 0.8)], axes);

    expect(result).toMatchObject({ cycle: 1, mode: 'co-create' });
    expect(result!.cycle).toBe(1);
    expect(result!.mode).toBe('co-create');
    expect(result!.budgetRemaining).toBeLessThan(100);
    expect(result!.health).toMatchObject({ healthLevel: expect.stringMatching(/^(thriving|healthy|stagnant|declining)$/) });
    expect(typeof result!.actions).toBe('number');
  });

  it('returns null when budget is exhausted', () => {
    const gardener = new AutonomousGardener({ totalBudget: 0 });
    const result = gardener.cycle(emptyCells, axes);
    expect(result).toBeNull();
  });

  it('decrements budget across multiple cycles', () => {
    const gardener = new AutonomousGardener({ totalBudget: 50 });
    const r1 = gardener.cycle([makeCell('a', 0.7)], axes);
    expect(r1).toMatchObject({ cycle: 1 });

    const r2 = gardener.cycle([makeCell('b', 0.6)], axes);
    if (r2) {
      expect(r2.budgetRemaining).toBeLessThan(r1!.budgetRemaining);
      expect(r2.cycle).toBe(2);
    }
  });

  it('handles empty archive gracefully', () => {
    const gardener = new AutonomousGardener({ totalBudget: 100 });
    const result = gardener.cycle(emptyCells, axes);
    // Empty archive may or may not produce actions depending on policy
    // but must not throw
    expect(result === null || typeof result.actions === 'number').toBe(true);
  });

  it('respects mode config', () => {
    const gardener = new AutonomousGardener({ mode: 'autopilot', totalBudget: 100 });
    const result = gardener.cycle([makeCell('a', 0.8)], axes);
    expect(result).toMatchObject({ cycle: 1, mode: 'autopilot' });
    expect(result!.mode).toBe('autopilot');
  });

  it('tracks cycle count incrementally', () => {
    const gardener = new AutonomousGardener({ totalBudget: 200 });
    const r1 = gardener.cycle([makeCell('a', 0.8)], axes);
    const r2 = gardener.cycle([makeCell('b', 0.7)], axes);
    const r3 = gardener.cycle([makeCell('c', 0.6)], axes);

    expect(r1?.cycle).toBe(1);
    expect(r2?.cycle).toBe(2);
    expect(r3?.cycle).toBe(3);
  });

  it('stop() sets active to false', () => {
    const gardener = new AutonomousGardener({ totalBudget: 100 });
    expect(gardener.isActive()).toBe(false);
    // stop() is idempotent — safe to call before start
    gardener.stop();
    expect(gardener.isActive()).toBe(false);
  });

  describe('start/stop lifecycle', () => {
    afterEach(() => { vi.useRealTimers(); });

    it('a second start while running joins the live loop instead of starting another', async () => {
      vi.useFakeTimers();
      const gardener = new AutonomousGardener({ totalBudget: 1000 });
      let cellReads = 0;
      const getCells = (): ArchiveCell[] => { cellReads++; return []; };
      const first = gardener.start(getCells, () => []);
      const second = gardener.start(getCells, () => []);
      await vi.advanceTimersByTimeAsync(0);

      expect(cellReads).toBe(1);
      expect(gardener.isActive()).toBe(true);
      gardener.stop();
      await vi.advanceTimersByTimeAsync(0);
      await expect(Promise.all([first, second])).resolves.toEqual([undefined, undefined]);
      expect(gardener.isActive()).toBe(false);
    });

    it('stop is terminal: start after stop runs no cycle', async () => {
      const gardener = new AutonomousGardener({ totalBudget: 1000 });
      let cellReads = 0;
      gardener.stop();
      await gardener.start(() => { cellReads++; return []; }, () => []);

      expect(cellReads).toBe(0);
      expect(gardener.isActive()).toBe(false);
    });

    it('returns to idle when a cycle yields no result, so it can start again', async () => {
      const gardener = new AutonomousGardener({ totalBudget: 0 });
      await gardener.start(() => [], () => []);
      expect(gardener.isActive()).toBe(false);
      await gardener.start(() => [], () => []);
      expect(gardener.isActive()).toBe(false);
    });
  });

  it('reports task breakdown with fresh/replay/dream counts', () => {
    const gardener = new AutonomousGardener({ totalBudget: 200 });
    // Provide multiple cells to increase archive coverage
    const cells = [makeCell('a', 0.9), makeCell('b', 0.8), makeCell('c', 0.7)];
    const result = gardener.cycle(cells, axes);

    if (result?.taskBreakdown) {
      const { fresh, replay, dream } = result.taskBreakdown;
      expect(typeof fresh).toBe('number');
      expect(typeof replay).toBe('number');
      expect(typeof dream).toBe('number');
      expect(fresh + replay + dream).toBeGreaterThanOrEqual(0);
    }
  });

  it('includes stagnation data in cycle result', () => {
    const gardener = new AutonomousGardener({ totalBudget: 100 });
    const result = gardener.cycle([makeCell('a', 0.8)], axes);
    expect(result).toMatchObject({ cycle: 1, mode: 'co-create' });
    expect(result!.stagnation).toMatchObject({ isStagnant: expect.any(Boolean) });
    expect(result!.stagnation.isStagnant === true || result!.stagnation.isStagnant === false).toBe(true);
  });

  it('reports archive entries selected by the loaded taste model', () => {
    const gardener = new AutonomousGardener({
      totalBudget: 20,
      replayRatio: 1,
      replayBiasStrength: 1,
      minTasteScore: 0.5,
      maxArchiveTasks: 1,
    });
    gardener.loadTasteModel({
      axisWeights: [1],
      qualityWeight: 0,
      trainedAt: new Date().toISOString(),
      pairCount: 1,
      trainingAgreement: 1,
    });

    const result = gardener.cycle([
      makeCell('preferred', 0.5, 0.9),
      makeCell('low-signal', 0.9, 0.1),
    ], axes);

    expect(result).toMatchObject({
      tasteAlignedCount: 1,
      tasteSelectedEntryIds: ['preferred'],
    });
  });

  describe('Dream command proposals', () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('proposes an in-cycle recombination without queue authority', () => {
      // Force ReplayBudgetPolicy.decideNextTask down the dream-recombination
      // path deterministically: replayRatio 0 (never replay) + Math.random 0.99
      // (full archive coverage → normal allocation → freshTypes[floor(0.99*2)=1]
      // = 'dream-recombination').
      vi.spyOn(Math, 'random').mockReturnValue(0.99);

      const proposeDream = vi.fn();
      const renderedEvidence = createDreamRenderedEvidenceAuthority();
      const dreamSourceAdmission = new DreamArchiveSourceAdmission(renderedEvidence.resolver);
      const gardener = new AutonomousGardener({
        totalBudget: 100,
        replayRatio: 0,
        maxArchiveTasks: 1,
        proposeDream,
        dreamSourceAdmission,
      });

      // Two distinct elites so DreamPlanner produces a pair to recombine.
      const cells = admit([makeCell('alpha', 0.9, 0.9), makeCell('beta', 0.6, 0.1)],
        dreamSourceAdmission, renderedEvidence.issuer);
      const result = gardener.cycle(cells, axes);

      expect(result!.taskBreakdown!.dream).toBe(1);

      expect(proposeDream).toHaveBeenCalledOnce();
      const top = proposeDream.mock.calls[0][0];
      expect(top.strategy).toBe('elite-x-elite');
      const sourceIds = top.sources.map(s => s.id).sort();
      expect(sourceIds).toEqual(['alpha', 'beta']);
    });

    it('keeps Dream work inert when no proposal port is injected', () => {
      vi.spyOn(Math, 'random').mockReturnValue(0.99);

      const renderedEvidence = createDreamRenderedEvidenceAuthority();
      const dreamSourceAdmission = new DreamArchiveSourceAdmission(renderedEvidence.resolver);
      const gardener = new AutonomousGardener({
        totalBudget: 100,
        replayRatio: 0,
        maxArchiveTasks: 1,
        dreamSourceAdmission,
        // no proposal port injected
      });

      const cells = admit([makeCell('alpha', 0.9, 0.9), makeCell('beta', 0.6, 0.1)],
        dreamSourceAdmission, renderedEvidence.issuer);
      const result = gardener.cycle(cells, axes);

      expect(result!.taskBreakdown!.dream).toBe(1);
    });

    it('does not re-propose the same pairing across cycles', () => {
      vi.spyOn(Math, 'random').mockReturnValue(0.99);

      const proposeDream = vi.fn();
      const renderedEvidence = createDreamRenderedEvidenceAuthority();
      const dreamSourceAdmission = new DreamArchiveSourceAdmission(renderedEvidence.resolver);
      const gardener = new AutonomousGardener({
        totalBudget: 100,
        replayRatio: 0,
        maxArchiveTasks: 1,
        proposeDream,
        dreamSourceAdmission,
      });

      const cells = admit([makeCell('alpha', 0.9, 0.9), makeCell('beta', 0.6, 0.1)],
        dreamSourceAdmission, renderedEvidence.issuer);
      gardener.cycle(cells, axes);
      gardener.cycle(cells, axes);
      expect(proposeDream).toHaveBeenCalledOnce();
    });
  });
});
