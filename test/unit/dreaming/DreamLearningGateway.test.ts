import { describe, expect, it, vi } from 'vitest';
import { createDreamFindingAdmission } from '../../../src/dreaming/research/DreamLearningAdmission.js';
import { DreamLearningGateway } from '../../../src/dreaming/research/DreamLearningGateway.js';
import { DreamResearchJournal } from '../../../src/dreaming/research/DreamResearchJournal.js';
import { DreamResearchService } from '../../../src/dreaming/research/DreamResearchService.js';
import { frozenExperiment } from './dreamResearchFixtures.js';
import { createDreamDecisionAuthority } from
  '../../../src/dreaming/research/DreamDecisionAuthority.js';

const digest = (char: string) => char.repeat(64);

function validated() {
  const decisions = createDreamDecisionAuthority();
  const service = new DreamResearchService(new DreamResearchJournal(':memory:'),
    { assertActive: () => undefined }, decisions.resolver);
  service.plan(frozenExperiment(), 'plan'); service.freeze('dream-1', 1, 'freeze');
  service.recordBaseline('dream-1', 2, 'baseline', digest('b'));
  service.recordVariants('dream-1', 3, 'variants', [digest('c')], [digest('a')]);
  service.compare('dream-1', 4, 'compare', decisions.issuer.issueComparison({
    aggregateId: 'dream-1', outcome: 'keeper', reason: 'depth',
    baselineEvidenceDigest: digest('b'), variantEvidenceDigests: [digest('c')],
    variantArtifactDigests: [digest('a')] }));
  service.freezeTransfer('dream-1', 5, 'transfer-freeze');
  service.recordTransfer('dream-1', 6, 'transfer', digest('d'), digest('e'),
    digest('f'), digest('9'));
  service.validateTransfer('dream-1', 7, 'verdict', decisions.issuer.issueTransfer({
    aggregateId: 'dream-1', outcome: 'validated',
    treatmentEvidenceDigest: digest('d'), controlEvidenceDigest: digest('e'),
    treatmentArtifactDigest: digest('f'), controlArtifactDigest: digest('9') }));
  const events = service.events('dream-1');
  const finding = events.find(event => event.type === 'finding-proposed')!;
  const transfer = events.find(event => event.type === 'transfer-observed')!;
  return { service, admission: createDreamFindingAdmission({ aggregateId: 'dream-1',
    findingDigest: finding.eventDigest,
    artifactDigests: [digest('a'), digest('f'), digest('9')],
    evidenceDigests: [digest('b'), digest('c'), digest('d'), digest('e')],
    transferEvidenceDigest: transfer.eventDigest, state: 'validated' }) };
}

describe('DreamLearningGateway', () => {
  it('requires journal-bound digests and an unforgeable capability', async () => {
    const { service, admission } = validated();
    const gateway = new DreamLearningGateway(service);
    const capability = gateway.authorize(admission);
    const sink = { writeFinding: vi.fn() };
    await gateway.write(capability, sink);
    expect(sink.writeFinding).toHaveBeenCalledOnce();
    await expect(gateway.write({ admissionDigest: capability.admissionDigest }, sink))
      .rejects.toThrow('DREAM_LEARNING_CAPABILITY_INVALID');
  });

  it('denies syntactically valid but journal-mismatched digests', () => {
    const { service, admission } = validated();
    const forged = createDreamFindingAdmission({ aggregateId: admission.aggregateId,
      findingDigest: admission.findingDigest, artifactDigests: [digest('f')],
      evidenceDigests: admission.evidenceDigests,
      transferEvidenceDigest: admission.transferEvidenceDigest, state: 'validated' });
    expect(() => new DreamLearningGateway(service).authorize(forged))
      .toThrow('DREAM_LEARNING_JOURNAL_BINDING_INVALID');
  });
});
