/**
 * PolicyExperimentRunner — Phase 16
 *
 * Runs A/B experiments on garden policies (critic prompts,
 * descriptor definitions, replay weights, loop-mix allocations).
 * Compares experiment branch against control using held-out metrics.
 *
 * Diagnostic only: `confidence` is 1 − a two-sided Welch/normal-approximation
 * p-value on a single metric. It is not a promotion decision; promotion goes
 * through the acceptance/search methodology (#1286).
 */

export type PolicyKind = 'critic-prompt' | 'descriptor-weights' | 'replay-bias' | 'loop-mix' | 'taste-model';

export interface PolicyVariant {
  id: string;
  kind: PolicyKind;
  label: string;
  config: Record<string, number>;
}

export interface ExperimentResult {
  variantId: string;
  metric: string;
  value: number;
  sampleSize: number;
  confidence: number;
}

export interface ExperimentOutcome {
  experimentId: string;
  control: PolicyVariant;
  treatment: PolicyVariant;
  controlResults: ExperimentResult[];
  treatmentResults: ExperimentResult[];
  winner: 'control' | 'treatment' | 'inconclusive';
  confidence: number;
  recommendation: string;
}

export interface PolicyExperimentRunnerConfig {
  /** Minimum samples per variant before declaring a winner (default: 10) */
  minSamples?: number;
  /** Confidence (1 − p) needed to report a leader (default: 0.7) */
  confidenceThreshold?: number;
}

export class PolicyExperimentRunner {
  private readonly minSamples: number;
  private readonly confidenceThreshold: number;
  private readonly experiments = new Map<string, { control: PolicyVariant; treatment: PolicyVariant }>();
  private readonly results = new Map<string, { control: ExperimentResult[]; treatment: ExperimentResult[] }>();
  private readonly metrics = new Map<string, string>();
  private experimentCount = 0;

  constructor(config: PolicyExperimentRunnerConfig = {}) {
    this.minSamples = config.minSamples ?? 10;
    this.confidenceThreshold = config.confidenceThreshold ?? 0.7;
  }

  /**
   * Create a new A/B experiment.
   */
  createExperiment(control: PolicyVariant, treatment: PolicyVariant): string {
    if (control.id === treatment.id) {
      throw new Error('PolicyExperimentRunner: control and treatment must have distinct ids');
    }
    const id = `experiment-${++this.experimentCount}`;
    this.experiments.set(id, { control, treatment });
    this.results.set(id, { control: [], treatment: [] });
    return id;
  }

  /**
   * Record a result for a variant. Fails closed on an unknown experiment or
   * variant, a non-finite value, or a metric other than the experiment's first.
   */
  recordResult(experimentId: string, variantId: string, metric: string, value: number): void {
    const data = this.results.get(experimentId);
    const experiment = this.experiments.get(experimentId);
    if (!data || !experiment) {
      throw new Error(`PolicyExperimentRunner: unknown experiment ${experimentId}`);
    }
    if (variantId !== experiment.control.id && variantId !== experiment.treatment.id) {
      throw new Error(`PolicyExperimentRunner: unknown variant ${variantId} for ${experimentId}`);
    }
    if (!Number.isFinite(value)) {
      throw new Error('PolicyExperimentRunner: metric value must be finite');
    }
    const expectedMetric = this.metrics.get(experimentId) ?? metric;
    if (metric !== expectedMetric) {
      throw new Error(
        `PolicyExperimentRunner: ${experimentId} measures "${expectedMetric}"; refusing to mix in "${metric}"`,
      );
    }
    this.metrics.set(experimentId, expectedMetric);

    const entry: ExperimentResult = {
      variantId,
      metric,
      value,
      sampleSize: 1,
      confidence: 0,
    };

    if (variantId === experiment.control.id) {
      data.control.push(entry);
    } else {
      data.treatment.push(entry);
    }
  }

  /**
   * Evaluate experiment: compare treatment vs control.
   */
  evaluate(experimentId: string): ExperimentOutcome | null {
    const experiment = this.experiments.get(experimentId);
    const data = this.results.get(experimentId);
    if (!experiment || !data) return null;

    const controlAvg = this.averageMetric(data.control);
    const treatmentAvg = this.averageMetric(data.treatment);

    const controlN = data.control.length;
    const treatmentN = data.treatment.length;

    if (controlN < this.minSamples || treatmentN < this.minSamples) {
      return {
        experimentId,
        control: experiment.control,
        treatment: experiment.treatment,
        controlResults: data.control,
        treatmentResults: data.treatment,
        winner: 'inconclusive',
        confidence: 0,
        recommendation: `Need at least ${this.minSamples} samples per variant (control: ${controlN}, treatment: ${treatmentN})`,
      };
    }

    // Uncertainty-aware: Welch standard error, two-sided normal approximation.
    const diff = treatmentAvg - controlAvg;
    const standardError = Math.sqrt(
      sampleVariance(data.control, controlAvg) / controlN
      + sampleVariance(data.treatment, treatmentAvg) / treatmentN,
    );
    const pValue = diff === 0 ? 1
      : standardError === 0 ? 0
      : 2 * (1 - normalCdf(Math.abs(diff) / standardError));
    const confidence = 1 - pValue;

    let winner: 'control' | 'treatment' | 'inconclusive';
    if (confidence >= this.confidenceThreshold) {
      winner = diff > 0 ? 'treatment' : 'control';
    } else {
      winner = 'inconclusive';
    }

    const recommendation = winner === 'treatment'
      ? `Treatment "${experiment.treatment.label}" leads by ${diff.toFixed(4)} (p≈${pValue.toFixed(4)}); diagnostic only — promotion requires acceptance review`
      : winner === 'control'
        ? `Keep control "${experiment.control.label}" — treatment did not improve (p≈${pValue.toFixed(4)})`
        : 'Insufficient evidence to decide; continue sampling';

    return {
      experimentId,
      control: experiment.control,
      treatment: experiment.treatment,
      controlResults: data.control,
      treatmentResults: data.treatment,
      winner,
      confidence,
      recommendation,
    };
  }

  /**
   * Get all active experiment IDs.
   */
  getActiveExperiments(): string[] {
    return [...this.experiments.keys()];
  }

  getExperimentCount(): number {
    return this.experimentCount;
  }

  private averageMetric(results: ExperimentResult[]): number {
    if (results.length === 0) return 0;
    return results.reduce((s, r) => s + r.value, 0) / results.length;
  }
}

function sampleVariance(results: ExperimentResult[], mean: number): number {
  if (results.length < 2) return 0;
  return results.reduce((sum, r) => sum + (r.value - mean) ** 2, 0) / (results.length - 1);
}

/** Standard normal CDF (Abramowitz–Stegun 7.1.26 erf approximation, |error| < 1.5e-7). */
function normalCdf(z: number): number {
  const x = Math.abs(z) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * x);
  const poly = ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t;
  const erf = 1 - poly * Math.exp(-x * x);
  return z >= 0 ? 0.5 * (1 + erf) : 0.5 * (1 - erf);
}
