import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const DOMAIN_INCUBATION_SCHEMA_VERSION = 1 as const;

export type IncubationEvidenceKind =
  | 'creative'
  | 'evaluation'
  | 'consolidation'
  | 'causal';

export interface MissingCapabilitySignal {
  id: string;
  kind: IncubationEvidenceKind;
  capabilityKey: string;
  claim: string;
  evidenceRef: string;
  lineageId: string;
}

export interface DomainIncubationSpecification {
  routing: string[];
  generation: string[];
  evaluation: string[];
  persistence: string[];
  documentation: string[];
  rejectionTests: string[];
}

export interface DomainIncubationInput {
  slug: string;
  displayName: string;
  kind: 'domain' | 'composition-primitive';
  rationale: string;
  ownerConfirmed: boolean;
  signals: MissingCapabilitySignal[];
  specification: DomainIncubationSpecification;
}

export interface DomainIncubationRecommendation extends DomainIncubationInput {
  schemaVersion: typeof DOMAIN_INCUBATION_SCHEMA_VERSION;
  candidateId: string;
  status: 'recommended';
  allowedAction: 'open-isolated-incubator';
  promotion: 'forbidden';
  receiptDigest: string;
}

export interface IncubationCapabilityProof {
  candidateId: string;
  routing: {
    capabilityKey: string;
    selectedCandidateId: string;
    evidenceRef: string;
  };
  generation: { artifactDigest: string; runnable: boolean; evidenceRef: string };
  evaluation: {
    artifactDigest: string;
    hardFloorsPass: boolean;
    evidenceRef: string;
  };
  persistence: { recordDigest: string; roundTrip: boolean; evidenceRef: string };
  documentation: { candidateId: string; complete: boolean; evidenceRef: string };
  rejectionTests: Array<{ name: string; passed: boolean }>;
}

export interface EvaluatedDomainIncubation {
  schemaVersion: typeof DOMAIN_INCUBATION_SCHEMA_VERSION;
  candidateId: string;
  recommendationDigest: string;
  status: 'ready-for-owner-review' | 'rejected';
  allowedAction: 'request-owner-domain-review' | 'archive-rejected-incubator';
  promotion: 'forbidden';
  proof: IncubationCapabilityProof;
  rejectionReasons: string[];
  receiptDigest: string;
}

export type PersistableIncubationRecord =
  | DomainIncubationRecommendation
  | EvaluatedDomainIncubation;

const EVIDENCE_KINDS: IncubationEvidenceKind[] = [
  'creative', 'evaluation', 'consolidation', 'causal',
];

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map(key =>
      `${JSON.stringify(key)}:${canonical(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function digest(value: unknown): string {
  return createHash('sha256').update(canonical(value)).digest('hex');
}

function requireText(value: string, field: string): void {
  if (!value?.trim()) throw new Error(`DOMAIN_INCUBATOR_MISSING:${field}`);
}

function validateCandidateId(candidateId: string): void {
  if (!/^incubator:[a-z0-9]+(?:-[a-z0-9]+)*:[a-f0-9]{12}$/.test(candidateId)) {
    throw new Error('DOMAIN_INCUBATOR_INVALID_CANDIDATE_ID');
  }
}

function validateSpecification(specification: DomainIncubationSpecification): void {
  for (const field of [
    'routing', 'generation', 'evaluation', 'persistence', 'documentation',
  ] as const) {
    if (specification[field].length === 0 || specification[field].some(item => !item.trim())) {
      throw new Error(`DOMAIN_INCUBATOR_SPEC_INCOMPLETE:${field}`);
    }
  }
  if (
    specification.rejectionTests.length < 2
    || specification.rejectionTests.some(item => !item.trim())
  ) {
    throw new Error('DOMAIN_INCUBATOR_SPEC_INCOMPLETE:rejectionTests');
  }
}

function validateSignals(input: DomainIncubationInput): void {
  const seen = new Set<string>();
  for (const signal of input.signals) {
    requireText(signal.id, 'signal.id');
    requireText(signal.claim, 'signal.claim');
    requireText(signal.evidenceRef, 'signal.evidenceRef');
    requireText(signal.lineageId, 'signal.lineageId');
    if (signal.capabilityKey !== input.slug || seen.has(signal.id)) {
      throw new Error('DOMAIN_INCUBATOR_SIGNAL_INVALID');
    }
    seen.add(signal.id);
  }
  const kinds = new Set(input.signals.map(signal => signal.kind));
  if (!EVIDENCE_KINDS.every(kind => kinds.has(kind))) {
    throw new Error('DOMAIN_INCUBATOR_EVIDENCE_ENVELOPE_INCOMPLETE');
  }
  if (!input.ownerConfirmed && input.signals.length < EVIDENCE_KINDS.length) {
    throw new Error('DOMAIN_INCUBATOR_REPEATED_EVIDENCE_REQUIRED');
  }
}

export function recommendDomainIncubation(
  input: DomainIncubationInput,
): DomainIncubationRecommendation {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(input.slug)) {
    throw new Error('DOMAIN_INCUBATOR_INVALID_SLUG');
  }
  requireText(input.displayName, 'displayName');
  requireText(input.rationale, 'rationale');
  validateSignals(input);
  validateSpecification(input.specification);
  const candidateId = `incubator:${input.slug}:${digest(input).slice(0, 12)}`;
  const unsigned = {
    schemaVersion: DOMAIN_INCUBATION_SCHEMA_VERSION,
    ...structuredClone(input),
    candidateId,
    status: 'recommended' as const,
    allowedAction: 'open-isolated-incubator' as const,
    promotion: 'forbidden' as const,
  };
  return { ...unsigned, receiptDigest: digest(unsigned) };
}

export function parseDomainIncubationRecommendation(
  value: unknown,
): DomainIncubationRecommendation {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('INVALID_DOMAIN_INCUBATOR_RECOMMENDATION');
  }
  const record = value as DomainIncubationRecommendation;
  if (
    record.schemaVersion !== DOMAIN_INCUBATION_SCHEMA_VERSION
    || record.status !== 'recommended'
    || record.allowedAction !== 'open-isolated-incubator'
    || record.promotion !== 'forbidden'
  ) {
    throw new Error('INVALID_DOMAIN_INCUBATOR_RECOMMENDATION');
  }
  const { receiptDigest, schemaVersion: _schema, candidateId, status: _status,
    allowedAction: _action, promotion: _promotion, ...input } = record;
  validateCandidateId(candidateId);
  const expected = recommendDomainIncubation(input);
  if (canonical(expected) !== canonical(record) || !receiptDigest) {
    throw new Error('INVALID_DOMAIN_INCUBATOR_RECOMMENDATION:digest');
  }
  return record;
}

function proofRejectionReasons(
  recommendation: DomainIncubationRecommendation,
  proof: IncubationCapabilityProof,
): string[] {
  const reasons: string[] = [];
  if (proof.candidateId !== recommendation.candidateId) reasons.push('candidate-mismatch');
  if (
    proof.routing.capabilityKey !== recommendation.slug
    || proof.routing.selectedCandidateId !== recommendation.candidateId
    || !proof.routing.evidenceRef
  ) reasons.push('routing');
  if (
    !proof.generation.runnable
    || !proof.generation.evidenceRef
    || !/^[a-f0-9]{64}$/.test(proof.generation.artifactDigest)
  ) reasons.push('generation');
  if (
    !proof.evaluation.hardFloorsPass
    || !proof.evaluation.evidenceRef
    || proof.evaluation.artifactDigest !== proof.generation.artifactDigest
  ) {
    reasons.push('evaluation');
  }
  if (
    !proof.persistence.roundTrip
    || !proof.persistence.evidenceRef
    || proof.persistence.recordDigest !== recommendation.receiptDigest
  ) reasons.push('persistence');
  if (
    !proof.documentation.complete
    || !proof.documentation.evidenceRef
    || proof.documentation.candidateId !== recommendation.candidateId
  ) {
    reasons.push('documentation');
  }
  const declared = new Set(recommendation.specification.rejectionTests);
  if (
    proof.rejectionTests.length !== declared.size
    || proof.rejectionTests.some(test => !declared.has(test.name) || !test.passed)
  ) {
    reasons.push('rejection-tests');
  }
  return reasons;
}

export function evaluateDomainIncubator(
  recommendationValue: unknown,
  proof: IncubationCapabilityProof,
): EvaluatedDomainIncubation {
  const recommendation = parseDomainIncubationRecommendation(recommendationValue);
  const rejectionReasons = proofRejectionReasons(recommendation, proof);
  const ready = rejectionReasons.length === 0;
  const unsigned = {
    schemaVersion: DOMAIN_INCUBATION_SCHEMA_VERSION,
    candidateId: recommendation.candidateId,
    recommendationDigest: recommendation.receiptDigest,
    status: ready ? 'ready-for-owner-review' as const : 'rejected' as const,
    allowedAction: ready
      ? 'request-owner-domain-review' as const
      : 'archive-rejected-incubator' as const,
    promotion: 'forbidden' as const,
    proof: structuredClone(proof),
    rejectionReasons,
  };
  return { ...unsigned, receiptDigest: digest(unsigned) };
}

export function parseEvaluatedDomainIncubation(
  value: unknown,
): EvaluatedDomainIncubation {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('INVALID_DOMAIN_INCUBATOR_EVALUATION');
  }
  const record = value as EvaluatedDomainIncubation;
  const ready = record.status === 'ready-for-owner-review'
    && record.allowedAction === 'request-owner-domain-review';
  const rejected = record.status === 'rejected'
    && record.allowedAction === 'archive-rejected-incubator';
  const { receiptDigest, ...unsigned } = record;
  if (
    record.schemaVersion !== DOMAIN_INCUBATION_SCHEMA_VERSION
    || (!ready && !rejected)
    || record.promotion !== 'forbidden'
    || !receiptDigest
    || digest(unsigned) !== receiptDigest
    || ready !== (record.rejectionReasons.length === 0)
  ) {
    throw new Error('INVALID_DOMAIN_INCUBATOR_EVALUATION');
  }
  validateCandidateId(record.candidateId);
  return record;
}

function recordSegment(candidateId: string): string {
  validateCandidateId(candidateId);
  return candidateId.replaceAll(':', '--');
}

export class DomainIncubatorStore {
  readonly #root: string;

  constructor(root: string) {
    if (!path.isAbsolute(root)) throw new Error('DOMAIN_INCUBATOR_ROOT_NOT_ABSOLUTE');
    this.#root = path.resolve(root);
  }

  async save(recordValue: PersistableIncubationRecord): Promise<string> {
    const record = recordValue.status === 'recommended'
      ? parseDomainIncubationRecommendation(recordValue)
      : parseEvaluatedDomainIncubation(recordValue);
    const directory = path.join(this.#root, recordSegment(record.candidateId));
    const target = path.join(directory, `${record.status}.json`);
    const temporary = `${target}.tmp`;
    await mkdir(directory, { recursive: true });
    await writeFile(temporary, `${JSON.stringify(record, null, 2)}\n`, {
      encoding: 'utf8',
      flag: 'wx',
    });
    await rename(temporary, target);
    return target;
  }

  /** Atomically create an immutable recommendation or return the exact prior value. */
  async getOrCreate(
    recordValue: DomainIncubationRecommendation,
  ): Promise<{ record: DomainIncubationRecommendation; created: boolean }> {
    const record = parseDomainIncubationRecommendation(recordValue);
    const directory = path.join(this.#root, recordSegment(record.candidateId));
    const target = path.join(directory, `${record.status}.json`);
    await mkdir(directory, { recursive: true });
    try {
      await writeFile(target, `${JSON.stringify(record, null, 2)}\n`, {
        encoding: 'utf8', flag: 'wx',
      });
      return { record, created: true };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const existing = await this.load(record.candidateId, 'recommended');
      if (JSON.stringify(existing) !== JSON.stringify(record)) {
        throw new Error('DOMAIN_INCUBATOR_GET_OR_CREATE_CONFLICT');
      }
      return { record: existing as DomainIncubationRecommendation, created: false };
    }
  }

  async load(
    candidateId: string,
    status: PersistableIncubationRecord['status'],
  ): Promise<PersistableIncubationRecord> {
    const target = path.join(
      this.#root,
      recordSegment(candidateId),
      `${status}.json`,
    );
    const value: unknown = JSON.parse(await readFile(target, 'utf8'));
    return status === 'recommended'
      ? parseDomainIncubationRecommendation(value)
      : parseEvaluatedDomainIncubation(value);
  }
}
