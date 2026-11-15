import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

export const CREATIVE_JUDGMENT_DIMENSIONS = [
  'cohesion',
  'structuralDepth',
  'spatialEmbodiment',
  'materiality',
  'motionPurpose',
  'composition',
  'palette',
  'finish',
] as const;

export type CreativeJudgmentDimension = typeof CREATIVE_JUDGMENT_DIMENSIONS[number];
export type CreativeJudgmentScores = Record<CreativeJudgmentDimension, number>;

export interface CreativeJudgmentCandidate {
  id: string;
  evidenceDigest: string;
  dimensions: CreativeJudgmentScores;
}

export interface CreativeJudgmentComparison {
  schema: 'sinter.creative-judgment-comparison';
  candidateSetDigest: string;
  referenceRanking: string[];
  evaluatorRanking: string[];
  candidates: CreativeJudgmentCandidate[];
}

export interface CreativeJudgmentProfile {
  schema: 'sinter.creative-judgment-profile';
  version: 1;
  weights: CreativeJudgmentScores;
  guidance: string[];
  sourceCandidateSetDigests: string[];
  comparisonCount: number;
  profileDigest: string;
}

const DEFAULT_WEIGHT = 1 / CREATIVE_JUDGMENT_DIMENSIONS.length;
const SHA256 = /^[a-f0-9]{64}$/;

function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function defaultWeights(): CreativeJudgmentScores {
  return Object.fromEntries(
    CREATIVE_JUDGMENT_DIMENSIONS.map(dimension => [dimension, DEFAULT_WEIGHT]),
  ) as CreativeJudgmentScores;
}

function profileBody(profile: Omit<CreativeJudgmentProfile, 'profileDigest'>) {
  return {
    schema: profile.schema,
    version: profile.version,
    weights: profile.weights,
    guidance: profile.guidance,
    sourceCandidateSetDigests: profile.sourceCandidateSetDigests,
    comparisonCount: profile.comparisonCount,
  };
}

export function createCreativeJudgmentProfile(): CreativeJudgmentProfile {
  const body = {
    schema: 'sinter.creative-judgment-profile' as const,
    version: 1 as const,
    weights: defaultWeights(),
    guidance: [],
    sourceCandidateSetDigests: [],
    comparisonCount: 0,
  };
  return { ...body, profileDigest: digest(body) };
}

export function creativeJudgmentProfilePath(): string {
  return process.env.SINTER_JUDGMENT_PROFILE
    ?? path.join(homedir(), '.sinter', 'learning', 'creative-judgment.json');
}

function normalizeWeights(weights: CreativeJudgmentScores): CreativeJudgmentScores {
  const bounded = CREATIVE_JUDGMENT_DIMENSIONS.map(dimension => (
    Math.max(0.01, Number.isFinite(weights[dimension]) ? weights[dimension] : DEFAULT_WEIGHT)
  ));
  const total = bounded.reduce((sum, weight) => sum + weight, 0);
  return Object.fromEntries(CREATIVE_JUDGMENT_DIMENSIONS.map((dimension, index) => (
    [dimension, bounded[index] / total]
  ))) as CreativeJudgmentScores;
}

export function validateCreativeJudgmentProfile(
  value: CreativeJudgmentProfile,
): CreativeJudgmentProfile {
  if (value.schema !== 'sinter.creative-judgment-profile' || value.version !== 1) {
    throw new Error('CREATIVE_JUDGMENT_PROFILE_SCHEMA_INVALID');
  }
  if (digest(profileBody(value)) !== value.profileDigest) {
    throw new Error('CREATIVE_JUDGMENT_PROFILE_DIGEST_MISMATCH');
  }
  return value;
}

export function loadCreativeJudgmentProfile(
  filePath?: string,
): CreativeJudgmentProfile {
  if (!filePath && process.env.NODE_ENV === 'test' && !process.env.SINTER_JUDGMENT_PROFILE) {
    return createCreativeJudgmentProfile();
  }
  const resolvedPath = filePath ?? creativeJudgmentProfilePath();
  try {
    const profile = JSON.parse(fs.readFileSync(resolvedPath, 'utf8')) as CreativeJudgmentProfile;
    return validateCreativeJudgmentProfile(profile);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return createCreativeJudgmentProfile();
    throw error;
  }
}

export function scoreCreativeJudgment(
  dimensions: CreativeJudgmentScores,
  profile: CreativeJudgmentProfile,
): number {
  validateCreativeJudgmentProfile(profile);
  return CREATIVE_JUDGMENT_DIMENSIONS.reduce((score, dimension) => (
    score + Math.max(0, Math.min(1, dimensions[dimension])) * profile.weights[dimension]
  ), 0);
}

function weightedScore(dimensions: CreativeJudgmentScores, weights: CreativeJudgmentScores): number {
  return CREATIVE_JUDGMENT_DIMENSIONS.reduce((score, dimension) => (
    score + dimensions[dimension] * weights[dimension]
  ), 0);
}

export function candidateSetDigest(candidates: CreativeJudgmentCandidate[]): string {
  return digest(candidates.map(candidate => ({
    id: candidate.id,
    evidenceDigest: candidate.evidenceDigest,
    dimensions: candidate.dimensions,
  })));
}

function assertComparison(comparison: CreativeJudgmentComparison): void {
  if (comparison.schema !== 'sinter.creative-judgment-comparison') {
    throw new Error('CREATIVE_JUDGMENT_COMPARISON_SCHEMA_INVALID');
  }
  if (comparison.candidates.length < 2
    || comparison.candidates.some(candidate => !candidate.id || !SHA256.test(candidate.evidenceDigest))) {
    throw new Error('CREATIVE_JUDGMENT_EVIDENCE_INVALID');
  }
  if (comparison.candidates.some(candidate => CREATIVE_JUDGMENT_DIMENSIONS.some(dimension => (
    !Number.isFinite(candidate.dimensions[dimension])
      || candidate.dimensions[dimension] < 0
      || candidate.dimensions[dimension] > 1
  )))) {
    throw new Error('CREATIVE_JUDGMENT_DIMENSIONS_INVALID');
  }
  if (candidateSetDigest(comparison.candidates) !== comparison.candidateSetDigest) {
    throw new Error('CREATIVE_JUDGMENT_CANDIDATE_SET_DIGEST_MISMATCH');
  }
  const ids = comparison.candidates.map(candidate => candidate.id);
  for (const ranking of [comparison.referenceRanking, comparison.evaluatorRanking]) {
    if (ranking.length !== ids.length || new Set(ranking).size !== ids.length
      || ranking.some(id => !ids.includes(id))) {
      throw new Error('CREATIVE_JUDGMENT_RANKING_INVALID');
    }
  }
}

function invertedPairs(comparison: CreativeJudgmentComparison): Array<[string, string]> {
  const evaluatorPosition = new Map(comparison.evaluatorRanking.map((id, index) => [id, index]));
  const pairs: Array<[string, string]> = [];
  comparison.referenceRanking.forEach((preferred, index) => {
    for (const lower of comparison.referenceRanking.slice(index + 1)) {
      if (evaluatorPosition.get(preferred)! > evaluatorPosition.get(lower)!) pairs.push([preferred, lower]);
    }
  });
  return pairs;
}

export function learnCreativeJudgment(
  comparison: CreativeJudgmentComparison,
  current: CreativeJudgmentProfile = loadCreativeJudgmentProfile(),
): CreativeJudgmentProfile {
  assertComparison(comparison);
  validateCreativeJudgmentProfile(current);
  const candidates = new Map(comparison.candidates.map(candidate => [candidate.id, candidate]));
  let learnedWeights = { ...current.weights };
  const inversions = invertedPairs(comparison);
  const referencePairs = comparison.referenceRanking.flatMap((preferred, index) => (
    comparison.referenceRanking.slice(index + 1).map(lower => [preferred, lower] as const)
  ));

  for (let step = 0; step < 25 && inversions.length > 0; step++) {
    const updates = { ...learnedWeights };
    let violated = false;
    for (const [preferredId, lowerId] of inversions) {
      const preferred = candidates.get(preferredId)!;
      const lower = candidates.get(lowerId)!;
      if (step > 0 && weightedScore(preferred.dimensions, learnedWeights)
        > weightedScore(lower.dimensions, learnedWeights)) continue;
      violated = true;
      for (const dimension of CREATIVE_JUDGMENT_DIMENSIONS) {
        updates[dimension] += 0.15 * (preferred.dimensions[dimension] - lower.dimensions[dimension]);
      }
    }
    if (!violated) break;
    learnedWeights = normalizeWeights(updates);
  }

  const unresolved = referencePairs.some(([preferredId, lowerId]) => (
    weightedScore(candidates.get(preferredId)!.dimensions, learnedWeights)
      <= weightedScore(candidates.get(lowerId)!.dimensions, learnedWeights)
  ));
  const hierarchyGuidance = 'Apply this ordering contract: first exclude visibly flat, unembodied work '
    + 'from the top tier; then rank the remaining candidates by whole-system cohesion, composition, palette, '
    + 'finish, and purposeful motion before raw volumetric ambition. Never select a 3D object as strongest '
    + 'solely because it is volumetric when its material, motion, or finish remain under-resolved.';
  if (unresolved) learnedWeights = { ...current.weights };

  const body = {
    schema: 'sinter.creative-judgment-profile' as const,
    version: 1 as const,
    weights: learnedWeights,
    guidance: unresolved
      ? [...new Set([...current.guidance, hierarchyGuidance])]
      : current.guidance,
    sourceCandidateSetDigests: [...new Set([
      ...current.sourceCandidateSetDigests,
      comparison.candidateSetDigest,
    ])],
    comparisonCount: current.comparisonCount + 1,
  };
  return { ...body, profileDigest: digest(body) };
}

export function persistCreativeJudgmentProfile(
  profile: CreativeJudgmentProfile,
  filePath: string = creativeJudgmentProfilePath(),
): void {
  validateCreativeJudgmentProfile(profile);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.tmp-${process.pid}`;
  fs.writeFileSync(temporary, `${JSON.stringify(profile, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, filePath);
}
