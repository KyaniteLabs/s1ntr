import { describe, expect, it } from 'vitest';
import {
  EvidenceConsolidationCoordinator,
  type ConsolidationEvidence,
} from '../../../src/intuition/EvidenceConsolidationCoordinator.js';
import { MemoryConsolidator } from '../../../src/intuition/MemoryConsolidator.js';

const NOW = new Date('2026-07-30T12:00:00.000Z');
const base = (
  id: string,
  source: ConsolidationEvidence['source'],
  overrides: Partial<ConsolidationEvidence> = {},
): ConsolidationEvidence => ({
  id,
  hypothesisKey: 'p5:slow-blue:prompt',
  claim: 'Adding explicit motion cadence improves calming p5 outputs',
  falsifier: 'Reject if blinded quality fails to improve by 0.05 over baseline',
  source,
  sourceRef: `${source}:${id}`,
  lineageId: `lineage:${id}`,
  stance: 'support',
  confidence: 0.9,
  observedAt: '2026-07-30T11:00:00.000Z',
  trust: 'verified-system',
  taint: 'clean',
  ...overrides,
});

describe('EvidenceConsolidationCoordinator', () => {
  it('emits one ranked hypothesis with citations and deduplicated evidence', () => {
    const coordinator = new EvidenceConsolidationCoordinator();
    const memory = base('memory-1', 'memory');
    const result = coordinator.consolidate([
      memory,
      structuredClone(memory),
      base('taste-1', 'taste'),
    ], NOW);

    expect(result.duplicateEvidence).toBe(1);
    expect(result.hypotheses).toHaveLength(1);
    expect(result.hypotheses[0]).toMatchObject({
      status: 'ready',
      supportingSources: ['memory', 'taste'],
      trust: 'verified-system',
    });
    expect(result.hypotheses[0].citations).toHaveLength(2);
  });

  it('retains disagreement and blocks contradicted work', () => {
    const coordinator = new EvidenceConsolidationCoordinator();
    const result = coordinator.consolidate([
      base('memory-1', 'memory', { confidence: 0.6 }),
      base('taste-1', 'taste', { confidence: 0.6 }),
      base('ops-1', 'operational', {
        stance: 'contradict',
        confidence: 1,
        trust: 'owner',
      }),
      base('archive-1', 'archive', {
        stance: 'contradict',
        confidence: 1,
      }),
    ], NOW);

    expect(result.hypotheses[0].status).toBe('contradicted');
    expect(result.hypotheses[0].disagreements).toHaveLength(2);
    expect(result.hypotheses[0].confidence).toBe(0);
  });

  it('never promotes tainted quoted evidence into authority', () => {
    const coordinator = new EvidenceConsolidationCoordinator();
    const result = coordinator.consolidate([
      base('quote-1', 'compost', {
        trust: 'untrusted-external',
        taint: 'tainted',
      }),
      base('dream-1', 'dream', {
        trust: 'model-inference',
        taint: 'tainted',
      }),
    ], NOW);

    expect(result.hypotheses[0]).toMatchObject({
      status: 'insufficient',
      taint: 'tainted',
    });
  });

  it('does not count tainted support as a corroborating organ', () => {
    const coordinator = new EvidenceConsolidationCoordinator();
    const result = coordinator.consolidate([
      base('memory-clean', 'memory'),
      base('archive-tainted', 'archive', { taint: 'tainted' }),
    ], NOW);

    expect(result.hypotheses[0]).toMatchObject({
      status: 'insufficient',
      supportingSources: ['memory', 'archive'],
      corroboratingSources: ['memory'],
    });
  });

  it('does not count untrusted external support as corroboration', () => {
    const coordinator = new EvidenceConsolidationCoordinator();
    const result = coordinator.consolidate([
      base('memory-clean', 'memory', { confidence: 1 }),
      base('compost-quote', 'compost', {
        confidence: 1,
        trust: 'untrusted-external',
      }),
    ], NOW);

    expect(result.hypotheses[0]).toMatchObject({
      status: 'insufficient',
      corroboratingSources: ['memory'],
    });
  });

  it('does not treat two source categories from one root as independent (#1254)', () => {
    const coordinator = new EvidenceConsolidationCoordinator();
    const result = coordinator.consolidate([
      base('memory-1', 'memory', { lineageId: 'lineage:shared-root' }),
      base('taste-1', 'taste', { lineageId: 'lineage:shared-root' }),
    ], NOW);

    expect(result.hypotheses[0]).toMatchObject({
      status: 'insufficient',
      corroboratingSources: ['memory', 'taste'],
      corroboratingRoots: ['lineage:shared-root'],
    });
  });

  it('reports ready (for CS review) only with two distinct clean roots (#1254)', () => {
    const coordinator = new EvidenceConsolidationCoordinator();
    const result = coordinator.consolidate([
      base('memory-1', 'memory', { lineageId: 'lineage:root-a' }),
      base('taste-1', 'taste', { lineageId: 'lineage:root-b' }),
    ], NOW);

    expect(result.hypotheses[0]).toMatchObject({
      status: 'ready',
      corroboratingRoots: ['lineage:root-a', 'lineage:root-b'],
      confidence: 0.89875,
    });
  });

  it('excludes tainted support from confidence instead of discounting it (#1254)', () => {
    const coordinator = new EvidenceConsolidationCoordinator();
    const clean = coordinator.consolidate([
      base('memory-1', 'memory'),
    ], NOW);
    const withTainted = coordinator.consolidate([
      base('memory-1', 'memory'),
      base('archive-tainted', 'archive', { taint: 'tainted', confidence: 0.1 }),
    ], NOW);

    expect(withTainted.hypotheses[0].confidence).toBe(clean.hypotheses[0].confidence);
    expect(withTainted.hypotheses[0].corroboratingRoots).toEqual(['lineage:memory-1']);
    expect(withTainted.hypotheses[0].status).toBe('insufficient');
  });

  it('gives zero confidence when all support is tainted (#1254)', () => {
    const coordinator = new EvidenceConsolidationCoordinator();
    const result = coordinator.consolidate([
      base('memory-t', 'memory', { taint: 'tainted', trust: 'owner', confidence: 1 }),
      base('taste-t', 'taste', { taint: 'tainted', trust: 'owner', confidence: 1 }),
    ], NOW);

    expect(result.hypotheses[0]).toMatchObject({
      status: 'insufficient',
      confidence: 0,
      corroboratingRoots: [],
    });
  });

  it('ages stale evidence out of ready status', () => {
    const coordinator = new EvidenceConsolidationCoordinator({ maxAgeDays: 30 });
    const result = coordinator.consolidate([
      base('memory-old', 'memory', { observedAt: '2026-05-01T00:00:00.000Z' }),
      base('taste-old', 'taste', { observedAt: '2026-05-01T00:00:00.000Z' }),
    ], NOW);

    expect(result.hypotheses[0]).toMatchObject({
      status: 'insufficient',
      confidence: 0,
    });
  });

  it('assigns bounded retry ownership without inventing composition evidence', () => {
    const coordinator = new EvidenceConsolidationCoordinator({
      retryDelayMs: 1_000,
      maxRetries: 2,
    });
    const result = coordinator.consolidate([
      base('ops-retry', 'operational', {
        retryOwner: 'consolidate-loop',
        retryAttempt: 0,
      }),
    ], NOW);

    expect(result.hypotheses[0]).toMatchObject({
      status: 'retry',
      retry: {
        owner: 'consolidate-loop',
        attempt: 1,
        nextRetryAt: '2026-07-30T12:00:01.000Z',
      },
      supportingSources: ['operational'],
    });
    expect(result.hypotheses[0].citations.some(
      item => item.source === 'composition',
    )).toBe(false);
  });

  it('returns no hypothesis for empty or invalid evidence and preserves input', () => {
    const coordinator = new EvidenceConsolidationCoordinator();
    const evidence = [
      base('memory-1', 'memory'),
      base('', 'archive'),
    ];
    const snapshot = structuredClone(evidence);
    const result = coordinator.consolidate(evidence, NOW);

    expect(coordinator.consolidate([], NOW).hypotheses).toEqual([]);
    expect(result.rejectedEvidence).toBe(1);
    expect(evidence).toEqual(snapshot);
  });

  it('rejects conflicting duplicate IDs and treats changed propositions as disagreement', () => {
    const coordinator = new EvidenceConsolidationCoordinator();
    const original = base('memory-1', 'memory');
    const result = coordinator.consolidate([
      original,
      { ...original, confidence: 0.1 },
      base('taste-1', 'taste'),
      base('archive-1', 'archive', { claim: 'A different proposition' }),
    ], NOW);

    expect(result.rejectedEvidence).toBe(1);
    expect(result.hypotheses[0].disagreements).toHaveLength(1);
  });

  it('is integrated through the existing MemoryConsolidator pathway', () => {
    const consolidator = new MemoryConsolidator();
    const result = consolidator.consolidateEvidence([
      base('pattern-1', 'pattern'),
      base('archive-1', 'archive'),
    ], NOW);

    expect(result.hypotheses[0].status).toBe('ready');
  });
});
