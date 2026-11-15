import { createHash } from 'node:crypto';
import type { LiminalCreativeCommand } from './LiminalCommandService.js';
import type { LiminalProductCommandPort, LiminalProductProjection }
  from './LiminalProductCommandPort.js';
import type { DreamActivationCommand, DreamActivationCommandPort,
  DreamActivationProjection } from './DreamTransferActivationPort.js';

const DIGEST = /^[a-f0-9]{64}$/;
const stable = (value: unknown): string => {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map(key =>
    `${JSON.stringify(key)}:${stable(record[key])}`).join(',')}}`;
};
const digest = (value: unknown): string =>
  createHash('sha256').update(stable(value)).digest('hex');

export interface CompoundCreateTask {
  readonly taskId: string; readonly prompt: string; readonly domain: string;
  readonly layers: readonly string[]; readonly targetScope: string;
  readonly maxTransportAttempts: number;
  readonly doctrineDigest?: string;
}

export interface CompoundArmAssignment {
  readonly taskId: string; readonly firstArmId: string; readonly secondArmId: string;
  readonly treatmentPosition: 0 | 1;
}

export interface CompoundCreatePolicy {
  readonly schema: 'sinter.compound-create-policy'; readonly schemaVersion: 1;
  readonly tasks: readonly CompoundCreateTask[];
  readonly assignments: readonly CompoundArmAssignment[];
  readonly judgeIdentityDigests: readonly [string, string];
  readonly criterionDigest: string;
  readonly executionContextDigest: string;
  readonly minimumEffectSize: number; readonly maximumJudgeDisagreement: number;
  readonly regressionVetoThreshold: number; readonly aggregation: 'mean-delta';
  readonly sampleCount: number; readonly minimumTaskWins: number;
  readonly policyDigest: string;
}

export function sealCompoundCreatePolicy(input: Omit<CompoundCreatePolicy,
  'schema' | 'schemaVersion' | 'policyDigest'>): CompoundCreatePolicy {
  const tasks = Object.freeze(input.tasks.map(task => Object.freeze({ ...task,
    layers: Object.freeze([...task.layers]) })));
  const assignments = Object.freeze(input.assignments.map(item => Object.freeze({ ...item })));
  const body = Object.freeze({ schema: 'sinter.compound-create-policy' as const,
    schemaVersion: 1 as const, tasks, assignments,
    judgeIdentityDigests: Object.freeze([...input.judgeIdentityDigests]) as
      unknown as readonly [string, string], criterionDigest: input.criterionDigest,
    executionContextDigest: input.executionContextDigest,
    minimumEffectSize: input.minimumEffectSize,
    maximumJudgeDisagreement: input.maximumJudgeDisagreement,
    regressionVetoThreshold: input.regressionVetoThreshold,
    aggregation: input.aggregation, sampleCount: input.sampleCount,
    minimumTaskWins: input.minimumTaskWins });
  validatePolicy(body);
  return Object.freeze({ ...body, policyDigest: digest(body) });
}

export interface CompoundBlindedArm {
  readonly armId: string; readonly taskId: string; readonly artifactDigest: string;
  readonly evidenceDigest: string; readonly domain: string;
}

export interface CompoundCreateJudgment {
  readonly judgeIdentityDigest: string; readonly criterionDigest: string;
  readonly armScores: Readonly<Record<string, number>>;
  readonly signature: string;
}

export interface CompoundCreateJudge {
  readonly identityDigest: string;
  compare(input: { readonly policyDigest: string; readonly taskId: string;
    readonly arms: readonly [CompoundBlindedArm, CompoundBlindedArm] }):
    Promise<CompoundCreateJudgment>;
  verify(judgment: CompoundCreateJudgment, input: { readonly policyDigest: string;
    readonly taskId: string; readonly arms: readonly [CompoundBlindedArm,
      CompoundBlindedArm] }): boolean;
}

export interface CompoundCreateCommand {
  readonly schema: 'sinter.compound-create-command'; readonly schemaVersion: 1;
  readonly idempotencyKey: string; readonly activation: DreamActivationCommand;
}

export interface CompoundCreateTrial {
  readonly taskId: string; readonly controlCreateKey: string;
  readonly treatmentCreateKey: string; readonly controlArtifactDigest: string;
  readonly treatmentArtifactDigest: string; readonly controlEvidenceDigest: string;
  readonly treatmentEvidenceDigest: string; readonly knowledgeApplicationDigest: string;
  readonly judgments: readonly [CompoundCreateJudgment, CompoundCreateJudgment];
  readonly meanDelta: number; readonly judgeDisagreement: number;
  readonly regressionVetoed: boolean;
}

export interface CompoundCreateProjection {
  readonly kind: 'compound-create'; readonly status: 'completed';
  readonly outcome: 'compound-proven' | 'regressed' | 'uncertain';
  readonly commandDigest: string; readonly policyDigest: string;
  readonly activationProjectionDigest: string; readonly snapshotDigest: string;
  readonly frozenAssignmentDigest: string; readonly trials: readonly CompoundCreateTrial[];
  readonly aggregateEffect: number; readonly projectionDigest: string;
}

export interface CompoundCreateProjectionStore {
  read(key: string): Promise<CompoundCreateProjection | null>;
  write(key: string, value: CompoundCreateProjection): Promise<void>;
  withLease<T>(key: string, operation: () => Promise<T>): Promise<T>;
}

export interface CompoundCreateHost {
  readonly product: LiminalProductCommandPort;
  readonly activation: DreamActivationCommandPort;
  createCommand(input: { prompt: string; domain: string; layers: readonly string[];
    maxTransportAttempts: number;
    teaching?: LiminalCreativeCommand['teaching'] }): LiminalCreativeCommand;
  readonly judges: readonly [CompoundCreateJudge, CompoundCreateJudge];
}

type CreateProjection = Extract<LiminalProductProjection, { kind: 'create' }>;

/** Product-owned, restart-safe proof that activated knowledge improves later Create work. */
export class CompoundCreateProofPort {
  constructor(private readonly host: CompoundCreateHost,
    private readonly policy: CompoundCreatePolicy,
    private readonly store: CompoundCreateProjectionStore) {
    validateSealedPolicy(policy);
    if (host.judges.map(judge => judge.identityDigest).join('|')
      !== policy.judgeIdentityDigests.join('|')) {
      throw new Error('COMPOUND_CREATE_JUDGE_IDENTITY_MISMATCH');
    }
  }

  async run(command: CompoundCreateCommand): Promise<CompoundCreateProjection> {
    validateCommand(command);
    const commandHash = digest(command);
    return this.store.withLease(command.idempotencyKey, async () => {
      const existing = await this.store.read(command.idempotencyKey);
      if (existing) {
        if (existing.commandDigest !== commandHash) throw new Error('IDEMPOTENCY_KEY_REBOUND');
        await this.assertProjection(existing, command);
        return existing;
      }
      const activation = await this.host.activation.run(command.activation);
      const trials: CompoundCreateTrial[] = [];
      for (const task of this.policy.tasks) {
        trials.push(await this.runTask(task, activation));
      }
      const projection = this.finish(commandHash, activation, trials);
      await this.store.write(command.idempotencyKey, projection);
      return projection;
    });
  }

  async projection(key: string): Promise<CompoundCreateProjection | null> {
    return this.store.read(key);
  }

  private async runTask(task: CompoundCreateTask,
    activation: DreamActivationProjection): Promise<CompoundCreateTrial> {
    const controlTeaching = task.doctrineDigest ? { targetScope: task.targetScope,
      doctrineDigest: task.doctrineDigest } : undefined;
    const controlCommand = this.host.createCommand({ prompt: task.prompt,
      domain: task.domain, layers: task.layers, maxTransportAttempts: task.maxTransportAttempts,
      teaching: controlTeaching });
    const treatmentCommand = this.host.createCommand({ prompt: task.prompt,
      domain: task.domain, layers: task.layers, maxTransportAttempts: task.maxTransportAttempts,
      teaching: { ...controlTeaching,
        targetScope: task.targetScope, snapshotDigest: activation.snapshot.snapshotDigest } });
    assertMatchedCommands(controlCommand, treatmentCommand,
      activation.snapshot.snapshotDigest, this.policy.executionContextDigest);
    const [controlSubmitted, treatmentSubmitted] = await Promise.all([
      this.host.product.submitCreate('campaign', controlCommand),
      this.host.product.submitCreate('campaign', treatmentCommand),
    ]);
    if (controlSubmitted.kind !== 'create' || treatmentSubmitted.kind !== 'create') {
      throw new Error('COMPOUND_CREATE_PROJECTION_KIND_INVALID');
    }
    const control = await this.host.product.verifiedCreate(controlCommand.idempotencyKey);
    const treatment = await this.host.product.verifiedCreate(treatmentCommand.idempotencyKey);
    this.assertTeaching(control, treatment, activation.snapshot.snapshotDigest);
    return this.judgeTask(task, controlCommand.idempotencyKey,
      treatmentCommand.idempotencyKey, control, treatment);
  }

  private assertTeaching(control: CreateProjection, treatment: CreateProjection,
    snapshotDigest: string): void {
    if (control.teachingReceipt?.empirical
      || control.result.receipt.empiricalContextDigests.length > 0) {
      throw new Error('COMPOUND_CREATE_CONTROL_AMBIENT_KNOWLEDGE');
    }
    const application = treatment.teachingReceipt?.empirical;
    if (!application || application.snapshotDigest !== snapshotDigest
      || application.prePlanDigest === application.postPlanDigest
      || !application.transformationDelta.trim()
      || treatment.teachingReceipt?.finalProviderInputDigest
        !== application.finalProviderInputDigest) {
      throw new Error('COMPOUND_CREATE_TREATMENT_NOT_APPLIED');
    }
  }

  private async judgeTask(task: CompoundCreateTask, controlKey: string, treatmentKey: string,
    control: CreateProjection, treatment: CreateProjection): Promise<CompoundCreateTrial> {
    const assignment = this.policy.assignments.find(item => item.taskId === task.taskId)!;
    const controlArm = arm(assignment.treatmentPosition === 0
      ? assignment.secondArmId : assignment.firstArmId, task, control);
    const treatmentArm = arm(assignment.treatmentPosition === 0
      ? assignment.firstArmId : assignment.secondArmId, task, treatment);
    const arms = assignment.treatmentPosition === 0
      ? [treatmentArm, controlArm] as const : [controlArm, treatmentArm] as const;
    const judgeInput = Object.freeze({ policyDigest: this.policy.policyDigest,
      taskId: task.taskId, arms });
    const received = await Promise.all(this.host.judges.map((judge, index) =>
      this.host.product.runCompoundJudgment({
        idempotencyKey: `compound-judge:${this.policy.policyDigest}:${task.taskId}:${index}`,
        identity: judge.identityDigest, maxTransportAttempts: 1,
        binding: { policyDigest: this.policy.policyDigest, taskId: task.taskId,
          controlKey, treatmentKey, controlOperationId: control.result.operationId,
          treatmentOperationId: treatment.result.operationId,
          arms: arms.map(item => ({ armId: item.armId,
            artifactDigest: item.artifactDigest, evidenceDigest: item.evidenceDigest })) },
        effect: () => judge.compare(judgeInput),
      }))) as [CompoundCreateJudgment, CompoundCreateJudgment];
    const judgments = received.map(freezeJudgment) as
      [CompoundCreateJudgment, CompoundCreateJudgment];
    judgments.forEach((judgment, index) => {
      validateJudgment(judgment, this.policy.judgeIdentityDigests[index]!,
        this.policy.criterionDigest, arms);
      if (!this.host.judges[index]!.verify(judgment, judgeInput)) {
        throw new Error('COMPOUND_CREATE_JUDGMENT_AUTHORITY_INVALID');
      }
    });
    const deltas = judgments.map(judgment => judgment.armScores[treatmentArm.armId]!
      - judgment.armScores[controlArm.armId]!);
    const meanDelta = mean(deltas);
    const judgeDisagreement = Math.abs(deltas[0]! - deltas[1]!);
    return Object.freeze({ taskId: task.taskId, controlCreateKey: controlKey,
      treatmentCreateKey: treatmentKey,
      controlArtifactDigest: control.result.receipt.artifactDigest,
      treatmentArtifactDigest: treatment.result.receipt.artifactDigest,
      controlEvidenceDigest: control.result.evidence.evidenceDigest!,
      treatmentEvidenceDigest: treatment.result.evidence.evidenceDigest!,
      knowledgeApplicationDigest: digest(treatment.teachingReceipt!.empirical),
      judgments: Object.freeze(judgments), meanDelta, judgeDisagreement,
      regressionVetoed: deltas.some(delta => delta <= -this.policy.regressionVetoThreshold) });
  }

  private finish(commandDigest: string, activation: DreamActivationProjection,
    trials: readonly CompoundCreateTrial[]): CompoundCreateProjection {
    const aggregateEffect = mean(trials.map(trial => trial.meanDelta));
    const hasRegression = trials.some(trial => trial.regressionVetoed);
    const uncertain = trials.some(trial =>
      trial.judgeDisagreement > this.policy.maximumJudgeDisagreement);
    const taskWins = trials.filter(trial => trial.meanDelta > 0).length;
    const outcome = hasRegression ? 'regressed'
      : uncertain || taskWins < this.policy.minimumTaskWins
        || aggregateEffect < this.policy.minimumEffectSize
        ? 'uncertain' : 'compound-proven';
    const body = Object.freeze({ kind: 'compound-create' as const,
      status: 'completed' as const, outcome, commandDigest,
      policyDigest: this.policy.policyDigest,
      activationProjectionDigest: digest(activation),
      snapshotDigest: activation.snapshot.snapshotDigest,
      frozenAssignmentDigest: digest(this.policy.assignments),
      trials: Object.freeze([...trials]), aggregateEffect });
    return Object.freeze({ ...body, projectionDigest: digest(body) });
  }

  private async assertProjection(value: CompoundCreateProjection,
    command: CompoundCreateCommand): Promise<void> {
    const activation = await this.host.activation.run(command.activation);
    if (value.trials.length !== this.policy.sampleCount
      || stable(value.trials.map(trial => trial.taskId))
        !== stable(this.policy.tasks.map(task => task.taskId))) {
      throw new Error('COMPOUND_CREATE_PROJECTION_INVALID');
    }
    if (value.policyDigest !== this.policy.policyDigest
      || value.activationProjectionDigest !== digest(activation)
      || value.snapshotDigest !== activation.snapshot.snapshotDigest
      || value.frozenAssignmentDigest !== digest(this.policy.assignments)) {
      throw new Error('COMPOUND_CREATE_PROJECTION_INVALID');
    }
    const trials = await Promise.all(value.trials.map(trial => this.assertTrial(
      trial, activation.snapshot.snapshotDigest)));
    const expected = this.finish(value.commandDigest, activation, trials);
    if (stable(expected) !== stable(value)) throw new Error('COMPOUND_CREATE_PROJECTION_INVALID');
  }

  private async assertTrial(trial: CompoundCreateTrial,
    snapshotDigest: string): Promise<CompoundCreateTrial> {
    const task = this.policy.tasks.find(item => item.taskId === trial.taskId);
    if (!task) throw new Error('COMPOUND_CREATE_PROJECTION_INVALID');
    const [control, treatment] = await Promise.all([
      this.host.product.verifiedCreate(trial.controlCreateKey),
      this.host.product.verifiedCreate(trial.treatmentCreateKey),
    ]);
    this.assertTeaching(control, treatment, snapshotDigest);
    return this.verifyStoredTrial(task, trial, control, treatment);
  }

  private verifyStoredTrial(task: CompoundCreateTask, trial: CompoundCreateTrial,
    control: CreateProjection, treatment: CreateProjection): CompoundCreateTrial {
    const assignment = this.policy.assignments.find(item => item.taskId === task.taskId)!;
    const controlArm = arm(assignment.treatmentPosition === 0
      ? assignment.secondArmId : assignment.firstArmId, task, control);
    const treatmentArm = arm(assignment.treatmentPosition === 0
      ? assignment.firstArmId : assignment.secondArmId, task, treatment);
    const arms = assignment.treatmentPosition === 0
      ? [treatmentArm, controlArm] as const : [controlArm, treatmentArm] as const;
    trial.judgments.forEach((judgment, index) => {
      validateJudgment(judgment, this.policy.judgeIdentityDigests[index]!,
        this.policy.criterionDigest, arms);
      if (!this.host.judges[index]!.verify(judgment, {
        policyDigest: this.policy.policyDigest, taskId: task.taskId, arms })) {
        throw new Error('COMPOUND_CREATE_JUDGMENT_AUTHORITY_INVALID');
      }
    });
    const deltas = trial.judgments.map(judgment =>
      judgment.armScores[treatmentArm.armId]! - judgment.armScores[controlArm.armId]!);
    const expected = Object.freeze({ ...trial,
      controlArtifactDigest: control.result.receipt.artifactDigest,
      treatmentArtifactDigest: treatment.result.receipt.artifactDigest,
      controlEvidenceDigest: control.result.evidence.evidenceDigest!,
      treatmentEvidenceDigest: treatment.result.evidence.evidenceDigest!,
      knowledgeApplicationDigest: digest(treatment.teachingReceipt!.empirical),
      meanDelta: mean(deltas), judgeDisagreement: Math.abs(deltas[0]! - deltas[1]!),
      regressionVetoed: deltas.some(delta => delta <= -this.policy.regressionVetoThreshold) });
    if (stable(expected) !== stable(trial)) throw new Error('COMPOUND_CREATE_TRIAL_INVALID');
    return expected;
  }
}

function validatePolicy(policy: Omit<CompoundCreatePolicy, 'policyDigest'>): void {
  const taskIds = policy.tasks.map(task => task.taskId);
  const assignmentIds = policy.assignments.map(item => item.taskId);
  if (policy.tasks.length < 2 || policy.sampleCount !== policy.tasks.length
    || !Number.isSafeInteger(policy.minimumTaskWins) || policy.minimumTaskWins < 2
    || policy.minimumTaskWins > policy.sampleCount
    || new Set(taskIds).size !== taskIds.length
    || stable(taskIds) !== stable(assignmentIds)
    || policy.tasks.some(task => !task.taskId.trim() || !task.prompt.trim()
      || !task.domain.trim() || !task.targetScope.trim() || task.layers.length === 0
      || !Number.isSafeInteger(task.maxTransportAttempts) || task.maxTransportAttempts < 1)
    || policy.assignments.some(item => !item.firstArmId.trim() || !item.secondArmId.trim()
      || item.firstArmId === item.secondArmId)
    || policy.judgeIdentityDigests.some(value => !DIGEST.test(value))
    || !DIGEST.test(policy.criterionDigest)
    || !DIGEST.test(policy.executionContextDigest)
    || new Set(policy.judgeIdentityDigests).size !== 2
    || !Number.isFinite(policy.minimumEffectSize) || policy.minimumEffectSize <= 0
    || !Number.isFinite(policy.maximumJudgeDisagreement)
    || policy.maximumJudgeDisagreement < 0
    || !Number.isFinite(policy.regressionVetoThreshold)
    || policy.regressionVetoThreshold <= 0 || policy.aggregation !== 'mean-delta') {
    throw new Error('COMPOUND_CREATE_POLICY_INVALID');
  }
}

function validateSealedPolicy(policy: CompoundCreatePolicy): void {
  const { policyDigest, ...body } = policy;
  validatePolicy(body);
  if (!Object.isFrozen(policy) || !Object.isFrozen(policy.tasks)
    || !Object.isFrozen(policy.assignments) || !Object.isFrozen(policy.judgeIdentityDigests)
    || policy.tasks.some(task => !Object.isFrozen(task) || !Object.isFrozen(task.layers))
    || policy.assignments.some(item => !Object.isFrozen(item))
    || policyDigest !== digest(body)) {
    throw new Error('COMPOUND_CREATE_POLICY_NOT_FROZEN');
  }
}

function validateCommand(command: CompoundCreateCommand): void {
  if (command.schema !== 'sinter.compound-create-command' || command.schemaVersion !== 1
    || !command.idempotencyKey?.trim()) throw new Error('COMPOUND_CREATE_COMMAND_INVALID');
}

function assertMatchedCommands(control: LiminalCreativeCommand,
  treatment: LiminalCreativeCommand, snapshotDigest: string,
  executionContextDigest: string): void {
  const strip = (command: LiminalCreativeCommand) => {
    const { idempotencyKey: _key, authorityPackageDigest: _authority,
      teaching: _teaching, ...matched } = command;
    return matched;
  };
  if (stable(strip(control)) !== stable(strip(treatment))
    || control.teaching?.snapshotDigest
    || treatment.teaching?.snapshotDigest !== snapshotDigest
    || control.teaching?.doctrineDigest !== treatment.teaching?.doctrineDigest
    || commandExecutionContextDigest(control) !== executionContextDigest) {
    throw new Error('COMPOUND_CREATE_ARMS_NOT_MATCHED');
  }
}

export function compoundCreateExecutionContextDigest(command: LiminalCreativeCommand): string {
  return digest({ sourceHeadSha: command.sourceHeadSha,
    canonicalMainSha: command.canonicalMainSha, roles: command.roles,
    rendererIdentity: command.rendererIdentity,
    renderAuthorization: command.renderAuthorization, evalMode: command.evalMode,
    safeMode: command.safeMode, maxTransportAttempts: command.maxTransportAttempts });
}

const commandExecutionContextDigest = compoundCreateExecutionContextDigest;

function arm(armId: string, task: CompoundCreateTask,
  projection: CreateProjection): CompoundBlindedArm {
  return Object.freeze({ armId, taskId: task.taskId,
    artifactDigest: projection.result.receipt.artifactDigest,
    evidenceDigest: projection.result.evidence.evidenceDigest!, domain: task.domain });
}

function validateJudgment(judgment: CompoundCreateJudgment, identity: string,
  criterionDigest: string, arms: readonly CompoundBlindedArm[]): void {
  const armIds = arms.map(arm => arm.armId).sort();
  const scoreIds = Object.keys(judgment.armScores).sort();
  if (judgment.judgeIdentityDigest !== identity
    || judgment.criterionDigest !== criterionDigest
    || !DIGEST.test(judgment.signature)
    || stable(armIds) !== stable(scoreIds)
    || Object.values(judgment.armScores).some(score => !Number.isFinite(score)
      || score < 0 || score > 1)) throw new Error('COMPOUND_CREATE_JUDGMENT_INVALID');
}

function freezeJudgment(judgment: CompoundCreateJudgment): CompoundCreateJudgment {
  return Object.freeze({ ...judgment,
    armScores: Object.freeze({ ...judgment.armScores }) });
}

function mean(values: readonly number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}
