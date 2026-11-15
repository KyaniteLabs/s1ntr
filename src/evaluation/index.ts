/**
 * Evaluation Module — Phase 11 Increment 4
 *
 * Unified evaluation pipeline combining code scoring with aesthetic critique.
 */

// Types
export type {
  EvaluationCandidate,
  ConfidenceDimension,
  AgreementLevel,
  ConfidenceReport,
  HybridWeights,
  HybridJudgment,
  GoldenCase,
  GoldenSuite,
  GoldenCaseResult,
  GoldenSuiteResult,
  EvaluationFabricResult,
  EvaluationFabricConfig,
} from './types.js';

// Confidence synthesis
export { synthesize, isTrustworthy } from './ConfidenceSynthesizer.js';

// Hybrid judge
export { HybridJudge } from './HybridJudge.js';

// Orchestrator
export { EvaluationFabric } from './EvaluationFabric.js';

// Emergence scorecard
export { EmergenceScorecard } from './EmergenceScorecard.js';

// Domain-general whole/layer/coupling evaluation.
export {
  CompositionEvaluator,
  COMPOSITION_EVIDENCE_DIMENSIONS,
  type CompositionEvidenceDimension,
  type EvidenceStatus,
  type EvidenceDirection,
  type CompositionEvidenceMeasure,
  type LayerEvaluationInput,
  type WholeWorkScores,
  type CouplingTrial,
  type CompositionEvaluationAttempt,
  type LayerEvaluation,
  type WholeWorkEvaluation,
  type CompositionEvaluationChecks,
  type CompositionEvaluationResult,
} from './CompositionEvaluator.js';

