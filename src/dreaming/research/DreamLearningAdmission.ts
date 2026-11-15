import { createHash } from 'node:crypto';

export interface DreamFindingAdmission {
  schema: 'sinter.dream-finding-admission';
  schemaVersion: 1;
  aggregateId: string;
  findingDigest: string;
  artifactDigests: readonly string[];
  evidenceDigests: readonly string[];
  transferEvidenceDigest: string;
  state: 'validated';
  admissionDigest: string;
}

const DIGEST = /^[a-f0-9]{64}$/;

function body(input: Omit<DreamFindingAdmission, 'admissionDigest'>): string {
  return JSON.stringify(input);
}

export function createDreamFindingAdmission(input: Omit<DreamFindingAdmission,
  'schema' | 'schemaVersion' | 'admissionDigest'>): DreamFindingAdmission {
  if (input.state !== 'validated') throw new Error('DREAM_FINDING_NOT_VALIDATED');
  const fields = [input.findingDigest, input.transferEvidenceDigest,
    ...input.artifactDigests, ...input.evidenceDigests];
  if (input.artifactDigests.length === 0 || input.evidenceDigests.length === 0
    || !fields.every(value => DIGEST.test(value))) throw new Error('DREAM_FINDING_DIGEST_INVALID');
  const value = { schema: 'sinter.dream-finding-admission' as const, schemaVersion: 1 as const,
    ...input, artifactDigests: Object.freeze([...input.artifactDigests]),
    evidenceDigests: Object.freeze([...input.evidenceDigests]) };
  return Object.freeze({ ...value,
    admissionDigest: createHash('sha256').update(body(value)).digest('hex') });
}

export function validateDreamFindingAdmission(value: DreamFindingAdmission): DreamFindingAdmission {
  const { admissionDigest, ...unsigned } = value;
  const expected = createHash('sha256').update(body(unsigned)).digest('hex');
  if (value.schema !== 'sinter.dream-finding-admission' || value.schemaVersion !== 1
    || value.state !== 'validated' || admissionDigest !== expected) {
    throw new Error('DREAM_FINDING_ADMISSION_INVALID');
  }
  return value;
}
