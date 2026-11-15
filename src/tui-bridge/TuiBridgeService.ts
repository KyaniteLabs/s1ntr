import { promises as fs, realpathSync } from 'node:fs';
import { randomBytes, createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { Logger } from '../utils/Logger.js';
import { normalizePath } from '../utils/normalizePath.js';
import { TuiEventStream, type TuiRunEventReplay } from './TuiEventStream.js';
import { TuiSessionStore } from './TuiSessionStore.js';
import { ConversationManager } from '../chat/ConversationManager.js';
import type { LLMClient } from '../llm/LLMClient.js';
import { ensureWave8LivePreSpendInterlockConfigured } from '../llm/PreSpendInterlock.js';
import type { LiminalCreativeCommand } from '../runtime-core/LiminalCommandService.js';
import type { LiminalProductCommandPort, LiminalProductProjection }
  from '../runtime-core/LiminalProductCommandPort.js';
import type { DreamProductCommand, DreamProductCommandPort,
  DreamProductProjection } from '../runtime-core/DreamProductCommandPort.js';
import type { DreamActivationCommand, DreamActivationCommandPort,
  DreamActivationProjection, DreamTransferCommand, DreamTransferCommandPort,
  DreamTransferProjection } from '../runtime-core/DreamTransferActivationPort.js';
import type { CompoundCreateCommand, CompoundCreateProofPort,
  CompoundCreateProjection } from '../runtime-core/CompoundCreateProofPort.js';
import type { TuiBridgeEvent, TuiFailureProvenance, TuiInputRequest, TuiPendingAction, TuiRunExecutor, TuiRunKind, TuiRunLifecycle, TuiRunPhase, TuiSessionStatus } from './types.js';
import { eventBus, EventTypes, type BusEvent } from '../core/EventBus.js';
import { createLLMModeAgent, type LLMSession } from '../harness/agent/index.js';
import { IntentRouter } from '../agent/IntentRouter.js';
import { ModeAwareRouter, PRODUCT_MODES } from '../agent/ProductMode.js';
import type { ModeConfig, ProductMode } from '../agent/ProductMode.js';
import { ModeRegistry } from '../agent/ModeRegistry.js';
import { SkillRunner } from '../agent/SkillRunner.js';
import { SkillCatalog } from '../agent/SkillCatalog.js';
import { ReviewManager } from '../agent/ReviewManager.js';
import { DiffRenderer } from '../agent/DiffRenderer.js';
import { OnboardingWizard } from '../agent/OnboardingWizard.js';
import { EnvironmentValidator } from '../agent/EnvironmentValidator.js';
import { SessionResumer } from '../agent/SessionResumer.js';
import { ReportGenerator } from '../agent/ReportGenerator.js';
import { WorkspaceManager } from '../agent/WorkspaceManager.js';
import { AutonomyController } from '../agent/AutonomyController.js';
import { STUDIO_SYSTEM_PROMPT } from '../agent/StudioAgent.js';
import { SessionGraph } from '../agent/SessionGraph.js';
import { CortexPerceptionBus } from '../cortex/CortexPerceptionBus.js';
import { GoalStore } from '../cortex/GoalStore.js';
import { SinterCortex } from '../cortex/SinterCortex.js';
import {
  CortexLivingLoopConductor,
  FileCortexCycleStore,
  LIVING_LOOP_STEPS,
  type LivingLoopCheckpoint,
  type LivingLoopExecutionContext,
  type LivingLoopExecutionResult,
  type LivingLoopRequest,
  type LivingLoopStep,
  type LivingLoopStepExecutor,
} from '../cortex/CortexLivingLoop.js';
import type { CortexConfig } from '../cortex/types.js';
import { AutonomousGardener, type GardenerCycleResult,
  type GardenerDreamProposal } from '../autonomy/AutonomousGardener.js';
import { DreamQueue } from '../dreaming/DreamQueue.js';
import { UnavailableDreamResearchConsumer }
  from '../dreaming/research/DreamResearchBootstrap.js';
import { DreamArchiveSourceAdmission } from '../dreaming/research/DreamArchiveSourceAdmission.js';
import { createDreamRenderedEvidenceAuthority } from
  '../dreaming/research/DreamResearchEvidence.js';
import { GovernedDreamTaskRunner,
  type DreamAssimilationGovernance,
  type DreamTaskConsumer } from '../dreaming/DreamTaskRunner.js';
import { TasteLearningService } from '../learning/TasteLearningService.js';
import { SinterFS } from '../fs/SinterFS.js';
import { resolveSinterProjectRoot } from '../fs/projectRoot.js';
import { EmergenceHooks } from '../emergence/EmergenceHooks.js';
import { BehaviorDescriptorExtractor } from '../emergence/BehaviorDescriptorExtractor.js';
import type { DescriptorAxis } from '../emergence/types.js';
import {
  buildCreativeDomainRouteTruth,
  type CreativeDomainRouteTruth,
} from './CreativeDomainRouting.js';
import { summarizeReasoningTrace } from './TraceSummarizer.js';
import type { ClarifyResult, GenerationSuccess } from '../core/clarify.js';
import { GeneratorHarnessTools } from '../generators/GeneratorHarnessTools.js';
import {
  injectPreparedGeneration,
  EvaluationAdmissionAuthority,
  PostGenerationCognitiveWriter,
} from './PostGenerationCognitiveWriter.js';
import { emitPreviewArtifacts, type PreviewContext } from './PreviewService.js';

type RetiredDraftResult = ClarifyResult | GenerationSuccess;
interface RetiredDraftGenerator {
  generate(prompt: string, source: string, stream: boolean,
    signal: AbortSignal): Promise<RetiredDraftResult>;
}
interface RetiredDraftTestAdapter {
  create(domain: string): RetiredDraftGenerator;
  score(code: string, domain: string): number;
}
let retiredDraftTestAdapter: RetiredDraftTestAdapter | undefined;
export function installRetiredDraftTestAdapter(adapter: RetiredDraftTestAdapter): void {
  if (process.env.NODE_ENV !== 'test') throw new Error('RETIRED_DRAFT_TEST_ADAPTER_FORBIDDEN');
  retiredDraftTestAdapter = adapter;
}
import { dispatchCommand, type CommandContext } from './CommandDispatcher.js';
import {
  buildCreativeIntentBrief,
  emitIntentBrief,
  emitReasoningTrace,
  emitCreativeClarification,
  emitCreativePreferenceGuidance,
  emitPriorRunReceiptLink,
  promptForCreativeDomain,
  scoreContentAdherence,
  describeStrictDomainMismatch,
  domainCorrectionPrompt,
  type CreativeIntentBrief,
  type IntentEmitContext,
} from './CreativeIntentHelpers.js';
import { detectProviderLabel } from '../config/ProviderRuntime.js';
import { compactLLMErrorProvenance, extractLLMErrorProvenance } from '../llm/ErrorProvenance.js';
import type { CompositionResult, CompositionSpec } from '../composition/CompositionOrchestrator.js';
import type { CompositionRequest } from '../composition/CompositionGraph.js';
import type { CampaignRunAdmission } from '../creative-run/CreativeRunCoordinatorBase.js';
import {
  CreativeRunCoordinator,
  type CreativeRunHandle,
} from '../creative-run/CreativeRunCoordinator.js';
import { CampaignService, type CampaignExecutionInputV1,
  type CampaignTransferEvaluator, type CampaignTransferTarget } from '../creative-run/CampaignService.js';
import {
  exportCampaignTransferTargetSeal,
  restoreCampaignTransferTarget,
} from '../creative-run/CampaignContinuation.js';
import type { CampaignOriginReceiptVerifier } from '../creative-run/CampaignProgressJournal.js';
import type { CampaignClosureEvidenceAuthority } from '../creative-run/CampaignClosure.js';
import type { CampaignLedgerPersistence } from '../creative-run/CampaignPersistence.js';
import type { OwnerAuthorityBootstrapConfig } from '../creative-run/CreativeRunCoordinator.js';
import { bootstrapProductionOwnerReviewHost, resolveOwnerReviewClosureContext,
  type OwnerReviewLifecycleResult } from '../creative-run/OwnerReviewLifecycle.js';
import type { CampaignExecutionPlan, CampaignManifest } from '../creative-run/CampaignManifest.js';
import { continueCampaignStudioJourney, runGovernedCampaignStudioJourney } from './CampaignStudio.js';
import { creativeThesisPromptContext, validateCreativeThesis, type CreativeThesis } from '../creative-intelligence/CreativeIntelligence.js';
import {
  createCoupledStudioArtifact,
  detectWave6Lane,
  type Wave6Lane,
} from '../composition/StudioControlRecipe.js';
import {
  describeStatusLifecycle,
  formatStatusEvidenceLines,
  formatStatusNextAction,
  formatStatusRiskLine,
} from '../types/status.js';
import {
  OwnerReactionCausality,
  OwnerReactionError,
  type OwnerReactionSource,
} from '../runtime-core/OwnerReactionCausality.js';
import { computeProofSourceFingerprint } from '../runtime-core/ProofReceiptValidator.js';
import type { ArtistReviewSurface } from '../cli/ArtistReviewCli.js';
import {
  createArtistReviewSession,
  resolveArtistReviewPromotionCheckpoint,
  type ArtistReviewAction,
  type ArtistReviewActionResult,
  type ArtistReviewSession,
  type ArtistReviewSessionOptions,
  type ArtistReviewState,
} from '../creative-run/ArtistReviewExperience.js';
import type {
  BlindedComparisonJudgment,
  PromotionComparisonPacket,
  TransferPromotionDecision,
  TransferPromotionGateSession,
  TransferPromotionReceipt,
  TransferPromotionReviewerSink,
} from '../creative-run/TransferPromotionGate.js';
import type {
  CampaignEvidenceCheckpoint,
  OwnerAuthorityCapability,
} from '../creative-run/CreativeRunCoordinator.js';
import type { HarnessTransportAuthority } from '../identity/harnessTransportGuard.js';
import { DurableCampaignContinuationContextRegistry } from './DurableCampaignContinuationContext.js';

export type ArtistReviewBootstrapOptions = Omit<ArtistReviewSessionOptions, 'sessionId'> & {
  /** Verified application capability; retained server-side and never accepted over HTTP. */
  readonly promotionReviewerCapability?: OwnerAuthorityCapability;
  /** Test/no-browser host policy; the HTTP client cannot set it. */
  readonly promotionRenderGate?: boolean;
};

interface ArtistReviewBootstrapGrant {
  readonly options: Omit<ArtistReviewSessionOptions, 'sessionId'>;
  readonly promotionReviewerCapability?: OwnerAuthorityCapability;
  readonly promotionRenderGate?: boolean;
  readonly expiresAt: number;
}

export interface TransferPromotionWorkflowState {
  readonly status: 'review-open' | 'awaiting-reviewer' | 'awaiting-owner'
    | 'preferred' | 'rejected' | 'promoted' | 'terminal';
  readonly runId: string;
  readonly packet: PromotionComparisonPacket;
  readonly decision?: TransferPromotionDecision;
  readonly receipt?: TransferPromotionReceipt;
}

interface TransferPromotionWorkflow {
  readonly runId: string;
  readonly gate: TransferPromotionGateSession;
  readonly reviewerSink: TransferPromotionReviewerSink;
  readonly reviewerCapability: OwnerAuthorityCapability;
  readonly ownerCapability: OwnerAuthorityCapability;
  readonly issuerCapability: OwnerAuthorityCapability;
  reviewerJudgment?: BlindedComparisonJudgment;
  ownerJudgment?: { readonly preferredArtifact: 'treatment' | 'control'; readonly claim: string };
  decision?: TransferPromotionDecision;
  receipt?: TransferPromotionReceipt;
}

type TransferPromotionCheckpointKind = 'reviewer' | 'owner' | 'promote';

export interface AuthenticatedBridgeActor {
  readonly principalId: string;
  readonly role: 'owner' | 'issuer' | 'reviewer';
  readonly capability: OwnerAuthorityCapability;
}

/** Production adapter to the host application's authenticated session registry. */
export interface BridgeHostAuthorityRegistry {
  resolveActor(input: {
    readonly sessionId: string;
    readonly credential: string;
  }): AuthenticatedBridgeActor | undefined;
}

export interface IssuedBridgeActionCheckpoint {
  readonly token: string;
  readonly expiresAt: string;
}

/** Max UTF-16 code units of prior-artifact code injected into revision generation prompts. */
const PRIOR_ARTIFACT_EXCERPT_MAX_CHARS = 5000;

function creativeIdentityFields(run: CreativeRunHandle): {
  creativeThesisId?: string;
  creativePrincipleId?: string;
  creativeContractVersion?: number;
  creativeProjectionDigest?: string;
} {
  const principle = run.creativeThesis?.principles[0]?.contractIdentity;
  return principle ? {
    creativeThesisId: run.creativeThesis?.thesisId,
    creativePrincipleId: principle.principleId,
    creativeContractVersion: principle.contractVersion,
    creativeProjectionDigest: principle.projectionDigest,
  } : {};
}

export const TUI_SYSTEM_PROMPT = `You are Sinter's Meta-Harness operator interface.

Primary role:
- Help inspect, debug, repair, and improve the Sinter codebase and harness.
- Treat self-improvement, CI fixes, dogfood diagnostics, TUI fixes, generator hardening, and repo maintenance as first-class tasks.
- You are allowed and expected to discuss how the system should improve itself.

Secondary role:
- Support creative coding requests when the user explicitly asks for art/music/code generation.

Operating rules:
- Be direct and technical.
- Do not refuse self-improvement work or narrow your identity to creative-only help.
- If you do not have tool execution in the current path, say what needs to be inspected or changed rather than pretending it is impossible.
- Prefer root cause, exact files, verification steps, and small patches.
- Generated code is untrusted until verified.`;

/** Keywords that indicate a generation request */
const GENERATION_KEYWORDS = [
  'generate', 'create', 'make', 'sketch', 'draw', 'code',
  'p5', 'three.js', 'shader', 'glsl', 'hydra', 'strudel',
  'visualization', 'animation', 'pattern', 'art',
];

const SELF_IMPROVEMENT_KEYWORDS = [
  'self-improve', 'self improve', 'self-improvement', 'improve itself',
  'fix', 'debug', 'diagnose', 'repair', 'refactor', 'cleanup',
  'harness', 'meta-harness', 'bubble tea', 'tui', 'ci', 'build',
  'test', 'dogfood', 'repo', 'codebase', 'generator hardening',
];

const OPERATOR_INSPECTION_PATTERNS = [
  /\bread-only\b/,
  /\bdo not modify\b/,
  /\bdo not create files?\b/,
  /\bdo not commit\b/,
  /\bdo not push\b/,
  /\buse tool calls only\b/,
  /\btelemetry-friendly\b/,
  /\bdogfood checkpoint\b/,
  /\brepository state\b/,
  /\bprovider\/model truth\b/,
  /\btool schema recovery\b/,
];

/** Check if input indicates repo/harness repair rather than creative generation. */
export function isSelfImprovementRequest(text: string): boolean {
  const lower = text.toLowerCase();
  return SELF_IMPROVEMENT_KEYWORDS.some(kw => lower.includes(kw));
}

/** Check if input is an operator inspection/checkpoint, not creative generation. */
export function isOperatorInspectionRequest(text: string): boolean {
  const lower = text.toLowerCase();
  const matchCount = OPERATOR_INSPECTION_PATTERNS
    .filter(pattern => pattern.test(lower))
    .length;
  return matchCount >= 2;
}

/** Check if input indicates creative generation intent */
export function isGenerationRequest(text: string): boolean {
  if (isSelfImprovementRequest(text)) return false;

  const lower = text.toLowerCase();
  const operatorLike = /\b(fix|debug|diagnose|repair|refactor|cleanup|harness|meta-harness|bubble tea|tui|ci|build|test|dogfood|repo|codebase)\b/.test(lower);
  if (operatorLike) return false;
  return GENERATION_KEYWORDS.some(kw => lower.includes(kw));
}

/** Keep Studio responsive while allowing K3's larger reasoning budget to finish. */
export function resolveDraftCandidateTimeoutMinutes(
  timeoutMinutes: number,
  generatorModelName: string,
): number {
  const providerCap = generatorModelName.toLowerCase().includes('kimi-k3') ? 5 : 3;
  return Math.min(providerCap, timeoutMinutes);
}

function logBridge(event: string, fields: Record<string, unknown>): void {
  Logger.info('TuiBridgeService', `${event} ${JSON.stringify(fields)}`);
}


export class TuiBridgeService {
  private sessions = new TuiSessionStore();
  private stream = new TuiEventStream({ maxStoredEventsPerSession: 500 });
  private activeStreams = new Map<string, AbortController>();
  // Step 1: Conversation memory - one ConversationManager per session
  private conversations = new Map<string, ConversationManager>();
  // Studio routing: intelligent intent classification replaces keyword matching
  private router = new IntentRouter();
  // Session persistence: records every turn per session
  private sessionGraphs = new Map<string, SessionGraph>();
  // Product mode registry: per-session mode biasing
  private modeRegistry = new ModeRegistry();
  // Skill runner: resolves and executes skill templates
  private skillRunner = new SkillRunner();
  // Skill catalog: lists skills with mode filtering
  private skillCatalog = new SkillCatalog();
  // Review manager: candidate lifecycle (accept/reject/pin)
  private reviewManager = new ReviewManager();
  // Diff renderer: unified diff between candidates
  private diffRenderer = new DiffRenderer();
  // Onboarding wizard: provider setup
  private onboardingWizard = new OnboardingWizard();
  // Environment validator: diagnostics
  private envValidator = new EnvironmentValidator();
  // Session resumer: session history
  private sessionResumer = new SessionResumer();
  // Report generator: session reports from SessionGraph data
  private reportGenerator = new ReportGenerator();
  // Workspace manager: workspace CRUD
  private workspaceManager = new WorkspaceManager();
  // Autonomy controller: approval gating per level
  private autonomyController = new AutonomyController();
  // Cortex perception bus: aggregates live system state from EventBus
  private cortexBus = new CortexPerceptionBus(eventBus);
  // Cortex goal store: persists user goals via SinterFS
  private goalStore: GoalStore | null = null;
  // Cortex loop: background executive that fuses perception + goals into actions
  private cortexLoop: SinterCortex | null = null;
  // Autonomous gardener: coordinates taste learning, dream recombination, emergence cycles
  private gardener: AutonomousGardener | null = null;
  // Taste learning service: records preference events and hydrates gardener replay bias.
  private tasteLearningService: TasteLearningService | null = null;
  // Emergence hooks: reads persisted archive experience so the gardener hydrates each cycle
  private emergenceHooks: EmergenceHooks | null = null;
  // Shared SinterFS handle for session persistence/hydration; opened lazily.
  private sinterFs: SinterFS | null = null;
  // Guards one-time hydration of persisted sessions into the resumer.
  private sessionsHydrated = false;
  // Cognitive write-back: memory, compost, and dreaming receipts for Studio generation
  private cognitiveWriter: PostGenerationCognitiveWriter;
  private readonly evaluationAuthority = new EvaluationAdmissionAuthority();
  private readonly dreamRenderedEvidenceAuthority = createDreamRenderedEvidenceAuthority();
  private readonly dreamSourceAdmission = new DreamArchiveSourceAdmission(
    this.dreamRenderedEvidenceAuthority.resolver);
  private readonly governedDreamRunner: DreamTaskConsumer;
  private readonly ownerReactions: OwnerReactionCausality;
  /** Default Gardener configuration */
  private static readonly GARDENER_CONFIG = {
    mode: 'co-create' as const,
    totalBudget: 100,
    stagnationWindow: 10,
    explorationFraction: 0.3,
    replayRatio: 0.4,
    maxConsecutiveReplay: 3,
    maxArchiveTasks: 10,
    replayBiasStrength: 0.7,
    minTasteScore: 0.5,
  };
  /** Default Cortex configuration */
  private static readonly CORTEX_CONFIG: CortexConfig = {
    loopIntervalMs: 30000,   // 30s tick
    maxConsecutiveFailures: 5,
    budgetActionsLimit: 10,
    budgetTokenLimit: 50000,
    autonomyLevel: 'assist',
  };
  /** Interval in ms for cortex snapshot broadcasts (default: 5s) */
  private static readonly CORTEX_BROADCAST_INTERVAL_MS = 5000;
  /** Handle for the cortex broadcast interval (stored for cleanup) */
  private cortexBroadcastTimer: ReturnType<typeof setInterval> | null = null;
  private readonly creativeRunCoordinator: CreativeRunCoordinator;
  private readonly campaignService: CampaignService;
  private readonly campaignDreamQueue: DreamQueue;
  private readonly campaignDreamGovernance?: DreamAssimilationGovernance;
  private readonly creativeRuns = new Map<string, CreativeRunHandle>();
  private readonly artistReviews = new Map<string, ArtistReviewSurface>();
  private readonly authenticArtistReviews = new Map<string, ArtistReviewSession>();
  private readonly artistReviewBootstrapGrants = new Map<string, ArtistReviewBootstrapGrant>();
  private readonly artistActionCheckpoints = new Map<string, Readonly<{
    sessionId: string; principalId: string; ownerCapability: OwnerAuthorityCapability;
    stateDigest: string; scopeDigest: string; expiresAt: number;
  }>>();
  private readonly hostIssuedArtistActions = new Set<string>();
  private readonly promotionReviewers = new Map<string, OwnerAuthorityCapability>();
  private readonly promotionRenderGates = new Map<string, boolean>();
  private readonly transferPromotions = new Map<string, TransferPromotionWorkflow>();
  private readonly transferPromotionCheckpoints = new Map<string, Readonly<{
    sessionId: string; kind: TransferPromotionCheckpointKind;
    principalId: string; runId: string; state: TransferPromotionWorkflowState['status'];
    expiresAt: number;
  }>>();
  /** Campaign admission state; original owner review remains a separate quality gate. */
  private readonly governedOwnerClosures = new Map<string, {
    readonly admission: CampaignRunAdmission;
    readonly manifest: CampaignManifest;
    readonly reviews: ReadonlyMap<string, OwnerReviewLifecycleResult>;
    readonly completedBriefIds: Set<string>;
  }>();
  /** Host-only durable continuation material; HTTP callers can name only the campaign run. */
  private readonly governedContinuations?: DurableCampaignContinuationContextRegistry;
  /** Exact host registration prevents one Artist Review session closing another brief. */
  private readonly governedRevisionDecisionSessions = new Map<string, Map<string, Readonly<{
    readonly sessionId: string;
    readonly revisionEvidenceId: string;
    readonly ownerDecisionEvidenceId: string;
  }>>>();
  private readonly hostAuthorityRegistry?: BridgeHostAuthorityRegistry;
  private readonly campaignPreSpendInstaller: () => void;
  private readonly productCommands?: LiminalProductCommandPort;
  private readonly productCreateCommand?: (input: { prompt: string; domain: string;
    layers: readonly string[]; maxTransportAttempts: number }) =>
      LiminalCreativeCommand | Promise<LiminalCreativeCommand>;
  private readonly dreamCommands?: DreamProductCommandPort;
  private readonly dreamTransferCommands?: DreamTransferCommandPort;
  private readonly dreamActivationCommands?: DreamActivationCommandPort;
  private readonly compoundCreateCommands?: CompoundCreateProofPort;
  private readonly now: () => string;
  private static readonly ACTION_CHECKPOINT_TTL_MS = 2 * 60 * 1_000;
  private static readonly ARTIST_REVIEW_BOOTSTRAP_TTL_MS = 5 * 60 * 1_000;

  constructor(options: {
    cognitiveWriter?: PostGenerationCognitiveWriter;
    livingLoopConductor?: CortexLivingLoopConductor;
    ownerReactions?: OwnerReactionCausality;
    ownerReactionPath?: string;
    creativeRunCoordinator?: CreativeRunCoordinator;
    campaignService?: CampaignService;
    /** Host-authentication configuration used when the bridge composes its coordinator. */
    ownerAuthority?: OwnerAuthorityBootstrapConfig;
    /** Host-owned durable closure registry; never supplied by a bridge request. */
    closureEvidenceAuthority?: CampaignClosureEvidenceAuthority;
    closurePersistence?: CampaignLedgerPersistence;
    progressPersistence?: CampaignLedgerPersistence;
    originVerifier?: CampaignOriginReceiptVerifier;
    transferEvaluator?: CampaignTransferEvaluator;
    executorAuthority?: HarnessTransportAuthority;
    dreamAssimilation?: DreamAssimilationGovernance;
    /** Canonical journal-backed Dream consumer; preferred over the legacy adapter. */
    dreamTaskConsumer?: DreamTaskConsumer;
    dreamQueuePath?: string;
    hostAuthorityRegistry?: BridgeHostAuthorityRegistry;
    /** Construction-only test seam; product requests cannot override this installer. */
    campaignPreSpendInstaller?: () => void;
    /** Narrow shared Create/proposal/projection port; never raw effect authority. */
    productCommands?: LiminalProductCommandPort;
    productCreateCommand?: (input: { prompt: string; domain: string;
      layers: readonly string[]; maxTransportAttempts: number }) =>
        LiminalCreativeCommand | Promise<LiminalCreativeCommand>;
    /** Canonical accepted-evidence research handler; never the legacy Dream queue. */
    dreamCommands?: DreamProductCommandPort;
    dreamTransferCommands?: DreamTransferCommandPort;
    dreamActivationCommands?: DreamActivationCommandPort;
    compoundCreateCommands?: CompoundCreateProofPort;
    now?: () => string;
  } = {}) {
    if (!options.productCommands && process.env.NODE_ENV !== 'test') {
      throw new Error('LIMINAL_PRODUCT_COMMAND_PORT_REQUIRED');
    }
    if (process.env.NODE_ENV !== 'test') bootstrapProductionOwnerReviewHost();
    this.creativeRunCoordinator = options.creativeRunCoordinator
      ?? new CreativeRunCoordinator({ executorAuthority: options.executorAuthority,
        ownerAuthority: options.ownerAuthority });
    this.campaignService = options.campaignService
      ?? CampaignService.shared(this.creativeRunCoordinator, {
        closureEvidenceAuthority: options.closureEvidenceAuthority,
        closurePersistence: options.closurePersistence,
        progressPersistence: options.progressPersistence,
        originVerifier: options.originVerifier,
        transferEvaluator: options.transferEvaluator,
      });
    this.campaignPreSpendInstaller = options.campaignPreSpendInstaller
      ?? ensureWave8LivePreSpendInterlockConfigured;
    this.productCommands = options.productCommands;
    this.productCreateCommand = options.productCreateCommand;
    this.dreamCommands = options.dreamCommands;
    this.dreamTransferCommands = options.dreamTransferCommands;
    this.dreamActivationCommands = options.dreamActivationCommands;
    this.compoundCreateCommands = options.compoundCreateCommands;
    this.governedContinuations = options.progressPersistence
      ? new DurableCampaignContinuationContextRegistry(options.progressPersistence) : undefined;
    const dreamQueue = new DreamQueue({ persistPath: options.dreamQueuePath
      ?? process.env.SINTER_DREAM_QUEUE_PATH
      ?? path.join(os.homedir(), '.sinter', 'dreams', 'queue.json') });
    this.campaignDreamQueue = dreamQueue;
    this.campaignDreamGovernance = options.dreamAssimilation;
    this.governedDreamRunner = options.dreamTaskConsumer
      ?? (options.dreamAssimilation
          ? new GovernedDreamTaskRunner(dreamQueue, this.creativeRunCoordinator,
            options.dreamAssimilation)
          : new UnavailableDreamResearchConsumer());
    this.cognitiveWriter = options.cognitiveWriter ?? new PostGenerationCognitiveWriter({
      dreamQueue, dreamTaskConsumer: this.governedDreamRunner,
      evaluationAuthority: this.evaluationAuthority,
    });
    this.ownerReactions = options.ownerReactions ?? new OwnerReactionCausality({ persistPath: options.ownerReactionPath });
    this.hostAuthorityRegistry = options.hostAuthorityRegistry;
    this.now = options.now ?? (() => new Date().toISOString());
    // Start the Cortex perception bus
    this.cortexBus.start();
    // Broadcast cortex snapshots to all active sessions periodically
    // Uses emitEphemeral so these high-frequency status updates don't grow
    // the per-session event log (codex P1 review feedback).
    this.cortexBroadcastTimer = setInterval(() => {
      const snapshot = this.cortexBus.getSnapshot();
      for (const sessionId of this.sessions.list()) {
        this.stream.publishEphemeral(sessionId, { type: 'cortex.snapshot', sessionId, snapshot });
      }
    }, TuiBridgeService.CORTEX_BROADCAST_INTERVAL_MS);

    // Start the Cortex background executive loop.
    // Fuses perception + goals into priority-ranked actions, emitting
    // cortex.loop_tick, cortex.decision, and cortex.action_proposed events.
    this.cortexLoop = new SinterCortex({
      perceptionBus: this.cortexBus,
      goalStore: {
        getActiveGoals: () => this.getGoalStore()?.getActiveGoals() ?? [],
      },
      config: TuiBridgeService.CORTEX_CONFIG,
      livingLoopConductor: options.livingLoopConductor
        ?? new CortexLivingLoopConductor(new FileCortexCycleStore(
          process.env.SINTER_CORTEX_CYCLE_ROOT
            ?? path.join(process.cwd(), '.omx', 'cortex', 'cycles'),
        )),
      onEvent: (evt) => {
        // Broadcast cortex loop events to all active sessions
        for (const sid of this.sessions.list()) {
          this.stream.publishEphemeral(sid, {
            type: evt.type,
            sessionId: sid,
            tickNumber: evt.tickNumber,
            data: evt.data,
          } as Extract<TuiBridgeEvent, { type: typeof evt.type }>);
        }
        if (evt.type === 'cortex.action_proposed') {
          const briefDigest = createHash('sha256').update(JSON.stringify(evt.data)).digest('hex');
          void this.productCommandPort().propose('cortex', {
            schema: 'sinter.liminal-proposal', schemaVersion: 1,
            idempotencyKey: `studio-cortex:${evt.tickNumber}:${briefDigest}`,
            requestedKind: 'generate-candidate', briefDigest,
            authorityDigest: createHash('sha256').update('studio-cortex-v1').digest('hex'),
          }).catch((error: unknown) => {
            Logger.warn('TuiBridgeService', 'Cortex proposal failed closed:', error);
          });
        }
      },
    });
    this.cortexLoop.start();

    // Start the Autonomous Gardener — coordinates taste learning, dream
    // recombination, and emergence evaluation in the background. Each cycle
    // hydrates the archive from emergence experience persisted to SinterFS by
    // prior creative runs (EmergenceHooks.onCreativeRun), so the garden
    // accumulates instead of starting cold. Empty store → [] (handled gracefully).
    this.gardener = new AutonomousGardener({ ...TuiBridgeService.GARDENER_CONFIG,
      dreamSourceAdmission: this.dreamSourceAdmission,
      proposeDream: proposal => this.proposeGardenerDream(proposal) });
    this.hydrateLatestTasteModel();
    void this.gardener.start(
      () => this.getEmergenceHooks()?.hydrateArchive() ?? [],   // Archive cells hydrated from SinterFS
      () => this.gardenerAxes(),   // The real 6 behavior axes (same source the CLI garden path uses)
      (result: GardenerCycleResult) => {
        for (const sid of this.sessions.list()) {
          this.stream.publishEphemeral(sid, {
            type: 'gardener.cycle',
            sessionId: sid,
            cycle: result.cycle,
            mode: result.mode,
            actions: result.actions,
            budgetRemaining: result.budgetRemaining,
            taskBreakdown: result.taskBreakdown,
            health: result.health,
          });
        }
      },
    ).catch((err) => {
      Logger.warn('TuiBridgeService', 'Gardener background cycle failed:', err);
    });

    // Wire SWARM_ROUND events from the EventBus to all active TUI sessions.
    // External consumers (Bubble Tea client, gallery) receive these via SSE
    // through the existing TuiEventStream subscription mechanism.
    eventBus.onEvent((event) => {
      if (event.type !== EventTypes.SWARM_ROUND) return;
      const data = event.data as {
        round: number;
        totalRounds: number;
        vocabularySize: number;
        winner: string | null;
        converged: boolean;
        outputs: Record<string, unknown>;
        votes: Record<string, unknown>;
        timestamp: number;
      };
      // Broadcast to every active session
      for (const sessionId of this.sessions.list()) {
        this.stream.publish(sessionId, {
          type: 'swarm.round',
          sessionId,
          round: data.round,
          totalRounds: data.totalRounds,
          vocabularySize: data.vocabularySize,
          winner: data.winner,
          converged: data.converged,
          outputs: data.outputs,
          votes: data.votes,
          timestamp: data.timestamp,
        });
      }
    });
  }

  async submitLiminalCreate(surface: 'studio' | 'chat',
    command: LiminalCreativeCommand): Promise<LiminalProductProjection> {
    return this.productCommandPort().submitCreate(surface, command);
  }

  async submitStudioCreate(intent: { prompt: string; domain: string;
    layers: readonly string[] }): Promise<LiminalProductProjection> {
    if (!intent || typeof intent !== 'object' || Array.isArray(intent)
      || Object.keys(intent).some(key => !['prompt', 'domain', 'layers'].includes(key))
      || typeof intent.prompt !== 'string' || !intent.prompt.trim()
      || typeof intent.domain !== 'string' || !intent.domain.trim()
      || !Array.isArray(intent.layers) || intent.layers.length === 0
      || intent.layers.some(layer => typeof layer !== 'string' || !layer.trim())) {
      throw new Error('STUDIO_CREATE_INTENT_INVALID');
    }
    if (!this.productCreateCommand) {
      throw new Error('LIMINAL_PRODUCT_COMMAND_FACTORY_REQUIRED');
    }
    const command = await this.productCreateCommand({ prompt: intent.prompt,
      domain: intent.domain, layers: [...intent.layers], maxTransportAttempts: 2 });
    return this.productCommandPort().submitCreate('studio', command);
  }

  submitDreamResearch(command: DreamProductCommand): Promise<DreamProductProjection> {
    if (!this.dreamCommands) {
      return Promise.reject(new Error('DREAM_PRODUCT_RUNTIME_NOT_CONFIGURED'));
    }
    return this.dreamCommands.run(command);
  }

  submitDreamTransfer(command: DreamTransferCommand): Promise<DreamTransferProjection> {
    if (!this.dreamTransferCommands) {
      return Promise.reject(new Error('DREAM_TRANSFER_RUNTIME_NOT_CONFIGURED'));
    }
    return this.dreamTransferCommands.run(command);
  }

  submitDreamActivation(command: DreamActivationCommand): Promise<DreamActivationProjection> {
    if (!this.dreamActivationCommands) {
      return Promise.reject(new Error('DREAM_ACTIVATION_RUNTIME_NOT_CONFIGURED'));
    }
    return this.dreamActivationCommands.run(command);
  }

  submitCompoundCreate(command: CompoundCreateCommand): Promise<CompoundCreateProjection> {
    if (!this.compoundCreateCommands) {
      return Promise.reject(new Error('COMPOUND_CREATE_RUNTIME_NOT_CONFIGURED'));
    }
    return this.compoundCreateCommands.run(command);
  }

  private productCommandPort(): LiminalProductCommandPort {
    if (!this.productCommands) throw new Error('LIMINAL_PRODUCT_COMMAND_PORT_REQUIRED');
    return this.productCommands;
  }

  private proposeGardenerDream(proposal: GardenerDreamProposal): void {
    const briefDigest = createHash('sha256').update(JSON.stringify(proposal)).digest('hex');
    void this.productCommandPort().propose('gardener', {
      schema: 'sinter.liminal-proposal', schemaVersion: 1,
      idempotencyKey: `studio-gardener:${proposal.key}:${briefDigest}`,
      requestedKind: 'generate-candidate', briefDigest,
      authorityDigest: createHash('sha256').update('studio-gardener-v1').digest('hex'),
    }).catch((error: unknown) => {
      Logger.warn('TuiBridgeService', 'Gardener proposal failed closed:', error);
    });
  }

  readLiminalProjection(idempotencyKey: string): Promise<LiminalProductProjection | null> {
    return this.productCommandPort().projection(idempotencyKey);
  }

  /** Studio composition is one governed Create, observed as a complete rendered work. */
  async composeStudioLayersGoverned(spec: CompositionSpec) {
    if (!this.productCreateCommand) {
      throw new Error('LIMINAL_PRODUCT_COMMAND_FACTORY_REQUIRED');
    }
    const layers = spec.layers.map((layer, index) => ({ index, domain: layer.domain,
      prompt: layer.prompt, ...(layer.code ? { immutableBaseCode: layer.code } : {}),
      blendMode: layer.blendMode ?? 'normal', opacity: layer.opacity ?? 1 }));
    const prompt = ['Create one cohesive playable layered composition.',
      'Preserve any immutableBaseCode exactly and integrate every declared layer.',
      JSON.stringify({ title: spec.title, background: spec.background, layers })].join('\n');
    const command = await this.productCreateCommand({ prompt, domain: 'html',
      layers: layers.map(layer => `${layer.domain}:${layer.blendMode}:${layer.opacity}`),
      maxTransportAttempts: 2 });
    const projection = await this.productCommandPort().submitCreate('studio', command);
    if (projection.kind !== 'create') throw new Error('LIMINAL_COMPOSITION_CREATE_INVALID');
    const artifact = await this.productCommandPort().verifiedArtifact(command.idempotencyKey);
    return { html: artifact.playable, title: spec.title ?? 'Liminal composition',
      successCount: layers.length, coupled: layers.length > 1,
      lineageId: projection.result.lineageId, creativeRun: { readiness: {
        state: 'product-rendered', evidenceDigest: projection.result.evidence.evidenceDigest } },
      layers: layers.map(layer => ({ ...layer, generated: true })),
      renderGate: { verdict: 'ok' as const }, productProjection: projection };
  }

  async composeStudioLayers(
    spec: CompositionRequest,
    options: {
      sessionId?: string;
      provider?: string;
      model?: string;
      requestKey?: string;
      governedCampaign?: {
        readonly manifest: CampaignManifest;
        readonly plan: CampaignExecutionPlan;
        readonly input: CampaignExecutionInputV1;
        readonly ownerReviewBriefIds: readonly string[];
        readonly ownerReviews: Parameters<typeof runGovernedCampaignStudioJourney>[4]['ownerReviews'];
        readonly ownerDecisionClosures?: Parameters<typeof runGovernedCampaignStudioJourney>[4]['ownerDecisionClosures'];
        /** Host-held durable learning evidence locator; never an owner capability. */
        readonly continuation?: {
          readonly learningEvidenceId: string;
          readonly target: CampaignTransferTarget;
        };
      };
    } = {},
  ): Promise<CompositionResult & {
    coupled: boolean;
    lane?: Wave6Lane;
    lineageId: string;
    creativeRun: CreativeRunHandle;
    creativeThesis?: CreativeRunHandle['creativeThesis'];
    recipeDigest?: string;
    campaignEvidenceCheckpoint?: CampaignEvidenceCheckpoint;
    campaignResult?: Awaited<ReturnType<typeof runGovernedCampaignStudioJourney>>['result'];
    ownerReviews?: readonly OwnerReviewLifecycleResult[];
    campaignClosure?: Awaited<ReturnType<typeof runGovernedCampaignStudioJourney>>['closure'];
    campaignContinuation?: Awaited<ReturnType<typeof continueCampaignStudioJourney>>;
  }> {
    const runOptions = { entryPoint: 'studio-layers' as const, sessionId: options.sessionId,
      provider: options.provider, model: options.model, requestKey: options.requestKey };
    let result: Awaited<ReturnType<CreativeRunCoordinator['compose']>>;
    let campaignResult: Awaited<ReturnType<typeof runGovernedCampaignStudioJourney>>['result'] | undefined;
    let ownerReviews: readonly OwnerReviewLifecycleResult[] | undefined;
    let campaignClosure: Awaited<ReturnType<typeof runGovernedCampaignStudioJourney>>['closure'];
    let campaignContinuation: Awaited<ReturnType<typeof continueCampaignStudioJourney>> | undefined;
    if (options.governedCampaign) {
      if (!options.governedCampaign.input
        || !Array.isArray(options.governedCampaign.ownerReviewBriefIds)
        || typeof options.governedCampaign.ownerReviews !== 'function') {
        throw new Error('GOVERNED_STUDIO_OWNER_REVIEW_REQUIRED');
      }
      const governed = await runGovernedCampaignStudioJourney(this.campaignService, runOptions,
        options.governedCampaign.manifest, options.governedCampaign.plan,
        options.governedCampaign, this.campaignPreSpendInstaller);
      campaignResult = governed.result;
      ownerReviews = governed.ownerReviews;
      if (governed.ownerReviews.length === options.governedCampaign.manifest.briefs.length
        && governed.ownerReviews.every((review) => Boolean(review.closureContext))) {
        this.registerGovernedOwnerReviewResults(governed.admission, options.governedCampaign.manifest,
          governed.ownerReviews, Boolean(governed.closure));
      }
      campaignClosure = governed.closure;
      if (options.governedCampaign.continuation) {
        if (!this.campaignDreamGovernance || !campaignResult.campaignEvidenceCheckpoint
          || !this.governedContinuations) {
          throw new Error('GOVERNED_STUDIO_CAMPAIGN_DREAM_CONTEXT_REQUIRED');
        }
        await this.persistGovernedCampaignContinuation({
          manifest: options.governedCampaign.manifest,
          plan: options.governedCampaign.plan,
          checkpoint: campaignResult.campaignEvidenceCheckpoint,
          learningEvidenceId: options.governedCampaign.continuation.learningEvidenceId,
          ownerPrincipalId: options.governedCampaign.manifest.owner.authorityId,
          target: options.governedCampaign.continuation.target,
        });
        campaignContinuation = await continueCampaignStudioJourney(
          this.campaignService, governed.admission, options.governedCampaign.manifest,
          campaignResult.campaignEvidenceCheckpoint,
          options.governedCampaign.continuation.learningEvidenceId,
          options.governedCampaign.continuation.target,
          this.campaignDreamQueue, this.creativeRunCoordinator, this.campaignDreamGovernance,
        );
      }
      const first = campaignResult.executions[0]?.composition;
      if (!first) throw new Error('GOVERNED_STUDIO_CAMPAIGN_RESULT_EMPTY');
      result = { ...first };
    } else {
      result = await this.creativeRunCoordinator.compose(spec, runOptions);
    }
    const lane = detectWave6Lane(result.layers.map((layer) => layer.domain));
    const coupled = lane ? createCoupledStudioArtifact(lane, result) : undefined;
    const lineageId = result.creativeRun.rootRunId;
    const sessionId = options.sessionId ?? `studio-compose-${Date.now()}`;
    const displaySpec = options.governedCampaign?.input.slotGraphs[0]?.graph ?? spec;
    const composedLayers = 'nodes' in displaySpec
      ? displaySpec.nodes.map(node => node.layer) : displaySpec.layers;
    const userText = composedLayers.map((layer) => `${layer.domain}: ${layer.prompt}`).join('\n');
    const html = coupled?.html ?? result.html;

    await this.cognitiveWriter.beginGenerationLineage({
      sessionId,
      lineageId,
      userText,
      domain: 'html',
      executionMode: 'prove',
    });
    await this.cognitiveWriter.writeBackGeneration({
      sessionId,
      lineageId,
      userText,
      domain: 'html',
      code: html,
      finalScore: result.renderGate?.verdict === 'ok' ? 1 : 0,
      iterations: 1,
      model: options.model ?? 'unreported',
      reason: coupled
        ? `Studio composed the ${lane} Wave 6 control recipe`
        : 'Studio composed an uncoupled layered artifact',
      executionMode: 'prove',
      evaluationStatus: result.renderGate?.verdict === 'ok' ? 'observed' : 'unavailable',
      evaluationDetail: result.renderGate
        ? `composition render gate: ${result.renderGate.verdict}`
        : 'composition render gate was unavailable',
      evaluationAdmission: result.renderGate?.verdict === 'ok' ? this.evaluationAuthority.issue({
        artifactDigest: createHash('sha256').update(html).digest('hex'),
        identity: 'valid', confidence: 1, failureClass: 'none',
      }) : undefined,
    });
    if (coupled && lane) {
      await this.cognitiveWriter.recordCompositionContract({
        lineageId,
        lane,
        recipeDigest: coupled.recipeDigest,
        coupled: true,
      });
    }

    return {
      ...result,
      html,
      coupled: Boolean(coupled),
      lane,
      lineageId,
      creativeThesis: result.creativeThesis,
      recipeDigest: coupled?.recipeDigest,
      campaignEvidenceCheckpoint: campaignResult?.campaignEvidenceCheckpoint,
      campaignResult,
      ownerReviews,
      ...(campaignClosure ? { campaignClosure } : {}),
      ...(campaignContinuation ? { campaignContinuation } : {}),
    };
  }

  createSession(
    patch: Partial<Pick<TuiSessionStatus, 'provider' | 'model' | 'roles' | 'evaluation'>> = {},
    artistReviewGrant?: string,
  ): TuiSessionStatus {
    const sessionId = `tui-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const artistReviewSurface = artistReviewGrant
      ? this.claimArtistReviewBootstrap(artistReviewGrant, sessionId) : undefined;
    const ownerSession = this.ownerReactions.openSession(sessionId);

    // Initialize conversation manager for this session
    const conversation = new ConversationManager();
    conversation.startNewSession();
    this.conversations.set(sessionId, conversation);

    // Initialize session graph for turn persistence. Pass SinterFS so turns
    // persist to disk and survive restarts (read back by SessionResumer.hydrate).
    const graph = new SessionGraph(sessionId, this.getSinterFS() ?? undefined);
    this.sessionGraphs.set(sessionId, graph);

    // Register with session resumer for /sessions command
    this.sessionResumer.register(sessionId, graph);

    const status = this.sessions.create({
      sessionId,
      ownerSession,
      mode: 'chat',
      provider: patch.provider,
      model: patch.model,
      roles: patch.roles,
      evaluation: patch.evaluation,
      trust: { level: 'untrusted', label: 'Generated code is untrusted by default' },
    });
    if (artistReviewSurface) this.registerArtistReview(sessionId, artistReviewSurface);
    return status;
  }

  getStatus(sessionId: string): TuiSessionStatus {
    const status = this.sessions.get(sessionId);
    if (!status) throw new Error(`Unknown TUI session: ${sessionId}`);
    return status;
  }

  registerArtistReview(sessionId: string, surface: ArtistReviewSurface): ArtistReviewState {
    this.getStatus(sessionId);
    this.artistReviews.set(sessionId, surface);
    const state = surface.state();
    this.emit(sessionId, {
      type: 'artist.review_state', sessionId,
      stateDigest: state.stateDigest, decisionVersion: state.decisionVersion,
    });
    return state;
  }

  /**
   * Host-only handoff for a coordinator-created revision-comparison session.
   * The bridge retains the exact authenticated object; a caller cannot replace
   * it with a serialized surface or caller-authored review evidence.
   */
  registerAuthenticArtistReview(sessionId: string, review: ArtistReviewSession): ArtistReviewState {
    this.getStatus(sessionId);
    const existing = this.authenticArtistReviews.get(sessionId);
    if (existing && existing !== review) throw new Error('ARTIST_REVIEW_SESSION_IMMUTABLE');
    this.authenticArtistReviews.set(sessionId, review);
    return this.registerArtistReview(sessionId, review);
  }

  /** Host-only governed handoff; each result must carry a real sealed owner-review context. */
  registerGovernedOwnerReviewResults(
    admission: CampaignRunAdmission,
    manifest: CampaignManifest,
    reviews: readonly OwnerReviewLifecycleResult[],
    alreadyClosed = false,
  ): void {
    const expected = manifest.briefs.map((brief) => brief.id);
    if (reviews.length !== expected.length
      || new Set(reviews.map((review) => review.packet.briefId)).size !== expected.length
      || expected.some((briefId) => !reviews.some((review) => review.packet.briefId === briefId))) {
      throw new Error('GOVERNED_OWNER_CLOSURE_REVIEW_COVERAGE_INVALID');
    }
    for (const review of reviews) {
      const context = resolveOwnerReviewClosureContext(review.closureContext);
      if (context.briefId !== review.packet.briefId || context.packetDigest !== review.packet.packetDigest) {
        throw new Error('GOVERNED_OWNER_CLOSURE_REVIEW_PROVENANCE_INVALID');
      }
    }
    const existing = this.governedOwnerClosures.get(manifest.campaignRunId);
    if (existing && (existing.admission !== admission || existing.manifest !== manifest)) {
      throw new Error('GOVERNED_OWNER_CLOSURE_CONTEXT_IMMUTABLE');
    }
    this.governedOwnerClosures.set(manifest.campaignRunId, {
      admission, manifest, reviews: new Map(reviews.map((review) => [review.packet.briefId, review])),
      completedBriefIds: new Set(alreadyClosed ? expected : []),
    });
  }

  /** Host-only registration seam. Private target bytes are persisted but never returned. */
  async registerGovernedCampaignContinuationForHost(input: {
    readonly sessionId: string;
    readonly ownerCredential: string;
    readonly manifest: CampaignManifest;
    readonly plan: CampaignExecutionPlan;
    readonly checkpoint: CampaignEvidenceCheckpoint;
    readonly learningEvidenceId: string;
    readonly target: CampaignTransferTarget;
  }): Promise<void> {
    if (!this.governedContinuations) {
      throw new Error('GOVERNED_CAMPAIGN_CONTINUATION_PERSISTENCE_REQUIRED');
    }
    this.getStatus(input.sessionId);
    const owner = this.resolveHostActor(input.sessionId, input.ownerCredential, 'owner');
    if (owner.principalId !== input.manifest.owner.authorityId) {
      throw new Error('GOVERNED_CAMPAIGN_CONTINUATION_OWNER_MISMATCH');
    }
    await this.persistGovernedCampaignContinuation({ manifest: input.manifest, plan: input.plan,
      checkpoint: input.checkpoint, learningEvidenceId: input.learningEvidenceId,
      target: input.target, ownerPrincipalId: owner.principalId });
  }

  private async persistGovernedCampaignContinuation(input: {
    readonly manifest: CampaignManifest;
    readonly plan: CampaignExecutionPlan;
    readonly checkpoint: CampaignEvidenceCheckpoint;
    readonly learningEvidenceId: string;
    readonly ownerPrincipalId: string;
    readonly target: CampaignTransferTarget;
  }): Promise<void> {
    if (!this.governedContinuations) {
      throw new Error('GOVERNED_CAMPAIGN_CONTINUATION_PERSISTENCE_REQUIRED');
    }
    await this.governedContinuations.register({ manifest: input.manifest, plan: input.plan,
      checkpoint: input.checkpoint, learningEvidenceId: input.learningEvidenceId,
      ownerPrincipalId: input.ownerPrincipalId,
      targetSeal: exportCampaignTransferTargetSeal(input.target) });
  }

  /** Authenticated product surface for the exact server-registered continuation. */
  async continueGovernedCampaign(
    sessionId: string,
    ownerCredential: string,
    campaignRunId: string,
  ) {
    this.getStatus(sessionId);
    const owner = this.resolveHostActor(sessionId, ownerCredential, 'owner');
    if (!this.governedContinuations) {
      throw new Error('GOVERNED_CAMPAIGN_CONTINUATION_CONTEXT_MISSING');
    }
    const context = await this.governedContinuations.resolve(campaignRunId);
    if (owner.principalId !== context.ownerPrincipalId
      || owner.principalId !== context.ownerAuthorityId) {
      throw new Error('GOVERNED_CAMPAIGN_CONTINUATION_OWNER_MISMATCH');
    }
    if (!this.campaignDreamGovernance) {
      throw new Error('GOVERNED_STUDIO_CAMPAIGN_DREAM_CONTEXT_REQUIRED');
    }
    const admission = await this.campaignService.startCampaign({ entryPoint: 'studio-layers',
      requestKey: context.campaignRunId }, context.manifest, context.plan);
    if (admission.creativeRun.rootRunId !== context.rootRunId
      || admission.manifestDigest !== context.manifestDigest
      || admission.planDigest !== context.planDigest
      || admission.fundingReservation.reservationDigest !== context.fundingReservationDigest) {
      throw new Error('GOVERNED_CAMPAIGN_CONTINUATION_CONTEXT_INVALID');
    }
    const target = restoreCampaignTransferTarget(context.manifest, context.targetSeal);
    return continueCampaignStudioJourney(this.campaignService, admission,
      context.manifest, context.checkpoint, context.learningEvidenceId, target,
      this.campaignDreamQueue, this.creativeRunCoordinator, this.campaignDreamGovernance);
  }

  /** In-process W8 pipeline handoff. HTTP clients receive only the opaque bearer grant. */
  issueArtistReviewBootstrap(options: ArtistReviewBootstrapOptions): string {
    const { promotionReviewerCapability, promotionRenderGate, ...sessionOptions } = options;
    createArtistReviewSession({ ...sessionOptions, sessionId: 'bootstrap-validation' });
    const grant = randomBytes(32).toString('base64url');
    this.artistReviewBootstrapGrants.set(grant, {
      options: sessionOptions,
      ...(promotionReviewerCapability ? { promotionReviewerCapability } : {}),
      ...(promotionRenderGate !== undefined ? { promotionRenderGate } : {}),
      expiresAt: Date.now() + TuiBridgeService.ARTIST_REVIEW_BOOTSTRAP_TTL_MS,
    });
    return grant;
  }

  private claimArtistReviewBootstrap(grant: string, sessionId: string): ArtistReviewSession {
    const staged = this.artistReviewBootstrapGrants.get(grant);
    this.artistReviewBootstrapGrants.delete(grant);
    if (!staged || staged.expiresAt <= Date.now()) {
      throw new Error('ARTIST_REVIEW_BOOTSTRAP_GRANT_INVALID');
    }
    const session = createArtistReviewSession({ ...staged.options, sessionId });
    this.authenticArtistReviews.set(sessionId, session);
    if (staged.promotionReviewerCapability) {
      this.promotionReviewers.set(sessionId, staged.promotionReviewerCapability);
    }
    if (staged.promotionRenderGate !== undefined) {
      this.promotionRenderGates.set(sessionId, staged.promotionRenderGate);
    }
    return session;
  }

  private resolveHostActor(
    sessionId: string,
    credential: string,
    role: AuthenticatedBridgeActor['role'],
  ): AuthenticatedBridgeActor {
    if (!this.hostAuthorityRegistry || !credential.trim()) {
      throw new Error('BRIDGE_HOST_AUTHENTICATION_REQUIRED');
    }
    const actor = this.hostAuthorityRegistry.resolveActor({ sessionId, credential });
    if (!actor || actor.role !== role || !actor.principalId.trim()) {
      throw new Error('BRIDGE_HOST_ACTOR_ROLE_INVALID');
    }
    const verified = this.creativeRunCoordinator.verifyOwnerAuthorityCapability(
      actor.capability, role,
    );
    if (verified.id !== actor.principalId || verified.role !== actor.role) {
      throw new Error('BRIDGE_HOST_ACTOR_IDENTITY_INVALID');
    }
    return actor;
  }

  /** Real host-authenticated issuance route; capabilities never leave this process. */
  issueArtistReviewActionCheckpoint(
    sessionId: string,
    ownerCredential: string,
    action: ArtistReviewAction,
    issuerCredential?: string,
  ): IssuedBridgeActionCheckpoint {
    this.getStatus(sessionId);
    const session = this.authenticArtistReviews.get(sessionId);
    if (!session) throw new Error(`Authentic artist review not found for session: ${sessionId}`);
    const owner = this.resolveHostActor(sessionId, ownerCredential, 'owner');
    const issuer = action.kind === 'learning'
      ? this.resolveHostActor(sessionId, issuerCredential ?? '', 'issuer') : undefined;
    if (issuer && issuer.principalId === owner.principalId) {
      throw new Error('BRIDGE_HOST_ACTOR_SEPARATION_REQUIRED');
    }
    const expiresAt = new Date(
      Date.parse(this.now()) + TuiBridgeService.ACTION_CHECKPOINT_TTL_MS,
    ).toISOString();
    const token = session.issueActionToken(action, {
      ownerCapability: owner.capability,
      ...(issuer ? { issuerCapability: issuer.capability } : {}),
    }, expiresAt);
    this.artistActionCheckpoints.set(token, Object.freeze({
      sessionId, principalId: owner.principalId, ownerCapability: owner.capability,
      stateDigest: session.state().stateDigest,
      scopeDigest: session.actionCheckpointScope(token),
      expiresAt: Date.parse(expiresAt),
    }));
    this.hostIssuedArtistActions.add(token);
    return Object.freeze({ token, expiresAt });
  }

  /** Host-derived revision release target; unavailable until blind preference succeeds. */
  issueArtistReviewReleaseCheckpoint(
    sessionId: string,
    ownerCredential: string,
    decision: 'release-worthy' | 'not-release-worthy',
  ): IssuedBridgeActionCheckpoint {
    const artist = this.authenticArtistReviews.get(sessionId);
    if (!artist) throw new Error('ARTIST_REVIEW_RELEASE_TARGET_NOT_READY');
    return this.issueArtistReviewActionCheckpoint(
      sessionId, ownerCredential, artist.hostDerivedReleaseAction(decision),
    );
  }

  getArtistReviewState(sessionId: string): ArtistReviewState {
    this.getStatus(sessionId);
    const surface = this.artistReviews.get(sessionId);
    if (!surface) throw new Error(`Artist review not found for session: ${sessionId}`);
    return surface.state();
  }

  executeArtistReviewAction(
    sessionId: string,
    token: string,
    ownerCredential?: string,
  ): ArtistReviewActionResult {
    this.getStatus(sessionId);
    const surface = this.artistReviews.get(sessionId);
    if (!surface) throw new Error(`Artist review not found for session: ${sessionId}`);
    if (this.hostIssuedArtistActions.has(token)) {
      const checkpoint = this.artistActionCheckpoints.get(token);
      this.artistActionCheckpoints.delete(token);
      if (!checkpoint || checkpoint.sessionId !== sessionId
        || Date.parse(this.now()) >= checkpoint.expiresAt
        || surface.state().stateDigest !== checkpoint.stateDigest) {
        throw new Error('ARTIST_REVIEW_ACTION_CHECKPOINT_INVALID');
      }
      const owner = this.resolveHostActor(sessionId, ownerCredential ?? '', 'owner');
      const authentic = this.authenticArtistReviews.get(sessionId);
      if (!authentic || owner.principalId !== checkpoint.principalId
        || owner.capability !== checkpoint.ownerCapability
        || authentic.actionCheckpointScope(token) !== checkpoint.scopeDigest) {
        throw new Error('ARTIST_REVIEW_ACTION_CHECKPOINT_INVALID');
      }
    }
    const result = surface.executeAction(token);
    this.emit(sessionId, {
      type: 'artist.review_state', sessionId,
      stateDigest: result.state.stateDigest,
      decisionVersion: result.state.decisionVersion,
      feedback: result.feedback,
    });
    return result;
  }

  /**
   * Finish one registered governed brief after its real host-authenticated
   * two-artifact revision-comparison actions.
   */
  async finalizeGovernedCampaignOwnerDecision(
    sessionId: string,
    ownerCredential: string,
    input: { readonly campaignRunId: string; readonly briefId: string },
  ): Promise<Readonly<{ readonly closed: boolean;
    readonly record: Awaited<ReturnType<CampaignService['recordRevisionClosure']>>;
    readonly closure?: Awaited<ReturnType<CampaignService['closeCampaignClosure']>> }>> {
    this.getStatus(sessionId);
    this.resolveHostActor(sessionId, ownerCredential, 'owner');
    const artist = this.authenticArtistReviews.get(sessionId);
    const governed = this.governedOwnerClosures.get(input.campaignRunId);
    const registered = this.governedRevisionDecisionSessions
      .get(input.campaignRunId)?.get(input.briefId);
    if (!artist || !governed || !governed.reviews.has(input.briefId)) {
      throw new Error('GOVERNED_OWNER_CLOSURE_CONTEXT_MISSING');
    }
    if (!registered || registered.sessionId !== sessionId) {
      throw new Error('GOVERNED_OWNER_CLOSURE_SESSION_BINDING_INVALID');
    }
    const originalReview = governed.reviews.get(input.briefId)!;
    const record = await this.campaignService.finalizeOwnerDecisionClosure(
      governed.admission, governed.manifest, {
        briefId: input.briefId, revisionEvidenceId: registered.revisionEvidenceId,
        ownerDecisionEvidenceId: registered.ownerDecisionEvidenceId, checkpoint: artist.closureCheckpoint(),
        originalOwnerReview: originalReview.closureContext,
      },
    );
    governed.completedBriefIds.add(input.briefId);
    const complete = governed.completedBriefIds.size === governed.manifest.briefs.length;
    const closure = complete
      ? await this.campaignService.closeCampaignClosure(governed.admission, governed.manifest) : undefined;
    return Object.freeze({ closed: complete, record, ...(closure ? { closure } : {}) });
  }

  /**
   * Start the real two-artifact owner comparison from the host-sealed
   * attributable revision input. Transport callers name an evidence ID only;
   * this bridge resolves the opaque live witness and keeps the resulting
   * ArtistReviewSession entirely server-side.
   */
  async startGovernedCampaignOwnerDecisionComparison(
    sessionId: string,
    ownerCredential: string,
    input: { readonly campaignRunId: string; readonly briefId: string;
      readonly revisionEvidenceId: string },
  ): Promise<ArtistReviewState> {
    this.getStatus(sessionId);
    this.resolveHostActor(sessionId, ownerCredential, 'owner');
    const governed = this.governedOwnerClosures.get(input.campaignRunId);
    if (!governed || !governed.reviews.has(input.briefId)) {
      throw new Error('GOVERNED_OWNER_CLOSURE_CONTEXT_MISSING');
    }
    const existing = this.governedRevisionDecisionSessions
      .get(input.campaignRunId)?.get(input.briefId);
    if (existing && existing.sessionId !== sessionId) {
      throw new Error('GOVERNED_OWNER_CLOSURE_SESSION_IMMUTABLE');
    }
    const existingReview = this.authenticArtistReviews.get(sessionId);
    if (existing || existingReview) {
      if (!existing || existing.revisionEvidenceId !== input.revisionEvidenceId || !existingReview) {
        throw new Error('GOVERNED_OWNER_CLOSURE_REVISION_IMMUTABLE');
      }
      return existingReview.state();
    }
    const revision = await this.campaignService.resolveRevisionDecisionInput(
      governed.admission, governed.manifest, {
        briefId: input.briefId, revisionEvidenceId: input.revisionEvidenceId,
      },
    );
    const artist = this.creativeRunCoordinator.createRevisionDecisionArtistReviewSession({
      sessionId, plan: revision.plan, revision: revision.revision,
      independentBlindPreference: revision.blindPreference,
    });
    const state = this.registerArtistReview(sessionId, artist);
    const ownerDecisionEvidenceId = 'owner-decision-' + createHash('sha256')
      .update(input.campaignRunId + '\u0000' + input.briefId + '\u0000' + input.revisionEvidenceId)
      .digest('hex');
    const sessions = this.governedRevisionDecisionSessions.get(input.campaignRunId) ?? new Map();
    sessions.set(input.briefId, Object.freeze({
      sessionId, revisionEvidenceId: input.revisionEvidenceId, ownerDecisionEvidenceId,
    }));
    this.authenticArtistReviews.set(sessionId, artist);
    this.governedRevisionDecisionSessions.set(input.campaignRunId, sessions);
    return state;
  }

  /** @deprecated Production callers must use startGovernedCampaignOwnerDecisionComparison. */
  registerGovernedRevisionDecisionSession(
    sessionId: string,
    campaignRunId: string,
    briefId: string,
  ): void {
    this.getStatus(sessionId);
    if (!this.authenticArtistReviews.has(sessionId)
      || !this.governedOwnerClosures.get(campaignRunId)?.reviews.has(briefId)) {
      throw new Error('GOVERNED_OWNER_CLOSURE_CONTEXT_MISSING');
    }
    const sessions = this.governedRevisionDecisionSessions.get(campaignRunId) ?? new Map();
    const existing = sessions.get(briefId);
    if (existing && existing.sessionId !== sessionId) throw new Error('GOVERNED_OWNER_CLOSURE_SESSION_IMMUTABLE');
    if (!existing) throw new Error('GOVERNED_OWNER_CLOSURE_START_REQUIRED');
    this.governedRevisionDecisionSessions.set(campaignRunId, sessions);
  }

  async startTransferPromotion(
    sessionId: string,
    ownerCredential?: string,
  ): Promise<TransferPromotionWorkflowState> {
    this.getStatus(sessionId);
    const owner = this.resolveHostActor(sessionId, ownerCredential ?? '', 'owner');
    const existing = this.transferPromotions.get(sessionId);
    if (existing) {
      if (owner.capability !== existing.ownerCapability) {
        throw new Error('TRANSFER_PROMOTION_CHECKPOINT_AUTHORITY_INVALID');
      }
      return this.getTransferPromotionState(sessionId);
    }
    const artist = this.authenticArtistReviews.get(sessionId);
    const reviewerCapability = this.promotionReviewers.get(sessionId);
    if (!artist || !reviewerCapability) {
      throw new Error('TRANSFER_PROMOTION_AUTHENTIC_REVIEW_REQUIRED');
    }
    const checkpoint = artist.promotionCheckpoint();
    const authority = resolveArtistReviewPromotionCheckpoint(checkpoint);
    if (owner.capability !== authority.ownerCapability) {
      throw new Error('TRANSFER_PROMOTION_CHECKPOINT_AUTHORITY_INVALID');
    }
    const experiment = await this.creativeRunCoordinator.openTransferPromotionExperiment(
      checkpoint,
      { renderGate: this.promotionRenderGates.get(sessionId) ?? true },
    );
    const reviewerSink = experiment.gate.openReviewerSink(reviewerCapability);
    this.transferPromotions.set(sessionId, {
      runId: experiment.runId,
      gate: experiment.gate,
      reviewerSink,
      reviewerCapability,
      ownerCapability: authority.ownerCapability,
      issuerCapability: authority.issuerCapability,
    });
    return this.getTransferPromotionState(sessionId);
  }

  issueTransferPromotionCheckpointForHost(
    sessionId: string,
    kind: TransferPromotionCheckpointKind,
    credential: string,
  ): IssuedBridgeActionCheckpoint {
    const workflow = this.transferPromotions.get(sessionId);
    if (!workflow) throw new Error(`Transfer promotion not found for session: ${sessionId}`);
    const role = kind === 'reviewer' ? 'reviewer' : 'owner';
    const actor = this.resolveHostActor(sessionId, credential, role);
    const expected = kind === 'reviewer'
      ? workflow.reviewerCapability : workflow.ownerCapability;
    if (actor.capability !== expected) {
      throw new Error('TRANSFER_PROMOTION_CHECKPOINT_AUTHORITY_INVALID');
    }
    const state = this.getTransferPromotionState(sessionId);
    if ((kind === 'reviewer' && workflow.reviewerJudgment)
      || (kind === 'owner' && workflow.ownerJudgment)
      || (kind === 'promote' && (!workflow.decision
        || workflow.decision.status !== 'preferred' || workflow.receipt))) {
      throw new Error('TRANSFER_PROMOTION_CHECKPOINT_STATE_INVALID');
    }
    const token = randomBytes(32).toString('base64url');
    const expiresAtMs = Date.parse(this.now()) + TuiBridgeService.ACTION_CHECKPOINT_TTL_MS;
    this.transferPromotionCheckpoints.set(token, Object.freeze({
      sessionId, kind, principalId: actor.principalId,
      runId: workflow.runId, state: state.status, expiresAt: expiresAtMs,
    }));
    return Object.freeze({ token, expiresAt: new Date(expiresAtMs).toISOString() });
  }

  executeTransferPromotionCheckpoint(sessionId: string, input: {
    readonly token: string;
    readonly preferredBlindId?: string;
    readonly preferredArtifact?: 'treatment' | 'control';
    readonly claim?: string;
  }, credential: string): TransferPromotionWorkflowState {
    this.getStatus(sessionId);
    const workflow = this.transferPromotions.get(sessionId);
    const checkpoint = this.transferPromotionCheckpoints.get(input.token);
    if (!workflow || !checkpoint || checkpoint.sessionId !== sessionId) {
      throw new Error('TRANSFER_PROMOTION_CHECKPOINT_INVALID');
    }
    this.transferPromotionCheckpoints.delete(input.token);
    if (Date.parse(this.now()) >= checkpoint.expiresAt
      || checkpoint.runId !== workflow.runId
      || checkpoint.state !== this.getTransferPromotionState(sessionId).status) {
      throw new Error('TRANSFER_PROMOTION_CHECKPOINT_STALE');
    }
    const role = checkpoint.kind === 'reviewer' ? 'reviewer' : 'owner';
    const actor = this.resolveHostActor(sessionId, credential, role);
    if (actor.principalId !== checkpoint.principalId) {
      throw new Error('TRANSFER_PROMOTION_CHECKPOINT_ACTOR_MISMATCH');
    }
    if (checkpoint.kind === 'reviewer') {
      if (workflow.reviewerJudgment || typeof input.preferredBlindId !== 'string'
        || typeof input.claim !== 'string') {
        throw new Error('TRANSFER_PROMOTION_REVIEWER_CHECKPOINT_INVALID');
      }
      workflow.reviewerJudgment = workflow.reviewerSink.submit({
        preferredBlindId: input.preferredBlindId, claim: input.claim,
      });
    } else if (checkpoint.kind === 'owner') {
      if (workflow.ownerJudgment || (input.preferredArtifact !== 'treatment'
        && input.preferredArtifact !== 'control') || typeof input.claim !== 'string'
        || !input.claim.trim()) {
        throw new Error('TRANSFER_PROMOTION_OWNER_CHECKPOINT_INVALID');
      }
      workflow.ownerJudgment = Object.freeze({
        preferredArtifact: input.preferredArtifact, claim: input.claim.trim(),
      });
    } else {
      if (!workflow.decision || workflow.receipt) {
        throw new Error('TRANSFER_PROMOTION_PROMOTE_CHECKPOINT_INVALID');
      }
      workflow.receipt = workflow.gate.promote(workflow.decision, {
        ownerCapability: workflow.ownerCapability,
        sourceCapability: workflow.issuerCapability,
      });
      return this.getTransferPromotionState(sessionId);
    }
    if (workflow.reviewerJudgment && workflow.ownerJudgment && !workflow.decision) {
      workflow.decision = workflow.gate.evaluate({
        blindedJudgment: workflow.reviewerJudgment,
        ownerCapability: workflow.ownerCapability,
        ownerJudgment: workflow.ownerJudgment,
      });
    }
    return this.getTransferPromotionState(sessionId);
  }

  getTransferPromotionState(sessionId: string): TransferPromotionWorkflowState {
    this.getStatus(sessionId);
    const workflow = this.transferPromotions.get(sessionId);
    if (!workflow) throw new Error(`Transfer promotion not found for session: ${sessionId}`);
    const status: TransferPromotionWorkflowState['status'] = workflow.receipt
      ? workflow.receipt.status === 'promoted' ? 'promoted' : 'terminal'
      : workflow.decision
        ? workflow.decision.status === 'preferred' ? 'preferred' : 'rejected'
        : workflow.reviewerJudgment && !workflow.ownerJudgment
          ? 'awaiting-owner'
          : workflow.ownerJudgment && !workflow.reviewerJudgment
            ? 'awaiting-reviewer' : 'review-open';
    return Object.freeze({
      status, runId: workflow.runId, packet: workflow.reviewerSink.packet,
      ...(workflow.decision ? { decision: workflow.decision } : {}),
      ...(workflow.receipt ? { receipt: workflow.receipt } : {}),
    });
  }

  getTransferPromotionDecision(sessionId: string): TransferPromotionDecision {
    this.getStatus(sessionId);
    const decision = this.transferPromotions.get(sessionId)?.decision;
    if (!decision) throw new Error(`Transfer promotion decision not found for session: ${sessionId}`);
    return decision;
  }

  getEvents(sessionId: string): TuiBridgeEvent[] {
    return this.stream.history(sessionId);
  }

  conductLivingLoop(
    sessionId: string,
    request: LivingLoopRequest,
    actorId: string,
    executor: LivingLoopStepExecutor,
  ): Promise<LivingLoopCheckpoint> {
    if (!this.sessions.get(sessionId)) {
      throw new Error(`Unknown TUI session: ${sessionId}`);
    }
    if (!this.cortexLoop) throw new Error('CORTEX_LIVING_LOOP_NOT_CONFIGURED');
    for (const step of LIVING_LOOP_STEPS) {
      this.emitLivingLoopEvent(sessionId, request, actorId, step, {
        state: 'queued', disposition: 'proposed', budget: request.budgets,
      });
    }
    const observed: LivingLoopStepExecutor = {
      execute: context => this.executeLivingLoopStep(
        sessionId, request, actorId, executor, context, false,
      ),
      recover: context => this.executeLivingLoopStep(
        sessionId, request, actorId, executor, context, true,
      ),
    };
    return this.cortexLoop.conductLivingLoop(request, actorId, observed);
  }

  private async executeLivingLoopStep<T extends LivingLoopExecutionResult | null>(
    sessionId: string,
    request: LivingLoopRequest,
    actorId: string,
    executor: LivingLoopStepExecutor,
    context: LivingLoopExecutionContext,
    recovering: boolean,
  ): Promise<T> {
    this.emitLivingLoopEvent(sessionId, request, actorId, context.step, {
      state: 'running', disposition: 'proposed', budget: context.remaining,
    });
    try {
      const result = await (recovering
        ? executor.recover(context)
        : executor.execute(context)) as T;
      this.emitLivingLoopEvent(sessionId, request, actorId, context.step, {
        state: result ? 'completed' : 'failed',
        disposition: result ? 'executed' : 'proposed',
        budget: context.remaining,
        result,
        errorClass: result ? null : 'recovery-required',
      });
      return result;
    } catch (error) {
      this.emitLivingLoopEvent(sessionId, request, actorId, context.step, {
        state: 'failed', disposition: 'proposed', budget: context.remaining,
        errorClass: error instanceof Error ? error.name : 'unknown-error',
      });
      throw error;
    }
  }

  private emitLivingLoopEvent(
    sessionId: string,
    request: LivingLoopRequest,
    actorId: string,
    step: LivingLoopStep,
    input: {
      state: 'queued' | 'running' | 'completed' | 'failed';
      disposition: 'proposed' | 'executed';
      budget: LivingLoopRequest['budgets'];
      result?: LivingLoopExecutionResult | null;
      errorClass?: string | null;
    },
  ): void {
    this.emit(sessionId, {
      type: 'cortex.action_lifecycle',
      sessionId,
      cycleId: request.cycleId,
      lineageId: request.lineageId,
      step,
      state: input.state,
      disposition: input.disposition,
      actorId,
      sourceFingerprint: request.sourceFingerprint,
      budget: { ...input.budget },
      effectIds: input.result?.effects.map(effect => effect.id) ?? [],
      artifactRefs: [...(input.result?.receiptRefs ?? [])],
      errorClass: input.errorClass ?? null,
      timestamp: new Date().toISOString(),
    });
  }

  getEventReplay(): TuiRunEventReplay {
    return this.stream;
  }

  updateStatus(sessionId: string, patch: Partial<TuiSessionStatus>): TuiSessionStatus {
    const status = this.sessions.update(sessionId, patch);
    this.emit(sessionId, { type: 'status.updated', sessionId, status });
    return status;
  }

  private publishResolvedGeneratorModel(
    sessionId: string,
    provider: string,
    baseUrl: string,
    model: string,
  ): void {
    const status = this.sessions.get(sessionId);
    if (!status) return;
    const roles = status.roles ? { ...status.roles } : undefined;
    if (roles?.generator) {
      roles.generator = { ...roles.generator, provider, baseUrl, model };
    }
    if (roles?.harness) {
      roles.harness = { ...roles.harness, provider, baseUrl, model };
    }
    this.updateStatus(sessionId, { provider, model, roles });
  }

  private beginRun(
    sessionId: string,
    details: {
      kind: TuiRunKind;
      label: string;
      executionMode?: 'draft' | 'prove';
      executor?: TuiRunExecutor;
      model?: string;
      provider?: string;
      runId?: string;
    },
  ): TuiRunLifecycle {
    const now = new Date().toISOString();
    const run: TuiRunLifecycle = {
      runId: details.runId ?? `run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      kind: details.kind,
      phase: 'queued',
      label: details.label,
      startedAt: now,
      updatedAt: now,
      executionMode: details.executionMode,
      executor: details.executor,
      model: details.model,
      provider: details.provider,
    };
    this.setRunLifecycle(sessionId, run, details.label);
    return run;
  }

  private startCreativeRun(
    sessionId: string,
    prompt: string,
    provider?: string,
    model?: string,
    requestKey?: string,
  ): CreativeRunHandle {
    const handle = this.creativeRunCoordinator.startSync({
      entryPoint: 'studio-session',
      requestKey: requestKey?.trim()
        || `studio-session:${sessionId}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`,
      prompt,
      sessionId,
      provider,
      model,
    });
    this.requireCreativeThesis(handle);
    this.creativeRuns.set(sessionId, handle);
    return handle;
  }

  private requireCreativeThesis(handle: CreativeRunHandle): CreativeThesis {
    if (!handle.creativeThesis) throw new Error('Legacy creative run is read-only and cannot generate without a Creative Thesis');
    return validateCreativeThesis(handle.creativeThesis);
  }

  private async finishCreativeRun(sessionId: string, status: 'completed' | 'failed'): Promise<void> {
    const creativeRun = this.creativeRuns.get(sessionId);
    if (!creativeRun) return;
    this.creativeRuns.delete(sessionId);
    await this.creativeRunCoordinator.finish(creativeRun, status);
  }

  private transitionRun(
    sessionId: string,
    phase: TuiRunPhase,
    patch: Partial<Omit<TuiRunLifecycle, 'runId' | 'kind' | 'startedAt'>> = {},
  ): TuiRunLifecycle | undefined {
    const current = this.sessions.get(sessionId)?.run;
    if (!current) return undefined;
    const now = new Date().toISOString();
    const run: TuiRunLifecycle = {
      ...current,
      ...patch,
      phase,
      updatedAt: now,
      completedAt: phase === 'completed' ? (patch.completedAt ?? now) : patch.completedAt ?? current.completedAt,
      failedAt: phase === 'failed' ? (patch.failedAt ?? now) : patch.failedAt ?? current.failedAt,
    };
    this.setRunLifecycle(sessionId, run, run.label);
    return run;
  }

  private completeRun(
    sessionId: string,
    patch: Partial<Omit<TuiRunLifecycle, 'runId' | 'kind' | 'startedAt' | 'phase'>> = {},
  ): TuiRunLifecycle | undefined {
    const creativeRun = this.creativeRuns.get(sessionId);
    if (creativeRun) {
      this.creativeRuns.delete(sessionId);
      void this.creativeRunCoordinator.finish(creativeRun, 'completed').catch((error) => {
        Logger.warn('TuiBridgeService', 'Creative-run completion persistence failed:', error);
      });
    }
    return this.transitionRun(sessionId, 'completed', {
      ...patch,
      outcome: 'completed',
    });
  }

  private failRun(
    sessionId: string,
    error: string,
    outcome: 'failed' | 'cancelled' = 'failed',
    patch: Partial<Omit<TuiRunLifecycle, 'runId' | 'kind' | 'startedAt' | 'phase' | 'error' | 'outcome'>> = {},
  ): TuiRunLifecycle | undefined {
    const creativeRun = this.creativeRuns.get(sessionId);
    if (creativeRun) {
      this.creativeRuns.delete(sessionId);
      void this.creativeRunCoordinator.finish(creativeRun, 'failed').catch((finishError) => {
        Logger.warn('TuiBridgeService', 'Creative-run failure persistence failed:', finishError);
      });
    }
    return this.transitionRun(sessionId, 'failed', { ...patch, error, outcome });
  }

  private suspendRun(
    sessionId: string,
    error: string,
    patch: Partial<Omit<TuiRunLifecycle, 'runId' | 'kind' | 'startedAt' | 'phase' | 'error' | 'outcome'>> = {},
  ): TuiRunLifecycle | undefined {
    return this.transitionRun(sessionId, 'suspended', { ...patch, error, outcome: 'suspended' });
  }

  private setRunLifecycle(sessionId: string, run: TuiRunLifecycle, activeTask?: string): void {
    const status = this.sessions.update(sessionId, {
      run,
      activeTask: activeTask ?? run.label,
      model: run.model ?? this.sessions.get(sessionId)?.model,
      provider: run.provider ?? this.sessions.get(sessionId)?.provider,
    });
    this.emit(sessionId, { type: 'run.lifecycle', sessionId, run });
    this.emit(sessionId, { type: 'status.updated', sessionId, status });
  }

  private emitDomainTruth(
    sessionId: string,
    route: CreativeDomainRouteTruth,
    patch: { generatedDomain?: string; previewDomain?: string; artifactPath?: string } = {},
  ): void {
    this.emit(sessionId, {
      type: 'generation.domain_truth',
      sessionId,
      requestedDomain: route.requestedDomain,
      selectedDomain: route.selectedDomain,
      domains: route.domains,
      promptDomainLocked: route.promptDomainLocked,
      source: route.source,
      ...patch,
    });
  }

  private failureProvenance(
    error: unknown,
    fallback: TuiFailureProvenance = {},
  ): TuiFailureProvenance {
    return compactLLMErrorProvenance(extractLLMErrorProvenance(error), fallback);
  }

  private errorEvent(sessionId: string, error: unknown, fallback: TuiFailureProvenance = {}): TuiBridgeEvent {
    return {
      type: 'error',
      sessionId,
      message: error instanceof Error ? error.message : String(error),
      ...this.failureProvenance(error, fallback),
    };
  }

  emitCommandResponse(sessionId: string, content: string): void {
    this.emit(sessionId, { type: 'response.started', sessionId });
    this.emit(sessionId, { type: 'response.delta', sessionId, delta: content });
    this.emit(sessionId, { type: 'response.completed', sessionId, content });
    this.emit(sessionId, { type: 'response.committed', sessionId, content });
  }

  /** Emit video render lifecycle events via SSE. */
  emitVideoRenderStart(sessionId: string, domain: string): void {
    this.emit(sessionId, { type: 'video:render:start', sessionId, domain });
  }

  emitVideoRenderComplete(sessionId: string, domain: string, videoPath: string): void {
    this.emit(sessionId, { type: 'video:render:complete', sessionId, domain, videoPath });
  }

  emitVideoRenderError(sessionId: string, domain: string, error: string): void {
    this.emit(sessionId, { type: 'video:render:error', sessionId, domain, error });
  }
  // eslint-disable-next-line @typescript-eslint/require-await
  async submitInput(
    sessionId: string,
    input: TuiInputRequest,
    llm?: LLMClient,
  ): Promise<{ reviewRequired: boolean }> {
    // Cancel any in-flight stream for this session
    this.cancelStream(sessionId);

    this.sessions.update(sessionId, { mode: input.mode });
    const selfImprovement = isSelfImprovementRequest(input.text);
    const creativeGeneration = isGenerationRequest(input.text);

    // Slash-command dispatch (extracted to CommandDispatcher)
    const commandResult = await dispatchCommand(this.commandCtx, sessionId, input.text, llm);
    if (commandResult) return commandResult;
    // Studio routing: classify intent via IntentRouter with mode biasing
    const modeConfig = this.modeRegistry.getMode(sessionId);
    const classifier = new ModeAwareRouter(this.router, () => modeConfig);
    const baseClassification = classifier.classify(input.text);
    const classification = input.clientIntent === 'creative'
      ? {
          ...baseClassification,
          intent: 'creative' as const,
          confidence: 'high' as const,
          topic: baseClassification.topic ?? 'generate',
        }
      : isOperatorInspectionRequest(input.text)
      ? {
          ...baseClassification,
          intent: 'engineering' as const,
          confidence: 'high' as const,
          topic: baseClassification.topic ?? 'inspect',
        }
      : baseClassification;

    logBridge('input.received', {
      sessionId,
      mode: input.mode,
      intent: input.clientIntent,
      studioIntent: classification.intent,
      studioConfidence: classification.confidence,
      topic: classification.topic,
      selfImprovement,
      creativeGeneration,
      chars: input.text.length,
    });

    if (input.clientIntent === 'action' || input.mode === 'action') {
      const pendingAction: TuiPendingAction = {
        id: `action-${Date.now()}`,
        title: input.text.slice(0, 60),
        description: input.text,
        prompt: input.text,
        route: 'operator',
        kind: 'llm',
        requiresConfirmation: true,
        createdAt: new Date().toISOString(),
      };
      const status = this.sessions.update(sessionId, {
        mode: 'action',
        trust: { level: 'review-required', label: 'Review required before mutation' },
        pendingAction,
      });
      this.emit(sessionId, { type: 'action.review_required', sessionId, action: pendingAction });
      this.emit(sessionId, { type: 'status.updated', sessionId, status });
      logBridge('input.routed', { sessionId, route: 'action.review_required' });
      return { reviewRequired: true };
    }

    // Get or create conversation manager for this session
    let conversation = this.conversations.get(sessionId);
    if (!conversation) {
      conversation = new ConversationManager();
      conversation.startNewSession();
      this.conversations.set(sessionId, conversation);
    }

    // Record user message in conversation history
    conversation.appendMessage('user', input.text);

    // Step 2: Route via StudioAgent classification
    this.emit(sessionId, { type: 'response.started', sessionId });

    const routeStart = Date.now();
    const handleError = (err: unknown) => {
      const config = llm?.getConfig();
      this.emit(sessionId, this.errorEvent(sessionId, err, {
        provider: config?.baseUrl ? this.providerLabelFromBaseUrl(config.baseUrl) : undefined,
        model: config?.model,
        endpoint: config?.baseUrl,
      }));
    };

    const emitSessionTurn = (delegatedTo: string, responseContent?: string, extras?: { executor?: TuiRunExecutor; artifactRefs?: string[]; taskRefs?: string[] }) => {
      const turnId = `turn-${Date.now()}`;
      const durationMs = Date.now() - routeStart;
      this.emit(sessionId, {
        type: 'session.turn',
        sessionId,
        turnId,
        intent: classification.intent,
        delegatedTo,
        durationMs,
        ...extras,
      });

      // Record turn in session graph
      const graph = this.sessionGraphs.get(sessionId);
      if (graph) {
        graph.recordTurn({
          turnId,
          input: input.text,
          intent: classification.intent,
          delegatedTo,
          response: responseContent ?? '',
          durationMs,
          artifactRefs: extras?.artifactRefs,
          taskRefs: extras?.taskRefs,
        });
      }
    };

    if (!llm) {
      // Fallback: echo without LLM
      this.emit(sessionId, { type: 'response.delta', sessionId, delta: input.text });
      this.emit(sessionId, { type: 'response.completed', sessionId, content: input.text });
      this.emit(sessionId, { type: 'response.committed', sessionId, content: input.text });
      conversation.appendMessage('assistant', input.text);
      emitSessionTurn('echo', input.text);
      this.emit(sessionId, {
        type: 'status.updated',
        sessionId,
        status: this.sessions.update(sessionId, {
          mode: input.mode,
          activeTask: input.text.slice(0, 60),
        }),
      });
      return { reviewRequired: false };
    }

    // Route based on StudioAgent intent classification
    // Autonomy gating: check if the action kind requires review at current level
    switch (classification.intent) {
      case 'creative': {
        const intentBrief = buildCreativeIntentBrief(input.text);
        emitIntentBrief(this.intentCtx, sessionId, intentBrief);
        emitReasoningTrace(this.intentCtx, sessionId, {
          phase: 'analysis',
          thought: intentBrief.shouldClarify
            ? 'Prompt is underspecified; asking for missing requirements before generation.'
            : 'Prompt has enough concrete intent to prepare generation.',
          detail: intentBrief.requirements.join(' | '),
          source: 'harness',
        });
        if (intentBrief.shouldClarify) {
          emitCreativeClarification(this.intentCtx, sessionId, intentBrief, conversation);
          emitSessionTurn('clarification', intentBrief.questions.join('\n'));
          break;
        }

        if (input.clientIntent === 'creative') {
          logBridge('input.routed', { sessionId, route: 'workbench.creative', confidence: classification.confidence });
          const useRetiredTestSeam = process.env.NODE_ENV === 'test'
            && Boolean(retiredDraftTestAdapter) && !this.productCreateCommand;
          const runCreative = useRetiredTestSeam
            ? this.streamDraftGeneration(sessionId, input.text, conversation, llm, input)
            : this.streamGovernedProductCreate(sessionId, input.text, conversation, input);
          runCreative
            .then(() => emitSessionTurn(useRetiredTestSeam ? 'draft-generator' : 'product-command'))
            .catch(handleError);
          break;
        }

        const actionKind = 'creative' as const;
        if (this.autonomyController.requiresReview(actionKind, sessionId)) {
          const pendingAction: TuiPendingAction = {
            id: `action-${Date.now()}`,
            title: input.text.slice(0, 60),
            description: `Creative: ${input.text}`,
            prompt: input.text,
            route: 'creative',
            kind: 'llm',
            requiresConfirmation: true,
            createdAt: new Date().toISOString(),
          };
          const status = this.sessions.update(sessionId, {
            mode: 'action',
            trust: { level: 'review-required', label: `Autonomy: ${this.autonomyController.getConfig(sessionId).label} — creative needs review` },
            pendingAction,
          });
          this.emit(sessionId, { type: 'action.review_required', sessionId, action: pendingAction });
          this.emit(sessionId, { type: 'status.updated', sessionId, status });
          return { reviewRequired: true };
        }
        logBridge('input.routed', { sessionId, route: 'studio.creative', confidence: classification.confidence });
        this.streamGovernedProductCreate(sessionId, input.text, conversation, input)
          .then(() => emitSessionTurn('product-command'))
          .catch(handleError);
        break;
      }

      case 'engineering': {
        const actionKind = 'engineering' as const;
        if (this.autonomyController.requiresReview(actionKind, sessionId)) {
          const pendingAction: TuiPendingAction = {
            id: `action-${Date.now()}`,
            title: input.text.slice(0, 60),
            description: `Engineering: ${input.text}`,
            prompt: input.text,
            route: 'engineering',
            kind: 'structured',
            requiresConfirmation: true,
            createdAt: new Date().toISOString(),
          };
          const status = this.sessions.update(sessionId, {
            mode: 'action',
            trust: { level: 'review-required', label: `Autonomy: ${this.autonomyController.getConfig(sessionId).label} — engineering needs review` },
            pendingAction,
          });
          this.emit(sessionId, { type: 'action.review_required', sessionId, action: pendingAction });
          this.emit(sessionId, { type: 'status.updated', sessionId, status });
          return { reviewRequired: true };
        }
        logBridge('input.routed', { sessionId, route: 'studio.engineering', confidence: classification.confidence });
        this.streamEngineeringTask(sessionId, input.text, conversation, llm)
          .then(() => emitSessionTurn('engineering-agent', undefined, { executor: 'llm-mode-agent' }))
          .catch(handleError);
        break;
      }

      case 'hybrid': {
        const actionKind = 'engineering' as const;
        if (this.autonomyController.requiresReview(actionKind, sessionId)) {
          const pendingAction: TuiPendingAction = {
            id: `action-${Date.now()}`,
            title: input.text.slice(0, 60),
            description: `Hybrid: ${input.text}`,
            prompt: input.text,
            route: 'hybrid',
            kind: 'llm',
            requiresConfirmation: true,
            createdAt: new Date().toISOString(),
          };
          const status = this.sessions.update(sessionId, {
            mode: 'action',
            trust: { level: 'review-required', label: `Autonomy: ${this.autonomyController.getConfig(sessionId).label} — hybrid needs review` },
            pendingAction,
          });
          this.emit(sessionId, { type: 'action.review_required', sessionId, action: pendingAction });
          this.emit(sessionId, { type: 'status.updated', sessionId, status });
          return { reviewRequired: true };
        }
        logBridge('input.routed', { sessionId, route: 'studio.hybrid', confidence: classification.confidence });
        this.streamHybridTask(sessionId, input.text, conversation, llm, input)
          .then(() => emitSessionTurn('product-command', undefined,
            { executor: 'product-command' }))
          .catch(handleError);
        break;
      }

      case 'direct':
      default:
        logBridge('input.routed', { sessionId, route: 'studio.direct', confidence: classification.confidence });
        this.streamDirectChat(sessionId, input.text, conversation, llm)
          .then(() => emitSessionTurn('llm-chat'))
          .catch(handleError);
        break;
    }

    return { reviewRequired: false };
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async confirmAction(sessionId: string, actionId: string, llm?: LLMClient): Promise<void> {
    const currentStatus = this.getStatus(sessionId);
    if (!currentStatus.pendingAction || currentStatus.pendingAction.id !== actionId) {
      throw new Error(`Pending action ${actionId} not found`);
    }
    const pendingAction = currentStatus.pendingAction;
    const nextStatus = this.sessions.update(sessionId, {
      mode: 'confirm',
      pendingAction: undefined,
      trust: { level: 'confirmed', label: 'Operator confirmed mutation' },
    });
    this.emit(sessionId, { type: 'action.confirmed', sessionId, actionId });
    this.emit(sessionId, { type: 'status.updated', sessionId, status: nextStatus });

    if (!llm) return;

    const approvedText = (pendingAction.prompt ?? pendingAction.description.replace(/^(Operator|Engineering|Hybrid|Creative):\s*/i, '')).trim();
    if (!approvedText) return;
    const route = pendingAction.route ?? this.inferPendingActionRoute(pendingAction.description);

    let conversation = this.conversations.get(sessionId);
    if (!conversation) {
      conversation = new ConversationManager();
      conversation.startNewSession();
      this.conversations.set(sessionId, conversation);
    }

    this.emit(sessionId, { type: 'response.started', sessionId });
    const routeStart = Date.now();
    const runApproved = route === 'creative'
      ? this.streamGovernedProductCreate(sessionId, approvedText, conversation)
      : route === 'hybrid'
        ? this.streamHybridTask(sessionId, approvedText, conversation, llm)
        : this.streamEngineeringTask(sessionId, approvedText, conversation, llm);

    runApproved
      .then(() => {
        this.emit(sessionId, {
          type: 'session.turn',
          sessionId,
          turnId: `turn-${Date.now()}`,
          intent: route === 'creative' ? 'creative' : route === 'hybrid' ? 'hybrid' : 'engineering',
          delegatedTo: route === 'creative' ? 'product-command'
            : route === 'hybrid' ? 'product-command' : 'engineering-agent',
          executor: route === 'creative' || route === 'hybrid'
            ? 'product-command' : 'llm-mode-agent',
          durationMs: Date.now() - routeStart,
        });
      })
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        this.emit(sessionId, { type: 'activity.updated', sessionId, message: `Task failed: ${message}` });
        this.emit(sessionId, {
          type: 'error',
          sessionId,
          message,
        });
      });
  }

  private inferPendingActionRoute(description: string): NonNullable<TuiPendingAction['route']> {
    if (/^Creative:/i.test(description)) return 'creative';
    if (/^Hybrid:/i.test(description)) return 'hybrid';
    return 'engineering';
  }

  cancelAction(sessionId: string, actionId: string): void {
    const currentStatus = this.getStatus(sessionId);
    if (!currentStatus.pendingAction || currentStatus.pendingAction.id !== actionId) {
      throw new Error(`Pending action ${actionId} not found`);
    }
    const nextStatus = this.sessions.update(sessionId, {
      mode: 'chat',
      pendingAction: undefined,
      trust: { level: 'untrusted', label: 'Generated code is untrusted by default' },
    });
    this.emit(sessionId, { type: 'action.cancelled', sessionId, actionId });
    this.emit(sessionId, { type: 'status.updated', sessionId, status: nextStatus });
  }

  cancelRun(sessionId: string): void {
    this.cancelStream(sessionId);
    const status = this.sessions.get(sessionId);
    if (!status) {
      throw new Error(`Unknown TUI session: ${sessionId}`);
    }
    this.emit(sessionId, {
      type: 'generation.cancelled',
      sessionId,
      reason: 'operator-stop',
      cancelledAt: new Date().toISOString(),
      message: 'Generation stopped by operator.',
    });
    this.emit(sessionId, { type: 'activity.updated', sessionId, message: 'Generation stopped by operator.' });
    this.emit(sessionId, {
      type: 'status.updated',
      sessionId,
      status: this.sessions.update(sessionId, {
        mode: 'chat',
        activeTask: 'Generation stopped',
      }),
    });
    this.failRun(sessionId, 'Generation stopped by operator.', 'cancelled');
  }

  /**
   * Set the product mode for a session.
   * Emits mode.product_changed event for the TUI to render the mode badge.
   */
  setProductMode(sessionId: string, mode: ProductMode): ModeConfig {
    const config = this.modeRegistry.setMode(sessionId, mode);
    const modeInfo = PRODUCT_MODES[mode];

    logBridge('mode.changed', { sessionId, mode, label: modeInfo.label });

    this.emit(sessionId, {
      type: 'mode.product_changed',
      sessionId,
      mode,
      label: modeInfo.label,
      description: modeInfo.description,
    });

    return config;
  }


  /**
   * Lazy-initialize the GoalStore with SinterFS.
   * Returns null if SinterFS cannot be opened (e.g. not in a project directory).
   */
  private getGoalStore(): GoalStore | null {
    if (!this.goalStore) {
      try {
        const fs = SinterFS.open(resolveSinterProjectRoot());
        this.goalStore = new GoalStore(fs);
      } catch (err) {
        Logger.debug('TuiBridgeService', 'GoalStore unavailable — SinterFS could not be opened:', err);
        return null;
      }
    }
    return this.goalStore;
  }

  /**
   * Lazy-initialize EmergenceHooks with SinterFS so the gardener can hydrate the
   * archive from persisted emergence experience each cycle.
   * Returns null if SinterFS cannot be opened (e.g. not in a project directory).
   */
  private getEmergenceHooks(): EmergenceHooks | null {
    if (!this.emergenceHooks) {
      try {
        const fs = SinterFS.open(resolveSinterProjectRoot());
        this.emergenceHooks = new EmergenceHooks(fs, undefined, this.dreamSourceAdmission);
      } catch (err) {
        Logger.debug('TuiBridgeService', 'EmergenceHooks unavailable — SinterFS could not be opened:', err);
        return null;
      }
    }
    return this.emergenceHooks;
  }

  /**
   * The descriptor axes the background gardener searches over. Sources the real
   * 6 behavior axes from the same canonical place the rest of the system uses
   * (BehaviorDescriptorExtractor's defaults, derived from the DescriptorAxis
   * union) — matching the CLI `garden` path, which passes the identical 6 axes.
   * Without this the GUI gardener would run dream/novelty over a null (empty)
   * descriptor space.
   */
  private gardenerAxes(): DescriptorAxis[] {
    return new BehaviorDescriptorExtractor().getAvailableAxes();
  }

  /**
   * Lazily open a shared SinterFS handle (session persistence + hydration).
   * Returns null if SinterFS cannot be opened (e.g. not in a project directory),
   * in which case sessions degrade to memory-only.
   */
  private getSinterFS(): SinterFS | null {
    if (!this.sinterFs) {
      try {
        this.sinterFs = SinterFS.open(resolveSinterProjectRoot());
      } catch (err) {
        Logger.debug('TuiBridgeService', 'SinterFS unavailable — sessions are memory-only:', err);
        return null;
      }
    }
    return this.sinterFs;
  }

  /**
   * Lazily initialize taste learning against the same project-local SinterFS
   * handle used by session and archive persistence.
   */
  private getTasteLearningService(): TasteLearningService | null {
    if (!this.tasteLearningService) {
      const fs = this.getSinterFS();
      if (!fs) return null;
      this.tasteLearningService = new TasteLearningService(fs);
    }
    return this.tasteLearningService;
  }

  private hydrateLatestTasteModel(): boolean {
    const service = this.getTasteLearningService();
    if (!service || !this.gardener) return false;
    try {
      const weights = service.loadLatestModel();
      if (!weights) return false;
      this.gardener.loadTasteModel(weights);
      return true;
    } catch (err) {
      Logger.debug('TuiBridgeService', 'Taste model hydration unavailable:', err);
      return false;
    }
  }

  private async recordReviewPreference(
    sessionId: string,
    action: 'pin' | 'reject',
    artifactId: string,
    auth?: { nonce: string; eventId: string; source: OwnerReactionSource; occurredAt: string },
  ): Promise<{ saved: boolean; causal: boolean; reactionDigest?: string; reason?: string }> {
    const service = this.getTasteLearningService();
    let saved = false;
    try {
      if (!service) throw new Error('taste learning service unavailable');
      await service.recordPreference({ action, artifactId, sessionId });
      const summary = await service.trainFromProject();
      if (summary.weights && this.gardener) {
        this.gardener.loadTasteModel(summary.weights);
      }
      saved = true;
    } catch (err) {
      Logger.warn('TuiBridgeService', `Preference ${action} persistence failed for ${artifactId}:`, err);
    }
    if (saved && auth) {
      try {
        const receipt = this.ownerReactions.record({
          ownerSessionId: sessionId, artifactId, action, ...auth,
        });
        const nextCreateContext = this.ownerReactions.resolveNextCreateContext(sessionId, receipt.reactionDigest);
        await this.cognitiveWriter.recordReaction({
          receipt, nextCreateContext, saved,
        });
        return { saved, causal: true, reactionDigest: receipt.reactionDigest };
      } catch (err) {
        Logger.warn('TuiBridgeService', `Preference lineage failed for ${artifactId}:`, err);
        const reason = err instanceof OwnerReactionError ? err.code : 'LINEAGE_FAILED';
        return { saved, causal: false, reason };
      }
    }
    return { saved, causal: false, reason: saved ? 'OWNER_AUTH_NOT_SUPPLIED' : 'PERSISTENCE_FAILED' };
  }

  private registerOwnerArtifact(sessionId: string, lineageId: string, artifact: {
    artifactPath: string;
    artifactDigest: string;
  }): void {
    const ownerSession = this.sessions.get(sessionId)?.ownerSession;
    const sourceFingerprint = computeProofSourceFingerprint(process.cwd())?.replace(/^sha256:/, '');
    if (!ownerSession || !sourceFingerprint) return;
    const revision = (this.ownerReactions.currentArtifact(sessionId)?.revision ?? 0) + 1;
    const binding = this.ownerReactions.bindArtifact({
      ownerSessionId: sessionId,
      nonce: ownerSession.nonce,
      artifactId: artifact.artifactPath,
      artifactDigest: artifact.artifactDigest,
      lineageId,
      revision,
      sourceFingerprint,
    });
    this.emit(sessionId, {
      type: 'review.owner_artifact_ready', sessionId,
      artifactId: binding.artifactId, artifactDigest: binding.artifactDigest,
      lineageId: binding.lineageId, revision: binding.revision,
      sourceFingerprint: binding.sourceFingerprint,
    });
  }

  /**
   * Hydrate sessions persisted by prior processes into the resumer, once, so
   * `/sessions` accumulates across restarts. Safe no-op if SinterFS is
   * unavailable or already hydrated.
   */
  private ensureSessionsHydrated(): void {
    if (this.sessionsHydrated) return;
    this.sessionsHydrated = true;
    const fs = this.getSinterFS();
    if (!fs) return;
    try {
      const loaded = this.sessionResumer.hydrate(fs);
      if (loaded > 0) {
        Logger.debug('TuiBridgeService', `Hydrated ${loaded} persisted session(s) from SinterFS.`);
      }
    } catch (err) {
      Logger.debug('TuiBridgeService', 'Session hydration failed:', err);
    }
  }


  /**
   * Stream a direct chat response from the LLM.
   * Uses STUDIO_SYSTEM_PROMPT for the creative-first persona.
   * No autonomy gating — direct chat is read-only.
   */
  private async streamDirectChat(
    sessionId: string,
    userText: string,
    conversation: ConversationManager,
    llm: LLMClient,
  ): Promise<void> {
    const controller = new AbortController();
    this.activeStreams.set(sessionId, controller);

    const config = llm.getConfig();
    const modelName = config.model || 'unknown';
    const provider = config.baseUrl ? this.providerLabelFromBaseUrl(config.baseUrl) : 'unknown';
    const startTime = Date.now();
    logBridge('direct.started', { sessionId, model: modelName, chars: userText.length });
    this.beginRun(sessionId, {
      kind: 'chat',
      label: 'Direct chat',
      model: modelName,
      provider,
    });
    this.transitionRun(sessionId, 'generating', { label: 'Streaming direct chat response' });

    try {
      // Build conversation context from history (same pattern as streamChatResponse)
      const conversationContext = conversation.getConversationContext({ excludeLatest: true });
      const fullPrompt = conversationContext
        ? `${conversationContext}user: ${userText}`
        : userText;

      const response = await llm.generate(STUDIO_SYSTEM_PROMPT, fullPrompt, controller.signal);

      const content = response.code || response.explanation || '';
      if (!content) {
        throw new Error('Empty response from LLM');
      }

      const chunks = this.chunkString(content, 50);
      let fullContent = '';
      for (const chunk of chunks) {
        fullContent += chunk;
        this.emit(sessionId, { type: 'response.delta', sessionId, delta: chunk });
        await new Promise(r => setTimeout(r, 10));
      }

      this.emit(sessionId, { type: 'response.completed', sessionId, content: fullContent });
      this.emit(sessionId, { type: 'response.committed', sessionId, content: fullContent });
      conversation.appendMessage('assistant', fullContent);

      this.emit(sessionId, {
        type: 'response.metadata',
        sessionId,
        model: modelName,
        duration: Date.now() - startTime,
      });

      this.emit(sessionId, {
        type: 'status.updated',
        sessionId,
        status: this.sessions.update(sessionId, {
          mode: 'chat',
          activeTask: 'Direct chat',
          model: modelName,
        }),
      });
      this.completeRun(sessionId, { label: 'Direct chat complete', model: modelName, provider });

      logBridge('direct.completed', { sessionId, model: modelName, duration: Date.now() - startTime });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.failRun(sessionId, message);
      this.emit(sessionId, this.errorEvent(sessionId, err, { provider, model: modelName, endpoint: config.baseUrl }));
      throw err;
    } finally {
      this.activeStreams.delete(sessionId);
    }
  }

  /**
   * Read a bounded excerpt of the prior artifact for revision prompts.
   * Confines the read to `.omx/proof` (where preview/cognition receipts write;
   * production receipts emit absolute `.omx/proof/live-previews/...`).
   * Rejects `..` segments, absolute/relative escapes, and symlink escapes. Never throws.
   */
  private async resolvePriorArtifactExcerpt(
    priorRunReceipt: unknown,
    maxChars = PRIOR_ARTIFACT_EXCERPT_MAX_CHARS,
  ): Promise<string | undefined> {
    try {
      if (!priorRunReceipt || typeof priorRunReceipt !== 'object' || Array.isArray(priorRunReceipt)) {
        return undefined;
      }
      const artifact = (priorRunReceipt as { artifact?: unknown }).artifact;
      if (!artifact || typeof artifact !== 'object' || Array.isArray(artifact)) {
        return undefined;
      }
      const rawPath = (artifact as { path?: unknown }).path;
      if (typeof rawPath !== 'string' || rawPath.trim() === '') {
        return undefined;
      }
      const trimmed = rawPath.trim();
      // Attacker-controllable via unauthenticated session input — fail closed.
      // Reject `..` in the raw string before any resolution (defense in depth).
      if (trimmed.split(/[/\\]/).includes('..')) {
        return undefined;
      }

      const repoRoot = process.cwd();
      let candidate: string;
      if (path.isAbsolute(trimmed)) {
        // Absolute receipts (PreviewService) are allowed only if realpath stays in-repo.
        candidate = path.normalize(trimmed);
      } else {
        let subPath = trimmed.replace(/\\/g, '/');
        if (subPath.startsWith('./')) {
          subPath = subPath.slice(2);
        }
        if (!subPath || subPath.startsWith('/') || subPath.split('/').includes('..')) {
          return undefined;
        }
        candidate = normalizePath(repoRoot, subPath);
      }

      let rootReal: string;
      let resolvedReal: string;
      try {
        // Root is .omx/proof, not the repo root: receipt artifact paths are
        // proof artifacts, and anything wider would expose arbitrary repo files.
        rootReal = realpathSync(path.join(repoRoot, '.omx', 'proof'));
        resolvedReal = realpathSync(candidate);
      } catch {
        return undefined;
      }
      const rel = path.relative(rootReal, resolvedReal);
      if (rel.startsWith('..') || path.isAbsolute(rel)) {
        return undefined;
      }

      const content = await fs.readFile(resolvedReal, 'utf8');
      if (content.length <= maxChars) return content;
      return `${content.slice(0, maxChars)}\n// …(truncated)`;
    } catch {
      return undefined;
    }
  }

  private async streamGovernedProductCreate(sessionId: string, userText: string,
    conversation: ConversationManager,
    options: Pick<TuiInputRequest, 'creativePreferences' | 'guidanceAnswers'> = {}): Promise<void> {
    if (!this.productCreateCommand) throw new Error('LIMINAL_PRODUCT_COMMAND_FACTORY_REQUIRED');
    const route = buildCreativeDomainRouteTruth(userText);
    emitCreativePreferenceGuidance(this.intentCtx, sessionId, userText, route.selectedDomain);
    emitPriorRunReceiptLink(this.intentCtx, sessionId, options);
    this.beginRun(sessionId, { kind: 'creative', label: 'Governed Create queued',
      executionMode: 'prove', executor: 'product-command' });
    try {
      this.transitionRun(sessionId, 'planning', { label: 'Minting governed Product Create' });
      this.emit(sessionId, { type: 'generation.route.selected', sessionId,
        domain: route.selectedDomain, domains: route.domains,
        requestedDomain: route.requestedDomain, selectedDomain: route.selectedDomain,
        promptDomainLocked: route.promptDomainLocked, source: route.source,
        startedAt: new Date().toISOString(), timeoutMinutes: 3, candidateCount: 1,
        executionMode: 'prove' });
      const priorArtifactExcerpt = options.creativePreferences?.priorRunReceipt != null
        ? await this.resolvePriorArtifactExcerpt(options.creativePreferences.priorRunReceipt)
        : undefined;
      const providerPrompt = promptForCreativeDomain(userText, route.selectedDomain,
        false, buildCreativeIntentBrief(userText), { ...options, priorArtifactExcerpt });
      const command = await this.productCreateCommand({ prompt: providerPrompt,
        domain: route.selectedDomain, layers: [`${route.selectedDomain}-composition`],
        maxTransportAttempts: 2 });
      this.transitionRun(sessionId, 'generating', { label: 'Executing governed Product Create' });
      const projection = await this.productCommandPort().submitCreate('studio', command);
      if (projection.kind !== 'create') throw new Error('LIMINAL_STUDIO_CREATE_INVALID');
      const artifact = await this.productCommandPort().verifiedArtifact(command.idempotencyKey);
      this.emit(sessionId, { type: 'response.delta', sessionId, delta: artifact.source });
      this.emit(sessionId, { type: 'response.completed', sessionId, content: artifact.source });
      this.emit(sessionId, { type: 'response.committed', sessionId, content: artifact.source });
      const evaluation = projection.result.evaluation;
      const qualityState = evaluation.admissionEligible ? 'scored' : 'degraded';
      const failureClasses = ['none', 'render', 'validator', 'parse', 'scorer',
        'infra', 'legacy'] as const;
      const failureClass = failureClasses.includes(evaluation.failureClass as never)
        ? evaluation.failureClass as typeof failureClasses[number]
        : evaluation.admissionEligible ? 'none' : 'infra';
      this.emit(sessionId, { type: 'generation.reasoning_trace', sessionId,
        phase: 'generation', source: 'generator', model: projection.result.roles.generator,
        thought: `Generated by ${projection.result.roles.generator} through governed Product Create.` });
      this.emit(sessionId, { type: 'generation.reasoning_trace', sessionId,
        phase: 'evaluation', source: 'evaluator', model: projection.result.roles.evaluator,
        thought: `Rendered evidence evaluated by ${projection.result.roles.evaluator}.`,
        detail: evaluation.admissionEligible ? 'admission-eligible' : 'admission-ineligible' });
      this.emit(sessionId, { type: 'generation.complete', sessionId, iterations: 1,
        finalScore: projection.result.evaluation.score, duration: 0,
        model: projection.result.roles.generator, reason: 'governed-product-create',
        qualityState, executionMode: 'prove',
        evaluationConfidence: evaluation.confidence
          ?? (evaluation.admissionEligible ? 1 : 0), evaluationFailureClass: failureClass });
      this.emit(sessionId, { type: 'generation.cognitive_receipt', sessionId,
        lineageId: projection.result.lineageId, loop: 'creative', receipts: [
          { organ: 'evaluation', status: evaluation.admissionEligible ? 'observed' : 'unavailable',
            detail: evaluation.admissionEligible
              ? `Verified rendered evaluation admitted from ${evaluation.evaluatorIdentity}.`
              : `Rendered evaluation unavailable for admission (${failureClass}): ${evaluation.rejectionReasons.join(', ') || 'ineligible'}.` },
          { organ: 'immune-truth', status: 'observed', detail: evaluation.admissionEligible
            ? 'Verified rendered scored output from the governed Product Create projection.'
            : 'Degraded mode: presenting the artifact without a real fitness score.' },
        ] });
      await emitPreviewArtifacts(this.previewCtx, sessionId, artifact.source,
        route.selectedDomain, route);
      conversation.appendMessage('assistant', artifact.source);
      this.completeRun(sessionId, { label: 'Governed Create complete',
        model: projection.result.roles.generator });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.emit(sessionId, this.errorEvent(sessionId, error));
      this.failRun(sessionId, message);
      throw error;
    }
  }

  /** Retained only as an explicit fail-closed compatibility boundary. */
  private async streamDraftGeneration(
    sessionId: string,
    userText: string,
    conversation: ConversationManager,
    llm: LLMClient,
    options: Pick<TuiInputRequest, 'maxIterations' | 'candidateCount' | 'minQualityScore' | 'timeoutMinutes' | 'creativePreferences' | 'guidanceAnswers' | 'idempotencyKey'> = {},
  ): Promise<void> {
    if (process.env.NODE_ENV !== 'test') {
      throw new Error('LEGACY_TUI_DRAFT_RETIRED_USE_GOVERNED_CREATE');
    }
    if (!retiredDraftTestAdapter) throw new Error('RETIRED_DRAFT_TEST_ADAPTER_REQUIRED');
    const controller = new AbortController();
    this.activeStreams.set(sessionId, controller);

    let config = llm.getConfig();
    const sessionStatus = this.sessions.get(sessionId);
    const coordinatorRun = this.startCreativeRun(
      sessionId,
      userText,
      config.baseUrl ? this.providerLabelFromBaseUrl(config.baseUrl) : sessionStatus?.provider,
      config.model,
      options.idempotencyKey,
    );
    const creativeThesis = this.requireCreativeThesis(coordinatorRun);
    const creativeIdentity = creativeIdentityFields(coordinatorRun);
    let effectiveModel = sessionStatus?.roles?.generator?.model || config.model || 'unknown';
    let resolvedEffectiveModel = false;
    const resolver = (llm as LLMClient & { resolveEffectiveModel?: () => Promise<string> }).resolveEffectiveModel;
    if (typeof resolver === 'function') {
      try {
        effectiveModel = await resolver.call(llm);
        config = llm.getConfig();
        resolvedEffectiveModel = true;
      } catch (err) {
        Logger.info('TuiBridgeService', `Effective model preflight failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    const provider = config.baseUrl ? this.providerLabelFromBaseUrl(config.baseUrl) : sessionStatus?.provider || 'unknown';
    if (resolvedEffectiveModel) {
      this.publishResolvedGeneratorModel(sessionId, provider, config.baseUrl, effectiveModel);
    }
    const harnessModelName = resolvedEffectiveModel
      ? effectiveModel
      : sessionStatus?.roles?.harness?.model || config.model || 'unknown';
    const generatorModelName = resolvedEffectiveModel
      ? effectiveModel
      : sessionStatus?.roles?.generator?.model || harnessModelName;
    // Studio owns the operator-visible timeout; the bridge only bounds it so draft runs cannot hang forever.
    const timeoutMinutes = Math.min(30, Math.max(1, Number(options.timeoutMinutes) || 1));
    // Draft is best-of-N: the GUI asks for a few candidates and we keep the
    // strongest, so a single bad roll never reaches the canvas. Clamped to [1,3]
    // to bound parallel provider load on the fast-preview path.
    const candidateCount = Math.min(3, Math.max(1, Math.floor(Number(options.candidateCount)) || 1));
    const generationStartedAt = Date.now();
    const intentBrief = buildCreativeIntentBrief(userText);
    const run = this.beginRun(sessionId, {
      kind: 'creative',
      label: 'Creative draft queued',
      executionMode: 'draft',
      model: generatorModelName,
      provider,
      runId: coordinatorRun.rootRunId,
    });

    try {
      this.transitionRun(sessionId, 'planning', { label: 'Reading prompt and choosing draft route' });
      this.emit(sessionId, {
        type: 'activity.updated',
        sessionId,
        message: 'Generating a first artifact before quality scoring.',
      });
      emitIntentBrief(this.intentCtx, sessionId, intentBrief);
      emitReasoningTrace(this.intentCtx, sessionId, {
        phase: 'analysis',
        thought: 'Fast generation is prioritizing the first visible artifact before quality scoring.',
        detail: intentBrief.requirements.join(' | '),
        model: harnessModelName,
        source: 'harness',
      });

      if (intentBrief.shouldClarify) {
        emitCreativeClarification(this.intentCtx, sessionId, intentBrief, conversation);
        await this.finishCreativeRun(sessionId, 'failed');
        return;
      }

      const routeTruth = buildCreativeDomainRouteTruth(userText);
      const domainPlan = routeTruth.domains;
      emitCreativePreferenceGuidance(this.intentCtx, sessionId, userText, routeTruth.selectedDomain);
      this.emit(sessionId, {
        type: 'generation.route.selected',
        sessionId,
        domain: routeTruth.selectedDomain,
        domains: domainPlan,
        requestedDomain: routeTruth.requestedDomain,
        selectedDomain: routeTruth.selectedDomain,
        promptDomainLocked: routeTruth.promptDomainLocked,
        source: routeTruth.source,
        startedAt: new Date(generationStartedAt).toISOString(),
        timeoutMinutes,
        candidateCount,
        executionMode: 'draft',
      });
      this.emitDomainTruth(sessionId, routeTruth);
      emitPriorRunReceiptLink(this.intentCtx, sessionId, options);
      const lineageReady = this.cognitiveWriter.beginGenerationLineage({
        lineageId: run.runId,
        sessionId,
        userText,
        domain: routeTruth.selectedDomain,
        executionMode: 'draft',
      });
      const memoryReceiptsPromise = lineageReady.then(() =>
        this.cognitiveWriter.prepareGeneration({
          sessionId,
          lineageId: run.runId,
          userText,
          domain: routeTruth.selectedDomain,
        })
      );
      this.emit(sessionId, {
        type: 'generation.domain_plan',
        sessionId,
        domains: domainPlan,
        requestedDomain: routeTruth.requestedDomain,
        selectedDomain: routeTruth.selectedDomain,
        promptDomainLocked: routeTruth.promptDomainLocked,
        source: routeTruth.source,
        startedAt: new Date(generationStartedAt).toISOString(),
        timeoutMinutes,
        candidateCount,
        executionMode: 'draft',
      });
      void memoryReceiptsPromise.then((memoryPreparation) => {
        this.emit(sessionId, {
          type: 'generation.cognitive_receipt',
          sessionId,
          lineageId: run.runId,
          loop: 'creative',
          receipts: [
            { organ: 'perception', status: 'observed', detail: `Captured ${intentBrief.requirements.length} requirement(s) from the prompt.` },
            { organ: 'intuition', status: 'observed', detail: `Generation route selected ${domainPlan.join(' -> ')}.` },
            ...memoryPreparation.receipts,
            { organ: 'evaluation', status: 'pending', detail: 'Quality scoring is deferred until the artist asks to polish.' },
          ],
        });
      }).catch((error) => {
        Logger.warn('TuiBridgeService', `Lineage memory receipt failed for ${run.runId}:`, error);
      });

      let result: RetiredDraftResult | undefined;
      let activeDomain = domainPlan[0];
      let lastError: unknown;
      const priorArtifactExcerpt = options.creativePreferences?.priorRunReceipt != null
        ? await this.resolvePriorArtifactExcerpt(options.creativePreferences.priorRunReceipt)
        : undefined;

      for (let attempt = 0; attempt < domainPlan.length; attempt++) {
        const attemptStartedAt = Date.now();
        const domain = domainPlan[attempt];
        activeDomain = domain;
        const baseAttemptPrompt = `${promptForCreativeDomain(userText, domain, attempt > 0, intentBrief, {
          ...options,
          priorArtifactExcerpt,
        })}\n\n${creativeThesisPromptContext(creativeThesis)}`;
        const preparation = this.cognitiveWriter.getPreparedGeneration(domain, sessionId);
        const preparedRequest = injectPreparedGeneration(baseAttemptPrompt, preparation);
        const requestReceiptReady = this.cognitiveWriter.recordGeneratorRequest({
          lineageId: run.runId,
          preparation,
          request: preparedRequest,
        });
        const attemptPrompt = preparedRequest.prompt;
        void requestReceiptReady.then((requestReceipt) => {
          this.emit(sessionId, {
            type: 'generation.cognitive_receipt',
            sessionId,
            lineageId: run.runId,
            loop: 'creative',
            receipts: [requestReceipt],
          });
        }).catch((error) => {
          Logger.warn('TuiBridgeService', `Generator request receipt failed for ${run.runId}:`, error);
        });

        this.emit(sessionId, {
          type: 'generation.attempt.started',
          sessionId,
          domain,
          attempt: attempt + 1,
          attemptTotal: domainPlan.length,
          startedAt: new Date(attemptStartedAt).toISOString(),
          timeoutMinutes,
          candidateCount,
          executionMode: 'draft',
        });
        this.transitionRun(sessionId, 'generating', {
          label: `Generating ${domain} draft`,
          model: generatorModelName,
          provider,
        });
        emitReasoningTrace(this.intentCtx, sessionId, {
          phase: 'generation',
          thought: `Calling ${generatorModelName} for a fast ${domain} generation.`,
          detail: 'Fast generation skips evaluator scoring and repair so preview can appear immediately.',
          model: generatorModelName,
          source: 'harness',
        });

        try {
          const orchestrator = retiredDraftTestAdapter.create(domain);
          // Best-of-N: fire candidateCount generations in parallel and keep the
          // strongest by the retired static draft path,
          // so a broken or truncated roll never reaches the canvas.
          // K3 needs its proven five-minute Wave 4 generation window; other
          // models retain the three-minute fast-path cap.
          const draftCandidateTimeoutMinutes = resolveDraftCandidateTimeoutMinutes(
            timeoutMinutes,
            generatorModelName,
          );
          const best = await this.generateBestDraftCandidate(
            orchestrator,
            attemptPrompt,
            domain,
            candidateCount,
            controller,
            generatorModelName,
            sessionId,
            draftCandidateTimeoutMinutes,
            intentBrief.userRequest,
          );
          let attemptResult = best.result;
          if (best.stopped || !attemptResult) {
            this.emit(sessionId, { type: 'activity.updated', sessionId, message: 'Generation stopped by operator.' });
            return;
          }
          if (attemptResult.needsClarification) {
            const clarificationBrief: CreativeIntentBrief = {
              userRequest: intentBrief.userRequest,
              requirements: intentBrief.requirements,
              missingDetails: intentBrief.missingDetails,
              questions: attemptResult.clarifyingQuestions.map((question) => question.question),
              shouldClarify: true,
              reason: `Generation needs clarification for ${domain}.`,
            };
            emitCreativeClarification(this.intentCtx, sessionId, clarificationBrief, conversation);
            await this.finishCreativeRun(sessionId, 'failed');
            return;
          }
          if (!attemptResult.code?.trim()) {
            throw new Error('Generation produced no code');
          }
          if (controller.signal.aborted) {
            this.emit(sessionId, { type: 'activity.updated', sessionId, message: 'Generation stopped by operator.' });
            return;
          }
          const mismatch = describeStrictDomainMismatch(attemptResult.code, domain, domainPlan);
          if (mismatch) {
            this.emit(sessionId, {
              type: 'activity.updated',
              sessionId,
              message: `${mismatch}; retrying ${domain} without changing domains.`,
            });
            this.transitionRun(sessionId, 'repairing', {
              label: `Repairing ${domain} domain mismatch`,
              model: generatorModelName,
              provider,
            });
            const correctionPrompt = domainCorrectionPrompt(attemptPrompt, domain, mismatch);
            const retryController = new AbortController();
            const unlinkRetryAbort = this.linkDraftAttemptToRun(controller.signal, retryController);
            const retryPromise = orchestrator.generate(correctionPrompt, correctionPrompt, true, retryController.signal);
            retryPromise.catch((err) => {
              if (!retryController.signal.aborted) {
                const message = err instanceof Error ? err.message : String(err);
                logBridge('generation.draft.domain_retry_failed', { sessionId, generatorModel: generatorModelName, message });
              }
            });
            let retryResult: RetiredDraftResult | undefined;
            try {
              retryResult = await this.awaitDraftAttempt(retryPromise, controller, retryController, timeoutMinutes);
            } finally {
              unlinkRetryAbort();
            }
            if (!retryResult) {
              this.emit(sessionId, { type: 'activity.updated', sessionId, message: 'Generation stopped by operator.' });
              return;
            }
            if (retryResult.needsClarification) {
              attemptResult = retryResult;
            } else if (retryResult.code?.trim()) {
              attemptResult = retryResult;
            }
          }
          if (attemptResult.needsClarification) {
            const clarificationBrief: CreativeIntentBrief = {
              userRequest: intentBrief.userRequest,
              requirements: intentBrief.requirements,
              missingDetails: intentBrief.missingDetails,
              questions: attemptResult.clarifyingQuestions.map((question) => question.question),
              shouldClarify: true,
              reason: `Generation needs clarification for ${domain}.`,
            };
            emitCreativeClarification(this.intentCtx, sessionId, clarificationBrief, conversation);
            await this.finishCreativeRun(sessionId, 'failed');
            return;
          }
          const retryMismatch = describeStrictDomainMismatch(attemptResult.code, domain, domainPlan);
          if (retryMismatch) throw new Error(retryMismatch);
          if (attemptResult.thinking) {
            const summary = summarizeReasoningTrace(attemptResult.thinking, 'generator');
            emitReasoningTrace(this.intentCtx, sessionId, {
              source: 'generator',
              phase: 'generator-thinking',
              thought: summary.summary,
              detail: summary.details.join(' | ') || attemptResult.thinking.slice(0, 600),
              model: attemptResult.model || generatorModelName,
            });
          }
          result = attemptResult;
          break;
        } catch (err) {
          lastError = err;
          const message = err instanceof Error ? err.message : String(err);
          const nextDomain = domainPlan[attempt + 1];
          this.emit(sessionId, {
            type: 'generation.attempt.failed',
            sessionId,
            domain,
            attempt: attempt + 1,
            attemptTotal: domainPlan.length,
            error: message,
            duration: Date.now() - attemptStartedAt,
            ...this.failureProvenance(err, { provider, model: generatorModelName }),
          });
          this.emit(sessionId, {
            type: 'activity.updated',
            sessionId,
            message: nextDomain
              ? `${domain} did not finish: ${message}. Trying ${nextDomain} next.`
              : `${domain} did not finish: ${message}. No backup medium completed, so recovery choices are available.`,
          });
          this.transitionRun(sessionId, 'repairing', {
            label: nextDomain ? `Trying ${nextDomain} after ${domain} draft failure` : `Recovery needed after ${domain} draft failure`,
            model: generatorModelName,
            provider,
          });
          if (controller.signal.aborted) throw err;
        }
      }

      if (!result || result.needsClarification) {
        throw lastError instanceof Error ? lastError : new Error(String(lastError ?? 'All generation attempts failed'));
      }

      this.emit(sessionId, { type: 'response.delta', sessionId, delta: result.code });
      this.emit(sessionId, { type: 'response.completed', sessionId, content: result.code });
      this.emit(sessionId, { type: 'response.committed', sessionId, content: result.code });
      this.emit(sessionId, {
        type: 'response.metadata',
        sessionId,
        model: result.model || generatorModelName,
        duration: Date.now() - generationStartedAt,
      });

      const codeContent = this.extractCodeContent(result.code);
      if (codeContent) {
        this.emit(sessionId, { type: 'preview.started', sessionId, previewType: 'code' });
        this.emit(sessionId, { type: 'preview.content', sessionId, content: codeContent, previewType: 'code', ...creativeIdentity });
      }

      conversation.appendMessage('assistant', `Generated artifact ready:\n\n${result.code}`);
      this.emit(sessionId, {
        type: 'generation.complete',
        sessionId,
        iterations: 1,
        finalScore: 0,
        duration: Date.now() - generationStartedAt,
        model: result.model || generatorModelName,
        reason: 'generated artifact ready (unscored)',
        qualityState: 'unscored',
        executionMode: 'draft',
        ...creativeIdentity,
      });
      await lineageReady;
      const writeBack = await this.cognitiveWriter.writeBackGeneration({
        sessionId,
        lineageId: run.runId,
        userText,
        domain: activeDomain,
        code: result.code,
        finalScore: 0,
        iterations: 1,
        model: result.model || generatorModelName,
        reason: 'generated artifact ready (unscored)',
        executionMode: 'draft',
        evaluationStatus: 'unavailable',
        evaluationDetail: 'Initial generation intentionally did not run evaluator scoring.',
      });
      this.registerOwnerArtifact(sessionId, run.runId, writeBack);
      this.emit(sessionId, {
        type: 'generation.cognitive_receipt',
        sessionId,
        lineageId: run.runId,
        loop: 'creative',
        receipts: [
          { organ: 'perception', status: 'observed', detail: 'Prompt and generated artifact were captured in the session transcript.' },
          { organ: 'intuition', status: 'observed', detail: `Generation route completed through ${activeDomain}.` },
          { organ: 'evaluation', status: 'unavailable', detail: 'Initial generation intentionally did not run evaluator scoring.' },
          { organ: 'immune-truth', status: 'observed', detail: 'Initial artifact is labeled unscored instead of presented as finished output.' },
          ...writeBack.receipts,
        ],
      });
      this.emit(sessionId, {
        type: 'status.updated',
        sessionId,
        status: this.sessions.update(sessionId, {
          mode: 'chat',
          activeTask: 'Generated artifact ready',
          model: result.model || generatorModelName,
        }),
      });
      this.transitionRun(sessionId, 'rendering', {
        label: 'Rendering draft preview artifact',
        model: result.model || generatorModelName,
        provider,
      });
      await emitPreviewArtifacts(this.previewCtx, sessionId, result.code, activeDomain, routeTruth, creativeThesis);
      this.completeRun(sessionId, {
        label: 'Creative draft complete',
        model: result.model || generatorModelName,
        provider,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const provenance = this.failureProvenance(err, { provider, model: generatorModelName, endpoint: config.baseUrl });
      this.emit(sessionId, {
        type: 'activity.updated',
        sessionId,
        message: `Generation stopped before a usable artifact: ${message}. Try again, polish safely, or switch medium.`,
      });
      this.failRun(sessionId, message, 'failed', {
        label: 'Creative draft needs recovery',
        model: generatorModelName,
        provider,
        ...(typeof provenance.retryable === 'boolean' ? { retryable: provenance.retryable } : {}),
      });
      throw err;
    } finally {
      this.activeStreams.delete(sessionId);
    }
  }

  /**
   * Draft best-of-N. Fires `candidateCount` generations of the same domain in
   * Historical draft helper; unreachable after governed Create retirement.
   * deliberately skips the slow, paid vision evaluator, so selection is a free
   * heuristic — its job is to drop the broken/truncated roll, not to pick the
   * prettiest (that is Polish's job via the real evaluator). Behaviour for
   * candidateCount === 1 is identical to a single generate call. Failure modes
   * fall through to the caller's existing handling: a clarification result still
   * surfaces, an all-rejected batch rethrows so the next fallback domain runs,
   * and an operator stop returns `{ stopped: true }`.
   */
  private async generateBestDraftCandidate(
    orchestrator: RetiredDraftGenerator,
    prompt: string,
    domain: string,
    candidateCount: number,
    runController: AbortController,
    generatorModelName: string,
    sessionId: string,
    timeoutMinutes: number,
    userRequest: string = '',
  ): Promise<{ result: RetiredDraftResult | undefined; stopped: boolean }> {
    void domain;
    const n = Math.min(3, Math.max(1, Math.floor(candidateCount) || 1));
    // Once one candidate is usable, wait at most this long for the rest before
    // proceeding with the best-so-far — so a stalled provider call can't hold the
    // whole batch hostage when we already have a good artifact to show.
    const DRAFT_STRAGGLER_GRACE_MS = 7000;
    // Spread the candidates with the SAME diversity prompting the prove path uses
    // (RalphLoop), so best-of-N selects among genuinely different attempts instead
    // of near-clones that differ only by sampling temperature.
    const harnessTools = new GeneratorHarnessTools({ seededRandom: Math.random });
    const attemptControllers: AbortController[] = [];
    const runOne = async (index: number) => {
      const candidatePrompt = n > 1 ? harnessTools.buildDiversityPrompt(prompt, index, n) : prompt;
      const attemptController = new AbortController();
      attemptControllers[index] = attemptController;
      const unlink = this.linkDraftAttemptToRun(runController.signal, attemptController);
      const generationPromise = orchestrator.generate(candidatePrompt, candidatePrompt, true, attemptController.signal);
      generationPromise.catch((err) => {
        if (!attemptController.signal.aborted) {
          const message = err instanceof Error ? err.message : String(err);
          logBridge('generation.draft.background_failed', { sessionId, generatorModel: generatorModelName, message });
        }
      });
      try {
        return await this.awaitDraftAttempt(generationPromise, runController, attemptController, timeoutMinutes);
      } finally {
        unlink();
      }
    };

    if (n === 1) {
      const result = await runOne(0);
      return { result, stopped: result === undefined && runController.signal.aborted };
    }

    type DraftResult = RetiredDraftResult;
    const isUsable = (r: DraftResult | undefined): r is Extract<DraftResult, { needsClarification: false }> =>
      r !== undefined && !r.needsClarification && Boolean(r.code?.trim());

    // Best-of-N must NOT block on a straggler. Promise.allSettled waited for the
    // SLOWEST candidate, so one stalled provider call (parallel requests the model
    // queues server-side) held the whole batch for the full per-candidate timeout
    // — the user saw "still working" for minutes even when other candidates had
    // already succeeded. Instead: collect candidates as they land; once one is
    // usable, give the rest a short grace, then proceed with the best so far.
    const results: (DraftResult | undefined)[] = [];
    let firstRejection: unknown;
    const tasks = Array.from({ length: n }, (_, index) =>
      runOne(index).then(
        (r) => { results.push(r); },
        (err) => { if (firstRejection === undefined) firstRejection = err; },
      ),
    );
    await new Promise<void>((resolve) => {
      let finished = false;
      let grace: ReturnType<typeof setTimeout> | undefined;
      let pending = n;
      const finish = () => { if (!finished) { finished = true; if (grace) clearTimeout(grace); resolve(); } };
      for (const task of tasks) {
        void task.then(() => {
          pending -= 1;
          if (pending === 0) finish();
          else if (!grace && results.some(isUsable)) grace = setTimeout(finish, DRAFT_STRAGGLER_GRACE_MS);
        });
      }
    });

    // Abandon any stragglers still in flight so they stop occupying the provider.
    if (!runController.signal.aborted) {
      for (const c of attemptControllers) if (c && !c.signal.aborted) c.abort();
    }
    if (runController.signal.aborted) return { result: undefined, stopped: true };

    // Prefer fully-generated candidates and keep the highest-scoring one. Score
    // Historical ordering is retained only for restart-compatible source shape;
    // among candidates of comparable quality the one that better honors what the
    // user asked for wins — without letting a noisy adherence signal override a
    // clearly better artifact.
    const defined = results.filter((r): r is DraftResult => r !== undefined);
    const generated = defined.filter(isUsable);
    if (generated.length > 0) {
      const scoreOf = (code: string) =>
        (retiredDraftTestAdapter?.score(code, domain) ?? 0)
          + (userRequest ? 0.1 * scoreContentAdherence(code, userRequest) : 0);
      let best = generated[0];
      let bestScore = scoreOf(best.code);
      for (let i = 1; i < generated.length; i++) {
        const candidateScore = scoreOf(generated[i].code);
        if (candidateScore > bestScore) {
          best = generated[i];
          bestScore = candidateScore;
        }
      }
      return { result: best, stopped: false };
    }

    // No usable candidate: surface a clarification if one came back, else the
    // first result (carries the error), else rethrow so the caller falls back.
    const clarify = defined.find((r) => r.needsClarification);
    if (clarify) return { result: clarify, stopped: false };
    if (defined.length > 0) return { result: defined[0], stopped: false };
    if (firstRejection !== undefined) throw firstRejection;
    return { result: undefined, stopped: runController.signal.aborted };
  }

  private async awaitDraftAttempt<T>(
    generationPromise: Promise<T>,
    runController: AbortController,
    attemptController: AbortController,
    timeoutMinutes: number,
  ): Promise<T | undefined> {
    const runSignal = runController.signal;
    if (runSignal.aborted) return undefined;

    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    let removeAbortListener = () => {};
    const interruptPromise = new Promise<undefined>((resolve, reject) => {
      const onAbort = () => resolve(undefined);
      runSignal.addEventListener('abort', onAbort, { once: true });
      removeAbortListener = () => runSignal.removeEventListener('abort', onAbort);
      timeoutId = setTimeout(() => {
        const timeoutError = new Error(`Generation timed out after ${timeoutMinutes} minute${timeoutMinutes === 1 ? '' : 's'}`);
        attemptController.abort(timeoutError);
        reject(timeoutError);
        // Attempt timeouts fail only this candidate. Stop still uses the run
        // controller, while this abort prevents stale local model calls from
        // occupying the provider after the UI has moved to recovery/fallback.
      }, timeoutMinutes * 60_000);
    });

    try {
      return await Promise.race([generationPromise, interruptPromise]);
    } finally {
      removeAbortListener();
      if (timeoutId) clearTimeout(timeoutId);
    }
  }

  private linkDraftAttemptToRun(runSignal: AbortSignal, attemptController: AbortController): () => void {
    if (runSignal.aborted) {
      attemptController.abort(runSignal.reason);
      return () => {};
    }
    const onAbort = () => attemptController.abort(runSignal.reason);
    runSignal.addEventListener('abort', onAbort, { once: true });
    return () => runSignal.removeEventListener('abort', onAbort);
  }

  /**
   * Stream a chat response with conversation history and telemetry
   */
  private async streamChatResponse(
    sessionId: string,
    userText: string,
    conversation: ConversationManager,
    llm: LLMClient,
    systemPrompt?: string,
  ): Promise<void> {
    const controller = new AbortController();
    this.activeStreams.set(sessionId, controller);

    const startTime = Date.now();
    const config = llm.getConfig();
    const modelName = config.model || 'unknown';
    logBridge('chat.started', { sessionId, model: modelName, chars: userText.length });

    try {
      // Build conversation context from history
      const conversationContext = conversation.getConversationContext({ excludeLatest: true });

      const fullPrompt = conversationContext
        ? `${conversationContext}user: ${userText}`
        : userText;

      let fullContent = '';
      const effectivePrompt = systemPrompt ?? TUI_SYSTEM_PROMPT;
      for await (const chunk of llm.stream(effectivePrompt, fullPrompt, controller.signal)) {
        fullContent += chunk;
        this.emit(sessionId, { type: 'response.delta', sessionId, delta: chunk });
      }
      if (!fullContent.trim()) {
        throw new Error('Empty response from LLM stream');
      }

      const duration = Date.now() - startTime;

      this.emit(sessionId, { type: 'response.completed', sessionId, content: fullContent });
      this.emit(sessionId, { type: 'response.committed', sessionId, content: fullContent });

      // Emit telemetry
      this.emit(sessionId, {
        type: 'response.metadata',
        sessionId,
        model: modelName,
        duration,
      });

      // Record assistant response in conversation
      conversation.appendMessage('assistant', fullContent);

      // Detect code in response and emit preview events for TUI
      const codeContent = this.extractCodeContent(fullContent);
      if (codeContent) {
        this.emit(sessionId, { type: 'preview.started', sessionId, previewType: 'code' });
        this.emit(sessionId, { type: 'preview.content', sessionId, content: codeContent, previewType: 'code' });
      }

      this.emit(sessionId, {
        type: 'status.updated',
        sessionId,
        status: this.sessions.update(sessionId, {
          mode: 'chat',
          activeTask: fullContent.slice(0, 60),
          model: modelName,
        }),
      });
      logBridge('chat.completed', { sessionId, model: modelName, duration, chars: fullContent.length });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.emit(sessionId, this.errorEvent(sessionId, err, { model: modelName, endpoint: config.baseUrl }));
      logBridge('chat.failed', { sessionId, model: modelName, error: message });
      throw err;
    } finally {
      this.activeStreams.delete(sessionId);
    }
  }

  /**
   * Stream an engineering task through the LLMModeAgent with task lifecycle events.
   */
  private async streamEngineeringTask(
    sessionId: string,
    userText: string,
    conversation: ConversationManager,
    llm: LLMClient,
  ): Promise<void> {
    const controller = new AbortController();
    this.activeStreams.set(sessionId, controller);

    const config = llm.getConfig();
    const modelName = config.model || 'unknown';
    const provider = config.baseUrl ? this.providerLabelFromBaseUrl(config.baseUrl) : 'unknown';
    const liveTaskDescription = this.withLiveSessionContext(sessionId, userText, config);
    const maxSteps = Number(process.env.LIMINAL_TUI_AGENT_MAX_STEPS || 20);
    const agent = createLLMModeAgent(llm);
    const taskId = `studio-eng-${Date.now()}`;

    // Emit task lifecycle events
    this.beginRun(sessionId, {
      kind: 'engineering',
      label: `Engineering task queued: ${userText.slice(0, 60)}`,
      executor: 'llm-mode-agent',
      model: modelName,
      provider,
    });
    this.transitionRun(sessionId, 'planning', { label: 'Planning engineering task' });
    this.emit(sessionId, { type: 'task.queued', sessionId, taskId, description: userText.slice(0, 120) });
    this.emit(sessionId, { type: 'activity.updated', sessionId, message: `Engineering task queued: ${userText.slice(0, 60)}` });

    const listener = (event: BusEvent) => {
      if (event.source !== 'LLMModeAgent') return;
      if (event.type === EventTypes.PROCESS_START || event.type === EventTypes.PROCESS_PROGRESS) {
        const message = event.data.message || event.data.stage || 'working';
        this.emitOperatorProgress(sessionId, event);
        const stage = typeof event.data.stage === 'string' ? event.data.stage : '';
        if (stage.includes('verification') || stage.includes('runBuild') || stage.includes('runTests')) {
          this.transitionRun(sessionId, 'evaluating', { label: String(message), model: modelName, provider });
        } else if (stage.startsWith('planned ')) {
          this.transitionRun(sessionId, 'planning', { label: String(message), model: modelName, provider });
        } else if (stage.startsWith('executed ')) {
          this.transitionRun(sessionId, 'generating', { label: String(message), model: modelName, provider });
        }
        this.emit(sessionId, { type: 'activity.updated', sessionId, message: String(message) });
        this.emitLiveNarration(sessionId, String(message));
      }
      if (event.type === EventTypes.PROCESS_END) {
        const message = event.data.success ? 'Task complete' : `Task failed: ${String(event.data.reason || 'unknown')}`;
        this.emit(sessionId, { type: 'activity.updated', sessionId, message });
        this.emitLiveNarration(sessionId, message);
      }
    };

    eventBus.onEvent(listener);
    logBridge('engineering.started', { sessionId, taskId, model: modelName, maxSteps });

    try {
      this.emit(sessionId, { type: 'task.started', sessionId, taskId });
      this.transitionRun(sessionId, 'generating', { label: 'Executing engineering task', model: modelName, provider });

      const session = await agent.executeTask({
        id: taskId,
        title: `Studio engineering: ${userText.slice(0, 60)}`,
        description: liveTaskDescription,
        maxSteps,
        approved: true,
      });

      const fullContent = this.formatAgentSession(session);
      for (const chunk of this.chunkString(fullContent, 80)) {
        this.emit(sessionId, { type: 'response.delta', sessionId, delta: chunk });
        await new Promise(r => setTimeout(r, 5));
      }
      this.emit(sessionId, { type: 'response.completed', sessionId, content: fullContent });
      this.emit(sessionId, { type: 'response.committed', sessionId, content: fullContent });
      conversation.appendMessage('assistant', fullContent);

      const duration = new Date(session.endTime || new Date().toISOString()).getTime() - new Date(session.startTime).getTime();
      const lifecycle = describeStatusLifecycle(session.status, session.lastPlanError, {
        lastVerification: session.lastVerification,
        mutatedFiles: Array.from(session.mutatedFiles),
      });
      this.emit(sessionId, { type: 'response.metadata', sessionId, model: modelName, duration });
      this.emit(sessionId, { type: 'task.completed', sessionId, taskId, success: lifecycle.succeeded, durationMs: duration });

      this.emit(sessionId, {
        type: 'status.updated',
        sessionId,
        status: this.sessions.update(sessionId, {
          mode: 'chat',
          activeTask: `Engineering ${session.status}`,
          model: modelName,
        }),
      });
      if (lifecycle.succeeded) {
        this.completeRun(sessionId, {
          label: 'Engineering task complete',
          model: modelName,
          provider,
          agentStatus: session.status,
          resumable: lifecycle.resumable,
          retryable: lifecycle.retryable,
          nextAction: lifecycle.nextAction,
        });
      } else if (lifecycle.resumable) {
        this.suspendRun(
          sessionId,
          session.lastPlanError || `Engineering ${session.status}`,
          {
            label: 'Engineering suspended - resumable',
            lastPlanError: session.lastPlanError,
            agentStatus: session.status,
            resumable: true,
            retryable: lifecycle.retryable,
            nextAction: lifecycle.nextAction,
            model: modelName,
            provider,
          },
        );
      } else {
        this.failRun(
          sessionId,
          session.lastPlanError || `Engineering ${session.status}`,
          'failed',
          {
            label: `Engineering ${session.status}`,
            lastPlanError: session.lastPlanError,
            agentStatus: session.status,
            resumable: false,
            retryable: lifecycle.retryable,
            nextAction: lifecycle.nextAction,
            model: modelName,
            provider,
          },
        );
      }

      logBridge('engineering.completed', {
        sessionId,
        taskId,
        status: session.status,
        steps: session.stepCount,
        tools: this.agentToolsUsed(session),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.failRun(sessionId, message);
      throw err;
    } finally {
      eventBus.offEvent(listener);
      this.activeStreams.delete(sessionId);
    }
  }

  private withLiveSessionContext(
    sessionId: string,
    userText: string,
    config: ReturnType<LLMClient['getConfig']>,
  ): string {
    const status = this.getStatus(sessionId);
    const runtimeProvider = config.baseUrl
      ? this.providerLabelFromBaseUrl(config.baseUrl)
      : status.provider || 'unknown';
    const runtimeModel = config.model || status.model || 'unknown';
    const lines = [
      userText,
      '',
      'Live Bubble Tea session context:',
      `- sessionId: ${sessionId}`,
      `- status.provider: ${status.provider || 'unknown'}`,
      `- status.model: ${status.model || 'unknown'}`,
      `- runtime.provider: ${runtimeProvider}`,
      `- runtime.model: ${runtimeModel}`,
      `- runtime.baseUrl: ${config.baseUrl || 'unknown'}`,
      '',
      'Treat this context as live bridge-provided evidence for the current TUI session provider/model.',
    ];
    return lines.join('\n');
  }

  private providerLabelFromBaseUrl(baseUrl: string): string {
    const label = detectProviderLabel(baseUrl);
    return label === 'llm' ? 'unknown' : label;
  }


  private emitOperatorProgress(sessionId: string, event: BusEvent): void {
    const current = typeof event.data.current === 'number' ? event.data.current : undefined;
    const total = typeof event.data.total === 'number' ? event.data.total : undefined;
    const stage = typeof event.data.stage === 'string' ? event.data.stage : '';
    const message = typeof event.data.message === 'string' ? event.data.message : stage;

    if (current != null || total != null) {
      this.emit(sessionId, {
        type: 'phase.changed',
        sessionId,
        phase: this.phaseForProcessStage(stage),
        stepCurrent: current,
        stepTotal: total,
        objective: message,
      });
    }

    if (stage.startsWith('planned ')) {
      const toolName = stage.slice('planned '.length).trim();
      if (!toolName) return;
      if (toolName === 'complete') return;
      const thought = (typeof event.data.thought === 'string' && event.data.thought)
        || message.replace(new RegExp(`^${toolName}:\\s*`), '');
      this.emit(sessionId, {
        type: 'tool.started',
        sessionId,
        toolName,
        thought,
        displayLabel: thought || toolName,
        stepNum: current,
      });
      return;
    }

    if (stage.startsWith('executed ')) {
      const toolName = stage.slice('executed '.length).trim();
      if (!toolName) return;
      const failed = /\bfailed\b/i.test(message);
      this.emit(sessionId, {
        type: 'tool.completed',
        sessionId,
        toolName,
        resultSummary: message,
        success: !failed,
        stepNum: current,
      });
    }
  }

  private phaseForProcessStage(stage: string): string {
    if (stage.includes('verification') || stage.includes('typeCheck') || stage.includes('runBuild') || stage.includes('runTests')) return 'Verify';
    if (stage.startsWith('executed ')) return 'Inspect';
    if (stage.startsWith('planned ')) return 'Plan';
    return 'Plan';
  }

  /**
   * Stream a hybrid task: creative generation followed by engineering verification.
   */
  private async streamHybridTask(
    sessionId: string,
    userText: string,
    conversation: ConversationManager,
    llm: LLMClient,
    options: Pick<TuiInputRequest, 'creativePreferences' | 'guidanceAnswers'> = {},
  ): Promise<void> {
    // Phase 1: Creative generation
    this.emit(sessionId, { type: 'activity.updated', sessionId, message: 'Starting creative generation...' });
    await this.streamGovernedProductCreate(sessionId, userText, conversation, options);

    // Phase 2: Engineering verification
    this.emit(sessionId, { type: 'activity.updated', sessionId, message: 'Verifying with engineering agent...' });
    await this.streamEngineeringTask(sessionId, `Verify and improve the creative output for: ${userText}`, conversation, llm);
  }

  private cancelStream(sessionId: string): void {
    const controller = this.activeStreams.get(sessionId);
    if (controller) {
      controller.abort();
      this.activeStreams.delete(sessionId);
    }
  }

  /** Extract code from markdown fences or detect raw code patterns */
  private extractCodeContent(content: string): string | null {
    // Try markdown fence extraction
    const fenceMatch = content.match(/```[\w]*\n([\s\S]*?)```/);
    if (fenceMatch) return fenceMatch[1].trim();

    // Detect raw code patterns (function declarations, const assignments)
    if (/\bfunction\s+\w+/.test(content) || /\bconst\s+\w+\s*=\s*\(.*\)\s*=>/.test(content)) {
      return content.trim();
    }

    return null;
  }

  private formatAgentSession(session: LLMSession): string {
    const lifecycle = describeStatusLifecycle(session.status, session.lastPlanError, {
      lastVerification: session.lastVerification,
      mutatedFiles: Array.from(session.mutatedFiles),
    });
    const duration = session.endTime
      ? new Date(session.endTime).getTime() - new Date(session.startTime).getTime()
      : Date.now() - new Date(session.startTime).getTime();
    const toolLines = session.messages
      .filter((m) => m.toolCall)
      .map((m) => {
        const mIndex = session.messages.indexOf(m);
        const result = mIndex >= 0
          ? session.messages.slice(mIndex + 1).find((candidate) => candidate.role === 'tool' && candidate.toolResult)
          : undefined;
        return `- ${m.toolCall?.tool}: ${m.toolCall?.thought}${result?.toolResult ? ` (${result.toolResult.success ? 'ok' : 'failed'})` : ''}`;
      })
      .slice(-12);
    const touchedFiles = Array.from(session.mutatedFiles);
    const filesChanged = session.status === 'rolled_back' ? [] : touchedFiles;
    const rolledBackFiles = session.status === 'rolled_back' ? touchedFiles : [];
    const testTools = new Set(['runTests', 'runFocusedTests']);
    const otherVerificationTools = new Set(['typeCheck', 'runBuild']);
    const testsRun = session.messages
      .filter((m) => m.toolCall && testTools.has(m.toolCall.tool))
      .map((m) => `- ${m.toolCall?.tool}`);
    const otherVerificationRun = session.messages
      .filter((m) => m.toolCall && otherVerificationTools.has(m.toolCall.tool))
      .map((m) => `- ${m.toolCall?.tool}`);
    const verdict = session.status === 'success'
      ? 'The engineering run completed successfully.'
      : lifecycle.resumable
        ? 'The engineering run is suspended with a checkpoint and can be resumed.'
      : session.status === 'failed' || session.status === 'rolled_back'
        ? 'The engineering run did not complete successfully.'
        : 'The engineering run completed with unresolved issues.';
    const evidence = [
      `- Task: ${session.task.title}`,
      `- Steps: ${session.stepCount}`,
      `- Duration: ${duration}ms`,
      `- Tools used: ${this.agentToolsUsed(session).join(', ') || 'none'}`,
      ...formatStatusEvidenceLines(lifecycle),
    ];

    return [
      `Status: ${session.status}`,
      `Verdict:`,
      verdict,
      `Evidence:`,
      evidence.join('\n'),
      `Files changed:`,
      filesChanged.length > 0
        ? filesChanged.map((file) => `- ${file}`).join('\n')
        : rolledBackFiles.length > 0
          ? `- none (rolled back ${rolledBackFiles.length} touched file${rolledBackFiles.length === 1 ? '' : 's'})`
          : '- none',
      `Tests run:`,
      testsRun.length > 0 ? testsRun.join('\n') : '- none recorded',
      `Other verification:`,
      otherVerificationRun.length > 0 ? otherVerificationRun.join('\n') : '- none recorded',
      ...(session.lastPlanError ? [
        `Last planning failure:`,
        session.lastPlanError,
      ] : []),
      `Remaining risks:`,
      formatStatusRiskLine(lifecycle),
      `Recommended next action:`,
      session.status === 'success'
        ? '- Review the diff and merge if the changes match intent.'
        : `- ${formatStatusNextAction(lifecycle.nextAction)}`,
      '',
      `Supporting tool trace:`,
      toolLines.length > 0 ? toolLines.join('\n') : '- no tool calls recorded',
    ].join('\n');
  }

  private agentToolsUsed(session: LLMSession): string[] {
    return Array.from(new Set(
      session.messages
        .map((m) => m.toolCall?.tool)
        .filter((tool): tool is string => Boolean(tool))
    ));
  }

  /** Split string into chunks for streaming effect */
  private chunkString(str: string, chunkSize: number): string[] {
    const chunks: string[] = [];
    for (let i = 0; i < str.length; i += chunkSize) {
      chunks.push(str.slice(i, i + chunkSize));
    }
    return chunks;
  }

  /** Context adapter for PreviewService (F20 extraction). */
  private get previewCtx(): PreviewContext {
    return {
      emit: (sid: string, ev: TuiBridgeEvent) => this.emit(sid, ev),
      emitDomainTruth: (sid: string, route: CreativeDomainRouteTruth, patch: { generatedDomain?: string; previewDomain?: string; artifactPath?: string }) =>
        this.emitDomainTruth(sid, route, patch),
      transitionRun: (sid: string, phase: TuiRunPhase, patch?: Partial<Omit<TuiRunLifecycle, 'runId' | 'kind' | 'startedAt'>>) =>
        this.transitionRun(sid, phase, patch),
    };
  }

  /** Context adapter for CommandDispatcher (F20 extraction). */
  private get commandCtx(): CommandContext {
    return {
      emit: (sid: string, ev: TuiBridgeEvent) => this.emit(sid, ev),
      emitCommandResponse: (sid: string, content: string) => this.emitCommandResponse(sid, content),
      skillRunner: this.skillRunner,
      skillCatalog: this.skillCatalog,
      reviewManager: this.reviewManager,
      diffRenderer: this.diffRenderer,
      onboardingWizard: this.onboardingWizard,
      envValidator: this.envValidator,
      sessionResumer: this.sessionResumer,
      reportGenerator: this.reportGenerator,
      workspaceManager: this.workspaceManager,
      autonomyController: this.autonomyController,
      modeRegistry: this.modeRegistry,
      conversations: this.conversations,
      sessionGraphs: this.sessionGraphs,
      sessions: this.sessions,
      cortexLoop: this.cortexLoop,
      cortexBus: this.cortexBus,
      setProductMode: (sid: string, mode: ProductMode) => this.setProductMode(sid, mode),
      ensureSessionsHydrated: () => this.ensureSessionsHydrated(),
      recordReviewPreference: (sid, action, artifactId, auth) =>
        this.recordReviewPreference(sid, action, artifactId, auth),
      getGoalStore: () => this.getGoalStore(),
      getArtistReviewState: (sid: string) => this.getArtistReviewState(sid),
      executeArtistReviewAction: (sid: string, token: string) =>
        this.executeArtistReviewAction(sid, token),
      getTransferPromotionDecision: (sid: string) =>
        this.getTransferPromotionDecision(sid),
      streamGovernedProductCreate: (sid: string, text: string, conv: ConversationManager,
        opts?: Pick<TuiInputRequest, 'creativePreferences' | 'guidanceAnswers'>) =>
        this.streamGovernedProductCreate(sid, text, conv, opts),
      streamEngineeringTask: (sid: string, text: string, conv: ConversationManager, llm: LLMClient) =>
        this.streamEngineeringTask(sid, text, conv, llm),
      streamChatResponse: (sid: string, text: string, conv: ConversationManager, llm: LLMClient, sp?: string) =>
        this.streamChatResponse(sid, text, conv, llm, sp),
      cortexConfig: TuiBridgeService.CORTEX_CONFIG,
    };
  }

  /** Context adapter for CreativeIntentHelpers (F20 extraction). */
  private get intentCtx(): IntentEmitContext {
    return {
      emit: (sid: string, ev: TuiBridgeEvent) => this.emit(sid, ev),
      updateSession: (sid: string, patch: Partial<TuiSessionStatus>) =>
        this.sessions.update(sid, patch),
    };
  }
  private emit(sessionId: string, event: TuiBridgeEvent): void {
    this.stream.publish(sessionId, event);
  }


  /**
   * Publish a typed operator event into a session stream.
   * Used by the Bubble Tea operator-surface tests and by future explicit
   * operator instrumentation publishers.
   */
  publishEvent<T extends TuiBridgeEvent['type']>(
    sessionId: string,
    event: Omit<Extract<TuiBridgeEvent, { type: T }>, 'sessionId'>,
  ): void {
    this.emit(sessionId, { ...event, sessionId } as TuiBridgeEvent);
  }

  private emitLiveNarration(sessionId: string, message: string): void {
    if (!message.trim()) return;
    this.emit(sessionId, {
      type: 'response.delta',
      sessionId,
      delta: `${message}\n`,
    });
  }
  /** Stop cortex broadcast timer, loop, and perception bus. Call on shutdown. */
  destroy(): void {
    this.artistReviews.clear();
    this.authenticArtistReviews.clear();
    this.artistActionCheckpoints.clear();
    this.hostIssuedArtistActions.clear();
    this.artistReviewBootstrapGrants.clear();
    this.promotionReviewers.clear();
    this.promotionRenderGates.clear();
    this.transferPromotions.clear();
    this.transferPromotionCheckpoints.clear();
    this.governedOwnerClosures.clear();
    this.governedRevisionDecisionSessions.clear();
    if (this.gardener) {
      this.gardener.stop();
      this.gardener = null;
    }
    if (this.cortexBroadcastTimer !== null) {
      clearInterval(this.cortexBroadcastTimer);
      this.cortexBroadcastTimer = null;
    }
    if (this.cortexLoop) {
      this.cortexLoop.stop();
      this.cortexLoop = null;
    }
    this.cortexBus.stop();
  }
}
