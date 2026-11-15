import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DreamResearchJournal } from '../../../src/dreaming/research/DreamResearchJournal.js';
import { DreamResearchService } from '../../../src/dreaming/research/DreamResearchService.js';
import { frozenExperiment } from './dreamResearchFixtures.js';
import { createDreamDecisionAuthority, type DreamDecisionIssuer } from
  '../../../src/dreaming/research/DreamDecisionAuthority.js';
import { createDreamRecoveryAuthority, type DreamRecoveryIssuer } from
  '../../../src/dreaming/research/DreamRecoveryAuthority.js';

const decisionIssuers = new WeakMap<DreamResearchService, DreamDecisionIssuer>();
const recoveryIssuers = new WeakMap<DreamResearchService, DreamRecoveryIssuer>();

describe('DreamResearchService', () => {
  const roots: string[] = [];
  afterEach(async () => Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))));

  async function service() {
    const root = await mkdtemp(path.join(tmpdir(), 'dream-service-'));
    roots.push(root);
    const decisions = createDreamDecisionAuthority();
    const recovery = createDreamRecoveryAuthority();
    const result = new DreamResearchService(new DreamResearchJournal(path.join(root, 'dream.sqlite')),
      { assertActive: () => undefined }, decisions.resolver, recovery.resolver);
    decisionIssuers.set(result, decisions.issuer);
    recoveryIssuers.set(result, recovery.issuer);
    return result;
  }

  it('completes rejection without positive learning', async () => {
    const dream = await service();
    dream.plan(frozenExperiment(), 'plan');
    dream.freeze('dream-1', 1, 'freeze');
    dream.recordBaseline('dream-1', 2, 'baseline', 'e'.repeat(64));
    dream.recordVariants('dream-1', 3, 'variants', ['f'.repeat(64)], ['a'.repeat(64)]);
    dream.recordDiagnosticOutcome('dream-1', 4, 'compare',
      { outcome: 'rejected', reason: 'regression' });
    expect(dream.snapshot('dream-1')).toMatchObject({ state: 'completed', finding: 'none' });
    expect(dream.events('dream-1').map(event => event.type)).not.toContain('finding-proposed');
  });

  it('requires unseen transfer before validating a finding', async () => {
    const dream = await service();
    dream.plan(frozenExperiment(), 'plan'); dream.freeze('dream-1', 1, 'freeze');
    dream.recordBaseline('dream-1', 2, 'baseline', 'e'.repeat(64));
    dream.recordVariants('dream-1', 3, 'variants', ['f'.repeat(64)], ['a'.repeat(64)]);
    expect(() => dream.compare('dream-1', 4, 'forged',
      { kind: 'dream-rendered-comparison' })).toThrow('DREAM_COMPARISON_CAPABILITY_INVALID');
    const decisions = decisionIssuers.get(dream)!;
    dream.compare('dream-1', 4, 'compare', decisions.issueComparison({
      aggregateId: 'dream-1', outcome: 'keeper', reason: 'stronger depth',
      baselineEvidenceDigest: 'e'.repeat(64), variantEvidenceDigests: ['f'.repeat(64)],
      variantArtifactDigests: ['a'.repeat(64)] }));
    expect(dream.snapshot('dream-1')).toMatchObject({ state: 'finding-proposed', finding: 'proposed' });
    expect(() => dream.validateTransfer('dream-1', 6, 'early', decisions.issueTransfer({
      aggregateId: 'dream-1', outcome: 'validated',
      treatmentEvidenceDigest: 'a'.repeat(64), controlEvidenceDigest: 'b'.repeat(64),
      treatmentArtifactDigest: 'c'.repeat(64), controlArtifactDigest: 'd'.repeat(64) })))
      .toThrow('DREAM_STATE_INVALID');
    dream.freezeTransfer('dream-1', 5, 'transfer-freeze');
    dream.recordTransfer('dream-1', 6, 'transfer-observed', 'a'.repeat(64),
      'b'.repeat(64), 'c'.repeat(64), 'd'.repeat(64));
    dream.validateTransfer('dream-1', 7, 'transfer-compare', decisions.issueTransfer({
      aggregateId: 'dream-1', outcome: 'validated',
      treatmentEvidenceDigest: 'a'.repeat(64), controlEvidenceDigest: 'b'.repeat(64),
      treatmentArtifactDigest: 'c'.repeat(64), controlArtifactDigest: 'd'.repeat(64) }));
    expect(dream.snapshot('dream-1')).toMatchObject({ state: 'completed', finding: 'validated' });
  });

  it('counts transport start and never retries an ambiguous outcome', async () => {
    const dream = await service();
    dream.plan(frozenExperiment(), 'plan');
    const reservation = dream.reserveAttempt('dream-1', 1, 'reserve-1', 'generation');
    expect(reservation.attempt).toBe(1);
    dream.markTransportStarted('dream-1', 2, 'start-1', reservation.operationId);
    dream.markAttemptUnknown('dream-1', 3, 'unknown-1', reservation.operationId);
    expect(() => dream.reserveAttempt('dream-1', 4, 'reserve-again', 'generation'))
      .toThrow('DREAM_ATTEMPT_OUTCOME_UNKNOWN');
    expect(dream.snapshot('dream-1').attemptsStarted).toBe(1);
  });

  it('aborts before attempt N plus one', async () => {
    const dream = await service();
    dream.plan({ ...frozenExperiment(), budget: { maximumAttempts: 1 } }, 'plan');
    const reservation = dream.reserveAttempt('dream-1', 1, 'reserve-1', 'generation');
    dream.markTransportStarted('dream-1', 2, 'start-1', reservation.operationId);
    dream.completeAttempt('dream-1', 3, 'complete-1', reservation.operationId, 'a'.repeat(64));
    expect(() => dream.reserveAttempt('dream-1', 4, 'reserve-2', 'evaluation'))
      .toThrow('DREAM_ATTEMPT_CAP_EXHAUSTED');
  });

  it('recovers a completed effect result after restart without another effect or budget debit', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'dream-result-restart-')); roots.push(root);
    const database = path.join(root, 'dream.sqlite');
    const firstJournal = new DreamResearchJournal(database);
    const first = new DreamResearchService(firstJournal, { assertActive: () => undefined });
    first.plan(frozenExperiment(), 'plan');
    const effect = vi.fn(async () => ({ artifact: 'persisted', nested: [1, 2] }));
    expect(await first.runOperation('dream-1', 'creative-operator', effect))
      .toEqual({ artifact: 'persisted', nested: [1, 2] });
    expect(first.events('dream-1').filter(event => event.type === 'operation-completed'))
      .toHaveLength(1);
    firstJournal.close();

    const restartedJournal = new DreamResearchJournal(database);
    const restarted = new DreamResearchService(restartedJournal,
      { assertActive: () => undefined });
    const replayEffect = vi.fn(async () => ({ artifact: 'wrong' }));
    expect(await restarted.runOperation('dream-1', 'creative-operator', replayEffect))
      .toEqual({ artifact: 'persisted', nested: [1, 2] });
    expect(replayEffect).not.toHaveBeenCalled();
    expect(restarted.snapshot('dream-1').attemptsStarted).toBe(1);
    restartedJournal.close();

    const raw = new Database(database);
    raw.prepare(`UPDATE dream_operation_results SET response_json = ?`)
      .run(JSON.stringify({ artifact: 'tampered' }));
    raw.close();
    const tamperedJournal = new DreamResearchJournal(database);
    const tampered = new DreamResearchService(tamperedJournal,
      { assertActive: () => undefined });
    const forbiddenEffect = vi.fn(async () => ({ artifact: 'must-not-run' }));
    await expect(tampered.runOperation('dream-1', 'creative-operator', forbiddenEffect))
      .rejects.toThrow('DREAM_OPERATION_RESULT_INVALID');
    expect(forbiddenEffect).not.toHaveBeenCalled();
    tamperedJournal.close();
  });

  it('refuses lifecycle creation without active lease authority', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'dream-service-')); roots.push(root);
    const dream = new DreamResearchService(new DreamResearchJournal(path.join(root, 'dream.sqlite')));
    expect(() => dream.plan(frozenExperiment(), 'plan'))
      .toThrow('DREAM_LEASE_AUTHORITY_MISSING');
  });

  it('supports explicit unknown resolution lease cancellation and safe abandon', async () => {
    const dream = await service(); dream.plan(frozenExperiment(), 'plan');
    const reservation = dream.reserveAttempt('dream-1', 1, 'reserve', 'generation');
    dream.markTransportStarted('dream-1', 2, 'start', reservation.operationId);
    dream.markAttemptUnknown('dream-1', 3, 'unknown', reservation.operationId);
    expect(() => dream.resolveUnknownAttempt('dream-1', 4, 'wrong-resolve',
      'f'.repeat(64), 'a'.repeat(64))).toThrow('DREAM_ATTEMPT_NOT_UNKNOWN');
    dream.resolveUnknownAttempt('dream-1', 4, 'resolve', reservation.operationId,
      'a'.repeat(64));
    expect(() => dream.reserveAttempt('dream-1', 5, 'same-purpose', 'generation'))
      .toThrow('DREAM_ATTEMPT_RETRY_FORBIDDEN');
    const next = dream.reserveAttempt('dream-1', 5, 'again', 'evaluation');
    expect(next.attempt).toBe(2);
    dream.cancelLease('dream-1', 6, 'cancel');
    expect(() => dream.reserveAttempt('dream-1', 7, 'after-cancel', 'evaluation'))
      .toThrow('DREAM_LEASE_CANCELLED');
    expect(() => dream.abandon('dream-1', 7, 'forged-abandon', 'operator decision',
      { kind: 'dream-operator-recovery' })).toThrow('DREAM_RECOVERY_CAPABILITY_INVALID');
    const recovery = recoveryIssuers.get(dream)!.authorizeAbandon('dream-1', 'operator decision');
    expect(() => dream.abandon('dream-1', 7, 'wrong-reason', 'different', recovery))
      .toThrow('DREAM_RECOVERY_CAPABILITY_INVALID');
    dream.abandon('dream-1', 7, 'abandon', 'operator decision', recovery);
    expect(dream.snapshot('dream-1')).toMatchObject({ state: 'completed',
      leaseCancelled: true, hasUnknownAttempt: false });
  });
});
