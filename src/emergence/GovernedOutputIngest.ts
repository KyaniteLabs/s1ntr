import type { EmergenceHooks } from './EmergenceHooks.js';

/** One finished governed generate run, as recorded in a batch corpus row. */
export interface GovernedOutputRow {
  readonly run_dir: string;
  readonly finished_utc?: string | null;
  readonly model?: string | null;
  readonly domain?: string | null;
  readonly score?: number | null;
  readonly admission_eligible?: boolean | null;
  readonly degraded?: boolean | null;
  readonly artifact_digest?: string | null;
  /** Absolute path to the governed artifact source. */
  readonly source_path?: string | null;
}

export const governedOutputKey = (row: GovernedOutputRow): string =>
  `${row.run_dir}|${row.finished_utc ?? ''}|${row.artifact_digest ?? ''}`;

export interface GovernedIngestResult { ingested: string[]; skipped: number; failed: number }

/**
 * Archives batch score observations for reporting. An imported scalar score
 * carries no signed label and does not authorize taste training.
 */
export async function ingestGovernedOutputs(hooks: EmergenceHooks,
  rows: readonly GovernedOutputRow[], seen: ReadonlySet<string>,
  readSource: (path: string) => string): Promise<GovernedIngestResult> {
  const result: GovernedIngestResult = { ingested: [], skipped: 0, failed: 0 };
  for (const row of rows) {
    const key = governedOutputKey(row);
    if (seen.has(key)) continue;
    if (!row.admission_eligible || row.degraded || typeof row.score !== 'number'
      || !Number.isFinite(row.score) || !row.source_path) { result.skipped += 1; continue; }
    try {
      const output = readSource(row.source_path);
      await hooks.onCreativeRun({ output, qualityScore: Math.min(1, Math.max(0, row.score)),
        provenance: 'fresh-generation', runId: row.artifact_digest ?? undefined,
        metadata: { domain: row.domain ?? undefined, model: row.model ?? undefined,
          source: 'governed-generate', judgeScored: true } });
      result.ingested.push(key);
    } catch { result.failed += 1; }
  }
  return result;
}
