/**
 * Fail-closed promotion gate. A candidate (staged snapshot, retrieval set, ...) replaces the incumbent only
 * when its first-attempt score gain on the SCHEDULED prompts is at least a predeclared margin AND the paired
 * bootstrap 95% lower bound of the mean gain is above zero. Everything else leaves the incumbent live:
 * failed or missing prompts score 0 (never dropped), and any malformed input is an error, not a pass.
 */
export interface ArmScores { readonly [promptId: string]: number | null | undefined }

export interface GateOptions {
  /** Predeclared minimum mean paired gain to promote. */
  readonly minGain: number;
  readonly resamples?: number;
  readonly seed?: number;
  /** Fewest scheduled prompts that can support a promotion (default 8). */
  readonly minScheduled?: number;
  /** Largest tolerated share of incumbent attempts without a valid score (default 0.25). */
  readonly maxIncumbentFailureRate?: number;
}

export type GateDecision = 'promote' | 'keep-incumbent' | 'error';
export interface GateVerdict {
  readonly decision: GateDecision;
  readonly reason: string;
  readonly scheduled: number;
  readonly meanGain: number;
  readonly lowerBound95: number;
  readonly incumbentFailures: number;
  readonly candidateFailures: number;
}

export const DEFAULT_MIN_GAIN = 0.03;
export const DEFAULT_MIN_SCHEDULED = 8;
export const DEFAULT_MAX_INCUMBENT_FAILURE_RATE = 0.25;

const mulberry32 = (seed: number): (() => number) => {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

const isScore = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;

const fail = (reason: string, scheduled = 0): GateVerdict => ({ decision: 'error', reason, scheduled,
  meanGain: 0, lowerBound95: 0, incumbentFailures: 0, candidateFailures: 0 });

export function promotionGate(scheduled: readonly string[], incumbent: ArmScores,
  candidate: ArmScores, options: GateOptions): GateVerdict {
  if (!Array.isArray(scheduled) || scheduled.length === 0
    || new Set(scheduled).size !== scheduled.length) return fail('GATE_SCHEDULE_INVALID');
  if (!Number.isFinite(options.minGain) || options.minGain <= 0) return fail('GATE_MIN_GAIN_INVALID', scheduled.length);
  if (!incumbent || !candidate || typeof incumbent !== 'object' || typeof candidate !== 'object') {
    return fail('GATE_SCORES_MISSING', scheduled.length);
  }
  let incumbentFailures = 0;
  let candidateFailures = 0;
  const deltas = scheduled.map(id => {
    const before = incumbent[id];
    const after = candidate[id];
    if (!isScore(before)) incumbentFailures += 1;
    if (!isScore(after)) candidateFailures += 1;
    return (isScore(after) ? after : 0) - (isScore(before) ? before : 0);
  });
  const n = deltas.length;
  if (n < (options.minScheduled ?? DEFAULT_MIN_SCHEDULED)) return fail('GATE_SCHEDULE_TOO_SMALL', n);
  // An incumbent that did not run is "unavailable", not "bad": any candidate would beat it, and that proves nothing.
  if (incumbentFailures / n > (options.maxIncumbentFailureRate ?? DEFAULT_MAX_INCUMBENT_FAILURE_RATE)) {
    return { ...fail('GATE_INCUMBENT_UNAVAILABLE', n), incumbentFailures, candidateFailures };
  }
  const meanGain = deltas.reduce((sum, d) => sum + d, 0) / n;
  const random = mulberry32(options.seed ?? 20261118);
  const resamples = options.resamples ?? 2000;
  const means: number[] = [];
  for (let r = 0; r < resamples; r += 1) {
    let sum = 0;
    for (let i = 0; i < n; i += 1) sum += deltas[Math.floor(random() * n)]!;
    means.push(sum / n);
  }
  means.sort((a, b) => a - b);
  const lowerBound95 = means[Math.floor(0.025 * resamples)]!;
  const base = { scheduled: n, meanGain, lowerBound95, incumbentFailures, candidateFailures };
  if (meanGain < options.minGain) return { decision: 'keep-incumbent', reason: 'GAIN_BELOW_PREDECLARED_MARGIN', ...base };
  if (!(lowerBound95 > 0)) return { decision: 'keep-incumbent', reason: 'LOWER_BOUND_NOT_ABOVE_ZERO', ...base };
  return { decision: 'promote', reason: 'GAIN_AND_LOWER_BOUND_CLEAR', ...base };
}
