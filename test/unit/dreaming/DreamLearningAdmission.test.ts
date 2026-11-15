import { describe, expect, it } from 'vitest';
import { createDreamFindingAdmission, validateDreamFindingAdmission,
} from '../../../src/dreaming/research/DreamLearningAdmission.js';

describe('Dream finding admission', () => {
  const digest = (char: string) => char.repeat(64);
  const input = { aggregateId: 'dream-1', findingDigest: digest('a'),
    artifactDigests: [digest('b')], evidenceDigests: [digest('c'), digest('d')],
    transferEvidenceDigest: digest('e'), state: 'validated' as const };

  it('seals exact validated finding and evidence digests', () => {
    const admission = createDreamFindingAdmission(input);
    expect(validateDreamFindingAdmission(admission)).toEqual(admission);
    expect(admission.admissionDigest).toMatch(/^[a-f0-9]{64}$/);
  });

  it('rejects proposed, degraded, mismatched, or tampered learning', () => {
    expect(() => createDreamFindingAdmission({ ...input, state: 'proposed' as never }))
      .toThrow('DREAM_FINDING_NOT_VALIDATED');
    const admission = createDreamFindingAdmission(input);
    expect(() => validateDreamFindingAdmission({ ...admission,
      findingDigest: digest('f') })).toThrow('DREAM_FINDING_ADMISSION_INVALID');
  });
});
