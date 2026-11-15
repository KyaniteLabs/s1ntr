/**
 * Characterization tests for TuiBridgeService.
 *
 * These pin the observable behaviour of the service facade (session/run state
 * transitions, bridge events, and fail-closed error replies) so the file can be
 * split into responsibility modules without behaviour drift. They only mock
 * process/network boundaries (LLM client, product command ports, host authority).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  isGenerationRequest,
  isOperatorInspectionRequest,
  isSelfImprovementRequest,
  resolveDraftCandidateTimeoutMinutes,
  installRetiredDraftTestAdapter,
  TuiBridgeService,
  type BridgeHostAuthorityRegistry,
} from '../../src/tui-bridge/TuiBridgeService.js';
import type { LLMClient } from '../../src/llm/LLMClient.js';
import type { CreativeRunCoordinator } from '../../src/creative-run/CreativeRunCoordinator.js';
import type { OwnerAuthorityCapability } from '../../src/creative-run/CreativeRunCoordinator.js';
import type { ArtistReviewSession, ArtistReviewState } from '../../src/creative-run/ArtistReviewExperience.js';
import type { LiminalProductCommandPort } from '../../src/runtime-core/LiminalProductCommandPort.js';

const services: TuiBridgeService[] = [];

function makeService(options: ConstructorParameters<typeof TuiBridgeService>[0] = {}): TuiBridgeService {
  const service = new TuiBridgeService(options);
  services.push(service);
  return service;
}

afterEach(() => {
  while (services.length > 0) services.pop()!.destroy();
});

type Anyish = Record<string, any>;
const internals = (service: TuiBridgeService): Anyish => service as unknown as Anyish;

function types(service: TuiBridgeService, sessionId: string): string[] {
  return service.getEvents(sessionId).map(event => event.type);
}

function artistState(version = 0): ArtistReviewState {
  return { stateDigest: `digest-${version}`, decisionVersion: version } as unknown as ArtistReviewState;
}

const capability = { id: 'cap-owner' } as unknown as OwnerAuthorityCapability;

function hostAuth(
  actor: { principalId: string; role: 'owner' | 'issuer' | 'reviewer' } | undefined,
  verified: { id: string; role: string } = { id: actor?.principalId ?? '', role: actor?.role ?? '' },
): { hostAuthorityRegistry: BridgeHostAuthorityRegistry; creativeRunCoordinator: CreativeRunCoordinator; campaignService: never } {
  return {
    hostAuthorityRegistry: { resolveActor: () => actor ? { ...actor, capability } : undefined },
    creativeRunCoordinator: {
      verifyOwnerAuthorityCapability: () => verified,
    } as unknown as CreativeRunCoordinator,
    campaignService: {} as never,
  };
}

describe('request classification helpers', () => {
  it('flags self-improvement vocabulary and nothing else', () => {
    expect(isSelfImprovementRequest('Please DEBUG the harness')).toBe(true);
    expect(isSelfImprovementRequest('paint a quiet lake')).toBe(false);
  });

  it('needs two operator-inspection patterns to count as an inspection', () => {
    expect(isOperatorInspectionRequest('read-only please')).toBe(false);
    expect(isOperatorInspectionRequest('read-only, and do not commit anything')).toBe(true);
  });

  it('never treats operator-like wording as a generation request', () => {
    expect(isGenerationRequest('generate a hydra animation')).toBe(true);
    expect(isGenerationRequest('generate a test for the repo')).toBe(false);
    expect(isGenerationRequest('hello there')).toBe(false);
  });

  it('caps draft candidate timeouts at 3 minutes, or 5 for kimi-k3', () => {
    expect(resolveDraftCandidateTimeoutMinutes(10, 'glm-5')).toBe(3);
    expect(resolveDraftCandidateTimeoutMinutes(10, 'Kimi-K3-turbo')).toBe(5);
    expect(resolveDraftCandidateTimeoutMinutes(2, 'Kimi-K3-turbo')).toBe(2);
  });

  it('refuses to install the retired draft adapter outside NODE_ENV=test', () => {
    const previous = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      expect(() => installRetiredDraftTestAdapter({} as never))
        .toThrow('RETIRED_DRAFT_TEST_ADAPTER_FORBIDDEN');
    } finally {
      process.env.NODE_ENV = previous;
    }
  });
});

describe('session state and event emission', () => {
  it('throws a named error for unknown sessions', () => {
    const service = makeService();
    expect(() => service.getStatus('nope')).toThrow('Unknown TUI session: nope');
    expect(() => service.cancelRun('nope')).toThrow('Unknown TUI session: nope');
    expect(() => service.getArtistReviewState('nope')).toThrow('Unknown TUI session: nope');
    expect(() => service.registerArtistReview('nope', { state: artistState } as never))
      .toThrow('Unknown TUI session: nope');
  });

  it('merges a status patch and publishes status.updated', () => {
    const service = makeService();
    const { sessionId } = service.createSession({ provider: 'p1', model: 'm1' });

    const next = service.updateStatus(sessionId, { activeTask: 'Tuning' });

    expect(next.activeTask).toBe('Tuning');
    expect(next.provider).toBe('p1');
    expect(next.model).toBe('m1');
    expect(service.getStatus(sessionId).activeTask).toBe('Tuning');
    const last = service.getEvents(sessionId).at(-1) as Anyish;
    expect(last.type).toBe('status.updated');
    expect(last.status.activeTask).toBe('Tuning');
  });

  it('emits a command response as started, delta, completed, committed', () => {
    const service = makeService();
    const { sessionId } = service.createSession();

    service.emitCommandResponse(sessionId, 'hello');

    expect(types(service, sessionId)).toEqual([
      'response.started', 'response.delta', 'response.completed', 'response.committed',
    ]);
    expect((service.getEvents(sessionId)[1] as Anyish).delta).toBe('hello');
    expect((service.getEvents(sessionId)[3] as Anyish).content).toBe('hello');
  });

  it('emits video render lifecycle events with their payloads', () => {
    const service = makeService();
    const { sessionId } = service.createSession();

    service.emitVideoRenderStart(sessionId, 'p5');
    service.emitVideoRenderComplete(sessionId, 'p5', '/tmp/out.mp4');
    service.emitVideoRenderError(sessionId, 'p5', 'boom');

    expect(service.getEvents(sessionId)).toEqual([
      { type: 'video:render:start', sessionId, domain: 'p5' },
      { type: 'video:render:complete', sessionId, domain: 'p5', videoPath: '/tmp/out.mp4' },
      { type: 'video:render:error', sessionId, domain: 'p5', error: 'boom' },
    ]);
  });

  it('stamps the session id onto operator events published through publishEvent', () => {
    const service = makeService();
    const { sessionId } = service.createSession();

    service.publishEvent(sessionId, { type: 'activity.updated', message: 'working' });

    expect(service.getEvents(sessionId)).toEqual([
      { type: 'activity.updated', message: 'working', sessionId },
    ]);
  });

  it('exposes the event stream as the replay source', () => {
    const service = makeService();
    expect(service.getEventReplay()).toBe(internals(service).stream);
  });

  it('emits mode.product_changed and returns the configured mode', () => {
    const service = makeService();
    const { sessionId } = service.createSession();

    const config = service.setProductMode(sessionId, 'remix');

    expect(config).toBe(internals(service).modeRegistry.getMode(sessionId));
    const event = service.getEvents(sessionId).at(-1) as Anyish;
    expect(event).toMatchObject({ type: 'mode.product_changed', sessionId, mode: 'remix', label: 'Remix' });
    expect(event.description).toBe('Creative remix — evolve and transform existing work');
  });

  it('is safe to destroy twice and keeps already published history readable', () => {
    const service = makeService();
    const { sessionId } = service.createSession();
    service.emitCommandResponse(sessionId, 'x');

    service.destroy();
    service.destroy();

    expect(internals(service).gardener).toBeNull();
    expect(internals(service).cortexLoop).toBeNull();
    expect(internals(service).cortexBroadcastTimer).toBeNull();
    expect(service.getEvents(sessionId).length).toBe(4);
  });
});

describe('run lifecycle transitions', () => {
  it('walks queued -> planning -> generating -> completed and publishes each phase', () => {
    const service = makeService();
    const { sessionId } = service.createSession();
    const bridge = internals(service);

    const run = bridge.beginRun(sessionId, { kind: 'chat', label: 'Direct chat', model: 'm', provider: 'p' });
    expect(run).toMatchObject({ kind: 'chat', phase: 'queued', label: 'Direct chat', model: 'm', provider: 'p' });
    expect(run.runId).toMatch(/^run-\d+-[a-z0-9]+$/);
    expect(service.getStatus(sessionId).activeTask).toBe('Direct chat');

    bridge.transitionRun(sessionId, 'planning', { label: 'Thinking' });
    expect(service.getStatus(sessionId).run).toMatchObject({ phase: 'planning', label: 'Thinking' });

    bridge.transitionRun(sessionId, 'generating');
    bridge.completeRun(sessionId, { label: 'Done' });
    const finished = service.getStatus(sessionId).run!;
    expect(finished).toMatchObject({ phase: 'completed', outcome: 'completed', label: 'Done', runId: run.runId });
    expect(typeof finished.completedAt).toBe('string');
    expect(finished.failedAt).toBeUndefined();

    const lifecycle = service.getEvents(sessionId)
      .filter((event): event is Anyish => event.type === 'run.lifecycle')
      .map(event => event.run.phase);
    expect(lifecycle).toEqual(['queued', 'planning', 'generating', 'completed']);
  });

  it('honours an explicit runId and records failure outcome and error', () => {
    const service = makeService();
    const { sessionId } = service.createSession();
    const bridge = internals(service);

    bridge.beginRun(sessionId, { kind: 'creative', label: 'Create', runId: 'run-fixed' });
    const failed = bridge.failRun(sessionId, 'provider down');

    expect(failed).toMatchObject({ runId: 'run-fixed', phase: 'failed', outcome: 'failed', error: 'provider down' });
    expect(typeof failed.failedAt).toBe('string');
  });

  it('records cancelled and suspended outcomes distinctly', () => {
    const service = makeService();
    const { sessionId } = service.createSession();
    const bridge = internals(service);

    bridge.beginRun(sessionId, { kind: 'engineering', label: 'Fix' });
    expect(bridge.failRun(sessionId, 'stopped', 'cancelled')).toMatchObject({ phase: 'failed', outcome: 'cancelled' });
    expect(bridge.suspendRun(sessionId, 'paused')).toMatchObject({ phase: 'suspended', outcome: 'suspended', error: 'paused' });
  });

  it('returns undefined when transitioning a session that never began a run', () => {
    const service = makeService();
    const { sessionId } = service.createSession();
    expect(internals(service).transitionRun(sessionId, 'planning')).toBeUndefined();
  });

  it('publishes a resolved generator model onto the session and its roles', () => {
    const service = makeService();
    const roleBase = { provider: 'old', baseUrl: 'http://old', model: 'old-model' };
    const { sessionId } = service.createSession({
      roles: { generator: { ...roleBase }, harness: { ...roleBase } } as never,
    });

    internals(service).publishResolvedGeneratorModel(sessionId, 'zai', 'http://new', 'glm-5');

    const status = service.getStatus(sessionId);
    expect(status.provider).toBe('zai');
    expect(status.model).toBe('glm-5');
    expect(status.roles?.generator).toEqual({ provider: 'zai', baseUrl: 'http://new', model: 'glm-5' });
    expect(status.roles?.harness).toEqual({ provider: 'zai', baseUrl: 'http://new', model: 'glm-5' });
  });

  it('ignores a resolved model for an unknown session', () => {
    const service = makeService();
    expect(() => internals(service).publishResolvedGeneratorModel('ghost', 'p', 'u', 'm')).not.toThrow();
  });

  it('builds error events from Error and non-Error values', () => {
    const service = makeService();
    const bridge = internals(service);

    expect(bridge.errorEvent('s', new Error('bad'), { provider: 'p' })).toMatchObject({
      type: 'error', sessionId: 's', message: 'bad', provider: 'p',
    });
    expect(bridge.errorEvent('s', 'plain')).toMatchObject({ type: 'error', message: 'plain' });
  });

  it('emits domain truth with route fields and patch overrides', () => {
    const service = makeService();
    const { sessionId } = service.createSession();

    internals(service).emitDomainTruth(sessionId, {
      requestedDomain: 'p5', selectedDomain: 'p5', domains: ['p5'], promptDomainLocked: true, source: 'prompt',
    }, { previewDomain: 'html' });

    expect(service.getEvents(sessionId).at(-1)).toEqual({
      type: 'generation.domain_truth', sessionId, requestedDomain: 'p5', selectedDomain: 'p5',
      domains: ['p5'], promptDomainLocked: true, source: 'prompt', previewDomain: 'html',
    });
  });
});

describe('input handling and pending actions', () => {
  it('echoes input and records a turn when no LLM is attached', async () => {
    const service = makeService();
    const { sessionId } = service.createSession();

    const result = await service.submitInput(sessionId, { text: 'hello world', mode: 'chat' } as never);

    expect(result).toEqual({ reviewRequired: false });
    expect(types(service, sessionId)).toEqual([
      'response.started', 'response.delta', 'response.completed', 'response.committed',
      'session.turn', 'status.updated',
    ]);
    const turn = service.getEvents(sessionId).find((event): event is Anyish => event.type === 'session.turn')!;
    expect(turn.delegatedTo).toBe('echo');
    expect(service.getStatus(sessionId).activeTask).toBe('hello world');
  });

  it('parks action-mode input as a pending action requiring review', async () => {
    const service = makeService();
    const { sessionId } = service.createSession();

    const result = await service.submitInput(sessionId, { text: 'delete the cache', mode: 'action' } as never);

    expect(result).toEqual({ reviewRequired: true });
    const status = service.getStatus(sessionId);
    expect(status.mode).toBe('action');
    expect(status.trust).toEqual({ level: 'review-required', label: 'Review required before mutation' });
    expect(status.pendingAction).toMatchObject({
      title: 'delete the cache', description: 'delete the cache', prompt: 'delete the cache',
      route: 'operator', kind: 'llm', requiresConfirmation: true,
    });
    expect(types(service, sessionId)).toEqual(['action.review_required', 'status.updated']);
  });

  it('truncates a pending action title to 60 characters', async () => {
    const service = makeService();
    const { sessionId } = service.createSession();
    const text = 'x'.repeat(100);

    await service.submitInput(sessionId, { text, mode: 'action' } as never);

    expect(service.getStatus(sessionId).pendingAction?.title).toBe('x'.repeat(60));
  });

  it('confirms a pending action, replays no run without an LLM, and rejects a stale id', async () => {
    const service = makeService();
    const { sessionId } = service.createSession();
    await service.submitInput(sessionId, { text: 'do it', mode: 'action' } as never);
    const actionId = service.getStatus(sessionId).pendingAction!.id;

    await expect(service.confirmAction(sessionId, 'wrong')).rejects.toThrow('Pending action wrong not found');
    await service.confirmAction(sessionId, actionId);

    const status = service.getStatus(sessionId);
    expect(status.pendingAction).toBeUndefined();
    expect(status.mode).toBe('confirm');
    expect(status.trust).toEqual({ level: 'confirmed', label: 'Operator confirmed mutation' });
    expect(types(service, sessionId).slice(-2)).toEqual(['action.confirmed', 'status.updated']);
    await expect(service.confirmAction(sessionId, actionId)).rejects.toThrow(`Pending action ${actionId} not found`);
  });

  it('cancels a pending action back to untrusted chat mode and rejects a stale id', async () => {
    const service = makeService();
    const { sessionId } = service.createSession();
    await service.submitInput(sessionId, { text: 'do it', mode: 'action' } as never);
    const actionId = service.getStatus(sessionId).pendingAction!.id;

    expect(() => service.cancelAction(sessionId, 'wrong')).toThrow('Pending action wrong not found');
    service.cancelAction(sessionId, actionId);

    const status = service.getStatus(sessionId);
    expect(status.pendingAction).toBeUndefined();
    expect(status.mode).toBe('chat');
    expect(status.trust.level).toBe('untrusted');
    expect(types(service, sessionId).slice(-2)).toEqual(['action.cancelled', 'status.updated']);
  });

  it('infers the confirmation route from the pending description prefix', () => {
    const bridge = internals(makeService());
    expect(bridge.inferPendingActionRoute('Creative: a lake')).toBe('creative');
    expect(bridge.inferPendingActionRoute('hybrid: both')).toBe('hybrid');
    expect(bridge.inferPendingActionRoute('anything else')).toBe('engineering');
  });

  it('runs confirmed work through the engineering stream and reports its failure as events', async () => {
    const service = makeService();
    const { sessionId } = service.createSession();
    await service.submitInput(sessionId, { text: 'fix the build', mode: 'action' } as never);
    const actionId = service.getStatus(sessionId).pendingAction!.id;
    const engineering = vi.spyOn(internals(service), 'streamEngineeringTask')
      .mockRejectedValue(new Error('engine exploded'));
    const llm = { getConfig: () => ({ model: 'm', baseUrl: '' }) } as unknown as LLMClient;

    await service.confirmAction(sessionId, actionId, llm);
    await vi.waitFor(() => {
      expect(service.getEvents(sessionId).some(event => event.type === 'error')).toBe(true);
    });

    expect(engineering).toHaveBeenCalledTimes(1);
    expect(engineering.mock.calls[0]?.[1]).toBe('fix the build');
    const tail = service.getEvents(sessionId).slice(-2) as Anyish[];
    expect(tail[0]).toMatchObject({ type: 'activity.updated', message: 'Task failed: engine exploded' });
    expect(tail[1]).toMatchObject({ type: 'error', message: 'engine exploded' });
  });

  it('stops a run: emits cancellation events and marks the run cancelled', () => {
    const service = makeService();
    const { sessionId } = service.createSession();
    const bridge = internals(service);
    bridge.beginRun(sessionId, { kind: 'creative', label: 'Create' });
    const controller = new AbortController();
    bridge.activeStreams.set(sessionId, controller);

    service.cancelRun(sessionId);

    expect(controller.signal.aborted).toBe(true);
    expect(bridge.activeStreams.has(sessionId)).toBe(false);
    expect(service.getStatus(sessionId).run).toMatchObject({ phase: 'failed', outcome: 'cancelled' });
    const stopped = service.getEvents(sessionId).filter((event): event is Anyish => event.type === 'status.updated')
      .map(event => event.status.activeTask);
    expect(stopped).toContain('Generation stopped');
    expect(service.getStatus(sessionId).mode).toBe('chat');
    const emitted = types(service, sessionId);
    expect(emitted).toEqual(expect.arrayContaining(['generation.cancelled', 'activity.updated']));
    expect(emitted.indexOf('generation.cancelled')).toBeLessThan(emitted.indexOf('activity.updated'));
  });

  it('reports an LLM failure on the direct-chat route as an error event and a failed run', async () => {
    const service = makeService();
    const { sessionId } = service.createSession();
    const llm = {
      getConfig: () => ({ model: 'm', baseUrl: 'https://api.example.com/v1' }),
      generate: vi.fn().mockRejectedValue(new Error('upstream 500')),
    } as unknown as LLMClient;

    await service.submitInput(sessionId, { text: 'tell me a story', mode: 'chat' } as never, llm);
    await vi.waitFor(() => {
      expect(service.getStatus(sessionId).run?.phase).toBe('failed');
    });

    expect(service.getStatus(sessionId).run).toMatchObject({ kind: 'chat', outcome: 'failed', error: 'upstream 500' });
    const errors = service.getEvents(sessionId).filter((event): event is Anyish => event.type === 'error');
    expect(errors.length).toBeGreaterThanOrEqual(1);
    expect(errors[0]).toMatchObject({ message: 'upstream 500', model: 'm' });
    expect(types(service, sessionId)).not.toContain('session.turn');
  });
});

describe('formatting and parsing helpers', () => {
  it('splits strings into fixed-size chunks', () => {
    const bridge = internals(makeService());
    expect(bridge.chunkString('abcdefg', 3)).toEqual(['abc', 'def', 'g']);
    expect(bridge.chunkString('', 3)).toEqual([]);
  });

  it('extracts code only when the text looks like code', () => {
    const bridge = internals(makeService());
    expect(bridge.extractCodeContent('function foo() { return 1; }')).toBe('function foo() { return 1; }');
    expect(bridge.extractCodeContent('just prose')).toBeNull();
  });

  it('labels the provider from a base URL', () => {
    const bridge = internals(makeService());
    expect(typeof bridge.providerLabelFromBaseUrl('https://api.example.com/v1')).toBe('string');
    expect(bridge.providerLabelFromBaseUrl('https://api.example.com/v1').length).toBeGreaterThan(0);
  });

  it('maps process stages onto a stable phase name', () => {
    const bridge = internals(makeService());
    const phase = bridge.phaseForProcessStage('verification: runBuild');
    expect(typeof phase).toBe('string');
    expect(bridge.phaseForProcessStage('verification: runBuild')).toBe(phase);
  });
});

describe('product command ports', () => {
  it('rejects every unconfigured runtime with its own error code', async () => {
    const service = makeService();
    await expect(service.submitDreamResearch({} as never)).rejects.toThrow('DREAM_PRODUCT_RUNTIME_NOT_CONFIGURED');
    await expect(service.submitDreamTransfer({} as never)).rejects.toThrow('DREAM_TRANSFER_RUNTIME_NOT_CONFIGURED');
    await expect(service.submitDreamActivation({} as never)).rejects.toThrow('DREAM_ACTIVATION_RUNTIME_NOT_CONFIGURED');
    await expect(service.submitCompoundCreate({} as never)).rejects.toThrow('COMPOUND_CREATE_RUNTIME_NOT_CONFIGURED');
  });

  it('forwards commands to the configured runtimes and returns their projections', async () => {
    const run = vi.fn().mockResolvedValue({ ok: 'projection' });
    const service = makeService({
      dreamCommands: { run } as never,
      dreamTransferCommands: { run } as never,
      dreamActivationCommands: { run } as never,
      compoundCreateCommands: { run } as never,
    });
    const command = { id: 'cmd' } as never;

    await expect(service.submitDreamResearch(command)).resolves.toEqual({ ok: 'projection' });
    await expect(service.submitDreamTransfer(command)).resolves.toEqual({ ok: 'projection' });
    await expect(service.submitDreamActivation(command)).resolves.toEqual({ ok: 'projection' });
    await expect(service.submitCompoundCreate(command)).resolves.toEqual({ ok: 'projection' });
    expect(run).toHaveBeenCalledTimes(4);
    expect(run).toHaveBeenCalledWith(command);
  });

  it('fails closed when the product command port is absent', async () => {
    const service = makeService();
    await expect(service.submitLiminalCreate('studio', {} as never)).rejects.toThrow('LIMINAL_PRODUCT_COMMAND_PORT_REQUIRED');
    expect(() => service.readLiminalProjection('k')).toThrow('LIMINAL_PRODUCT_COMMAND_PORT_REQUIRED');
  });

  it('delegates create and projection reads to the configured port', async () => {
    const port = {
      submitCreate: vi.fn().mockResolvedValue({ kind: 'create' }),
      projection: vi.fn().mockResolvedValue({ kind: 'seen' }),
    } as unknown as LiminalProductCommandPort;
    const service = makeService({ productCommands: port });

    await expect(service.submitLiminalCreate('chat', { idempotencyKey: 'k' } as never)).resolves.toEqual({ kind: 'create' });
    await expect(service.readLiminalProjection('k')).resolves.toEqual({ kind: 'seen' });
    expect(port.submitCreate).toHaveBeenCalledWith('chat', { idempotencyKey: 'k' });
    expect(port.projection).toHaveBeenCalledWith('k');
  });

  it('validates Studio create intents before touching the factory', async () => {
    const factory = vi.fn();
    const service = makeService({ productCreateCommand: factory, productCommands: {} as never });
    const invalid: unknown[] = [
      null, [], { prompt: 'p', domain: 'd' }, { prompt: ' ', domain: 'd', layers: ['l'] },
      { prompt: 'p', domain: '', layers: ['l'] }, { prompt: 'p', domain: 'd', layers: [] },
      { prompt: 'p', domain: 'd', layers: [' '] }, { prompt: 'p', domain: 'd', layers: ['l'], extra: 1 },
    ];
    for (const intent of invalid) {
      await expect(service.submitStudioCreate(intent as never)).rejects.toThrow('STUDIO_CREATE_INTENT_INVALID');
    }
    expect(factory).not.toHaveBeenCalled();
  });

  it('requires a command factory for Studio create and composition', async () => {
    const service = makeService();
    await expect(service.submitStudioCreate({ prompt: 'p', domain: 'd', layers: ['l'] }))
      .rejects.toThrow('LIMINAL_PRODUCT_COMMAND_FACTORY_REQUIRED');
    await expect(service.composeStudioLayersGoverned({ layers: [] } as never))
      .rejects.toThrow('LIMINAL_PRODUCT_COMMAND_FACTORY_REQUIRED');
  });

  it('builds the governed command from the Studio intent with two transport attempts', async () => {
    const command = { idempotencyKey: 'idem-1' };
    const factory = vi.fn().mockResolvedValue(command);
    const port = { submitCreate: vi.fn().mockResolvedValue({ kind: 'create' }) } as unknown as LiminalProductCommandPort;
    const service = makeService({ productCreateCommand: factory, productCommands: port });

    await service.submitStudioCreate({ prompt: 'a lake', domain: 'p5', layers: ['p5-composition'] });

    expect(factory).toHaveBeenCalledWith({
      prompt: 'a lake', domain: 'p5', layers: ['p5-composition'], maxTransportAttempts: 2,
    });
    expect(port.submitCreate).toHaveBeenCalledWith('studio', command);
  });

  it('rejects governed composition when the port does not return a create projection', async () => {
    const port = {
      submitCreate: vi.fn().mockResolvedValue({ kind: 'proposal' }),
      verifiedArtifact: vi.fn(),
    } as unknown as LiminalProductCommandPort;
    const factory = vi.fn().mockResolvedValue({ idempotencyKey: 'k' });
    const service = makeService({ productCreateCommand: factory, productCommands: port });

    await expect(service.composeStudioLayersGoverned({
      title: 'T', layers: [{ domain: 'p5', prompt: 'a' }, { domain: 'css', prompt: 'b', opacity: 0.5 }],
    } as never)).rejects.toThrow('LIMINAL_COMPOSITION_CREATE_INVALID');
    expect(factory.mock.calls[0]?.[0]).toMatchObject({
      domain: 'html', layers: ['p5:normal:1', 'css:normal:0.5'], maxTransportAttempts: 2,
    });
    expect(port.verifiedArtifact).not.toHaveBeenCalled();
  });

  it('fails the governed create stream with an error event and failed run when no factory exists', async () => {
    const service = makeService();
    const { sessionId } = service.createSession();

    await expect(internals(service).streamGovernedProductCreate(sessionId, 'a lake', {} as never))
      .rejects.toThrow('LIMINAL_PRODUCT_COMMAND_FACTORY_REQUIRED');
    expect(service.getEvents(sessionId)).toEqual([]);
  });

  it('turns a rejected governed create into error event plus failed run, then rethrows', async () => {
    const factory = vi.fn().mockRejectedValue(new Error('factory down'));
    const service = makeService({ productCreateCommand: factory, productCommands: {} as never });
    const { sessionId } = service.createSession();

    await expect(internals(service).streamGovernedProductCreate(sessionId, 'a calm lake', {} as never))
      .rejects.toThrow('factory down');

    expect(service.getStatus(sessionId).run).toMatchObject({
      kind: 'creative', phase: 'failed', outcome: 'failed', error: 'factory down',
    });
    const emitted = types(service, sessionId);
    expect(emitted).toContain('generation.route.selected');
    expect(service.getEvents(sessionId).find((event): event is Anyish => event.type === 'error'))
      .toMatchObject({ message: 'factory down' });
  });
});

describe('living loop', () => {
  it('rejects unknown sessions and unconfigured loops', () => {
    const service = makeService();
    const { sessionId } = service.createSession();
    const request = { cycleId: 'c', lineageId: 'l', sourceFingerprint: 'f', budgets: {} } as never;

    expect(() => service.conductLivingLoop('ghost', request, 'actor', {} as never))
      .toThrow('Unknown TUI session: ghost');
    internals(service).cortexLoop = null;
    expect(() => service.conductLivingLoop(sessionId, request, 'actor', {} as never))
      .toThrow('CORTEX_LIVING_LOOP_NOT_CONFIGURED');
  });

  it('queues every step, then reports executor results as lifecycle events', async () => {
    const service = makeService();
    const { sessionId } = service.createSession();
    const request = {
      cycleId: 'cycle-1', lineageId: 'lin-1', sourceFingerprint: 'fp', budgets: { actions: 3 },
    } as never;
    const result = { effects: [{ id: 'eff-1' }], receiptRefs: ['ref-1'] };
    const executor = { execute: vi.fn().mockResolvedValue(result), recover: vi.fn().mockResolvedValue(null) };
    internals(service).cortexLoop.conductLivingLoop = vi.fn(async (_req: unknown, _actor: string, observed: Anyish) => {
      await observed.execute({ step: 'observe', remaining: { actions: 2 } });
      await observed.recover({ step: 'observe', remaining: { actions: 1 } });
      return { checkpoint: true };
    });

    const checkpoint = await service.conductLivingLoop(sessionId, request, 'actor-1', executor as never);

    expect(checkpoint).toEqual({ checkpoint: true });
    const lifecycle = service.getEvents(sessionId).filter((event): event is Anyish => event.type === 'cortex.action_lifecycle');
    const queued = lifecycle.filter(event => event.state === 'queued');
    expect(queued.length).toBeGreaterThanOrEqual(1);
    expect(queued.every(event => event.disposition === 'proposed' && event.cycleId === 'cycle-1')).toBe(true);
    const after = lifecycle.slice(queued.length);
    expect(after.map(event => event.state)).toEqual(['running', 'completed', 'running', 'failed']);
    expect(after[1]).toMatchObject({
      disposition: 'executed', effectIds: ['eff-1'], artifactRefs: ['ref-1'], errorClass: null, actorId: 'actor-1',
    });
    expect(after[3]).toMatchObject({ disposition: 'proposed', errorClass: 'recovery-required', effectIds: [] });
  });

  it('records the error class and rethrows when a step executor throws', async () => {
    const service = makeService();
    const { sessionId } = service.createSession();
    class StepError extends Error { override name = 'StepError'; }
    const executor = { execute: vi.fn().mockRejectedValue(new StepError('x')), recover: vi.fn() };
    internals(service).cortexLoop.conductLivingLoop = vi.fn(async (_r: unknown, _a: string, observed: Anyish) =>
      observed.execute({ step: 'observe', remaining: {} }));

    await expect(service.conductLivingLoop(sessionId, { budgets: {} } as never, 'a', executor as never))
      .rejects.toThrow('x');

    const last = service.getEvents(sessionId).at(-1) as Anyish;
    expect(last).toMatchObject({ type: 'cortex.action_lifecycle', state: 'failed', errorClass: 'StepError' });
  });
});

describe('artist review and host authority', () => {
  it('registers an artist review surface, publishes its digest, and serves its state', () => {
    const service = makeService();
    const { sessionId } = service.createSession();
    const surface = { state: () => artistState(2), executeAction: vi.fn() };

    const state = service.registerArtistReview(sessionId, surface as never);

    expect(state.stateDigest).toBe('digest-2');
    expect(service.getEvents(sessionId).at(-1)).toEqual({
      type: 'artist.review_state', sessionId, stateDigest: 'digest-2', decisionVersion: 2,
    });
    expect(service.getArtistReviewState(sessionId)).toEqual(state);
  });

  it('reports a missing review for sessions that never registered one', () => {
    const service = makeService();
    const { sessionId } = service.createSession();
    expect(() => service.getArtistReviewState(sessionId)).toThrow(`Artist review not found for session: ${sessionId}`);
    expect(() => service.executeArtistReviewAction(sessionId, 'tok')).toThrow(`Artist review not found for session: ${sessionId}`);
  });

  it('executes a non-host action on the surface and publishes the resulting state with feedback', () => {
    const service = makeService();
    const { sessionId } = service.createSession();
    const executeAction = vi.fn().mockReturnValue({ accepted: true, feedback: 'Noted.', state: artistState(3) });
    service.registerArtistReview(sessionId, { state: () => artistState(), executeAction } as never);

    const result = service.executeArtistReviewAction(sessionId, 'plain-token');

    expect(executeAction).toHaveBeenCalledWith('plain-token');
    expect(result.feedback).toBe('Noted.');
    expect(service.getEvents(sessionId).at(-1)).toEqual({
      type: 'artist.review_state', sessionId, stateDigest: 'digest-3', decisionVersion: 3, feedback: 'Noted.',
    });
  });

  it('keeps an authentic review immutable once registered', () => {
    const service = makeService();
    const { sessionId } = service.createSession();
    const review = { state: () => artistState() } as unknown as ArtistReviewSession;

    service.registerAuthenticArtistReview(sessionId, review);
    expect(() => service.registerAuthenticArtistReview(sessionId, review)).not.toThrow();
    expect(() => service.registerAuthenticArtistReview(sessionId, { state: () => artistState() } as never))
      .toThrow('ARTIST_REVIEW_SESSION_IMMUTABLE');
  });

  it('rejects an unknown or expired bootstrap grant when creating a session', () => {
    const service = makeService();
    expect(() => service.createSession({}, 'not-a-grant')).toThrow('ARTIST_REVIEW_BOOTSTRAP_GRANT_INVALID');
  });

  it('requires host authentication for every owner-gated entry point', async () => {
    const service = makeService();
    const { sessionId } = service.createSession();
    await expect(service.startTransferPromotion(sessionId, 'cred')).rejects.toThrow('BRIDGE_HOST_AUTHENTICATION_REQUIRED');
    await expect(service.startGovernedCampaignOwnerDecisionComparison(sessionId, 'cred', {} as never))
      .rejects.toThrow('BRIDGE_HOST_AUTHENTICATION_REQUIRED');
    await expect(service.finalizeGovernedCampaignOwnerDecision(sessionId, 'cred', {} as never))
      .rejects.toThrow('BRIDGE_HOST_AUTHENTICATION_REQUIRED');
  });

  it('rejects blank credentials, wrong roles, and capabilities that fail verification', async () => {
    const owner = { principalId: 'owner-1', role: 'owner' as const };

    const blank = makeService(hostAuth(owner));
    const a = blank.createSession().sessionId;
    await expect(blank.startTransferPromotion(a, '   ')).rejects.toThrow('BRIDGE_HOST_AUTHENTICATION_REQUIRED');

    const wrongRole = makeService(hostAuth({ principalId: 'rev-1', role: 'reviewer' }));
    const b = wrongRole.createSession().sessionId;
    await expect(wrongRole.startTransferPromotion(b, 'cred')).rejects.toThrow('BRIDGE_HOST_ACTOR_ROLE_INVALID');

    const unknownActor = makeService(hostAuth(undefined));
    const c = unknownActor.createSession().sessionId;
    await expect(unknownActor.startTransferPromotion(c, 'cred')).rejects.toThrow('BRIDGE_HOST_ACTOR_ROLE_INVALID');

    const mismatch = makeService(hostAuth(owner, { id: 'someone-else', role: 'owner' }));
    const d = mismatch.createSession().sessionId;
    await expect(mismatch.startTransferPromotion(d, 'cred')).rejects.toThrow('BRIDGE_HOST_ACTOR_IDENTITY_INVALID');
  });

  it('requires an authentic review and reviewer capability before starting a transfer promotion', async () => {
    const service = makeService(hostAuth({ principalId: 'owner-1', role: 'owner' }));
    const { sessionId } = service.createSession();
    await expect(service.startTransferPromotion(sessionId, 'cred'))
      .rejects.toThrow('TRANSFER_PROMOTION_AUTHENTIC_REVIEW_REQUIRED');
  });

  it('refuses action checkpoints without an authentic review and release targets that are not ready', () => {
    const service = makeService(hostAuth({ principalId: 'owner-1', role: 'owner' }));
    const { sessionId } = service.createSession();
    expect(() => service.issueArtistReviewActionCheckpoint(sessionId, 'cred', { kind: 'learning' } as never))
      .toThrow(`Authentic artist review not found for session: ${sessionId}`);
    expect(() => service.issueArtistReviewReleaseCheckpoint(sessionId, 'cred', 'release-worthy'))
      .toThrow('ARTIST_REVIEW_RELEASE_TARGET_NOT_READY');
  });

  it('reports missing transfer promotion state, decision and checkpoints', () => {
    const service = makeService();
    const { sessionId } = service.createSession();
    expect(() => service.getTransferPromotionState(sessionId)).toThrow(`Transfer promotion not found for session: ${sessionId}`);
    expect(() => service.getTransferPromotionDecision(sessionId))
      .toThrow(`Transfer promotion decision not found for session: ${sessionId}`);
    expect(() => service.issueTransferPromotionCheckpointForHost(sessionId, 'owner', 'cred'))
      .toThrow(`Transfer promotion not found for session: ${sessionId}`);
    expect(() => service.executeTransferPromotionCheckpoint(sessionId, { token: 'nope' }, 'cred'))
      .toThrow('TRANSFER_PROMOTION_CHECKPOINT_INVALID');
  });
});

describe('governed campaign registration', () => {
  const manifest = { campaignRunId: 'camp-1', briefs: [{ id: 'b1' }, { id: 'b2' }], owner: { authorityId: 'owner-1' } } as never;

  it('requires one sealed review per manifest brief', () => {
    const service = makeService();
    const review = (briefId: string) => ({ packet: { briefId, packetDigest: 'd' }, closureContext: {} }) as never;

    expect(() => service.registerGovernedOwnerReviewResults({} as never, manifest, []))
      .toThrow('GOVERNED_OWNER_CLOSURE_REVIEW_COVERAGE_INVALID');
    expect(() => service.registerGovernedOwnerReviewResults({} as never, manifest, [review('b1'), review('b1')]))
      .toThrow('GOVERNED_OWNER_CLOSURE_REVIEW_COVERAGE_INVALID');
    expect(() => service.registerGovernedOwnerReviewResults({} as never, manifest, [review('b1'), review('zzz')]))
      .toThrow('GOVERNED_OWNER_CLOSURE_REVIEW_COVERAGE_INVALID');
  });

  it('refuses revision-decision sessions before an owner closure context exists', () => {
    const service = makeService();
    const { sessionId } = service.createSession();
    expect(() => service.registerGovernedRevisionDecisionSession(sessionId, 'camp-1', 'b1'))
      .toThrow('GOVERNED_OWNER_CLOSURE_CONTEXT_MISSING');
  });

  it('requires owner closure context after owner authentication', async () => {
    const service = makeService(hostAuth({ principalId: 'owner-1', role: 'owner' }));
    const { sessionId } = service.createSession();
    const input = { campaignRunId: 'camp-1', briefId: 'b1', revisionEvidenceId: 'rev' };
    await expect(service.startGovernedCampaignOwnerDecisionComparison(sessionId, 'cred', input))
      .rejects.toThrow('GOVERNED_OWNER_CLOSURE_CONTEXT_MISSING');
    await expect(service.finalizeGovernedCampaignOwnerDecision(sessionId, 'cred', input))
      .rejects.toThrow('GOVERNED_OWNER_CLOSURE_CONTEXT_MISSING');
  });

  it('requires durable persistence to register or continue a governed campaign', async () => {
    const service = makeService(hostAuth({ principalId: 'owner-1', role: 'owner' }));
    const { sessionId } = service.createSession();

    await expect(service.registerGovernedCampaignContinuationForHost({
      sessionId, ownerCredential: 'cred', manifest, plan: {} as never, checkpoint: {} as never,
      learningEvidenceId: 'ev', target: {} as never,
    })).rejects.toThrow('GOVERNED_CAMPAIGN_CONTINUATION_PERSISTENCE_REQUIRED');
    await expect(service.continueGovernedCampaign(sessionId, 'cred', 'camp-1'))
      .rejects.toThrow('GOVERNED_CAMPAIGN_CONTINUATION_CONTEXT_MISSING');
  });
});

describe('background wiring', () => {
  it('broadcasts cortex snapshots ephemerally without growing session history', () => {
    vi.useFakeTimers();
    try {
      const service = makeService();
      const { sessionId } = service.createSession();
      const publish = vi.spyOn(internals(service).stream, 'publishEphemeral');

      vi.advanceTimersByTime(5000);

      expect(publish).toHaveBeenCalledWith(sessionId, expect.objectContaining({ type: 'cortex.snapshot', sessionId }));
      expect(service.getEvents(sessionId).some(event => event.type === 'cortex.snapshot')).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('exposes the six canonical gardener behaviour axes', () => {
    expect(internals(makeService()).gardenerAxes()).toHaveLength(6);
  });
});
