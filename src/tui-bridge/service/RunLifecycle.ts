/**
 * Extracted from TuiBridgeService.ts: run lifecycle transitions and domain/error events.
 * Pure move: behavior is unchanged. TuiBridgeService keeps a delegating method for each
 * function here and passes itself as `host`.
 */
import { type CreativeThesis, validateCreativeThesis } from '../../creative-intelligence/CreativeIntelligence.js';
import type { CreativeRunHandle } from '../../creative-run/CreativeRunCoordinator.js';
import { compactLLMErrorProvenance, extractLLMErrorProvenance } from '../../llm/ErrorProvenance.js';
import { Logger } from '../../utils/Logger.js';
import type { CreativeDomainRouteTruth } from '../CreativeDomainRouting.js';
import type { TuiBridgeService } from '../TuiBridgeService.js';
import type { TuiBridgeEvent, TuiFailureProvenance, TuiRunExecutor, TuiRunKind, TuiRunLifecycle, TuiRunPhase } from '../types.js';

export function publishResolvedGeneratorModel(host: TuiBridgeService, sessionId: string, provider: string, baseUrl: string, model: string): void {
    const status = host.sessions.get(sessionId);
    if (!status) return;
    const roles = status.roles ? { ...status.roles } : undefined;
    if (roles?.generator) {
      roles.generator = { ...roles.generator, provider, baseUrl, model };
    }
    if (roles?.harness) {
      roles.harness = { ...roles.harness, provider, baseUrl, model };
    }
    host.updateStatus(sessionId, { provider, model, roles });
  }

export function beginRun(host: TuiBridgeService, sessionId: string, details: {
      kind: TuiRunKind;
      label: string;
      executionMode?: 'draft' | 'prove';
      executor?: TuiRunExecutor;
      model?: string;
      provider?: string;
      runId?: string;
    }): TuiRunLifecycle {
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
    host.setRunLifecycle(sessionId, run, details.label);
    return run;
  }

export function startCreativeRun(host: TuiBridgeService, sessionId: string, prompt: string, provider?: string, model?: string, requestKey?: string): CreativeRunHandle {
    const handle = host.creativeRunCoordinator.startSync({
      entryPoint: 'studio-session',
      requestKey: requestKey?.trim()
        || `studio-session:${sessionId}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`,
      prompt,
      sessionId,
      provider,
      model,
    });
    host.requireCreativeThesis(handle);
    host.creativeRuns.set(sessionId, handle);
    return handle;
  }

export function requireCreativeThesis(_host: TuiBridgeService, handle: CreativeRunHandle): CreativeThesis {
    if (!handle.creativeThesis) throw new Error('Legacy creative run is read-only and cannot generate without a Creative Thesis');
    return validateCreativeThesis(handle.creativeThesis);
  }

export async function finishCreativeRun(host: TuiBridgeService, sessionId: string, status: 'completed' | 'failed'): Promise<void> {
    const creativeRun = host.creativeRuns.get(sessionId);
    if (!creativeRun) return;
    host.creativeRuns.delete(sessionId);
    await host.creativeRunCoordinator.finish(creativeRun, status);
  }

export function transitionRun(host: TuiBridgeService, sessionId: string, phase: TuiRunPhase, patch: Partial<Omit<TuiRunLifecycle, 'runId' | 'kind' | 'startedAt'>> = {}): TuiRunLifecycle | undefined {
    const current = host.sessions.get(sessionId)?.run;
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
    host.setRunLifecycle(sessionId, run, run.label);
    return run;
  }

export function completeRun(host: TuiBridgeService, sessionId: string, patch: Partial<Omit<TuiRunLifecycle, 'runId' | 'kind' | 'startedAt' | 'phase'>> = {}): TuiRunLifecycle | undefined {
    const creativeRun = host.creativeRuns.get(sessionId);
    if (creativeRun) {
      host.creativeRuns.delete(sessionId);
      void host.creativeRunCoordinator.finish(creativeRun, 'completed').catch((error) => {
        Logger.warn('TuiBridgeService', 'Creative-run completion persistence failed:', error);
      });
    }
    return host.transitionRun(sessionId, 'completed', {
      ...patch,
      outcome: 'completed',
    });
  }

export function failRun(host: TuiBridgeService, sessionId: string, error: string, outcome: 'failed' | 'cancelled' = 'failed', patch: Partial<Omit<TuiRunLifecycle, 'runId' | 'kind' | 'startedAt' | 'phase' | 'error' | 'outcome'>> = {}): TuiRunLifecycle | undefined {
    const creativeRun = host.creativeRuns.get(sessionId);
    if (creativeRun) {
      host.creativeRuns.delete(sessionId);
      void host.creativeRunCoordinator.finish(creativeRun, 'failed').catch((finishError) => {
        Logger.warn('TuiBridgeService', 'Creative-run failure persistence failed:', finishError);
      });
    }
    return host.transitionRun(sessionId, 'failed', { ...patch, error, outcome });
  }

export function suspendRun(host: TuiBridgeService, sessionId: string, error: string, patch: Partial<Omit<TuiRunLifecycle, 'runId' | 'kind' | 'startedAt' | 'phase' | 'error' | 'outcome'>> = {}): TuiRunLifecycle | undefined {
    return host.transitionRun(sessionId, 'suspended', { ...patch, error, outcome: 'suspended' });
  }

export function setRunLifecycle(host: TuiBridgeService, sessionId: string, run: TuiRunLifecycle, activeTask?: string): void {
    const status = host.sessions.update(sessionId, {
      run,
      activeTask: activeTask ?? run.label,
      model: run.model ?? host.sessions.get(sessionId)?.model,
      provider: run.provider ?? host.sessions.get(sessionId)?.provider,
    });
    host.emit(sessionId, { type: 'run.lifecycle', sessionId, run });
    host.emit(sessionId, { type: 'status.updated', sessionId, status });
  }

export function emitDomainTruth(host: TuiBridgeService, sessionId: string, route: CreativeDomainRouteTruth, patch: { generatedDomain?: string; previewDomain?: string; artifactPath?: string } = {}): void {
    host.emit(sessionId, {
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

export function failureProvenance(_host: TuiBridgeService, error: unknown, fallback: TuiFailureProvenance = {}): TuiFailureProvenance {
    return compactLLMErrorProvenance(extractLLMErrorProvenance(error), fallback);
  }

export function errorEvent(host: TuiBridgeService, sessionId: string, error: unknown, fallback: TuiFailureProvenance = {}): TuiBridgeEvent {
    return {
      type: 'error',
      sessionId,
      message: error instanceof Error ? error.message : String(error),
      ...host.failureProvenance(error, fallback),
    };
  }

export function emitCommandResponse(host: TuiBridgeService, sessionId: string, content: string): void {
    host.emit(sessionId, { type: 'response.started', sessionId });
    host.emit(sessionId, { type: 'response.delta', sessionId, delta: content });
    host.emit(sessionId, { type: 'response.completed', sessionId, content });
    host.emit(sessionId, { type: 'response.committed', sessionId, content });
  }
