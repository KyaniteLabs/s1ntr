import {
  validateControlRecipe,
  type ControlMapping,
  type ControlRecipe,
} from '../composition/ControlRecipe.js';

export const COMPOSITION_EVIDENCE_DIMENSIONS = [
  'technical',
  'creative',
  'taste',
  'cost',
  'latency',
  'reliability',
  'security',
  'complexity',
] as const;

export type CompositionEvidenceDimension =
  typeof COMPOSITION_EVIDENCE_DIMENSIONS[number];
export type EvidenceStatus = 'observed' | 'missing' | 'failed' | 'unavailable';
export type EvidenceDirection = 'higher-better' | 'lower-better' | 'target';

export interface CompositionEvidenceMeasure {
  dimension: CompositionEvidenceDimension;
  status: EvidenceStatus;
  value?: number;
  unit: string;
  direction: EvidenceDirection;
  baseline: number | null;
  sourceRef: string;
  missingReason?: string;
}

export interface LayerEvaluationInput {
  layerId: string;
  technicalValidity: number;
  contribution: number;
  compatibility: number;
  necessity: number;
}

export interface WholeWorkScores {
  coherence: number;
  technicalValidity: number;
  creativeQuality: number;
  tasteQuality: number;
}

export interface CouplingTrial {
  condition: 'baseline' | 'signal-mutation' | 'coupling-ablation';
  signalValue: number;
  targetValue: number;
  signalUnit: string;
  targetUnit: string;
  whole: WholeWorkScores;
}

export interface CompositionEvaluationAttempt {
  id: string;
  method: string;
  status: 'complete' | 'failed' | 'unavailable';
  reason?: string;
  mappingId?: string;
  layers?: LayerEvaluationInput[];
  trials?: CouplingTrial[];
  evidence?: CompositionEvidenceMeasure[];
}

export interface LayerEvaluation extends LayerEvaluationInput {
  verdict: 'PASS' | 'FAIL';
}

export interface WholeWorkEvaluation {
  condition: CouplingTrial['condition'];
  scores: WholeWorkScores;
  verdict: 'PASS' | 'FAIL';
}

export interface CompositionEvaluationChecks {
  layersEvaluatedIndependently: boolean;
  baselineWholePasses: boolean;
  baselineTargetMatchesMapping: boolean;
  mutationTargetMatchesMapping: boolean;
  mutationChangesTarget: boolean;
  mutationChangesWholeVerdict: boolean;
  ablationChangesTarget: boolean;
  ablationPreservesSignal: boolean;
  ablationChangesWholeVerdict: boolean;
  evidenceContractComplete: boolean;
  attemptBudgetHonored: boolean;
}

export interface CompositionEvaluationResult {
  recipeId: string;
  outcome: 'PASS' | 'FAIL' | 'RETRY_ALLOWED' | 'RESIDUAL';
  terminal: boolean;
  attempts: Array<{ id: string; method: string; status: CompositionEvaluationAttempt['status'] }>;
  layers: LayerEvaluation[];
  whole: WholeWorkEvaluation[];
  evidence: CompositionEvidenceMeasure[];
  checks: CompositionEvaluationChecks;
  residualReason?: string;
}

const SCORE_KEYS: Array<keyof WholeWorkScores> = [
  'coherence',
  'technicalValidity',
  'creativeQuality',
  'tasteQuality',
];

function assertScore(value: number, label: string): void {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`${label} must be between 0 and 1`);
  }
}

function wholeEvaluation(trial: CouplingTrial): WholeWorkEvaluation {
  for (const key of SCORE_KEYS) assertScore(trial.whole[key], `${trial.condition}.${key}`);
  const passesFloors = trial.whole.coherence >= 0.65
    && trial.whole.technicalValidity >= 0.5
    && trial.whole.creativeQuality >= 0.6
    && trial.whole.tasteQuality >= 0.6;
  return {
    condition: trial.condition,
    scores: { ...trial.whole },
    verdict: passesFloors ? 'PASS' : 'FAIL',
  };
}

function mappedValue(mapping: ControlMapping, signal: number): number {
  let value = signal * mapping.scale + mapping.offset;
  if (mapping.clamp) value = Math.min(mapping.clamp[1], Math.max(mapping.clamp[0], value));
  return value;
}

function validateAttempts(attempts: CompositionEvaluationAttempt[]): void {
  if (attempts.length < 1 || attempts.length > 2) {
    throw new Error('Composition evaluation requires one or two attempts');
  }
  const ids = new Set(attempts.map(attempt => attempt.id));
  const methods = new Set(attempts.map(attempt => attempt.method));
  if (ids.size !== attempts.length || attempts.some(attempt => !attempt.id || !attempt.method)) {
    throw new Error('Composition evaluation attempts must have distinct ids');
  }
  if (attempts.length === 2 && methods.size !== 2) {
    throw new Error('The second composition evaluation attempt must use a distinct method');
  }
  for (const attempt of attempts) {
    if (attempt.status !== 'complete' && !attempt.reason) {
      throw new Error(`Attempt ${attempt.id} must explain ${attempt.status} evidence`);
    }
    if (attempt.status !== 'complete' && !attempt.evidence) {
      throw new Error(`Attempt ${attempt.id} must retain unavailable evidence metadata`);
    }
    if (attempt.status !== 'complete') validateEvidence(attempt.evidence!);
  }
}

function validateEvidence(evidence: CompositionEvidenceMeasure[]): boolean {
  const dimensions = new Set(evidence.map(measure => measure.dimension));
  if (evidence.length !== COMPOSITION_EVIDENCE_DIMENSIONS.length
    || dimensions.size !== COMPOSITION_EVIDENCE_DIMENSIONS.length
    || COMPOSITION_EVIDENCE_DIMENSIONS.some(dimension => !dimensions.has(dimension))) {
    throw new Error('Composition evidence must contain every dimension exactly once');
  }
  for (const measure of evidence) {
    if (!measure.unit || !measure.direction || !measure.sourceRef) {
      throw new Error(`Evidence ${measure.dimension} lost unit, direction, or source`);
    }
    if (measure.status === 'observed') {
      if (!Number.isFinite(measure.value) || !Number.isFinite(measure.baseline)) {
        throw new Error(`Observed evidence ${measure.dimension} needs value and baseline`);
      }
    } else if (!measure.missingReason || measure.value !== undefined) {
      throw new Error(`Missing evidence ${measure.dimension} needs an explicit reason`);
    }
  }
  return evidence.every(measure => measure.status === 'observed');
}

function evaluateLayers(
  recipe: ControlRecipe,
  inputs: LayerEvaluationInput[],
): LayerEvaluation[] {
  const expected = new Set(recipe.layers.map(layer => layer.id));
  const ids = new Set(inputs.map(layer => layer.layerId));
  if (inputs.length !== expected.size
    || ids.size !== expected.size
    || [...expected].some(id => !ids.has(id))) {
    throw new Error('Every recipe layer must be evaluated exactly once');
  }
  return inputs.map(layer => {
    const scores = [
      layer.technicalValidity,
      layer.contribution,
      layer.compatibility,
      layer.necessity,
    ];
    scores.forEach(score => assertScore(score, `layer ${layer.layerId}`));
    return {
      ...layer,
      verdict: scores.every(score => score >= 0.6) ? 'PASS' : 'FAIL',
    };
  });
}

function evaluateTrials(trials: CouplingTrial[]): {
  byCondition: Map<CouplingTrial['condition'], CouplingTrial>;
  whole: WholeWorkEvaluation[];
} {
  const byCondition = new Map(trials.map(trial => [trial.condition, trial]));
  if (trials.length !== 3 || byCondition.size !== 3) {
    throw new Error('Coupling proof requires baseline, signal mutation, and ablation');
  }
  const units = new Set(trials.map(trial => `${trial.signalUnit}|${trial.targetUnit}`));
  if (units.size !== 1 || trials.some(trial =>
    !Number.isFinite(trial.signalValue) || !Number.isFinite(trial.targetValue))) {
    throw new Error('Coupling trials must retain finite values and matching units');
  }
  return { byCondition, whole: trials.map(wholeEvaluation) };
}

function blankChecks(attemptBudgetHonored: boolean): CompositionEvaluationChecks {
  return {
    layersEvaluatedIndependently: false,
    baselineWholePasses: false,
    baselineTargetMatchesMapping: false,
    mutationTargetMatchesMapping: false,
    mutationChangesTarget: false,
    mutationChangesWholeVerdict: false,
    ablationChangesTarget: false,
    ablationPreservesSignal: false,
    ablationChangesWholeVerdict: false,
    evidenceContractComplete: false,
    attemptBudgetHonored,
  };
}

export class CompositionEvaluator {
  evaluate(
    recipe: ControlRecipe,
    attempts: CompositionEvaluationAttempt[],
  ): CompositionEvaluationResult {
    validateControlRecipe(recipe);
    validateAttempts(attempts);
    const attemptSummaries = attempts.map(({ id, method, status }) => ({ id, method, status }));
    const latest = attempts.at(-1)!;
    if (latest.status !== 'complete') {
      const terminal = attempts.length === 2;
      return {
        recipeId: recipe.id,
        outcome: terminal ? 'RESIDUAL' : 'RETRY_ALLOWED',
        terminal,
        attempts: attemptSummaries,
        layers: [],
        whole: [],
        evidence: latest.evidence!,
        checks: blankChecks(true),
        residualReason: latest.reason,
      };
    }
    if (!latest.mappingId || !latest.layers || !latest.trials || !latest.evidence) {
      throw new Error(`Complete attempt ${latest.id} is missing evaluation evidence`);
    }
    const mapping = recipe.mappings.find(candidate => candidate.id === latest.mappingId);
    if (!mapping) throw new Error(`Unknown control mapping: ${latest.mappingId}`);
    const signal = recipe.signals.find(port => port.id === mapping.signalId);
    const target = recipe.targets.find(port => port.id === mapping.targetId);
    if (signal?.type !== 'number' || target?.type !== 'number') {
      throw new Error('Coupling proof requires a numeric signal and target');
    }
    return this.evaluateComplete(
      recipe,
      latest,
      mapping,
      attemptSummaries,
    );
  }

  private evaluateComplete(
    recipe: ControlRecipe,
    attempt: CompositionEvaluationAttempt & {
      layers?: LayerEvaluationInput[];
      trials?: CouplingTrial[];
      evidence?: CompositionEvidenceMeasure[];
    },
    mapping: ControlMapping,
    attempts: CompositionEvaluationResult['attempts'],
  ): CompositionEvaluationResult {
    const layers = evaluateLayers(recipe, attempt.layers!);
    const { byCondition, whole } = evaluateTrials(attempt.trials!);
    const baseline = byCondition.get('baseline')!;
    const mutation = byCondition.get('signal-mutation')!;
    const ablation = byCondition.get('coupling-ablation')!;
    const wholeByCondition = new Map(whole.map(item => [item.condition, item]));
    const baselineWhole = wholeByCondition.get('baseline')!;
    const mutationWhole = wholeByCondition.get('signal-mutation')!;
    const ablationWhole = wholeByCondition.get('coupling-ablation')!;
    const tolerance = 1e-9;
    const evidenceComplete = validateEvidence(attempt.evidence!);
    const checks: CompositionEvaluationChecks = {
      layersEvaluatedIndependently: layers.every(layer => layer.verdict === 'PASS'),
      baselineWholePasses: baselineWhole.verdict === 'PASS',
      baselineTargetMatchesMapping:
        Math.abs(baseline.targetValue - mappedValue(mapping, baseline.signalValue)) <= tolerance,
      mutationTargetMatchesMapping:
        Math.abs(mutation.targetValue - mappedValue(mapping, mutation.signalValue)) <= tolerance,
      mutationChangesTarget: Math.abs(mutation.targetValue - baseline.targetValue) > tolerance,
      mutationChangesWholeVerdict: mutationWhole.verdict !== baselineWhole.verdict,
      ablationChangesTarget: Math.abs(ablation.targetValue - baseline.targetValue) > tolerance,
      ablationPreservesSignal: Math.abs(ablation.signalValue - baseline.signalValue) <= tolerance,
      ablationChangesWholeVerdict: ablationWhole.verdict !== baselineWhole.verdict,
      evidenceContractComplete: evidenceComplete,
      attemptBudgetHonored: attempts.length <= 2,
    };
    const outcome = Object.values(checks).every(Boolean) ? 'PASS' : 'FAIL';
    return {
      recipeId: recipe.id,
      outcome,
      terminal: true,
      attempts,
      layers,
      whole,
      evidence: attempt.evidence!,
      checks,
    };
  }
}
