import { createHash } from 'node:crypto';
import type { DreamRenderedExperimentExecutor } from
  '../dreaming/research/DreamRenderedExperimentExecutor.js';
import type { AdmittedCreativeEvidence, DreamResearchPlan,
  DreamResearchController } from '../dreaming/research/DreamResearchController.js';
import type { DreamResearchService } from '../dreaming/research/DreamResearchService.js';
import type { DreamExperimentPlan, DreamModality } from
  '../dreaming/research/DreamResearchTypes.js';
import { extractParentTechnique } from '../dreaming/research/ParentTechnique.js';
import type { LiminalProductCommandPort } from './LiminalProductCommandPort.js';
import type { VerifiedLiminalOwnerEvidence } from './LiminalProductCommandPort.js';
import { FileLiminalProductCommandStore } from './LiminalProductCommandPort.js';

export interface DreamProductCommand {
  readonly schema: 'sinter.dream-product-command';
  readonly schemaVersion: 1;
  readonly idempotencyKey: string;
  /** Each item names an owner review, or `source: 'judge-scoring'` to use the judge's score as evidence. */
  readonly evidence: readonly ({ readonly createKey: string; readonly ownerReviewKey: string;
    readonly source?: undefined } | { readonly createKey: string;
    readonly source: 'judge-scoring'; readonly ownerReviewKey?: undefined;
    readonly expectedCreateReceiptDigest?: string })[];
}

export interface DreamProductProjection {
  readonly kind: 'dream-research';
  readonly status: 'completed';
  readonly commandDigest: string;
  readonly researchPlan: DreamResearchPlan;
  readonly experimentPlan: DreamExperimentPlan;
  readonly outcome: 'keeper' | 'rejected' | 'inconclusive';
  readonly state: string;
}

export interface DreamExperimentTemplate {
  readonly campaignId: string;
  readonly context: Omit<DreamExperimentPlan['context'], 'sourceDigests' | 'parentSetDigest'>;
  readonly requiredModalities: readonly DreamModality[];
  readonly lease: DreamExperimentPlan['lease'];
}

export interface DreamProductProjectionStore {
  read(key: string): Promise<DreamProductProjection | null>;
  write(key: string, projection: DreamProductProjection): Promise<void>;
  withLease<T>(key: string, operation: () => Promise<T>): Promise<T>;
}

export class FileDreamProductProjectionStore implements DreamProductProjectionStore {
  private readonly inner: FileLiminalProductCommandStore;
  constructor(file: string) { this.inner = new FileLiminalProductCommandStore(file); }
  async read(key: string): Promise<DreamProductProjection | null> {
    return await this.inner.read(key) as unknown as DreamProductProjection | null;
  }
  async write(key: string, projection: DreamProductProjection): Promise<void> {
    await this.inner.write(key, projection as never);
  }
  withLease<T>(key: string, operation: () => Promise<T>): Promise<T> {
    return this.inner.withLease(key, operation);
  }
}

const stable = (value: unknown): string => {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map(key =>
    `${JSON.stringify(key)}:${stable(record[key])}`).join(',')}}`;
};
const digest = (value: unknown): string =>
  createHash('sha256').update(stable(value)).digest('hex');

interface ParentTechniqueFields { readonly parentTechniqueDigest?: string; readonly parentTechnique?: string }

/** Canonical product path from accepted Create evidence to one bounded experiment. */
export class DreamProductCommandPort {
  constructor(private readonly products: LiminalProductCommandPort,
    private readonly controller: DreamResearchController,
    private readonly service: DreamResearchService,
    private readonly executor: DreamRenderedExperimentExecutor,
    private readonly store: DreamProductProjectionStore,
    private readonly policy: DreamResearchPlan['budget'],
    private readonly template: DreamExperimentTemplate,
    /** Reserves one precommitted holdout per study and returns its commitment digest (F02). Absent: the template's single commitment. */
    private readonly assignHoldout?: (aggregateId: string) => string,
    /** Reads an admitted parent's source so the study binds what the piece does (F09). Absent or null: criterion-digest principle. */
    private readonly readParentSource?: (createKey: string, artifactDigest: string) => Promise<string | null>) {}

  async run(command: DreamProductCommand): Promise<DreamProductProjection> {
    this.validate(command);
    const commandDigest = digest(command);
    return this.store.withLease(command.idempotencyKey, async () => {
      const existing = await this.store.read(command.idempotencyKey);
      if (existing) {
        if (existing.commandDigest !== commandDigest) throw new Error('IDEMPOTENCY_KEY_REBOUND');
        if (!existing.experimentPlan.context.liminalParentBindings?.length) {
          throw new Error('DREAM_PRODUCT_HISTORICAL_NON_ADMISSIBLE');
        }
        const journaled = this.completedProjection(commandDigest, existing.researchPlan,
          existing.experimentPlan);
        if (!journaled || stable(journaled) !== stable(existing)) {
          throw new Error('DREAM_PRODUCT_PROJECTION_INVALID');
        }
        await this.recordNegative(existing);
        return existing;
      }
      const evidence = await this.admittedEvidence(command);
      const researchPlan = await this.controller.select(evidence, this.policy);
      const experimentPlan = this.experimentPlan(commandDigest, evidence, researchPlan);
      const projection = await this.execute(commandDigest, researchPlan, experimentPlan);
      await this.products.linkDreamProjection(evidence.map(item => item.operationId),
        digest(projection));
      await this.store.write(command.idempotencyKey, projection);
      await this.recordNegative(projection);
      return projection;
    });
  }

  projection(key: string): Promise<DreamProductProjection | null> {
    return this.store.read(key);
  }

  private async recordNegative(projection: DreamProductProjection): Promise<void> {
    if (projection.outcome !== 'keeper') {
      await this.controller.recordOutcome(projection.researchPlan.planDigest,
        projection.outcome === 'rejected' ? 'rejected' : 'inconclusive');
    }
  }

  private async admittedEvidence(command: DreamProductCommand):
  Promise<Array<AdmittedCreativeEvidence & VerifiedLiminalOwnerEvidence & ParentTechniqueFields>> {
    const verified = await Promise.all(command.evidence.map(async item => {
      if (item.source !== 'judge-scoring') {
        return this.products.verifiedOwnerEvidence(item.createKey, item.ownerReviewKey);
      }
      const proof = await this.products.verifiedJudgeEvidence(item.createKey, item.expectedCreateReceiptDigest !== undefined);
      if (item.expectedCreateReceiptDigest !== undefined
        && item.expectedCreateReceiptDigest !== proof.createReceiptDigest) {
        throw new Error('DREAM_JUDGE_CREATE_RECEIPT_MISMATCH');
      }
      return proof;
    }));
    const techniques = await Promise.all(verified.map(async item => {
      const source = this.readParentSource ? await this.readParentSource(item.createKey, item.artifactDigest) : null;
      return source ? extractParentTechnique(source) : null;
    }));
    return verified.map((item, index) => Object.freeze({ ...item, evidenceDigest: item.evidenceDigest,
      artifactDigest: item.artifactDigest,
      principleIds: [techniques[index]?.statement ?? item.criterionDigest],
      ...(techniques[index] ? { parentTechniqueDigest: techniques[index]!.digest,
        parentTechnique: techniques[index]!.statement } : {}),
      domain: item.domain, quality: item.quality, noveltyDescriptor: [item.quality],
      outcome: 'accepted' as const, rendered: true, admissionEligible: true }));
  }

  private experimentPlan(commandDigest: string,
    evidence: readonly (AdmittedCreativeEvidence & VerifiedLiminalOwnerEvidence & ParentTechniqueFields)[],
    plan: DreamResearchPlan): DreamExperimentPlan {
    const aggregateId = `dream-${commandDigest.slice(0, 24)}`;
    return Object.freeze({ aggregateId, schemaVersion: 1, campaignId: this.template.campaignId,
      hypothesis: Object.freeze({ id: plan.planDigest, statement: plan.hypothesis,
        principle: plan.hypothesis, expectedEffect: plan.criterion }),
      context: Object.freeze({ ...this.template.context,
        ...(this.assignHoldout ? { transferCommitmentDigest: this.assignHoldout(aggregateId) } : {}),
        liminalParentBindings: evidence.map(item => Object.freeze({
          createKey: item.createKey, ownerReviewKey: item.ownerReviewKey,
          operationId: item.operationId, lineageId: item.lineageId,
          createCommandDigest: item.createCommandDigest,
          createReceiptDigest: item.createReceiptDigest,
          reviewCommandDigest: item.reviewCommandDigest,
          reviewDecisionDigest: item.reviewDecisionDigest,
          reviewReceiptDigest: item.reviewReceiptDigest,
          artifactDigest: item.artifactDigest, evidenceDigest: item.evidenceDigest,
          ...('parentTechniqueDigest' in item ? { parentTechniqueDigest: item.parentTechniqueDigest,
            parentTechnique: item.parentTechnique } : {}),
          ...(item.provenance ? { provenance: item.provenance } : {}) })),
        sourceDigests: evidence.map(item => item.artifactDigest).sort(),
        parentSetDigest: digest(evidence.map(item => ({ artifactDigest: item.artifactDigest,
          evidenceDigest: item.evidenceDigest })).sort((a, b) =>
          a.evidenceDigest.localeCompare(b.evidenceDigest))) }),
      budget: Object.freeze({ maximumAttempts: plan.budget.maxProviderAttempts }),
      requiredModalities: [...this.template.requiredModalities],
      lease: Object.freeze({ ...this.template.lease }) });
  }

  private async execute(commandDigest: string, researchPlan: DreamResearchPlan,
    plan: DreamExperimentPlan): Promise<DreamProductProjection> {
    const key = `dream-product:${commandDigest}`;
    this.service.plan(plan, `${key}:plan`);
    this.service.freeze(plan.aggregateId, 1, `${key}:freeze`);
    const recovered = this.completedProjection(commandDigest, researchPlan, plan);
    if (recovered) return recovered;
    await this.controller.reserveCandidate(researchPlan.planDigest, key);
    const result = await this.executor.execute(plan, async (purpose, operation, options) => {
      const metered = options?.metered !== false;
      if (!metered) return this.service.runOperation(
        plan.aggregateId, purpose, operation, false);
      const role = purpose === 'creative-operator' ? 'generator' : 'evaluator';
      const identity = role === 'generator' ? plan.context.operatorDigest
        : plan.context.evaluatorManifestDigests[Number(purpose.split('-').at(-1)) - 1];
      if (!identity) throw new Error('DREAM_PROVIDER_IDENTITY_MISSING');
      const governedOperation = () => this.products.runResearchProviderEffect({
          idempotencyKey: `dream-provider:${plan.aggregateId}:${purpose}`,
          binding: { commandDigest, aggregateId: plan.aggregateId, purpose, identity },
          identity, role, maxTransportAttempts: 1, effect: operation,
        });
      return this.service.runOperation(plan.aggregateId, purpose, governedOperation,
        true, async () => {
          await this.controller.reserveProviderAttempt(researchPlan.planDigest, purpose);
        });
    });
    let revision = this.service.snapshot(plan.aggregateId).revision;
    this.service.recordBaseline(plan.aggregateId, revision, `${key}:baseline`,
      result.baselineEvidenceDigest);
    revision = this.service.snapshot(plan.aggregateId).revision;
    this.service.recordVariants(plan.aggregateId, revision, `${key}:variants`,
      result.variantEvidenceDigests, result.variantArtifactDigests);
    revision = this.service.snapshot(plan.aggregateId).revision;
    if (!result.comparisonCapability) throw new Error('DREAM_RENDERED_COMPARISON_REQUIRED');
    this.service.compare(plan.aggregateId, revision, `${key}:compare`,
      result.comparisonCapability);
    return Object.freeze({ kind: 'dream-research', status: 'completed', commandDigest,
      researchPlan, experimentPlan: plan, outcome: result.comparison.outcome,
      state: this.service.snapshot(plan.aggregateId).state });
  }

  private completedProjection(commandDigest: string, researchPlan: DreamResearchPlan,
    plan: DreamExperimentPlan): DreamProductProjection | null {
    const terminal = [...this.service.events(plan.aggregateId)].reverse().find(event =>
      ['finding-proposed', 'experiment-rejected', 'experiment-inconclusive'].includes(event.type));
    if (!terminal) return null;
    const outcome = terminal.type === 'finding-proposed' ? 'keeper'
      : terminal.type === 'experiment-rejected' ? 'rejected' : 'inconclusive';
    return Object.freeze({ kind: 'dream-research', status: 'completed', commandDigest,
      researchPlan, experimentPlan: plan, outcome,
      state: this.service.snapshot(plan.aggregateId).state });
  }

  private validate(command: DreamProductCommand): void {
    const pairs = command.evidence.map(item => `${item.createKey}\0${item.ownerReviewKey ?? item.source}`);
    if (command.schema !== 'sinter.dream-product-command' || command.schemaVersion !== 1
      || !command.idempotencyKey.trim() || command.evidence.length < 1
      || new Set(pairs).size !== pairs.length
      || command.evidence.some(item => !item.createKey.trim()
        || (item.source === 'judge-scoring'
          ? item.ownerReviewKey !== undefined || (item.expectedCreateReceiptDigest !== undefined
            && !/^[a-f0-9]{64}$/.test(item.expectedCreateReceiptDigest))
          : item.source !== undefined || !item.ownerReviewKey?.trim()
            || item.createKey === item.ownerReviewKey))) {
      throw new Error('DREAM_PRODUCT_COMMAND_INVALID');
    }
  }
}
