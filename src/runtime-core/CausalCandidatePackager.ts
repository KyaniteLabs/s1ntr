import { createHash } from 'node:crypto';
import {
  assertReviewedCandidate,
  type ReviewedAutoresearchResult,
} from './SealedIndependentReview.js';
import type { RecursiveExperimentContract } from './RecursiveImprovementContract.js';

export const CAUSAL_CANDIDATE_SCHEMA_VERSION = 1 as const;

export interface FrozenTrialConfiguration {
  intentDigest: string;
  provider: string;
  model: string;
  promptDigest: string;
  parametersDigest: string;
  capabilitiesDigest: string;
  evaluatorDigest: string;
  environmentDigest: string;
  seedSupported: boolean;
}

export interface MetricFloor {
  minimum?: number;
  maximum?: number;
}

export interface CausalDecisionRule {
  objective: string;
  direction: 'higher-better' | 'lower-better';
  minimumEffect: number;
  minimumTrials: number;
  hardFloors: Record<string, MetricFloor>;
}

export interface CausalTrialPair {
  trialId: string;
  seed?: string;
  controlConfigurationDigest: string;
  treatmentConfigurationDigest: string;
  controlArtifactDigest: string;
  treatmentArtifactDigest: string;
  controlMetrics: Record<string, number>;
  treatmentMetrics: Record<string, number>;
}

export interface CausalAnalysis {
  objective: string;
  controlMean: number;
  treatmentMean: number;
  trialEffects: number[];
  meanEffect: number;
  sampleVariance: number;
  hardFloorsPass: boolean;
  improved: boolean;
}

export interface CandidateDiffEvidence {
  paths: string[];
  digest: string;
}

export interface CausalCandidateInput {
  contract: RecursiveExperimentContract;
  candidate: ReviewedAutoresearchResult;
  restoredFailure: ReviewedAutoresearchResult;
  configuration: FrozenTrialConfiguration;
  decisionRule: CausalDecisionRule;
  trials: CausalTrialPair[];
  diff: CandidateDiffEvidence;
  verificationRefs: string[];
  artifactComparisonRefs: string[];
}

export interface OwnerControlledCandidate {
  schemaVersion: typeof CAUSAL_CANDIDATE_SCHEMA_VERSION;
  candidateId: string;
  experimentId: string;
  lineageId: string;
  status: 'awaiting-owner';
  allowedAction: 'request-owner-merge';
  author: ReviewedAutoresearchResult['review']['author'];
  reviewer: ReviewedAutoresearchResult['review']['reviewer'];
  reviewReceiptDigest: string;
  restoredFailureExperimentId: string;
  configuration: FrozenTrialConfiguration;
  decisionRule: CausalDecisionRule;
  analysis: CausalAnalysis;
  trials: CausalTrialPair[];
  diff: CandidateDiffEvidence;
  verificationRefs: string[];
  artifactComparisonRefs: string[];
  receiptDigest: string;
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map(key => (
      `${JSON.stringify(key)}:${stable(record[key])}`
    )).join(',')}}`;
  }
  return JSON.stringify(value);
}

function digest(value: unknown): string {
  return createHash('sha256').update(stable(value)).digest('hex');
}

export function fingerprintTrialConfiguration(
  configuration: FrozenTrialConfiguration,
): string {
  validateConfiguration(configuration);
  return digest(configuration);
}

function requireDigest(value: string, field: string): void {
  if (!/^[a-f0-9]{64}$/.test(value)) {
    throw new Error(`CAUSAL_CANDIDATE_INVALID_DIGEST:${field}`);
  }
}

function requireRefs(value: readonly string[], field: string): void {
  if (value.length === 0 || value.some(ref => !ref.trim())) {
    throw new Error(`CAUSAL_CANDIDATE_EVIDENCE_MISSING:${field}`);
  }
}

function validateConfiguration(configuration: FrozenTrialConfiguration): void {
  for (const field of [
    'intentDigest', 'promptDigest', 'parametersDigest', 'capabilitiesDigest',
    'evaluatorDigest', 'environmentDigest',
  ] as const) {
    requireDigest(configuration[field], field);
  }
  if (!configuration.provider.trim() || !configuration.model.trim()) {
    throw new Error('CAUSAL_CANDIDATE_IDENTITY_UNKNOWN');
  }
}

function validateDecisionRule(rule: CausalDecisionRule): void {
  if (
    !rule.objective.trim()
    || !Number.isFinite(rule.minimumEffect)
    || !Number.isInteger(rule.minimumTrials)
    || rule.minimumTrials < 3
    || Object.keys(rule.hardFloors).length === 0
  ) {
    throw new Error('CAUSAL_CANDIDATE_DECISION_RULE_INVALID');
  }
  for (const [metric, floor] of Object.entries(rule.hardFloors)) {
    if (
      !metric.trim()
      || (floor.minimum === undefined && floor.maximum === undefined)
      || [floor.minimum, floor.maximum].some(value => (
        value !== undefined && !Number.isFinite(value)
      ))
    ) {
      throw new Error(`CAUSAL_CANDIDATE_FLOOR_INVALID:${metric}`);
    }
  }
}

function validateTrials(
  input: Pick<CausalCandidateInput, 'configuration' | 'decisionRule' | 'trials'>,
): void {
  if (input.trials.length < input.decisionRule.minimumTrials) {
    throw new Error('CAUSAL_CANDIDATE_TRIALS_INSUFFICIENT');
  }
  const configurationDigest = fingerprintTrialConfiguration(input.configuration);
  const ids = new Set<string>();
  const seeds = new Set<string>();
  for (const trial of input.trials) {
    if (!trial.trialId.trim() || ids.has(trial.trialId)) {
      throw new Error('CAUSAL_CANDIDATE_TRIAL_ID_INVALID');
    }
    ids.add(trial.trialId);
    if (input.configuration.seedSupported) {
      if (!trial.seed?.trim() || seeds.has(trial.seed)) {
        throw new Error('CAUSAL_CANDIDATE_SEED_INVALID');
      }
      seeds.add(trial.seed);
    }
    if (
      trial.controlConfigurationDigest !== configurationDigest
      || trial.treatmentConfigurationDigest !== configurationDigest
    ) {
      throw new Error('CAUSAL_CANDIDATE_CONFIGURATION_MISMATCH');
    }
    requireDigest(trial.controlArtifactDigest, `${trial.trialId}.controlArtifact`);
    requireDigest(trial.treatmentArtifactDigest, `${trial.trialId}.treatmentArtifact`);
    const requiredMetrics = [
      input.decisionRule.objective,
      ...Object.keys(input.decisionRule.hardFloors),
    ];
    for (const metric of requiredMetrics) {
      const values = [trial.controlMetrics[metric], trial.treatmentMetrics[metric]];
      if (values.some(value => typeof value !== 'number' || !Number.isFinite(value))) {
        throw new Error(`CAUSAL_CANDIDATE_METRIC_MISSING:${trial.trialId}:${metric}`);
      }
    }
  }
}

function floorPasses(
  metrics: Record<string, number>,
  floors: Record<string, MetricFloor>,
): boolean {
  return Object.entries(floors).every(([metric, floor]) => {
    const value = metrics[metric];
    return Number.isFinite(value)
      && (floor.minimum === undefined || value >= floor.minimum)
      && (floor.maximum === undefined || value <= floor.maximum);
  });
}

function analyze(
  input: Pick<CausalCandidateInput, 'decisionRule' | 'trials'>,
): CausalAnalysis {
  const objective = input.decisionRule.objective;
  const direction = input.decisionRule.direction === 'higher-better' ? 1 : -1;
  const controls = input.trials.map(trial => trial.controlMetrics[objective]);
  const treatments = input.trials.map(trial => trial.treatmentMetrics[objective]);
  const effects = treatments.map((value, index) => (
    direction * (value - controls[index])
  ));
  const meanEffect = effects.reduce((sum, value) => sum + value, 0) / effects.length;
  const sampleVariance = effects.reduce((sum, value) => (
    sum + ((value - meanEffect) ** 2)
  ), 0) / (effects.length - 1);
  const hardFloorsPass = input.trials.every(trial =>
    floorPasses(trial.treatmentMetrics, input.decisionRule.hardFloors));
  return {
    objective,
    controlMean: controls.reduce((sum, value) => sum + value, 0) / controls.length,
    treatmentMean: treatments.reduce((sum, value) => sum + value, 0) / treatments.length,
    trialEffects: effects,
    meanEffect,
    sampleVariance,
    hardFloorsPass,
    improved: meanEffect >= input.decisionRule.minimumEffect && hardFloorsPass,
  };
}

function validateDiff(input: CausalCandidateInput): void {
  requireRefs(input.diff.paths, 'diff.paths');
  requireDigest(input.diff.digest, 'diff.digest');
  const declared = new Set(input.diff.paths);
  const changed = new Set(input.candidate.experiment.changedPaths);
  if (
    changed.size === 0
    || declared.size !== changed.size
    || [...changed].some(path => !declared.has(path))
  ) {
    throw new Error('CAUSAL_CANDIDATE_DIFF_UNBOUNDED');
  }
}

export function packageOwnerControlledCandidate(
  input: CausalCandidateInput,
): OwnerControlledCandidate {
  assertReviewedCandidate(
    input.contract,
    input.candidate.experiment,
    input.candidate.review,
  );
  if (
    input.restoredFailure.experiment.terminal !== 'restored'
    || input.restoredFailure.review.verdict !== 'veto'
    || !input.restoredFailure.experiment.failure?.quarantined
  ) {
    throw new Error('CAUSAL_CANDIDATE_RESTORE_PROOF_MISSING');
  }
  validateConfiguration(input.configuration);
  validateDecisionRule(input.decisionRule);
  validateTrials(input);
  validateDiff(input);
  requireRefs(input.verificationRefs, 'verificationRefs');
  requireRefs(input.artifactComparisonRefs, 'artifactComparisonRefs');
  const analysis = analyze(input);
  if (!analysis.improved) {
    throw new Error(analysis.hardFloorsPass
      ? 'CAUSAL_CANDIDATE_EFFECT_INSUFFICIENT'
      : 'CAUSAL_CANDIDATE_HARD_FLOOR_REGRESSION');
  }
  const unsigned = {
    schemaVersion: CAUSAL_CANDIDATE_SCHEMA_VERSION,
    candidateId: `candidate:${input.candidate.experiment.experimentId}`,
    experimentId: input.candidate.experiment.experimentId,
    lineageId: input.candidate.experiment.lineageId,
    status: 'awaiting-owner' as const,
    allowedAction: 'request-owner-merge' as const,
    author: { ...input.candidate.review.author },
    reviewer: { ...input.candidate.review.reviewer },
    reviewReceiptDigest: input.candidate.review.receiptDigest,
    restoredFailureExperimentId: input.restoredFailure.experiment.experimentId,
    configuration: structuredClone(input.configuration),
    decisionRule: structuredClone(input.decisionRule),
    analysis,
    trials: structuredClone(input.trials),
    diff: structuredClone(input.diff),
    verificationRefs: [...input.verificationRefs],
    artifactComparisonRefs: [...input.artifactComparisonRefs],
  };
  return { ...unsigned, receiptDigest: digest(unsigned) };
}

export function parseOwnerControlledCandidate(value: unknown): OwnerControlledCandidate {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('INVALID_CAUSAL_CANDIDATE: package must be an object');
  }
  const candidate = value as OwnerControlledCandidate;
  if (
    candidate.schemaVersion !== CAUSAL_CANDIDATE_SCHEMA_VERSION
    || candidate.status !== 'awaiting-owner'
    || candidate.allowedAction !== 'request-owner-merge'
    || !candidate.analysis?.improved
    || !candidate.analysis.hardFloorsPass
  ) {
    throw new Error('INVALID_CAUSAL_CANDIDATE: state or analysis invalid');
  }
  const { receiptDigest, ...unsigned } = candidate;
  if (!receiptDigest || digest(unsigned) !== receiptDigest) {
    throw new Error('INVALID_CAUSAL_CANDIDATE: digest mismatch');
  }
  validateConfiguration(candidate.configuration);
  validateDecisionRule(candidate.decisionRule);
  validateTrials(candidate);
  requireRefs(candidate.diff.paths, 'diff.paths');
  requireDigest(candidate.diff.digest, 'diff.digest');
  requireRefs(candidate.verificationRefs, 'verificationRefs');
  requireRefs(candidate.artifactComparisonRefs, 'artifactComparisonRefs');
  if (stable(analyze(candidate)) !== stable(candidate.analysis)) {
    throw new Error('INVALID_CAUSAL_CANDIDATE: analysis does not match trials');
  }
  return candidate;
}
