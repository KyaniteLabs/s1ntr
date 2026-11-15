import { createHash } from 'node:crypto';
import { DreamResearchJournal } from './DreamResearchJournal.js';
import type { DreamAttemptReservation, DreamComparisonOutcome, DreamExperimentPlan,
  DreamResearchEvent, DreamResearchEventType, DreamResearchSnapshot,
} from './DreamResearchTypes.js';
import type { DreamComparisonCapability, DreamDecisionResolver,
  DreamTransferCapability } from './DreamDecisionAuthority.js';
import type { DreamRecoveryCapability,
  DreamRecoveryResolver } from './DreamRecoveryAuthority.js';

function operationId(aggregateId: string, commandId: string, purpose: string): string {
  return createHash('sha256').update(`${aggregateId}:${commandId}:${purpose}`).digest('hex');
}

export interface DreamLeaseAuthority {
  assertActive(campaignId: string,
    lease: DreamExperimentPlan['lease']): void;
}

export class DreamResearchService {
  constructor(private readonly journal: DreamResearchJournal,
    private readonly leaseAuthority?: DreamLeaseAuthority,
    private readonly decisions?: DreamDecisionResolver,
    private readonly recovery?: DreamRecoveryResolver) {}

  plan(plan: DreamExperimentPlan, commandId: string): DreamResearchEvent {
    if (!this.leaseAuthority) throw new Error('DREAM_LEASE_AUTHORITY_MISSING');
    this.leaseAuthority.assertActive(plan.campaignId, plan.lease);
    if (this.journal.events(plan.aggregateId).length > 0) {
      const replay = this.journal.byCommand(commandId);
      if (replay) return replay;
      throw new Error('DREAM_ALREADY_PLANNED');
    }
    return this.journal.append({ aggregateId: plan.aggregateId, expectedRevision: 0,
      commandId, type: 'experiment-planned', payload: { plan } });
  }

  freeze(aggregateId: string, expectedRevision: number, commandId: string) {
    return this.transition(aggregateId, expectedRevision, commandId,
      'experiment-frozen', ['planned'], {});
  }

  recordBaseline(aggregateId: string, expectedRevision: number,
    commandId: string, evidenceDigest: string) {
    return this.transition(aggregateId, expectedRevision, commandId,
      'baseline-observed', ['frozen'], { evidenceDigest });
  }

  recordVariants(aggregateId: string, expectedRevision: number,
    commandId: string, evidenceDigests: string[], artifactDigests: string[]) {
    if (evidenceDigests.length === 0 || artifactDigests.length !== evidenceDigests.length) {
      throw new Error('DREAM_VARIANT_EVIDENCE_REQUIRED');
    }
    return this.transition(aggregateId, expectedRevision, commandId,
      'variants-observed', ['baseline-observed'], { evidenceDigests, artifactDigests });
  }

  compare(aggregateId: string, expectedRevision: number, commandId: string,
    capability: DreamComparisonCapability) {
    if (!this.decisions) throw new Error('DREAM_DECISION_AUTHORITY_MISSING');
    const comparison = this.decisions.comparison(capability, aggregateId);
    const events = this.events(aggregateId);
    const baseline = events.find(event => event.type === 'baseline-observed');
    const variants = events.find(event => event.type === 'variants-observed');
    if (baseline?.payload.evidenceDigest !== comparison.baselineEvidenceDigest
      || !sameValues(variants?.payload.evidenceDigests, comparison.variantEvidenceDigests)
      || !sameValues(variants?.payload.artifactDigests, comparison.variantArtifactDigests)) {
      throw new Error('DREAM_COMPARISON_EVIDENCE_MISMATCH');
    }
    const type: DreamResearchEventType = comparison.outcome === 'keeper'
      ? 'finding-proposed' : comparison.outcome === 'rejected'
        ? 'experiment-rejected' : 'experiment-inconclusive';
    return this.transition(aggregateId, expectedRevision, commandId,
      type, ['variants-observed'], { ...comparison });
  }

  recordDiagnosticOutcome(aggregateId: string, expectedRevision: number,
    commandId: string, comparison: { outcome: DreamComparisonOutcome; reason: string }) {
    if (comparison.outcome === 'keeper') throw new Error('DREAM_RENDERED_COMPARISON_REQUIRED');
    return this.compareDiagnostic(aggregateId, expectedRevision, commandId,
      { outcome: comparison.outcome, reason: comparison.reason });
  }

  freezeTransfer(aggregateId: string, expectedRevision: number, commandId: string) {
    return this.transition(aggregateId, expectedRevision, commandId,
      'transfer-frozen', ['finding-proposed'], {});
  }

  recordTransfer(aggregateId: string, expectedRevision: number, commandId: string,
    treatmentEvidenceDigest: string, controlEvidenceDigest: string,
    treatmentArtifactDigest: string, controlArtifactDigest: string) {
    return this.transition(aggregateId, expectedRevision, commandId,
      'transfer-observed', ['transfer-frozen'], { treatmentEvidenceDigest,
        controlEvidenceDigest, treatmentArtifactDigest, controlArtifactDigest });
  }

  validateTransfer(aggregateId: string, expectedRevision: number, commandId: string,
    capability: DreamTransferCapability) {
    if (!this.decisions) throw new Error('DREAM_DECISION_AUTHORITY_MISSING');
    if (this.snapshot(aggregateId).state !== 'transfer-observed') {
      throw new Error('DREAM_STATE_INVALID');
    }
    const { outcome } = this.decisions.transfer(capability, aggregateId);
    const proof = this.decisions.transfer(capability, aggregateId);
    const observed = this.events(aggregateId).find(event => event.type === 'transfer-observed');
    for (const key of ['treatmentEvidenceDigest', 'controlEvidenceDigest',
      'treatmentArtifactDigest', 'controlArtifactDigest'] as const) {
      if (observed?.payload[key] !== proof[key]) throw new Error('DREAM_TRANSFER_EVIDENCE_MISMATCH');
    }
    const type: DreamResearchEventType = outcome === 'validated'
      ? 'finding-validated' : outcome === 'falsified'
        ? 'finding-falsified' : 'finding-inconclusive';
    return this.transition(aggregateId, expectedRevision, commandId,
      type, ['transfer-observed'], { outcome });
  }

  private compareDiagnostic(aggregateId: string, expectedRevision: number,
    commandId: string, comparison: { outcome: Exclude<DreamComparisonOutcome, 'keeper'>;
      reason: string }) {
    const type = comparison.outcome === 'rejected'
      ? 'experiment-rejected' : 'experiment-inconclusive';
    return this.transition(aggregateId, expectedRevision, commandId,
      type, ['variants-observed'], comparison);
  }

  recordHoldoutAccess(aggregateId: string, expectedRevision: number,
    commandId: string, commitmentDigest: string) {
    return this.transition(aggregateId, expectedRevision, commandId,
      'holdout-accessed', ['transfer-frozen'], { commitmentDigest });
  }

  importHistorical(aggregateId: string, expectedRevision: number,
    commandId: string, payload: { sourceKind: string; originalDigest: string;
      originalBase64: string }) {
    return this.transition(aggregateId, expectedRevision, commandId,
      'historical-imported', ['planned'], { ...payload,
        classification: 'historical-non-admissible' });
  }

  snapshot(aggregateId: string): DreamResearchSnapshot {
    return this.journal.projection(aggregateId);
  }

  events(aggregateId: string): DreamResearchEvent[] {
    return this.journal.events(aggregateId);
  }

  async runOperation<T>(aggregateId: string, purpose: string,
    operation: () => Promise<T>, metered = true,
    beforeStart?: () => Promise<void>): Promise<T> {
    const prior = this.completedOperation<T>(aggregateId, purpose);
    if (prior !== null) return prior;
    if (beforeStart) await beforeStart();
    let revision = this.snapshot(aggregateId).revision;
    const reservation = this.reserveAttempt(aggregateId, revision,
      `${aggregateId}:reserve:${purpose}`, purpose, metered);
    revision = this.snapshot(aggregateId).revision;
    this.markTransportStarted(aggregateId, revision,
      `${aggregateId}:transport-start:${purpose}`, reservation.operationId);
    try {
      const response = await operation();
      revision = this.snapshot(aggregateId).revision;
      this.journal.completeOperation({ aggregateId, expectedRevision: revision,
        commandId: `${aggregateId}:transport-complete:${purpose}`,
        operationId: reservation.operationId, response });
      return response;
    } catch (error) {
      revision = this.snapshot(aggregateId).revision;
      this.markAttemptUnknown(aggregateId, revision,
        `${aggregateId}:transport-unknown:${purpose}`, reservation.operationId);
      throw error;
    }
  }

  private completedOperation<T>(aggregateId: string, purpose: string): T | null {
    const reservation = this.events(aggregateId).find(event => event.type === 'operation-reserved'
      && (event.payload.reservation as DreamAttemptReservation).purpose === purpose);
    if (!reservation) return null;
    const operation = (reservation.payload.reservation as DreamAttemptReservation).operationId;
    const completed = this.events(aggregateId).find(event => event.type === 'operation-completed'
      && event.payload.operationId === operation);
    if (!completed) return null;
    const responseDigest = completed.payload.responseDigest;
    if (typeof responseDigest !== 'string') throw new Error('DREAM_OPERATION_RESULT_INVALID');
    return this.journal.operationResult<T>(operation, responseDigest);
  }

  reserveAttempt(aggregateId: string, expectedRevision: number,
    commandId: string, purpose: string, metered = true): DreamAttemptReservation {
    const replay = this.journal.byCommand(commandId);
    if (replay) return replay.payload.reservation as unknown as DreamAttemptReservation;
    const snapshot = this.snapshot(aggregateId);
    this.assertActiveLease(aggregateId);
    if (snapshot.leaseCancelled) throw new Error('DREAM_LEASE_CANCELLED');
    if (snapshot.hasUnknownAttempt) throw new Error('DREAM_ATTEMPT_OUTCOME_UNKNOWN');
    const events = this.events(aggregateId);
    if (events.some(event => event.type === 'operation-outcome-resolved'
      && event.payload.retryForbidden === true && event.payload.purpose === purpose)) {
      throw new Error('DREAM_ATTEMPT_RETRY_FORBIDDEN');
    }
    const reserved = events.filter(event => event.type === 'operation-reserved');
    const completed = new Set(events.filter(event => ['operation-completed',
      'operation-outcome-resolved'].includes(event.type))
      .map(event => event.payload.operationId));
    const outstanding = reserved.find(event => !completed.has(
      (event.payload.reservation as { operationId: string }).operationId));
    if (outstanding) throw new Error('DREAM_ATTEMPT_ALREADY_RESERVED');
    if (metered && snapshot.attemptsStarted >= snapshot.maximumAttempts) {
      throw new Error('DREAM_ATTEMPT_CAP_EXHAUSTED');
    }
    const reservation = Object.freeze({ operationId: operationId(aggregateId, commandId, purpose),
      attempt: metered ? snapshot.attemptsStarted + 1 : 0, purpose, metered });
    this.journal.append({ aggregateId, expectedRevision, commandId,
      type: 'operation-reserved', payload: { reservation } });
    return reservation;
  }

  markTransportStarted(aggregateId: string, expectedRevision: number,
    commandId: string, operation: string) {
    this.assertActiveLease(aggregateId);
    if (this.snapshot(aggregateId).leaseCancelled) throw new Error('DREAM_LEASE_CANCELLED');
    this.assertOperation(aggregateId, operation, 'reserved');
    const reservation = this.operationReservation(aggregateId, operation);
    return this.journal.append({ aggregateId, expectedRevision, commandId,
      type: 'transport-started', payload: { operationId: operation,
        metered: reservation.metered } });
  }

  completeAttempt(aggregateId: string, expectedRevision: number,
    commandId: string, operation: string, responseDigest: string) {
    this.assertOperation(aggregateId, operation, 'started');
    return this.journal.append({ aggregateId, expectedRevision, commandId,
      type: 'operation-completed', payload: { operationId: operation, responseDigest } });
  }

  markAttemptUnknown(aggregateId: string, expectedRevision: number,
    commandId: string, operation: string) {
    this.assertOperation(aggregateId, operation, 'started');
    return this.journal.append({ aggregateId, expectedRevision, commandId,
      type: 'operation-outcome-unknown', payload: { operationId: operation } });
  }

  resolveUnknownAttempt(aggregateId: string, expectedRevision: number,
    commandId: string, operation: string, resolutionDigest: string) {
    this.assertActiveLease(aggregateId);
    const events = this.events(aggregateId);
    const unknown = [...events].reverse().find(
      event => event.type === 'operation-outcome-unknown');
    if (!this.snapshot(aggregateId).hasUnknownAttempt
      || unknown?.payload.operationId !== operation) {
      throw new Error('DREAM_ATTEMPT_NOT_UNKNOWN');
    }
    const reservation = this.operationReservation(aggregateId, operation);
    return this.journal.append({ aggregateId, expectedRevision, commandId,
      type: 'operation-outcome-resolved', payload: { operationId: operation,
        purpose: reservation.purpose, resolutionDigest, retryForbidden: true } });
  }

  cancelLease(aggregateId: string, expectedRevision: number, commandId: string) {
    this.assertActiveLease(aggregateId);
    return this.journal.append({ aggregateId, expectedRevision, commandId,
      type: 'lease-cancelled', payload: {} });
  }

  abandon(aggregateId: string, expectedRevision: number,
    commandId: string, reason: string, capability: DreamRecoveryCapability) {
    if (!this.recovery) throw new Error('DREAM_RECOVERY_AUTHORITY_MISSING');
    this.recovery.assertAbandon(capability, aggregateId, reason);
    if (this.snapshot(aggregateId).state === 'completed') throw new Error('DREAM_ALREADY_COMPLETED');
    return this.journal.append({ aggregateId, expectedRevision, commandId,
      type: 'experiment-abandoned', payload: { reason } });
  }

  private transition(aggregateId: string, expectedRevision: number, commandId: string,
    type: DreamResearchEventType, states: DreamResearchSnapshot['state'][],
    payload: Record<string, unknown>) {
    const replay = this.journal.byCommand(commandId);
    if (replay) return this.journal.append({ aggregateId, expectedRevision,
      commandId, type, payload });
    const snapshot = this.snapshot(aggregateId);
    this.assertActiveLease(aggregateId);
    if (!states.includes(snapshot.state)) throw new Error('DREAM_STATE_INVALID');
    return this.journal.append({ aggregateId, expectedRevision, commandId, type, payload });
  }

  private assertOperation(aggregateId: string, operationIdValue: string,
    required: 'reserved' | 'started'): void {
    const events = this.events(aggregateId);
    const reserved = events.some(event => event.type === 'operation-reserved'
      && (event.payload.reservation as { operationId?: string })?.operationId === operationIdValue);
    const started = events.some(event => event.type === 'transport-started'
      && event.payload.operationId === operationIdValue);
    const terminal = events.some(event => ['operation-completed', 'operation-outcome-unknown']
      .includes(event.type) && event.payload.operationId === operationIdValue);
    if (!reserved || terminal || (required === 'started' && !started)
      || (required === 'reserved' && started)) throw new Error('DREAM_OPERATION_STATE_INVALID');
  }

  private operationReservation(aggregateId: string,
    operationIdValue: string): DreamAttemptReservation {
    const event = this.events(aggregateId).find(item => item.type === 'operation-reserved'
      && (item.payload.reservation as { operationId?: string })?.operationId === operationIdValue);
    if (!event) throw new Error('DREAM_OPERATION_STATE_INVALID');
    return event.payload.reservation as unknown as DreamAttemptReservation;
  }

  private assertActiveLease(aggregateId: string): void {
    if (!this.leaseAuthority) throw new Error('DREAM_LEASE_AUTHORITY_MISSING');
    const plan = this.events(aggregateId)[0]?.payload.plan as DreamExperimentPlan | undefined;
    if (!plan) throw new Error('DREAM_PLAN_INVALID');
    this.leaseAuthority.assertActive(plan.campaignId, plan.lease);
  }
}

function sameValues(value: unknown, expected: readonly string[]): boolean {
  return Array.isArray(value) && value.length === expected.length
    && value.every((item, index) => item === expected[index]);
}
