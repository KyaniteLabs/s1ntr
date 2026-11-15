import { describe, expect, it, vi } from 'vitest';
import {
  buildTemporalArtifact,
  TEMPORAL_ARTIFACT_SCHEMA,
  TEMPORAL_ARTIFACT_VERSION,
} from '../../../src/creative-intelligence/temporal/TemporalArtifact.js';
import {
  CreativeRunCoordinator,
  MemoryCreativeRunPersistence,
  TemporalArtifactBuilder,
} from '../../../src/creative-run/CreativeRunCoordinator.js';
import {
  compileCreativeThesis,
  validateCreativeThesis,
} from '../../../src/creative-intelligence/CreativeIntelligence.js';

const TEMPORAL_ARC_BRIEF = 'A time-based study that evolves from stillness into a luminous release across sample frames over time.';
const TEMPORAL_RHYTHM_BRIEF = 'A time-based rhythm that pulses across the duration with steady beats over time.';
const UNSUPPORTED_BRIEF = 'Use the chiaroscuro principle for this time-based study with frame sequence over time.';

describe('temporal artifact (no-spend time-based create)', () => {
  it('produces a real artifact whose HTML embeds the thesis identity and observable sample timeline', () => {
    const artifact = buildTemporalArtifact({
      brief: TEMPORAL_ARC_BRIEF,
      artifactId: 'temporal-evidence-w8-07',
      schedule: { id: 'arc-6', unit: 'frame', sampleCount: 6, interval: 1, firstT: 0 },
    });
    expect(artifact.schema).toBe(TEMPORAL_ARTIFACT_SCHEMA);
    expect(artifact.schemaVersion).toBe(TEMPORAL_ARTIFACT_VERSION);
    expect(artifact.principleId).toBe('temporal-arc');
    expect(artifact.thesisId).toMatch(/^thesis-/);
    expect(artifact.projectionDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(artifact.evidence.samples.length).toBe(6);
    expect(artifact.evidence.clock.fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(artifact.html).toContain(`data-creative-thesis-id="${artifact.thesisId}`);
    expect(artifact.html).toContain(`data-creative-principle-id="temporal-arc"`);
    expect(artifact.html).toContain('<meta name="sinter-temporal-clock-id"');
    expect(artifact.html).toContain('class="bar"');
    expect(artifact.html).toContain('Observed temporal arc');
    expect(artifact.samplesDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(artifact.clockFingerprint).toBe(artifact.evidence.clock.fingerprint);
    expect(artifact.observedChange.observedAtSample).toBe(6);
  });

  it('applies bounded revisions while preserving the clock fingerprint and projection digest', () => {
    const artifact = buildTemporalArtifact({
      brief: TEMPORAL_RHYTHM_BRIEF,
      artifactId: 'temporal-evidence-w8-07-rhythm',
      schedule: { id: 'rhythm-6', unit: 'ms', sampleCount: 6, interval: 100, firstT: 0 },
      revisionApplications: [{ revisionId: 'phase-shift', bound: 2 }],
    });
    expect(artifact.principleId).toBe('temporal-rhythm');
    expect(artifact.evidence.schedule.firstT).toBe(0);
    expect(artifact.evidence.samples.length).toBe(6);
    expect(artifact.evidence.clock.fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(artifact.html).toContain('data-creative-principle-id="temporal-rhythm"');
    expect(artifact.revisions.length).toBe(1);
    expect(artifact.revisions[0]?.request.revisionId).toBe('phase-shift');
    expect(artifact.revisions[0]?.request.bound).toBe(2);
  });

  it('rejects multiple revision inputs before constructing an artifact', () => {
    expect(() => buildTemporalArtifact({
      brief: TEMPORAL_ARC_BRIEF,
      revisionApplications: [
        { revisionId: 'phase-shift', bound: 1 },
        { revisionId: 'compress', bound: 2 },
      ],
    })).toThrow(/at most one revision/i);
  });

  it('does not create an artifact from duplicate or drifting generated samples', () => {
    expect(() => buildTemporalArtifact({
      brief: TEMPORAL_ARC_BRIEF,
      schedule: { sampleCount: 3 },
      sampleGenerator: (index, schedule) => ({ id: 's-dup', t: index, unit: schedule.unit, value: index }),
    })).toThrow(/duplicate samples/i);
    expect(() => buildTemporalArtifact({
      brief: TEMPORAL_ARC_BRIEF,
      schedule: { sampleCount: 3, interval: 2 },
      sampleGenerator: (index, schedule) => ({ id: `s-${index}`, t: index, unit: schedule.unit, value: index }),
    })).toThrow(/timeline drift/i);
  });

  it('fails closed when the brief names an unsupported principle', () => {
    expect(() => buildTemporalArtifact({
      brief: UNSUPPORTED_BRIEF,
      artifactId: 'temporal-evidence-w8-07-bad',
      schedule: { id: 'arc-3', unit: 'ms', sampleCount: 3, interval: 1, firstT: 0 },
    })).toThrow(/supported Creative Thesis/i);
  });

  it('fails closed when handed a pre-compiled unsupported thesis', () => {
    const unsupported = compileCreativeThesis(UNSUPPORTED_BRIEF);
    expect(unsupported.disposition).toBe('unsupported');
    expect(() => buildTemporalArtifact({
      brief: TEMPORAL_ARC_BRIEF,
      artifactId: 'temporal-evidence-w8-07-bad-thesis',
      schedule: { id: 'arc-3', unit: 'ms', sampleCount: 3, interval: 1, firstT: 0 },
      thesis: unsupported,
    })).toThrow(/unsupported/i);
  });

  it('rejects an explicit thesis whose principle is not motion/time', () => {
    const crossDomain = compileCreativeThesis('A quiet restraint that opens into luminous release.');
    expect(crossDomain.disposition).toBe('supported');
    expect(() => buildTemporalArtifact({
      brief: TEMPORAL_ARC_BRIEF,
      artifactId: 'temporal-evidence-w8-07-cross',
      schedule: { id: 'arc-3', unit: 'ms', sampleCount: 3, interval: 1, firstT: 0 },
      thesis: crossDomain,
    })).toThrow(/motion\/time principle/i);
  });

  it('accepts a validated thesis carrying the temporal-arc identity', () => {
    const thesis = compileCreativeThesis(TEMPORAL_ARC_BRIEF);
    expect(thesis.disposition).toBe('supported');
    const validated = validateCreativeThesis(thesis);
    const artifact = buildTemporalArtifact({
      brief: TEMPORAL_ARC_BRIEF,
      artifactId: 'temporal-evidence-w8-07-passed-thesis',
      schedule: { id: 'arc-3', unit: 'ms', sampleCount: 3, interval: 1, firstT: 0 },
      thesis: validated,
    });
    expect(artifact.thesisId).toBe(validated.thesisId);
  });
});

describe('temporal artifact integration with CreativeRunCoordinator', () => {
  it('routes production Create through the temporal generator seam', async () => {
    const coordinator = new CreativeRunCoordinator({ persistence: new MemoryCreativeRunPersistence() });
    const generated = buildTemporalArtifact({ brief: TEMPORAL_ARC_BRIEF, artifactId: 'generator-spy-result' });
    const generator = { generate: vi.fn(() => generated) };
    const result = await new TemporalArtifactBuilder(coordinator, generator).compose({
      brief: TEMPORAL_ARC_BRIEF,
      artifactId: 'generator-spy-input',
      requestKey: 'generator-spy-input',
    });
    expect(generator.generate).toHaveBeenCalledOnce();
    expect(generator.generate).toHaveBeenCalledWith(expect.objectContaining({ artifactId: 'generator-spy-input' }));
    expect(result.temporalArtifact).toBe(generated);
    expect(result.creativeRun.readiness.source).toBe('synthetic-no-spend');
  });

  it('reaches the no-spend path through the coordinator without reserving a provider', async () => {
    const coordinator = new CreativeRunCoordinator({ persistence: new MemoryCreativeRunPersistence() });
    const result = await new TemporalArtifactBuilder(coordinator).compose({
      brief: TEMPORAL_ARC_BRIEF,
      artifactId: 'coordinated-temporal-w8-07',
      schedule: { id: 'arc-5', unit: 'frame', sampleCount: 5, interval: 1, firstT: 0 },
      requestKey: 'coordinated-temporal-w8-07',
    });
    expect(result.creativeRun.readiness.source).toBe('synthetic-no-spend');
    expect(result.creativeRun.creativeThesis?.principles[0]?.contractIdentity.principleId).toBe('temporal-arc');
    expect(result.temporalArtifact.principleId).toBe('temporal-arc');
    expect(result.temporalArtifact.html).toContain('data-creative-thesis-id');
  });

  it('excludes reservation when the coordinator reserves nothing (synthetic-no-spend default)', async () => {
    const coordinator = new CreativeRunCoordinator({ persistence: new MemoryCreativeRunPersistence() });
    const result = await new TemporalArtifactBuilder(coordinator).compose({
      brief: 'A time-based scene that moves from restraint into luminous release through sample frames over time.',
      artifactId: 'no-spend-default-w8-07',
      schedule: { id: 'arc-4', unit: 'ms', sampleCount: 4, interval: 1, firstT: 0 },
      requestKey: 'no-spend-default-w8-07',
    });
    expect(result.creativeRun.readiness.source).toBe('synthetic-no-spend');
    expect(result.temporalArtifact.evidence.samples.length).toBe(4);
  });

  it('fails an unsupported brief before creating even a synthetic run record', async () => {
    const persistence = new MemoryCreativeRunPersistence();
    const reserve = vi.fn(async () => { throw new Error('must not reserve'); });
    const coordinator = new CreativeRunCoordinator({ persistence, reserveProvider: reserve as never });
    await expect(new TemporalArtifactBuilder(coordinator).compose({
      brief: UNSUPPORTED_BRIEF,
      artifactId: 'unsupported-before-run-w8-07',
      requestKey: 'unsupported-before-run-w8-07',
    })).rejects.toThrow(/unsupported/i);
    expect(reserve).not.toHaveBeenCalled();
    expect(await persistence.read('unsupported-before-run-w8-07')).toBeNull();
  });
});
