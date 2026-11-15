/**
 * Extracted from TuiBridgeService.ts: cortex living-loop execution and lifecycle events.
 * Pure move: behavior is unchanged. TuiBridgeService keeps a delegating method for each
 * function here and passes itself as `host`.
 */
import { LIVING_LOOP_STEPS, type LivingLoopCheckpoint, type LivingLoopExecutionContext, type LivingLoopExecutionResult, type LivingLoopRequest, type LivingLoopStep, type LivingLoopStepExecutor } from '../../cortex/CortexLivingLoop.js';
import type { TuiBridgeService } from '../TuiBridgeService.js';

export function conductLivingLoop(host: TuiBridgeService, sessionId: string, request: LivingLoopRequest, actorId: string, executor: LivingLoopStepExecutor): Promise<LivingLoopCheckpoint> {
    if (!host.sessions.get(sessionId)) {
      throw new Error(`Unknown TUI session: ${sessionId}`);
    }
    if (!host.cortexLoop) throw new Error('CORTEX_LIVING_LOOP_NOT_CONFIGURED');
    for (const step of LIVING_LOOP_STEPS) {
      host.emitLivingLoopEvent(sessionId, request, actorId, step, {
        state: 'queued', disposition: 'proposed', budget: request.budgets,
      });
    }
    const observed: LivingLoopStepExecutor = {
      execute: context => host.executeLivingLoopStep(
        sessionId, request, actorId, executor, context, false,
      ),
      recover: context => host.executeLivingLoopStep(
        sessionId, request, actorId, executor, context, true,
      ),
    };
    return host.cortexLoop.conductLivingLoop(request, actorId, observed);
  }

export async function executeLivingLoopStep<T extends LivingLoopExecutionResult | null>(host: TuiBridgeService, sessionId: string, request: LivingLoopRequest, actorId: string, executor: LivingLoopStepExecutor, context: LivingLoopExecutionContext, recovering: boolean): Promise<T> {
    host.emitLivingLoopEvent(sessionId, request, actorId, context.step, {
      state: 'running', disposition: 'proposed', budget: context.remaining,
    });
    try {
      const result = await (recovering
        ? executor.recover(context)
        : executor.execute(context)) as T;
      host.emitLivingLoopEvent(sessionId, request, actorId, context.step, {
        state: result ? 'completed' : 'failed',
        disposition: result ? 'executed' : 'proposed',
        budget: context.remaining,
        result,
        errorClass: result ? null : 'recovery-required',
      });
      return result;
    } catch (error) {
      host.emitLivingLoopEvent(sessionId, request, actorId, context.step, {
        state: 'failed', disposition: 'proposed', budget: context.remaining,
        errorClass: error instanceof Error ? error.name : 'unknown-error',
      });
      throw error;
    }
  }

export function emitLivingLoopEvent(host: TuiBridgeService, sessionId: string, request: LivingLoopRequest, actorId: string, step: LivingLoopStep, input: {
      state: 'queued' | 'running' | 'completed' | 'failed';
      disposition: 'proposed' | 'executed';
      budget: LivingLoopRequest['budgets'];
      result?: LivingLoopExecutionResult | null;
      errorClass?: string | null;
    }): void {
    host.emit(sessionId, {
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
