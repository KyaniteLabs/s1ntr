import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CortexLivingLoopConductor,
  FileCortexCycleStore,
  type LivingLoopStep,
} from '../../src/cortex/CortexLivingLoop.js';
import {
  StudioLivingLoopExecutor,
  CanonicalStudioLivingLoopProviderBoundary,
  type StudioLivingLoopProviderBoundary,
  type StudioLivingLoopProviderRequest,
} from '../../src/cortex/StudioLivingLoopExecutor.js';
import { DreamQueue } from '../../src/dreaming/DreamQueue.js';
import { StudioLineageLedger } from '../../src/tui-bridge/StudioLineage.js';
import { TuiBridgeService } from '../../src/tui-bridge/TuiBridgeService.js';
import type { NoSpendCirculationProof } from '../../src/llm/PreSpendInterlock.js';

const roots: string[] = [];

const manifest: LivingLoopStep[] = [
  'create-evidence', 'consolidate', 'dream', 'autoresearch',
  'review', 'assimilate', 'candidate-request', 'follow-up-create',
];

class FrozenProviderBoundary implements StudioLivingLoopProviderBoundary {
  readonly calls: StudioLivingLoopProviderRequest[] = [];
  readonly transport = { ledgerReservations: 0, networkCalls: 0, spendUsd: 0 };

  async invoke(request: StudioLivingLoopProviderRequest) {
    if (this.calls.some(call => call.idempotencyKey === request.idempotencyKey)) {
      throw new Error(`FROZEN_PROVIDER_DUPLICATE:${request.step}`);
    }
    const expected = manifest[this.calls.length];
    if (request.step !== expected) {
      throw new Error(`FROZEN_PROVIDER_REQUEST_MISMATCH:${expected ?? 'end'}:${request.step}`);
    }
    this.calls.push(structuredClone(request));
    return {
      content: `frozen response for ${request.step}`,
      provider: 'deterministic-fixture',
      model: 'provider-shaped-v1',
      artifactRefs: [`fixture:${request.step}`],
      usage: { tokens: 1, costUsd: 0, wallClockMs: 1 },
    };
  }
}

function providerRequest(
  step: LivingLoopStep,
  idempotencyKey = step.padEnd(64, '0'),
): StudioLivingLoopProviderRequest {
  return {
    cycleId: 'wave7-studio-cycle',
    lineageId: 'wave7-studio-lineage',
    sourceFingerprint: 'e'.repeat(64),
    step,
    idempotencyKey,
  };
}

function request() {
  return {
    cycleId: 'wave7-studio-cycle',
    lineageId: 'wave7-studio-lineage',
    sourceFingerprint: 'e'.repeat(64),
    autonomyLevel: 'co-create' as const,
    prerequisites: {
      dreamReceiptDigest: 'a'.repeat(64),
      causalReceiptDigest: 'b'.repeat(64),
      domainReceiptDigest: 'c'.repeat(64),
      assimilationReceiptDigest: 'd'.repeat(64),
    },
    budgets: {
      maxActions: 8, maxTokens: 700, maxCostUsd: 1, maxWallClockMs: 10_000,
    },
    concurrencyLimit: 1,
    leaseTtlMs: 1_000,
  };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe('Wave 7 Studio organism no-spend seam', () => {
  it('blocks a live Studio organism executor before its provider boundary when no policy is active', () => {
    const boundary = new FrozenProviderBoundary();
    expect(() => new StudioLivingLoopExecutor({
      cycleId: 'live-cycle', lineageId: 'live-lineage', sourceFingerprint: 'e'.repeat(64),
      receiptRoot: path.resolve(os.tmpdir(), 'wave7-live-blocked'), evidenceClass: 'live',
      boundary: new CanonicalStudioLivingLoopProviderBoundary('live', boundary), dreamQueue: {} as DreamQueue, lineageLedger: {} as StudioLineageLedger,
    })).toThrow('SINTER_WAVE8_LIVE_EXECUTION_CONFIG is required');
    expect(boundary.calls).toEqual([]);
  });

  it('keeps the executable receipt shape consumable by the spend interlock', () => {
    const receipt: NoSpendCirculationProof = {
      gate: 'noSpendCirculationProof', passed: true,
      planHash: 'a'.repeat(64), sourceFingerprint: 'b'.repeat(64),
      artifactDigest: 'c'.repeat(64), evidenceClass: 'deterministic-proof',
    };
    expect(receipt.passed).toBe(true);
  });

  it('fails closed on duplicate, reordered, unknown, or unmapped provider calls', async () => {
    const reordered = new FrozenProviderBoundary();
    await expect(reordered.invoke(providerRequest('consolidate')))
      .rejects.toThrow('FROZEN_PROVIDER_REQUEST_MISMATCH');

    const duplicate = new FrozenProviderBoundary();
    const first = providerRequest('create-evidence');
    await duplicate.invoke(first);
    await expect(duplicate.invoke(first)).rejects.toThrow('FROZEN_PROVIDER_DUPLICATE');

    const unknown = new FrozenProviderBoundary();
    await expect(unknown.invoke(providerRequest('unknown' as LivingLoopStep)))
      .rejects.toThrow('FROZEN_PROVIDER_REQUEST_MISMATCH');

    const unmapped = new FrozenProviderBoundary();
    for (const [index, step] of manifest.entries()) {
      await unmapped.invoke(providerRequest(step, `${index}`.padEnd(64, 'f')));
    }
    await expect(unmapped.invoke(providerRequest('create-evidence', 'f'.repeat(64))))
      .rejects.toThrow('FROZEN_PROVIDER_REQUEST_MISMATCH:end');
  });

  it('runs the living loop through real Studio construction in causal order', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'wave7-studio-loop-'));
    roots.push(root);
    const ledger = new StudioLineageLedger({ ledgerPath: path.join(root, 'lineage.jsonl') });
    await ledger.start({
      lineageId: 'wave7-studio-lineage', sessionId: 'studio-fixture', origin: 'studio',
    });
    await ledger.append('wave7-studio-lineage', {
      stage: 'artifact', status: 'observed', origin: 'studio-create',
      trust: 'verified-system', corroboration: ['fixture:initial-artifact'],
      payload: { codeDigest: 'f'.repeat(64) },
    });
    await ledger.append('wave7-studio-lineage', {
      stage: 'reaction', status: 'observed', origin: 'studio-owner-reaction',
      trust: 'owner', corroboration: ['fixture:initial-artifact'],
      payload: { artifactDigest: 'f'.repeat(64), lineageId: 'wave7-studio-lineage', sourceFingerprint: 'e'.repeat(64), reactionDigest: '9'.repeat(64) },
    });
    await ledger.append('wave7-studio-lineage', {
      stage: 'hypothesis', status: 'observed', origin: 'studio-consolidate',
      trust: 'verified-system', corroboration: ['9'.repeat(64)],
      payload: { reactionDigest: '9'.repeat(64) },
    });
    const queue = new DreamQueue({ persistPath: path.join(root, 'dream-queue.json') });
    queue.enqueue('elite-x-compost', [{
      id: 'fixture:initial-artifact', descriptor: [0.5], quality: 0.8,
    }], 0.8);
    const boundary = new CanonicalStudioLivingLoopProviderBoundary('deterministic-no-spend');
    const conductor = new CortexLivingLoopConductor(
      new FileCortexCycleStore(path.join(root, 'cycles')),
    );
    const service = new TuiBridgeService({ livingLoopConductor: conductor });
    const session = service.createSession();
    const executor = new StudioLivingLoopExecutor({
      cycleId: 'wave7-studio-cycle', lineageId: 'wave7-studio-lineage',
      sourceFingerprint: 'e'.repeat(64), receiptRoot: path.join(root, 'receipts'),
      evidenceClass: 'deterministic-proof',
      boundary, dreamQueue: queue, lineageLedger: ledger,
    });

    const checkpoint = await service.conductLivingLoop(
      session.sessionId, request(), 'studio-owner', executor,
    );

    expect(checkpoint.state).toBe('completed');
    expect(boundary.calls.map(call => call.step)).toEqual([
      'create-evidence', 'consolidate', 'dream', 'autoresearch',
      'review', 'assimilate', 'candidate-request', 'follow-up-create',
    ]);
    const events = service.getEvents(session.sessionId)
      .filter(event => event.type === 'cortex.action_lifecycle');
    expect(events).toHaveLength(24);
    expect(events[0]).toMatchObject({
      step: 'create-evidence', state: 'queued', disposition: 'proposed',
      lineageId: 'wave7-studio-lineage', actorId: 'studio-owner',
      sourceFingerprint: 'e'.repeat(64),
    });
    expect(events.at(-1)).toMatchObject({
      step: 'follow-up-create', state: 'completed', disposition: 'executed',
      effectIds: expect.arrayContaining([
        expect.stringContaining('follow-up-artifact'),
      ]),
      artifactRefs: expect.arrayContaining(['deterministic:follow-up-create']),
      errorClass: null,
    });
    expect(queue.getStatus()).toMatchObject({ queued: 0, running: 0, completed: 1 });
    expect((await ledger.query('wave7-studio-lineage')).records.at(-1)).toMatchObject({
      stage: 'follow-up', status: 'observed', origin: 'studio-cortex-follow-up-create',
    });
    expect(boundary.transportSentinel).toEqual({
      ledgerReservations: 0, networkCalls: 0, spendUsd: 0,
    });
    const persisted = JSON.parse(await readFile(
      path.join(root, 'receipts', 'follow-up-create.json'), 'utf8',
    ));
    expect(persisted).toMatchObject({
      evidenceClass: 'deterministic-proof', livePass: false,
    });
    service.destroy();
  });
});
