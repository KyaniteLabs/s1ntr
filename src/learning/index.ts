/**
 * Learning module - Persistent quality archive with few-shot prompting
 */

export { ArchiveLearning } from './ArchiveLearning.js';
export type { ArchiveConfig, ArchivedItem } from './ArchiveLearning.js';

export { QualityArchive } from './QualityArchive.js';
export type {
  ArchiveQueryOptions,
  ArchiveEntry,
  QualityArchiveConfig,
} from './QualityArchive.js';

export { PreferenceEventLogger } from './PreferenceEventLogger.js';
export { NimaService, scoreImage, isValidNimaScore } from './NimaService.js';
export type { NimaResult, NimaBatchResult } from './NimaService.js';
export type { NimaScorer } from './TasteLearningService.js';
export { createCreativeLabelAdmission, isCreativeLabelAdmitted,
  validateCreativeLabelAdmission } from './CreativeLabelAdmission.js';
export type { CreativeLabelAdmission, CreativeLabelTrustKind,
  CreativeLabelUse } from './CreativeLabelAdmission.js';
export { TasteLearningService } from './TasteLearningService.js';
export type { TasteLearningRecordResult, TasteTrainingSummary, NimaEnrichmentReport } from './TasteLearningService.js';

// Phase 15 — Taste Learning
export { PreferenceDatasetBuilder } from './PreferenceDatasetBuilder.js';
export type { PreferencePair, PreferenceChannel, PreferenceDataset, PreferenceDatasetBuilderConfig } from './PreferenceDatasetBuilder.js';
export { TasteModelTrainer } from './TasteModelTrainer.js';
export type { TasteModelWeights, TasteModelTrainerConfig } from './TasteModelTrainer.js';
export { TasteModelRuntime } from './TasteModelRuntime.js';
export type { RankedCandidate } from './TasteModelRuntime.js';
export { TasteModelEvaluator, splitEntriesByRoot, lineageRootOf } from './TasteModelEvaluator.js';
export type { TasteEvaluationResult, TasteModelEvaluatorConfig } from './TasteModelEvaluator.js';
export { ReplayBiasPolicy } from './ReplayBiasPolicy.js';
export type { ReplayBiasConfig } from './ReplayBiasPolicy.js';
export {
  candidateSetDigest,
  learnCreativeJudgment,
  loadCreativeJudgmentProfile,
  persistCreativeJudgmentProfile,
  scoreCreativeJudgment,
  validateCreativeJudgmentProfile,
} from './CreativeJudgmentCalibration.js';
export { compareRenderedJudgment } from './RenderedJudgmentComparison.js';
export type {
  CreativeJudgmentComparison,
  CreativeJudgmentProfile,
} from './CreativeJudgmentCalibration.js';
export type {
  RenderedComparisonCandidate,
  RenderedJudgmentComparison,
} from './RenderedJudgmentComparison.js';
