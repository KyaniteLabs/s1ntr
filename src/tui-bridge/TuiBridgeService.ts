import { AutonomyController } from '../agent/AutonomyController.js';
import { DiffRenderer } from '../agent/DiffRenderer.js';
import { EnvironmentValidator } from '../agent/EnvironmentValidator.js';
import { IntentRouter } from '../agent/IntentRouter.js';
import { ModeRegistry } from '../agent/ModeRegistry.js';
import { OnboardingWizard } from '../agent/OnboardingWizard.js';
import type { ModeConfig, ProductMode } from '../agent/ProductMode.js';
import { ReportGenerator } from '../agent/ReportGenerator.js';
import { ReviewManager } from '../agent/ReviewManager.js';
import { SessionGraph } from '../agent/SessionGraph.js';
import { SessionResumer } from '../agent/SessionResumer.js';
import { SkillCatalog } from '../agent/SkillCatalog.js';
import { SkillRunner } from '../agent/SkillRunner.js';
import { WorkspaceManager } from '../agent/WorkspaceManager.js';
import { AutonomousGardener, type GardenerCycleResult, type GardenerDreamProposal } from '../autonomy/AutonomousGardener.js';
import { ConversationManager } from '../chat/ConversationManager.js';
import type { ArtistReviewSurface } from '../cli/ArtistReviewCli.js';
import type { CompositionRequest } from '../composition/CompositionGraph.js';
import type { CompositionResult, CompositionSpec } from '../composition/CompositionOrchestrator.js';
import type { Wave6Lane } from '../composition/StudioControlRecipe.js';
import { type BusEvent, eventBus, EventTypes } from '../core/EventBus.js';
import { CortexLivingLoopConductor, FileCortexCycleStore, type LivingLoopCheckpoint, type LivingLoopExecutionContext, type LivingLoopExecutionResult, type LivingLoopRequest, type LivingLoopStep, type LivingLoopStepExecutor } from '../cortex/CortexLivingLoop.js';
import { CortexPerceptionBus } from '../cortex/CortexPerceptionBus.js';
import { GoalStore } from '../cortex/GoalStore.js';
import { SinterCortex } from '../cortex/SinterCortex.js';
import type { CreativeThesis } from '../creative-intelligence/CreativeIntelligence.js';
import type { ArtistReviewAction, ArtistReviewActionResult, ArtistReviewSession, ArtistReviewState } from '../creative-run/ArtistReviewExperience.js';
import type { CampaignClosureEvidenceAuthority } from '../creative-run/CampaignClosure.js';
import type { CampaignExecutionPlan, CampaignManifest } from '../creative-run/CampaignManifest.js';
import type { CampaignLedgerPersistence } from '../creative-run/CampaignPersistence.js';
import type { CampaignOriginReceiptVerifier } from '../creative-run/CampaignProgressJournal.js';
import { type CampaignExecutionInputV1, CampaignService, type CampaignTransferEvaluator, type CampaignTransferTarget } from '../creative-run/CampaignService.js';
import { type CampaignEvidenceCheckpoint, CreativeRunCoordinator, type CreativeRunHandle, type OwnerAuthorityBootstrapConfig, type OwnerAuthorityCapability } from '../creative-run/CreativeRunCoordinator.js';
import type { CampaignRunAdmission } from '../creative-run/CreativeRunCoordinatorBase.js';
import { bootstrapProductionOwnerReviewHost, type OwnerReviewLifecycleResult } from '../creative-run/OwnerReviewLifecycle.js';
import type { TransferPromotionDecision } from '../creative-run/TransferPromotionGate.js';
import { DreamQueue } from '../dreaming/DreamQueue.js';
import { type DreamAssimilationGovernance, type DreamTaskConsumer, GovernedDreamTaskRunner } from '../dreaming/DreamTaskRunner.js';
import { DreamArchiveSourceAdmission } from '../dreaming/research/DreamArchiveSourceAdmission.js';
import { UnavailableDreamResearchConsumer } from '../dreaming/research/DreamResearchBootstrap.js';
import { createDreamRenderedEvidenceAuthority } from '../dreaming/research/DreamResearchEvidence.js';
import { EmergenceHooks } from '../emergence/EmergenceHooks.js';
import type { DescriptorAxis } from '../emergence/types.js';
import { SinterFS } from '../fs/SinterFS.js';
import type { LLMSession } from '../harness/agent/index.js';
import type { HarnessTransportAuthority } from '../identity/harnessTransportGuard.js';
import { TasteLearningService } from '../learning/TasteLearningService.js';
import type { LLMClient } from '../llm/LLMClient.js';
import { ensureWave8LivePreSpendInterlockConfigured } from '../llm/PreSpendInterlock.js';
import type { CompoundCreateCommand, CompoundCreateProjection, CompoundCreateProofPort } from '../runtime-core/CompoundCreateProofPort.js';
import type { DreamProductCommand, DreamProductCommandPort, DreamProductProjection } from '../runtime-core/DreamProductCommandPort.js';
import type { DreamActivationCommand, DreamActivationCommandPort, DreamActivationProjection, DreamTransferCommand, DreamTransferCommandPort, DreamTransferProjection } from '../runtime-core/DreamTransferActivationPort.js';
import type { LiminalCreativeCommand } from '../runtime-core/LiminalCommandService.js';
import type { LiminalProductCommandPort, LiminalProductProjection } from '../runtime-core/LiminalProductCommandPort.js';
import { OwnerReactionCausality, type OwnerReactionSource } from '../runtime-core/OwnerReactionCausality.js';
import { Logger } from '../utils/Logger.js';
import { continueCampaignStudioJourney, runGovernedCampaignStudioJourney } from './CampaignStudio.js';
import type { CommandContext } from './CommandDispatcher.js';
import type { CreativeDomainRouteTruth } from './CreativeDomainRouting.js';
import type { IntentEmitContext } from './CreativeIntentHelpers.js';
import { DurableCampaignContinuationContextRegistry } from './DurableCampaignContinuationContext.js';
import { EvaluationAdmissionAuthority, PostGenerationCognitiveWriter } from './PostGenerationCognitiveWriter.js';
import type { PreviewContext } from './PreviewService.js';
import { TuiEventStream, type TuiRunEventReplay } from './TuiEventStream.js';
import { TuiSessionStore } from './TuiSessionStore.js';
import type { ArtistReviewBootstrapGrant, ArtistReviewBootstrapOptions, AuthenticatedBridgeActor, BridgeHostAuthorityRegistry, IssuedBridgeActionCheckpoint, TransferPromotionCheckpointKind, TransferPromotionWorkflow, TransferPromotionWorkflowState } from './service/bridgeTypes.js';
import { CORTEX_BROADCAST_INTERVAL_MS, CORTEX_CONFIG, GARDENER_CONFIG, PRIOR_ARTIFACT_EXCERPT_MAX_CHARS } from './service/constants.js';
import type { RetiredDraftGenerator, RetiredDraftResult } from './service/retiredDraftAdapter.js';
import type { TuiBridgeEvent, TuiFailureProvenance, TuiInputRequest, TuiPendingAction, TuiRunExecutor, TuiRunKind, TuiRunLifecycle, TuiRunPhase, TuiSessionStatus } from './types.js';
import { createHash } from 'node:crypto';
import { resolveDreamQueuePath } from '../dreaming/dreamQueuePath.js';
import path from 'node:path';
import * as artistReview from './service/ArtistReview.js';
import * as draftGeneration from './service/DraftGeneration.js';
import * as governedCampaign from './service/GovernedCampaign.js';
import * as governedCreate from './service/GovernedCreate.js';
import * as inputHandling from './service/InputHandling.js';
import * as lazyServices from './service/LazyServices.js';
import * as livingLoop from './service/LivingLoop.js';
import * as productCommands from './service/ProductCommands.js';
import * as runLifecycle from './service/RunLifecycle.js';
import * as streamHandlers from './service/StreamHandlers.js';
import * as transferPromotion from './service/TransferPromotion.js';

export { installRetiredDraftTestAdapter } from './service/retiredDraftAdapter.js';
export type { ArtistReviewBootstrapOptions, TransferPromotionWorkflowState, AuthenticatedBridgeActor, BridgeHostAuthorityRegistry, IssuedBridgeActionCheckpoint } from './service/bridgeTypes.js';
export { TUI_SYSTEM_PROMPT, isSelfImprovementRequest, isOperatorInspectionRequest, isGenerationRequest, resolveDraftCandidateTimeoutMinutes } from './service/requestClassification.js';

export class TuiBridgeService {
  sessions = new TuiSessionStore();
  stream = new TuiEventStream({ maxStoredEventsPerSession: 500 });
  activeStreams = new Map<string, AbortController>();
  // Step 1: Conversation memory - one ConversationManager per session
  conversations = new Map<string, ConversationManager>();
  // Studio routing: intelligent intent classification replaces keyword matching
  router = new IntentRouter();
  // Session persistence: records every turn per session
  sessionGraphs = new Map<string, SessionGraph>();
  // Product mode registry: per-session mode biasing
  modeRegistry = new ModeRegistry();
  // Skill runner: resolves and executes skill templates
  skillRunner = new SkillRunner();
  // Skill catalog: lists skills with mode filtering
  skillCatalog = new SkillCatalog();
  // Review manager: candidate lifecycle (accept/reject/pin)
  reviewManager = new ReviewManager();
  // Diff renderer: unified diff between candidates
  diffRenderer = new DiffRenderer();
  // Onboarding wizard: provider setup
  onboardingWizard = new OnboardingWizard();
  // Environment validator: diagnostics
  envValidator = new EnvironmentValidator();
  // Session resumer: session history
  sessionResumer = new SessionResumer();
  // Report generator: session reports from SessionGraph data
  reportGenerator = new ReportGenerator();
  // Workspace manager: workspace CRUD
  workspaceManager = new WorkspaceManager();
  // Autonomy controller: approval gating per level
  autonomyController = new AutonomyController();
  // Cortex perception bus: aggregates live system state from EventBus
  cortexBus = new CortexPerceptionBus(eventBus);
  // Cortex goal store: persists user goals via SinterFS
  goalStore: GoalStore | null = null;
  // Cortex loop: background executive that fuses perception + goals into actions
  cortexLoop: SinterCortex | null = null;
  // Autonomous gardener: coordinates taste learning, dream recombination, emergence cycles
  gardener: AutonomousGardener | null = null;
  // Taste learning service: records preference events and hydrates gardener replay bias.
  tasteLearningService: TasteLearningService | null = null;
  // Emergence hooks: reads persisted archive experience so the gardener hydrates each cycle
  emergenceHooks: EmergenceHooks | null = null;
  // Shared SinterFS handle for session persistence/hydration; opened lazily.
  sinterFs: SinterFS | null = null;
  // Guards one-time hydration of persisted sessions into the resumer.
  sessionsHydrated = false;
  // Cognitive write-back: memory, compost, and dreaming receipts for Studio generation
  cognitiveWriter: PostGenerationCognitiveWriter;
  readonly evaluationAuthority = new EvaluationAdmissionAuthority();
  readonly dreamRenderedEvidenceAuthority = createDreamRenderedEvidenceAuthority();
  readonly dreamSourceAdmission = new DreamArchiveSourceAdmission(
    this.dreamRenderedEvidenceAuthority.resolver);
  readonly governedDreamRunner: DreamTaskConsumer;
  readonly ownerReactions: OwnerReactionCausality;
  /** Handle for the cortex broadcast interval (stored for cleanup) */
  cortexBroadcastTimer: ReturnType<typeof setInterval> | null = null;
  readonly creativeRunCoordinator: CreativeRunCoordinator;
  readonly campaignService: CampaignService;
  readonly campaignDreamQueue: DreamQueue;
  readonly campaignDreamGovernance?: DreamAssimilationGovernance;
  readonly creativeRuns = new Map<string, CreativeRunHandle>();
  readonly artistReviews = new Map<string, ArtistReviewSurface>();
  readonly authenticArtistReviews = new Map<string, ArtistReviewSession>();
  readonly artistReviewBootstrapGrants = new Map<string, ArtistReviewBootstrapGrant>();
  readonly artistActionCheckpoints = new Map<string, Readonly<{
    sessionId: string; principalId: string; ownerCapability: OwnerAuthorityCapability;
    stateDigest: string; scopeDigest: string; expiresAt: number;
  }>>();
  readonly hostIssuedArtistActions = new Set<string>();
  readonly promotionReviewers = new Map<string, OwnerAuthorityCapability>();
  readonly promotionRenderGates = new Map<string, boolean>();
  readonly transferPromotions = new Map<string, TransferPromotionWorkflow>();
  readonly transferPromotionCheckpoints = new Map<string, Readonly<{
    sessionId: string; kind: TransferPromotionCheckpointKind;
    principalId: string; runId: string; state: TransferPromotionWorkflowState['status'];
    expiresAt: number;
  }>>();
  /** Campaign admission state; original owner review remains a separate quality gate. */
  readonly governedOwnerClosures = new Map<string, {
    readonly admission: CampaignRunAdmission;
    readonly manifest: CampaignManifest;
    readonly reviews: ReadonlyMap<string, OwnerReviewLifecycleResult>;
    readonly completedBriefIds: Set<string>;
  }>();
  /** Host-only durable continuation material; HTTP callers can name only the campaign run. */
  readonly governedContinuations?: DurableCampaignContinuationContextRegistry;
  /** Exact host registration prevents one Artist Review session closing another brief. */
  readonly governedRevisionDecisionSessions = new Map<string, Map<string, Readonly<{
    readonly sessionId: string;
    readonly revisionEvidenceId: string;
    readonly ownerDecisionEvidenceId: string;
  }>>>();
  readonly hostAuthorityRegistry?: BridgeHostAuthorityRegistry;
  readonly campaignPreSpendInstaller: () => void;
  readonly productCommands?: LiminalProductCommandPort;
  readonly productCreateCommand?: (input: { prompt: string; domain: string;
    layers: readonly string[]; maxTransportAttempts: number }) =>
      LiminalCreativeCommand | Promise<LiminalCreativeCommand>;
  readonly dreamCommands?: DreamProductCommandPort;
  readonly dreamTransferCommands?: DreamTransferCommandPort;
  readonly dreamActivationCommands?: DreamActivationCommandPort;
  readonly compoundCreateCommands?: CompoundCreateProofPort;
  readonly now: () => string;

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
      ?? resolveDreamQueuePath() });
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
    }, CORTEX_BROADCAST_INTERVAL_MS);

    // Start the Cortex background executive loop.
    // Fuses perception + goals into priority-ranked actions, emitting
    // cortex.loop_tick, cortex.decision, and cortex.action_proposed events.
    this.cortexLoop = new SinterCortex({
      perceptionBus: this.cortexBus,
      goalStore: {
        getActiveGoals: () => this.getGoalStore()?.getActiveGoals() ?? [],
      },
      config: CORTEX_CONFIG,
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
    this.gardener = new AutonomousGardener({ ...GARDENER_CONFIG,
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
  submitLiminalCreate(surface: 'studio' | 'chat', command: LiminalCreativeCommand): Promise<LiminalProductProjection> { return productCommands.submitLiminalCreate(this, surface, command); }
  submitStudioCreate(intent: { prompt: string; domain: string;
    layers: readonly string[] }): Promise<LiminalProductProjection> { return productCommands.submitStudioCreate(this, intent); }
  submitDreamResearch(command: DreamProductCommand): Promise<DreamProductProjection> { return productCommands.submitDreamResearch(this, command); }
  submitDreamTransfer(command: DreamTransferCommand): Promise<DreamTransferProjection> { return productCommands.submitDreamTransfer(this, command); }
  submitDreamActivation(command: DreamActivationCommand): Promise<DreamActivationProjection> { return productCommands.submitDreamActivation(this, command); }
  submitCompoundCreate(command: CompoundCreateCommand): Promise<CompoundCreateProjection> { return productCommands.submitCompoundCreate(this, command); }
  productCommandPort(): LiminalProductCommandPort { return productCommands.productCommandPort(this); }
  proposeGardenerDream(proposal: GardenerDreamProposal): void { return productCommands.proposeGardenerDream(this, proposal); }
  readLiminalProjection(idempotencyKey: string): Promise<LiminalProductProjection | null> { return productCommands.readLiminalProjection(this, idempotencyKey); }
  composeStudioLayersGoverned(spec: CompositionSpec) { return productCommands.composeStudioLayersGoverned(this, spec); }
  composeStudioLayers(spec: CompositionRequest, options: {
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
    } = {}): Promise<CompositionResult & {
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
  }> { return productCommands.composeStudioLayers(this, spec, options); }
  createSession(patch: Partial<Pick<TuiSessionStatus, 'provider' | 'model' | 'roles' | 'evaluation'>> = {}, artistReviewGrant?: string): TuiSessionStatus { return productCommands.createSession(this, patch, artistReviewGrant); }

  getStatus(sessionId: string): TuiSessionStatus {
    const status = this.sessions.get(sessionId);
    if (!status) throw new Error(`Unknown TUI session: ${sessionId}`);
    return status;
  }
  registerArtistReview(sessionId: string, surface: ArtistReviewSurface): ArtistReviewState { return artistReview.registerArtistReview(this, sessionId, surface); }
  registerAuthenticArtistReview(sessionId: string, review: ArtistReviewSession): ArtistReviewState { return artistReview.registerAuthenticArtistReview(this, sessionId, review); }
  registerGovernedOwnerReviewResults(admission: CampaignRunAdmission, manifest: CampaignManifest, reviews: readonly OwnerReviewLifecycleResult[], alreadyClosed = false): void { return governedCampaign.registerGovernedOwnerReviewResults(this, admission, manifest, reviews, alreadyClosed); }
  registerGovernedCampaignContinuationForHost(input: {
    readonly sessionId: string;
    readonly ownerCredential: string;
    readonly manifest: CampaignManifest;
    readonly plan: CampaignExecutionPlan;
    readonly checkpoint: CampaignEvidenceCheckpoint;
    readonly learningEvidenceId: string;
    readonly target: CampaignTransferTarget;
  }): Promise<void> { return governedCampaign.registerGovernedCampaignContinuationForHost(this, input); }
  persistGovernedCampaignContinuation(input: {
    readonly manifest: CampaignManifest;
    readonly plan: CampaignExecutionPlan;
    readonly checkpoint: CampaignEvidenceCheckpoint;
    readonly learningEvidenceId: string;
    readonly ownerPrincipalId: string;
    readonly target: CampaignTransferTarget;
  }): Promise<void> { return governedCampaign.persistGovernedCampaignContinuation(this, input); }
  continueGovernedCampaign(sessionId: string, ownerCredential: string, campaignRunId: string) { return governedCampaign.continueGovernedCampaign(this, sessionId, ownerCredential, campaignRunId); }
  issueArtistReviewBootstrap(options: ArtistReviewBootstrapOptions): string { return artistReview.issueArtistReviewBootstrap(this, options); }
  claimArtistReviewBootstrap(grant: string, sessionId: string): ArtistReviewSession { return artistReview.claimArtistReviewBootstrap(this, grant, sessionId); }
  resolveHostActor(sessionId: string, credential: string, role: AuthenticatedBridgeActor['role']): AuthenticatedBridgeActor { return artistReview.resolveHostActor(this, sessionId, credential, role); }
  issueArtistReviewActionCheckpoint(sessionId: string, ownerCredential: string, action: ArtistReviewAction, issuerCredential?: string): IssuedBridgeActionCheckpoint { return artistReview.issueArtistReviewActionCheckpoint(this, sessionId, ownerCredential, action, issuerCredential); }
  issueArtistReviewReleaseCheckpoint(sessionId: string, ownerCredential: string, decision: 'release-worthy' | 'not-release-worthy'): IssuedBridgeActionCheckpoint { return artistReview.issueArtistReviewReleaseCheckpoint(this, sessionId, ownerCredential, decision); }
  getArtistReviewState(sessionId: string): ArtistReviewState { return artistReview.getArtistReviewState(this, sessionId); }
  executeArtistReviewAction(sessionId: string, token: string, ownerCredential?: string): ArtistReviewActionResult { return artistReview.executeArtistReviewAction(this, sessionId, token, ownerCredential); }
  finalizeGovernedCampaignOwnerDecision(sessionId: string, ownerCredential: string, input: { readonly campaignRunId: string; readonly briefId: string }): Promise<Readonly<{ readonly closed: boolean;
    readonly record: Awaited<ReturnType<CampaignService['recordRevisionClosure']>>;
    readonly closure?: Awaited<ReturnType<CampaignService['closeCampaignClosure']>> }>> { return governedCampaign.finalizeGovernedCampaignOwnerDecision(this, sessionId, ownerCredential, input); }
  startGovernedCampaignOwnerDecisionComparison(sessionId: string, ownerCredential: string, input: { readonly campaignRunId: string; readonly briefId: string;
      readonly revisionEvidenceId: string }): Promise<ArtistReviewState> { return governedCampaign.startGovernedCampaignOwnerDecisionComparison(this, sessionId, ownerCredential, input); }
  registerGovernedRevisionDecisionSession(sessionId: string, campaignRunId: string, briefId: string): void { return governedCampaign.registerGovernedRevisionDecisionSession(this, sessionId, campaignRunId, briefId); }
  startTransferPromotion(sessionId: string, ownerCredential?: string): Promise<TransferPromotionWorkflowState> { return transferPromotion.startTransferPromotion(this, sessionId, ownerCredential); }
  issueTransferPromotionCheckpointForHost(sessionId: string, kind: TransferPromotionCheckpointKind, credential: string): IssuedBridgeActionCheckpoint { return transferPromotion.issueTransferPromotionCheckpointForHost(this, sessionId, kind, credential); }
  executeTransferPromotionCheckpoint(sessionId: string, input: {
    readonly token: string;
    readonly preferredBlindId?: string;
    readonly preferredArtifact?: 'treatment' | 'control';
    readonly claim?: string;
  }, credential: string): TransferPromotionWorkflowState { return transferPromotion.executeTransferPromotionCheckpoint(this, sessionId, input, credential); }
  getTransferPromotionState(sessionId: string): TransferPromotionWorkflowState { return transferPromotion.getTransferPromotionState(this, sessionId); }
  getTransferPromotionDecision(sessionId: string): TransferPromotionDecision { return transferPromotion.getTransferPromotionDecision(this, sessionId); }

  getEvents(sessionId: string): TuiBridgeEvent[] {
    return this.stream.history(sessionId);
  }
  conductLivingLoop(sessionId: string, request: LivingLoopRequest, actorId: string, executor: LivingLoopStepExecutor): Promise<LivingLoopCheckpoint> { return livingLoop.conductLivingLoop(this, sessionId, request, actorId, executor); }
  executeLivingLoopStep<T extends LivingLoopExecutionResult | null>(sessionId: string, request: LivingLoopRequest, actorId: string, executor: LivingLoopStepExecutor, context: LivingLoopExecutionContext, recovering: boolean): Promise<T> { return livingLoop.executeLivingLoopStep(this, sessionId, request, actorId, executor, context, recovering); }
  emitLivingLoopEvent(sessionId: string, request: LivingLoopRequest, actorId: string, step: LivingLoopStep, input: {
      state: 'queued' | 'running' | 'completed' | 'failed';
      disposition: 'proposed' | 'executed';
      budget: LivingLoopRequest['budgets'];
      result?: LivingLoopExecutionResult | null;
      errorClass?: string | null;
    }): void { return livingLoop.emitLivingLoopEvent(this, sessionId, request, actorId, step, input); }

  getEventReplay(): TuiRunEventReplay {
    return this.stream;
  }

  updateStatus(sessionId: string, patch: Partial<TuiSessionStatus>): TuiSessionStatus {
    const status = this.sessions.update(sessionId, patch);
    this.emit(sessionId, { type: 'status.updated', sessionId, status });
    return status;
  }
  publishResolvedGeneratorModel(sessionId: string, provider: string, baseUrl: string, model: string): void { return runLifecycle.publishResolvedGeneratorModel(this, sessionId, provider, baseUrl, model); }
  beginRun(sessionId: string, details: {
      kind: TuiRunKind;
      label: string;
      executionMode?: 'draft' | 'prove';
      executor?: TuiRunExecutor;
      model?: string;
      provider?: string;
      runId?: string;
    }): TuiRunLifecycle { return runLifecycle.beginRun(this, sessionId, details); }
  startCreativeRun(sessionId: string, prompt: string, provider?: string, model?: string, requestKey?: string): CreativeRunHandle { return runLifecycle.startCreativeRun(this, sessionId, prompt, provider, model, requestKey); }
  requireCreativeThesis(handle: CreativeRunHandle): CreativeThesis { return runLifecycle.requireCreativeThesis(this, handle); }
  finishCreativeRun(sessionId: string, status: 'completed' | 'failed'): Promise<void> { return runLifecycle.finishCreativeRun(this, sessionId, status); }
  transitionRun(sessionId: string, phase: TuiRunPhase, patch: Partial<Omit<TuiRunLifecycle, 'runId' | 'kind' | 'startedAt'>> = {}): TuiRunLifecycle | undefined { return runLifecycle.transitionRun(this, sessionId, phase, patch); }
  completeRun(sessionId: string, patch: Partial<Omit<TuiRunLifecycle, 'runId' | 'kind' | 'startedAt' | 'phase'>> = {}): TuiRunLifecycle | undefined { return runLifecycle.completeRun(this, sessionId, patch); }
  failRun(sessionId: string, error: string, outcome: 'failed' | 'cancelled' = 'failed', patch: Partial<Omit<TuiRunLifecycle, 'runId' | 'kind' | 'startedAt' | 'phase' | 'error' | 'outcome'>> = {}): TuiRunLifecycle | undefined { return runLifecycle.failRun(this, sessionId, error, outcome, patch); }
  suspendRun(sessionId: string, error: string, patch: Partial<Omit<TuiRunLifecycle, 'runId' | 'kind' | 'startedAt' | 'phase' | 'error' | 'outcome'>> = {}): TuiRunLifecycle | undefined { return runLifecycle.suspendRun(this, sessionId, error, patch); }
  setRunLifecycle(sessionId: string, run: TuiRunLifecycle, activeTask?: string): void { return runLifecycle.setRunLifecycle(this, sessionId, run, activeTask); }
  emitDomainTruth(sessionId: string, route: CreativeDomainRouteTruth, patch: { generatedDomain?: string; previewDomain?: string; artifactPath?: string } = {}): void { return runLifecycle.emitDomainTruth(this, sessionId, route, patch); }
  failureProvenance(error: unknown, fallback: TuiFailureProvenance = {}): TuiFailureProvenance { return runLifecycle.failureProvenance(this, error, fallback); }
  errorEvent(sessionId: string, error: unknown, fallback: TuiFailureProvenance = {}): TuiBridgeEvent { return runLifecycle.errorEvent(this, sessionId, error, fallback); }
  emitCommandResponse(sessionId: string, content: string): void { return runLifecycle.emitCommandResponse(this, sessionId, content); }

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
  submitInput(sessionId: string, input: TuiInputRequest, llm?: LLMClient): Promise<{ reviewRequired: boolean }> { return inputHandling.submitInput(this, sessionId, input, llm); }
  confirmAction(sessionId: string, actionId: string, llm?: LLMClient): Promise<void> { return inputHandling.confirmAction(this, sessionId, actionId, llm); }
  inferPendingActionRoute(description: string): NonNullable<TuiPendingAction['route']> { return inputHandling.inferPendingActionRoute(this, description); }
  cancelAction(sessionId: string, actionId: string): void { return inputHandling.cancelAction(this, sessionId, actionId); }
  cancelRun(sessionId: string): void { return inputHandling.cancelRun(this, sessionId); }
  setProductMode(sessionId: string, mode: ProductMode): ModeConfig { return inputHandling.setProductMode(this, sessionId, mode); }
  getGoalStore(): GoalStore | null { return lazyServices.getGoalStore(this); }
  getEmergenceHooks(): EmergenceHooks | null { return lazyServices.getEmergenceHooks(this); }
  gardenerAxes(): DescriptorAxis[] { return lazyServices.gardenerAxes(this); }
  getSinterFS(): SinterFS | null { return lazyServices.getSinterFS(this); }
  getTasteLearningService(): TasteLearningService | null { return lazyServices.getTasteLearningService(this); }
  hydrateLatestTasteModel(): boolean { return lazyServices.hydrateLatestTasteModel(this); }
  recordReviewPreference(sessionId: string, action: 'pin' | 'reject', artifactId: string, auth?: { nonce: string; eventId: string; source: OwnerReactionSource; occurredAt: string }): Promise<{ saved: boolean; causal: boolean; reactionDigest?: string; reason?: string }> { return lazyServices.recordReviewPreference(this, sessionId, action, artifactId, auth); }
  registerOwnerArtifact(sessionId: string, lineageId: string, artifact: {
    artifactPath: string;
    artifactDigest: string;
  }): void { return lazyServices.registerOwnerArtifact(this, sessionId, lineageId, artifact); }
  ensureSessionsHydrated(): void { return lazyServices.ensureSessionsHydrated(this); }
  streamDirectChat(sessionId: string, userText: string, conversation: ConversationManager, llm: LLMClient): Promise<void> { return streamHandlers.streamDirectChat(this, sessionId, userText, conversation, llm); }
  resolvePriorArtifactExcerpt(priorRunReceipt: unknown, maxChars = PRIOR_ARTIFACT_EXCERPT_MAX_CHARS): Promise<string | undefined> { return streamHandlers.resolvePriorArtifactExcerpt(this, priorRunReceipt, maxChars); }
  streamGovernedProductCreate(sessionId: string, userText: string, conversation: ConversationManager, options: Pick<TuiInputRequest, 'creativePreferences' | 'guidanceAnswers'> = {}): Promise<void> { return governedCreate.streamGovernedProductCreate(this, sessionId, userText, conversation, options); }
  /** Retained only as an explicit fail-closed compatibility boundary. */
  async streamDraftGeneration(sessionId: string, userText: string, conversation: ConversationManager, llm: LLMClient, options: Pick<TuiInputRequest, 'maxIterations' | 'candidateCount' | 'minQualityScore' | 'timeoutMinutes' | 'creativePreferences' | 'guidanceAnswers' | 'idempotencyKey'> = {}): Promise<void> {
    if (process.env.NODE_ENV !== 'test') {
      throw new Error('LEGACY_TUI_DRAFT_RETIRED_USE_GOVERNED_CREATE');
    }
    return draftGeneration.streamDraftGeneration(this, sessionId, userText, conversation, llm, options);
  }
  generateBestDraftCandidate(orchestrator: RetiredDraftGenerator, prompt: string, domain: string, candidateCount: number, runController: AbortController, generatorModelName: string, sessionId: string, timeoutMinutes: number, userRequest: string = ''): Promise<{ result: RetiredDraftResult | undefined; stopped: boolean }> { return draftGeneration.generateBestDraftCandidate(this, orchestrator, prompt, domain, candidateCount, runController, generatorModelName, sessionId, timeoutMinutes, userRequest); }
  awaitDraftAttempt<T>(generationPromise: Promise<T>, runController: AbortController, attemptController: AbortController, timeoutMinutes: number): Promise<T | undefined> { return draftGeneration.awaitDraftAttempt(this, generationPromise, runController, attemptController, timeoutMinutes); }
  linkDraftAttemptToRun(runSignal: AbortSignal, attemptController: AbortController): () => void { return draftGeneration.linkDraftAttemptToRun(this, runSignal, attemptController); }
  streamChatResponse(sessionId: string, userText: string, conversation: ConversationManager, llm: LLMClient, systemPrompt?: string): Promise<void> { return streamHandlers.streamChatResponse(this, sessionId, userText, conversation, llm, systemPrompt); }
  streamEngineeringTask(sessionId: string, userText: string, conversation: ConversationManager, llm: LLMClient): Promise<void> { return streamHandlers.streamEngineeringTask(this, sessionId, userText, conversation, llm); }
  withLiveSessionContext(sessionId: string, userText: string, config: ReturnType<LLMClient['getConfig']>): string { return streamHandlers.withLiveSessionContext(this, sessionId, userText, config); }
  providerLabelFromBaseUrl(baseUrl: string): string { return streamHandlers.providerLabelFromBaseUrl(this, baseUrl); }
  emitOperatorProgress(sessionId: string, event: BusEvent): void { return streamHandlers.emitOperatorProgress(this, sessionId, event); }
  phaseForProcessStage(stage: string): string { return streamHandlers.phaseForProcessStage(this, stage); }
  streamHybridTask(sessionId: string, userText: string, conversation: ConversationManager, llm: LLMClient, options: Pick<TuiInputRequest, 'creativePreferences' | 'guidanceAnswers'> = {}): Promise<void> { return streamHandlers.streamHybridTask(this, sessionId, userText, conversation, llm, options); }
  cancelStream(sessionId: string): void { return streamHandlers.cancelStream(this, sessionId); }
  extractCodeContent(content: string): string | null { return streamHandlers.extractCodeContent(this, content); }
  formatAgentSession(session: LLMSession): string { return streamHandlers.formatAgentSession(this, session); }
  agentToolsUsed(session: LLMSession): string[] { return streamHandlers.agentToolsUsed(this, session); }
  chunkString(str: string, chunkSize: number): string[] { return streamHandlers.chunkString(this, str, chunkSize); }

  /** Context adapter for PreviewService (F20 extraction). */
  get previewCtx(): PreviewContext {
    return {
      emit: (sid: string, ev: TuiBridgeEvent) => this.emit(sid, ev),
      emitDomainTruth: (sid: string, route: CreativeDomainRouteTruth, patch: { generatedDomain?: string; previewDomain?: string; artifactPath?: string }) =>
        this.emitDomainTruth(sid, route, patch),
      transitionRun: (sid: string, phase: TuiRunPhase, patch?: Partial<Omit<TuiRunLifecycle, 'runId' | 'kind' | 'startedAt'>>) =>
        this.transitionRun(sid, phase, patch),
    };
  }

  /** Context adapter for CommandDispatcher (F20 extraction). */
  get commandCtx(): CommandContext {
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
      cortexConfig: CORTEX_CONFIG,
    };
  }

  /** Context adapter for CreativeIntentHelpers (F20 extraction). */
  get intentCtx(): IntentEmitContext {
    return {
      emit: (sid: string, ev: TuiBridgeEvent) => this.emit(sid, ev),
      updateSession: (sid: string, patch: Partial<TuiSessionStatus>) =>
        this.sessions.update(sid, patch),
    };
  }
  emit(sessionId: string, event: TuiBridgeEvent): void {
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
  emitLiveNarration(sessionId: string, message: string): void { return streamHandlers.emitLiveNarration(this, sessionId, message); }
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
