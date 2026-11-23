import { createHash } from 'node:crypto';
import { boundedEvaluatorImages } from '../core/ScoringEngine.js';
import { evaluatorCall } from '../core/EvaluatorScope.js';
import type { LLMClient } from '../llm/LLMClient.js';
import { loadCreativeJudgmentProfile, type CreativeJudgmentProfile } from './CreativeJudgmentCalibration.js';

export interface RenderedComparisonCandidate {
  id: string;
  evidenceDigest: string;
  early: { mimeType: string; dataBase64: string; width?: number; height?: number };
  late: { mimeType: string; dataBase64: string; width?: number; height?: number };
}

export interface RenderedJudgmentComparison {
  ranking: string[];
  reasoning: string;
  comparisonDigest: string;
}

function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

export async function compareRenderedJudgment(
  candidates: RenderedComparisonCandidate[],
  llm: LLMClient,
  profile: CreativeJudgmentProfile = loadCreativeJudgmentProfile(),
): Promise<RenderedJudgmentComparison> {
  if (candidates.length < 2 || new Set(candidates.map(item => item.id)).size !== candidates.length) {
    throw new Error('RENDERED_COMPARISON_CANDIDATES_INVALID');
  }
  const images = await boundedEvaluatorImages(candidates.flatMap(candidate => ([
    { ...candidate.early, label: `candidate-${candidate.id}-early` },
    { ...candidate.late, label: `candidate-${candidate.id}-late` },
  ])));
  const ids = candidates.map(candidate => candidate.id);
  const response = await evaluatorCall(() => llm.generateWithImages(
    `You are a blind comparative visual-art judge. Rank only the supplied rendered evidence.
Judge primordial craft: cohesion, structural depth, spatial embodiment, materiality,
form-revealing motion, composition, palette, and finish. Demonstrated volume and material
behavior outrank merely clean flat overlap; surface polish cannot substitute for structure.
Use both temporal frames. Do not infer quality from implementation technique or candidate order.
Learned hierarchy guidance: ${profile.guidance.join(' ') || 'none'}
Return JSON only: {"ranking":["id"],"reasoning":"concise comparative explanation"}.`,
    `Rank these neutral candidate IDs from strongest to weakest: ${ids.join(', ')}.`,
    images,
    AbortSignal.timeout(120_000),
    true,
    { jsonMode: true, requireVision: true },
  ));
  const parsed = JSON.parse(response.code) as { ranking?: unknown; reasoning?: unknown };
  if (!Array.isArray(parsed.ranking)
    || parsed.ranking.length !== ids.length
    || new Set(parsed.ranking).size !== ids.length
    || parsed.ranking.some(id => typeof id !== 'string' || !ids.includes(id))) {
    throw new Error('RENDERED_COMPARISON_RANKING_INVALID');
  }
  const body = {
    ranking: parsed.ranking as string[],
    reasoning: typeof parsed.reasoning === 'string' ? parsed.reasoning : '',
    candidateEvidence: candidates.map(candidate => ({
      id: candidate.id,
      evidenceDigest: candidate.evidenceDigest,
    })),
  };
  return { ranking: body.ranking, reasoning: body.reasoning, comparisonDigest: digest(body) };
}
