import { createHash } from 'node:crypto';
import { JUDGE_POSITIVE_FLOOR } from './JudgeFloor.js';
import { classifyEvaluationBinding, type EvaluationBinding } from '../runtime-core/LiminalCommandService.js';

/**
 * Score-based owner seal (Simon, 2026-11-18): the top judge-scored, accepted Creates become Dream
 * parents. Provenance is plain: "auto-sealed by owner rule: top score". It is NOT a hand signature.
 * The Create receipt and judge identity are still re-verified by `verifiedJudgeEvidence` at dream run.
 */
export const SCORE_SEAL_RULE = 'auto-sealed by owner rule: top score' as const;
export const SCORE_SEAL_DIRECTIVE = 'Simon, 2026-11-18: "you must add a way for it to learn from the highest scored art."';

export interface ScoreSealCandidate {
  readonly createKey: string;
  readonly score: number;
  readonly domain: string;
  readonly seat: string;
  readonly judge: string;
  readonly lineageId: string;
  readonly artifactDigest: string;
  readonly admissionEligible: boolean;
  readonly degraded: boolean;
  readonly identityValid: boolean;
  readonly failureClass?: string;
  /** Wall coordinates (seat dir / piece id) of the run that holds this Create. */
  readonly authorityKeyDigest?: string;
  /** Receipt scheme of the Create; 'mismatch' can never pass dream's judge-evidence check. */
  readonly evaluationBinding?: EvaluationBinding;
  readonly seat_dir?: string;
  readonly piece_id?: string;
  /** ISO time of an owner like on the wall; a liked piece is an owner seal and outranks score-only parents. */
  readonly likedAt?: string;
}

export const OWNER_LIKE_RULE = 'owner like';

export interface ScoreSealPolicy {
  /** Never below the judge floor; this is an additional bar for learning from the top only. */
  readonly minScore: number;
  readonly topPerDomain: number;
  /** Parents are only taken from this judge so every group shares one criterion. */
  readonly judge: string;
  /** Independent parent groups to emit; activation needs at least 2. */
  readonly groups: number;
  readonly parentsPerGroup: number;
}

export const DEFAULT_SCORE_SEAL_POLICY = Object.freeze({
  minScore: 0.5, topPerDomain: 8, groups: 2, parentsPerGroup: 2,
}) satisfies Omit<ScoreSealPolicy, 'judge'>;

export interface ScoreSealGroup {
  readonly idempotencyKey: string;
  readonly createKeys: readonly string[];
  readonly command: {
    readonly schema: 'sinter.dream-product-command'; readonly schemaVersion: 1;
    readonly idempotencyKey: string;
    readonly evidence: readonly { readonly createKey: string; readonly source: 'judge-scoring' }[];
  };
}

export interface ScoreSealResult {
  readonly sealed: boolean;
  readonly reason?: string;
  readonly groups: readonly ScoreSealGroup[];
  readonly provenance: {
    readonly rule: typeof SCORE_SEAL_RULE; readonly ownerDirective: string;
    readonly minScore: number; readonly judge: string; readonly topPerDomain: number;
    readonly sealedAt: string; readonly handSigned: false;
    readonly parents: readonly { createKey: string; score: number; domain: string; seat: string;
      signal: typeof SCORE_SEAL_RULE | typeof OWNER_LIKE_RULE; likedAt?: string }[];
  };
}

/** Eligible = accepted by the judge, rendered-and-admissible, scored by the pinned judge, above the bar. */
export function isScoreSealEligible(item: ScoreSealCandidate, policy: ScoreSealPolicy): boolean {
  return item.admissionEligible && !item.degraded && item.identityValid
    && (!item.failureClass || item.failureClass === 'none' || item.failureClass === 'aesthetic')
    && Number.isFinite(item.score)
    && item.score >= (item.likedAt ? JUDGE_POSITIVE_FLOOR : Math.max(policy.minScore, JUDGE_POSITIVE_FLOOR))
    && item.judge === policy.judge;
}

/** Drops Creates that fail their own receipt scheme; the count is reported, never thrown. */
export function skipUnverifiable<T extends { readonly evaluationBinding?: EvaluationBinding }>(
  candidates: readonly T[]): { kept: T[]; skipped: number } {
  const kept = candidates.filter(item => item.evaluationBinding !== 'mismatch');
  return { kept, skipped: candidates.length - kept.length };
}

export function selectScoreSealedParents(candidates: readonly ScoreSealCandidate[],
  policy: ScoreSealPolicy, now: Date = new Date()): ScoreSealResult {
  // Owner likes rank above every score-only parent; then score; then key for determinism.
  const byRank = (a: ScoreSealCandidate, b: ScoreSealCandidate): number =>
    Number(Boolean(b.likedAt)) - Number(Boolean(a.likedAt)) || b.score - a.score || a.createKey.localeCompare(b.createKey);
  // Top N per domain, then one parent per artifact and per lineage so groups cannot share sources.
  const domains = [...new Set(candidates.map(item => item.domain))].sort();
  const top = domains.flatMap(domain => candidates
    .filter(item => item.domain === domain && isScoreSealEligible(item, policy))
    .sort(byRank).slice(0, policy.topPerDomain)).sort(byRank);
  // Likes are retroactive: a like on an old piece joins the pool even outside the per-domain top N.
  const liked = candidates.filter(item => item.likedAt && isScoreSealEligible(item, policy)
    && !top.includes(item));
  top.push(...liked); top.sort(byRank);
  const seenArtifact = new Set<string>(); const seenLineage = new Set<string>();
  const pool = top.filter(item => {
    if (seenArtifact.has(item.artifactDigest) || seenLineage.has(item.lineageId)) return false;
    seenArtifact.add(item.artifactDigest); seenLineage.add(item.lineageId); return true;
  });
  const need = policy.groups * policy.parentsPerGroup;
  // One domain per seal run so every group shares the same principle; take the domain with the best parents.
  const byDomain = new Map<string, ScoreSealCandidate[]>();
  for (const item of pool) byDomain.set(item.domain, [...(byDomain.get(item.domain) ?? []), item]);
  const strength = (items: ScoreSealCandidate[]): number => items.slice(0, need).reduce((n, i) => n + i.score + (i.likedAt ? 10 : 0), 0);
  const bestDomain = [...byDomain.values()].filter(items => items.length >= need)
    .sort((a, b) => strength(b) - strength(a))[0];
  const provenanceBase = { rule: SCORE_SEAL_RULE, ownerDirective: SCORE_SEAL_DIRECTIVE,
    minScore: Math.max(policy.minScore, JUDGE_POSITIVE_FLOOR), judge: policy.judge,
    topPerDomain: policy.topPerDomain, sealedAt: now.toISOString(), handSigned: false as const };
  if (policy.groups < 2 || !bestDomain) {
    return { sealed: false, reason: policy.groups < 2 ? 'ACTIVATION_NEEDS_AT_LEAST_2_GROUPS'
      : `NEED_${need}_INDEPENDENT_PARENTS_HAVE_${Math.max(0, ...[...byDomain.values()].map(i => i.length))}`, groups: [],
    provenance: { ...provenanceBase, parents: [] } };
  }
  // Deal by rank so each group mixes strong parents and, where available, different seats.
  const chosen = bestDomain!.slice(0, need);
  const buckets: ScoreSealCandidate[][] = Array.from({ length: policy.groups }, () => []);
  chosen.forEach((item, index) => buckets[index % policy.groups]!.push(item));
  const groups = buckets.map(bucket => {
    const createKeys = bucket.map(item => item.createKey).sort();
    const idempotencyKey = `score-seal:${createHash('sha256').update(createKeys.join('\0')).digest('hex').slice(0, 24)}`;
    return Object.freeze({ idempotencyKey, createKeys, command: Object.freeze({
      schema: 'sinter.dream-product-command' as const, schemaVersion: 1 as const, idempotencyKey,
      evidence: createKeys.map(createKey => ({ createKey, source: 'judge-scoring' as const })) }) });
  });
  return { sealed: true, groups, provenance: { ...provenanceBase, parents: chosen.map(item => ({
    createKey: item.createKey, score: item.score, domain: item.domain, seat: item.seat,
    signal: item.likedAt ? OWNER_LIKE_RULE : SCORE_SEAL_RULE,
    ...(item.likedAt ? { likedAt: item.likedAt } : {}) })) } };
}

/** `artifactDigest` (when the wall recorded it) binds the like to one artifact: a take that merely shares the seat/id alias does not inherit it. */
export interface LikeRecord { readonly seat: string; readonly id: string; readonly at: string; readonly artifactDigest?: string }

/**
 * Merges many per-run product stores into one. Create keys repeat across seats for the same prompt,
 * so per key the best eligible score wins; the winner is a complete, unmodified record (receipt intact).
 * `sources` keeps where each winner came from so wall likes can be mapped back to Creates.
 */
export function mergeProductStores(runs: readonly { seat: string; id: string; store: Record<string, any> }[],
  liked: ReadonlySet<string> = new Set(), likeDigests: ReadonlyMap<string, string> = new Map()):
  { merged: Record<string, unknown>; sources: Map<string, { seat: string; id: string }> } {
  const merged: Record<string, any> = {}; const sources = new Map<string, { seat: string; id: string }>();
  const rank = (v: any): number => (v?.result?.evaluation?.admissionEligible ? 1 : 0) * 10 + Number(v?.result?.evaluation?.score ?? 0);
  const bonus = new Map<string, number>();
  for (const run of runs) for (const [key, value] of Object.entries(run.store)) {
    if ((value as any)?.kind !== 'create') continue;
    const r = rank(value) + (liked.has(`${run.seat}/${run.id}`) && (!likeDigests.get(`${run.seat}/${run.id}`) || likeDigests.get(`${run.seat}/${run.id}`) === (value as any)?.result?.receipt?.artifactDigest) ? 100 : 0);
    if (!merged[key] || r > (bonus.get(key) ?? 0)) { merged[key] = value; bonus.set(key, r); sources.set(key, { seat: run.seat, id: run.id }); }
  }
  return { merged, sources };
}

/** Marks the Creates that sit behind wall likes. A like names the winner run for its prompt only. */
export function applyLikes(candidates: readonly ScoreSealCandidate[], likes: readonly LikeRecord[]): ScoreSealCandidate[] {
  const byPiece = new Map(likes.map(l => [`${l.seat}/${l.id}`, l]));
  return candidates.map(item => {
    const like = byPiece.get(`${item.seat_dir}/${item.piece_id}`);
    if (!like || (like.artifactDigest && like.artifactDigest !== item.artifactDigest)) return item;
    return { ...item, likedAt: like.at };
  });
}

/** Reads candidates from a product-projections.json document; receipts are re-verified at dream run. */
export function candidatesFromProductStore(store: Record<string, unknown>,
  sources: ReadonlyMap<string, { seat: string; id: string }> = new Map()): ScoreSealCandidate[] {
  const out: ScoreSealCandidate[] = [];
  for (const [createKey, value] of Object.entries(store)) {
    const v = value as { kind?: string; result?: Record<string, any> };
    if (v?.kind !== 'create' || !v.result?.evaluation) continue;
    const { evaluation: e, roles, receipt } = v.result;
    out.push({ createKey, score: Number(e.score), domain: String(v.result.domain),
      seat: String(roles?.generator ?? ''), judge: String(e.evaluatorIdentity ?? ''),
      lineageId: String(v.result.lineageId), artifactDigest: String(receipt?.artifactDigest ?? ''),
      admissionEligible: e.admissionEligible === true, degraded: e.degraded === true,
      identityValid: e.identityValid === true,
      evaluationBinding: classifyEvaluationBinding(receipt ?? {}, e),
      authorityKeyDigest: String(receipt?.authorityKeyDigest ?? ''),
      ...(sources.has(createKey) ? { seat_dir: sources.get(createKey)!.seat, piece_id: sources.get(createKey)!.id } : {}),
      ...(e.failureClass ? { failureClass: String(e.failureClass) } : {}) });
  }
  return out;
}
