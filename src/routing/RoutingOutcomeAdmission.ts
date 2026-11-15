import { createHash } from 'node:crypto';
import { sealCreativeAdmission, verifyCreativeAdmission,
  type CreativeAdmissionProof, type CreativeAdmissionSigner } from
  '../runtime-core/CreativeAdmissionAuthority.js';

export interface RoutingOutcomeAdmission {
  readonly schema: 'sinter.routing-outcome-admission';
  readonly schemaVersion: 1;
  readonly role: string;
  readonly domain: string;
  readonly model: string;
  readonly criterionScore: number;
  readonly ownerDecision: 'accepted' | 'rejected';
  readonly artifactDigest: string;
  readonly evidenceDigest: string;
  readonly decisionDigest: string;
  readonly rendered: true;
  readonly identityValid: true;
  readonly digestMatched: true;
  readonly degraded: false;
  readonly authorityProof: CreativeAdmissionProof;
  readonly admissionDigest: string;
}

const HEX = /^[a-f0-9]{64}$/;
const hash = (value: unknown): string => createHash('sha256')
  .update(JSON.stringify(value)).digest('hex');

export function createRoutingOutcomeAdmission(input: Omit<RoutingOutcomeAdmission,
  'schema' | 'schemaVersion' | 'authorityProof' | 'admissionDigest'>,
authority?: CreativeAdmissionSigner): RoutingOutcomeAdmission {
  if (!input.role.trim() || !input.domain.trim() || !input.model.trim()
    || !Number.isFinite(input.criterionScore) || input.criterionScore < 0
    || input.criterionScore > 1
    || !['accepted', 'rejected'].includes(input.ownerDecision)
    || ![input.artifactDigest, input.evidenceDigest, input.decisionDigest]
      .every(value => HEX.test(value))
    || !input.rendered || !input.identityValid || !input.digestMatched || input.degraded) {
    throw new Error('ROUTING_OUTCOME_EVIDENCE_INVALID');
  }
  const body = { schema: 'sinter.routing-outcome-admission' as const,
    schemaVersion: 1 as const, ...input };
  const authorityProof = sealCreativeAdmission(body, authority);
  const admitted = { ...body, authorityProof };
  return Object.freeze({ ...admitted, admissionDigest: hash(admitted) });
}

export function validateRoutingOutcomeAdmission(
  admission: RoutingOutcomeAdmission,
  scope: Pick<RoutingOutcomeAdmission, 'role' | 'domain' | 'model'>,
): RoutingOutcomeAdmission {
  const { admissionDigest, authorityProof, ...body } = admission;
  if (admission.schema !== 'sinter.routing-outcome-admission'
    || admission.schemaVersion !== 1 || hash({ ...body, authorityProof }) !== admissionDigest
    || !verifyCreativeAdmission(body, authorityProof)
    || admission.rendered !== true || admission.identityValid !== true
    || admission.digestMatched !== true || admission.degraded !== false) {
    throw new Error('ROUTING_OUTCOME_ADMISSION_INVALID');
  }
  if (admission.ownerDecision !== 'accepted') {
    throw new Error('ROUTING_OUTCOME_REJECTED_NOT_ADMISSIBLE');
  }
  if (admission.role !== scope.role || admission.domain !== scope.domain
    || admission.model !== scope.model) {
    throw new Error('ROUTING_OUTCOME_SCOPE_MISMATCH');
  }
  return admission;
}
