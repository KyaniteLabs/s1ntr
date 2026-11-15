import { describe, expect, it, vi } from 'vitest';
import {
  buildCandidateManifest,
  evaluateCandidateGate,
  type CandidateHypothesis,
  type CandidateManifest,
} from '../../../src/creative-run/CandidateHypothesisProduction.js';
import {
  CreativeRunCoordinator,
  MemoryCreativeRunPersistence,
} from '../../../src/creative-run/CreativeRunCoordinator.js';
import { CompositionOrchestrator } from '../../../src/composition/CompositionOrchestrator.js';

const INTENT = 'A calm blue particle field with a clear focal relationship.';
const LAYERS = [0, 1, 2, 3].map((index) => ({
  domain: 'html' as const,
  prompt: `layer ${index}`,
  code: `<div data-layer="${index}">ready</div>`,
}));

function candidatesWithOnlyVariation(
  manifest: CandidateManifest,
  field: 'seed' | 'palette' | 'format' | 'styleLabel',
): CandidateHypothesis[] {
  return manifest.candidates.map((candidate, index) => ({
    ...candidate,
    id: `adversarial-${index}`,
    dimensions: {
      ...manifest.candidates[0].dimensions,
      [field]: `${field}-${index}`,
    },
  }));
}

describe('W8-11 candidate hypothesis production', () => {
  it('generates quality-diverse hypotheses and preserves arbitrary-N layers', async () => {
    const manifest = await buildCandidateManifest(INTENT, { layers: LAYERS });

    expect(manifest.candidates).toHaveLength(3);
    expect(manifest.intentDerivedDimensions.map((dimension) => dimension.id)).toEqual([
      'subject', 'experience', 'emotional-arc', 'principles', 'hard-floors',
    ]);
    expect(manifest.intentDerivedDimensions[0]).toEqual({
      id: 'subject', source: 'user-intent', value: INTENT,
    });
    expect(manifest.candidates.every((candidate) => candidate.qualityScore === 1)).toBe(true);
    expect(manifest.gate).toMatchObject({ passed: true, qualityPassed: true, diversityPassed: true });
    expect(manifest.candidates.every((candidate) => candidate.artifact.layers.length === LAYERS.length)).toBe(true);
    expect(manifest.candidates.every((candidate) => candidate.materialDifference.length > 0)).toBe(true);
    expect(manifest.candidates.every((candidate) => candidate.artifact.successCount === LAYERS.length)).toBe(true);
    expect(manifest.candidates.every((candidate) => candidate.artifact.html.startsWith('<!DOCTYPE html>'))).toBe(true);
    expect(manifest.candidates.every((candidate) => candidate.artifact.layers
      .map((layer) => layer.code).sort().join('|') === LAYERS.map((layer) => layer.code).sort().join('|'))).toBe(true);
    expect(new Set(manifest.candidates.map((candidate) => candidate.artifact.artifactDigest)).size).toBe(3);
    expect(new Set(manifest.candidates.map((candidate) => candidate.materialDifference)).size).toBe(3);
  });

  it('derives dimensions and executable plans from each distinct intent', async () => {
    const calm = await buildCandidateManifest(INTENT, { layers: LAYERS });
    const tense = await buildCandidateManifest('A tense red lattice that snaps into focus.', { layers: LAYERS });

    expect(calm.candidates[0].dimensions.subject).toBe(INTENT);
    expect(tense.candidates[0].dimensions.subject).toContain('tense red lattice');
    expect(calm.candidates[0].dimensions).not.toEqual(tense.candidates[0].dimensions);
    expect(calm.candidates[0].artifact.planDigest).not.toBe(tense.candidates[0].artifact.planDigest);
    expect(calm.candidates[0].artifact.artifactDigest).not.toBe(tense.candidates[0].artifact.artifactDigest);
  });

  it('executes arbitrary N beyond five without an implicit cap', async () => {
    const manifest = await buildCandidateManifest(INTENT, { layers: LAYERS, candidateCount: 8 });

    expect(manifest.candidates).toHaveLength(8);
    expect(manifest.candidates.every((candidate) => candidate.artifact.successCount === LAYERS.length)).toBe(true);
    expect(new Set(manifest.candidates.map((candidate) => candidate.artifact.planDigest)).size).toBe(8);
    await expect(buildCandidateManifest(INTENT, { candidateCount: 8, candidateBudget: 7 })).rejects.toThrow(/explicit budget/);
  });

  it('plans candidates without reserving a provider', async () => {
    const reserve = vi.fn(async () => ({ id: 'must-not-run', status: 'reserved' as const }));
    const coordinator = new CreativeRunCoordinator({
      persistence: new MemoryCreativeRunPersistence(),
      reserveProvider: reserve,
    });

    const manifest = await coordinator.planCandidates(INTENT, { layers: LAYERS });

    expect(manifest.gate.passed).toBe(true);
    expect(reserve).not.toHaveBeenCalled();
  });

  it('does not report internal candidate executions as user compose calls', async () => {
    const compose = vi.spyOn(CompositionOrchestrator, 'compose');
    try {
      const manifest = await buildCandidateManifest(INTENT, { layers: LAYERS });
      expect(manifest.candidates.every((candidate) => candidate.artifact.successCount === LAYERS.length)).toBe(true);
      expect(compose).not.toHaveBeenCalled();
    } finally {
      compose.mockRestore();
    }
  });

  it.each(['seed', 'palette', 'format', 'styleLabel'] as const)(
    'rejects %s-only variation as non-diverse',
    async (field) => {
      const manifest = await buildCandidateManifest(INTENT);
      const gate = evaluateCandidateGate(candidatesWithOnlyVariation(manifest, field));

      expect(gate.diversityPassed).toBe(false);
      expect(gate.passed).toBe(false);
      expect(gate.diversity.failures[0]).toContain('fewer than two executed material dimensions');
    },
  );

  it('rejects hard-coded quality-score gaming', async () => {
    const manifest = await buildCandidateManifest(INTENT);
    const lowQuality = manifest.candidates.map((candidate) => ({ ...candidate, qualityScore: 0.2 }));
    const gate = evaluateCandidateGate(lowQuality);

    expect(gate.diversityPassed).toBe(true);
    expect(gate.qualityPassed).toBe(false);
    expect(gate.passed).toBe(false);
    expect(gate.quality.failures).toHaveLength(3);
  });

  it('rejects low-quality artifacts even when their plans remain diverse', async () => {
    const manifest = await buildCandidateManifest(INTENT);
    const broken = manifest.candidates.map((candidate) => ({
      ...candidate,
      qualityScore: 0.4,
      artifact: { ...candidate.artifact, html: '', successCount: 0 },
    }));
    const gate = evaluateCandidateGate(broken);

    expect(gate.diversityPassed).toBe(true);
    expect(gate.qualityPassed).toBe(false);
    expect(gate.passed).toBe(false);
  });

  it('rejects a pair that changes only one material dimension', async () => {
    const manifest = await buildCandidateManifest(INTENT);
    const candidates = manifest.candidates.map((candidate, index) => ({
      ...candidate,
      id: `one-axis-${index}`,
      dimensions: {
        ...manifest.candidates[0].dimensions,
        composition: index === 0 ? 'single anchor in negative space' : `one-axis-${index}`,
      },
    }));
    const gate = evaluateCandidateGate(candidates);

    expect(gate.diversityPassed).toBe(false);
    expect(gate.diversity.pairwise.some((pair) => pair.materialDimensions.length === 1)).toBe(true);
  });

  it('requires at least three candidates even when quality is high', async () => {
    const manifest = await buildCandidateManifest(INTENT);
    const gate = evaluateCandidateGate(manifest.candidates.slice(0, 2));

    expect(gate.qualityPassed).toBe(true);
    expect(gate.diversityPassed).toBe(false);
    expect(gate.diversity.failures).toContain('At least three candidates are required');
  });

  it('fails closed for an invalid candidate count', async () => {
    await expect(buildCandidateManifest(INTENT, { candidateCount: Number.NaN })).rejects.toThrow(/positive integer/);
  });

  it('attaches the manifest to the coordinated composition result', async () => {
    const previousGate = process.env.SINTER_COMPOSITE_GATE;
    process.env.SINTER_COMPOSITE_GATE = '0';
    try {
      const result = await new CreativeRunCoordinator({
        persistence: new MemoryCreativeRunPersistence(),
      }).compose({ title: 'governed', layers: LAYERS }, { requestKey: 'candidate-compose' });

      expect(result.candidateManifest.gate.passed).toBe(true);
      expect(result.candidateManifest.candidates).toHaveLength(3);
      expect(result.layers).toHaveLength(LAYERS.length);
      expect(result.creativeRun.readiness.source).toBe('synthetic-no-spend');
    } finally {
      if (previousGate === undefined) delete process.env.SINTER_COMPOSITE_GATE;
      else process.env.SINTER_COMPOSITE_GATE = previousGate;
    }
  });
});
