import { createHash } from 'node:crypto';
import { createDreamFindingAdmission } from '../dreaming/research/DreamLearningAdmission.js';
import { DreamLearningGateway } from '../dreaming/research/DreamLearningGateway.js';
import { CreativeKnowledgeConsolidator, type ActivatedKnowledgeSnapshot,
  type CreativeKnowledgePolicy } from '../dreaming/research/DreamKnowledgeActivation.js';
import type { DreamHoldoutCapability } from '../dreaming/research/DreamHoldoutVault.js';
import type { DreamResearchService } from '../dreaming/research/DreamResearchService.js';
import type { DreamTransferEvaluator, DreamTransferProducer,
  DreamTransferRunner } from '../dreaming/research/DreamTransferRunner.js';
import type { DreamRenderedObserver } from '../dreaming/research/DreamRenderedExperimentExecutor.js';
import type { DreamProductProjection, DreamProductProjectionStore }
  from './DreamProductCommandPort.js';
import { FileLiminalProductCommandStore } from './LiminalProductCommandPort.js';

const stable = (value: unknown): string => {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map(key =>
    `${JSON.stringify(key)}:${stable(record[key])}`).join(',')}}`;
};
const digest = (value: unknown): string => createHash('sha256').update(stable(value)).digest('hex');
const principleDigest = (dream: DreamProductProjection): string => digest({
  principle: dream.experimentPlan.hypothesis.principle,
  expectedEffect: dream.experimentPlan.hypothesis.expectedEffect,
});

export interface DreamTransferCommand {
  schema: 'sinter.dream-transfer-command'; schemaVersion: 1;
  idempotencyKey: string; dreamKey: string;
}

export interface DreamTransferProjection {
  kind: 'dream-transfer'; status: 'completed'; commandDigest: string;
  dreamKey: string; dreamProjectionDigest: string; aggregateId: string;
  outcome: 'validated' | 'falsified' | 'inconclusive'; transferEvidenceDigest: string;
}

export interface DreamActivationCommand {
  schema: 'sinter.dream-activation-command'; schemaVersion: 1;
  idempotencyKey: string; transferKeys: readonly string[];
}

export interface DreamActivationProjection {
  kind: 'dream-activation'; status: 'completed'; commandDigest: string;
  activationPolicyDigest: string;
  transferProjectionDigests: readonly string[]; independentStudyDigests: readonly string[];
  snapshot: ActivatedKnowledgeSnapshot;
}

export interface DreamActivationPolicy {
  readonly policyDigest: string;
  readonly knowledge: CreativeKnowledgePolicy;
  readonly compilerRuleVersion: number;
  readonly compilerRulePrefix: string;
  readonly contraindications: readonly string[];
}

export function sealDreamActivationPolicy(input: Omit<DreamActivationPolicy,
  'policyDigest'>): DreamActivationPolicy {
  if (!Object.isFrozen(input.knowledge) || !Object.isFrozen(input.knowledge.allowedScopes)
    || !input.compilerRulePrefix.trim() || !Number.isSafeInteger(input.compilerRuleVersion)) {
    throw new Error('DREAM_ACTIVATION_POLICY_INVALID');
  }
  const body = { knowledge: input.knowledge, compilerRuleVersion: input.compilerRuleVersion,
    compilerRulePrefix: input.compilerRulePrefix,
    contraindications: Object.freeze([...input.contraindications]) };
  return Object.freeze({ ...body, policyDigest: digest(body) });
}

interface ProjectionStore<T> {
  read(key: string): Promise<T | null>;
  write(key: string, value: T): Promise<void>;
  withLease<R>(key: string, operation: () => Promise<R>): Promise<R>;
}

export class FileDreamProjectionStore<T> implements ProjectionStore<T> {
  private readonly inner: FileLiminalProductCommandStore;
  constructor(file: string) { this.inner = new FileLiminalProductCommandStore(file); }
  async read(key: string): Promise<T | null> {
    return await this.inner.read(key) as unknown as T | null;
  }
  async write(key: string, value: T): Promise<void> {
    await this.inner.write(key, value as never);
  }
  withLease<R>(key: string, operation: () => Promise<R>): Promise<R> {
    return this.inner.withLease(key, operation);
  }
}

export interface DreamTransferHostComposition {
  /** One capability, or a per-study assigner over a precommitted pool (F02). */
  holdout: DreamHoldoutCapability | ((aggregateId: string) => DreamHoldoutCapability);
  producer: DreamTransferProducer;
  producerIdentityDigest?: string;
  observer: DreamRenderedObserver;
  evaluators: readonly [DreamTransferEvaluator, DreamTransferEvaluator];
}

/** Product-owned transfer path. Callers name a keeper; the host owns every executor. */
export class DreamTransferCommandPort {
  constructor(private readonly dreams: DreamProductProjectionStore,
    private readonly service: DreamResearchService,
    private readonly runner: DreamTransferRunner,
    private readonly host: DreamTransferHostComposition,
    private readonly store: ProjectionStore<DreamTransferProjection>) {}

  async run(command: DreamTransferCommand): Promise<DreamTransferProjection> {
    this.validate(command);
    const commandDigest = digest(command);
    return this.store.withLease(command.idempotencyKey, async () => {
      const existing = await this.store.read(command.idempotencyKey);
      if (existing) {
        if (existing.commandDigest !== commandDigest) throw new Error('IDEMPOTENCY_KEY_REBOUND');
        await this.assertProjection(existing);
        return existing;
      }
      const dream = await this.dreams.read(command.dreamKey);
      if (!dream || dream.outcome !== 'keeper' || dream.state !== 'finding-proposed') {
        throw new Error('DREAM_TRANSFER_KEEPER_REQUIRED');
      }
      if (!dream.experimentPlan.context.liminalParentBindings?.length) {
        throw new Error('DREAM_TRANSFER_HISTORICAL_NON_ADMISSIBLE');
      }
      const recovered = this.completed(command, commandDigest, dream);
      if (recovered) { await this.store.write(command.idempotencyKey, recovered); return recovered; }
      const snapshot = this.service.snapshot(dream.experimentPlan.aggregateId);
      if (snapshot.maximumAttempts - snapshot.attemptsStarted !== 4) {
        throw new Error('DREAM_TRANSFER_EXACT_BUDGET_REQUIRED');
      }
      await this.runner.run({ aggregateId: dream.experimentPlan.aggregateId,
        holdout: typeof this.host.holdout === 'function'
          ? this.host.holdout(dream.experimentPlan.aggregateId) : this.host.holdout,
        requiredModalities: [...dream.experimentPlan.requiredModalities],
        producer: this.host.producer,
        producerIdentityDigest: this.host.producerIdentityDigest,
        evaluators: this.host.evaluators });
      const projection = this.completed(command, commandDigest, dream);
      if (!projection) throw new Error('DREAM_TRANSFER_NOT_TERMINAL');
      await this.store.write(command.idempotencyKey, projection);
      return projection;
    });
  }

  async projection(key: string): Promise<DreamTransferProjection | null> {
    const value = await this.store.read(key);
    if (value) await this.assertProjection(value);
    return value;
  }

  private completed(command: DreamTransferCommand, commandDigest: string,
    dream: DreamProductProjection): DreamTransferProjection | null {
    const events = this.service.events(dream.experimentPlan.aggregateId);
    const terminal = [...events].reverse().find(event =>
      ['finding-validated', 'finding-falsified', 'finding-inconclusive'].includes(event.type));
    const transfer = events.find(event => event.type === 'transfer-observed');
    if (!terminal || !transfer) return null;
    const outcome = terminal.type === 'finding-validated' ? 'validated'
      : terminal.type === 'finding-falsified' ? 'falsified' : 'inconclusive';
    return Object.freeze({ kind: 'dream-transfer', status: 'completed', commandDigest,
      dreamKey: command.dreamKey, dreamProjectionDigest: digest(dream),
      aggregateId: dream.experimentPlan.aggregateId, outcome,
      transferEvidenceDigest: transfer.eventDigest });
  }

  private async assertProjection(value: DreamTransferProjection): Promise<void> {
    const dream = await this.dreams.read(value.dreamKey);
    const events = this.service.events(value.aggregateId);
    const transfer = events.find(event => event.type === 'transfer-observed');
    const snapshot = this.service.snapshot(value.aggregateId);
    const expected = snapshot.finding === 'validated' ? 'validated'
      : snapshot.finding === 'falsified' ? 'falsified' : 'inconclusive';
    if (!dream || digest(dream) !== value.dreamProjectionDigest
      || dream.experimentPlan.aggregateId !== value.aggregateId
      || snapshot.state !== 'completed' || value.outcome !== expected
      || transfer?.eventDigest !== value.transferEvidenceDigest) {
      throw new Error('DREAM_TRANSFER_PROJECTION_INVALID');
    }
  }

  private validate(command: DreamTransferCommand): void {
    if (command.schema !== 'sinter.dream-transfer-command' || command.schemaVersion !== 1
      || !command.idempotencyKey?.trim() || !command.dreamKey?.trim()) {
      throw new Error('DREAM_TRANSFER_COMMAND_INVALID');
    }
  }
}

/** Consolidates only repeated, independently validated durable transfer projections. */
export class DreamActivationCommandPort {
  private readonly gateway: DreamLearningGateway;
  constructor(private readonly transfers: DreamTransferCommandPort,
    private readonly dreams: DreamProductProjectionStore,
    private readonly service: DreamResearchService,
    private readonly consolidator: CreativeKnowledgeConsolidator,
    private readonly policy: DreamActivationPolicy,
    private readonly store: ProjectionStore<DreamActivationProjection>) {
    this.gateway = new DreamLearningGateway(service);
  }

  async run(command: DreamActivationCommand): Promise<DreamActivationProjection> {
    this.validate(command);
    const commandDigest = digest(command);
    return this.store.withLease(command.idempotencyKey, async () => {
      const existing = await this.store.read(command.idempotencyKey);
      if (existing) {
        if (existing.commandDigest !== commandDigest) throw new Error('IDEMPOTENCY_KEY_REBOUND');
        await this.assertProjection(command, existing);
        return existing;
      }
      const studies = await Promise.all(command.transferKeys.map(key => this.study(key)));
      this.assertIndependent(studies);
      const admissions = studies.map(item => this.admission(item.transfer.aggregateId));
      const capabilities = admissions.map(item => this.gateway.authorize(item));
      const hypothesis = studies[0]!.dream.experimentPlan.hypothesis;
      const scope = [...new Set(studies.flatMap(item =>
        item.dream.experimentPlan.requiredModalities))]
        .filter(item => this.policy.knowledge.allowedScopes.includes(item));
      const studyDigests = studies.map(item => item.studyDigest);
      const transferEvidenceDigests = studies.map(item => item.transfer.transferEvidenceDigest);
      const snapshot = await this.consolidator.activate({ principleIds: [principleDigest(
        studies[0]!.dream)],
        compilerRules: [`${this.policy.compilerRulePrefix}${hypothesis.principle}: ${hypothesis.expectedEffect}`],
        scope, contraindications: this.policy.contraindications, repetitions: studies.length,
        independentStudyDigests: studyDigests, transferEvidenceDigests,
        compilerRuleVersion: this.policy.compilerRuleVersion }, this.policy.knowledge, capabilities);
      const projection = Object.freeze({ kind: 'dream-activation' as const,
        status: 'completed' as const, commandDigest,
        activationPolicyDigest: this.policy.policyDigest,
        transferProjectionDigests: studies.map(item => digest(item.transfer)),
        independentStudyDigests: studyDigests, snapshot });
      await this.store.write(command.idempotencyKey, projection);
      return projection;
    });
  }

  private async study(key: string) {
    const transfer = await this.transfers.projection(key);
    if (!transfer || transfer.outcome !== 'validated') {
      throw new Error('DREAM_ACTIVATION_VALIDATED_TRANSFER_REQUIRED');
    }
    const dream = await this.dreams.read(transfer.dreamKey);
    if (!dream || digest(dream) !== transfer.dreamProjectionDigest
      || dream.experimentPlan.aggregateId !== transfer.aggregateId) {
      throw new Error('DREAM_ACTIVATION_DREAM_BINDING_INVALID');
    }
    const plan = dream.experimentPlan;
    return { transfer, dream, studyDigest: digest({ aggregateId: plan.aggregateId,
      principleDigest: principleDigest(dream), parentSetDigest: plan.context.parentSetDigest,
      sourceDigests: plan.context.sourceDigests,
      evaluatorManifestDigests: plan.context.evaluatorManifestDigests }) };
  }

  private async assertProjection(command: DreamActivationCommand,
    value: DreamActivationProjection): Promise<void> {
    const studies = await Promise.all(command.transferKeys.map(key => this.study(key)));
    this.assertIndependent(studies);
    const transferDigests = studies.map(item => digest(item.transfer));
    const studyDigests = studies.map(item => item.studyDigest);
    const admissions = studies.map(item => this.admission(item.transfer.aggregateId));
    const admissionDigests = admissions.map(item => item.admissionDigest);
    const transferEvidenceDigests = admissions.map(item => item.transferEvidenceDigest);
    if (!this.consolidator.verify(value.snapshot)
      || value.activationPolicyDigest !== this.policy.policyDigest
      || value.snapshot.policyDigest !== this.policy.knowledge.policyDigest
      || stable(value.snapshot.admissionDigests) !== stable(admissionDigests)
      || value.snapshot.admissionDigest !== admissionDigests[0]
      || value.snapshot.repetitions !== studies.length
      || stable(value.snapshot.independentStudyDigests) !== stable(studyDigests)
      || stable(value.snapshot.transferEvidenceDigests) !== stable(transferEvidenceDigests)
      || stable(value.snapshot.contraindications) !== stable(this.policy.contraindications)
      || value.snapshot.compilerRuleVersion !== this.policy.compilerRuleVersion
      || stable(value.transferProjectionDigests) !== stable(transferDigests)
      || stable(value.independentStudyDigests) !== stable(studyDigests)) {
      throw new Error('DREAM_ACTIVATION_PROJECTION_INVALID');
    }
  }

  private admission(aggregateId: string) {
    const events = this.service.events(aggregateId);
    const finding = events.find(event => event.type === 'finding-proposed');
    const baseline = events.find(event => event.type === 'baseline-observed');
    const variants = events.find(event => event.type === 'variants-observed');
    const transfer = events.find(event => event.type === 'transfer-observed');
    if (!finding || !baseline || !variants || !transfer) {
      throw new Error('DREAM_ACTIVATION_JOURNAL_INCOMPLETE');
    }
    return createDreamFindingAdmission({ aggregateId, findingDigest: finding.eventDigest,
      artifactDigests: [...(variants.payload.artifactDigests as string[]),
        transfer.payload.treatmentArtifactDigest as string,
        transfer.payload.controlArtifactDigest as string],
      evidenceDigests: [baseline.payload.evidenceDigest as string,
        ...(variants.payload.evidenceDigests as string[]),
        transfer.payload.treatmentEvidenceDigest as string,
        transfer.payload.controlEvidenceDigest as string],
      transferEvidenceDigest: transfer.eventDigest, state: 'validated' });
  }

  private assertIndependent(studies: Array<{ transfer: DreamTransferProjection;
    dream: DreamProductProjection; studyDigest: string }>): void {
    if (studies.length < 2 || studies.length < this.policy.knowledge.minimumRepetitions
      || studies.length < this.policy.knowledge.minimumIndependentStudies) {
      throw new Error('DREAM_ACTIVATION_REPETITIONS_INSUFFICIENT');
    }
    const hypothesisIds = new Set(studies.map(item => principleDigest(item.dream)));
    const parents = new Set(studies.map(item =>
      item.dream.experimentPlan.context.parentSetDigest));
    const sources = studies.flatMap(item => item.dream.experimentPlan.context.sourceDigests);
    if (hypothesisIds.size !== 1 || parents.size !== studies.length
      || new Set(sources).size !== sources.length) {
      throw new Error('DREAM_ACTIVATION_STUDIES_CORRELATED');
    }
    // Studies validated against one shared holdout are one observation, however many aggregates ran (F02).
    const commitments = new Set(studies.map(item => item.dream.experimentPlan.context.transferCommitmentDigest));
    if (commitments.size !== studies.length) throw new Error('DREAM_ACTIVATION_HOLDOUT_REUSED');
  }

  private validate(command: DreamActivationCommand): void {
    const { policyDigest, ...policyBody } = this.policy;
    if (command.schema !== 'sinter.dream-activation-command' || command.schemaVersion !== 1
      || !command.idempotencyKey?.trim() || !Array.isArray(command.transferKeys)
      || command.transferKeys.some(key => !key.trim())
      || new Set(command.transferKeys).size !== command.transferKeys.length) {
      throw new Error('DREAM_ACTIVATION_COMMAND_INVALID');
    }
    if (!Object.isFrozen(this.policy) || policyDigest !== digest(policyBody)) {
      throw new Error('DREAM_ACTIVATION_POLICY_INVALID');
    }
  }
}
