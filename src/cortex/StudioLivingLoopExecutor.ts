import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { DreamQueue, DreamTask } from '../dreaming/DreamQueue.js';
import type { StudioLineageLedger, StudioLineageStage } from '../tui-bridge/StudioLineage.js';
import type {
  LivingLoopEffect,
  LivingLoopExecutionContext,
  LivingLoopExecutionResult,
  LivingLoopStep,
  LivingLoopStepExecutor,
} from './CortexLivingLoop.js';
import {
  authorizeCanonicalStudioInvocation,
  assertPreSpendInterlockConfigured,
  completeCanonicalStudioInvocation,
  ensureWave8LivePreSpendInterlockConfigured,
  failCanonicalStudioInvocation,
  invokeCanonicalStudioProvider,
  type CanonicalPreSpendCapability,
  type SubscriptionHostAdapterRegistry,
} from '../llm/PreSpendInterlock.js';

export interface StudioLivingLoopProviderRequest {
  cycleId: string;
  lineageId: string;
  sourceFingerprint: string;
  step: LivingLoopStep;
  idempotencyKey: string;
}

export interface StudioLivingLoopProviderResponse {
  content: string;
  provider: string;
  model: string;
  artifactRefs: string[];
  usage: { tokens: number; costUsd: number; wallClockMs: number };
}

export interface StudioLivingLoopProviderBoundary {
  invoke(request: StudioLivingLoopProviderRequest): Promise<StudioLivingLoopProviderResponse>;
}

export interface StudioLivingLoopLiveTransport {
  invoke(request: StudioLivingLoopProviderRequest,
    capability: CanonicalPreSpendCapability): Promise<StudioLivingLoopProviderResponse>;
}

export class CanonicalStudioLivingLoopProviderBoundary implements StudioLivingLoopProviderBoundary {
  readonly calls: StudioLivingLoopProviderRequest[] = [];
  readonly transportSentinel = { ledgerReservations: 0, networkCalls: 0, spendUsd: 0 };

  constructor(
    readonly mode: 'live' | 'deterministic-no-spend',
    private readonly transport?: StudioLivingLoopLiveTransport,
  ) {
    if (mode === 'live' ? !transport : transport) {
      throw new Error('STUDIO_LIVING_LOOP_PROVIDER_BOUNDARY_MODE_INVALID');
    }
  }

  async invoke(request: StudioLivingLoopProviderRequest): Promise<StudioLivingLoopProviderResponse> {
    if (this.mode === 'live') {
      const capability = authorizeCanonicalStudioInvocation(request.step);
      try {
        const response = await invokeCanonicalStudioProvider(capability, request,
          () => this.transport!.invoke(request, capability));
        completeCanonicalStudioInvocation(capability, response, 'success');
        return response;
      } catch (error) {
        try { failCanonicalStudioInvocation(capability); } catch { /* completion may already be terminal */ }
        throw error;
      }
    }
    if (this.calls.some(call => call.idempotencyKey === request.idempotencyKey)) {
      throw new Error(`STUDIO_LIVING_LOOP_NO_SPEND_DUPLICATE:${request.step}`);
    }
    this.calls.push(structuredClone(request));
    return {
      content: `deterministic no-spend response for ${request.step}`,
      provider: 'deterministic-no-spend', model: 'canonical-boundary-v1',
      artifactRefs: [`deterministic:${request.step}`],
      usage: { tokens: 1, costUsd: 0, wallClockMs: 1 },
    };
  }
}

const EFFECTS: Record<LivingLoopStep, LivingLoopEffect[]> = {
  'create-evidence': ['evidence-admission'],
  consolidate: ['consolidation-admission'],
  dream: ['dream-admission'],
  autoresearch: ['mutation'],
  review: ['review', 'veto'],
  assimilate: ['assimilation-recommendation'],
  'candidate-request': ['candidate', 'promotion-request'],
  'follow-up-create': ['follow-up-artifact'],
};

const LINEAGE_STAGE: Record<LivingLoopStep, StudioLineageStage> = {
  'create-evidence': 'artifact',
  consolidate: 'hypothesis',
  dream: 'dream',
  autoresearch: 'experiment',
  review: 'review',
  assimilate: 'memory',
  'candidate-request': 'review',
  'follow-up-create': 'follow-up',
};

export interface StudioLivingLoopExecutorOptions {
  cycleId: string;
  lineageId: string;
  sourceFingerprint: string;
  receiptRoot: string;
  evidenceClass: 'deterministic-proof' | 'live';
  boundary: StudioLivingLoopProviderBoundary;
  dreamQueue: DreamQueue;
  lineageLedger: StudioLineageLedger;
  /** Required authenticated Wave 8 config for a live executor; environment fallback is fail-closed. */
  liveProtocolConfigPath?: string;
  /** Host-pinned owner-only trust store; never accepted from the execution config. */
  liveTrustStorePath?: string;
  /** Explicit host-owned subscription adapters; never sourced from execution config or ambient state. */
  subscriptionHostAdapters?: SubscriptionHostAdapterRegistry;
}

function receiptDigest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function validateResponse(response: StudioLivingLoopProviderResponse): void {
  if (!response.content.trim() || !response.provider.trim() || !response.model.trim()) {
    throw new Error('STUDIO_LIVING_LOOP_PROVIDER_RESPONSE_INVALID');
  }
  if (!response.artifactRefs.length || response.artifactRefs.some(ref => !ref.trim())) {
    throw new Error('STUDIO_LIVING_LOOP_ARTIFACT_REQUIRED');
  }
  if (Object.values(response.usage).some(value => !Number.isFinite(value) || value < 0)) {
    throw new Error('STUDIO_LIVING_LOOP_USAGE_INVALID');
  }
}

export class StudioLivingLoopExecutor implements LivingLoopStepExecutor {
  constructor(private readonly options: StudioLivingLoopExecutorOptions) {
    if (!path.isAbsolute(options.receiptRoot)) {
      throw new Error('STUDIO_LIVING_LOOP_RECEIPT_ROOT_MUST_BE_ABSOLUTE');
    }
    if (!(options.boundary instanceof CanonicalStudioLivingLoopProviderBoundary)
      || (options.evidenceClass === 'live' ? options.boundary.mode !== 'live' : options.boundary.mode !== 'deterministic-no-spend')) {
      throw new Error('STUDIO_LIVING_LOOP_CANONICAL_PROVIDER_BOUNDARY_REQUIRED');
    }
    if (options.evidenceClass === 'live') {
      ensureWave8LivePreSpendInterlockConfigured(options.liveProtocolConfigPath,
        options.liveTrustStorePath, options.subscriptionHostAdapters);
    }
  }

  async execute(context: LivingLoopExecutionContext): Promise<LivingLoopExecutionResult> {
    if (this.options.evidenceClass === 'live') assertPreSpendInterlockConfigured();
    await this.assertCausalOrigin(context.step);
    const dreamTask = context.step === 'dream' ? this.claimDreamTask() : undefined;
    const response = await this.options.boundary.invoke(this.providerRequest(context));
    validateResponse(response);
    const result = this.result(context, response);
    await this.persist(context.step, result);
    await this.applyLocalEffects(context.step, response, dreamTask);
    return result;
  }

  async recover(
    context: LivingLoopExecutionContext,
  ): Promise<LivingLoopExecutionResult | null> {
    try {
      const stored = JSON.parse(await readFile(this.receiptPath(context.step), 'utf8')) as {
        result?: LivingLoopExecutionResult;
      };
      if (stored.result?.idempotencyKey !== context.idempotencyKey) {
        throw new Error('STUDIO_LIVING_LOOP_RECOVERY_MISMATCH');
      }
      return stored.result;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }

  private providerRequest(context: LivingLoopExecutionContext): StudioLivingLoopProviderRequest {
    return {
      cycleId: this.options.cycleId,
      lineageId: this.options.lineageId,
      sourceFingerprint: this.options.sourceFingerprint,
      step: context.step,
      idempotencyKey: context.idempotencyKey,
    };
  }

  private result(
    context: LivingLoopExecutionContext,
    response: StudioLivingLoopProviderResponse,
  ): LivingLoopExecutionResult {
    const responseId = receiptDigest(response);
    return {
      idempotencyKey: context.idempotencyKey,
      effects: EFFECTS[context.step].map(type => ({
        type, id: `${context.idempotencyKey}:${type}`,
      })),
      receiptRefs: [...response.artifactRefs, `provider-response:${responseId}`],
      usage: { actions: 1, ...response.usage },
    };
  }

  private async assertCausalOrigin(step: LivingLoopStep): Promise<void> {
    if (step !== 'create-evidence') return;
    const trace = await this.options.lineageLedger.query(this.options.lineageId);
    const latest = (stage: StudioLineageStage) => [...trace.records].reverse().find(record =>
      record.stage === stage && record.status === 'observed');
    const artifact = latest('artifact');
    const reaction = latest('reaction');
    const hypothesis = latest('hypothesis');
    const artifactDigest = artifact?.payload.codeDigest;
    const exact = typeof artifactDigest === 'string'
      && reaction?.payload.artifactDigest === artifactDigest
      && reaction.payload.lineageId === this.options.lineageId
      && reaction.payload.sourceFingerprint === this.options.sourceFingerprint
      && typeof reaction.payload.reactionDigest === 'string'
      && hypothesis?.payload.reactionDigest === reaction.payload.reactionDigest;
    if (!exact) {
      throw new Error('STUDIO_LIVING_LOOP_OWNER_REACTION_REQUIRED');
    }
  }

  private claimDreamTask(): DreamTask {
    const task = this.options.dreamQueue.dequeue('artifact');
    if (!task) throw new Error('STUDIO_LIVING_LOOP_DREAM_TASK_REQUIRED');
    return task;
  }

  private async applyLocalEffects(
    step: LivingLoopStep,
    response: StudioLivingLoopProviderResponse,
    dreamTask?: DreamTask,
  ): Promise<void> {
    if (dreamTask) {
      this.options.dreamQueue.complete(dreamTask.id, {
        candidateDescriptor: [],
        parentIds: dreamTask.sources.map(source => source.id),
      });
    }
    await this.options.lineageLedger.append(this.options.lineageId, {
      stage: LINEAGE_STAGE[step],
      status: 'observed',
      origin: `studio-cortex-${step}`,
      trust: 'verified-system',
      corroboration: [...response.artifactRefs],
      payload: {
        provider: response.provider,
        model: response.model,
        sourceFingerprint: this.options.sourceFingerprint,
      },
    });
  }

  private receiptPath(step: LivingLoopStep): string {
    return path.join(this.options.receiptRoot, `${step}.json`);
  }

  private async persist(
    step: LivingLoopStep,
    result: LivingLoopExecutionResult,
  ): Promise<void> {
    await mkdir(this.options.receiptRoot, { recursive: true });
    const target = this.receiptPath(step);
    const temporary = `${target}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify({
      schemaVersion: 1,
      cycleId: this.options.cycleId,
      lineageId: this.options.lineageId,
      sourceFingerprint: this.options.sourceFingerprint,
      evidenceClass: this.options.evidenceClass,
      livePass: false,
      result,
    }, null, 2)}\n`, { flag: 'wx' });
    await rename(temporary, target);
  }
}
