import { createHash } from 'node:crypto';
import type { CompositionEvaluationResult } from '../evaluation/CompositionEvaluator.js';
import type {
  CompositionDreamRecord,
  DreamFailureRecord,
} from '../dreaming/CompositionDreamTypes.js';
import type { ConsolidatedHypothesis } from '../intuition/EvidenceConsolidationCoordinator.js';
import type { AutoresearchExperimentResult } from './AutoresearchExperimentRunner.js';
import type { ExperimentBudgets } from './RecursiveImprovementContract.js';
import {
  SEALED_REVIEW_READ_ONLY_TOOLS,
  type ReviewedAutoresearchResult,
} from './SealedIndependentReview.js';
import {
  fingerprintTrialConfiguration,
  parseOwnerControlledCandidate,
  type OwnerControlledCandidate,
} from './CausalCandidatePackager.js';
import {
  evaluateDomainIncubator,
  parseDomainIncubationRecommendation,
  parseEvaluatedDomainIncubation,
  type DomainIncubationRecommendation,
  type EvaluatedDomainIncubation,
} from './DomainIncubator.js';
import {
  ASSIMILATION_ROLES,
  fingerprintAuditionSlice,
  parseRoleModelAssimilationReport,
  type RoleModelAssimilationReport,
} from './RoleModelAssimilator.js';
import {
  type LivingLoopCheckpoint,
  type LivingLoopDryRun,
} from '../cortex/CortexLivingLoop.js';

export const W5_MEMORY_FEED_FORWARD_SCHEMA_VERSION = 1 as const;
export const W5_COMPOSITION_EVALUATION_SCHEMA_VERSION = 1 as const;
export const W5_COMPOSITION_DREAM_SCHEMA_VERSION = 1 as const;
export const W5_EVIDENCE_CONSOLIDATION_SCHEMA_VERSION = 1 as const;
export const W5_AUTORESEARCH_EXPERIMENT_SCHEMA_VERSION = 1 as const;
export const W5_SEALED_REVIEW_SCHEMA_VERSION = 1 as const;
export const W5_CAUSAL_CANDIDATE_SCHEMA_VERSION = 1 as const;
export const W5_DOMAIN_INCUBATION_SCHEMA_VERSION = 1 as const;
export const W5_MODEL_ASSIMILATION_SCHEMA_VERSION = 1 as const;
export const W5_CORTEX_CYCLE_SCHEMA_VERSION = 1 as const;

export interface MemoryFeedForwardCondition {
  lineageId: string;
  sessionId: string;
  contextDigest: string;
  requestDigest: string;
  artifactDigest: string;
  injected: boolean;
  sourceEpisodeIds: string[];
  tainted: boolean;
}

export interface MemoryFeedForwardChecks {
  controlUninjected: boolean;
  treatmentInjected: boolean;
  exactDigestStamped: boolean;
  sourceLinked: boolean;
  requestChanged: boolean;
  downstreamChanged: boolean;
  taintPreserved: boolean;
}

export interface MemoryFeedForwardGateReceipt {
  schemaVersion: typeof W5_MEMORY_FEED_FORWARD_SCHEMA_VERSION;
  gate: 'W5-03';
  outcome: 'PASS' | 'FAIL';
  generatedAt: string;
  promptDigest: string;
  control: MemoryFeedForwardCondition;
  treatment: MemoryFeedForwardCondition;
  checks: MemoryFeedForwardChecks;
  evidenceRefs: string[];
  receiptDigest: string;
}

export interface CompositionEvaluationGateChecks {
  memoryFeedForwardPass: boolean;
  compositionEvaluationPass: boolean;
  terminalResult: boolean;
  couplingProven: boolean;
  evidenceComplete: boolean;
  evidenceReferenced: boolean;
  attemptBudgetHonored: boolean;
}

export interface CompositionEvaluationGateReceipt {
  schemaVersion: typeof W5_COMPOSITION_EVALUATION_SCHEMA_VERSION;
  gate: 'W5-06';
  outcome: 'PASS' | 'FAIL';
  generatedAt: string;
  prerequisite: MemoryFeedForwardGateReceipt;
  evaluation: CompositionEvaluationResult;
  checks: CompositionEvaluationGateChecks;
  evidenceRefs: string[];
  receiptDigest: string;
}

export interface CompositionDreamGateChecks {
  compositionEvaluationPass: boolean;
  admittedRunnableArtifact: boolean;
  parentLineagePreserved: boolean;
  admissionEvidencePasses: boolean;
  successFedCognition: boolean;
  failureFedCognition: boolean;
  trustTaintPreserved: boolean;
  evidenceReferenced: boolean;
}

export interface CompositionDreamGateReceipt {
  schemaVersion: typeof W5_COMPOSITION_DREAM_SCHEMA_VERSION;
  gate: 'W5-07';
  outcome: 'PASS' | 'FAIL';
  generatedAt: string;
  prerequisite: CompositionEvaluationGateReceipt;
  admitted: CompositionDreamRecord;
  failed: DreamFailureRecord;
  checks: CompositionDreamGateChecks;
  evidenceRefs: string[];
  receiptDigest: string;
}

export interface EvidenceConsolidationGateChecks {
  memoryFeedForwardPass: boolean;
  readyHypothesisBounded: boolean;
  citationsAndDisagreementPreserved: boolean;
  trustAndTaintPreserved: boolean;
  emptyEvidenceBlocked: boolean;
  contradictionBlocked: boolean;
  agingApplied: boolean;
  retryOwnedAndBounded: boolean;
  compositionNotInvented: boolean;
  evidenceReferenced: boolean;
}

export interface EvidenceConsolidationGateReceipt {
  schemaVersion: typeof W5_EVIDENCE_CONSOLIDATION_SCHEMA_VERSION;
  gate: 'W5-08';
  outcome: 'PASS' | 'FAIL';
  generatedAt: string;
  prerequisite: MemoryFeedForwardGateReceipt;
  ready: ConsolidatedHypothesis;
  contradicted: ConsolidatedHypothesis;
  retry: ConsolidatedHypothesis;
  aged: ConsolidatedHypothesis;
  emptyHypothesisCount: number;
  checks: EvidenceConsolidationGateChecks;
  evidenceRefs: string[];
  receiptDigest: string;
}

export interface Wave5PrerequisiteRef {
  gate: 'W5-04';
  outcome: 'PASS' | 'FAIL';
  receiptDigest: string;
}

export interface AutoresearchExperimentGateChecks {
  prerequisitesPass: boolean;
  allStatesObserved: boolean;
  passingReachedReview: boolean;
  candidateBounded: boolean;
  failingRestored: boolean;
  failureQuarantined: boolean;
  parentUnchanged: boolean;
  boundaryEscapeDenied: boolean;
  budgetsHonored: boolean;
  missingInputsFailClosed: boolean;
  evidenceReferenced: boolean;
}

export interface AutoresearchExperimentGateReceipt {
  schemaVersion: typeof W5_AUTORESEARCH_EXPERIMENT_SCHEMA_VERSION;
  gate: 'W5-09';
  outcome: 'PASS' | 'FAIL';
  generatedAt: string;
  prerequisites: {
    authority: Wave5PrerequisiteRef;
    composition: CompositionEvaluationGateReceipt;
    consolidation: EvidenceConsolidationGateReceipt;
  };
  budgets: ExperimentBudgets;
  passing: AutoresearchExperimentResult;
  failing: AutoresearchExperimentResult;
  boundaryEscape: AutoresearchExperimentResult;
  failClosedCases: string[];
  checks: AutoresearchExperimentGateChecks;
  evidenceRefs: string[];
  receiptDigest: string;
}

export interface SealedReviewGateChecks {
  autoresearchPass: boolean;
  differentVerifiedReviewer: boolean;
  reviewerReadOnly: boolean;
  manifestOutsideCandidate: boolean;
  manifestPinsRequiredClosure: boolean;
  sealsUnchanged: boolean;
  approvalEmitsCandidate: boolean;
  vetoRestoresCandidate: boolean;
  vetoBlocksPromotion: boolean;
  disagreementAndFollowUpPreserved: boolean;
  missingInputsFailClosed: boolean;
  evidenceReferenced: boolean;
}

export interface SealedReviewGateReceipt {
  schemaVersion: typeof W5_SEALED_REVIEW_SCHEMA_VERSION;
  gate: 'W5-10';
  outcome: 'PASS' | 'FAIL';
  generatedAt: string;
  prerequisite: AutoresearchExperimentGateReceipt;
  approved: ReviewedAutoresearchResult;
  vetoed: ReviewedAutoresearchResult;
  manifestDigest: string;
  manifestOutsideCandidate: boolean;
  manifestPinsRequiredClosure: boolean;
  vetoPromotionDenied: boolean;
  failClosedCases: string[];
  checks: SealedReviewGateChecks;
  evidenceRefs: string[];
  receiptDigest: string;
}

export interface CausalCandidateGateChecks {
  prerequisitesPass: boolean;
  reviewerApprovedCandidate: boolean;
  separateRestoreProof: boolean;
  configurationFrozen: boolean;
  matchedRepeatedTrials: boolean;
  objectiveImproved: boolean;
  varianceVisible: boolean;
  hardFloorsPass: boolean;
  ownerControlled: boolean;
  evidenceComplete: boolean;
  failClosedCasesProven: boolean;
}

export interface CausalCandidateGateReceipt {
  schemaVersion: typeof W5_CAUSAL_CANDIDATE_SCHEMA_VERSION;
  gate: 'W5-11';
  outcome: 'PASS' | 'FAIL';
  generatedAt: string;
  prerequisites: {
    composition: CompositionEvaluationGateReceipt;
    sealedReview: SealedReviewGateReceipt;
  };
  candidate: OwnerControlledCandidate;
  failClosedCases: string[];
  checks: CausalCandidateGateChecks;
  evidenceRefs: string[];
  receiptDigest: string;
}

export interface DomainIncubationGateChecks {
  prerequisitesPass: boolean;
  evidenceEnvelopeComplete: boolean;
  specificationComplete: boolean;
  isolatedPersistenceProven: boolean;
  strongCandidateOwnerControlled: boolean;
  weakCandidateRejected: boolean;
  promotionUnavailable: boolean;
  failClosedCasesProven: boolean;
}

export interface DomainIncubationGateReceipt {
  schemaVersion: typeof W5_DOMAIN_INCUBATION_SCHEMA_VERSION;
  gate: 'W5-12';
  outcome: 'PASS' | 'FAIL';
  generatedAt: string;
  prerequisites: {
    dream: CompositionDreamGateReceipt;
    consolidation: EvidenceConsolidationGateReceipt;
    causal: CausalCandidateGateReceipt;
  };
  recommendation: DomainIncubationRecommendation;
  accepted: EvaluatedDomainIncubation;
  rejected: EvaluatedDomainIncubation;
  persistedRoundTrip: boolean;
  failClosedCases: string[];
  checks: DomainIncubationGateChecks;
  evidenceRefs: string[];
  receiptDigest: string;
}

export interface ModelAssimilationGateChecks {
  prerequisitesPass: boolean;
  everyRoleCovered: boolean;
  comparisonsEquivalent: boolean;
  artifactsAndReceiptsBound: boolean;
  domainsAndCompositionsCovered: boolean;
  unknownIdentityPreserved: boolean;
  recommendationsEvidenceBased: boolean;
  routeMutationForbidden: boolean;
  failClosedCasesProven: boolean;
}

export interface ModelAssimilationGateReceipt {
  schemaVersion: typeof W5_MODEL_ASSIMILATION_SCHEMA_VERSION;
  gate: 'W5-13';
  outcome: 'PASS' | 'FAIL';
  generatedAt: string;
  prerequisites: {
    composition: CompositionEvaluationGateReceipt;
    sealedReview: SealedReviewGateReceipt;
    causal: CausalCandidateGateReceipt;
  };
  report: RoleModelAssimilationReport;
  failClosedCases: string[];
  checks: ModelAssimilationGateChecks;
  evidenceRefs: string[];
  receiptDigest: string;
}

export interface CortexCycleGateChecks {
  prerequisitesPass: boolean;
  dryRunComplete: boolean;
  completedOnce: boolean;
  replayIdempotent: boolean;
  effectsExactlyOnce: boolean;
  splitBrainFenced: boolean;
  budgetsHonored: boolean;
  concurrencyHonored: boolean;
  authorityInvariant: boolean;
  evidenceReferenced: boolean;
  failClosedCasesProven: boolean;
}

export interface CortexCyclePrerequisiteRef<
  Gate extends 'W5-07' | 'W5-11' | 'W5-12' | 'W5-13',
> {
  gate: Gate;
  outcome: 'PASS' | 'FAIL';
  receiptDigest: string;
}

export interface CortexCycleGateReceipt {
  schemaVersion: typeof W5_CORTEX_CYCLE_SCHEMA_VERSION;
  gate: 'W5-14';
  outcome: 'PASS' | 'FAIL';
  generatedAt: string;
  prerequisites: {
    dream: CortexCyclePrerequisiteRef<'W5-07'>;
    causal: CortexCyclePrerequisiteRef<'W5-11'>;
    domain: CortexCyclePrerequisiteRef<'W5-12'>;
    assimilation: CortexCyclePrerequisiteRef<'W5-13'>;
  };
  dryRuns: LivingLoopDryRun[];
  interrupted: LivingLoopCheckpoint;
  completed: LivingLoopCheckpoint;
  replayed: LivingLoopCheckpoint;
  budgetStopped: LivingLoopCheckpoint;
  requestMismatchRejected: boolean;
  splitBrain: {
    actorA: LivingLoopCheckpoint;
    actorB: LivingLoopCheckpoint;
  };
  failClosedCases: string[];
  checks: CortexCycleGateChecks;
  evidenceRefs: string[];
  receiptDigest: string;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) =>
      `${JSON.stringify(key)}:${canonical(record[key])}`
    ).join(',')}}`;
  }
  return JSON.stringify(value);
}

function digest(value: unknown): string {
  return createHash('sha256').update(canonical(value)).digest('hex');
}

export function createMemoryFeedForwardGateReceipt(
  input: Omit<MemoryFeedForwardGateReceipt, 'schemaVersion' | 'gate' | 'outcome' | 'receiptDigest'>,
): MemoryFeedForwardGateReceipt {
  const outcome: 'PASS' | 'FAIL' = Object.values(input.checks).every(Boolean)
    ? 'PASS'
    : 'FAIL';
  const unsigned = {
    schemaVersion: W5_MEMORY_FEED_FORWARD_SCHEMA_VERSION,
    gate: 'W5-03' as const,
    outcome,
    ...input,
  };
  return { ...unsigned, receiptDigest: digest(unsigned) };
}

export function parseMemoryFeedForwardGateReceipt(
  value: unknown,
): MemoryFeedForwardGateReceipt {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('INVALID_W5_03_RECEIPT: receipt must be an object');
  }
  const receipt = value as MemoryFeedForwardGateReceipt;
  if (
    receipt.schemaVersion !== W5_MEMORY_FEED_FORWARD_SCHEMA_VERSION
    || receipt.gate !== 'W5-03'
    || !['PASS', 'FAIL'].includes(receipt.outcome)
  ) {
    throw new Error('INVALID_W5_03_RECEIPT: unknown schema, gate, or outcome');
  }
  const { receiptDigest, ...unsigned } = receipt;
  if (!receiptDigest || digest(unsigned) !== receiptDigest) {
    throw new Error('INVALID_W5_03_RECEIPT: digest mismatch');
  }
  const expectedOutcome = Object.values(receipt.checks).every(Boolean) ? 'PASS' : 'FAIL';
  if (receipt.outcome !== expectedOutcome) {
    throw new Error('INVALID_W5_03_RECEIPT: outcome does not match checks');
  }
  return receipt;
}

function compositionGateChecks(
  prerequisite: MemoryFeedForwardGateReceipt,
  evaluation: CompositionEvaluationResult,
  evidenceRefs: string[],
): CompositionEvaluationGateChecks {
  const coupling = evaluation.checks;
  const structurallyPassing = evaluation.outcome === 'PASS'
    && evaluation.terminal
    && evaluation.layers.length >= 2
    && evaluation.whole.length === 3
    && Object.values(coupling).every(Boolean);
  return {
    memoryFeedForwardPass: prerequisite.outcome === 'PASS',
    compositionEvaluationPass: structurallyPassing,
    terminalResult: evaluation.terminal,
    couplingProven: [
      coupling.baselineTargetMatchesMapping,
      coupling.mutationTargetMatchesMapping,
      coupling.mutationChangesTarget,
      coupling.mutationChangesWholeVerdict,
      coupling.ablationChangesTarget,
      coupling.ablationPreservesSignal,
      coupling.ablationChangesWholeVerdict,
    ].every(Boolean),
    evidenceComplete: coupling.evidenceContractComplete,
    evidenceReferenced: evidenceRefs.length > 0 && evidenceRefs.every(Boolean),
    attemptBudgetHonored: coupling.attemptBudgetHonored,
  };
}

export function createCompositionEvaluationGateReceipt(input: {
  generatedAt: string;
  prerequisite: MemoryFeedForwardGateReceipt;
  evaluation: CompositionEvaluationResult;
  evidenceRefs: string[];
}): CompositionEvaluationGateReceipt {
  const prerequisite = parseMemoryFeedForwardGateReceipt(input.prerequisite);
  const checks = compositionGateChecks(prerequisite, input.evaluation, input.evidenceRefs);
  const unsigned = {
    schemaVersion: W5_COMPOSITION_EVALUATION_SCHEMA_VERSION,
    gate: 'W5-06' as const,
    outcome: Object.values(checks).every(Boolean) ? 'PASS' as const : 'FAIL' as const,
    ...input,
    prerequisite,
    checks,
  };
  return { ...unsigned, receiptDigest: digest(unsigned) };
}

export function parseCompositionEvaluationGateReceipt(
  value: unknown,
): CompositionEvaluationGateReceipt {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('INVALID_W5_06_RECEIPT: receipt must be an object');
  }
  const receipt = value as CompositionEvaluationGateReceipt;
  if (
    receipt.schemaVersion !== W5_COMPOSITION_EVALUATION_SCHEMA_VERSION
    || receipt.gate !== 'W5-06'
    || !['PASS', 'FAIL'].includes(receipt.outcome)
  ) {
    throw new Error('INVALID_W5_06_RECEIPT: unknown schema, gate, or outcome');
  }
  parseMemoryFeedForwardGateReceipt(receipt.prerequisite);
  const { receiptDigest, ...unsigned } = receipt;
  if (!receiptDigest || digest(unsigned) !== receiptDigest) {
    throw new Error('INVALID_W5_06_RECEIPT: digest mismatch');
  }
  const expectedChecks = compositionGateChecks(
    receipt.prerequisite,
    receipt.evaluation,
    receipt.evidenceRefs,
  );
  if (canonical(receipt.checks) !== canonical(expectedChecks)) {
    throw new Error('INVALID_W5_06_RECEIPT: checks do not match evidence');
  }
  const expectedOutcome = Object.values(expectedChecks).every(Boolean) ? 'PASS' : 'FAIL';
  if (receipt.outcome !== expectedOutcome) {
    throw new Error('INVALID_W5_06_RECEIPT: outcome does not match checks');
  }
  return receipt;
}

function cognitionComplete(
  receipts: Array<{ organ: string; status: string }>,
): boolean {
  const observed = new Set(
    receipts.filter(receipt => receipt.status === 'observed').map(receipt => receipt.organ),
  );
  return ['lineage', 'memory', 'compost', 'dreaming'].every(organ => observed.has(organ));
}

function compositionDreamChecks(
  prerequisite: CompositionEvaluationGateReceipt,
  admitted: CompositionDreamRecord,
  failed: DreamFailureRecord,
  evidenceRefs: string[],
): CompositionDreamGateChecks {
  const parentLinked = admitted.recipe.lineage.parentRecipeIds
    .includes(admitted.parentRecipeId);
  const artifactDigestMatches = createHash('sha256')
    .update(admitted.artifact)
    .digest('hex') === admitted.artifactDigest;
  const provenanceMatches = canonical(admitted.provenance) === canonical(failed.provenance);
  return {
    compositionEvaluationPass: prerequisite.outcome === 'PASS',
    admittedRunnableArtifact: admitted.artifact.startsWith('<!doctype html>')
      && artifactDigestMatches,
    parentLineagePreserved: parentLinked,
    admissionEvidencePasses: admitted.verdict === 'admitted'
      && admitted.evaluation.outcome === 'PASS',
    successFedCognition: cognitionComplete(admitted.cognitiveReceipts),
    failureFedCognition: cognitionComplete(failed.cognitiveReceipts),
    trustTaintPreserved: provenanceMatches
      && admitted.provenance.taint === 'tainted'
      && admitted.provenance.taintSources.length > 0,
    evidenceReferenced: evidenceRefs.length > 0 && evidenceRefs.every(Boolean),
  };
}

export function createCompositionDreamGateReceipt(input: {
  generatedAt: string;
  prerequisite: CompositionEvaluationGateReceipt;
  admitted: CompositionDreamRecord;
  failed: DreamFailureRecord;
  evidenceRefs: string[];
}): CompositionDreamGateReceipt {
  const prerequisite = parseCompositionEvaluationGateReceipt(input.prerequisite);
  const checks = compositionDreamChecks(
    prerequisite,
    input.admitted,
    input.failed,
    input.evidenceRefs,
  );
  const unsigned = {
    schemaVersion: W5_COMPOSITION_DREAM_SCHEMA_VERSION,
    gate: 'W5-07' as const,
    outcome: Object.values(checks).every(Boolean) ? 'PASS' as const : 'FAIL' as const,
    ...input,
    prerequisite,
    checks,
  };
  return { ...unsigned, receiptDigest: digest(unsigned) };
}

export function parseCompositionDreamGateReceipt(
  value: unknown,
): CompositionDreamGateReceipt {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('INVALID_W5_07_RECEIPT: receipt must be an object');
  }
  const receipt = value as CompositionDreamGateReceipt;
  if (
    receipt.schemaVersion !== W5_COMPOSITION_DREAM_SCHEMA_VERSION
    || receipt.gate !== 'W5-07'
    || !['PASS', 'FAIL'].includes(receipt.outcome)
  ) {
    throw new Error('INVALID_W5_07_RECEIPT: unknown schema, gate, or outcome');
  }
  parseCompositionEvaluationGateReceipt(receipt.prerequisite);
  const { receiptDigest, ...unsigned } = receipt;
  if (!receiptDigest || digest(unsigned) !== receiptDigest) {
    throw new Error('INVALID_W5_07_RECEIPT: digest mismatch');
  }
  const expected = compositionDreamChecks(
    receipt.prerequisite,
    receipt.admitted,
    receipt.failed,
    receipt.evidenceRefs,
  );
  if (canonical(receipt.checks) !== canonical(expected)) {
    throw new Error('INVALID_W5_07_RECEIPT: checks do not match evidence');
  }
  const outcome = Object.values(expected).every(Boolean) ? 'PASS' : 'FAIL';
  if (receipt.outcome !== outcome) {
    throw new Error('INVALID_W5_07_RECEIPT: outcome does not match checks');
  }
  return receipt;
}

function evidenceConsolidationChecks(input: {
  prerequisite: MemoryFeedForwardGateReceipt;
  ready: ConsolidatedHypothesis;
  contradicted: ConsolidatedHypothesis;
  retry: ConsolidatedHypothesis;
  aged: ConsolidatedHypothesis;
  emptyHypothesisCount: number;
  evidenceRefs: string[];
}): EvidenceConsolidationGateChecks {
  const ready = input.ready;
  const citationsComplete = ready.citations.length >= 2
    && ready.citations.every(item => item.sourceRef && item.lineageId);
  const hasDisagreement = ready.disagreements.length > 0
    && ready.disagreements.every(item => item.stance === 'contradict');
  const untrustedRetained = ready.citations.some(item =>
    item.trust === 'untrusted-external' && item.taint === 'tainted');
  const corroborating = ready.citations.filter(item =>
    item.stance === 'support'
    && item.taint === 'clean'
    && item.trust !== 'untrusted-external');
  const corroboratingSources = [...new Set(corroborating.map(item => item.source))];
  // Derived from citations, not read from the hypothesis: receipts sealed
  // before #1254 carry no corroboratingRoots field (#1403).
  const corroboratingRoots = [...new Set(corroborating.map(item => item.lineageId))];
  return {
    memoryFeedForwardPass: input.prerequisite.outcome === 'PASS',
    readyHypothesisBounded: ready.status === 'ready'
      && ready.confidence >= 0 && ready.confidence <= 1
      && Boolean(ready.falsifier)
      && corroboratingSources.length >= 2
      && canonical(corroboratingSources) === canonical(ready.corroboratingSources)
      && corroboratingRoots.length >= 2,
    citationsAndDisagreementPreserved: citationsComplete && hasDisagreement,
    trustAndTaintPreserved: ready.taint === 'tainted' && untrustedRetained,
    emptyEvidenceBlocked: input.emptyHypothesisCount === 0,
    contradictionBlocked: input.contradicted.status === 'contradicted'
      && input.contradicted.confidence === 0,
    agingApplied: input.aged.status === 'insufficient'
      && input.aged.confidence === 0,
    retryOwnedAndBounded: input.retry.status === 'retry'
      && Boolean(input.retry.retry?.owner)
      && (input.retry.retry?.attempt ?? 0) <= 2,
    compositionNotInvented: !ready.citations.some(item => item.source === 'composition'),
    evidenceReferenced: input.evidenceRefs.length > 0
      && input.evidenceRefs.every(Boolean),
  };
}

export function createEvidenceConsolidationGateReceipt(input: {
  generatedAt: string;
  prerequisite: MemoryFeedForwardGateReceipt;
  ready: ConsolidatedHypothesis;
  contradicted: ConsolidatedHypothesis;
  retry: ConsolidatedHypothesis;
  aged: ConsolidatedHypothesis;
  emptyHypothesisCount: number;
  evidenceRefs: string[];
}): EvidenceConsolidationGateReceipt {
  const prerequisite = parseMemoryFeedForwardGateReceipt(input.prerequisite);
  const checks = evidenceConsolidationChecks({ ...input, prerequisite });
  const unsigned = {
    schemaVersion: W5_EVIDENCE_CONSOLIDATION_SCHEMA_VERSION,
    gate: 'W5-08' as const,
    outcome: Object.values(checks).every(Boolean) ? 'PASS' as const : 'FAIL' as const,
    ...input,
    prerequisite,
    checks,
  };
  return { ...unsigned, receiptDigest: digest(unsigned) };
}

export function parseEvidenceConsolidationGateReceipt(
  value: unknown,
): EvidenceConsolidationGateReceipt {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('INVALID_W5_08_RECEIPT: receipt must be an object');
  }
  const receipt = value as EvidenceConsolidationGateReceipt;
  if (
    receipt.schemaVersion !== W5_EVIDENCE_CONSOLIDATION_SCHEMA_VERSION
    || receipt.gate !== 'W5-08'
    || !['PASS', 'FAIL'].includes(receipt.outcome)
  ) {
    throw new Error('INVALID_W5_08_RECEIPT: unknown schema, gate, or outcome');
  }
  parseMemoryFeedForwardGateReceipt(receipt.prerequisite);
  const { receiptDigest, checks, ...input } = receipt;
  if (!receiptDigest || digest({ ...input, checks }) !== receiptDigest) {
    throw new Error('INVALID_W5_08_RECEIPT: digest mismatch');
  }
  const expected = evidenceConsolidationChecks(input);
  if (canonical(checks) !== canonical(expected)) {
    throw new Error('INVALID_W5_08_RECEIPT: checks do not match evidence');
  }
  const outcome = Object.values(expected).every(Boolean) ? 'PASS' : 'FAIL';
  if (receipt.outcome !== outcome) {
    throw new Error('INVALID_W5_08_RECEIPT: outcome does not match checks');
  }
  return receipt;
}

const PASSING_AUTORESEARCH_STATES = [
  'observe', 'hypothesize', 'baseline', 'reproduce', 'mutate', 'verify',
  'artifact-evaluate', 'review', 'candidate', 'learn',
];

function usageWithinBudgets(
  result: AutoresearchExperimentResult,
  budgets: ExperimentBudgets,
): boolean {
  return (Object.keys(result.usage) as Array<keyof ExperimentBudgets>)
    .every(key => result.usage[key] <= budgets[key]);
}

function autoresearchExperimentChecks(input: {
  prerequisites: AutoresearchExperimentGateReceipt['prerequisites'];
  budgets: ExperimentBudgets;
  passing: AutoresearchExperimentResult;
  failing: AutoresearchExperimentResult;
  boundaryEscape: AutoresearchExperimentResult;
  failClosedCases: string[];
  evidenceRefs: string[];
}): AutoresearchExperimentGateChecks {
  const passingStates = input.passing.stages.map(stage => stage.state);
  const review = input.passing.stages.find(stage => stage.state === 'review');
  const requiredFailures = ['identity', 'evidence', 'control', 'budget', 'review'];
  return {
    prerequisitesPass: input.prerequisites.authority.outcome === 'PASS'
      && input.prerequisites.composition.outcome === 'PASS'
      && input.prerequisites.consolidation.outcome === 'PASS',
    allStatesObserved: canonical(passingStates) === canonical(PASSING_AUTORESEARCH_STATES),
    passingReachedReview: input.passing.terminal === 'candidate'
      && review?.passed === true && review.verdict === 'approve',
    candidateBounded: input.passing.changedPaths.length > 0
      && input.passing.authorityReceipts.length > 0
      && input.passing.authorityReceipts.every(receipt => receipt.decision === 'allow'),
    failingRestored: input.failing.terminal === 'restored'
      && input.failing.stages.some(stage => stage.state === 'restore'),
    failureQuarantined: input.failing.failure?.quarantined === true
      && input.boundaryEscape.failure?.quarantined === true,
    parentUnchanged: input.passing.parentUnchanged
      && input.failing.parentUnchanged
      && input.boundaryEscape.parentUnchanged,
    boundaryEscapeDenied: input.boundaryEscape.terminal === 'restored'
      && input.boundaryEscape.authorityReceipts.some(receipt =>
        receipt.decision === 'deny'),
    budgetsHonored: [
      input.passing, input.failing, input.boundaryEscape,
    ].every(result => usageWithinBudgets(result, input.budgets)),
    missingInputsFailClosed: requiredFailures.every(item =>
      input.failClosedCases.includes(item)),
    evidenceReferenced: input.evidenceRefs.length > 0
      && input.evidenceRefs.every(Boolean),
  };
}

export function createAutoresearchExperimentGateReceipt(input: {
  generatedAt: string;
  prerequisites: AutoresearchExperimentGateReceipt['prerequisites'];
  budgets: ExperimentBudgets;
  passing: AutoresearchExperimentResult;
  failing: AutoresearchExperimentResult;
  boundaryEscape: AutoresearchExperimentResult;
  failClosedCases: string[];
  evidenceRefs: string[];
}): AutoresearchExperimentGateReceipt {
  const prerequisites = {
    authority: input.prerequisites.authority,
    composition: parseCompositionEvaluationGateReceipt(
      input.prerequisites.composition,
    ),
    consolidation: parseEvidenceConsolidationGateReceipt(
      input.prerequisites.consolidation,
    ),
  };
  if (!/^[a-f0-9]{64}$/.test(prerequisites.authority.receiptDigest)) {
    throw new Error('INVALID_W5_04_RECEIPT_REF');
  }
  const checks = autoresearchExperimentChecks({ ...input, prerequisites });
  const unsigned = {
    schemaVersion: W5_AUTORESEARCH_EXPERIMENT_SCHEMA_VERSION,
    gate: 'W5-09' as const,
    outcome: Object.values(checks).every(Boolean) ? 'PASS' as const : 'FAIL' as const,
    ...input,
    prerequisites,
    checks,
  };
  return { ...unsigned, receiptDigest: digest(unsigned) };
}

export function parseAutoresearchExperimentGateReceipt(
  value: unknown,
): AutoresearchExperimentGateReceipt {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('INVALID_W5_09_RECEIPT: receipt must be an object');
  }
  const receipt = value as AutoresearchExperimentGateReceipt;
  if (
    receipt.schemaVersion !== W5_AUTORESEARCH_EXPERIMENT_SCHEMA_VERSION
    || receipt.gate !== 'W5-09'
    || !['PASS', 'FAIL'].includes(receipt.outcome)
  ) {
    throw new Error('INVALID_W5_09_RECEIPT: unknown schema, gate, or outcome');
  }
  parseCompositionEvaluationGateReceipt(receipt.prerequisites.composition);
  parseEvidenceConsolidationGateReceipt(receipt.prerequisites.consolidation);
  const { receiptDigest, checks, ...input } = receipt;
  if (!receiptDigest || digest({ ...input, checks }) !== receiptDigest) {
    throw new Error('INVALID_W5_09_RECEIPT: digest mismatch');
  }
  const expected = autoresearchExperimentChecks(input);
  if (canonical(checks) !== canonical(expected)) {
    throw new Error('INVALID_W5_09_RECEIPT: checks do not match evidence');
  }
  const outcome = Object.values(expected).every(Boolean) ? 'PASS' : 'FAIL';
  if (receipt.outcome !== outcome) {
    throw new Error('INVALID_W5_09_RECEIPT: outcome does not match checks');
  }
  return receipt;
}

function reviewerKey(identity: { provider: string; model: string }): string {
  return `${identity.provider.trim().toLowerCase()}/${identity.model.trim().toLowerCase()}`;
}

function sealedReviewChecks(input: {
  prerequisite: AutoresearchExperimentGateReceipt;
  approved: ReviewedAutoresearchResult;
  vetoed: ReviewedAutoresearchResult;
  manifestDigest: string;
  manifestOutsideCandidate: boolean;
  manifestPinsRequiredClosure: boolean;
  vetoPromotionDenied: boolean;
  failClosedCases: string[];
  evidenceRefs: string[];
}): SealedReviewGateChecks {
  const author = input.approved.review.author;
  const reviewer = input.approved.review.reviewer;
  const readOnlyTools = new Set<string>(SEALED_REVIEW_READ_ONLY_TOOLS);
  const requiredFailures = [
    'self-review', 'unknown-identity', 'reviewer-write',
    'manifest-drift', 'identity-mismatch', 'closure-omission',
  ];
  const reviews = [input.approved.review, input.vetoed.review];
  return {
    autoresearchPass: input.prerequisite.outcome === 'PASS',
    differentVerifiedReviewer: author.verified && reviewer.verified
      && reviewerKey(author) !== reviewerKey(reviewer),
    reviewerReadOnly: reviews.every(review =>
      review.reviewerTools.every(tool => readOnlyTools.has(tool))),
    manifestOutsideCandidate: input.manifestOutsideCandidate,
    manifestPinsRequiredClosure: input.manifestPinsRequiredClosure
      && /^[a-f0-9]{64}$/.test(input.manifestDigest),
    sealsUnchanged: reviews.every(review => (
      review.manifestDigest === input.manifestDigest
      && review.closureBeforeDigest === review.closureAfterDigest
    )),
    approvalEmitsCandidate: input.approved.review.verdict === 'approve'
      && input.approved.experiment.terminal === 'candidate',
    vetoRestoresCandidate: input.vetoed.review.verdict === 'veto'
      && input.vetoed.experiment.terminal === 'restored',
    vetoBlocksPromotion: input.vetoPromotionDenied,
    disagreementAndFollowUpPreserved: reviews.every(review => (
      review.disagreement.length > 0
      && review.requestedFollowUp.length > 0
      && review.followUpRequiresNewExperiment
    )),
    missingInputsFailClosed: requiredFailures.every(item =>
      input.failClosedCases.includes(item)),
    evidenceReferenced: input.evidenceRefs.length > 0
      && input.evidenceRefs.every(Boolean),
  };
}

export function createSealedReviewGateReceipt(input: {
  generatedAt: string;
  prerequisite: AutoresearchExperimentGateReceipt;
  approved: ReviewedAutoresearchResult;
  vetoed: ReviewedAutoresearchResult;
  manifestDigest: string;
  manifestOutsideCandidate: boolean;
  manifestPinsRequiredClosure: boolean;
  vetoPromotionDenied: boolean;
  failClosedCases: string[];
  evidenceRefs: string[];
}): SealedReviewGateReceipt {
  const prerequisite = parseAutoresearchExperimentGateReceipt(input.prerequisite);
  const checks = sealedReviewChecks({ ...input, prerequisite });
  const unsigned = {
    schemaVersion: W5_SEALED_REVIEW_SCHEMA_VERSION,
    gate: 'W5-10' as const,
    outcome: Object.values(checks).every(Boolean) ? 'PASS' as const : 'FAIL' as const,
    ...input,
    prerequisite,
    checks,
  };
  return { ...unsigned, receiptDigest: digest(unsigned) };
}

export function parseSealedReviewGateReceipt(
  value: unknown,
): SealedReviewGateReceipt {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('INVALID_W5_10_RECEIPT: receipt must be an object');
  }
  const receipt = value as SealedReviewGateReceipt;
  if (
    receipt.schemaVersion !== W5_SEALED_REVIEW_SCHEMA_VERSION
    || receipt.gate !== 'W5-10'
    || !['PASS', 'FAIL'].includes(receipt.outcome)
  ) {
    throw new Error('INVALID_W5_10_RECEIPT: unknown schema, gate, or outcome');
  }
  parseAutoresearchExperimentGateReceipt(receipt.prerequisite);
  const { receiptDigest, checks, ...input } = receipt;
  if (!receiptDigest || digest({ ...input, checks }) !== receiptDigest) {
    throw new Error('INVALID_W5_10_RECEIPT: digest mismatch');
  }
  const expected = sealedReviewChecks(input);
  if (canonical(checks) !== canonical(expected)) {
    throw new Error('INVALID_W5_10_RECEIPT: checks do not match evidence');
  }
  const outcome = Object.values(expected).every(Boolean) ? 'PASS' : 'FAIL';
  if (receipt.outcome !== outcome) {
    throw new Error('INVALID_W5_10_RECEIPT: outcome does not match checks');
  }
  return receipt;
}

function causalCandidateChecks(input: {
  prerequisites: CausalCandidateGateReceipt['prerequisites'];
  candidate: OwnerControlledCandidate;
  failClosedCases: string[];
  evidenceRefs: string[];
}): CausalCandidateGateChecks {
  const { candidate, prerequisites } = input;
  const requiredFailures = [
    'insufficient-effect', 'hard-floor', 'insufficient-trials',
    'missing-seed', 'unknown-identity', 'missing-restore', 'configuration-mismatch',
    'authority-decoupling', 'diff-decoupling',
  ];
  const digests = [
    candidate.configuration.intentDigest,
    candidate.configuration.promptDigest,
    candidate.configuration.parametersDigest,
    candidate.configuration.capabilitiesDigest,
    candidate.configuration.evaluatorDigest,
    candidate.configuration.environmentDigest,
  ];
  const configurationDigest = fingerprintTrialConfiguration(candidate.configuration);
  const approved = prerequisites.sealedReview.approved;
  const vetoed = prerequisites.sealedReview.vetoed;
  const approvedPaths = new Set(approved.experiment.changedPaths);
  const candidatePaths = new Set(candidate.diff.paths);
  const identityBound = canonical(candidate.author) === canonical(approved.review.author)
    && canonical(candidate.reviewer) === canonical(approved.review.reviewer);
  return {
    prerequisitesPass: prerequisites.composition.outcome === 'PASS'
      && prerequisites.sealedReview.outcome === 'PASS',
    reviewerApprovedCandidate: approved.review.verdict === 'approve'
      && candidate.experimentId === approved.experiment.experimentId
      && candidate.lineageId === approved.experiment.lineageId
      && candidate.reviewReceiptDigest === approved.review.receiptDigest
      && identityBound,
    separateRestoreProof: vetoed.experiment.terminal === 'restored'
      && vetoed.review.verdict === 'veto'
      && vetoed.experiment.failure?.quarantined === true
      && candidate.restoredFailureExperimentId
        === vetoed.experiment.experimentId,
    configurationFrozen: digests.every(value => /^[a-f0-9]{64}$/.test(value))
      && candidate.configuration.evaluatorDigest === prerequisites.sealedReview.manifestDigest,
    matchedRepeatedTrials: candidate.trials.length >= candidate.decisionRule.minimumTrials
      && new Set(candidate.trials.map(trial => trial.trialId)).size === candidate.trials.length
      && candidate.trials.every(trial => (
        trial.controlConfigurationDigest === configurationDigest
        && trial.treatmentConfigurationDigest === configurationDigest
        && trial.controlArtifactDigest !== trial.treatmentArtifactDigest
      )),
    objectiveImproved: candidate.analysis.improved
      && candidate.analysis.meanEffect >= candidate.decisionRule.minimumEffect,
    varianceVisible: candidate.analysis.trialEffects.length >= 3
      && Number.isFinite(candidate.analysis.sampleVariance),
    hardFloorsPass: candidate.analysis.hardFloorsPass,
    ownerControlled: candidate.status === 'awaiting-owner'
      && candidate.allowedAction === 'request-owner-merge',
    evidenceComplete: input.evidenceRefs.length > 0
      && input.evidenceRefs.every(Boolean)
      && candidate.verificationRefs.length > 0
      && candidate.artifactComparisonRefs.length > 0
      && approvedPaths.size > 0
      && approvedPaths.size === candidatePaths.size
      && [...approvedPaths].every(path => candidatePaths.has(path)),
    failClosedCasesProven: requiredFailures.every(item =>
      input.failClosedCases.includes(item)),
  };
}

export function createCausalCandidateGateReceipt(input: {
  generatedAt: string;
  prerequisites: CausalCandidateGateReceipt['prerequisites'];
  candidate: OwnerControlledCandidate;
  failClosedCases: string[];
  evidenceRefs: string[];
}): CausalCandidateGateReceipt {
  const prerequisites = {
    composition: parseCompositionEvaluationGateReceipt(input.prerequisites.composition),
    sealedReview: parseSealedReviewGateReceipt(input.prerequisites.sealedReview),
  };
  const candidate = parseOwnerControlledCandidate(input.candidate);
  const checks = causalCandidateChecks({ ...input, prerequisites, candidate });
  const unsigned = {
    schemaVersion: W5_CAUSAL_CANDIDATE_SCHEMA_VERSION,
    gate: 'W5-11' as const,
    outcome: Object.values(checks).every(Boolean) ? 'PASS' as const : 'FAIL' as const,
    ...input,
    prerequisites,
    candidate,
    checks,
  };
  return { ...unsigned, receiptDigest: digest(unsigned) };
}

export function parseCausalCandidateGateReceipt(
  value: unknown,
): CausalCandidateGateReceipt {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('INVALID_W5_11_RECEIPT: receipt must be an object');
  }
  const receipt = value as CausalCandidateGateReceipt;
  if (
    receipt.schemaVersion !== W5_CAUSAL_CANDIDATE_SCHEMA_VERSION
    || receipt.gate !== 'W5-11'
    || !['PASS', 'FAIL'].includes(receipt.outcome)
  ) {
    throw new Error('INVALID_W5_11_RECEIPT: unknown schema, gate, or outcome');
  }
  parseCompositionEvaluationGateReceipt(receipt.prerequisites.composition);
  parseSealedReviewGateReceipt(receipt.prerequisites.sealedReview);
  parseOwnerControlledCandidate(receipt.candidate);
  const { receiptDigest, checks, ...input } = receipt;
  if (!receiptDigest || digest({ ...input, checks }) !== receiptDigest) {
    throw new Error('INVALID_W5_11_RECEIPT: digest mismatch');
  }
  const expected = causalCandidateChecks(input);
  if (canonical(checks) !== canonical(expected)) {
    throw new Error('INVALID_W5_11_RECEIPT: checks do not match evidence');
  }
  const outcome = Object.values(expected).every(Boolean) ? 'PASS' : 'FAIL';
  if (receipt.outcome !== outcome) {
    throw new Error('INVALID_W5_11_RECEIPT: outcome does not match checks');
  }
  return receipt;
}

function domainIncubationChecks(input: {
  prerequisites: DomainIncubationGateReceipt['prerequisites'];
  recommendation: DomainIncubationRecommendation;
  accepted: EvaluatedDomainIncubation;
  rejected: EvaluatedDomainIncubation;
  persistedRoundTrip: boolean;
  failClosedCases: string[];
  evidenceRefs: string[];
}): DomainIncubationGateChecks {
  const requiredKinds = ['creative', 'evaluation', 'consolidation', 'causal'] as const;
  const kinds = new Set(input.recommendation.signals.map(signal => signal.kind));
  const spec = input.recommendation.specification;
  const requiredFailures = [
    'missing-evidence-organ', 'weak-candidate', 'candidate-mismatch',
    'missing-rejection-tests', 'promotion-attempt',
  ];
  const acceptedExpected = evaluateDomainIncubator(
    input.recommendation,
    input.accepted.proof,
  );
  const rejectedExpected = evaluateDomainIncubator(
    input.recommendation,
    input.rejected.proof,
  );
  const signal = (kind: typeof requiredKinds[number]) =>
    input.recommendation.signals.find(item => item.kind === kind);
  const creative = signal('creative');
  const evaluation = signal('evaluation');
  const consolidation = signal('consolidation');
  const causal = signal('causal');
  const dreamEvidenceRefs = new Set(
    input.prerequisites.dream.admitted.evaluation.evidence.map(item => item.sourceRef),
  );
  const evidenceBound = creative?.evidenceRef
      === `receipt:W5-07:${input.prerequisites.dream.receiptDigest}`
    && creative.lineageId === input.prerequisites.dream.admitted.recipe.id
    && Boolean(evaluation && dreamEvidenceRefs.has(evaluation.evidenceRef))
    && evaluation?.lineageId === input.prerequisites.dream.admitted.recipe.id
    && consolidation?.evidenceRef
      === `receipt:W5-08:${input.prerequisites.consolidation.receiptDigest}`
    && input.prerequisites.consolidation.ready.citations
      .some(item => item.lineageId === consolidation.lineageId)
    && causal?.evidenceRef
      === `receipt:W5-11:${input.prerequisites.causal.receiptDigest}`
    && causal.lineageId === input.prerequisites.causal.candidate.lineageId;
  return {
    prerequisitesPass: Object.values(input.prerequisites)
      .every(receipt => receipt.outcome === 'PASS'),
    evidenceEnvelopeComplete: requiredKinds.every(kind => kinds.has(kind))
      && evidenceBound
      && input.evidenceRefs.length > 0 && input.evidenceRefs.every(Boolean),
    specificationComplete: [
      spec.routing, spec.generation, spec.evaluation,
      spec.persistence, spec.documentation, spec.rejectionTests,
    ].every(items => items.length > 0),
    isolatedPersistenceProven: input.persistedRoundTrip,
    strongCandidateOwnerControlled: canonical(input.accepted) === canonical(acceptedExpected)
      && input.accepted.status === 'ready-for-owner-review',
    weakCandidateRejected: canonical(input.rejected) === canonical(rejectedExpected)
      && input.rejected.status === 'rejected',
    promotionUnavailable: input.recommendation.promotion === 'forbidden'
      && input.accepted.promotion === 'forbidden'
      && input.rejected.promotion === 'forbidden',
    failClosedCasesProven: requiredFailures.every(item =>
      input.failClosedCases.includes(item)),
  };
}

export function createDomainIncubationGateReceipt(input: {
  generatedAt: string;
  prerequisites: DomainIncubationGateReceipt['prerequisites'];
  recommendation: DomainIncubationRecommendation;
  accepted: EvaluatedDomainIncubation;
  rejected: EvaluatedDomainIncubation;
  persistedRoundTrip: boolean;
  failClosedCases: string[];
  evidenceRefs: string[];
}): DomainIncubationGateReceipt {
  const prerequisites = {
    dream: parseCompositionDreamGateReceipt(input.prerequisites.dream),
    consolidation: parseEvidenceConsolidationGateReceipt(
      input.prerequisites.consolidation,
    ),
    causal: parseCausalCandidateGateReceipt(input.prerequisites.causal),
  };
  const recommendation = parseDomainIncubationRecommendation(input.recommendation);
  const accepted = parseEvaluatedDomainIncubation(input.accepted);
  const rejected = parseEvaluatedDomainIncubation(input.rejected);
  const normalized = {
    ...input, prerequisites, recommendation, accepted, rejected,
  };
  const checks = domainIncubationChecks(normalized);
  const unsigned = {
    schemaVersion: W5_DOMAIN_INCUBATION_SCHEMA_VERSION,
    gate: 'W5-12' as const,
    outcome: Object.values(checks).every(Boolean) ? 'PASS' as const : 'FAIL' as const,
    ...normalized,
    checks,
  };
  return { ...unsigned, receiptDigest: digest(unsigned) };
}

export function parseDomainIncubationGateReceipt(
  value: unknown,
): DomainIncubationGateReceipt {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('INVALID_W5_12_RECEIPT: receipt must be an object');
  }
  const receipt = value as DomainIncubationGateReceipt;
  if (
    receipt.schemaVersion !== W5_DOMAIN_INCUBATION_SCHEMA_VERSION
    || receipt.gate !== 'W5-12'
    || !['PASS', 'FAIL'].includes(receipt.outcome)
  ) {
    throw new Error('INVALID_W5_12_RECEIPT: unknown schema, gate, or outcome');
  }
  const { receiptDigest, checks, ...input } = receipt;
  if (!receiptDigest || digest({ ...input, checks }) !== receiptDigest) {
    throw new Error('INVALID_W5_12_RECEIPT: digest mismatch');
  }
  const prerequisites = {
    dream: parseCompositionDreamGateReceipt(input.prerequisites.dream),
    consolidation: parseEvidenceConsolidationGateReceipt(
      input.prerequisites.consolidation,
    ),
    causal: parseCausalCandidateGateReceipt(input.prerequisites.causal),
  };
  const recommendation = parseDomainIncubationRecommendation(input.recommendation);
  const accepted = parseEvaluatedDomainIncubation(input.accepted);
  const rejected = parseEvaluatedDomainIncubation(input.rejected);
  const expected = domainIncubationChecks({
    ...input, prerequisites, recommendation, accepted, rejected,
  });
  if (canonical(checks) !== canonical(expected)) {
    throw new Error('INVALID_W5_12_RECEIPT: checks do not match evidence');
  }
  const outcome = Object.values(expected).every(Boolean) ? 'PASS' : 'FAIL';
  if (receipt.outcome !== outcome) {
    throw new Error('INVALID_W5_12_RECEIPT: outcome does not match checks');
  }
  return receipt;
}

function modelAssimilationChecks(input: {
  prerequisites: ModelAssimilationGateReceipt['prerequisites'];
  report: RoleModelAssimilationReport;
  failClosedCases: string[];
  evidenceRefs: string[];
}): ModelAssimilationGateChecks {
  const report = input.report;
  const roles = new Set(report.recommendations
    .filter(item => item.status !== 'unknown-identity')
    .map(item => item.role));
  const unknown = report.recommendations.find(item =>
    item.status === 'unknown-identity');
  const requiredFailures = [
    'configuration-mismatch', 'missing-identity', 'reputation-only',
    'weak-challenger', 'route-mutation',
  ];
  const requiredEvidence = [
    `receipt:W5-06:${input.prerequisites.composition.receiptDigest}`,
    `receipt:W5-10:${input.prerequisites.sealedReview.receiptDigest}`,
    `receipt:W5-11:${input.prerequisites.causal.receiptDigest}`,
  ];
  return {
    prerequisitesPass: Object.values(input.prerequisites)
      .every(receipt => receipt.outcome === 'PASS'),
    everyRoleCovered: ASSIMILATION_ROLES.every(role => roles.has(role)),
    comparisonsEquivalent: report.auditions.every(audition => {
      const expected = fingerprintAuditionSlice(audition.slice);
      return audition.baseline.configurationDigest === expected
        && audition.challenger.configurationDigest === expected;
    }),
    artifactsAndReceiptsBound: report.auditions.every(audition =>
      [audition.baseline, audition.challenger].every(arm =>
        /^[a-f0-9]{64}$/.test(arm.artifactDigest) && Boolean(arm.receiptRef))),
    domainsAndCompositionsCovered: report.auditions.every(audition =>
      Boolean(audition.slice.domain && audition.slice.composition)),
    unknownIdentityPreserved: Boolean(unknown)
      && unknown?.challenger.provider === null
      && unknown.challenger.model === null
      && !unknown.challenger.verified
      && unknown.allowedAction === 'none',
    recommendationsEvidenceBased: report.recommendations
      .filter(item => item.status === 'recommended')
      .every(item => item.meanEffect >= report.decisionRule.minimumEffect
        && item.hardFloorsPass
        && item.challenger.verified
        && item.allowedAction === 'request-explicit-model-promotion')
      && input.evidenceRefs.length > 0
      && input.evidenceRefs.every(Boolean)
      && requiredEvidence.every(ref => input.evidenceRefs.includes(ref)),
    routeMutationForbidden: report.routeMutation === 'forbidden',
    failClosedCasesProven: requiredFailures.every(item =>
      input.failClosedCases.includes(item)),
  };
}

export function createModelAssimilationGateReceipt(input: {
  generatedAt: string;
  prerequisites: ModelAssimilationGateReceipt['prerequisites'];
  report: RoleModelAssimilationReport;
  failClosedCases: string[];
  evidenceRefs: string[];
}): ModelAssimilationGateReceipt {
  const prerequisites = {
    composition: parseCompositionEvaluationGateReceipt(input.prerequisites.composition),
    sealedReview: parseSealedReviewGateReceipt(input.prerequisites.sealedReview),
    causal: parseCausalCandidateGateReceipt(input.prerequisites.causal),
  };
  const report = parseRoleModelAssimilationReport(input.report);
  const normalized = { ...input, prerequisites, report };
  const checks = modelAssimilationChecks(normalized);
  const unsigned = {
    schemaVersion: W5_MODEL_ASSIMILATION_SCHEMA_VERSION,
    gate: 'W5-13' as const,
    outcome: Object.values(checks).every(Boolean) ? 'PASS' as const : 'FAIL' as const,
    ...normalized,
    checks,
  };
  return { ...unsigned, receiptDigest: digest(unsigned) };
}

export function parseModelAssimilationGateReceipt(
  value: unknown,
): ModelAssimilationGateReceipt {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('INVALID_W5_13_RECEIPT: receipt must be an object');
  }
  const receipt = value as ModelAssimilationGateReceipt;
  if (
    receipt.schemaVersion !== W5_MODEL_ASSIMILATION_SCHEMA_VERSION
    || receipt.gate !== 'W5-13'
    || !['PASS', 'FAIL'].includes(receipt.outcome)
  ) throw new Error('INVALID_W5_13_RECEIPT: schema, gate, or outcome');
  const { receiptDigest, checks, ...input } = receipt;
  if (!receiptDigest || digest({ ...input, checks }) !== receiptDigest) {
    throw new Error('INVALID_W5_13_RECEIPT: digest mismatch');
  }
  const prerequisites = {
    composition: parseCompositionEvaluationGateReceipt(input.prerequisites.composition),
    sealedReview: parseSealedReviewGateReceipt(input.prerequisites.sealedReview),
    causal: parseCausalCandidateGateReceipt(input.prerequisites.causal),
  };
  const report = parseRoleModelAssimilationReport(input.report);
  const expected = modelAssimilationChecks({
    ...input, prerequisites, report,
  });
  if (canonical(checks) !== canonical(expected)) {
    throw new Error('INVALID_W5_13_RECEIPT: checks do not match evidence');
  }
  const outcome = Object.values(expected).every(Boolean) ? 'PASS' : 'FAIL';
  if (receipt.outcome !== outcome) {
    throw new Error('INVALID_W5_13_RECEIPT: outcome does not match checks');
  }
  return receipt;
}

const REQUIRED_CYCLE_EFFECTS = [
  'evidence-admission',
  'dream-admission',
  'consolidation-admission',
  'mutation',
  'review',
  'veto',
  'assimilation-recommendation',
  'candidate',
  'promotion-request',
] as const;

// Historical W5 receipts are immutable evidence. Later living-loop evolution
// must not rewrite their seven-stage contract or reinterpret a prior PASS.
const W5_LIVING_LOOP_STEPS = [
  'create-evidence', 'dream', 'consolidate', 'autoresearch',
  'review', 'assimilate', 'candidate-request',
] as const;

function cycleAuthorityHeld(
  value: Pick<LivingLoopCheckpoint, 'authority'> | LivingLoopDryRun,
): boolean {
  return value.authority.independentReviewRequired
    && value.authority.sealedControlsRequired
    && value.authority.stageOneNoMerge;
}

function cycleEffects(checkpoint: LivingLoopCheckpoint) {
  return checkpoint.steps.flatMap(step => step.effects);
}

function usageWithinBudget(checkpoint: LivingLoopCheckpoint): boolean {
  return checkpoint.usage.actions <= checkpoint.budgets.maxActions
    && checkpoint.usage.tokens <= checkpoint.budgets.maxTokens
    && checkpoint.usage.costUsd <= checkpoint.budgets.maxCostUsd
    && checkpoint.usage.wallClockMs <= checkpoint.budgets.maxWallClockMs;
}

function parseCortexCyclePrerequisite<
  Gate extends 'W5-07' | 'W5-11' | 'W5-12' | 'W5-13',
>(
  value: CortexCyclePrerequisiteRef<Gate>,
  gate: Gate,
): CortexCyclePrerequisiteRef<Gate> {
  if (
    !value
    || value.gate !== gate
    || !['PASS', 'FAIL'].includes(value.outcome)
    || !/^[a-f0-9]{64}$/.test(value.receiptDigest)
  ) throw new Error(`INVALID_W5_14_PREREQUISITE:${gate}`);
  return value;
}

function cortexCycleChecks(input: {
  prerequisites: CortexCycleGateReceipt['prerequisites'];
  dryRuns: LivingLoopDryRun[];
  interrupted: LivingLoopCheckpoint;
  completed: LivingLoopCheckpoint;
  replayed: LivingLoopCheckpoint;
  budgetStopped: LivingLoopCheckpoint;
  requestMismatchRejected: boolean;
  splitBrain: CortexCycleGateReceipt['splitBrain'];
  failClosedCases: string[];
  evidenceRefs: string[];
}): CortexCycleGateChecks {
  const effects = cycleEffects(input.completed);
  const ids = effects.map(effect => effect.id);
  const requiredFailures = [
    'interrupted-replay',
    'split-brain',
    'budget-overrun',
    'authority-bypass',
    'request-mismatch',
  ];
  const requiredEvidence = [
    `receipt:W5-07:${input.prerequisites.dream.receiptDigest}`,
    `receipt:W5-11:${input.prerequisites.causal.receiptDigest}`,
    `receipt:W5-12:${input.prerequisites.domain.receiptDigest}`,
    `receipt:W5-13:${input.prerequisites.assimilation.receiptDigest}`,
  ];
  return {
    prerequisitesPass: Object.values(input.prerequisites)
      .every(receipt => receipt.outcome === 'PASS'),
    dryRunComplete: input.dryRuns.length === 3
      && new Set(input.dryRuns.map(run => run.autonomyLevel)).size === 3
      && input.dryRuns.every(run => !run.writes
        && canonical(run.steps.map(step => step.step)) === canonical(W5_LIVING_LOOP_STEPS)
        && run.steps.every(step => Boolean(
          step.transition && step.prerequisite && step.idempotencyKey))),
    completedOnce: input.interrupted.state === 'running'
      && input.interrupted.steps.some(step => step.status === 'running')
      && input.completed.state === 'completed'
      && input.completed.requestDigest === input.interrupted.requestDigest
      && input.completed.steps.every(step => step.status === 'completed'),
    replayIdempotent: input.replayed.state === 'completed'
      && input.replayed.requestDigest === input.completed.requestDigest
      && canonical(input.replayed.steps) === canonical(input.completed.steps)
      && canonical(input.replayed.usage) === canonical(input.completed.usage),
    effectsExactlyOnce: REQUIRED_CYCLE_EFFECTS.every(type =>
      effects.filter(effect => effect.type === type).length === 1)
      && effects.length === REQUIRED_CYCLE_EFFECTS.length
      && new Set(ids).size === ids.length,
    splitBrainFenced: Object.values(input.splitBrain).every(actor =>
      actor.state === 'stopped'
      && actor.fenced
      && actor.stopReason === 'split-brain'),
    budgetsHonored: [
      input.completed,
      input.replayed,
      input.budgetStopped,
      ...Object.values(input.splitBrain),
    ].every(usageWithinBudget),
    concurrencyHonored: input.completed.maxObservedConcurrency
      <= input.completed.concurrencyLimit
      && input.replayed.maxObservedConcurrency <= input.replayed.concurrencyLimit,
    authorityInvariant: [
      ...input.dryRuns,
      input.completed,
      input.replayed,
      input.interrupted,
      input.budgetStopped,
      ...Object.values(input.splitBrain),
    ].every(cycleAuthorityHeld),
    evidenceReferenced: requiredEvidence.every(ref => input.evidenceRefs.includes(ref))
      && input.evidenceRefs.every(Boolean),
    failClosedCasesProven: requiredFailures.every(failure =>
      input.failClosedCases.includes(failure))
      && input.budgetStopped.state === 'stopped'
      && input.budgetStopped.stopReason === 'LIVING_LOOP_BUDGET_EXCEEDED'
      && input.requestMismatchRejected,
  };
}

export function createCortexCycleGateReceipt(input: {
  generatedAt: string;
  prerequisites: CortexCycleGateReceipt['prerequisites'];
  dryRuns: LivingLoopDryRun[];
  interrupted: LivingLoopCheckpoint;
  completed: LivingLoopCheckpoint;
  replayed: LivingLoopCheckpoint;
  budgetStopped: LivingLoopCheckpoint;
  requestMismatchRejected: boolean;
  splitBrain: CortexCycleGateReceipt['splitBrain'];
  failClosedCases: string[];
  evidenceRefs: string[];
}): CortexCycleGateReceipt {
  const prerequisites = {
    dream: parseCortexCyclePrerequisite(input.prerequisites.dream, 'W5-07'),
    causal: parseCortexCyclePrerequisite(input.prerequisites.causal, 'W5-11'),
    domain: parseCortexCyclePrerequisite(input.prerequisites.domain, 'W5-12'),
    assimilation: parseCortexCyclePrerequisite(
      input.prerequisites.assimilation,
      'W5-13',
    ),
  };
  const normalized = { ...input, prerequisites };
  const checks = cortexCycleChecks(normalized);
  const unsigned = {
    schemaVersion: W5_CORTEX_CYCLE_SCHEMA_VERSION,
    gate: 'W5-14' as const,
    outcome: Object.values(checks).every(Boolean) ? 'PASS' as const : 'FAIL' as const,
    ...normalized,
    checks,
  };
  return { ...unsigned, receiptDigest: digest(unsigned) };
}

export function parseCortexCycleGateReceipt(value: unknown): CortexCycleGateReceipt {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('INVALID_W5_14_RECEIPT: receipt must be an object');
  }
  const receipt = value as CortexCycleGateReceipt;
  if (
    receipt.schemaVersion !== W5_CORTEX_CYCLE_SCHEMA_VERSION
    || receipt.gate !== 'W5-14'
    || !['PASS', 'FAIL'].includes(receipt.outcome)
  ) throw new Error('INVALID_W5_14_RECEIPT: schema, gate, or outcome');
  const { receiptDigest, checks, ...input } = receipt;
  if (!receiptDigest || digest({ ...input, checks }) !== receiptDigest) {
    throw new Error('INVALID_W5_14_RECEIPT: digest mismatch');
  }
  const prerequisites = {
    dream: parseCortexCyclePrerequisite(input.prerequisites.dream, 'W5-07'),
    causal: parseCortexCyclePrerequisite(input.prerequisites.causal, 'W5-11'),
    domain: parseCortexCyclePrerequisite(input.prerequisites.domain, 'W5-12'),
    assimilation: parseCortexCyclePrerequisite(
      input.prerequisites.assimilation,
      'W5-13',
    ),
  };
  const expected = cortexCycleChecks({ ...input, prerequisites });
  if (canonical(checks) !== canonical(expected)) {
    throw new Error('INVALID_W5_14_RECEIPT: checks do not match evidence');
  }
  const outcome = Object.values(expected).every(Boolean) ? 'PASS' : 'FAIL';
  if (receipt.outcome !== outcome) {
    throw new Error('INVALID_W5_14_RECEIPT: outcome does not match checks');
  }
  return receipt;
}
