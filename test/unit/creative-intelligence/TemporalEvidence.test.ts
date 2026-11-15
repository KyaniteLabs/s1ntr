import { describe, expect, it } from 'vitest';
import {
  TEMPORAL_EVIDENCE_SCHEMA,
  TEMPORAL_EVIDENCE_VERSION,
  TEMPORAL_REVISION_OPERATOR_SCHEMA,
  applyBoundedTemporalRevision,
  buildTemporalEvidence,
  detectDuplicateTemporalSamples,
  detectTemporalClockDrift,
  temporalClockFingerprint,
  temporalEvidenceDigest,
} from '../../../src/creative-intelligence/temporal/TemporalEvidence.js';

const BASE_OPTIONS = {
  artifactId: 'artifact-w8-07-test',
  thesisId: 'thesis-w8-07-test',
  principleId: 'temporal-arc',
  contractVersion: 1,
  projectionDigest: 'a'.repeat(64),
} as const;

describe('temporal evidence', () => {
  it('binds clock identity, schedule, and samples to the exact artifact and selected principle', () => {
    const evidence = buildTemporalEvidence({
      ...BASE_OPTIONS,
      schedule: { id: 'arc-8', unit: 'ms', sampleCount: 8, interval: 100, firstT: 0 },
    });
    expect(evidence.schema).toBe(TEMPORAL_EVIDENCE_SCHEMA);
    expect(evidence.schemaVersion).toBe(TEMPORAL_EVIDENCE_VERSION);
    expect(evidence.artifactId).toBe('artifact-w8-07-test');
    expect(evidence.principleId).toBe('temporal-arc');
    expect(evidence.contractVersion).toBe(1);
    expect(evidence.projectionDigest).toBe('a'.repeat(64));
    expect(evidence.schedule.deterministic).toBe(true);
    expect(evidence.schedule.sampleCount).toBe(8);
    expect(evidence.schedule.firstT).toBe(0);
    expect(evidence.schedule.lastT).toBe(700);
    expect(evidence.samples.length).toBe(8);
    expect(evidence.clock.clockAlgorithm).toBe('monotonic-ns');
    expect(evidence.clock.epoch).toBe('process-start');
    expect(evidence.clock.fingerprint).toMatch(/^[a-f0-9]{64}$/);
  });

  it('records an observable change between first and last samples', () => {
    const evidence = buildTemporalEvidence({
      ...BASE_OPTIONS,
      sampleGenerator: (index, schedule) => {
        const progress = schedule.sampleCount <= 1 ? 0 : index / (schedule.sampleCount - 1);
        return { id: `s-${index}`, t: schedule.firstT + index * schedule.interval, unit: schedule.unit, value: progress, label: 'arc' };
      },
      schedule: { id: 'arc-5', unit: 'frame', sampleCount: 5, interval: 1, firstT: 0 },
    });
    expect(evidence.observedChange.firstValue).toBe(0);
    expect(evidence.observedChange.lastValue).toBe(1);
    expect(evidence.observedChange.delta).toBe(1);
    expect(evidence.observedChange.observedAtSample).toBe(5);
  });

  it('rejects schedules with fewer than 2 samples', () => {
    expect(() => buildTemporalEvidence({
      ...BASE_OPTIONS,
      schedule: { id: 'arc-1', unit: 'ms', sampleCount: 1, interval: 1, firstT: 0 },
    })).toThrow(/at least 2 samples/);
  });

  it('rejects non-positive intervals', () => {
    expect(() => buildTemporalEvidence({
      ...BASE_OPTIONS,
      schedule: { id: 'arc-3', unit: 'ms', sampleCount: 3, interval: 0, firstT: 0 },
    })).toThrow(/interval must be positive/);
  });

  it('rejects sample units that disagree with the schedule unit', () => {
    expect(() => buildTemporalEvidence({
      ...BASE_OPTIONS,
      sampleGenerator: (index, schedule) => ({ id: `s-${index}`, t: schedule.firstT + index, unit: 'frame', value: 0 }),
      schedule: { id: 'arc-3', unit: 'ms', sampleCount: 3, interval: 1, firstT: 0 },
    })).toThrow(/unit mismatch/);
  });

  it('fails construction closed on declared schedule and generated timeline drift', () => {
    expect(() => buildTemporalEvidence({
      ...BASE_OPTIONS,
      schedule: { sampleCount: 3, interval: 2, firstT: 1, lastT: 99 },
    })).toThrow(/schedule timeline drift/i);
    expect(() => buildTemporalEvidence({
      ...BASE_OPTIONS,
      schedule: { sampleCount: 3, interval: 2, firstT: 1 },
      sampleGenerator: (index, schedule) => ({ id: `s-${index}`, t: schedule.firstT + index, unit: schedule.unit, value: index }),
    })).toThrow(/sample timeline drift/i);
  });

  it('fails construction closed when the clock fingerprint does not identify its metadata', () => {
    const identity = { clockId: 'manual-clock', clockAlgorithm: 'manual' as const, epoch: 'manual' as const, resolutionNs: 1 };
    expect(() => buildTemporalEvidence({
      ...BASE_OPTIONS,
      clock: { ...identity, fingerprint: temporalClockFingerprint({ ...identity, clockId: 'other-clock' }) },
    })).toThrow(/clock identity mismatch/i);
  });

  it('applies a bounded compress revision and preserves first/last samples', () => {
    const original = buildTemporalEvidence({ ...BASE_OPTIONS, schedule: { id: 'arc-8', unit: 'ms', sampleCount: 8, interval: 1, firstT: 0 } });
    const result = applyBoundedTemporalRevision({ evidence: original, revisionId: 'compress', bound: 4 });
    expect(result.appliedRevision.id).toBe('compress');
    expect(result.evidence.samples.length).toBe(4);
    expect(result.evidence.samples[0]?.value).toBe(original.samples[0]?.value);
    expect(result.evidence.samples.at(-1)).toEqual(original.samples.at(-1));
    expect(result.evidence.schedule.lastT).toBe(original.schedule.lastT);
  });

  it.each([
    ['reverse', 1, 3],
    ['phase-shift', 1, 3],
    ['refine-arc', 6, 6],
  ] as const)('applies %s with a schedule consistent with revised timestamps', (revisionId, bound, sampleCount) => {
    const original = buildTemporalEvidence({ ...BASE_OPTIONS, schedule: { id: 'arc-3', unit: 'ms', sampleCount: 3, interval: 1, firstT: 0 } });
    const result = applyBoundedTemporalRevision({ evidence: original, revisionId, bound });
    expect(result.evidence.samples).toHaveLength(sampleCount);
    expect(result.evidence.schedule.sampleCount).toBe(sampleCount);
    expect(result.evidence.samples.map((sample) => sample.t)).toEqual(
      Array.from({ length: sampleCount }, (_, index) => result.evidence.schedule.firstT + index * result.evidence.schedule.interval),
    );
    expect(result.evidence.schedule.lastT).toBe(result.evidence.samples.at(-1)?.t);
    expect(detectDuplicateTemporalSamples(result.evidence)).toBe(false);
  });

  it('refuses to exceed the declared revision bound', () => {
    const original = buildTemporalEvidence({ ...BASE_OPTIONS, schedule: { id: 'arc-4', unit: 'ms', sampleCount: 4, interval: 1, firstT: 0 } });
    expect(() => applyBoundedTemporalRevision({ evidence: original, revisionId: 'compress', bound: 99 })).toThrow(/bound exceeded/);
  });

  it('refuses an unknown revision id', () => {
    const original = buildTemporalEvidence({ ...BASE_OPTIONS, schedule: { id: 'arc-3', unit: 'ms', sampleCount: 3, interval: 1, firstT: 0 } });
    expect(() => applyBoundedTemporalRevision({ evidence: original, revisionId: 'unknown', bound: 1 })).toThrow(/not found/);
  });

  it('globally permits at most one revision on an evidence lineage', () => {
    const original = buildTemporalEvidence({ ...BASE_OPTIONS, schedule: { sampleCount: 4 } });
    const revised = applyBoundedTemporalRevision({ evidence: original, revisionId: 'phase-shift', bound: 1 }).evidence;
    expect(() => applyBoundedTemporalRevision({ evidence: revised, revisionId: 'compress', bound: 2 }))
      .toThrow(/at most one revision/i);
  });

  it('produces a deterministic digest that changes when samples change', () => {
    const a = buildTemporalEvidence({ ...BASE_OPTIONS, schedule: { id: 'arc-3', unit: 'ms', sampleCount: 3, interval: 1, firstT: 0 } });
    const b = buildTemporalEvidence({ ...BASE_OPTIONS, schedule: { id: 'arc-3', unit: 'ms', sampleCount: 3, interval: 1, firstT: 0 } });
    expect(temporalEvidenceDigest(a)).toBe(temporalEvidenceDigest(b));
    const rotated = applyBoundedTemporalRevision({ evidence: a, revisionId: 'phase-shift', bound: 1 });
    expect(temporalEvidenceDigest(rotated.evidence)).not.toBe(temporalEvidenceDigest(a));
  });

  it('keeps the digest stable when semantically identical object keys are reordered', () => {
    const evidence = buildTemporalEvidence({ ...BASE_OPTIONS, schedule: { id: 'arc-3', unit: 'ms', sampleCount: 3, interval: 1, firstT: 0 } });
    const reordered = {
      observedChange: { observedAtSample: evidence.observedChange.observedAtSample, delta: evidence.observedChange.delta, lastValue: evidence.observedChange.lastValue, firstValue: evidence.observedChange.firstValue },
      revisions: evidence.revisions,
      appliedRevisionCount: evidence.appliedRevisionCount,
      samples: evidence.samples.map((sample) => ({ label: sample.label, value: sample.value, unit: sample.unit, t: sample.t, id: sample.id })),
      schedule: { deterministic: evidence.schedule.deterministic, lastT: evidence.schedule.lastT, firstT: evidence.schedule.firstT, interval: evidence.schedule.interval, sampleCount: evidence.schedule.sampleCount, unit: evidence.schedule.unit, id: evidence.schedule.id },
      clock: { fingerprint: evidence.clock.fingerprint, resolutionNs: evidence.clock.resolutionNs, epoch: evidence.clock.epoch, clockAlgorithm: evidence.clock.clockAlgorithm, clockId: evidence.clock.clockId },
      projectionDigest: evidence.projectionDigest,
      contractVersion: evidence.contractVersion,
      principleId: evidence.principleId,
      thesisId: evidence.thesisId,
      artifactId: evidence.artifactId,
      schemaVersion: evidence.schemaVersion,
      schema: evidence.schema,
    } as typeof evidence;
    expect(temporalEvidenceDigest(reordered)).toBe(temporalEvidenceDigest(evidence));
  });

  it('flags clock drift against an unexpected fingerprint', () => {
    const evidence = buildTemporalEvidence({ ...BASE_OPTIONS, schedule: { id: 'arc-3', unit: 'ms', sampleCount: 3, interval: 1, firstT: 0 } });
    expect(detectTemporalClockDrift(evidence, evidence.clock.fingerprint)).toBe(false);
    expect(detectTemporalClockDrift(evidence, 'wrong')).toBe(true);
  });

  it('accepts a constant-state trajectory: same value at distinct times is not duplication (#1282)', () => {
    const evidence = buildTemporalEvidence({
      ...BASE_OPTIONS,
      schedule: { id: 'arc-3', unit: 'ms', sampleCount: 3, interval: 1, firstT: 0 },
      sampleGenerator: (index, schedule) => ({ id: `flat-${index}`, t: schedule.firstT + index, unit: schedule.unit, value: 1 }),
    });
    expect(evidence.samples.map(s => s.value)).toEqual([1, 1, 1]);
    expect(evidence.observedChange).toEqual({ firstValue: 1, lastValue: 1, delta: 0, observedAtSample: 3 });
    expect(detectDuplicateTemporalSamples(evidence)).toBe(false);
  });

  it('accepts a plateau inside a ramp (#1282)', () => {
    const values = [0, 0.5, 0.5, 1];
    const evidence = buildTemporalEvidence({
      ...BASE_OPTIONS,
      schedule: { id: 'arc-4', unit: 'ms', sampleCount: 4, interval: 1, firstT: 0 },
      sampleGenerator: (index, schedule) => ({ id: `p-${index}`, t: schedule.firstT + index, unit: schedule.unit, value: values[index]! }),
    });
    expect(evidence.observedChange.delta).toBe(1);
  });

  it('fails construction closed on a reused observation id', () => {
    expect(() => buildTemporalEvidence({
      ...BASE_OPTIONS,
      schedule: { id: 'arc-3', unit: 'ms', sampleCount: 3, interval: 1, firstT: 0 },
      sampleGenerator: (index, schedule) => ({ id: 'same-id', t: schedule.firstT + index, unit: schedule.unit, value: index }),
    })).toThrow(/duplicate samples/i);
  });

  it('marks revised samples as transformed or synthesized and never rewrites observedChange (#1281)', () => {
    const original = buildTemporalEvidence({ ...BASE_OPTIONS, schedule: { id: 'arc-3', unit: 'ms', sampleCount: 3, interval: 1, firstT: 0 } });
    expect(original.samples.every((sample) => sample.provenance === undefined)).toBe(true);
    expect(original.revisedChange).toBeUndefined();

    const reversed = applyBoundedTemporalRevision({ evidence: original, revisionId: 'reverse', bound: 1 }).evidence;
    expect(reversed.samples.map((sample) => sample.provenance)).toEqual(['transformed', 'transformed', 'transformed']);
    expect(reversed.observedChange).toEqual(original.observedChange);
    expect(reversed.revisedChange).toEqual({
      firstValue: original.observedChange.lastValue,
      lastValue: original.observedChange.firstValue,
      delta: -original.observedChange.delta,
      observedAtSample: 3,
    });

    const extended = applyBoundedTemporalRevision({ evidence: original, revisionId: 'extend', bound: 5 }).evidence;
    expect(extended.samples.map((sample) => sample.provenance)).toEqual([undefined, undefined, undefined, 'synthesized', 'synthesized']);
    expect(extended.observedChange).toEqual(original.observedChange);
    expect(extended.revisedChange?.observedAtSample).toBe(5);

    const refined = applyBoundedTemporalRevision({ evidence: original, revisionId: 'refine-arc', bound: 5 }).evidence;
    expect(refined.samples.every((sample) => sample.provenance === 'synthesized')).toBe(true);
  });

  it('flags duplicate sample positions even when observation IDs differ', () => {
    const evidence = buildTemporalEvidence(BASE_OPTIONS);
    const forged = { ...evidence, samples: [evidence.samples[0], { ...evidence.samples[1], t: evidence.samples[0]!.t }] } as typeof evidence;
    expect(detectDuplicateTemporalSamples(forged)).toBe(true);
  });

  it('uses the canonical temporal-revision-operator schema for declared revisions', () => {
    const evidence = buildTemporalEvidence({
      ...BASE_OPTIONS,
      schedule: { id: 'arc-2', unit: 'ms', sampleCount: 2, interval: 1, firstT: 0 },
      revisions: [{
        schema: TEMPORAL_REVISION_OPERATOR_SCHEMA,
        id: 'compress',
        kind: 'compress',
        label: 'Compress',
        description: 'Reduce samples.',
        boundedBy: 'sample-count',
        bound: 2,
      }],
    });
    expect(evidence.revisions[0]?.schema).toBe(TEMPORAL_REVISION_OPERATOR_SCHEMA);
    expect(evidence.revisions[0]?.kind).toBe('compress');
  });
});
