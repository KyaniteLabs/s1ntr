import { createHash } from 'node:crypto';

export const CREATIVE_PROOF_SCHEMA_VERSION = 1 as const;

export type CreativeProofVerdict = 'pass' | 'fail' | 'not-evaluated';
export type CreativeProofModality = 'visual' | 'audio' | 'interaction' | 'text';
export type CreativeProofEvidenceKind =
  | 'image'
  | 'audio'
  | 'video'
  | 'interactive'
  | 'text';

export interface CreativeProofDomain {
  name: string;
  requiredModalities: CreativeProofModality[];
}

export interface CreativeProofEvidence {
  ref: string;
  kind: CreativeProofEvidenceKind;
  modalities: CreativeProofModality[];
  sha256: string;
  bytes: number;
  durationSeconds?: number;
}

export interface CreativeProofVerdictRecord {
  status: CreativeProofVerdict;
  evidenceRefs: string[];
  evaluatorRef?: string;
  rubricRef?: string;
}

export interface CreativeProofInput {
  schemaVersion: typeof CREATIVE_PROOF_SCHEMA_VERSION;
  domains: CreativeProofDomain[];
  evidence: CreativeProofEvidence[];
  verdicts: {
    technical: CreativeProofVerdictRecord;
    coordination: CreativeProofVerdictRecord;
    creativeQuality: CreativeProofVerdictRecord;
  };
  requestedClaims: {
    technicalSuccess: boolean;
    coordinationImproved: boolean;
    creativeQualityImproved: boolean;
  };
}

export type CreativeProofViolation =
  | 'INVALID_SCHEMA_VERSION'
  | 'INVALID_EVIDENCE'
  | 'NO_DOMAINS'
  | 'EMPTY_DOMAIN_MODALITIES'
  | 'EVIDENCE_UNREADABLE'
  | 'EVIDENCE_DIGEST_MISMATCH'
  | 'DOMAIN_MODALITY_MISMATCH'
  | 'MISSING_PRESENTATION_VISUAL'
  | 'MISSING_PRESENTATION_AUDIO'
  | 'MISSING_PRESENTATION_INTERACTION'
  | 'MISSING_PRESENTATION_TEXT'
  | 'TECHNICAL_SUCCESS_NOT_PROVEN'
  | 'COORDINATION_NOT_PROVEN'
  | 'CREATIVE_QUALITY_NOT_PROVEN';

export interface CreativeProofResult {
  outcome: 'PASS' | 'FAIL';
  claimable: {
    technicalSuccess: boolean;
    coordinationImproved: boolean;
    creativeQualityImproved: boolean;
    presentationComplete: boolean;
  };
  missingModalities: CreativeProofModality[];
  violations: CreativeProofViolation[];
  /**
   * True only when a `readEvidence` reader was supplied and every evidence
   * item's actual bytes matched its declared sha256 and byte length. Without
   * a reader, `sha256`/`bytes` are caller assertions checked for shape only,
   * so a PASS is a shape verdict, not artifact verification (#1316).
   */
  evidenceBytesVerified: boolean;
}

export interface CreativeProofOptions {
  /**
   * Returns the artifact bytes for an evidence ref, or null when the ref
   * cannot be read. When supplied, every evidence item is hashed and checked
   * against its declared digest and length.
   */
  readEvidence?: (ref: string) => Uint8Array | null;
}

const evidenceKindsByModality: Record<
  CreativeProofModality,
  CreativeProofEvidenceKind[]
> = {
  visual: ['image', 'video', 'interactive'],
  audio: ['audio', 'video', 'interactive'],
  interaction: ['interactive'],
  text: ['text', 'image', 'video', 'interactive'],
};

const knownDomainModality: Record<string, CreativeProofModality> = {
  tone: 'audio',
  strudel: 'audio',
  music: 'audio',
  p5: 'visual',
  glsl: 'visual',
  shader: 'visual',
  webgl: 'visual',
  three: 'visual',
  hydra: 'visual',
  ascii: 'visual',
  svg: 'visual',
  html: 'visual',
  dataviz: 'visual',
  kinetic: 'visual',
  revideo: 'visual',
  hyperframes: 'visual',
  video: 'visual',
  textgen: 'text',
};

function hasValidEvidenceShape(evidence: CreativeProofEvidence): boolean {
  return evidence.ref.length > 0
    && /^[a-f0-9]{64}$/i.test(evidence.sha256)
    && Number.isFinite(evidence.bytes)
    && evidence.bytes > 0
    && evidence.modalities.length > 0;
}

function evidenceCovers(
  evidence: CreativeProofEvidence,
  modality: CreativeProofModality,
): boolean {
  if (!hasValidEvidenceShape(evidence)) return false;
  if (!evidence.modalities.includes(modality)) return false;
  if (!evidenceKindsByModality[modality].includes(evidence.kind)) return false;
  if (modality !== 'audio') return true;
  return Number.isFinite(evidence.durationSeconds)
    && (evidence.durationSeconds ?? 0) > 0;
}

function qualityVerdictIsComplete(verdict: CreativeProofVerdictRecord): boolean {
  return verdict.status === 'pass'
    && verdict.evidenceRefs.length > 0
    && Boolean(verdict.evaluatorRef)
    && Boolean(verdict.rubricRef);
}

function verifyEvidenceBytes(
  evidence: CreativeProofEvidence[],
  readEvidence: (ref: string) => Uint8Array | null,
): CreativeProofViolation[] {
  const violations = new Set<CreativeProofViolation>();
  for (const item of evidence) {
    let bytes: Uint8Array | null;
    try {
      bytes = readEvidence(item.ref);
    } catch {
      bytes = null;
    }
    if (!bytes) {
      violations.add('EVIDENCE_UNREADABLE');
      continue;
    }
    const digest = createHash('sha256').update(bytes).digest('hex');
    if (bytes.byteLength !== item.bytes || digest !== item.sha256.toLowerCase()) {
      violations.add('EVIDENCE_DIGEST_MISMATCH');
    }
  }
  return [...violations];
}

export function evaluateCreativeProof(
  input: CreativeProofInput,
  options: CreativeProofOptions = {},
): CreativeProofResult {
  const violations: CreativeProofViolation[] = [];
  if (input.schemaVersion !== CREATIVE_PROOF_SCHEMA_VERSION) {
    violations.push('INVALID_SCHEMA_VERSION');
  }
  if (input.evidence.some(evidence => !hasValidEvidenceShape(evidence))) {
    violations.push('INVALID_EVIDENCE');
  }
  // With no domains, or a domain requiring no modality, the presentation
  // requirement is vacuous (#1316).
  if (input.domains.length === 0) {
    violations.push('NO_DOMAINS');
  }
  if (input.domains.some(domain => domain.requiredModalities.length === 0)) {
    violations.push('EMPTY_DOMAIN_MODALITIES');
  }
  let evidenceBytesVerified = false;
  if (options.readEvidence) {
    const byteViolations = verifyEvidenceBytes(input.evidence, options.readEvidence);
    violations.push(...byteViolations);
    evidenceBytesVerified = input.evidence.length > 0 && byteViolations.length === 0;
  }
  const domainModalitiesValid = input.domains.every(domain => {
    const knownModality = knownDomainModality[domain.name.toLowerCase()];
    return !knownModality || domain.requiredModalities.includes(knownModality);
  });
  if (!domainModalitiesValid) {
    violations.push('DOMAIN_MODALITY_MISMATCH');
  }

  const requiredModalities = [...new Set(
    input.domains.flatMap(domain => domain.requiredModalities),
  )];
  const missingModalities = requiredModalities.filter(modality =>
    !input.evidence.some(evidence => evidenceCovers(evidence, modality)));
  for (const modality of missingModalities) {
    violations.push(`MISSING_PRESENTATION_${modality.toUpperCase()}` as CreativeProofViolation);
  }

  const evidenceRefs = new Set(input.evidence.map(evidence => evidence.ref));
  const verdictIsProven = (verdict: CreativeProofVerdictRecord): boolean =>
    verdict.status === 'pass'
    && verdict.evidenceRefs.length > 0
    && verdict.evidenceRefs.every(ref => evidenceRefs.has(ref));
  const technicalSuccess = verdictIsProven(input.verdicts.technical);
  const coordinationImproved = verdictIsProven(input.verdicts.coordination);
  const creativeQualityImproved =
    qualityVerdictIsComplete(input.verdicts.creativeQuality)
    && input.verdicts.creativeQuality.evidenceRefs.every(ref => evidenceRefs.has(ref));

  if (input.requestedClaims.technicalSuccess && !technicalSuccess) {
    violations.push('TECHNICAL_SUCCESS_NOT_PROVEN');
  }
  if (input.requestedClaims.coordinationImproved && !coordinationImproved) {
    violations.push('COORDINATION_NOT_PROVEN');
  }
  if (input.requestedClaims.creativeQualityImproved && !creativeQualityImproved) {
    violations.push('CREATIVE_QUALITY_NOT_PROVEN');
  }

  return {
    outcome: violations.length === 0 ? 'PASS' : 'FAIL',
    claimable: {
      technicalSuccess,
      coordinationImproved,
      creativeQualityImproved,
      presentationComplete: missingModalities.length === 0,
    },
    missingModalities,
    violations,
    evidenceBytesVerified,
  };
}
