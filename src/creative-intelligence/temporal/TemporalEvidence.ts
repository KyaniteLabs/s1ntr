import { createHash } from 'node:crypto';

export const TEMPORAL_EVIDENCE_SCHEMA = 'sinter.temporal-evidence' as const;
export const TEMPORAL_EVIDENCE_VERSION = 1 as const;
export const TEMPORAL_REVISION_OPERATOR_SCHEMA = 'sinter.temporal-revision-operator' as const;

export type TemporalSampleUnit = 'ms' | 'frame' | 'beat' | 'tick';
export type TemporalRevisionKind = 'compress' | 'extend' | 'reverse' | 'phase-shift' | 'refine-arc';

export interface TemporalSample {
  readonly id: string;
  readonly t: number;
  readonly unit: TemporalSampleUnit;
  readonly value: number;
  readonly label?: string;
  /**
   * Absent or 'observed' = measured sample. Revisions mark moved samples
   * 'transformed' and interpolated/extended values 'synthesized'; neither may
   * be read as a new observation (#1281).
   */
  readonly provenance?: TemporalSampleProvenance;
}

export type TemporalSampleProvenance = 'observed' | 'transformed' | 'synthesized';

export interface TemporalSamplingSchedule {
  readonly id: string;
  readonly unit: TemporalSampleUnit;
  readonly sampleCount: number;
  readonly interval: number;
  readonly firstT: number;
  readonly lastT: number;
  readonly deterministic: true;
}

export interface TemporalClockIdentity {
  readonly clockId: string;
  readonly clockAlgorithm: 'monotonic-ns' | 'fixed-step' | 'manual';
  readonly epoch: 'process-start' | 'unix-epoch' | 'manual';
  readonly resolutionNs: number;
  readonly fingerprint: string;
}

export interface TemporalRevisionOperator {
  readonly schema: typeof TEMPORAL_REVISION_OPERATOR_SCHEMA;
  readonly id: string;
  readonly kind: TemporalRevisionKind;
  readonly label: string;
  readonly description: string;
  readonly boundedBy: 'sample-count' | 'window' | 'duration';
  readonly bound: number;
}

export interface TemporalEvidence {
  readonly schema: typeof TEMPORAL_EVIDENCE_SCHEMA;
  readonly schemaVersion: typeof TEMPORAL_EVIDENCE_VERSION;
  readonly artifactId: string;
  readonly thesisId: string;
  readonly principleId: string;
  readonly contractVersion: number;
  readonly projectionDigest: string;
  readonly clock: TemporalClockIdentity;
  readonly schedule: TemporalSamplingSchedule;
  readonly samples: readonly TemporalSample[];
  readonly revisions: readonly TemporalRevisionOperator[];
  readonly appliedRevisionCount: 0 | 1;
  /** Change across the originally observed samples; a revision never rewrites it. */
  readonly observedChange: {
    readonly firstValue: number;
    readonly lastValue: number;
    readonly delta: number;
    readonly observedAtSample: number;
  };
  /** Change across the revised (transformed/synthesized) samples, present only after a revision. */
  readonly revisedChange?: TemporalEvidence['observedChange'];
}

export interface TemporalEvidenceBuildOptions {
  readonly artifactId: string;
  readonly thesisId: string;
  readonly principleId: string;
  readonly contractVersion: number;
  readonly projectionDigest: string;
  readonly clock?: TemporalClockIdentity;
  readonly schedule?: Partial<TemporalSamplingSchedule>;
  readonly revisions?: readonly TemporalRevisionOperator[];
  readonly sampleGenerator?: (index: number, schedule: TemporalSamplingSchedule) => TemporalSample;
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(Object.keys(record).sort().map((key) => [key, canonicalize(record[key])]));
  }
  return value;
}

function stableJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested);
  }
  return value;
}

function defaultClock(): TemporalClockIdentity {
  // Deterministic canonical clock: the default no-spend clock carries a
  // canonical fingerprint so identical evidence options produce identical
  // digests. Callers can override with `options.clock` to bind a real runtime
  // fingerprint (e.g. process.hrtime + pid) when they need per-run identity.
  const fingerprintSeed = 'sinter.temporal-clock.canonical-monotonic-ns';
  const identity: Omit<TemporalClockIdentity, 'fingerprint'> = {
    clockId: `clock-${digest(fingerprintSeed).slice(0, 16)}`,
    clockAlgorithm: 'monotonic-ns',
    epoch: 'process-start',
    resolutionNs: 1_000_000,
  };
  return { ...identity, fingerprint: temporalClockFingerprint(identity) };
}

export function temporalClockFingerprint(clock: Omit<TemporalClockIdentity, 'fingerprint'>): string {
  return digest(stableJson(clock));
}

function defaultSchedule(partial: Partial<TemporalSamplingSchedule> | undefined): TemporalSamplingSchedule {
  const unit: TemporalSampleUnit = partial?.unit ?? 'ms';
  const sampleCount = partial?.sampleCount ?? 8;
  const interval = partial?.interval ?? 1;
  const firstT = partial?.firstT ?? 0;
  const lastT = firstT + (sampleCount - 1) * interval;
  if (partial?.lastT !== undefined && partial.lastT !== lastT) {
    throw new Error(`Temporal sampling schedule timeline drift (${partial.lastT} vs ${lastT})`);
  }
  return {
    id: partial?.id ?? `schedule-${unit}-${sampleCount}-${interval}`,
    unit,
    sampleCount,
    interval,
    firstT,
    lastT,
    deterministic: true,
  };
}

function defaultSampleGenerator(index: number, schedule: TemporalSamplingSchedule): TemporalSample {
  const t = schedule.firstT + index * schedule.interval;
  const progress = schedule.sampleCount <= 1 ? 0 : index / (schedule.sampleCount - 1);
  const wave = Math.sin(progress * Math.PI);
  const value = Math.round((wave + progress * 0.01) * 1000) / 1000;
  return {
    id: `sample-${schedule.id}-${index}`,
    t,
    unit: schedule.unit,
    value: Math.round(value * 1000) / 1000,
    label: index === 0 ? 'opening' : index === schedule.sampleCount - 1 ? 'release' : 'development',
  };
}

function observedChange(samples: readonly TemporalSample[]): TemporalEvidence['observedChange'] {
  if (samples.length === 0) {
    return { firstValue: 0, lastValue: 0, delta: 0, observedAtSample: 0 };
  }
  const first = samples[0]!;
  const last = samples[samples.length - 1]!;
  return {
    firstValue: first.value,
    lastValue: last.value,
    delta: Math.round((last.value - first.value) * 1000) / 1000,
    observedAtSample: samples.length,
  };
}

function validateTemporalEvidence(evidence: TemporalEvidence): void {
  const { fingerprint: _fingerprint, ...clockIdentity } = evidence.clock;
  if (evidence.clock.fingerprint !== temporalClockFingerprint(clockIdentity)) {
    throw new Error('Temporal clock identity mismatch');
  }
  const { schedule, samples } = evidence;
  if (samples.length !== schedule.sampleCount) throw new Error('Temporal sampling schedule sample count mismatch');
  if (schedule.lastT !== schedule.firstT + (schedule.sampleCount - 1) * schedule.interval) {
    throw new Error('Temporal sampling schedule timeline drift');
  }
  for (const [index, sample] of samples.entries()) {
    if (sample.unit !== schedule.unit) throw new Error(`Temporal sample unit mismatch (${sample.unit} vs ${schedule.unit})`);
    if (!Number.isFinite(sample.value)) throw new Error('Temporal sample value must be a finite number');
    const expectedT = schedule.firstT + index * schedule.interval;
    if (sample.t !== expectedT) throw new Error(`Temporal sample timeline drift at index ${index} (${sample.t} vs ${expectedT})`);
  }
  if (detectDuplicateTemporalSamples(evidence)) throw new Error('Temporal evidence contains duplicate samples');
}

export function buildTemporalEvidence(options: TemporalEvidenceBuildOptions): TemporalEvidence {
  const clock = options.clock ?? defaultClock();
  const schedule = defaultSchedule(options.schedule);
  if (!Number.isInteger(schedule.sampleCount) || schedule.sampleCount < 2) throw new Error('Temporal sampling schedule requires at least 2 samples');
  if (!Number.isFinite(schedule.interval) || schedule.interval <= 0) throw new Error('Temporal sampling schedule interval must be positive');
  if (!Number.isFinite(schedule.firstT)) throw new Error('Temporal sampling schedule firstT must be finite');
  const generator = options.sampleGenerator ?? defaultSampleGenerator;
  const samples = Array.from({ length: schedule.sampleCount }, (_, index) => generator(index, schedule));
  const revisions = options.revisions ?? [];
  const evidence = {
    schema: TEMPORAL_EVIDENCE_SCHEMA,
    schemaVersion: TEMPORAL_EVIDENCE_VERSION,
    artifactId: options.artifactId,
    thesisId: options.thesisId,
    principleId: options.principleId,
    contractVersion: options.contractVersion,
    projectionDigest: options.projectionDigest,
    clock,
    schedule,
    samples: Object.freeze(samples),
    revisions: Object.freeze(revisions),
    appliedRevisionCount: 0 as const,
    observedChange: observedChange(samples),
  };
  validateTemporalEvidence(evidence);
  return deepFreeze(evidence);
}

export interface TemporalRevisionApplyOptions {
  readonly evidence: TemporalEvidence;
  readonly revisionId: string;
  readonly bound: number;
}

export interface TemporalRevisionApplyResult {
  readonly evidence: TemporalEvidence;
  readonly appliedRevision: TemporalRevisionOperator;
  readonly previousRevisionCount: number;
}

/**
 * Canonical revision operators available to any motion/time evidence record.
 * Evidence may declare its own revisions (overriding bound/description), but if
 * none are declared the apply step uses these contract-bound defaults so a
 * caller can run a bounded revision without re-stating the operator manifest.
 */
export const CANONICAL_TEMPORAL_REVISIONS: readonly TemporalRevisionOperator[] = Object.freeze([
  Object.freeze({
    schema: 'sinter.temporal-revision-operator' as const,
    id: 'refine-arc',
    kind: 'refine-arc' as const,
    label: 'Refine arc',
    description: 'Subdivide the arc into additional intermediate samples while preserving first and last sample identity.',
    boundedBy: 'sample-count' as const,
    bound: 16,
  }),
  Object.freeze({
    schema: 'sinter.temporal-revision-operator' as const,
    id: 'phase-shift',
    kind: 'phase-shift' as const,
    label: 'Phase shift',
    description: 'Rotate the sample order by a bounded number of samples.',
    boundedBy: 'sample-count' as const,
    bound: 4,
  }),
  Object.freeze({
    schema: 'sinter.temporal-revision-operator' as const,
    id: 'compress',
    kind: 'compress' as const,
    label: 'Compress',
    description: 'Reduce the visible sample count by a bounded amount while preserving the first and last sample.',
    boundedBy: 'sample-count' as const,
    bound: 4,
  }),
  Object.freeze({
    schema: 'sinter.temporal-revision-operator' as const,
    id: 'extend',
    kind: 'extend' as const,
    label: 'Extend',
    description: 'Add a bounded number of trailing samples to lengthen the observed arc.',
    boundedBy: 'sample-count' as const,
    bound: 8,
  }),
  Object.freeze({
    schema: 'sinter.temporal-revision-operator' as const,
    id: 'reverse',
    kind: 'reverse' as const,
    label: 'Reverse',
    description: 'Reverse the sample order; bound is informational because reversal is symmetric.',
    boundedBy: 'sample-count' as const,
    bound: 1,
  }),
]);

function resolveRevision(evidence: TemporalEvidence, revisionId: string): TemporalRevisionOperator | undefined {
  const declared = evidence.revisions.find((item) => item.id === revisionId);
  if (declared) return declared;
  return CANONICAL_TEMPORAL_REVISIONS.find((item) => item.id === revisionId);
}

function transformedProvenance(sample: TemporalSample): TemporalSampleProvenance {
  return sample.provenance === 'synthesized' ? 'synthesized' : 'transformed';
}

export function applyBoundedTemporalRevision(options: TemporalRevisionApplyOptions): TemporalRevisionApplyResult {
  if (options.evidence.appliedRevisionCount !== 0) {
    throw new Error('Temporal evidence permits at most one revision');
  }
  const revision = resolveRevision(options.evidence, options.revisionId);
  if (!revision) throw new Error(`Temporal revision not found: ${options.revisionId}`);
  if (revision.bound <= 0) throw new Error(`Temporal revision bound must be positive: ${options.revisionId}`);
  if (!Number.isInteger(options.bound) || options.bound <= 0) throw new Error(`Temporal revision bound must be a positive integer: ${options.revisionId}`);
  if (options.bound > revision.bound) throw new Error(`Temporal revision bound exceeded (${options.bound} > ${revision.bound})`);
  const previousRevisionCount = options.evidence.samples.length;
  if (revision.kind === 'compress' && options.bound < 2) throw new Error('Temporal revision cannot reduce evidence below 2 samples');
  if (revision.kind === 'extend' && options.bound <= previousRevisionCount) throw new Error('Temporal extension bound must exceed the current sample count');
  let nextSamples: readonly TemporalSample[];
  switch (revision.kind) {
    case 'compress': {
      const source = options.evidence.samples;
      nextSamples = Array.from({ length: options.bound }, (_, index) => {
        if (index === 0) return source[0]!;
        if (index === options.bound - 1) return source[source.length - 1]!;
        const position = index * (source.length - 1) / (options.bound - 1);
        const leftIndex = Math.floor(position);
        const rightIndex = Math.ceil(position);
        const left = source[leftIndex]!;
        const right = source[rightIndex]!;
        const fraction = position - leftIndex;
        return {
          id: `sample-compress-${revision.id}-${index}`,
          t: options.evidence.schedule.firstT
            + index * (options.evidence.schedule.lastT - options.evidence.schedule.firstT) / (options.bound - 1),
          unit: options.evidence.schedule.unit,
          value: Math.round((left.value + (right.value - left.value) * fraction) * 1000) / 1000,
          label: left.label,
          provenance: 'synthesized' as const,
        };
      });
      break;
    }
    case 'extend':
      nextSamples = [
        ...options.evidence.samples,
        ...Array.from({ length: options.bound - options.evidence.samples.length }, (_, index) => ({
          id: `sample-extension-${revision.id}-${index}`,
          t: options.evidence.schedule.lastT + (index + 1) * options.evidence.schedule.interval,
          unit: options.evidence.schedule.unit,
          value: 0,
          label: 'extension',
          provenance: 'synthesized' as const,
        })),
      ];
      break;
    case 'reverse':
      nextSamples = [...options.evidence.samples].reverse().map((sample, index) => ({
        ...sample,
        t: options.evidence.schedule.firstT + index * options.evidence.schedule.interval,
        provenance: transformedProvenance(sample),
      }));
      break;
    case 'phase-shift': {
      const shift = options.bound % options.evidence.samples.length;
      nextSamples = [...options.evidence.samples.slice(shift), ...options.evidence.samples.slice(0, shift)]
        .map((sample, index) => ({
          ...sample,
          t: options.evidence.schedule.firstT + index * options.evidence.schedule.interval,
          provenance: transformedProvenance(sample),
        }));
      break;
    }
    case 'refine-arc': {
      const base = options.evidence.samples;
      const refined: TemporalSample[] = [];
      const interval = (options.evidence.schedule.lastT - options.evidence.schedule.firstT) / (options.bound - 1);
      for (let index = 0; index < options.bound; index += 1) {
        const position = index * (base.length - 1) / (options.bound - 1);
        const left = base[Math.floor(position)]!;
        const right = base[Math.ceil(position)]!;
        const fraction = position - Math.floor(position);
        refined.push({
          id: `sample-refine-${revision.id}-${index}`,
          t: options.evidence.schedule.firstT + index * interval,
          unit: left.unit,
          value: Math.round((left.value + (right.value - left.value) * fraction) * 1000) / 1000,
          label: 'refined',
          provenance: 'synthesized',
        });
      }
      nextSamples = refined;
      break;
    }
    default: {
      const exhaustive: never = revision.kind;
      throw new Error(`Unsupported temporal revision kind: ${String(exhaustive)}`);
    }
  }
  const nextSchedule: TemporalSamplingSchedule = {
    ...options.evidence.schedule,
    sampleCount: nextSamples.length,
    interval: revision.kind === 'compress' || revision.kind === 'refine-arc'
      ? (options.evidence.schedule.lastT - options.evidence.schedule.firstT) / (nextSamples.length - 1)
      : options.evidence.schedule.interval,
    lastT: nextSamples[nextSamples.length - 1]?.t ?? options.evidence.schedule.lastT,
  };
  const nextEvidence: TemporalEvidence = deepFreeze({
    ...options.evidence,
    schedule: nextSchedule,
    samples: Object.freeze(nextSamples),
    appliedRevisionCount: 1,
    // The observation did not change; only the revised view did.
    observedChange: options.evidence.observedChange,
    revisedChange: observedChange(nextSamples),
  });
  validateTemporalEvidence(nextEvidence);
  return { evidence: nextEvidence, appliedRevision: revision, previousRevisionCount };
}

export function detectTemporalClockDrift(evidence: TemporalEvidence, expectedFingerprint: string): boolean {
  return evidence.clock.fingerprint !== expectedFingerprint;
}

export function detectDuplicateTemporalSamples(evidence: TemporalEvidence): boolean {
  // IDs identify observations, not their semantic content. A repeated schedule
  // position or sample meaning is duplicate evidence even when IDs differ.
  // A repeated VALUE at a different t is not: constant-state trajectories and
  // plateaus legitimately repeat values (#1282).
  const seenSemantics = new Set<string>();
  const seenPositions = new Set<string>();
  const seenIds = new Set<string>();
  for (const sample of evidence.samples) {
    if (seenIds.has(sample.id)) return true;
    seenIds.add(sample.id);
    const semanticKey = stableJson({ t: sample.t, unit: sample.unit, value: sample.value, label: sample.label });
    if (seenSemantics.has(semanticKey)) return true;
    seenSemantics.add(semanticKey);
    const positionKey = `${sample.unit}|${sample.t}`;
    if (seenPositions.has(positionKey)) return true;
    seenPositions.add(positionKey);
  }
  return false;
}

export function temporalEvidenceDigest(evidence: TemporalEvidence): string {
  const material = stableJson({
    schema: evidence.schema,
    schemaVersion: evidence.schemaVersion,
    artifactId: evidence.artifactId,
    thesisId: evidence.thesisId,
    principleId: evidence.principleId,
    contractVersion: evidence.contractVersion,
    projectionDigest: evidence.projectionDigest,
    clock: evidence.clock,
    schedule: evidence.schedule,
    samples: evidence.samples,
    revisions: evidence.revisions,
    appliedRevisionCount: evidence.appliedRevisionCount,
    observedChange: evidence.observedChange,
    ...(evidence.revisedChange ? { revisedChange: evidence.revisedChange } : {}),
  });
  return digest(material);
}
