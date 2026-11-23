import { createHash } from 'node:crypto';
import { createCreativeLabelAdmission, isCreativeLabelAdmitted,
  type CreativeLabelAdmission } from './CreativeLabelAdmission.js';
import { JUDGE_POSITIVE_FLOOR, JUDGE_HARD_NEGATIVE_BELOW, classifyJudgeScore } from './JudgeFloor.js';
import type { CreativeAdmissionSigner } from '../runtime-core/CreativeAdmissionAuthority.js';

/**
 * Explicit authority for legacy pieces that have no run root and no signed Create receipt.
 * They are never given a forged receipt: the label says `legacy-backfill-judge`, binds the file
 * digest, the render the judge saw, the pinned judge and the score, and carries a reduced weight.
 * They can train the evaluator or teach hard negatives; they can never be dream evidence.
 */
export const LEGACY_BACKFILL_RULE_ID = 'legacy-backfill-judge-v2-simon40';
export const LEGACY_BACKFILL_WEIGHT = 0.25;
export const LEGACY_BACKFILL_CAP = 0.3;

const DIGEST = /^[a-f0-9]{64}$/;
const sha = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex');
const stable = (value: unknown): string => {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map(key =>
    `${JSON.stringify(key)}:${stable(record[key])}`).join(',')}}`;
};

export interface LegacyBackfillRow {
  readonly provenance: 'legacy-backfill';
  readonly fileDigest: string;
  readonly renderDigest: string;
  readonly judge: string;
  readonly judgeVersion: string;
  readonly score: number;
  readonly ruleId: typeof LEGACY_BACKFILL_RULE_ID;
  readonly decision: 'accepted' | 'rejected';
  readonly weight: number;
  readonly label: CreativeLabelAdmission;
}

type Bound = Pick<LegacyBackfillRow, 'fileDigest' | 'renderDigest' | 'judge' | 'judgeVersion'
  | 'score' | 'decision' | 'weight'>;

export const legacyBackfillDecisionDigest = (bound: Bound): string => sha(stable({
  ruleId: LEGACY_BACKFILL_RULE_ID, positiveFloor: JUDGE_POSITIVE_FLOOR, hardNegativeBelow: JUDGE_HARD_NEGATIVE_BELOW, fileDigest: bound.fileDigest,
  renderDigest: bound.renderDigest, judge: bound.judge, judgeVersion: bound.judgeVersion,
  score: bound.score, decision: bound.decision, weight: bound.weight }));

export function buildLegacyBackfillRow(input: { sourceBytes: string | Buffer; renderDigest: string;
  judge: string; judgeVersion: string; score: number }, signer?: CreativeAdmissionSigner): LegacyBackfillRow {
  if (!Number.isFinite(input.score) || input.score < 0 || input.score > 1) {
    throw new Error('LEGACY_BACKFILL_SCORE_INVALID');
  }
  if (!DIGEST.test(input.renderDigest)) throw new Error('LEGACY_BACKFILL_RENDER_DIGEST_INVALID');
  if (!input.judge.trim() || !input.judgeVersion.trim()) throw new Error('LEGACY_BACKFILL_JUDGE_UNPINNED');
  const fileDigest = sha(input.sourceBytes);
  const klass = classifyJudgeScore(input.score);
  if (klass === 'gray') throw new Error('LEGACY_BACKFILL_SCORE_GRAY_ZONE');
  const decision = klass;
  const bound: Bound = { fileDigest, renderDigest: input.renderDigest, judge: input.judge,
    judgeVersion: input.judgeVersion, score: input.score, decision, weight: LEGACY_BACKFILL_WEIGHT };
  const label = createCreativeLabelAdmission({ trustKind: 'legacy-backfill-judge',
    allowedUses: decision === 'accepted' ? ['evaluator-training'] : ['hard-negative'],
    artifactDigest: fileDigest, evidenceDigest: input.renderDigest,
    decisionDigest: legacyBackfillDecisionDigest(bound),
    rendered: true, identityValid: true, digestMatched: true, degraded: false }, signer);
  return Object.freeze({ provenance: 'legacy-backfill' as const, ...bound,
    ruleId: LEGACY_BACKFILL_RULE_ID, label });
}

/** True only if the score, judge, weight and file digest still match the sealed label. */
export function verifyLegacyBackfillRow(row: LegacyBackfillRow): boolean {
  try {
    const use = row.decision === 'accepted' ? 'evaluator-training' : 'hard-negative';
    return row.provenance === 'legacy-backfill' && row.ruleId === LEGACY_BACKFILL_RULE_ID
      && row.weight === LEGACY_BACKFILL_WEIGHT && Number.isFinite(row.score)
      && row.decision === classifyJudgeScore(row.score)
      && row.label.trustKind === 'legacy-backfill-judge'
      && row.label.artifactDigest === row.fileDigest && row.label.evidenceDigest === row.renderDigest
      && row.label.decisionDigest === legacyBackfillDecisionDigest(row)
      && isCreativeLabelAdmitted(row.label, use);
  } catch { return false; }
}

export interface LegacyBackfillSelection {
  admitted: LegacyBackfillRow[]; excludedHoldout: number; rejectedInvalid: number;
  duplicates: number; droppedForCap: number;
}

/**
 * Holdout exclusion is by file digest. Backfill is capped so it is at most `cap` of live + backfill.
 */
export function selectLegacyBackfill(rows: readonly LegacyBackfillRow[], options: {
  liveCount: number; holdoutFileDigests: ReadonlySet<string>; cap?: number }): LegacyBackfillSelection {
  const cap = options.cap ?? LEGACY_BACKFILL_CAP;
  const out: LegacyBackfillSelection = { admitted: [], excludedHoldout: 0, rejectedInvalid: 0,
    duplicates: 0, droppedForCap: 0 };
  const seen = new Set<string>(); const eligible: LegacyBackfillRow[] = [];
  for (const row of rows) {
    if (!verifyLegacyBackfillRow(row)) { out.rejectedInvalid += 1; continue; }
    if (options.holdoutFileDigests.has(row.fileDigest)) { out.excludedHoldout += 1; continue; }
    if (seen.has(row.fileDigest)) { out.duplicates += 1; continue; }
    seen.add(row.fileDigest); eligible.push(row);
  }
  const room = Math.max(0, Math.floor(cap * Math.max(0, options.liveCount) / (1 - cap) + 1e-9));
  eligible.sort((a, b) => a.fileDigest.localeCompare(b.fileDigest));
  out.admitted = eligible.slice(0, room);
  out.droppedForCap = eligible.length - out.admitted.length;
  return out;
}

/** Growth-queue row for `judge-negatives.jsonl`; null unless rejected. */
export function legacyNegativeRow(row: LegacyBackfillRow) {
  if (row.decision !== 'rejected') return null;
  return { id: `legacy:${row.fileDigest}`, source: 'legacy-backfill' as const,
    input: { domain: 'html', artifact_sha256: row.fileDigest },
    label: { creative_label: row.label },
    metadata: { judgeScore: row.score, judge: row.judge, judgeVersion: row.judgeVersion,
      ruleId: row.ruleId, weight: row.weight } };
}
