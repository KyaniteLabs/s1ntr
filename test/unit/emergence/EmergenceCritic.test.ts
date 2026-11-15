/**
 * Unit tests for EmergenceCritic — Phase 14
 *
 * Tests ensemble evaluation of emergence signals.
 */

import { describe, it, expect } from 'vitest';
import { EmergenceCritic } from '../../../src/emergence/EmergenceCritic.js';
import { EmergenceScorecard } from '../../../src/evaluation/EmergenceScorecard.js';
import type { ArchiveEntry, DescriptorAxis } from '../../../src/emergence/types.js';

function makeDescriptor(values: Record<string, number>) {
  return {
    values: Object.entries(values).map(([axis, value]) => ({ axis: axis as DescriptorAxis, value })),
    source: 'test',
    extractedAt: new Date().toISOString(),
  };
}

function makeEntry(id: string, descValues: Record<string, number>, quality: number): ArchiveEntry {
  return {
    id,
    artifactRef: { kind: 'test', path: `test/${id}` },
    descriptor: makeDescriptor(descValues),
    lineage: { artifactId: id, parentIds: [], provenance: 'fresh-generation', createdAt: new Date().toISOString() },
    qualityScore: quality,
    signals: { novelty: 0.5, structure: 0.5, temporalRichness: 0.5, perturbationResilience: 0.5, fertility: 0.5, aesthetic: 0.5 },
    archivedAt: new Date().toISOString(),
  };
}

const OUTPUT = [
  'function draw() {',
  '  let t = frameCount * 0.01;',
  '  for (let i = 0; i < 10; i++) {',
  '    let x = noise(i * 0.5, t) * width;',
  '    let y = noise(i * 0.5 + 100, t) * height;',
  '    ellipse(x, y, 20, 20);',
  '  }',
  '  if (frameCount > 100) { background(0); }',
  '}',
].join('\n');

const MOCK_EXTRACT = (output: string) => makeDescriptor({ 'order-chaos': 0.5, 'sparse-dense': 0.5 });

describe('EmergenceCritic', () => {
  it('evaluateQuick returns all signals and composite', () => {
    const critic = new EmergenceCritic();
    const desc = makeDescriptor({ 'order-chaos': 0.6, 'sparse-dense': 0.4 });
    const archive = [makeEntry('a', { 'order-chaos': 0.2, 'sparse-dense': 0.8 }, 0.7)];

    const result = critic.evaluateQuick({
      descriptor: desc,
      qualityScore: 0.8,
      archive,
      output: OUTPUT,
    });

    expect(result.signals.novelty).toBeGreaterThanOrEqual(0);
    expect(result.signals.novelty).toBeLessThanOrEqual(1);
    expect(result.signals.structure).toBeGreaterThanOrEqual(0);
    expect(result.composite).toBeGreaterThanOrEqual(0);
    expect(result.composite).toBeLessThanOrEqual(1);
    expect(result.mode).toBe('quick');
    expect(result.breakdown).toHaveLength(6);
  });

  it('evaluateFull computes perturbation resilience with extractFn', async () => {
    const critic = new EmergenceCritic();
    const desc = makeDescriptor({ 'order-chaos': 0.5, 'sparse-dense': 0.5 });
    const archive = [makeEntry('a', { 'order-chaos': 0.3, 'sparse-dense': 0.7 }, 0.6)];

    const result = await critic.evaluateFull({
      output: OUTPUT,
      descriptor: desc,
      qualityScore: 0.8,
      archive,
      extractFn: MOCK_EXTRACT,
    });

    expect(result.mode).toBe('full');
    expect(result.signals.perturbationResilience).toBeGreaterThanOrEqual(0);
    expect(result.signals.perturbationResilience).toBeLessThanOrEqual(1);
  });

  it('applies advertised *Weight overrides to the consumed weights (#1277)', () => {
    const critic = new EmergenceCritic({ noveltyWeight: 1, structureWeight: 0, temporalWeight: 0, resilienceWeight: 0, fertilityWeight: 0, aestheticWeight: 0 });
    const desc = makeDescriptor({ 'order-chaos': 0.5 });
    const archive = [makeEntry('a', { 'order-chaos': 0.2 }, 0.7)];
    const result = critic.evaluateQuick({ descriptor: desc, qualityScore: 0.5, archive, output: OUTPUT });
    expect(result.breakdown.map(b => [b.signal, b.weight])).toEqual([
      ['novelty', 1], ['structure', 0], ['temporalRichness', 0],
      ['perturbationResilience', 0], ['fertility', 0], ['aesthetic', 0],
    ]);
    expect(result.composite).toBeCloseTo(result.signals.novelty, 10);
  });

  it('normalises overridden weights so composite stays within [0, 1]', () => {
    const critic = new EmergenceCritic({ noveltyWeight: 5, aestheticWeight: 5 });
    const desc = makeDescriptor({ 'order-chaos': 0.5 });
    const result = critic.evaluateQuick({ descriptor: desc, qualityScore: 1, archive: [], output: OUTPUT });
    const total = result.breakdown.reduce((sum, b) => sum + b.weight, 0);
    const raw = result.breakdown.reduce((sum, b) => sum + b.contribution, 0);
    expect(total).toBeCloseTo(1, 10);
    expect(result.composite).toBeCloseTo(raw, 10);
    expect(result.composite).toBeLessThanOrEqual(1);
  });

  it('rejects negative, non-finite or all-zero weights', () => {
    expect(() => new EmergenceCritic({ noveltyWeight: -0.1 })).toThrow('novelty weight must be a finite non-negative number');
    expect(() => new EmergenceCritic({ fertilityWeight: Number.NaN })).toThrow('fertility weight must be a finite non-negative number');
    expect(() => new EmergenceCritic({ noveltyWeight: 0, structureWeight: 0, temporalWeight: 0, resilienceWeight: 0, fertilityWeight: 0, aestheticWeight: 0 })).toThrow('at least one weight must be positive');
  });

  it('composite is weighted sum across all signal breakdowns', () => {
    const critic = new EmergenceCritic();
    const desc = makeDescriptor({ 'order-chaos': 0.5 });
    const archive = [makeEntry('a', { 'order-chaos': 0.2 }, 0.7)];

    const result = critic.evaluateQuick({ descriptor: desc, qualityScore: 0.5, archive, output: OUTPUT });

    // Verify composite equals sum of breakdown contributions
    const expectedComposite = result.breakdown.reduce((sum, b) => sum + b.contribution, 0);
    expect(result.composite).toBeCloseTo(expectedComposite, 10);
    // Default weights should sum to 1.0
    const totalWeight = result.breakdown.reduce((sum, b) => sum + b.weight, 0);
    expect(totalWeight).toBeCloseTo(1.0, 10);
  });

  it('marks empty-archive novelty as insufficient and omits its grade', () => {
    const critic = new EmergenceCritic();
    const scorecard = new EmergenceScorecard();
    const desc = makeDescriptor({ 'order-chaos': 0.5 });
    const result = critic.evaluateQuick({ descriptor: desc, qualityScore: 0.5, archive: [], output: 'short' });

    expect(result.signals.noveltyInsufficient).toBe(true);
    const formatted = scorecard.format(scorecard.score(result.signals, result.composite));
    expect(formatted).toContain('Novelty                   insufficient data');
    expect(formatted).not.toMatch(/Novelty.*\[[A-F]\]/);
  });

  it('excludes insufficient novelty from the composite and renormalizes weights (#1318)', () => {
    const critic = new EmergenceCritic();
    const desc = makeDescriptor({ 'order-chaos': 0.5 });
    const result = critic.evaluateQuick({ descriptor: desc, qualityScore: 0.5, archive: [], output: OUTPUT });

    expect(result.signals.noveltyInsufficient).toBe(true);
    const novelty = result.breakdown.find(b => b.signal === 'novelty')!;
    expect(novelty.weight).toBe(0);
    expect(novelty.contribution).toBe(0);
    expect(result.breakdown.reduce((sum, b) => sum + b.weight, 0)).toBeCloseTo(1.0, 10);
    const others = result.breakdown.filter(b => b.signal !== 'novelty');
    const expected = others.reduce((s, b) => s + b.value * b.weight, 0);
    expect(result.composite).toBeCloseTo(expected, 10);

  });

  it('scorecard default mean excludes insufficient novelty (#1318)', () => {
    const scorecard = new EmergenceScorecard();
    const signals = {
      novelty: 1, noveltyInsufficient: true,
      structure: 0.2, temporalRichness: 0.2, perturbationResilience: 0.2, fertility: 0.2, aesthetic: 0.2,
    };
    const card = scorecard.score(signals);
    expect(card.overall.score).toBeCloseTo(0.2, 10);
    expect(card.overall.grade).toBe('D');

    const sufficient = scorecard.score({ ...signals, noveltyInsufficient: false });
    expect(sufficient.overall.score).toBeCloseTo((1 + 0.2 * 5) / 6, 10);
  });

  it('grades novelty when the archive has a baseline', () => {
    const critic = new EmergenceCritic();
    const scorecard = new EmergenceScorecard();
    const desc = makeDescriptor({ 'order-chaos': 0.5 });
    const archive = [makeEntry('a', { 'order-chaos': 0.2 }, 0.7)];
    const result = critic.evaluateQuick({ descriptor: desc, qualityScore: 0.5, archive, output: OUTPUT });

    expect(result.signals.noveltyInsufficient).toBe(false);
    expect(scorecard.format(scorecard.score(result.signals, result.composite))).toMatch(/Novelty.*\[[A-F]\]/);
  });

  it('exposes sub-components via getters', () => {
    const critic = new EmergenceCritic();
    expect(critic.getNoveltyIndex()).toEqual({"k":5,"defaultNovelty":1});
    expect(critic.getTemporalAnalyzer()).toEqual({"segmentCount":8});
    expect(critic.getPerturbationProbe()).toEqual({"magnitude":0.1});
  });

  describe('weight overrides (#1276)', () => {
    const params = () => ({
      descriptor: makeDescriptor({ 'order-chaos': 0.6, 'sparse-dense': 0.4 }),
      qualityScore: 0.8,
      archive: [makeEntry('a', { 'order-chaos': 0.2, 'sparse-dense': 0.8 }, 0.7)],
      output: OUTPUT,
    });
    const weightOf = (r: ReturnType<EmergenceCritic['evaluateQuick']>, signal: string) =>
      r.breakdown.find(b => b.signal === signal)?.weight;

    it('defaults are unchanged (they already sum to 1)', () => {
      const r = new EmergenceCritic().evaluateQuick(params());
      expect(r.breakdown.map(b => b.weight)).toEqual([0.25, 0.2, 0.15, 0.15, 0.15, 0.1]);
    });

    it('noveltyWeight actually changes the consumed novelty weight', () => {
      const r = new EmergenceCritic({ noveltyWeight: 1, structureWeight: 0, temporalWeight: 0, resilienceWeight: 0, fertilityWeight: 0, aestheticWeight: 0 })
        .evaluateQuick(params());
      expect(weightOf(r, 'novelty')).toBe(1);
      expect(weightOf(r, 'structure')).toBe(0);
      expect(r.composite).toBeCloseTo(r.signals.novelty, 10);
    });

    it('overrides that do not sum to 1 are normalized so composite stays in [0, 1]', () => {
      const r = new EmergenceCritic({ noveltyWeight: 1.25 }).evaluateQuick(params());
      const total = r.breakdown.reduce((sum, b) => sum + b.weight, 0);
      expect(total).toBeCloseTo(1, 10);
      expect(weightOf(r, 'novelty')).toBeCloseTo(1.25 / 2, 10);
      expect(r.composite).toBeLessThanOrEqual(1);
    });

    it('rejects negative, non-finite and all-zero weights', () => {
      expect(() => new EmergenceCritic({ noveltyWeight: -0.1 })).toThrow(/novelty weight must be a finite non-negative/);
      expect(() => new EmergenceCritic({ aestheticWeight: Number.NaN })).toThrow(/aesthetic weight/);
      expect(() => new EmergenceCritic({ noveltyWeight: 0, structureWeight: 0, temporalWeight: 0, resilienceWeight: 0, fertilityWeight: 0, aestheticWeight: 0 }))
        .toThrow(/at least one weight must be positive/);
    });
  });
});
