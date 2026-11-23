/** Read local wall taste measurements for the advisory line in the readiness report. */
import { existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { SinterFS } from '../fs/SinterFS.js';
import type { ArchiveEntry } from '../emergence/types.js';

export interface TasteEvidence { readonly auc: number; readonly votes: number; readonly file: string }

export function readTasteEvidence(cwd: string, env: NodeJS.ProcessEnv = process.env): TasteEvidence | null {
  const artHome = env.S1NTR_ART_HOME ?? path.join(os.homedir(), 's1ntr-art');
  const candidates = [path.join(cwd, 'beauty-eval.json'), path.join(cwd, '.sinter', 'learning', 'beauty-eval.json'),
    path.join(artHome, 'learning', 'beauty-eval.json')];
  for (const file of candidates) {
    if (!existsSync(file)) continue;
    try {
      const ev = JSON.parse(readFileSync(file, 'utf8')) as { grouped_cv_auc_by_prompt_family?: unknown; rated_pieces_with_frames?: unknown; cv_n?: unknown };
      const auc = ev.grouped_cv_auc_by_prompt_family;
      if (typeof auc === 'number' && Number.isFinite(auc) && auc >= 0 && auc <= 1) {
        const votes = ev.rated_pieces_with_frames ?? ev.cv_n;
        if (typeof votes === 'number' && Number.isSafeInteger(votes) && votes > 0) return { auc, votes, file };
      }
    } catch { /* unreadable eval: try the next location */ }
  }
  return null;
}

/** Archive alignment requires a persisted model with held-out pair evidence. */
export async function tasteAlignedIdsFromModel(
  sinterFs: SinterFS,
  entries: ReadonlyArray<Pick<ArchiveEntry, 'id' | 'descriptor' | 'qualityScore'>>,
): Promise<Set<string> | undefined> {
  const { TasteLearningService } = await import('../learning/TasteLearningService.js');
  const weights = new TasteLearningService(sinterFs).loadLatestModel();
  if (!weights || !Number.isSafeInteger(weights.heldOutPairCount) || (weights.heldOutPairCount ?? 0) < 1
    || !unitRate(weights.heldOutAgreement) || weights.heldOutAgreement <= 0.5
    || !unitRate(weights.heldOutTieRate) || weights.heldOutAgreement + weights.heldOutTieRate > 1
    || !unitRate(weights.qualityWeight) || !weights.axisWeights.length
    || !weights.axisWeights.every(Number.isFinite)) return undefined;
  const { TasteModelRuntime } = await import('../learning/TasteModelRuntime.js');
  const runtime = new TasteModelRuntime();
  runtime.load(weights);
  return new Set(entries.filter(entry => runtime.score(entry) >= 0.5).map(entry => entry.id));
}

function unitRate(value: number | undefined): value is number {
  return value !== undefined && Number.isFinite(value) && value >= 0 && value <= 1;
}
