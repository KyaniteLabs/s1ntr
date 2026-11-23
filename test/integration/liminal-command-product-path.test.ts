import { cp, mkdir, mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { createHash, createHmac } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  InMemoryLiminalArtifactStore,
  InMemoryLiminalOperationJournal,
  LiminalCommandService,
  createRotatingTestReceiptAuthority,
  createTestReceiptAuthority,
  type LiminalCommandEffects,
  type RenderedObservation,
} from '../../src/runtime-core/LiminalCommandService.js';
import { runLiminalCommandJourney } from '../../src/cli/LiminalCommandCli.js';
import { resolveReevaluationEvidenceRoot, validateEvaluatorTimeoutMs } from
  '../../src/cli/LiminalAuthoritativeCreate.js';
import {
  FileLiminalArtifactStore,
  FileLiminalOperationJournal,
} from '../../src/runtime-core/LiminalCommandFilePersistence.js';
import { rebuildOperationTrace } from '../../src/runtime-core/LiminalReceiptProjector.js';
import { LiminalOperationKernel } from '../../src/runtime-core/LiminalOperationKernel.js';
import { LiminalProductCommandPort } from '../../src/runtime-core/LiminalProductCommandPort.js';
import { UnsentTransportError, classifyEffectFailure, LiminalEffectBroker } from '../../src/runtime-core/LiminalEffectBroker.js';
import { encodeLiminalDurableValue, liminalDurablePayloadDigest }
  from '../../src/runtime-core/LiminalPayloadDigest.js';
import { assertProviderAttemptAllowed, assertRoleBoundProviderAttempt }
  from '../../src/llm/LLMClient.js';

function canonicalForTest(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalForTest).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map(key =>
    `${JSON.stringify(key)}:${canonicalForTest(record[key])}`).join(',')}}`;
}

const command = {
  schema: 'sinter.liminal-command' as const,
  schemaVersion: 1 as const,
  kind: 'generate-candidate' as const,
  idempotencyKey: 'w8-c0-fake-proof',
  prompt: 'A bounded temporal composition',
  domain: 'p5',
  layers: ['temporal-field'],
  canonicalMainSha: '7'.repeat(40),
  authorityPackageDigest: '8'.repeat(64),
  maxTransportAttempts: 2,
  evalMode: 'strict-browser' as const,
  safeMode: 'c0-no-empirical-teaching' as const,
  rendererIdentity: 'fake-renderer/v1',
  renderAuthorization: 'test-fake' as const,
  roles: {
    generator: 'fake/generator',
    evaluator: 'fake/evaluator',
    harness: 'fake/harness',
    studio: 'fake/studio',
  },
  generatorOverride: 'fake/generator-override',
};

function rendered(): RenderedObservation {
  return {
    status: 'rendered',
    rendererIdentity: 'fake-renderer/v1',
    earlyFrame: Buffer.from('early-frame'),
    lateFrame: Buffer.from('late-frame'),
    runtimeErrors: [],
    audio: { relevant: false, state: 'not-applicable' },
  };
}

describe('Liminal product command authority path', () => {
  it('binds measured audio into durable evidence and preserves it after restart', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'liminal-audio-evidence-'));
    try {
      const audio = { relevant: true, state: 'audible' as const,
        peakAmplitude: 0.5, rmsAmplitude: 0.395285 };
      const options = {
        artifacts: new FileLiminalArtifactStore(path.join(root, 'artifacts')),
        authority: createTestReceiptAuthority('audio-restart-proof-secret'),
        effects: {
          generate: async input => {
            await input.startTransport();
            return { source: 'audio-source', playable: '<html/>', provenance: 'audio-proof' };
          },
          render: async () => ({ ...rendered(), audio }),
          evaluate: async input => {
            await input.startTransport();
            expect(input.observation.audio).toEqual(audio);
            return { score: 0.8, degraded: false, identityValid: true,
              evaluatorIdentity: 'fake/evaluator', evidenceDigest: input.evidenceDigest };
          },
        },
      };
      const journey = { ...command, domain: 'tone', idempotencyKey: 'audio-restart' };
      const journalPath = path.join(root, 'journal.json');
      const first = await runLiminalCommandJourney(new LiminalCommandService({ ...options,
        journal: new FileLiminalOperationJournal(journalPath) }), journey);
      const resumed = await runLiminalCommandJourney(new LiminalCommandService({ ...options,
        journal: new FileLiminalOperationJournal(journalPath) }), journey);
      expect(first.evidence.audio).toEqual(audio);
      expect(first.evidence.evidenceDigest).toMatch(/^[a-f0-9]{64}$/);
      expect(resumed).toEqual(first);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('grants exact role-bound transport authority to governed research effects', async () => {
    const service = new LiminalCommandService({
      artifacts: new InMemoryLiminalArtifactStore(),
      journal: new InMemoryLiminalOperationJournal(),
      authority: createTestReceiptAuthority('research-effect-authority'),
      effects: { generate: vi.fn(), render: vi.fn(), evaluate: vi.fn() } as never,
    });
    for (const role of ['generator', 'evaluator'] as const) {
      await expect(service.runJudgmentEffect({
        idempotencyKey: `research-${role}`, binding: { role }, identity: `fake/${role}`,
        role, maxTransportAttempts: 1,
        effect: async () => { assertRoleBoundProviderAttempt(role, 'production'); return role; },
      })).resolves.toBe(role);
    }
  });

  it('blocks a nested provider retry inside one governed research effect', async () => {
    const service = new LiminalCommandService({
      artifacts: new InMemoryLiminalArtifactStore(),
      journal: new InMemoryLiminalOperationJournal(),
      authority: createTestReceiptAuthority('research-retry-authority'),
      effects: { generate: vi.fn(), render: vi.fn(), evaluate: vi.fn() } as never,
    });
    await expect(service.runJudgmentEffect({
      idempotencyKey: 'research-retry', binding: { role: 'generator' },
      identity: 'fake/generator', role: 'generator', maxTransportAttempts: 1,
      effect: async () => {
        assertProviderAttemptAllowed();
        try {
          assertProviderAttemptAllowed();
          return 'retry-allowed';
        } catch (error) {
          return error instanceof Error ? error.message : String(error);
        }
      },
    })).resolves.toBe('retry-allowed');
  });

  it('survives restart with source, playable, provenance, and journal intact', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'liminal-command-'));
    try {
      const journalPath = path.join(root, 'journal.json');
      const earlyFrame = Buffer.alloc(128 * 1024, 3);
      const lateFrame = Buffer.alloc(128 * 1024, 4);
      const options = {
        effects: {
          generate: async input => {
            await input.startTransport();
            return { source: 'durable-source', playable: '<canvas/>', provenance: 'durable-provenance' };
          },
          render: async () => ({ ...rendered(), earlyFrame, lateFrame }),
          evaluate: async input => {
            await input.startTransport();
            return { score: 0.8, degraded: false, identityValid: true,
              evaluatorIdentity: 'fake/evaluator', evidenceDigest: input.evidenceDigest };
          },
        },
        artifacts: new FileLiminalArtifactStore(path.join(root, 'artifacts')),
        journal: new FileLiminalOperationJournal(journalPath),
        authority: createTestReceiptAuthority('restart-proof-secret'),
      };
      const first = await runLiminalCommandJourney(new LiminalCommandService(options), command);
      const resumed = await runLiminalCommandJourney(new LiminalCommandService({
        ...options, journal: new FileLiminalOperationJournal(journalPath),
      }), command);

      expect(resumed).toEqual(first);
      const dirs = await readdir(path.join(root, 'artifacts'));
      expect(await readFile(path.join(root, 'artifacts', dirs[0]!, 'source.txt'), 'utf8'))
        .toBe('durable-source');
      expect(await readFile(path.join(root, 'artifacts', dirs[0]!, 'early-frame.png')))
        .toEqual(earlyFrame);
      expect(await readFile(path.join(root, 'artifacts', dirs[0]!, 'late-frame.png')))
        .toEqual(lateFrame);
      expect(JSON.parse(await readFile(path.join(root, 'artifacts', dirs[0]!,
        'rendered-evidence-manifest.json'), 'utf8'))).toEqual({
        earlyFrameDigest: first.evidence.earlyFrameDigest,
        lateFrameDigest: first.evidence.lateFrameDigest,
      });
      expect(JSON.parse(await readFile(journalPath, 'utf8')).events).toHaveLength(18);
      expect((await stat(journalPath)).size).toBeLessThan(32_768);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('persists exact artifacts before rendered evaluation with zero external IO', async () => {
    const order: string[] = [];
    const effects: LiminalCommandEffects = {
      generate: vi.fn(async input => {
        await input.startTransport();
        order.push(`generate:${input.identity}`);
        return { source: 'function setup(){}', playable: '<canvas></canvas>', provenance: 'fake:1' };
      }),
      render: vi.fn(async () => {
        order.push('render');
        return rendered();
      }),
      evaluate: vi.fn(async input => {
        await input.startTransport();
        order.push('evaluate');
        return {
          score: 0.82,
          degraded: false,
          identityValid: true,
          evaluatorIdentity: input.identity,
          evidenceDigest: input.evidenceDigest,
        };
      }),
    };
    const artifacts = new InMemoryLiminalArtifactStore(event => order.push(event));
    const journal = new InMemoryLiminalOperationJournal();
    const authority = createTestReceiptAuthority('fake-proof-secret');
    const service = new LiminalCommandService({ effects, artifacts, journal, authority });
    expect('sealAdmission' in service).toBe(false);
    expect(() => service.sealOwnerReviewAdmission({
      schema: 'sinter.product-transport-scope',
    })).toThrow('OWNER_REVIEW_ADMISSION_SCHEMA_FORBIDDEN');

    const result = await runLiminalCommandJourney(service, command);

    expect(result.evaluation).toMatchObject({ score: 0.82, admissionEligible: true });
    // #1638: the judge is told what the user asked for.
    expect(vi.mocked(effects.evaluate).mock.calls[0]![0].prompt).toBe(command.prompt);
    expect(result.receipt.authorityTier).toBe('test-proof');
    expect(authority.verify(result.receipt)).toBe(true);
    expect(order).toEqual([
      'generate:fake/generator-override',
      'persist:source',
      'persist:playable',
      'persist:provenance',
      'render',
      'evaluate',
    ]);
    expect(result.artifacts.sourceDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(result.artifacts.playableDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(result.evidence.earlyFrameDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(result.evidence.lateFrameDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(result.receipt.providerInputDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(result.receipt.providerInputDigest).toBe(createHash('sha256')
      .update(command.prompt).digest('hex'));
    expect(result.receipt.disabledTeachingReaders).toContain('quality-archive');
    expect(result.receipt.empiricalContextDigests).toEqual([]);
    expect(result.receipt.learningEligible).toBe(false);
    expect(result.receipt.operationTraceDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(result.roles).toEqual({
      generator: 'fake/generator-override',
      evaluator: 'fake/evaluator',
      harness: 'fake/harness',
      studio: 'fake/studio',
    });
    expect(result.attempts).toEqual({ consumed: 2, maximum: 2 });
    expect(journal.events().map(event => event.type)).toEqual([
      'command-accepted',
      'domain-authorized',
      'effect-reserved',
      'effect-started',
      'transport-started',
      'effect-result',
      'artifacts-persisted',
      'effect-reserved',
      'effect-started',
      'effect-result',
      'render-observed',
      'effect-reserved',
      'effect-started',
      'transport-started',
      'effect-result',
      'domain-decided',
      'evaluation-decided',
      'receipt-projected',
    ]);
  });

  it('fails before evaluation when persisted frame bytes do not match evidence digests', async () => {
    const artifacts = new InMemoryLiminalArtifactStore();
    vi.spyOn(artifacts, 'persistRenderedEvidence').mockResolvedValue({
      earlyFrameDigest: '0'.repeat(64), lateFrameDigest: '0'.repeat(64) });
    const evaluate = vi.fn();
    const service = new LiminalCommandService({ artifacts,
      journal: new InMemoryLiminalOperationJournal(),
      authority: createTestReceiptAuthority('frame-mismatch'), effects: {
        generate: async () => ({ source: 'x', playable: '<p>x</p>', provenance: 'fake' }),
        render: async () => rendered(), evaluate,
      } });
    await expect(service.execute({ ...command, maxTransportAttempts: 1 }))
      .rejects.toThrow('LIMINAL_RENDERED_EVIDENCE_DIGEST_MISMATCH');
    expect(evaluate).not.toHaveBeenCalled();
  });

  it('keeps a legacy numeric score non-admissible and out of learning', async () => {
    const effects: LiminalCommandEffects = {
      generate: async () => ({ source: 'x', playable: '<p>x</p>', provenance: 'fake' }),
      render: async () => ({ status: 'missing', rendererIdentity: 'none', runtimeErrors: [],
        audio: { relevant: false, state: 'not-applicable' } }),
      evaluate: async () => ({ score: 0.99, degraded: false, identityValid: true,
        evaluatorIdentity: 'fake/evaluator', evidenceDigest: null }),
    };
    const service = new LiminalCommandService({
      effects,
      artifacts: new InMemoryLiminalArtifactStore(),
      journal: new InMemoryLiminalOperationJournal(),
      authority: createTestReceiptAuthority('legacy-proof-secret'),
    });
    const result = await runLiminalCommandJourney(
      service,
      { ...command, evalMode: 'legacy', maxTransportAttempts: 1 },
    );

    expect(result.evaluation).toMatchObject({ score: 0.99, admissionEligible: false });
    expect(result.evaluation.rejectionReasons).toContain('rendered-evidence-required');
    expect(result.receipt.learningEligible).toBe(false);
  });

  it.each([
    ['missing evidence', { status: 'missing', rendererIdentity: 'fake', runtimeErrors: [],
      audio: { relevant: false, state: 'not-applicable' } }],
    ['failed evidence', { status: 'failed', rendererIdentity: 'fake', runtimeErrors: ['boom'],
      audio: { relevant: false, state: 'not-applicable' } }],
    ['degraded evidence', { ...rendered(), status: 'degraded' }],
  ] as const)('fails closed for %s', async (_name, observation) => {
    const effects: LiminalCommandEffects = {
      generate: async () => ({ source: 'x', playable: '<p>x</p>', provenance: 'fake' }),
      render: async () => observation,
      evaluate: async input => ({ score: 0.88, degraded: observation.status === 'degraded',
        identityValid: true, evaluatorIdentity: 'fake/evaluator', evidenceDigest: input.evidenceDigest }),
    };
    const service = new LiminalCommandService({
      effects,
      artifacts: new InMemoryLiminalArtifactStore(),
      journal: new InMemoryLiminalOperationJournal(),
      authority: createTestReceiptAuthority('closed-proof-secret'),
    });
    const result = await runLiminalCommandJourney(service, command);
    expect(result.evaluation.admissionEligible).toBe(false);
    expect(result.receipt.learningEligible).toBe(false);
  });

  it('fails closed when isolated Playwright omits containment evidence', async () => {
    const evaluate = vi.fn();
    const service = new LiminalCommandService({
      effects: {
        generate: async () => ({ source: 'x', playable: '<p>x</p>', provenance: 'fake' }),
        render: async () => rendered(),
        evaluate,
      },
      artifacts: new InMemoryLiminalArtifactStore(),
      journal: new InMemoryLiminalOperationJournal(),
      authority: createTestReceiptAuthority('containment-proof-secret'),
    });

    const result = await service.execute({
      ...command,
      idempotencyKey: 'isolated-containment-required',
      renderAuthorization: 'isolated-playwright',
    });

    expect(evaluate).not.toHaveBeenCalled();
    expect(result.evaluation.admissionEligible).toBe(false);
    expect(result.evaluation.rejectionReasons).toContain('render-containment-invalid');
  });

  it('rejects N+1 before invoking another transport', async () => {
    const generationTransport = vi.fn();
    const evaluationTransport = vi.fn();
    const generate = vi.fn(async input => {
      await input.startTransport();
      generationTransport();
      return { source: 'x', playable: '<p>x</p>', provenance: 'fake' };
    });
    const evaluate = vi.fn(async input => {
      await input.startTransport();
      evaluationTransport();
      return { score: 1, degraded: false, identityValid: true,
        evaluatorIdentity: 'fake/evaluator', evidenceDigest: '0'.repeat(64) };
    });
    const service = new LiminalCommandService({
      effects: {
        generate,
        render: async () => rendered(),
        evaluate,
      },
      artifacts: new InMemoryLiminalArtifactStore(),
      journal: new InMemoryLiminalOperationJournal(),
      authority: createTestReceiptAuthority('cap-proof-secret'),
    });

    await expect(runLiminalCommandJourney(service, { ...command, maxTransportAttempts: 1 }))
      .rejects.toThrow('TRANSPORT_ATTEMPT_CAP_EXHAUSTED');
    // After the failed attempt, the evaluation effect is 'failed'. reserveEffect
    // now allows retry for failed effects (#865), so the second journey re-enters
    // the evaluation effect — but the transport cap still prevents N+1 transport
    // invocation (evaluationTransport is never called).
    await expect(runLiminalCommandJourney(service, { ...command, maxTransportAttempts: 1 }))
      .rejects.toThrow('TRANSPORT_ATTEMPT_CAP_EXHAUSTED');
    expect(generate).toHaveBeenCalledOnce();
    // evaluate is entered twice (once per journey) but the second attempt fails
    // at startTransport before reaching evaluationTransport.
    expect(evaluate).toHaveBeenCalledTimes(2);
    expect(generationTransport).toHaveBeenCalledTimes(1);
    expect(evaluationTransport).not.toHaveBeenCalled();
  });

  it('retains a possible charge after a provider server error', async () => {
    let generateCalls = 0;
    const generate = vi.fn(async (input: { startTransport: () => Promise<number>;
      failTransport: (reason?: string) => Promise<void> }) => {
      await input.startTransport();
      generateCalls++;
      if (generateCalls === 1) {
        await input.failTransport('PROVIDER_HTTP_500');
        throw new Error('PROVIDER_HTTP_500');
      }
      return { source: 'recovered', playable: '<canvas/>', provenance: 'retry' };
    });
    const service = new LiminalCommandService({
      effects: {
        generate,
        render: async () => rendered(),
        evaluate: async (input: { startTransport: () => Promise<number> }) => {
          await input.startTransport();
          return { score: 0.8, degraded: false, identityValid: true,
            evaluatorIdentity: 'fake/evaluator', evidenceDigest: '0'.repeat(64) };
        },
      },
      artifacts: new InMemoryLiminalArtifactStore(),
      journal: new InMemoryLiminalOperationJournal(),
      authority: createTestReceiptAuthority('release-proof-secret'),
    });
    const releaseCommand = { ...command, idempotencyKey: 'release-proof',
      maxTransportAttempts: 2 };

    // An HTTP 500 does not establish that generation was unbilled.
    await expect(runLiminalCommandJourney(service, releaseCommand))
      .rejects.toThrow('PROVIDER_HTTP_500');

    await expect(runLiminalCommandJourney(service, releaseCommand)).rejects.toThrow('EFFECT_OUTCOME_UNRESOLVED');
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it('rejects evidence digest mismatch and handwritten receipt forgery', async () => {
    const authority = createTestReceiptAuthority('binding-proof-secret');
    const service = new LiminalCommandService({
      effects: {
        generate: async () => ({ source: 'x', playable: '<p>x</p>', provenance: 'fake' }),
        render: async () => rendered(),
        evaluate: async () => ({ score: 1, degraded: false, identityValid: true,
          evaluatorIdentity: 'fake/evaluator', evidenceDigest: '0'.repeat(64) }),
      },
      artifacts: new InMemoryLiminalArtifactStore(),
      journal: new InMemoryLiminalOperationJournal(),
      authority,
    });
    const result = await runLiminalCommandJourney(service, command);

    expect(result.evaluation.rejectionReasons).toContain('evidence-digest-mismatch');
    expect(result.receipt.learningEligible).toBe(false);
    expect(authority.verify({ ...result.receipt, learningEligible: true })).toBe(false);
    expect(result.receipt.authorityTier).not.toBe('production');
  });

  it('rejects forged or replayed effect capabilities', async () => {
    const journal = new InMemoryLiminalOperationJournal();
    const admission = await journal.begin('capability-proof', {
      operationId: 'operation:capability-proof', lineageId: 'lineage:capability-proof',
      commandDigest: 'a'.repeat(64), attemptsConsumed: 0,
    });
    const reservation = await journal.reserveEffect(
      admission.operationId, 'render', { renderer: 'fake' },
    );
    const reused = await journal.reserveEffect(
      admission.operationId, 'render', { renderer: 'fake' },
    );
    expect(reused).toEqual(reservation);
    expect((await journal.eventsForOperation(admission.operationId))
      .filter(event => event.type === 'effect-reserved')).toHaveLength(1);

    await expect(journal.startEffect({ ...reservation, capability: 'forged' }))
      .rejects.toThrow('INVALID_EFFECT_CAPABILITY');
    await journal.startEffect(reservation);
    await expect(journal.startEffect(reservation))
      .rejects.toThrow('EFFECT_RESERVATION_ALREADY_CLAIMED');
    await journal.finishEffect(reservation, 'ambiguous', { reason: 'process-loss' });
    await expect(journal.finishEffect(reservation, 'succeeded', {}))
      .rejects.toThrow('EFFECT_NOT_STARTED');
  });

  it('fails closed on a durable effect left ambiguous by process loss', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'liminal-effect-'));
    try {
      const file = path.join(root, 'journal.json');
      const first = new FileLiminalOperationJournal(file);
      const admission = await first.begin('durable-effect', {
        operationId: 'operation:durable-effect', lineageId: 'lineage:durable-effect',
        commandDigest: 'b'.repeat(64), attemptsConsumed: 0,
      });
      const reservation = await first.reserveEffect(
        admission.operationId, 'generation', { provider: 'fake' },
      );
      const reservedAfterRestart = await new FileLiminalOperationJournal(file).reserveEffect(
        admission.operationId, 'generation', { provider: 'fake' },
      );
      expect(reservedAfterRestart).toEqual(reservation);
      await first.startEffect(reservation);

      const resumed = new FileLiminalOperationJournal(file);
      await expect(resumed.startEffect(reservation))
        .rejects.toThrow('EFFECT_RESERVATION_ALREADY_CLAIMED');
      await resumed.finishEffect(reservation, 'ambiguous', { reason: 'restart-audit' });
      await expect(resumed.finishEffect(reservation, 'succeeded', {}))
        .rejects.toThrow('EFFECT_NOT_STARTED');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('does not start a second durable effect after restart observes a started effect', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'liminal-effect-restart-'));
    let release!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    const generate = vi.fn(async input => {
      await input.startTransport();
      await blocked;
      return { source: 'x', playable: '<canvas/>', provenance: 'fake' };
    });
    const options = { effects: { generate, render: async () => rendered(),
      evaluate: async input => ({ score: 0.8, degraded: false, identityValid: true,
        evaluatorIdentity: input.identity, evidenceDigest: input.evidenceDigest }) },
    artifacts: new FileLiminalArtifactStore(path.join(root, 'artifacts')),
    authority: createTestReceiptAuthority('restart-started-secret') };
    try {
      const file = path.join(root, 'journal.json');
      const first = new LiminalCommandService({ ...options,
        journal: new FileLiminalOperationJournal(file) }).execute(command);
      await vi.waitFor(() => expect(generate).toHaveBeenCalledOnce());
      const resumed = new LiminalCommandService({ ...options,
        journal: new FileLiminalOperationJournal(file) });
      await expect(resumed.execute(command)).rejects.toThrow('EFFECT_OUTCOME_UNRESOLVED');
      expect(generate).toHaveBeenCalledOnce();
      release();
      await first;
    } finally {
      release();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('allows retrying a provably unsent durable effect via the file-backed journal (#865)', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'liminal-effect-retry-'));
    try {
      const file = path.join(root, 'journal.json');
      const journal = new FileLiminalOperationJournal(file);
      const admission = await journal.begin('retry-effect', {
        operationId: 'operation:retry-effect', lineageId: 'lineage:retry-effect',
        commandDigest: 'd'.repeat(64), attemptsConsumed: 0,
      });
      // First attempt: reserve → start → fail
      const r1 = await journal.reserveEffect(admission.operationId, 'generation', { provider: 'fake' });
      await journal.startEffect(r1);
      await journal.finishEffect(r1, 'unsent', { error: 'boom' });
      // Retry: reserveEffect must succeed (not throw EFFECT_OUTCOME_UNRESOLVED)
      const r2 = await journal.reserveEffect(admission.operationId, 'generation', { provider: 'fake' });
      expect(r2.effectId).not.toBe(r1.effectId);
      // The new reservation is usable: start + complete works
      await journal.startEffect(r2);
      await journal.completeEffect(r2, { source: 'ok' });
      // completedEffect returns the fresh result
      const cached = await new FileLiminalOperationJournal(file)
        .completedEffect<{ source: string }>(admission.operationId, 'generation');
      expect(cached).toEqual({ source: 'ok' });
      // The audit log still has both the failed and the succeeded effect events
      const events = await journal.eventsForOperation(admission.operationId);
      const effectResults = events.filter(e => e.type === 'effect-result');
      expect(effectResults.length).toBeGreaterThanOrEqual(2);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('allows retrying a failed effect via the in-memory journal (#865)', async () => {
    const journal = new InMemoryLiminalOperationJournal();
    const admission = await journal.begin('retry-inmem', {
      operationId: 'operation:retry-inmem', lineageId: 'lineage:retry-inmem',
      commandDigest: 'e'.repeat(64), attemptsConsumed: 0,
    });
    const r1 = await journal.reserveEffect(admission.operationId, 'render', { renderer: 'fake' });
    await journal.startEffect(r1);
    await journal.finishEffect(r1, 'failed', { error: 'crash' });
    // Retry succeeds
    const r2 = await journal.reserveEffect(admission.operationId, 'render', { renderer: 'fake' });
    expect(r2.effectId).not.toBe(r1.effectId);
    await journal.startEffect(r2);
    await journal.completeEffect(r2, { html: '<div/>' });
    const cached = await journal.completedEffect<{ html: string }>(admission.operationId, 'render');
    expect(cached).toEqual({ html: '<div/>' });
  });

  it('classifies untyped outcomes as ambiguous (#1323)', () => {
    const timeout = Object.assign(new Error('The operation was aborted due to timeout'),
      { name: 'TimeoutError' });
    expect(classifyEffectFailure(timeout)).toBe('ambiguous');
    expect(classifyEffectFailure(Object.assign(new Error('x'), { name: 'AbortError' }))).toBe('ambiguous');
    expect(classifyEffectFailure(Object.assign(new Error('read'), { code: 'ECONNRESET' }))).toBe('ambiguous');
    expect(classifyEffectFailure(new Error('fetch failed', {
      cause: Object.assign(new Error('other side closed'), { code: 'UND_ERR_SOCKET' }) }))).toBe('ambiguous');
    expect(classifyEffectFailure('socket hang up')).toBe('ambiguous');
    expect(classifyEffectFailure(new Error('HTTP 400 invalid request'))).toBe('ambiguous');
    expect(classifyEffectFailure(new Error('LIMINAL_PRODUCT_STORE_LEASE_TIMEOUT'))).toBe('ambiguous');
    expect(classifyEffectFailure(undefined)).toBe('ambiguous');
    expect(classifyEffectFailure(null)).toBe('ambiguous');
  });

  it('records a timed-out effect as ambiguous and blocks a same-key rerun (#1323)', async () => {
    const journal = new InMemoryLiminalOperationJournal();
    const broker = new LiminalEffectBroker(journal);
    const admission = await journal.begin('ambiguous-timeout', {
      operationId: 'operation:ambiguous-timeout', lineageId: 'lineage:ambiguous-timeout',
      commandDigest: '2'.repeat(64), attemptsConsumed: 0,
    });
    const effect = vi.fn(async () => {
      throw Object.assign(new Error('request timed out'), { name: 'TimeoutError' });
    });
    await expect(broker.invoke({ operationId: admission.operationId, kind: 'generation',
      authority: {}, effect })).rejects.toThrow('request timed out');
    await expect(broker.invoke({ operationId: admission.operationId, kind: 'generation',
      authority: {}, effect })).rejects.toThrow('EFFECT_OUTCOME_UNRESOLVED');
    expect(effect).toHaveBeenCalledTimes(1);
  });

  it('keeps a definite broker failure retryable (#865 with #1323)', async () => {
    const journal = new InMemoryLiminalOperationJournal();
    const broker = new LiminalEffectBroker(journal);
    const admission = await journal.begin('definite-failure', {
      operationId: 'operation:definite-failure', lineageId: 'lineage:definite-failure',
      commandDigest: '3'.repeat(64), attemptsConsumed: 0,
    });
    let calls = 0;
    const effect = async () => {
      calls++;
      if (calls === 1) throw new UnsentTransportError('local validation refused dispatch');
      return { source: 'second' };
    };
    await expect(broker.invoke({ operationId: admission.operationId, kind: 'generation',
      authority: {}, effect })).rejects.toThrow('local validation refused dispatch');
    await expect(broker.invoke({ operationId: admission.operationId, kind: 'generation',
      authority: {}, effect })).resolves.toEqual({ source: 'second' });
    expect(calls).toBe(2);
  });

  it('does not refund a transport attempt after an ambiguous failure (#1323)', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'liminal-ambiguous-refund-'));
    try {
      for (const journal of [new InMemoryLiminalOperationJournal(),
        new FileLiminalOperationJournal(path.join(root, 'journal.json'))]) {
        const admission = await journal.begin('refund-check', {
          operationId: 'operation:refund-check', lineageId: 'lineage:refund-check',
          commandDigest: '4'.repeat(64), attemptsConsumed: 0,
        });
        const op = admission.operationId;
        await journal.reserveTransportAttempt(op, 2, {});
        await journal.failTransportAttempt(op, Object.assign(new Error('t'), { name: 'TimeoutError' }));
        expect(await journal.attemptsConsumed(op)).toBe(1);
        await journal.reserveTransportAttempt(op, 2, {});
        await journal.failTransportAttempt(op, new Error('HTTP 500'));
        expect(await journal.attemptsConsumed(op)).toBe(2);
        await journal.reserveTransportAttempt(op, 3, {});
        await journal.failTransportAttempt(op, new UnsentTransportError('local preflight'));
        expect(await journal.attemptsConsumed(op)).toBe(2);
        await expect(journal.failTransportAttempt('operation:missing', new Error('HTTP 500')))
          .rejects.toThrow('UNKNOWN_LIMINAL_OPERATION');
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('still rejects retry for ambiguous and started effects', async () => {
    const journal = new InMemoryLiminalOperationJournal();
    const admission = await journal.begin('no-retry-ambiguous', {
      operationId: 'operation:no-retry-ambiguous', lineageId: 'lineage:no-retry-ambiguous',
      commandDigest: 'f'.repeat(64), attemptsConsumed: 0,
    });
    // ambiguous → still blocks (fail-closed for uncertain outcomes)
    const r1 = await journal.reserveEffect(admission.operationId, 'generation', {});
    await journal.startEffect(r1);
    await journal.finishEffect(r1, 'ambiguous', { reason: 'process-loss' });
    await expect(journal.reserveEffect(admission.operationId, 'generation', {}))
      .rejects.toThrow('EFFECT_OUTCOME_UNRESOLVED');

    // started → still blocks (in-progress, no double-run)
    const admission2 = await journal.begin('no-retry-started', {
      operationId: 'operation:no-retry-started', lineageId: 'lineage:no-retry-started',
      commandDigest: '1'.repeat(64), attemptsConsumed: 0,
    });
    const r2 = await journal.reserveEffect(admission2.operationId, 'render', {});
    await journal.startEffect(r2);
    await expect(journal.reserveEffect(admission2.operationId, 'render', {}))
      .rejects.toThrow('EFFECT_OUTCOME_UNRESOLVED');
  });

  it('atomically replays a completed effect result after journal restart', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'liminal-effect-result-'));
    try {
      const file = path.join(root, 'journal.json');
      const firstJournal = new FileLiminalOperationJournal(file);
      await firstJournal.begin('effect-result', { operationId: 'operation:effect-result',
        lineageId: 'lineage:effect-result', commandDigest: 'c'.repeat(64),
        attemptsConsumed: 0 });
      // Exercise the 64 KiB external-blob boundary and one byte above it.
      const earlyFrame = Buffer.alloc(64 * 1024, 1);
      const lateFrame = Buffer.alloc(64 * 1024 + 1, 2);
      const special = JSON.parse('{"__proto__":{"polluted":"no"}}') as object;
      const effect = vi.fn(async () => ({ ...special, verdict: 'keeper', earlyFrame, lateFrame,
        frameDigests: [createHash('sha256').update(earlyFrame).digest('hex'),
          createHash('sha256').update(lateFrame).digest('hex')] }));
      const first = await new LiminalEffectBroker(firstJournal).invoke({
        operationId: 'operation:effect-result', kind: 'evaluation', authority: {}, effect });
      await firstJournal.append('operation:later', 'domain-authorized', { domain: 'svg' });
      const stored = JSON.parse(await readFile(file, 'utf8'));
      const frameRef = stored.effects[Object.keys(stored.effects)[0]].result.earlyFrame;
      expect(stored.schemaVersion).toBe(4);
      expect(frameRef.$type).toBe('sinter.buffer-ref.v1');
      expect((await stat(file)).size).toBeLessThan(16_384);
      expect(await readFile(path.join(`${file}.blobs`, frameRef.sha256))).toEqual(earlyFrame);
      const replay = await new LiminalEffectBroker(
        new FileLiminalOperationJournal(file)).invoke({ operationId: 'operation:effect-result',
        kind: 'evaluation', authority: {}, effect });
      expect(replay).toEqual(first);
      expect(Buffer.isBuffer(replay.earlyFrame)).toBe(true);
      expect(Buffer.isBuffer(replay.lateFrame)).toBe(true);
      expect(Object.hasOwn(replay, '__proto__')).toBe(true);
      expect(({} as { polluted?: string }).polluted).toBeUndefined();
      expect(replay.frameDigests).toEqual([
        createHash('sha256').update(replay.earlyFrame).digest('hex'),
        createHash('sha256').update(replay.lateFrame).digest('hex'),
      ]);
      expect(effect).toHaveBeenCalledOnce();
      const backup = await mkdtemp(path.join(os.tmpdir(), 'liminal-journal-backup-'));
      try {
        const restoredFile = path.join(backup, 'journal.json');
        await cp(file, restoredFile);
        await expect(new FileLiminalOperationJournal(restoredFile)
          .completedEffect('operation:effect-result', 'evaluation'))
          .rejects.toMatchObject({ code: 'ENOENT' });
        await cp(`${file}.blobs`, `${restoredFile}.blobs`, { recursive: true });
        expect(await new FileLiminalOperationJournal(restoredFile)
          .completedEffect('operation:effect-result', 'evaluation')).toEqual(first);
      } finally {
        await rm(backup, { recursive: true, force: true });
      }
      await writeFile(path.join(`${file}.blobs`, frameRef.sha256), Buffer.from('corrupt'));
      await expect(new FileLiminalOperationJournal(file)
        .completedEffect('operation:effect-result', 'evaluation'))
        .rejects.toThrow('JOURNAL_BLOB_DIGEST_MISMATCH');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rebuilds the signed trace deterministically and rejects incomplete history', async () => {
    const journal = new InMemoryLiminalOperationJournal();
    const service = new LiminalCommandService({
      effects: {
        generate: async () => ({ source: 'x', playable: '<canvas/>', provenance: 'fake' }),
        render: async () => rendered(),
        evaluate: async input => ({ score: 0.8, degraded: false, identityValid: true,
          evaluatorIdentity: input.identity, evidenceDigest: input.evidenceDigest }),
      },
      artifacts: new InMemoryLiminalArtifactStore(), journal,
      authority: createTestReceiptAuthority('trace-proof-secret'),
    });
    const result = await service.execute(command);
    const events = await journal.eventsForOperation(result.operationId);
    const preProjection = events.filter(event => event.type !== 'receipt-projected');

    expect(rebuildOperationTrace(preProjection)).toBe(result.receipt.operationTraceDigest);
    expect(() => rebuildOperationTrace(preProjection.filter(
      event => event.type !== 'effect-result',
    ))).toThrow('OPERATION_TRACE_INCOMPLETE');
  });

  it('supports signer rotation and fails closed after key revocation', async () => {
    const oldSecret = 'old-signing-secret';
    const newSecret = 'new-signing-secret';
    const oldAuthority = createTestReceiptAuthority(oldSecret);
    const receipt = oldAuthority.project({
      operationId: 'operation:rotation', lineageId: 'lineage:rotation',
      commandDigest: '1'.repeat(64), providerInputDigest: '2'.repeat(64),
      artifactDigest: '3'.repeat(64), evidenceDigest: '4'.repeat(64),
      operationTraceDigest: '5'.repeat(64), disabledTeachingReaders: [],
      empiricalContextDigests: [], learningEligible: false,
    });
    const rotated = createRotatingTestReceiptAuthority({
      currentSecret: newSecret, verificationSecrets: [oldSecret, newSecret],
    });
    const revoked = createRotatingTestReceiptAuthority({
      currentSecret: newSecret, verificationSecrets: [oldSecret, newSecret],
      revokedKeyDigests: [receipt.authorityKeyDigest],
    });

    expect(rotated.verify(receipt)).toBe(true);
    expect(revoked.verify(receipt)).toBe(false);
  });

  it('serializes concurrent file-journal writers without duplicate effects', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'liminal-lease-'));
    try {
      const file = path.join(root, 'journal.json');
      const first = new FileLiminalOperationJournal(file);
      const second = new FileLiminalOperationJournal(file);
      const proposed = { operationId: 'operation:lease', lineageId: 'lineage:lease',
        commandDigest: 'c'.repeat(64), attemptsConsumed: 0 };
      const settled = await Promise.allSettled([
        first.begin('lease-proof', proposed), second.begin('lease-proof', proposed),
      ]);
      expect(settled.filter(result => result.status === 'fulfilled')).toHaveLength(2);

      const inode = (await stat(file)).ino;
      await expect(second.begin('lease-proof', proposed)).resolves.toMatchObject(proposed);
      expect((await stat(file)).ino).toBe(inode);
      expect((await second.eventsForOperation(proposed.operationId))).toHaveLength(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('still upgrades a legacy journal on an idempotent replay', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'liminal-journal-migration-'));
    try {
      const file = path.join(root, 'journal.json');
      const proposed = { operationId: 'operation:legacy', lineageId: 'lineage:legacy',
        commandDigest: 'a'.repeat(64), attemptsConsumed: 0 };
      await writeFile(file, JSON.stringify({ schema: 'sinter.liminal-operation-journal',
        schemaVersion: 1, events: [], results: {}, operations: { legacy: proposed } }));
      await new FileLiminalOperationJournal(file).begin('legacy', proposed);
      expect(JSON.parse(await readFile(file, 'utf8')).schemaVersion).toBe(4);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('treats a succeeded effect with a tampered result as an integrity fault (#1323)', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'liminal-journal-tamper-'));
    try {
      const file = path.join(root, 'journal.json');
      const proposed = { operationId: 'operation:tamper', lineageId: 'lineage:tamper',
        commandDigest: 'd'.repeat(64), attemptsConsumed: 0 };
      const reservation = { operationId: proposed.operationId, kind: 'render',
        effectId: 'effect:tamper', capability: 'c'.repeat(64), fence: 1 };
      const original = { html: '<p>original</p>' };
      await writeFile(file, JSON.stringify({ schema: 'sinter.liminal-operation-journal',
        schemaVersion: 3, events: [], results: {}, operations: { tamper: proposed },
        effects: { [reservation.effectId]: { reservation, state: 'succeeded',
          result: encodeLiminalDurableValue({ html: '<p>tampered</p>' }),
          resultDigest: liminalDurablePayloadDigest(original) } }, nextFence: 2 }));
      const journal = new FileLiminalOperationJournal(file);
      await expect(journal.completedEffect(proposed.operationId, 'render'))
        .rejects.toThrow('EFFECT_RESULT_DIGEST_MISMATCH');
      const effect = vi.fn(async () => original);
      await expect(new LiminalEffectBroker(journal).invoke({ operationId: proposed.operationId,
        kind: 'render', authority: {}, effect })).rejects.toThrow('EFFECT_RESULT_DIGEST_MISMATCH');
      expect(effect).not.toHaveBeenCalled();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('keeps version-3 replay read-only until a new effect needs version 4', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'liminal-journal-v3-'));
    try {
      const file = path.join(root, 'journal.json');
      const proposed = { operationId: 'operation:v3', lineageId: 'lineage:v3',
        commandDigest: 'b'.repeat(64), attemptsConsumed: 0 };
      const reservation = { operationId: proposed.operationId, kind: 'render',
        effectId: 'effect:v3', capability: 'c'.repeat(64), fence: 1 };
      const result = { earlyFrame: Buffer.from('legacy-inline-frame') };
      await writeFile(file, JSON.stringify({ schema: 'sinter.liminal-operation-journal',
        schemaVersion: 3, events: [], results: {}, operations: { legacy: proposed },
        effects: { [reservation.effectId]: { reservation, state: 'succeeded',
          result: encodeLiminalDurableValue(result),
          resultDigest: liminalDurablePayloadDigest(result) } }, nextFence: 2 }));
      const journal = new FileLiminalOperationJournal(file);
      expect(await journal.completedEffect(proposed.operationId, 'render')).toEqual(result);
      const inode = (await stat(file)).ino;
      await journal.begin('legacy', proposed);
      expect((await stat(file)).ino).toBe(inode);
      expect(JSON.parse(await readFile(file, 'utf8')).schemaVersion).toBe(3);
      const next = await journal.reserveEffect(proposed.operationId, 'generation', {});
      await journal.startEffect(next);
      await journal.completeEffect(next, { source: Buffer.alloc(128 * 1024, 5) });
      expect(JSON.parse(await readFile(file, 'utf8')).schemaVersion).toBe(4);
      expect(await new FileLiminalOperationJournal(file)
        .completedEffect(proposed.operationId, 'render')).toEqual(result);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('compacts a quiescent version-3 journal with an exact backup and replay', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'liminal-journal-compact-'));
    try {
      const file = path.join(root, 'journal.json');
      const backup = `${file}.backup`;
      const operationId = 'operation:compact';
      const reservation = { operationId, kind: 'render', effectId: 'effect:compact',
        capability: 'f'.repeat(64), fence: 7 };
      const result = { earlyFrame: Buffer.alloc(128 * 1024, 9),
        lateFrame: Buffer.alloc(128 * 1024, 10) };
      const legacy = JSON.stringify({ schema: 'sinter.liminal-operation-journal',
        schemaVersion: 3, events: [{ operationId, ordinal: 1, type: 'effect-result',
          payloadDigest: 'a'.repeat(64) }], results: {}, operations: {},
        effects: { [reservation.effectId]: { reservation, state: 'succeeded',
          result: encodeLiminalDurableValue(result),
          resultDigest: liminalDurablePayloadDigest(result) } }, nextFence: 8 });
      await writeFile(file, legacy);
      const journal = new FileLiminalOperationJournal(file);
      await expect(journal.compactLegacy(backup)).resolves.toBe(true);
      expect(await readFile(backup, 'utf8')).toBe(legacy);
      expect((await stat(file)).size).toBeLessThan(8_192);
      expect(await journal.completedEffect(operationId, 'render')).toEqual(result);
      expect((await journal.eventsForOperation(operationId))[0]?.ordinal).toBe(1);
      expect(JSON.parse(await readFile(file, 'utf8')).nextFence).toBe(8);
      const inode = (await stat(file)).ino;
      await expect(journal.compactLegacy(`${file}.second-backup`)).resolves.toBe(false);
      expect((await stat(file)).ino).toBe(inode);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('leaves a legacy journal unchanged if an effect digest is invalid', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'liminal-journal-compact-bad-'));
    try {
      const file = path.join(root, 'journal.json');
      const reservation = { operationId: 'operation:bad', kind: 'render',
        effectId: 'effect:bad', capability: 'f'.repeat(64), fence: 1 };
      const legacy = JSON.stringify({ schema: 'sinter.liminal-operation-journal',
        schemaVersion: 3, events: [], results: {}, operations: {},
        effects: { [reservation.effectId]: { reservation, state: 'succeeded',
          result: encodeLiminalDurableValue({ frame: Buffer.alloc(128 * 1024, 1) }),
          resultDigest: '0'.repeat(64) } }, nextFence: 2 });
      await writeFile(file, legacy);
      await expect(new FileLiminalOperationJournal(file).compactLegacy(`${file}.backup`))
        .rejects.toThrow('JOURNAL_EFFECT_RESULT_DIGEST_MISMATCH');
      expect(await readFile(file, 'utf8')).toBe(legacy);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('compacts mixed version-4 inline frames without rewriting existing sidecars', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'liminal-journal-mixed-'));
    try {
      const file = path.join(root, 'journal.json');
      const operationId = 'operation:mixed';
      const journal = new FileLiminalOperationJournal(file);
      await journal.begin('mixed', { operationId, lineageId: 'lineage:mixed',
        commandDigest: 'd'.repeat(64), attemptsConsumed: 0 });
      const current = await journal.reserveEffect(operationId, 'render', {});
      await journal.startEffect(current);
      const currentResult = { frame: Buffer.alloc(128 * 1024, 4) };
      await journal.completeEffect(current, currentResult);
      const stored = JSON.parse(await readFile(file, 'utf8'));
      const inline = { frame: Buffer.alloc(128 * 1024, 5) };
      stored.effects['effect:inline'] = { reservation: { operationId, kind: 'evaluation',
        effectId: 'effect:inline', capability: 'f'.repeat(64), fence: stored.nextFence },
        state: 'succeeded', result: encodeLiminalDurableValue(inline),
        resultDigest: liminalDurablePayloadDigest(inline) };
      stored.nextFence += 1;
      const original = JSON.stringify(stored);
      await writeFile(file, original);
      const blob = path.join(`${file}.blobs`, (await readdir(`${file}.blobs`))[0]!);
      const blobInode = (await stat(blob)).ino;
      const backup = `${file}.backup`;
      await writeFile(backup, 'occupied');
      await expect(journal.compactLegacy(backup)).rejects.toMatchObject({ code: 'EEXIST' });
      expect(await readFile(file, 'utf8')).toBe(original);
      await rm(backup);
      await expect(journal.compactLegacy(backup)).resolves.toBe(true);
      expect(await readFile(backup, 'utf8')).toBe(original);
      expect((await stat(blob)).ino).toBe(blobInode);
      expect((await stat(file)).size).toBeLessThan(8_192);
      const replay = new FileLiminalOperationJournal(file);
      expect(await replay.completedEffect(operationId, 'render')).toEqual(currentResult);
      expect(await replay.completedEffect(operationId, 'evaluation')).toEqual(inline);
      const compacted = JSON.parse(await readFile(file, 'utf8'));
      expect(compacted.events).toEqual(stored.events);
      expect(compacted.nextFence).toBe(stored.nextFence);
      const inode = (await stat(file)).ino;
      await expect(journal.compactLegacy(`${file}.second-backup`)).resolves.toBe(false);
      expect((await stat(file)).ino).toBe(inode);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects a mixed version-4 journal with an invalid effect digest', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'liminal-journal-mixed-bad-'));
    try {
      const file = path.join(root, 'journal.json');
      const reservation = { operationId: 'operation:mixed-bad', kind: 'render',
        effectId: 'effect:mixed-bad', capability: 'f'.repeat(64), fence: 1 };
      const original = JSON.stringify({ schema: 'sinter.liminal-operation-journal',
        schemaVersion: 4, events: [], results: {}, operations: {},
        effects: { [reservation.effectId]: { reservation, state: 'succeeded',
          result: encodeLiminalDurableValue({ frame: Buffer.alloc(128 * 1024, 7) }),
          resultDigest: '0'.repeat(64) } }, nextFence: 2 });
      await writeFile(file, original);
      await expect(new FileLiminalOperationJournal(file).compactLegacy(`${file}.backup`))
        .rejects.toThrow('JOURNAL_EFFECT_RESULT_DIGEST_MISMATCH');
      expect(await readFile(file, 'utf8')).toBe(original);
      expect(await readFile(`${file}.backup`, 'utf8')).toBe(original);
      await expect(readdir(`${file}.blobs`)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('waits for the journal lease before compacting mixed version-4 frames', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'liminal-journal-mixed-lease-'));
    try {
      const file = path.join(root, 'journal.json');
      const reservation = { operationId: 'operation:mixed-lease', kind: 'render',
        effectId: 'effect:mixed-lease', capability: 'f'.repeat(64), fence: 1 };
      const frame = { frame: Buffer.alloc(128 * 1024, 8) };
      const original = JSON.stringify({ schema: 'sinter.liminal-operation-journal',
        schemaVersion: 4, events: [], results: {}, operations: {},
        effects: { [reservation.effectId]: { reservation, state: 'succeeded',
          result: encodeLiminalDurableValue(frame),
          resultDigest: liminalDurablePayloadDigest(frame) } }, nextFence: 2 });
      await writeFile(file, original);
      await mkdir(`${file}.lock`);
      const backup = `${file}.backup`;
      const pending = new FileLiminalOperationJournal(file).compactLegacy(backup);
      await new Promise(resolve => setTimeout(resolve, 80));
      expect(await readFile(file, 'utf8')).toBe(original);
      await expect(stat(backup)).rejects.toMatchObject({ code: 'ENOENT' });
      await rm(`${file}.lock`, { recursive: true });
      await expect(pending).resolves.toBe(true);
      expect(await readFile(backup, 'utf8')).toBe(original);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('does not commit an effect result when its frame blob cannot be stored', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'liminal-journal-blob-fail-'));
    try {
      const file = path.join(root, 'journal.json');
      const journal = new FileLiminalOperationJournal(file);
      const operationId = 'operation:blob-fail';
      await journal.begin('blob-fail', { operationId, lineageId: 'lineage:blob-fail',
        commandDigest: 'd'.repeat(64), attemptsConsumed: 0 });
      const reservation = await journal.reserveEffect(operationId, 'render', {});
      await journal.startEffect(reservation);
      await writeFile(`${file}.blobs`, 'not a directory');
      const result = { earlyFrame: Buffer.alloc(128 * 1024, 7) };
      await expect(journal.completeEffect(reservation, result)).rejects.toThrow();
      expect((await journal.eventsForOperation(operationId))
        .filter(event => event.type === 'effect-result')).toHaveLength(0);
      await rm(`${file}.blobs`);
      await journal.completeEffect(reservation, result);
      expect(await new FileLiminalOperationJournal(file)
        .completedEffect(operationId, 'render')).toEqual(result);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('does not repeat an effect whose result could not be stored', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'liminal-broker-blob-fail-'));
    try {
      const file = path.join(root, 'journal.json');
      const operationId = 'operation:broker-blob-fail';
      await new FileLiminalOperationJournal(file).begin('broker-blob-fail', {
        operationId, lineageId: 'lineage:broker-blob-fail',
        commandDigest: 'e'.repeat(64), attemptsConsumed: 0 });
      await writeFile(`${file}.blobs`, 'not a directory');
      const effect = vi.fn(async () => ({ earlyFrame: Buffer.alloc(128 * 1024, 8) }));
      const invoke = () => new LiminalEffectBroker(new FileLiminalOperationJournal(file))
        .invoke({ operationId, kind: 'render', authority: {}, effect });
      await expect(invoke()).rejects.toThrow();
      await rm(`${file}.blobs`);
      await expect(invoke()).rejects.toThrow('EFFECT_OUTCOME_UNRESOLVED');
      expect(effect).toHaveBeenCalledOnce();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('reclaims a stale file-journal lease after a crashed writer', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'liminal-stale-lease-'));
    try {
      const file = path.join(root, 'journal.json');
      const lock = `${file}.lock`;
      await mkdir(lock);
      const stale = new Date(Date.now() - 120_000);
      await utimes(lock, stale, stale);
      const journal = new FileLiminalOperationJournal(file);
      const proposed = { operationId: 'operation:stale', lineageId: 'lineage:stale',
        commandDigest: 'd'.repeat(64), attemptsConsumed: 0 };
      await expect(journal.begin('stale-proof', proposed)).resolves.toMatchObject(proposed);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('mints lineage only from a verified parent capability', async () => {
    const journal = new InMemoryLiminalOperationJournal();
    const authority = createTestReceiptAuthority('parent-proof-secret');
    const kernel = new LiminalOperationKernel(journal, authority, () => 'fixed-id');
    const parent = authority.project({ operationId: 'operation:parent',
      lineageId: 'lineage:parent', commandDigest: '1'.repeat(64),
      providerInputDigest: '2'.repeat(64), artifactDigest: '3'.repeat(64),
      evidenceDigest: '4'.repeat(64), operationTraceDigest: '5'.repeat(64),
      disabledTeachingReaders: [], empiricalContextDigests: [], learningEligible: false });

    await expect(kernel.beginChild('forged-child', '6'.repeat(64), {
      ...parent, lineageId: 'lineage:attacker',
    })).rejects.toThrow('PARENT_CAPABILITY_INVALID');
    await expect(kernel.beginChild('valid-child', '6'.repeat(64), parent))
      .resolves.toMatchObject({ lineageId: 'lineage:parent' });
    await journal.linkProjection('operation:fixed-id', 'dream', '7'.repeat(64));
    expect((await journal.eventsForOperation('operation:fixed-id')).at(-1)?.type)
      .toBe('domain-projection-linked');
  });

  it('re-evaluates exact persisted frames without generating another candidate', async () => {
    const generate = vi.fn(async input => {
      await input.startTransport();
      return { source: 'x', playable: '<canvas/>', provenance: 'fake' };
    });
    let evaluationCount = 0;
    const receiptSecret = 'reevaluation-proof-secret';
    const authority = createTestReceiptAuthority(receiptSecret);
    const journal = new InMemoryLiminalOperationJournal();
    const service = new LiminalCommandService({
      effects: {
        generate,
        render: async () => ({ ...rendered(), earlyFrameSize: { width: 800, height: 600 },
          lateFrameSize: { width: 800, height: 600 } }),
        evaluate: async input => {
          await input.startTransport();
          evaluationCount += 1;
          return { score: evaluationCount === 1 ? 0 : 0.81,
            degraded: evaluationCount === 1, identityValid: true,
            evaluatorIdentity: input.identity, evidenceDigest: input.evidenceDigest };
        },
      },
      artifacts: new InMemoryLiminalArtifactStore(),
      journal,
      authority,
    });
    const first = await service.execute(command);
    const { operationTraceDigest: _trace, signature: _signature,
      ...legacyUnsigned } = first.receipt;
    const legacyReceipt = { ...legacyUnsigned,
      signature: createHmac('sha256', receiptSecret)
        .update(canonicalForTest(legacyUnsigned)).digest('hex') };
    const historicalSource = { ...first, domain: undefined,
      evaluation: { ...first.evaluation, score: 1, degraded: false,
        admissionEligible: true }, receipt: legacyReceipt } as never;
    const second = await service.reevaluate(command, historicalSource, {
      ...rendered(), earlyFrameSize: { width: 800, height: 600 },
      lateFrameSize: { width: 800, height: 600 },
    }, { idempotencyKey: 'reevaluate-exact-c0', maxTransportAttempts: 1,
      actionAuthorityDigest: '9'.repeat(64) });

    expect(generate).toHaveBeenCalledTimes(1);
    expect(evaluationCount).toBe(2);
    expect(second.lineageId).toBe(first.lineageId);
    expect(second.artifacts).toEqual(first.artifacts);
    expect(second.attempts).toEqual({ consumed: 1, maximum: 1 });
    expect(second.evaluation.admissionEligible).toBe(true);
    expect(second.receipt.learningEligible).toBe(false);
    expect(second.receipt.actionAuthorityDigest).toBe('9'.repeat(64));
    await expect(service.reevaluate(command, { ...historicalSource,
      roles: { ...first.roles, evaluator: 'attacker/model' } }, rendered(), {
      idempotencyKey: 'reevaluate-forged-role', maxTransportAttempts: 1,
      actionAuthorityDigest: '8'.repeat(64),
    })).rejects.toThrow('REEVALUATION_PARENT_AUTHORITY_INVALID');
    const mismatchedEvidence = { ...first, receipt: authority.project({
      ...Object.fromEntries(Object.entries(first.receipt).filter(
        ([key]) => !['schema', 'schemaVersion', 'authorityTier', 'authorityKeyDigest',
          'signature'].includes(key))), artifactDigest: 'f'.repeat(64),
    } as never) };
    await expect(service.reevaluate(command, first, rendered(), {
      idempotencyKey: 'reevaluate-mismatched-artifact', maxTransportAttempts: 1,
      actionAuthorityDigest: '7'.repeat(64),
    }, mismatchedEvidence)).rejects.toThrow('REEVALUATION_PARENT_AUTHORITY_INVALID');
    await expect(service.restoreVerifiedArtifact(first, second)).resolves.toBeUndefined();
    await expect(service.readVerifiedArtifact(second)).resolves.toEqual({
      source: 'x', playable: '<canvas/>', provenance: 'fake',
    });
    await expect(service.readVerifiedArtifact({ ...second,
      artifacts: { ...second.artifacts, sourceDigest: 'f'.repeat(64) },
    })).rejects.toThrow('LIMINAL_ARTIFACT_RECEIPT_INVALID');
    const exactObservation = { ...rendered(), earlyFrameSize: { width: 800, height: 600 },
      lateFrameSize: { width: 800, height: 600 } };
    await expect(service.restoreVerifiedRenderedEvidence(second, exactObservation))
      .resolves.toBeUndefined();
    const serializedSecond = JSON.parse(JSON.stringify(second));
    await expect(service.restoreVerifiedRenderedEvidence(serializedSecond, exactObservation))
      .resolves.toBeUndefined();
    await expect(service.readVerifiedRenderedEvidence(second)).resolves.toBeUndefined();
    await expect(service.restoreVerifiedRenderedEvidence(second, {
      ...exactObservation, runtimeErrors: ['forged runtime state'],
    })).rejects.toThrow('LIMINAL_RENDERED_EVIDENCE_DIGEST_MISMATCH');
    await expect(service.readVerifiedResult('reevaluate-exact-c0')).resolves.toBe(second);
    vi.spyOn(journal, 'findByIdempotencyKey').mockResolvedValue({ ...second,
      evaluation: { ...second.evaluation, score: 1, degraded: false,
        admissionEligible: true } });
    await expect(service.readVerifiedResult('reevaluate-exact-c0'))
      .rejects.toThrow('LIMINAL_RESULT_TRACE_INVALID');
    await expect(service.reevaluate(command, first, rendered(), {
      idempotencyKey: 'reevaluate-forged-authority', maxTransportAttempts: 1,
      actionAuthorityDigest: 'not-a-digest',
    })).rejects.toThrow('REEVALUATION_ACTION_AUTHORITY_INVALID');
  });

  it('re-renders a verified artifact and judges the fresh evidence once (#1645)', async () => {
    const generate = vi.fn(async input => {
      await input.startTransport();
      return { source: 'x', playable: '<canvas id="rerender"/>', provenance: 'fake' };
    });
    // the first render is the parent's evidence; the second is a renderer fix's fresh frame
    const render = vi.fn(async (_input: { playable: string; domain: string }) => ({
      ...rendered(), lateFrame: Buffer.from(render.mock.calls.length === 1
        ? 'late-frame' : 'late-frame-after-arc-fix') }));
    const evaluate = vi.fn(async (input: { startTransport: () => Promise<unknown>;
      identity: string; evidenceDigest: string | null; prompt?: string }) => {
      await input.startTransport();
      return { score: evaluate.mock.calls.length === 1 ? 0.2 : 0.83, degraded: false,
        identityValid: true, evaluatorIdentity: input.identity,
        evidenceDigest: input.evidenceDigest };
    });
    const authority = createTestReceiptAuthority('rerender-proof-secret');
    const service = new LiminalCommandService({
      effects: { generate, render, evaluate } as never,
      artifacts: new InMemoryLiminalArtifactStore(),
      journal: new InMemoryLiminalOperationJournal(),
      authority,
    });
    const parent = await service.execute(command);
    const spec = { idempotencyKey: 'rerender-c0', maxTransportAttempts: 1 as const,
      actionAuthorityDigest: '9'.repeat(64) };

    const result = await service.rerenderAndReevaluate(command, parent, spec);

    expect(generate).toHaveBeenCalledTimes(1);
    expect(render).toHaveBeenCalledTimes(2);
    expect(render.mock.calls[1][0]).toEqual({ playable: '<canvas id="rerender"/>',
      domain: command.domain });
    expect(evaluate).toHaveBeenCalledTimes(2);
    expect(evaluate.mock.calls[1][0]).toMatchObject({ prompt: command.prompt,
      identity: command.roles.evaluator, evidenceDigest: result.evidence.evidenceDigest });
    expect(result.evidence.evidenceDigest).not.toBe(parent.evidence.evidenceDigest);
    expect(result.receipt.evidenceDigest).toBe(result.evidence.evidenceDigest);
    expect(result.evaluation.score).toBe(0.83);
    expect(result.lineageId).toBe(parent.lineageId);
    expect(result.artifacts).toEqual(parent.artifacts);
    expect(result.receipt.artifactDigest).toBe(parent.receipt.artifactDigest);
    expect(result.receipt.learningEligible).toBe(false);
    expect(result.receipt.actionAuthorityDigest).toBe('9'.repeat(64));
    expect(result.attempts).toEqual({ consumed: 1, maximum: 1 });
    await expect(service.readVerifiedResult('rerender-c0', command)).resolves.toBe(result);
    await service.restoreVerifiedArtifact(parent, result);
    await expect(service.readVerifiedArtifact(result)).resolves.toMatchObject({
      playable: '<canvas id="rerender"/>' });

    // same key: the stored result comes back, with no second render or judge call
    await expect(service.rerenderAndReevaluate(command, parent, spec)).resolves.toBe(result);
    expect(render).toHaveBeenCalledTimes(2);
    expect(evaluate).toHaveBeenCalledTimes(2);

    // a tampered parent receipt, a forged artifact digest and a bad grant never reach the renderer
    await expect(service.rerenderAndReevaluate(command, { ...parent,
      receipt: { ...parent.receipt, signature: 'f'.repeat(64) } }, {
      ...spec, idempotencyKey: 'rerender-tampered' }))
      .rejects.toThrow('REEVALUATION_PARENT_AUTHORITY_INVALID');
    await expect(service.rerenderAndReevaluate(command, { ...parent,
      artifacts: { ...parent.artifacts, playableDigest: 'f'.repeat(64) } }, {
      ...spec, idempotencyKey: 'rerender-forged-artifact' }))
      .rejects.toThrow('REEVALUATION_PARENT_AUTHORITY_INVALID');
    await expect(service.rerenderAndReevaluate(command, parent, {
      ...spec, idempotencyKey: 'rerender-bad-grant', actionAuthorityDigest: 'not-a-digest' }))
      .rejects.toThrow('REEVALUATION_ACTION_AUTHORITY_INVALID');
    expect(render).toHaveBeenCalledTimes(2);
    expect(evaluate).toHaveBeenCalledTimes(2);
  });

  it('refuses to judge a re-render that comes back broken (#1645)', async () => {
    let renders = 0;
    const evaluate = vi.fn(async (input: { startTransport: () => Promise<unknown>;
      identity: string; evidenceDigest: string | null }) => {
      await input.startTransport();
      return { score: 0.7, degraded: false, identityValid: true,
        evaluatorIdentity: input.identity, evidenceDigest: input.evidenceDigest };
    });
    const service = new LiminalCommandService({
      effects: {
        generate: async input => {
          await input.startTransport();
          return { source: 'x', playable: '<canvas/>', provenance: 'fake' };
        },
        render: async () => (++renders === 1 ? rendered()
          : { ...rendered(), runtimeErrors: ['ReferenceError: p5 is not defined'] }),
        evaluate,
      } as never,
      artifacts: new InMemoryLiminalArtifactStore(),
      journal: new InMemoryLiminalOperationJournal(),
      authority: createTestReceiptAuthority('rerender-broken-secret'),
    });
    const parent = await service.execute(command);

    await expect(service.rerenderAndReevaluate(command, parent, {
      idempotencyKey: 'rerender-broken', maxTransportAttempts: 1,
      actionAuthorityDigest: '9'.repeat(64) })).rejects.toThrow('REEVALUATION_RENDERED_EVIDENCE_INVALID');
    expect(renders).toBe(2);
    expect(evaluate).toHaveBeenCalledTimes(1);
  });

  it('L3-14: a re-render judges the parent source, and a broken one names its failure class', async () => {
    let renders = 0;
    const sources: Array<string | undefined> = [];
    const evaluate = vi.fn(async (input: { startTransport: () => Promise<unknown>; source?: string;
      identity: string; evidenceDigest: string | null }) => {
      await input.startTransport();
      sources.push(input.source);
      return { score: 0.7, degraded: false, identityValid: true,
        evaluatorIdentity: input.identity, evidenceDigest: input.evidenceDigest };
    });
    const service = new LiminalCommandService({
      effects: {
        generate: async input => {
          await input.startTransport();
          return { source: 'Tone.Transport.start(); // the real source', playable: '<canvas/>', provenance: 'fake' };
        },
        render: async () => (++renders === 3
          ? { ...rendered(), runtimeErrors: ['ReferenceError: p5 is not defined'] } : rendered()),
        evaluate,
      } as never,
      artifacts: new InMemoryLiminalArtifactStore(),
      journal: new InMemoryLiminalOperationJournal(),
      authority: createTestReceiptAuthority('rerender-source-secret'),
    });
    const parent = await service.execute(command);
    await service.rerenderAndReevaluate(command, parent, {
      idempotencyKey: 'rerender-source', maxTransportAttempts: 1, actionAuthorityDigest: '8'.repeat(64) });
    expect(sources).toEqual(['Tone.Transport.start(); // the real source', 'Tone.Transport.start(); // the real source']);
    await expect(service.rerenderAndReevaluate(command, parent, {
      idempotencyKey: 'rerender-source-broken', maxTransportAttempts: 1,
      actionAuthorityDigest: '7'.repeat(64) })).rejects.toThrow(/REEVALUATION_RENDERED_EVIDENCE_INVALID: render/);
  });

  it('verifies a saved native render stamp and historical payload digests on file-backed reevaluation', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'liminal-file-reevaluation-'));
    try {
      const journal = new FileLiminalOperationJournal(path.join(root, 'journal.json'));
      const receiptSecret = 'file-reevaluation-secret';
      const receiptAuthority = createTestReceiptAuthority(receiptSecret);
      const nativeObservation = { ...rendered(), rendered: true };
      const service = new LiminalCommandService({ effects: {
        generate: async input => {
          await input.startTransport();
          return { source: 'x', playable: '<canvas/>', provenance: 'file-proof' };
        },
        render: async () => nativeObservation,
        evaluate: async input => {
          await input.startTransport();
          return { score: 0.75, degraded: false, identityValid: true,
            evaluatorIdentity: input.identity, evidenceDigest: input.evidenceDigest };
        },
      }, artifacts: new FileLiminalArtifactStore(path.join(root, 'artifacts')),
      journal,
      authority: receiptAuthority });
      const parent = await service.execute(command);
      expect(parent.evidence.rendered).toBe(true);
      await expect(service.reevaluate(command, parent, rendered(), {
        idempotencyKey: 'file-reevaluation-without-native-stamp', maxTransportAttempts: 1,
        actionAuthorityDigest: '8'.repeat(64),
      })).rejects.toThrow('REEVALUATION_RENDERED_EVIDENCE_INVALID');
      const stored = await service.readVerifiedResult(command.idempotencyKey);
      const result = await service.reevaluate(command, parent, { ...rendered(), rendered: stored?.evidence.rendered }, {
        idempotencyKey: 'file-backed-reevaluation', maxTransportAttempts: 1,
        actionAuthorityDigest: '9'.repeat(64),
      });

      await expect(service.readVerifiedResult('file-backed-reevaluation'))
        .resolves.toEqual(result);
      const findResult = vi.spyOn(journal, 'findByIdempotencyKey').mockResolvedValue({ ...result,
        domain: undefined } as never);
      await expect(service.readVerifiedResult('file-backed-reevaluation', command))
        .rejects.toThrow('LIMINAL_RESULT_TRACE_INVALID');
      await expect(service.reevaluate(command, parent, nativeObservation, {
        idempotencyKey: 'file-backed-reevaluation', maxTransportAttempts: 1,
        actionAuthorityDigest: '8'.repeat(64),
      }, result)).rejects.toThrow('LIMINAL_RESULT_TRACE_INVALID');
      await service.restoreVerifiedArtifact(parent, result);
      await expect(service.readVerifiedArtifact(result)).resolves
        .toMatchObject({ provenance: 'file-proof' });
      const { operationTraceDigest: _trace, signature: _signature,
        ...legacyUnsigned } = result.receipt;
      const legacyReceipt = { ...legacyUnsigned,
        signature: createHmac('sha256', receiptSecret)
          .update(canonicalForTest(legacyUnsigned)).digest('hex') };
      findResult.mockResolvedValue({ ...result, domain: undefined,
        receipt: legacyReceipt } as never);
      await expect(service.readVerifiedResult('file-backed-reevaluation'))
        .rejects.toThrow('LIMINAL_RESULT_TRACE_INVALID');
      await expect(service.readVerifiedResult('file-backed-reevaluation', command))
        .rejects.toThrow('LIMINAL_RESULT_TRACE_INVALID');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('accepts only a bounded action-authorized evaluator timeout', () => {
    expect(validateEvaluatorTimeoutMs(300_000)).toBe(300_000);
    expect(() => validateEvaluatorTimeoutMs(119_999)).toThrow('EVALUATOR_TIMEOUT_OUT_OF_BOUNDS');
    expect(() => validateEvaluatorTimeoutMs(600_001)).toThrow('EVALUATOR_TIMEOUT_OUT_OF_BOUNDS');
  });

  it('replays relocated evidence only from the supplied authority package directory', () => {
    expect(resolveReevaluationEvidenceRoot(
      '/isolated/c0-authoritative-b51958f/authority.json',
      '/stale/worktree/c0-authoritative-b51958f',
    )).toBe('/isolated/c0-authoritative-b51958f');
    expect(() => resolveReevaluationEvidenceRoot(
      '/isolated/different-artifact/authority.json',
      '/stale/worktree/c0-authoritative-b51958f',
    )).toThrow('REEVALUATION_EVIDENCE_ROOT_IDENTITY_MISMATCH');
  });

  it('binds governed provider bytes and activated snapshot into the authority receipt', async () => {
    const snapshotDigest = '9'.repeat(64);
    const providerInput = 'Base prompt\n\nActivated creative principles:\nPreserve depth cues.';
    const service = new LiminalCommandService({
      effects: { generate: async input => {
        await input.startTransport();
        return { source: 'function setup(){}', playable: '<canvas/>', provenance: 'fake' };
      }, render: async () => rendered(), evaluate: async input => {
        await input.startTransport();
        return { score: 0.8, degraded: false, identityValid: true,
          evaluatorIdentity: input.identity, evidenceDigest: input.evidenceDigest };
      } }, artifacts: new InMemoryLiminalArtifactStore(),
      journal: new InMemoryLiminalOperationJournal(),
      authority: createTestReceiptAuthority('governed-digest-secret'),
    });
    const request = { ...command, idempotencyKey: 'governed-digests',
      prompt: 'Base prompt', sourceHeadSha: '6'.repeat(40),
      safeMode: 'governed-production' as const,
      teaching: { targetScope: 'visual', snapshotDigest } };
    let compiledInput = providerInput;
    const port = new LiminalProductCommandPort(service, undefined, undefined, {
      compile: async input => ({
        command: { ...input, prompt: compiledInput },
        receipt: { preProviderInputDigest: createHash('sha256').update(input.prompt).digest('hex'),
          finalProviderInputDigest: createHash('sha256').update(compiledInput).digest('hex'),
          compilationDigest: '8'.repeat(64) },
      }),
    });
    const projection = await port.submitCreate('cli', request);
    if (projection.kind !== 'create') throw new Error('Expected completed Create');
    const result = await port.readVerifiedCreateResult(request, projection);
    expect(result.receipt.providerInputDigest).toBe(createHash('sha256')
      .update(providerInput).digest('hex'));
    expect(result.receipt.empiricalContextDigests).toEqual([snapshotDigest]);
    compiledInput = 'A different compiled prompt';
    await expect(port.readVerifiedCreateResult(request, projection)).rejects.toThrow('LIMINAL_RESULT_TRACE_INVALID');
  });
});
