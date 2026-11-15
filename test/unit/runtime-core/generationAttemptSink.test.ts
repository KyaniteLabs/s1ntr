import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import {
  FileGenerationAttemptPersistence,
  GenerationAttemptLedger,
  MemoryGenerationAttemptPersistence,
} from '../../../src/runtime-core/generationAttemptSink.js';
import { buildGenerationAttemptEventV1 } from '../../../src/telemetry/generationAttemptEvent.js';

async function emitFailure(
  ledger: GenerationAttemptLedger,
  failureReason: 'empty-artifact' | 'timeout' = 'empty-artifact',
): Promise<void> {
  const attempt = await ledger.beginPrimary({ runId: 'run', candidateId: 'candidate', domain: 'p5' });
  await attempt.emit(buildGenerationAttemptEventV1({
    ...attempt,
    stage: 'failure_class',
    failureReason,
  }), {
    providerCalls: 1,
    inputTokens: 11,
    outputTokens: 7,
    activeTimeMs: 13,
    quotaUnits: 1,
  });
}

describe('GenerationAttemptLedger', () => {
  it('persists exact attempt ordinals and all resource counters', async () => {
    const ledger = new GenerationAttemptLedger(new MemoryGenerationAttemptPersistence());
    await emitFailure(ledger);
    const second = await ledger.beginPrimary({ runId: 'run', candidateId: 'candidate' });
    const snapshot = await ledger.snapshot('run', 'candidate');

    expect(second.attemptOrdinal).toBe(2);
    expect(snapshot?.counters).toEqual({
      providerCalls: 1,
      inputTokens: 11,
      outputTokens: 7,
      retries: 0,
      activeTimeMs: 13,
      quotaUnits: 1,
    });
  });

  it('hydrates the one-use recovery reservation across restart', async () => {
    const root = await mkdtemp(`${tmpdir()}/attempt-ledger-`);
    try {
      const first = new GenerationAttemptLedger(new FileGenerationAttemptPersistence(root));
      const executorReservationDigest = 'a'.repeat(64);
      const campaignFundingReservationDigest = 'b'.repeat(64);
      const primary = await first.beginPrimary({
        runId: 'run', candidateId: 'candidate', attemptId: 'primary-frozen',
        executorReservationDigest, campaignFundingReservationDigest,
      });
      const granted = await first.reserveRecovery({
        runId: 'run', candidateId: 'candidate', failedAttemptId: primary.attemptId,
        recoveryAttemptId: 'recovery-frozen',
      });
      expect(granted.granted).toBe(true);
      if (granted.granted) {
        expect(granted.context.executorReservationDigest).toBe(executorReservationDigest);
        expect(granted.context.campaignFundingReservationDigest).toBe(campaignFundingReservationDigest);
        expect(granted.context.attemptId).toBe('recovery-frozen');
      }

      const restarted = new GenerationAttemptLedger(new FileGenerationAttemptPersistence(root));
      const denied = await restarted.reserveRecovery({
        runId: 'run', candidateId: 'candidate', failedAttemptId: 'another-node',
      });
      expect(denied).toEqual({ granted: false, consumedByAttemptId: primary.attemptId });
      expect((await restarted.snapshot('run', 'candidate'))?.counters.retries).toBe(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('atomically grants exactly one recovery to concurrent graph nodes', async () => {
    const root = await mkdtemp(`${tmpdir()}/attempt-ledger-race-`);
    try {
      const a = new GenerationAttemptLedger(new FileGenerationAttemptPersistence(root));
      const b = new GenerationAttemptLedger(new FileGenerationAttemptPersistence(root));
      const outcomes = await Promise.all([
        a.reserveRecovery({ runId: 'run', candidateId: 'candidate', failedAttemptId: 'node-a' }),
        b.reserveRecovery({ runId: 'run', candidateId: 'candidate', failedAttemptId: 'node-b' }),
      ]);
      expect(outcomes.filter((outcome) => outcome.granted)).toHaveLength(1);
      expect(outcomes.filter((outcome) => !outcome.granted)).toHaveLength(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('projects one actionable failure shape for every product entrypoint', async () => {
    const ledger = new GenerationAttemptLedger(new MemoryGenerationAttemptPersistence());
    await emitFailure(ledger, 'timeout');
    expect(await ledger.failureProjection('run', 'candidate')).toMatchObject({
      failureClass: 'timeout',
      action: expect.stringContaining('provider health'),
      runId: 'run',
      candidateId: 'candidate',
    });
  });

  it('preserves immutable event attribution when a signed receipt is supplied before restart', async () => {
    const root = await mkdtemp(`${tmpdir()}/attempt-ledger-backfill-`);
    try {
      const first = new GenerationAttemptLedger(new FileGenerationAttemptPersistence(root));
      const attempt = await first.beginPrimary({ runId: 'run', candidateId: 'candidate' });
      // Emit a pre-transport event before any receipt is bound.
      await attempt.emit(buildGenerationAttemptEventV1({
        runId: 'run', candidateId: 'candidate', attemptId: attempt.attemptId,
        attemptOrdinal: attempt.attemptOrdinal, stage: 'request',
      }));
      const ref = {
        attestationId: 'att-backfill', attestationDigest: 'a'.repeat(64), attemptDigest: 'b'.repeat(64),
        requestDigest: 'c'.repeat(64), routeDigest: 'd'.repeat(64),
        attemptOrdinal: 1, fallbackOrdinal: 0, retryOrdinal: 0, durationMs: 1,
        quotaCounterDelta: { calls: 1, inputTokens: 0, outputTokens: 0, activeSeconds: 0 },
      };
      // The post-transport event binds the signed ref without rewriting the
      // earlier pre-transport event.
      await attempt.emit(buildGenerationAttemptEventV1({
        runId: 'run', candidateId: 'candidate', attemptId: attempt.attemptId,
        attemptOrdinal: attempt.attemptOrdinal, stage: 'assistant_payload',
      }), { providerCalls: 1, quotaUnits: 1 }, [ref]);

      // Simulate process restart: re-open the file persistence.
      const restarted = new GenerationAttemptLedger(new FileGenerationAttemptPersistence(root));
      const snapshot = await restarted.snapshot('run', 'candidate');
      expect(snapshot?.attemptBindings?.[attempt.attemptId]).toHaveLength(1);
      expect(snapshot?.events[0].attestationDigest).toBeUndefined();
      expect(snapshot?.events[1].attestationDigest).toBe(ref.attestationDigest);
      expect(snapshot?.events[1].attemptDigest).toBe(ref.attemptDigest);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('keeps no-receipt attempts explicitly unattested; never fabricates a digest', async () => {
    const ledger = new GenerationAttemptLedger(new MemoryGenerationAttemptPersistence());
    const attempt = await ledger.beginPrimary({ runId: 'run', candidateId: 'candidate' });
    await attempt.emit(buildGenerationAttemptEventV1({
      runId: 'run', candidateId: 'candidate', attemptId: attempt.attemptId,
      attemptOrdinal: attempt.attemptOrdinal, stage: 'request',
    }));
    const snapshot = await ledger.snapshot('run', 'candidate');
    expect(snapshot?.attemptBindings).toBeUndefined();
    for (const event of snapshot!.events) {
      expect(event.attestationDigest).toBeUndefined();
      expect(event.attemptDigest).toBeUndefined();
    }
  });

  it('does not cross-bind refs across concurrent candidates in the same run', async () => {
    const ledger = new GenerationAttemptLedger(new MemoryGenerationAttemptPersistence());
    const attemptA = await ledger.beginPrimary({ runId: 'run', candidateId: 'cand-A' });
    const attemptB = await ledger.beginPrimary({ runId: 'run', candidateId: 'cand-B' });
    const refA = {
      attestationId: 'att-A', attestationDigest: '1'.repeat(64), attemptDigest: '2'.repeat(64),
      requestDigest: '3'.repeat(64), routeDigest: '4'.repeat(64),
      attemptOrdinal: 1, fallbackOrdinal: 0, retryOrdinal: 0, durationMs: 0,
      quotaCounterDelta: { calls: 1, inputTokens: 0, outputTokens: 0, activeSeconds: 0 },
    };
    const refB = {
      attestationId: 'att-B', attestationDigest: '5'.repeat(64), attemptDigest: '6'.repeat(64),
      requestDigest: '7'.repeat(64), routeDigest: '8'.repeat(64),
      attemptOrdinal: 1, fallbackOrdinal: 0, retryOrdinal: 0, durationMs: 0,
      quotaCounterDelta: { calls: 1, inputTokens: 0, outputTokens: 0, activeSeconds: 0 },
    };
    // Interleave emissions — binding for A must not leak onto B's event.
    await attemptA.emit(buildGenerationAttemptEventV1({
      runId: 'run', candidateId: 'cand-A', attemptId: attemptA.attemptId,
      attemptOrdinal: 1, stage: 'request',
    }), undefined, [refA]);
    await attemptB.emit(buildGenerationAttemptEventV1({
      runId: 'run', candidateId: 'cand-B', attemptId: attemptB.attemptId,
      attemptOrdinal: 1, stage: 'request',
    }), undefined, [refB]);

    const snapA = await ledger.snapshot('run', 'cand-A');
    const snapB = await ledger.snapshot('run', 'cand-B');
    expect(snapA?.events[0].attestationDigest).toBe(refA.attestationDigest);
    expect(snapB?.events[0].attestationDigest).toBe(refB.attestationDigest);
    expect(snapA?.events.some((e) => e.attestationDigest === refB.attestationDigest)).toBe(false);
    expect(snapB?.events.some((e) => e.attestationDigest === refA.attestationDigest)).toBe(false);
  });
});
