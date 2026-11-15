export { DreamQueue } from './DreamQueue.js';
export type { DreamStrategy, DreamTask, DreamTaskKind, DreamQueueConfig } from './DreamQueue.js';
export { buildDreamTaskPrompt, buildGovernedDreamRequest,
  GovernedDreamTaskRunner, runNextDreamTask } from './DreamTaskRunner.js';
export type {
  DreamAssimilationGovernance,
  DreamAssimilationRunner,
  DreamCampaignAdmission,
  DreamCampaignAdmissionBoundary,
  DreamTaskClaimPersistence,
  DurableDreamTaskClaim,
  DreamTaskConsumer,
  DreamTaskRunResult,
} from './DreamTaskRunner.js';
export { mutateCompositionRecipe } from './CompositionRecipeMutator.js';
export { runNextCompositionDream } from './CompositionDreamRunner.js';
export type {
  CompositionDreamCognitiveSink,
  CompositionDreamEvidenceProvider,
  CompositionDreamRunResult,
} from './CompositionDreamRunner.js';
export { CompositionDreamCognitiveAdapter } from './CompositionDreamCognitiveAdapter.js';
export type {
  CompositionDreamMutation,
  CompositionDreamProvenance,
  CompositionDreamPlan,
  CompositionDreamRecord,
  DreamFailureRecord,
} from './CompositionDreamTypes.js';
export { DreamPlanner } from './DreamPlanner.js';
export type { DreamPlan, DreamPlannerConfig } from './DreamPlanner.js';
export { RecombinationEngine } from './RecombinationEngine.js';
export type { RecombinationResult, RecombinationStrategy, RecombinationConfig } from './RecombinationEngine.js';
export * from './research/index.js';
