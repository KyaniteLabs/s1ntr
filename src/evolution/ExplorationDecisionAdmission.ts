import { createHash } from 'node:crypto';
import { sealCreativeAdmission, verifyCreativeAdmission,
  type CreativeAdmissionProof, type CreativeAdmissionSigner } from
  '../runtime-core/CreativeAdmissionAuthority.js';

export type ExplorationDecisionPurpose = 'parent-selection' | 'evolution-reward';
export interface ExplorationDecisionAdmission {
  readonly schema: 'sinter.exploration-decision-admission';
  readonly schemaVersion: 1;
  readonly purpose: ExplorationDecisionPurpose;
  readonly artifactId: string;
  readonly role: string;
  readonly domain: string;
  readonly criterionScore: number;
  readonly ownerDecision: 'accepted' | 'rejected';
  readonly artifactDigest: string;
  readonly evidenceDigest: string;
  readonly decisionDigest: string;
  readonly criterionDigest: string;
  readonly rendered: true;
  readonly identityValid: true;
  readonly digestMatched: true;
  readonly degraded: false;
  readonly authorityProof: CreativeAdmissionProof;
  readonly admissionDigest: string;
}

const DIGEST = /^[a-f0-9]{64}$/;
const hash = (value: unknown): string => createHash('sha256')
  .update(JSON.stringify(value)).digest('hex');
const bodyOf = (input: Omit<ExplorationDecisionAdmission, 'schema' |
  'schemaVersion' | 'authorityProof' | 'admissionDigest'>) => ({
  schema: 'sinter.exploration-decision-admission' as const, schemaVersion: 1 as const,
  ...input,
});

export function createExplorationDecisionAdmission(input: Omit<ExplorationDecisionAdmission,
  'schema' | 'schemaVersion' | 'authorityProof' | 'admissionDigest'>,
authority?: CreativeAdmissionSigner): ExplorationDecisionAdmission {
  const body = bodyOf(input);
  if (!input.artifactId || !input.role || !input.domain
    || !Number.isFinite(input.criterionScore) || input.criterionScore < 0
    || input.criterionScore > 1
    || !['accepted', 'rejected'].includes(input.ownerDecision)
    || ![input.artifactDigest, input.evidenceDigest, input.decisionDigest,
      input.criterionDigest].every(value => DIGEST.test(value))
    || !input.rendered || !input.identityValid || !input.digestMatched || input.degraded) {
    throw new Error('EXPLORATION_DECISION_EVIDENCE_INVALID');
  }
  const authorityProof = sealCreativeAdmission(body, authority);
  const admitted = { ...body, authorityProof };
  return Object.freeze({ ...admitted, admissionDigest: hash(admitted) });
}

export function validateExplorationDecisionAdmission(admission: ExplorationDecisionAdmission,
  scope: Pick<ExplorationDecisionAdmission, 'purpose' | 'artifactId' | 'role' | 'domain'>):
  ExplorationDecisionAdmission {
  const { admissionDigest, authorityProof, schema: _schema,
    schemaVersion: _version, ...input } = admission;
  const body = bodyOf(input);
  if (hash({ ...body, authorityProof }) !== admissionDigest
    || !verifyCreativeAdmission(body, authorityProof)) {
    throw new Error('EXPLORATION_DECISION_DIGEST_MISMATCH');
  }
  if (admission.ownerDecision !== 'accepted') {
    throw new Error('EXPLORATION_REJECTED_NOT_ADMISSIBLE');
  }
  if (Object.entries(scope).some(([key, value]) => admission[key as keyof typeof scope] !== value)) {
    throw new Error('EXPLORATION_DECISION_SCOPE_MISMATCH');
  }
  return admission;
}
