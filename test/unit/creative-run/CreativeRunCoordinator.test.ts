import { describe, expect, it, vi, afterEach } from 'vitest';
import { validateCreativeRunRecord } from '../../../src/creative-run/CreativeRunCoordinator.js';
import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { CompositionOrchestrator } from '../../../src/composition/CompositionOrchestrator.js';
import {
  CreativeRunCoordinator,
  FileCreativeRunPersistence,
  MemoryCreativeRunPersistence,
  type CreativeRunRequest,
} from '../../../src/creative-run/CreativeRunCoordinator.js';
import { compileCreativeThesis } from '../../../src/creative-intelligence/CreativeIntelligence.js';
import { createCampaignAuthority, InMemoryCampaignAdmissionStore } from '../../../src/runtime-core/CampaignOrigin.js';
import { LLMClient } from '../../../src/llm/LLMClient.js';
import { HarnessTransportGuard, type HarnessTransportAuthority } from '../../../src/identity/harnessTransportGuard.js';
import { ReservationTracker } from '../../../src/identity/executorReservation.js';
import { NonceLedger, issueExecutorAttestation } from '../../../src/identity/executorAttestation.js';
import { buildRegistry, CLIPROXY_SURFACE, SOL_IDENTITY, SOL_SEAT, SOL_SUBSCRIPTION_FUNDING } from '../identity/helpers.js';
import { ok } from 'neverthrow';

afterEach(() => { vi.unstubAllEnvs(); });

const request: CreativeRunRequest = {
  entryPoint: 'cli-compose',
  requestKey: 'retry-1',
  prompt: 'a deterministic layered scene',
  provider: 'test-provider',
  model: 'test-model',
};

describe('CreativeRunCoordinator', () => {
  it('rejects a forged digest-only governed request before transport', async () => {
    const ledgerRoot = await mkdtemp(path.join(tmpdir(), 'coordinator-executor-'));
    const { privateKey } = generateKeyPairSync('ed25519');
    const campaignAuthority = createCampaignAuthority({
      keyId: 'host', privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
      admissionStore: new InMemoryCampaignAdmissionStore(),
    });
    const registry = buildRegistry();
    const attest = vi.fn<NonNullable<HarnessTransportAuthority['attestCompletion']>>(({ context }) =>
      issueExecutorAttestation(registry, {
        attestationId: 'coordinator-attestation', runDigest: 'campaign-run',
        requestDigest: context.requestDigest, attemptDigest: 'attempt',
        routeDigest: context.routeDigest, attemptOrdinal: context.attemptOrdinal,
        fallbackOrdinal: context.fallbackOrdinal, retryOrdinal: context.retryOrdinal,
        priorTraceDigest: context.priorTraceDigest, policyTraceDigest: context.policyTraceDigest,
        requestedIdentity: context.requestedIdentity, resolvedIdentity: context.resolvedIdentity,
        effort: context.resolvedIdentity.effort, fallbackChain: context.fallbackChain,
        seat: SOL_SEAT, funding: SOL_SUBSCRIPTION_FUNDING, quotaSurface: 'cliproxy-seat',
        issuedAt: new Date().toISOString(), nonce: 'coordinator-attestation-nonce', surface: CLIPROXY_SURFACE,
        durationMs: 0, success: true,
        quotaCounterDelta: { calls: 1, inputTokens: 0, outputTokens: 0, activeSeconds: 0 },
      }));
    const executorAuthority: HarnessTransportAuthority = {
      guard: new HarnessTransportGuard(registry, {
        reservations: new ReservationTracker(path.join(ledgerRoot, 'reservations')),
        nonces: new NonceLedger(path.join(ledgerRoot, 'nonces')),
      }),
      reserveAttempt: () => { throw new Error('studio attempt must not reserve harness transport'); },
      attestCompletion: attest,
    };
    const llm = new LLMClient({ role: 'studio', baseUrl: 'http://localhost:9/v1', model: SOL_IDENTITY.model });
    vi.spyOn(llm as never, 'resolveModel' as never).mockResolvedValue(SOL_IDENTITY.model as never);
    const generate = vi.fn(async () => ok({
      content: '{"title":"x","background":"#000","layers":[{"domain":"html","prompt":"x"}]}',
      model: SOL_IDENTITY.model, success: true,
    }));
    vi.spyOn(llm as never, 'getProvider' as never).mockResolvedValue({
      name: 'anthropic', getModel: () => SOL_IDENTITY.model,
      getConfig: () => ({ baseUrl: 'http://localhost:9/v1' }), generate,
    } as never);
    const compose = vi.spyOn(CompositionOrchestrator, 'compose').mockRejectedValueOnce(new Error('stop-after-decompose'));
    const coordinator = new CreativeRunCoordinator({
      persistence: new MemoryCreativeRunPersistence(), executorAuthority,
      campaignAuthority, campaignPreflight: async () => ({
        releaseHead: 'b'.repeat(40), sourceFingerprint: 'c'.repeat(64), schemaDigest: 'd'.repeat(64),
        implementationDigest: 'e'.repeat(64), wave8ReleaseRootDigest: 'f'.repeat(64),
      }),
    });
    await expect(coordinator.runGovernedCampaign({ kind: 'prompt', prompt: 'x', llm }, {
      campaignRunId: 'campaign-authority', manifestDigest: 'a'.repeat(64),
    } as never)).rejects.toThrow(/host-admitted funding reservation/);
    expect(compose).not.toHaveBeenCalled();
    expect(generate).not.toHaveBeenCalled();
    expect(attest).not.toHaveBeenCalled();
    expect(llm.getHarnessExecutorProjection()).toMatchObject({ status: 'idle' });
    compose.mockRestore();
    await rm(ledgerRoot, { recursive: true, force: true });
  });
  it('blocks a governed campaign before provider reservation when host preflight fails', async () => {
    const { privateKey } = generateKeyPairSync('ed25519');
    const reserve = vi.fn(async () => ({ id: 'must-not-run', status: 'reserved' as const }));
    const preflight = vi.fn(async () => { throw new Error('release root stale'); });
    const coordinator = new CreativeRunCoordinator({
      persistence: new MemoryCreativeRunPersistence(), reserveProvider: reserve,
      campaignPreflight: preflight,
      campaignAuthority: createCampaignAuthority({
        keyId: 'host', privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
        admissionStore: new InMemoryCampaignAdmissionStore(),
      }),
    });
    const d = (char: string) => char.repeat(64);
    await expect(coordinator.runGovernedCampaign({
      kind: 'spec', spec: { layers: [{ domain: 'html', prompt: 'x', code: '<p>x</p>' }] },
    }, {
      campaignRunId: 'campaign-blocked', manifestDigest: d('a'),
    } as never, { requestKey: 'campaign-blocked' })).rejects.toThrow(/host-admitted funding reservation/);
    expect(reserve).not.toHaveBeenCalled();
    expect(preflight).not.toHaveBeenCalled();
  });

  it('rejects an unbacked full-looking origin tuple', async () => {
    const { privateKey } = generateKeyPairSync('ed25519');
    const authority = createCampaignAuthority({
      keyId: 'host', privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
      admissionStore: new InMemoryCampaignAdmissionStore(),
    });
    const coordinator = new CreativeRunCoordinator({
      persistence: new MemoryCreativeRunPersistence(),
      reserveProvider: async () => ({ id: 'product-reservation', status: 'reserved' }),
      campaignAuthority: authority, campaignPreflight: async () => ({
        releaseHead: 'b'.repeat(40), sourceFingerprint: 'c'.repeat(64),
        schemaDigest: 'd'.repeat(64), implementationDigest: 'e'.repeat(64),
        wave8ReleaseRootDigest: 'f'.repeat(64),
      }),
      idFactory: () => 'product-root',
    });
    const d = (char: string) => char.repeat(64);
    const binding = { campaignRunId: 'campaign-product', manifestDigest: d('a'),
      campaignFundingReservationDigest: d('b'), campaignPlanDigest: d('c'),
      campaignRouteFreezeDigest: d('d') };
    await expect(coordinator.runGovernedCampaign({
      kind: 'spec', spec: { layers: [{ domain: 'html', prompt: 'x', code: '<p>x</p>' }] },
    }, binding as never, { entryPoint: 'studio-layers', requestKey: 'product-request' }))
      .rejects.toThrow(/host-admitted funding reservation/);
  });

  it('creates one coordinator-owned run and reservation for retries', async () => {
    const persistence = new MemoryCreativeRunPersistence();
    const reserve = vi.fn(async () => ({ id: 'reservation-1', status: 'reserved' as const }));
    const coordinator = new CreativeRunCoordinator({ persistence, reserveProvider: reserve });

    const first = await coordinator.start(request);
    const second = await coordinator.start(request);

    expect(second.rootRunId).toBe(first.rootRunId);
    expect(second.lineageId).toBe(first.rootRunId);
    expect(reserve).toHaveBeenCalledTimes(1);
    expect(first.readiness).toEqual({
      wave: 8,
      ready: true,
      source: 'injected-provider',
      reason: 'Provider reservation was injected by the caller.',
    });
    expect(await persistence.read('retry-1')).toMatchObject({
      schemaVersion: 2,
      rootRunId: first.rootRunId,
      releaseRoot: expect.any(String),
      providerReservation: { id: 'reservation-1', status: 'reserved' },
    });
  });

  it('lets a retried failed run complete but never downgrades a completed outcome', async () => {
    const persistence = new MemoryCreativeRunPersistence();
    const coordinator = new CreativeRunCoordinator({ persistence });
    const handle = await coordinator.start(request);

    expect((await coordinator.finish(handle, 'failed')).record.status).toBe('failed');
    const retried = await coordinator.start(request);
    expect(retried.record.status).toBe('failed');
    expect((await coordinator.finish(retried, 'completed')).record.status).toBe('completed');

    const stale = await coordinator.finish(handle, 'failed');
    expect(stale.record.status).toBe('completed');
    expect((await persistence.read('retry-1'))?.status).toBe('completed');
  });

  it('treats repeating the stored outcome as a no-op', async () => {
    const persistence = new MemoryCreativeRunPersistence();
    const coordinator = new CreativeRunCoordinator({ persistence, now: () => '2026-11-09T00:00:00.000Z' });
    const handle = await coordinator.start(request);
    const first = await coordinator.finish(handle, 'completed');
    const again = await coordinator.finish(handle, 'completed');

    expect(again.record).toEqual(first.record);
  });

  it('resumes a persisted run after a coordinator restart', async () => {
    const persistence = new MemoryCreativeRunPersistence();
    const firstCoordinator = new CreativeRunCoordinator({ persistence });
    const first = await firstCoordinator.start(request);
    const restarted = new CreativeRunCoordinator({ persistence });

    const second = await restarted.start(request);

    expect(second.rootRunId).toBe(first.rootRunId);
    expect(second.providerReservation.id).toBe(first.providerReservation.id);
  });

  it('keeps synchronous Studio reservations idempotent across restarts', () => {
    const persistence = new MemoryCreativeRunPersistence();
    const reserve = vi.fn(() => ({ id: 'sync-reservation', status: 'reserved' as const }));
    const first = new CreativeRunCoordinator({ persistence, reserveProviderSync: reserve }).startSync({
      ...request,
      entryPoint: 'studio-session',
      requestKey: 'studio-retry-1',
    });
    const second = new CreativeRunCoordinator({ persistence, reserveProviderSync: reserve }).startSync({
      ...request,
      entryPoint: 'studio-session',
      requestKey: 'studio-retry-1',
    });

    expect(second.rootRunId).toBe(first.rootRunId);
    expect(second.providerReservation.id).toBe('sync-reservation');
    expect(reserve).toHaveBeenCalledOnce();
  });

  it('survives a file-backed coordinator restart without a second reservation', async () => {
    const root = await mkdtemp(`${tmpdir()}/creative-run-`);
    try {
      const persistence = new FileCreativeRunPersistence(root);
      const reserve = vi.fn(async () => ({ id: 'file-reservation', status: 'reserved' as const }));
      const first = await new CreativeRunCoordinator({ persistence, reserveProvider: reserve }).start(request);
      const second = await new CreativeRunCoordinator({ persistence, reserveProvider: reserve }).start(request);
      expect(second.rootRunId).toBe(first.rootRunId);
      expect(reserve).toHaveBeenCalledOnce();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('reserves exactly once when separate file-backed coordinators start concurrently', async () => {
    const root = await mkdtemp(`${tmpdir()}/creative-run-concurrent-`);
    try {
      const persistenceA = new FileCreativeRunPersistence(root);
      const persistenceB = new FileCreativeRunPersistence(root);
      const reserve = vi.fn(async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        return { id: 'concurrent-reservation', status: 'reserved' as const };
      });
      const requestWithKey = { ...request, requestKey: 'concurrent-1' };

      const [first, second] = await Promise.all([
        new CreativeRunCoordinator({ persistence: persistenceA, reserveProvider: reserve }).start(requestWithKey),
        new CreativeRunCoordinator({ persistence: persistenceB, reserveProvider: reserve }).start(requestWithKey),
      ]);

      expect(first.rootRunId).toBe(second.rootRunId);
      expect(first.providerReservation.id).toBe('concurrent-reservation');
      expect(reserve).toHaveBeenCalledTimes(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('fails closed on corrupt persisted state without reserving again', async () => {
    const root = await mkdtemp(`${tmpdir()}/creative-run-corrupt-`);
    try {
      const requestKey = 'corrupt-1';
      const digest = createHash('sha256').update(requestKey).digest('hex');
      await mkdir(root, { recursive: true });
      await writeFile(path.join(root, `${digest}.json`), '{not valid json', 'utf8');
      const reserve = vi.fn(async () => ({ id: 'should-not-exist', status: 'reserved' as const }));

      await expect(new CreativeRunCoordinator({
        persistence: new FileCreativeRunPersistence(root),
        reserveProvider: reserve,
      }).start({ ...request, requestKey })).rejects.toThrow();
      expect(reserve).not.toHaveBeenCalled();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('recovers a bounded stale file claim before reserving', async () => {
    const root = await mkdtemp(`${tmpdir()}/creative-run-stale-`);
    try {
      const requestKey = 'stale-1';
      const digest = createHash('sha256').update(requestKey).digest('hex');
      const lockPath = path.join(root, `${digest}.json.lock`);
      await mkdir(lockPath, { recursive: true });
      const staleAt = new Date(Date.now() - 120_000);
      await utimes(lockPath, staleAt, staleAt);
      const reserve = vi.fn(async () => ({ id: 'recovered-reservation', status: 'reserved' as const }));

      const result = await new CreativeRunCoordinator({
        persistence: new FileCreativeRunPersistence(root),
        reserveProvider: reserve,
      }).start({ ...request, requestKey });

      expect(result.providerReservation.id).toBe('recovered-reservation');
      expect(reserve).toHaveBeenCalledOnce();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('adds readiness only to the coordinated composition result', async () => {
    // Hermetic: the measured-frame gate launches a real browser; it is not under test here.
    vi.stubEnv('SINTER_COMPOSITE_GATE', '0');
    const coordinator = new CreativeRunCoordinator({
      persistence: new MemoryCreativeRunPersistence(),
    });
    const result = await coordinator.compose({
      title: 'deterministic',
      layers: [{ domain: 'html', prompt: 'existing', code: '<div>ok</div>' }],
    }, { requestKey: 'compose-1', entryPoint: 'cli-compose' });

    expect(result.creativeRun.record.status).toBe('completed');
    expect(result.creativeRun.readiness).toEqual({
      wave: 8,
      ready: false,
      source: 'synthetic-no-spend',
      reason: 'No provider reservation was injected; this is a deterministic no-spend reservation.',
    });
    expect(result.successCount).toBe(1);

    const direct = await CompositionOrchestrator.compose({
      layers: [{ domain: 'html', prompt: 'existing', code: '<div>ok</div>' }],
    });
    expect(direct).not.toHaveProperty('creativeRun');
    expect(direct).not.toHaveProperty('readiness');
  });

  it('rejects conflicting run and composition theses before reserving provider spend', async () => {
    const reserve = vi.fn(async () => ({ id: 'must-not-reserve', status: 'reserved' as const }));
    const coordinator = new CreativeRunCoordinator({
      persistence: new MemoryCreativeRunPersistence(), reserveProvider: reserve,
    });
    const compositionThesis = compileCreativeThesis('Music with expressive dynamics.', { requestedPrinciples: ['music-dynamics'] });
    const suppliedThesis = compileCreativeThesis('Music with shaped timbre.', { requestedPrinciples: ['music-timbre'] });

    await expect(coordinator.compose({
      creativeThesis: compositionThesis,
      layers: [{ domain: 'music', prompt: 'expressive dynamics' }],
    }, { requestKey: 'conflicting-thesis', creativeThesis: suppliedThesis }))
      .rejects.toThrow(/incompatible.*provider reservation was not attempted/i);
    expect(reserve).not.toHaveBeenCalled();
  });

  it('returns the identical actionable failure projection to CLI and Studio', async () => {
    const failureProjection = {
      failureClass: 'timeout' as const,
      action: 'Retry after provider health recovers; the candidate recovery allowance is already bounded.',
      runId: 'run', candidateId: 'candidate', attemptId: 'attempt',
    };
    const compose = vi.spyOn(CompositionOrchestrator, 'compose').mockResolvedValue({
      html: '<div></div>', title: 'failed', background: '#000', layers: [], successCount: 0,
      failureProjection,
    });
    const coordinator = new CreativeRunCoordinator({ persistence: new MemoryCreativeRunPersistence() });
    const spec = { layers: [{ domain: 'html' as const, prompt: 'fixture', code: '<div></div>' }] };

    const cli = await coordinator.compose(spec, { requestKey: 'failure-cli', entryPoint: 'cli-compose' });
    const studio = await coordinator.compose(spec, { requestKey: 'failure-studio', entryPoint: 'studio-layers' });

    expect(cli.failureProjection).toEqual(failureProjection);
    expect(studio.failureProjection).toEqual(cli.failureProjection);
    compose.mockRestore();
  });

  it('keeps the CreativeRun, composition, wrapper, and audio evidence thesis identities equal', async () => {
    const thesis = compileCreativeThesis('Music with expressive dynamics and a luminous field.', {
      requestedPrinciples: ['music-dynamics'],
    });
    const result = await new CreativeRunCoordinator({
      persistence: new MemoryCreativeRunPersistence(),
    }).compose({
      title: 'One governed work', creativeThesis: thesis,
      layers: [
        { domain: 'p5', prompt: 'luminous field', code: 'function draw(){clear();}' },
        { domain: 'music', prompt: 'expressive dynamics' },
      ],
    }, { requestKey: 'one-thesis' });

    expect(result.creativeRun.creativeThesis?.thesisId).toBe(thesis.thesisId);
    expect(result.creativeThesis?.thesisId).toBe(thesis.thesisId);
    expect(result.layers[1].artifactHtml).toContain(thesis.thesisId);
    expect(result.audioEvidence?.[0].provenance.thesisId).toBe(thesis.thesisId);
  }, 30_000); // whole-pipeline test: 5 s default timed out on the public runner (db1b666)

  it('rejects an invalid graph before reserving provider spend', async () => {
    const reserve = vi.fn(async () => ({ id: 'must-not-reserve', status: 'reserved' as const }));
    const coordinator = new CreativeRunCoordinator({
      persistence: new MemoryCreativeRunPersistence(),
      reserveProvider: reserve,
    });
    await expect(coordinator.compose({
      schema: 'sinter.composition-graph',
      schemaVersion: '2.0',
      status: 'draft',
      id: 'draft-work',
      budgets: { maxNodes: 1, maxEdges: 0, maxProviderCalls: 1 },
      nodes: [{ id: 'layer-0', type: 'layer', layer: { domain: 'p5', prompt: 'draft' } }],
      edges: [],
    }, { requestKey: 'invalid-graph', entryPoint: 'cli-compose' })).rejects.toThrow(/Draft/);
    expect(reserve).not.toHaveBeenCalled();
  });

  it('keeps legacy no-thesis records read-compatible but blocks Wave 8 compose', async () => {
    const persistence = new MemoryCreativeRunPersistence();
    await persistence.write({
      schemaVersion: 1, rootRunId: 'legacy-run', lineageId: 'legacy-run',
      requestKey: 'legacy-compose', entryPoint: 'cli-compose', releaseRoot: '/tmp',
      status: 'reserved', providerReservation: { id: 'legacy-reservation', status: 'reserved' },
      readiness: { wave: 8, ready: false, source: 'synthetic-no-spend', reason: 'legacy' },
      createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
    });
    const compose = vi.spyOn(CompositionOrchestrator, 'compose');
    const handle = await new CreativeRunCoordinator({ persistence }).start({
      ...request, requestKey: 'legacy-compose',
    });
    expect(handle.creativeThesis).toBeUndefined();
    await expect(new CreativeRunCoordinator({ persistence }).compose({
      layers: [{ domain: 'html', prompt: 'legacy', code: '<div>legacy</div>' }],
    }, { requestKey: 'legacy-compose', entryPoint: 'cli-compose' })).rejects.toThrow(/legacy|thesis|read-only/i);
    expect(compose).not.toHaveBeenCalled();
    compose.mockRestore();
  });

  describe('FileCreativeRunPersistence schema validation', () => {
    const validRecord = {
      schemaVersion: 2,
      rootRunId: 'creative-1',
      lineageId: 'creative-1',
      requestKey: 'corrupt-validation-1',
      entryPoint: 'cli-compose',
      releaseRoot: '/tmp/release',
      status: 'reserved',
      provider: 'test-provider',
      model: 'test-model',
      providerReservation: { id: 'reservation-1', status: 'reserved', source: 'injected-provider' },
      readiness: { wave: 8, ready: true, source: 'injected-provider', reason: 'ok' },
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    };

    const persistRaw = async (root: string, requestKey: string, payload: unknown): Promise<void> => {
      const digest = createHash('sha256').update(requestKey).digest('hex');
      await mkdir(root, { recursive: true });
      await writeFile(
        path.join(root, `${digest}.json`),
        typeof payload === 'string' ? payload : JSON.stringify(payload),
        'utf8',
      );
    };

    it('accepts a well-formed persisted record', () => {
      expect(() => validateCreativeRunRecord(validRecord)).not.toThrow();
      const validated = validateCreativeRunRecord(validRecord);
      expect(validated.rootRunId).toBe('creative-1');
      expect(validated.providerReservation.id).toBe('reservation-1');
      expect(validated.interactionRevisionsApplied).toBe(0);
    });

    it('normalizes the original v1 readiness shape without claiming provider readiness', () => {
      const legacy = validateCreativeRunRecord({
        ...validRecord,
        providerReservation: { id: 'legacy-reservation', status: 'reserved' },
        readiness: { wave: 8, ready: true, source: 'CreativeRunCoordinator' },
      });

      expect(legacy.readiness).toEqual({
        wave: 8,
        ready: false,
        source: 'synthetic-no-spend',
        reason: 'No provider reservation was injected; this is a deterministic no-spend reservation.',
      });
    });

    it.each([
      ['persisted null', null],
      ['array', [validRecord]],
      ['string scalar', 'creative-run'],
      ['number scalar', 42],
      ['boolean scalar', true],
    ])('rejects %s at the top level', (_label, payload) => {
      expect(() => validateCreativeRunRecord(payload)).toThrow(/corrupted|invalid/);
    });

    it.each([
      ['missing schemaVersion', { ...validRecord, schemaVersion: undefined }],
      ['wrong schemaVersion', { ...validRecord, schemaVersion: 3 }],
      ['missing rootRunId', { ...validRecord, rootRunId: undefined }],
      ['empty requestKey', { ...validRecord, requestKey: '' }],
      ['numeric rootRunId', { ...validRecord, rootRunId: 123 }],
      ['invalid entryPoint', { ...validRecord, entryPoint: 'web-ui' }],
      ['invalid status', { ...validRecord, status: 'in-progress' }],
      ['provider as number', { ...validRecord, provider: 7 }],
      ['model as object', { ...validRecord, model: { id: 'm' } }],
      ['invalid reservation.status', { ...validRecord, providerReservation: { ...validRecord.providerReservation, status: 'cancelled' } }],
      ['invalid reservation.source', { ...validRecord, providerReservation: { ...validRecord.providerReservation, source: 'unknown' } }],
      ['reservation as string', { ...validRecord, providerReservation: 'reservation-1' }],
      ['reservation as null', { ...validRecord, providerReservation: null }],
      ['invalid readiness.wave', { ...validRecord, readiness: { ...validRecord.readiness, wave: 7 } }],
      ['readiness as boolean', { ...validRecord, readiness: true }],
      ['invalid readiness.source', { ...validRecord, readiness: { ...validRecord.readiness, source: 'magic' } }],
      ['non-boolean readiness.ready', { ...validRecord, readiness: { ...validRecord.readiness, ready: 'yes' } }],
      ['missing readiness.reason', { ...validRecord, readiness: { ...validRecord.readiness, reason: '' } }],
      ['createdAt as number', { ...validRecord, createdAt: 1700000000000 }],
      ['missing updatedAt', { ...validRecord, updatedAt: undefined }],
      ['invalid interaction revision count', { ...validRecord, interactionRevisionsApplied: 2 }],
    ])('rejects %s', (_label, payload) => {
      expect(() => validateCreativeRunRecord(payload)).toThrow(/invalid|corrupted/);
    });

    it('survives a malformed persisted object without reserving a new provider', async () => {
      const root = await mkdtemp(`${tmpdir()}/creative-run-schema-malformed-`);
      try {
        await persistRaw(root, 'malformed-1', { not: 'a creative run record' });
        const reserve = vi.fn(async () => ({ id: 'should-not-fire', status: 'reserved' as const }));
        const persistence = new FileCreativeRunPersistence(root);
        await expect(new CreativeRunCoordinator({
          persistence,
          reserveProvider: reserve,
        }).start({ ...request, requestKey: 'malformed-1' })).rejects.toThrow(/invalid|corrupted/);
        expect(reserve).not.toHaveBeenCalled();
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });

    it('survives a persisted null without reserving a new provider', async () => {
      const root = await mkdtemp(`${tmpdir()}/creative-run-schema-null-`);
      try {
        await persistRaw(root, 'null-1', 'null');
        const reserve = vi.fn(async () => ({ id: 'should-not-fire', status: 'reserved' as const }));
        const persistence = new FileCreativeRunPersistence(root);
        await expect(new CreativeRunCoordinator({
          persistence,
          reserveProvider: reserve,
        }).start({ ...request, requestKey: 'null-1' })).rejects.toThrow(/corrupted/);
        expect(reserve).not.toHaveBeenCalled();
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });

    it('survives a persisted array without reserving a new provider', async () => {
      const root = await mkdtemp(`${tmpdir()}/creative-run-schema-array-`);
      try {
        await persistRaw(root, 'array-1', [validRecord]);
        const reserve = vi.fn(async () => ({ id: 'should-not-fire', status: 'reserved' as const }));
        const persistence = new FileCreativeRunPersistence(root);
        await expect(new CreativeRunCoordinator({
          persistence,
          reserveProvider: reserve,
        }).start({ ...request, requestKey: 'array-1' })).rejects.toThrow(/corrupted/);
        expect(reserve).not.toHaveBeenCalled();
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });

    it('rejects a valid record stored under a different request key', async () => {
      const root = await mkdtemp(`${tmpdir()}/creative-run-key-mismatch-`);
      try {
        await persistRaw(root, 'requested-key', { ...validRecord, requestKey: 'different-key' });
        const reserve = vi.fn(async () => ({ id: 'should-not-fire', status: 'reserved' as const }));
        const persistence = new FileCreativeRunPersistence(root);
        await expect(new CreativeRunCoordinator({
          persistence,
          reserveProvider: reserve,
        }).start({ ...request, requestKey: 'requested-key' })).rejects.toThrow(/requestKey/);
        expect(reserve).not.toHaveBeenCalled();
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
  });
});
