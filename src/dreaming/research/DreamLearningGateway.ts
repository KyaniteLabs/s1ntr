import { validateDreamFindingAdmission,
  type DreamFindingAdmission } from './DreamLearningAdmission.js';
import type { DreamResearchService } from './DreamResearchService.js';

export interface DreamLearningCapability {
  readonly admissionDigest: string;
}

const bindings = new WeakMap<object, DreamFindingAdmission>();

export interface DreamKnowledgeSink {
  writeFinding(admission: DreamFindingAdmission): void | Promise<void>;
}

export class DreamLearningGateway {
  constructor(private readonly service: DreamResearchService) {}

  authorize(admission: DreamFindingAdmission): DreamLearningCapability {
    validateDreamFindingAdmission(admission);
    const snapshot = this.service.snapshot(admission.aggregateId);
    if (snapshot.aggregateId !== admission.aggregateId
      || snapshot.state !== 'completed' || snapshot.finding !== 'validated') {
      throw new Error('DREAM_LEARNING_STATE_NOT_VALIDATED');
    }
    this.assertJournalBinding(admission);
    const capability = Object.freeze({ admissionDigest: admission.admissionDigest });
    bindings.set(capability, admission);
    return capability;
  }

  private assertJournalBinding(admission: DreamFindingAdmission): void {
    const events = this.service.events(admission.aggregateId);
    const finding = events.find(event => event.type === 'finding-proposed');
    const variants = events.find(event => event.type === 'variants-observed');
    const baseline = events.find(event => event.type === 'baseline-observed');
    const transfer = events.find(event => event.type === 'transfer-observed');
    const artifactDigests = [...((variants?.payload.artifactDigests as string[] | undefined) ?? []),
      transfer?.payload.treatmentArtifactDigest,
      transfer?.payload.controlArtifactDigest]
      .filter((value): value is string => typeof value === 'string');
    const evidenceDigests = [baseline?.payload.evidenceDigest,
      ...((variants?.payload.evidenceDigests as string[] | undefined) ?? []),
      transfer?.payload.treatmentEvidenceDigest, transfer?.payload.controlEvidenceDigest]
      .filter((value): value is string => typeof value === 'string');
    if (!finding || !transfer || finding.eventDigest !== admission.findingDigest
      || transfer.eventDigest !== admission.transferEvidenceDigest
      || !sameDigests(artifactDigests, admission.artifactDigests)
      || !sameDigests(evidenceDigests, admission.evidenceDigests)) {
      throw new Error('DREAM_LEARNING_JOURNAL_BINDING_INVALID');
    }
  }

  async write(capability: DreamLearningCapability,
    sink: DreamKnowledgeSink): Promise<void> {
    const admission = bindings.get(capability);
    if (!admission || capability.admissionDigest !== admission.admissionDigest) {
      throw new Error('DREAM_LEARNING_CAPABILITY_INVALID');
    }
    await sink.writeFinding(admission);
  }
}

function sameDigests(left: readonly string[] | undefined,
  right: readonly string[]): boolean {
  return Boolean(left) && [...left!].sort().join(':') === [...right].sort().join(':');
}
