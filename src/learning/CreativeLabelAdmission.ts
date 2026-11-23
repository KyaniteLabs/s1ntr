import { createHash } from 'node:crypto';
import { sealCreativeAdmission, verifyCreativeAdmission,
  type CreativeAdmissionProof, type CreativeAdmissionSigner } from
  '../runtime-core/CreativeAdmissionAuthority.js';

export type CreativeLabelTrustKind =
  | 'owner-preference' | 'universal-criterion' | 'transfer-principle' | 'judge-scoring'
  | 'legacy-backfill-judge';
export type CreativeLabelUse = 'few-shot' | 'evaluator-training' | 'hard-negative';

export interface CreativeLabelAdmission {
  readonly schema: 'sinter.creative-label-admission';
  readonly schemaVersion: 1;
  readonly trustKind: CreativeLabelTrustKind;
  readonly allowedUses: readonly CreativeLabelUse[];
  readonly artifactDigest: string;
  readonly evidenceDigest: string;
  readonly decisionDigest: string;
  /** Signed archive projection for evaluator training from a governed Create. */
  readonly trainingEvidence?: { readonly operationDigest: string; readonly quality: number };
  readonly rendered: true;
  readonly identityValid: true;
  readonly digestMatched: true;
  readonly degraded: false;
  readonly authorityProof: CreativeAdmissionProof;
  readonly labelDigest: string;
}

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

function validTrainingEvidence(input: Pick<CreativeLabelAdmission, 'trainingEvidence' | 'trustKind' | 'allowedUses'>): boolean {
  const evidence = input.trainingEvidence;
  return evidence === undefined || Boolean(evidence && DIGEST.test(evidence.operationDigest)
    && Number.isFinite(evidence.quality) && evidence.quality >= 0 && evidence.quality <= 1
    && input.trustKind === 'judge-scoring'
    && input.allowedUses.length === 1 && input.allowedUses[0] === 'evaluator-training');
}

export function createCreativeLabelAdmission(input: Omit<CreativeLabelAdmission,
  'schema' | 'schemaVersion' | 'authorityProof' | 'labelDigest'>,
authority?: CreativeAdmissionSigner): CreativeLabelAdmission {
  if (input.rendered !== true || input.identityValid !== true
    || input.digestMatched !== true || input.degraded !== false || !validTrainingEvidence(input)
    || ![input.artifactDigest, input.evidenceDigest,
      input.decisionDigest].every(value => DIGEST.test(value))) {
    throw new Error('CREATIVE_LABEL_EVIDENCE_INVALID');
  }
  if (!['owner-preference', 'universal-criterion', 'transfer-principle', 'judge-scoring', 'legacy-backfill-judge']
    .includes(input.trustKind) || input.allowedUses.length === 0
    || input.allowedUses.some(use =>
      !['few-shot', 'evaluator-training', 'hard-negative'].includes(use))) {
    throw new Error('CREATIVE_LABEL_TRUST_INVALID');
  }
  const body = Object.freeze({ schema: 'sinter.creative-label-admission' as const,
    schemaVersion: 1 as const, ...input,
    ...(input.trainingEvidence ? { trainingEvidence: Object.freeze({ ...input.trainingEvidence }) } : {}),
    allowedUses: Object.freeze([...new Set(input.allowedUses)]) });
  const authorityProof = sealCreativeAdmission(body, authority);
  const admitted = Object.freeze({ ...body, authorityProof });
  return Object.freeze({ ...admitted, labelDigest: digest(admitted) });
}

export function validateCreativeLabelAdmission(value: CreativeLabelAdmission,
  use: CreativeLabelUse): CreativeLabelAdmission {
  const { labelDigest, authorityProof, ...body } = value;
  if (value.schema !== 'sinter.creative-label-admission' || value.schemaVersion !== 1
    || labelDigest !== digest({ ...body, authorityProof })
    || !verifyCreativeAdmission(body, authorityProof) || value.rendered !== true
    || value.identityValid !== true || value.digestMatched !== true
    || value.degraded !== false || !validTrainingEvidence(value)) throw new Error('CREATIVE_LABEL_ADMISSION_INVALID');
  if (!value.allowedUses.includes(use)) throw new Error('CREATIVE_LABEL_USE_NOT_ADMITTED');
  return value;
}

export function isCreativeLabelAdmitted(value: CreativeLabelAdmission | undefined,
  use: CreativeLabelUse): boolean {
  try {
    return Boolean(value && validateCreativeLabelAdmission(value, use));
  } catch {
    return false;
  }
}
