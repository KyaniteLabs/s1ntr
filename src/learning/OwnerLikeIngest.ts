import { readFileSync, realpathSync } from 'node:fs';
import { join, relative, isAbsolute, sep } from 'node:path';
import type { EmergenceHooks } from '../emergence/EmergenceHooks.js';
import { createProductionLiminalRuntime } from '../runtime-core/ProductionLiminalRuntime.js';
import type { TasteLearningService } from './TasteLearningService.js';
import { validateCreativeLabelAdmission } from './CreativeLabelAdmission.js';
import { ownerLikeKey, type OwnerLike } from './OwnerLikeAdmission.js';

export interface OwnerLikeIngestResult { ingested: string[]; unbound: number }

const pieceSegment = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;
const sha256 = /^[a-f0-9]{64}$/;

/** Last record per piece wins; an un-like removes it. */
export function readOwnerLikes(file: string): OwnerLike[] {
  const state = new Map<string, OwnerLike>();
  for (const line of readFileSync(file, 'utf8').split('\n').filter(Boolean)) {
    let row: Partial<OwnerLike> & { liked?: boolean };
    try { row = JSON.parse(line); } catch { continue; }
    if (!row || typeof row !== 'object' || typeof row.seat !== 'string' || typeof row.id !== 'string') continue;
    const key = row.uid ?? `${row.seat}/${row.id}`;
    if (row.liked === false) state.delete(key);
    else state.set(key, { ...row, seat: row.seat, id: row.id, at: String(row.at ?? '') });
  }
  return [...state.values()];
}

function findRun(scanDirs: readonly string[], like: OwnerLike): string | undefined {
  if (!pieceSegment.test(like.seat) || !pieceSegment.test(like.id)) return undefined;
  for (const scan of scanDirs) {
    try {
      const root = realpathSync(scan);
      const dir = realpathSync(join(root, like.seat, like.id));
      const rel = relative(root, dir);
      if (rel && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)) return dir;
    } catch { /* try the next configured root */ }
  }
  return undefined;
}

/** Import a preference already authorized by the normal signed owner-review flow. */
export async function ingestOwnerLikes(input: { hooks: EmergenceHooks; service: TasteLearningService; likesFile: string;
  scanDirs: readonly string[]; seen: ReadonlySet<string> }): Promise<OwnerLikeIngestResult> {
  const out: OwnerLikeIngestResult = { ingested: [], unbound: 0 };
  for (const like of readOwnerLikes(input.likesFile)) {
    if (typeof like.createKey !== 'string' || !like.createKey
      || typeof like.ownerReviewKey !== 'string' || !like.ownerReviewKey
      || typeof like.artifactDigest !== 'string' || !sha256.test(like.artifactDigest)) {
      out.unbound++;
      continue;
    }
    const root = findRun(input.scanDirs, like);
    if (!root) { out.unbound++; continue; }
    // The batch keeps operation/review projections in shared state, and renders into each run.
    const sharedRoot = process.env.SINTER_LIMINAL_RUNTIME_ROOT;
    const runtime = await createProductionLiminalRuntime({
      root: sharedRoot && isAbsolute(sharedRoot) ? sharedRoot : root,
      artifactRoot: root,
    });
    try {
      const bound = await runtime.port.verifiedOwnerEvidence(like.createKey, like.ownerReviewKey);
      if (bound.artifactDigest !== like.artifactDigest) { out.unbound++; continue; }
      const key = ownerLikeKey(like, bound.artifactDigest, bound.reviewDecisionDigest);
      if (input.seen.has(key) || out.ingested.includes(key)) continue;
      const review = await runtime.port.projection(like.ownerReviewKey);
      if (review?.kind !== 'owner-review') { out.unbound++; continue; }
      const label = review.admissions.creativeLabel;
      validateCreativeLabelAdmission(label, 'evaluator-training');
      if (label.trustKind !== 'owner-preference' || label.decisionDigest !== bound.reviewDecisionDigest
        || label.artifactDigest !== bound.artifactDigest || label.evidenceDigest !== bound.evidenceDigest) {
        out.unbound++;
        continue;
      }
      const artifact = await runtime.port.verifiedArtifact(like.createKey, bound.artifactDigest);
      const run = await input.hooks.onCreativeRun({ output: artifact.source, qualityScore: bound.quality,
        provenance: 'fresh-generation', runId: bound.artifactDigest, creativeLabel: label,
        verifiedArtifactDigest: bound.artifactDigest,
        metadata: { domain: bound.domain, source: 'owner-like', judgeScored: true } });
      if (!run.placement.accepted) { out.unbound++; continue; }
      await input.service.recordPreference({ action: 'favorite', artifactId: `sinter://artifact/${run.lineage.artifactId}` });
      out.ingested.push(key);
    } catch (error) {
      const code = error instanceof Error ? error.message : '';
      if (!/^LIMINAL_(VERIFIED_|ARTIFACT_|RENDERED_|EVIDENCE_)/.test(code)
        && !code.startsWith('CREATIVE_LABEL_')) throw error;
      out.unbound++;
    } finally {
      await runtime.close();
    }
  }
  return out;
}
