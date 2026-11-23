import type { CreativeLabelAdmission } from './CreativeLabelAdmission.js';

export interface JudgeEvidenceLike {
  readonly createKey: string; readonly decision: 'accepted' | 'rejected'; readonly domain: string;
  readonly artifactDigest: string; readonly score: number; readonly judge: string;
  readonly ruleId: string; readonly label: CreativeLabelAdmission;
}

/** Row for `judge-negatives.jsonl`, read by buildEvaluatorGrowthQueue. Null unless rejected. */
export function judgeNegativeRow(evidence: JudgeEvidenceLike) {
  if (evidence.decision !== 'rejected') return null;
  return { id: evidence.createKey, source: 'judge-scoring' as const,
    input: { domain: evidence.domain, artifact_sha256: evidence.artifactDigest },
    label: { creative_label: evidence.label },
    metadata: { judgeScore: evidence.score, judge: evidence.judge, ruleId: evidence.ruleId } };
}
