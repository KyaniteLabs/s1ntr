import { createHash } from 'node:crypto';
import type { DreamHoldoutCapability, DreamHoldoutCustody } from './DreamHoldoutVault.js';
import { dreamEvidenceReceiptDigest, validateDreamEvidence, validateEvaluatorIndependence,
  validateEvaluatorManifests,
  validateTransferIsolation, type DreamEvaluatorIdentity,
  type DreamObservedEvidence, type DreamTransferIsolation,
  type DreamTransferCommitmentProtocol, type DreamRenderedEvidenceResolver,
} from './DreamResearchEvidence.js';
import type { DreamResearchService } from './DreamResearchService.js';
import type { DreamModality, DreamTransferOutcome } from './DreamResearchTypes.js';
import type { DreamDecisionIssuer } from './DreamDecisionAuthority.js';
import type { DreamCreativeCandidate,
  DreamRenderedObserver } from './DreamRenderedExperimentExecutor.js';

export interface DreamTransferRunInput {
  aggregateId: string;
  holdout: DreamHoldoutCapability;
  requiredModalities: DreamModality[];
  producer: DreamTransferProducer;
  producerIdentityDigest?: string;
  evaluators: readonly [DreamTransferEvaluator, DreamTransferEvaluator];
}

export interface DreamTransferProducer {
  produce(input: { holdout: string; contextDigest: string;
    findingDigest: string | null }): Promise<DreamCreativeCandidate>;
}

export interface DreamTransferEvaluator {
  identity: DreamEvaluatorIdentity;
  compare(treatment: DreamObservedEvidence, control: DreamObservedEvidence):
    Promise<DreamTransferOutcome>;
}

export type DreamTransferProviderEffect = <T>(input: { aggregateId: string;
  purpose: string; identity: string; role: 'generator' | 'evaluator';
  effect: () => Promise<T> }) => Promise<T>;

export class DreamTransferRunner {
  constructor(private readonly service: DreamResearchService,
    private readonly vault: DreamHoldoutCustody,
    private readonly decisions: DreamDecisionIssuer,
    private readonly observer: DreamRenderedObserver,
    private readonly renderedEvidence: DreamRenderedEvidenceResolver,
    private readonly providerEffect?: DreamTransferProviderEffect) {}

  async run(input: DreamTransferRunInput): Promise<DreamTransferOutcome> {
    let snapshot = this.service.snapshot(input.aggregateId);
    const plan = this.service.events(input.aggregateId)[0]?.payload.plan as
      import('./DreamResearchTypes.js').DreamExperimentPlan;
    if (plan.context.transferCommitmentDigest
      !== input.holdout.commitment.commitmentDigest) {
      throw new Error('DREAM_TRANSFER_COMMITMENT_MISMATCH');
    }
    // Freeze every transfer pin BEFORE the holdout can be opened (#1259).
    if (snapshot.state === 'finding-proposed') {
      this.service.freezeTransfer(input.aggregateId, snapshot.revision,
        `${input.aggregateId}:transfer-freeze`);
      snapshot = this.service.snapshot(input.aggregateId);
    }
    const accessRevision = snapshot.revision;
    const opened = this.vault.open(input.holdout, snapshot, (commandId, commitmentDigest) => {
      this.service.recordHoldoutAccess(input.aggregateId, accessRevision,
        commandId, commitmentDigest);
    });
    snapshot = this.service.snapshot(input.aggregateId);
    if (protocolDigest(opened.protocol) !== input.holdout.commitment.protocolDigest) {
      throw new Error('DREAM_TRANSFER_PROTOCOL_MISMATCH');
    }
    const events = this.service.events(input.aggregateId);
    const findingRevision = events.find(event => event.type === 'finding-proposed')?.revision;
    const accessRevisionObserved = events.find(event => event.type === 'holdout-accessed')?.revision;
    const isolation: DreamTransferIsolation = { ...opened.protocol,
      holdoutAccessedBeforeProposal: !findingRevision || !accessRevisionObserved
        || accessRevisionObserved < findingRevision };
    validateTransferIsolation(isolation);
    const controlCandidate = await this.service.runOperation(input.aggregateId, 'transfer-control',
      () => this.runProvider(input.aggregateId, 'transfer-control', 'generator',
        input.producerIdentityDigest, () => input.producer.produce({ holdout: opened.bytes,
          contextDigest: opened.protocol.controlContextDigest, findingDigest: null })));
    const treatmentCandidate = await this.service.runOperation(input.aggregateId, 'transfer-treatment',
      () => this.runProvider(input.aggregateId, 'transfer-treatment', 'generator',
        input.producerIdentityDigest, () => input.producer.produce({ holdout: opened.bytes,
          contextDigest: opened.protocol.treatmentContextDigest,
          findingDigest: opened.protocol.findingDigest })));
    if (controlCandidate.source === treatmentCandidate.source
      || controlCandidate.graphDigest === treatmentCandidate.graphDigest) {
      throw new Error('DREAM_TRANSFER_ASSIGNMENT_NOT_APPLIED');
    }
    const control = await this.service.runOperation(input.aggregateId, 'transfer-control-render',
      () => this.observer.observe(controlCandidate, plan), false);
    const treatment = await this.service.runOperation(input.aggregateId,
      'transfer-treatment-render', () => this.observer.observe(treatmentCandidate, plan), false);
    if (control.artifactDigest === treatment.artifactDigest) {
      throw new Error('DREAM_TRANSFER_ARTIFACTS_NOT_DISTINCT');
    }
    this.assertEvidence(treatment, input.requiredModalities);
    this.assertEvidence(control, input.requiredModalities);
    const treatmentEvidenceDigest = evidenceDigest(treatment);
    const controlEvidenceDigest = evidenceDigest(control);
    const evaluatorTreatment = deepFreeze(structuredClone(treatment));
    const evaluatorControl = deepFreeze(structuredClone(control));
    snapshot = this.service.snapshot(input.aggregateId);
    this.service.recordTransfer(input.aggregateId, snapshot.revision,
      `${input.aggregateId}:transfer-observed`, treatmentEvidenceDigest,
      controlEvidenceDigest, treatment.artifactDigest, control.artifactDigest);
    validateEvaluatorIndependence(input.evaluators[0].identity,
      input.evaluators[1].identity);
    validateEvaluatorManifests(input.evaluators.map(item => item.identity),
      plan.context.evaluatorManifestDigests);
    const verdicts: DreamTransferOutcome[] = [];
    for (const [index, evaluator] of input.evaluators.entries()) {
      verdicts.push(await this.service.runOperation(input.aggregateId,
        `transfer-evaluator-${index + 1}`,
        () => this.runProvider(input.aggregateId, `transfer-evaluator-${index + 1}`,
          'evaluator', evaluator.identity.identityDigest,
          () => evaluator.compare(evaluatorTreatment, evaluatorControl))));
    }
    const outcome = verdicts[0] === verdicts[1] ? verdicts[0] : 'inconclusive';
    snapshot = this.service.snapshot(input.aggregateId);
    this.service.validateTransfer(input.aggregateId, snapshot.revision,
      `${input.aggregateId}:transfer-verdict`, this.decisions.issueTransfer({
        aggregateId: input.aggregateId, outcome, treatmentEvidenceDigest,
        controlEvidenceDigest, treatmentArtifactDigest: treatment.artifactDigest,
        controlArtifactDigest: control.artifactDigest }));
    return outcome;
  }

  private runProvider<T>(aggregateId: string, purpose: string,
    role: 'generator' | 'evaluator', identity: string | undefined,
    effect: () => Promise<T>): Promise<T> {
    if (!this.providerEffect) return effect();
    if (!identity) throw new Error('DREAM_TRANSFER_PROVIDER_IDENTITY_MISSING');
    return this.providerEffect({ aggregateId, purpose, role, identity, effect });
  }

  private assertEvidence(evidence: DreamObservedEvidence,
    required: DreamModality[]): void {
    this.renderedEvidence.assertAttested(evidence);
    const failures = validateDreamEvidence(evidence, required);
    if (failures.length > 0) throw new Error(failures.join(','));
  }
}

export function protocolDigest(value: DreamTransferCommitmentProtocol): string {
  return createHash('sha256').update(JSON.stringify({
    originContextDigest: value.originContextDigest,
    controlContextDigest: value.controlContextDigest,
    treatmentContextDigest: value.treatmentContextDigest,
    findingDigest: value.findingDigest,
    controlFindingDigest: value.controlFindingDigest,
    treatmentFindingDigest: value.treatmentFindingDigest,
  })).digest('hex');
}

const evidenceDigest = dreamEvidenceReceiptDigest;

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.values(value as Record<string, unknown>).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
}
