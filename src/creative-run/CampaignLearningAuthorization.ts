import { createHash } from 'node:crypto';
import type { ExperimentPlan } from './AttributableRevision.js';
import type { CandidateManifest } from './CandidateHypothesisProduction.js';
import { resolveCoordinatorOwnerTransferCheckpoint, type CoordinatorOwnerTransferCheckpoint,
  type LearningAuthorization, type LearningStageReceipt,
  type ProvisionalLearningTransfer } from './CreativeRunCoordinator.js';
import type { CampaignClosureBinding, CampaignClosurePersistence } from './CampaignClosure.js';
import type { EnvelopeAuthority } from './OwnerQualityReview.js';

export interface CampaignLearningAuthorizationEvidence {
  readonly id: string;
  readonly binding: CampaignClosureBinding;
  readonly briefId: string;
  readonly manifestIntentDigest: string;
  readonly manifest: CandidateManifest;
  readonly planDigest: string;
  readonly route: ExperimentPlan['route'];
  readonly revisionReceiptDigest: string;
  readonly authorization: LearningAuthorization;
  readonly stage: LearningStageReceipt;
  readonly provisional: ProvisionalLearningTransfer;
  readonly signatureBase64: string;
  readonly evidenceDigest: string;
}

export interface CampaignLearningAuthorizationState {
  readonly authorizationEvidenceId: string;
  readonly state: 'active' | 'executing' | 'revoked' | 'consumed';
  readonly execution?: CampaignLearningAuthorizationExecution;
  readonly authorizedArms?: readonly CampaignLearningComparisonArm[];
  readonly stateDigest: string;
}

export type CampaignLearningComparisonArm = 'treatment' | 'control';

export interface CampaignLearningAuthorizationExecution {
  readonly authorizationEvidenceId: string;
  readonly authorizationEvidenceDigest: string;
  readonly executionId: string;
  readonly binding: CampaignClosureBinding;
  readonly briefId: string;
  readonly beganAt: string;
  readonly executionDigest: string;
}

export interface CampaignLearningAuthorizationScope {
  readonly binding: CampaignClosureBinding;
  readonly briefId: string;
  readonly now: string;
}

export interface CampaignLearningAuthorizationAuthority {
  sealLearningAuthorization(input: { readonly id: string; readonly binding: CampaignClosureBinding;
    readonly briefId: string; readonly checkpoint: CoordinatorOwnerTransferCheckpoint }):
    Promise<CampaignLearningAuthorizationEvidence>;
  resolveLearningAuthorization(id: string): Promise<CampaignLearningAuthorizationEvidence>;
  resolveLearningAuthorizationState(id: string): Promise<CampaignLearningAuthorizationState>;
  resolveActiveLearningAuthorization(id: string, scope: CampaignLearningAuthorizationScope):
    Promise<CampaignLearningAuthorizationEvidence>;
  beginLearningAuthorizationExecution(id: string, input: CampaignLearningAuthorizationScope & {
    readonly executionId: string }): Promise<CampaignLearningAuthorizationExecution>;
  /** @deprecated Fails closed; callers must identify the gated comparison arm. */
  resolveLearningAuthorizationExecution(id: string, execution: CampaignLearningAuthorizationExecution,
    now: string): Promise<CampaignLearningAuthorizationEvidence>;
  resolveLearningAuthorizationExecution(id: string, execution: CampaignLearningAuthorizationExecution,
    arm: CampaignLearningComparisonArm, now: string): Promise<CampaignLearningAuthorizationEvidence>;
  commitLearningAuthorizationExecution(id: string, execution: CampaignLearningAuthorizationExecution,
    now: string): Promise<CampaignLearningAuthorizationState>;
  abortLearningAuthorizationExecution(id: string, execution: CampaignLearningAuthorizationExecution):
    Promise<CampaignLearningAuthorizationState>;
  consumeLearningAuthorization(id: string): Promise<CampaignLearningAuthorizationState>;
  revokeLearningAuthorization(id: string): Promise<CampaignLearningAuthorizationState>;
}

const evidenceKey = (id: string): string => `campaign-closure:evidence:learning:${id}`;
const stateKey = (id: string): string => `campaign-closure:learning-state:${id}`;

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${stable(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function digest(value: unknown): string {
  return createHash('sha256').update(stable(value)).digest('hex');
}

function state(id: string, status: CampaignLearningAuthorizationState['state'],
  execution?: CampaignLearningAuthorizationExecution,
  authorizedArms?: readonly CampaignLearningComparisonArm[]): CampaignLearningAuthorizationState {
  const body = { authorizationEvidenceId: id, state: status, ...(execution ? { execution } : {}),
    ...(authorizedArms ? { authorizedArms } : {}) };
  return Object.freeze({ ...body, stateDigest: digest(body) });
}

function execution(input: Omit<CampaignLearningAuthorizationExecution, 'executionDigest'>):
CampaignLearningAuthorizationExecution {
  return Object.freeze({ ...input, executionDigest: digest(input) });
}

function sameBinding(left: CampaignClosureBinding, right: CampaignClosureBinding): boolean {
  return left.campaignRunId === right.campaignRunId && left.manifestDigest === right.manifestDigest;
}

function requireTime(value: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error('CAMPAIGN_LEARNING_AUTHORIZATION_TIME_INVALID');
  return parsed;
}

export class DurableCampaignLearningAuthorizationLifecycle
implements CampaignLearningAuthorizationAuthority {
  constructor(private readonly persistence: CampaignClosurePersistence,
    private readonly envelopeAuthority: EnvelopeAuthority) {}

  async sealLearningAuthorization(input: { readonly id: string; readonly binding: CampaignClosureBinding;
    readonly briefId: string; readonly checkpoint: CoordinatorOwnerTransferCheckpoint }):
    Promise<CampaignLearningAuthorizationEvidence> {
    const existingRaw = await this.persistence.read(evidenceKey(input.id));
    if (existingRaw) {
      const existing = await this.resolveLearningAuthorization(input.id);
      if (stable(existing.binding) !== stable(input.binding) || existing.briefId !== input.briefId) {
        throw new Error('CAMPAIGN_CLOSURE_EVIDENCE_IMMUTABLE');
      }
      await this.ensureState(input.id);
      return existing;
    }
    const transfer = resolveCoordinatorOwnerTransferCheckpoint(input.checkpoint);
    if (transfer.authorization.decision !== 'allow' || transfer.stage.status !== 'staged'
      || !transfer.stage.provisional
      || transfer.provisional.authorizationDigest !== transfer.authorization.authorizationDigest
      || transfer.provisional.planDigest !== transfer.plan.planDigest
      || transfer.provisional.revisionReceiptDigest !== transfer.revision.receiptDigest) {
      throw new Error('CAMPAIGN_LEARNING_AUTHORIZATION_INVALID');
    }
    const unsigned = { id: input.id, binding: input.binding, briefId: input.briefId,
      manifestIntentDigest: digest(transfer.manifest.intent), manifest: transfer.manifest,
      planDigest: transfer.plan.planDigest, route: transfer.plan.route,
      revisionReceiptDigest: transfer.revision.receiptDigest, authorization: transfer.authorization,
      stage: transfer.stage, provisional: transfer.provisional };
    const evidence = Object.freeze({ ...unsigned,
      signatureBase64: this.envelopeAuthority.signReview(unsigned), evidenceDigest: digest(unsigned) });
    await this.putIfAbsent(input.id, evidence);
    await this.ensureState(input.id);
    return evidence;
  }

  async resolveLearningAuthorization(id: string): Promise<CampaignLearningAuthorizationEvidence> {
    const raw = await this.persistence.read(evidenceKey(id));
    if (!raw) throw new Error(`CAMPAIGN_CLOSURE_EVIDENCE_MISSING:learning:${id}`);
    const value = JSON.parse(raw) as CampaignLearningAuthorizationEvidence;
    const { signatureBase64: _signature, evidenceDigest: _digest, ...body } = value;
    if (value.id !== id || value.evidenceDigest !== digest(body)
      || !this.envelopeAuthority.verifyReview(body, value.signatureBase64)) {
      throw new Error('CAMPAIGN_CLOSURE_EVIDENCE_SIGNATURE_INVALID');
    }
    this.assertEvidence(value);
    return Object.freeze(value);
  }

  async resolveLearningAuthorizationState(id: string): Promise<CampaignLearningAuthorizationState> {
    await this.resolveLearningAuthorization(id);
    return this.readState(id);
  }

  async resolveActiveLearningAuthorization(id: string, scope: CampaignLearningAuthorizationScope):
    Promise<CampaignLearningAuthorizationEvidence> {
    const evidence = await this.resolveLearningAuthorization(id);
    this.assertScope(evidence, scope);
    if ((await this.readState(id)).state !== 'active') {
      throw new Error('CAMPAIGN_LEARNING_AUTHORIZATION_NOT_ACTIVE');
    }
    return evidence;
  }

  async beginLearningAuthorizationExecution(id: string, input: CampaignLearningAuthorizationScope & {
    readonly executionId: string }): Promise<CampaignLearningAuthorizationExecution> {
    if (!input.executionId.trim()) throw new Error('CAMPAIGN_LEARNING_EXECUTION_ID_REQUIRED');
    const evidence = await this.resolveLearningAuthorization(id);
    this.assertScope(evidence, input);
    return this.persistence.claim(stateKey(id), async () => {
      const prior = await this.readStateUnlocked(id);
      const nextExecution = execution({ authorizationEvidenceId: id,
        authorizationEvidenceDigest: evidence.evidenceDigest, executionId: input.executionId,
        binding: evidence.binding, briefId: evidence.briefId, beganAt: input.now });
      if (prior.state === 'executing' && stable(prior.execution) === stable(nextExecution)) return nextExecution;
      if (prior.state !== 'active') throw new Error('CAMPAIGN_LEARNING_AUTHORIZATION_NOT_ACTIVE');
      await this.persistence.write(stateKey(id), JSON.stringify(state(id, 'executing', nextExecution, [])));
      return nextExecution;
    });
  }

  async resolveLearningAuthorizationExecution(id: string, value: CampaignLearningAuthorizationExecution,
    now: string): Promise<CampaignLearningAuthorizationEvidence>;
  async resolveLearningAuthorizationExecution(id: string, value: CampaignLearningAuthorizationExecution,
    arm: CampaignLearningComparisonArm, now: string): Promise<CampaignLearningAuthorizationEvidence>;
  async resolveLearningAuthorizationExecution(id: string, value: CampaignLearningAuthorizationExecution,
    armOrNow: CampaignLearningComparisonArm | string, now?: string): Promise<CampaignLearningAuthorizationEvidence> {
    if (!now) throw new Error('CAMPAIGN_LEARNING_EXECUTION_ARM_REQUIRED');
    const arm = armOrNow as CampaignLearningComparisonArm;
    if (arm !== 'treatment' && arm !== 'control') throw new Error('CAMPAIGN_LEARNING_EXECUTION_ARM_INVALID');
    const evidence = await this.resolveLearningAuthorization(id);
    if (value.authorizationEvidenceDigest !== evidence.evidenceDigest) {
      throw new Error('CAMPAIGN_LEARNING_EXECUTION_BINDING_INVALID');
    }
    this.assertScope(evidence, { binding: value.binding, briefId: value.briefId, now });
    this.assertExecutionTime(value, now);
    await this.persistence.claim(stateKey(id), async () => {
      const current = await this.readStateUnlocked(id);
      this.assertExecutionMatches(id, current, value);
      const arms = current.authorizedArms ?? [];
      if (!arms.includes(arm)) await this.persistence.write(stateKey(id),
        JSON.stringify(state(id, 'executing', value, [...arms, arm])));
    });
    return evidence;
  }

  async commitLearningAuthorizationExecution(id: string, value: CampaignLearningAuthorizationExecution,
    now: string): Promise<CampaignLearningAuthorizationState> {
    const evidence = await this.resolveLearningAuthorization(id);
    if (value.authorizationEvidenceDigest !== evidence.evidenceDigest) {
      throw new Error('CAMPAIGN_LEARNING_EXECUTION_BINDING_INVALID');
    }
    this.assertScope(evidence, { binding: value.binding, briefId: value.briefId, now });
    this.assertExecutionTime(value, now);
    return this.persistence.claim(stateKey(id), async () => {
      const prior = await this.readStateUnlocked(id);
      if (prior.state === 'consumed') {
        if (prior.execution && stable(prior.execution) === stable(value)) return prior;
        throw new Error('CAMPAIGN_LEARNING_EXECUTION_BINDING_INVALID');
      }
      this.assertExecutionMatches(id, prior, value);
      if (prior.authorizedArms?.length !== 2
        || !prior.authorizedArms.includes('treatment') || !prior.authorizedArms.includes('control')) {
        throw new Error('CAMPAIGN_LEARNING_COMPARISON_INCOMPLETE');
      }
      const next = state(id, 'consumed', value, prior.authorizedArms);
      await this.persistence.write(stateKey(id), JSON.stringify(next));
      return next;
    });
  }

  async abortLearningAuthorizationExecution(id: string, value: CampaignLearningAuthorizationExecution):
    Promise<CampaignLearningAuthorizationState> {
    await this.resolveLearningAuthorization(id);
    return this.persistence.claim(stateKey(id), async () => {
      const prior = await this.readStateUnlocked(id);
      this.assertExecutionMatches(id, prior, value);
      const next = state(id, 'active');
      await this.persistence.write(stateKey(id), JSON.stringify(next));
      return next;
    });
  }

  async consumeLearningAuthorization(id: string): Promise<CampaignLearningAuthorizationState> {
    await this.resolveLearningAuthorization(id);
    throw new Error('CAMPAIGN_LEARNING_AUTHORIZATION_EXECUTION_REQUIRED');
  }

  async revokeLearningAuthorization(id: string): Promise<CampaignLearningAuthorizationState> {
    await this.resolveLearningAuthorization(id);
    return this.persistence.claim(stateKey(id), async () => {
      const prior = await this.readStateUnlocked(id);
      if (prior.state === 'revoked') return prior;
      if (prior.state !== 'active') throw new Error('CAMPAIGN_LEARNING_AUTHORIZATION_NOT_ACTIVE');
      const next = state(id, 'revoked');
      await this.persistence.write(stateKey(id), JSON.stringify(next));
      return next;
    });
  }

  private async putIfAbsent(id: string, value: CampaignLearningAuthorizationEvidence): Promise<void> {
    await this.persistence.claim(evidenceKey(id), async () => {
      const prior = await this.persistence.read(evidenceKey(id));
      if (prior && stable(JSON.parse(prior)) !== stable(value)) {
        throw new Error('CAMPAIGN_CLOSURE_EVIDENCE_IMMUTABLE');
      }
      if (!prior) await this.persistence.write(evidenceKey(id), JSON.stringify(value));
    });
  }

  private async ensureState(id: string): Promise<CampaignLearningAuthorizationState> {
    return this.persistence.claim(stateKey(id), async () => {
      const raw = await this.persistence.read(stateKey(id));
      if (raw) return this.parseState(id, raw);
      const initial = state(id, 'active');
      await this.persistence.write(stateKey(id), JSON.stringify(initial));
      return initial;
    });
  }

  private async readState(id: string): Promise<CampaignLearningAuthorizationState> {
    return this.persistence.claim(stateKey(id), () => this.readStateUnlocked(id));
  }

  private async readStateUnlocked(id: string): Promise<CampaignLearningAuthorizationState> {
    const raw = await this.persistence.read(stateKey(id));
    if (!raw) throw new Error('CAMPAIGN_LEARNING_AUTHORIZATION_STATE_MISSING');
    return this.parseState(id, raw);
  }

  private assertEvidence(value: CampaignLearningAuthorizationEvidence): void {
    const authorization = value.authorization;
    const provisional = value.provisional;
    const { authorizationDigest: _authorizationDigest, ...authorizationBody } = authorization;
    const { provisionalDigest: _provisionalDigest, ...provisionalBody } = provisional;
    const { receiptDigest: _stageDigest, ...stageBody } = value.stage;
    if (authorization.schema !== 'sinter.learning-authorization' || authorization.schemaVersion !== 1
      || authorization.decision !== 'allow' || authorization.initialRevocationState !== 'active'
      || authorization.maximumTransfers !== 1
      || provisional.schema !== 'sinter.provisional-learning-transfer' || provisional.schemaVersion !== 1
      || value.stage.schema !== 'sinter.learning-stage-receipt' || value.stage.schemaVersion !== 1
      || value.stage.status !== 'staged' || value.stage.reason !== 'STAGED' || !value.stage.provisional
      || authorization.authorizationDigest !== createHash('sha256').update(JSON.stringify(authorizationBody)).digest('hex')
      || provisional.provisionalDigest !== createHash('sha256').update(JSON.stringify(provisionalBody)).digest('hex')
      || value.stage.receiptDigest !== createHash('sha256').update(JSON.stringify(stageBody)).digest('hex')
      || digest(value.manifest.intent) !== value.manifestIntentDigest
      || value.stage.provisional.provisionalDigest !== provisional.provisionalDigest
      || authorization.planDigest !== value.planDigest
      || !value.route.provider || !value.route.model
      || authorization.revisionReceiptDigest !== value.revisionReceiptDigest
      || provisional.authorizationDigest !== authorization.authorizationDigest
      || provisional.ruleId !== authorization.ruleId
      || provisional.artifactDigest !== authorization.artifactDigest
      || provisional.planDigest !== value.planDigest
      || provisional.revisionReceiptDigest !== value.revisionReceiptDigest) {
      throw new Error('CAMPAIGN_LEARNING_AUTHORIZATION_INVALID');
    }
  }

  private assertScope(value: CampaignLearningAuthorizationEvidence,
    scope: CampaignLearningAuthorizationScope): void {
    const now = requireTime(scope.now);
    const issuedAt = requireTime(value.authorization.issuedAt);
    const expiresAt = requireTime(value.authorization.expiresAt);
    if (!sameBinding(value.binding, scope.binding) || value.briefId !== scope.briefId) {
      throw new Error('CAMPAIGN_LEARNING_AUTHORIZATION_SCOPE_MISMATCH');
    }
    if (expiresAt <= issuedAt) throw new Error('CAMPAIGN_LEARNING_AUTHORIZATION_TIME_INVALID');
    if (now < issuedAt) throw new Error('CAMPAIGN_LEARNING_AUTHORIZATION_NOT_YET_VALID');
    if (now >= expiresAt) throw new Error('CAMPAIGN_LEARNING_AUTHORIZATION_EXPIRED');
  }

  private assertExecutionTime(value: CampaignLearningAuthorizationExecution, now: string): void {
    if (requireTime(now) < requireTime(value.beganAt)) {
      throw new Error('CAMPAIGN_LEARNING_EXECUTION_TIME_INVALID');
    }
  }

  private assertExecutionMatches(id: string, current: CampaignLearningAuthorizationState,
    value: CampaignLearningAuthorizationExecution): void {
    const { executionDigest: _digest, ...body } = value;
    if (value.authorizationEvidenceId !== id || value.executionDigest !== digest(body)
      || current.state !== 'executing' || !current.execution
      || stable(current.execution) !== stable(value)) {
      throw new Error('CAMPAIGN_LEARNING_EXECUTION_BINDING_INVALID');
    }
  }

  private parseState(id: string, raw: string): CampaignLearningAuthorizationState {
    const value = JSON.parse(raw) as CampaignLearningAuthorizationState;
    const body = { authorizationEvidenceId: value.authorizationEvidenceId, state: value.state,
      ...(value.execution ? { execution: value.execution } : {}),
      ...(value.authorizedArms ? { authorizedArms: value.authorizedArms } : {}) };
    const hasExecution = value.state === 'executing' || value.state === 'consumed';
    if (value.authorizationEvidenceId !== id || !['active', 'executing', 'revoked', 'consumed'].includes(value.state)
      || hasExecution !== Boolean(value.execution)
      || hasExecution !== Array.isArray(value.authorizedArms)
      || (value.state === 'consumed' && (value.authorizedArms?.length !== 2
        || !value.authorizedArms.includes('treatment') || !value.authorizedArms.includes('control')))
      || (value.authorizedArms && (new Set(value.authorizedArms).size !== value.authorizedArms.length
        || value.authorizedArms.some((arm) => arm !== 'treatment' && arm !== 'control')))
      || value.stateDigest !== digest(body)) throw new Error('CAMPAIGN_LEARNING_AUTHORIZATION_STATE_INVALID');
    if (value.execution) {
      const { executionDigest: _digest, ...executionBody } = value.execution;
      if (value.execution.authorizationEvidenceId !== id
        || value.execution.executionDigest !== digest(executionBody)) {
        throw new Error('CAMPAIGN_LEARNING_AUTHORIZATION_STATE_INVALID');
      }
    }
    return Object.freeze(value);
  }
}
