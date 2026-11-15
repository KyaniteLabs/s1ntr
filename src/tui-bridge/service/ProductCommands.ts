/**
 * Extracted from TuiBridgeService.ts: product command ports, Studio composition and session creation.
 * Pure move: behavior is unchanged. TuiBridgeService keeps a delegating method for each
 * function here and passes itself as `host`.
 */
import { SessionGraph } from '../../agent/SessionGraph.js';
import type { GardenerDreamProposal } from '../../autonomy/AutonomousGardener.js';
import { ConversationManager } from '../../chat/ConversationManager.js';
import type { CompositionRequest } from '../../composition/CompositionGraph.js';
import type { CompositionResult, CompositionSpec } from '../../composition/CompositionOrchestrator.js';
import { createCoupledStudioArtifact, detectWave6Lane, type Wave6Lane } from '../../composition/StudioControlRecipe.js';
import type { CampaignExecutionPlan, CampaignManifest } from '../../creative-run/CampaignManifest.js';
import type { CampaignExecutionInputV1, CampaignTransferTarget } from '../../creative-run/CampaignService.js';
import { type CampaignEvidenceCheckpoint, CreativeRunCoordinator, type CreativeRunHandle } from '../../creative-run/CreativeRunCoordinator.js';
import type { OwnerReviewLifecycleResult } from '../../creative-run/OwnerReviewLifecycle.js';
import type { CompoundCreateCommand, CompoundCreateProjection } from '../../runtime-core/CompoundCreateProofPort.js';
import type { DreamProductCommand, DreamProductProjection } from '../../runtime-core/DreamProductCommandPort.js';
import type { DreamActivationCommand, DreamActivationProjection, DreamTransferCommand, DreamTransferProjection } from '../../runtime-core/DreamTransferActivationPort.js';
import type { LiminalCreativeCommand } from '../../runtime-core/LiminalCommandService.js';
import type { LiminalProductCommandPort, LiminalProductProjection } from '../../runtime-core/LiminalProductCommandPort.js';
import { Logger } from '../../utils/Logger.js';
import { continueCampaignStudioJourney, runGovernedCampaignStudioJourney } from '../CampaignStudio.js';
import type { TuiBridgeService } from '../TuiBridgeService.js';
import type { TuiSessionStatus } from '../types.js';
import { createHash } from 'node:crypto';

export async function submitLiminalCreate(host: TuiBridgeService, surface: 'studio' | 'chat', command: LiminalCreativeCommand): Promise<LiminalProductProjection> {
    return host.productCommandPort().submitCreate(surface, command);
  }

export async function submitStudioCreate(host: TuiBridgeService, intent: { prompt: string; domain: string;
    layers: readonly string[] }): Promise<LiminalProductProjection> {
    if (!intent || typeof intent !== 'object' || Array.isArray(intent)
      || Object.keys(intent).some(key => !['prompt', 'domain', 'layers'].includes(key))
      || typeof intent.prompt !== 'string' || !intent.prompt.trim()
      || typeof intent.domain !== 'string' || !intent.domain.trim()
      || !Array.isArray(intent.layers) || intent.layers.length === 0
      || intent.layers.some(layer => typeof layer !== 'string' || !layer.trim())) {
      throw new Error('STUDIO_CREATE_INTENT_INVALID');
    }
    if (!host.productCreateCommand) {
      throw new Error('LIMINAL_PRODUCT_COMMAND_FACTORY_REQUIRED');
    }
    const command = await host.productCreateCommand({ prompt: intent.prompt,
      domain: intent.domain, layers: [...intent.layers], maxTransportAttempts: 2 });
    return host.productCommandPort().submitCreate('studio', command);
  }

export function submitDreamResearch(host: TuiBridgeService, command: DreamProductCommand): Promise<DreamProductProjection> {
    if (!host.dreamCommands) {
      return Promise.reject(new Error('DREAM_PRODUCT_RUNTIME_NOT_CONFIGURED'));
    }
    return host.dreamCommands.run(command);
  }

export function submitDreamTransfer(host: TuiBridgeService, command: DreamTransferCommand): Promise<DreamTransferProjection> {
    if (!host.dreamTransferCommands) {
      return Promise.reject(new Error('DREAM_TRANSFER_RUNTIME_NOT_CONFIGURED'));
    }
    return host.dreamTransferCommands.run(command);
  }

export function submitDreamActivation(host: TuiBridgeService, command: DreamActivationCommand): Promise<DreamActivationProjection> {
    if (!host.dreamActivationCommands) {
      return Promise.reject(new Error('DREAM_ACTIVATION_RUNTIME_NOT_CONFIGURED'));
    }
    return host.dreamActivationCommands.run(command);
  }

export function submitCompoundCreate(host: TuiBridgeService, command: CompoundCreateCommand): Promise<CompoundCreateProjection> {
    if (!host.compoundCreateCommands) {
      return Promise.reject(new Error('COMPOUND_CREATE_RUNTIME_NOT_CONFIGURED'));
    }
    return host.compoundCreateCommands.run(command);
  }

export function productCommandPort(host: TuiBridgeService): LiminalProductCommandPort {
    if (!host.productCommands) throw new Error('LIMINAL_PRODUCT_COMMAND_PORT_REQUIRED');
    return host.productCommands;
  }

export function proposeGardenerDream(host: TuiBridgeService, proposal: GardenerDreamProposal): void {
    const briefDigest = createHash('sha256').update(JSON.stringify(proposal)).digest('hex');
    void host.productCommandPort().propose('gardener', {
      schema: 'sinter.liminal-proposal', schemaVersion: 1,
      idempotencyKey: `studio-gardener:${proposal.key}:${briefDigest}`,
      requestedKind: 'generate-candidate', briefDigest,
      authorityDigest: createHash('sha256').update('studio-gardener-v1').digest('hex'),
    }).catch((error: unknown) => {
      Logger.warn('TuiBridgeService', 'Gardener proposal failed closed:', error);
    });
  }

export function readLiminalProjection(host: TuiBridgeService, idempotencyKey: string): Promise<LiminalProductProjection | null> {
    return host.productCommandPort().projection(idempotencyKey);
  }

/** Studio composition is one governed Create, observed as a complete rendered work. */
export async function composeStudioLayersGoverned(host: TuiBridgeService, spec: CompositionSpec) {
    if (!host.productCreateCommand) {
      throw new Error('LIMINAL_PRODUCT_COMMAND_FACTORY_REQUIRED');
    }
    const layers = spec.layers.map((layer, index) => ({ index, domain: layer.domain,
      prompt: layer.prompt, ...(layer.code ? { immutableBaseCode: layer.code } : {}),
      blendMode: layer.blendMode ?? 'normal', opacity: layer.opacity ?? 1 }));
    const prompt = ['Create one cohesive playable layered composition.',
      'Preserve any immutableBaseCode exactly and integrate every declared layer.',
      JSON.stringify({ title: spec.title, background: spec.background, layers })].join('\n');
    const command = await host.productCreateCommand({ prompt, domain: 'html',
      layers: layers.map(layer => `${layer.domain}:${layer.blendMode}:${layer.opacity}`),
      maxTransportAttempts: 2 });
    const projection = await host.productCommandPort().submitCreate('studio', command);
    if (projection.kind !== 'create') throw new Error('LIMINAL_COMPOSITION_CREATE_INVALID');
    const artifact = await host.productCommandPort().verifiedArtifact(command.idempotencyKey);
    return { html: artifact.playable, title: spec.title ?? 'Liminal composition',
      successCount: layers.length, coupled: layers.length > 1,
      lineageId: projection.result.lineageId, creativeRun: { readiness: {
        state: 'product-rendered', evidenceDigest: projection.result.evidence.evidenceDigest } },
      layers: layers.map(layer => ({ ...layer, generated: true })),
      renderGate: { verdict: 'ok' as const }, productProjection: projection };
  }

export async function composeStudioLayers(host: TuiBridgeService, spec: CompositionRequest, options: {
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
      const governed = await runGovernedCampaignStudioJourney(host.campaignService, runOptions,
        options.governedCampaign.manifest, options.governedCampaign.plan,
        options.governedCampaign, host.campaignPreSpendInstaller);
      campaignResult = governed.result;
      ownerReviews = governed.ownerReviews;
      if (governed.ownerReviews.length === options.governedCampaign.manifest.briefs.length
        && governed.ownerReviews.every((review) => Boolean(review.closureContext))) {
        host.registerGovernedOwnerReviewResults(governed.admission, options.governedCampaign.manifest,
          governed.ownerReviews, Boolean(governed.closure));
      }
      campaignClosure = governed.closure;
      if (options.governedCampaign.continuation) {
        if (!host.campaignDreamGovernance || !campaignResult.campaignEvidenceCheckpoint
          || !host.governedContinuations) {
          throw new Error('GOVERNED_STUDIO_CAMPAIGN_DREAM_CONTEXT_REQUIRED');
        }
        await host.persistGovernedCampaignContinuation({
          manifest: options.governedCampaign.manifest,
          plan: options.governedCampaign.plan,
          checkpoint: campaignResult.campaignEvidenceCheckpoint,
          learningEvidenceId: options.governedCampaign.continuation.learningEvidenceId,
          ownerPrincipalId: options.governedCampaign.manifest.owner.authorityId,
          target: options.governedCampaign.continuation.target,
        });
        campaignContinuation = await continueCampaignStudioJourney(
          host.campaignService, governed.admission, options.governedCampaign.manifest,
          campaignResult.campaignEvidenceCheckpoint,
          options.governedCampaign.continuation.learningEvidenceId,
          options.governedCampaign.continuation.target,
          host.campaignDreamQueue, host.creativeRunCoordinator, host.campaignDreamGovernance,
        );
      }
      const first = campaignResult.executions[0]?.composition;
      if (!first) throw new Error('GOVERNED_STUDIO_CAMPAIGN_RESULT_EMPTY');
      result = { ...first };
    } else {
      result = await host.creativeRunCoordinator.compose(spec, runOptions);
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

    await host.cognitiveWriter.beginGenerationLineage({
      sessionId,
      lineageId,
      userText,
      domain: 'html',
      executionMode: 'prove',
    });
    await host.cognitiveWriter.writeBackGeneration({
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
      evaluationAdmission: result.renderGate?.verdict === 'ok' ? host.evaluationAuthority.issue({
        artifactDigest: createHash('sha256').update(html).digest('hex'),
        identity: 'valid', confidence: 1, failureClass: 'none',
      }) : undefined,
    });
    if (coupled && lane) {
      await host.cognitiveWriter.recordCompositionContract({
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

export function createSession(host: TuiBridgeService, patch: Partial<Pick<TuiSessionStatus, 'provider' | 'model' | 'roles' | 'evaluation'>> = {}, artistReviewGrant?: string): TuiSessionStatus {
    const sessionId = `tui-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const artistReviewSurface = artistReviewGrant
      ? host.claimArtistReviewBootstrap(artistReviewGrant, sessionId) : undefined;
    const ownerSession = host.ownerReactions.openSession(sessionId);

    // Initialize conversation manager for this session
    const conversation = new ConversationManager();
    conversation.startNewSession();
    host.conversations.set(sessionId, conversation);

    // Initialize session graph for turn persistence. Pass SinterFS so turns
    // persist to disk and survive restarts (read back by SessionResumer.hydrate).
    const graph = new SessionGraph(sessionId, host.getSinterFS() ?? undefined);
    host.sessionGraphs.set(sessionId, graph);

    // Register with session resumer for /sessions command
    host.sessionResumer.register(sessionId, graph);

    const status = host.sessions.create({
      sessionId,
      ownerSession,
      mode: 'chat',
      provider: patch.provider,
      model: patch.model,
      roles: patch.roles,
      evaluation: patch.evaluation,
      trust: { level: 'untrusted', label: 'Generated code is untrusted by default' },
    });
    if (artistReviewSurface) host.registerArtistReview(sessionId, artistReviewSurface);
    return status;
  }
