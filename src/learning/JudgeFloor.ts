/**
 * Judge-score thresholds, calibrated against Simon's 40 labels (n=40, stratified 8 per band,
 * test/fixtures/judge-calibration-simon40.json; source learning/calibration-40.labeled.jsonl).
 * At the old 0.6 floor the production judge matched Simon on 62% and rejected 11 of 23 good pieces.
 * At 0.3 it matches on 82%, rejects 1 good piece and admits 6 bad ones (0.25: 85%, 0 good rejected).
 * 0.3 is an estimate from a small sample: re-run the fixture test when more labels exist.
 * Scores from 0.2 up to 0.3 are a gray zone that teaches nothing either way.
 */
export const JUDGE_SCORE_RULE_ID = 'judge-score-floor-v2-simon40';
export const JUDGE_POSITIVE_FLOOR = 0.3;
export const JUDGE_HARD_NEGATIVE_BELOW = 0.2;

export type JudgeScoreClass = 'accepted' | 'rejected' | 'gray';

export function classifyJudgeScore(score: number): JudgeScoreClass {
  if (!Number.isFinite(score)) throw new Error('JUDGE_SCORE_INVALID');
  if (score >= JUDGE_POSITIVE_FLOOR) return 'accepted';
  return score < JUDGE_HARD_NEGATIVE_BELOW ? 'rejected' : 'gray';
}
