/**
 * SinterEvaluatorGrowthMaterializer
 *
 * Materializes a growth queue into durable label artifacts. Objective hard
 * negatives can be promoted automatically. Baseline misses with an existing
 * numeric quality-archive label become high-trust challenge confirmations;
 * ambiguous misses become a review queue rather than invented labels.
 */

import { promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

export interface GrowthMaterializeOptions {
  growthQueueJsonl: string;
  outputDir: string;
  rescoreOutput: string;
  reviewOutput: string;
  now?: string;
}

export interface GrowthMaterializeReport {
  schemaVersion: 1;
  createdAt: string;
  growthQueueJsonl: string;
  outputDir: string;
  rescoreOutput: string;
  reviewOutput: string;
  counts: {
    queueItems: number;
    hardNegativeLabels: number;
    baselineConfirmationLabels: number;
    reviewItems: number;
    skippedItems: number;
  };
}

export async function materializeEvaluatorGrowth(options: GrowthMaterializeOptions): Promise<GrowthMaterializeReport> {
  const rows = await readJsonl(options.growthQueueJsonl);
  const hardNegativeLabels = new Map<string, Record<string, unknown>>();
  const baselineConfirmationLabels = new Map<string, Record<string, unknown>>();
  const reviewItems = new Map<string, Record<string, unknown>>();
  let skippedItems = 0;

  for (const row of rows) {
    const record = asRecord(row);
    const payload = asRecord(record.payload);
    const kind = stringValue(record.kind);
    const id = stringValue(payload.id);
    const domain = stringValue(payload.domain);
    if (!id) {
      skippedItems++;
      continue;
    }

    if (kind === 'quarantined_hard_negative' && domain) {
      const key = `${id}:${domain}`;
      hardNegativeLabels.set(key, {
        id,
        domain,
        stored: numberValue(payload.numericScore) ?? null,
        fresh: 0,
        delta: null,
        labelKind: 'hard_negative_rescore',
        provenance: 'objective_quarantine_promotion',
        reason: stringValue(record.reason) ?? 'quarantined hard negative promoted to explicit fail label',
      });
      continue;
    }

    if (kind === 'baseline_error') {
      const source = stringValue(payload.source);
      const actual = stringValue(payload.actual);
      const numericScore = numberValue(payload.numericScore);
      if (domain && source === 'quality_archive' && actual && numericScore !== undefined) {
        const key = `${id}:${domain}`;
        baselineConfirmationLabels.set(key, {
          id,
          domain,
          stored: null,
          fresh: numericScore,
          delta: null,
          labelKind: 'baseline_challenge_confirmation',
          provenance: 'quality_archive_baseline_error_promotion',
          reason: `Promoted baseline miss to high-trust challenge label: ${actual} was predicted as ${stringValue(payload.predicted) ?? 'unknown'}`,
        });
        continue;
      }

      reviewItems.set(id, {
        id,
        domain,
        source,
        currentLabel: actual,
        predictedAs: stringValue(payload.predicted),
        numericScore,
        model: stringValue(payload.model),
        requestedAction: 'human_or_rescore_label',
        reason: stringValue(record.reason),
      });
      continue;
    }

    if (kind === 'owner_downvote' || kind === 'judge_hard_negative') {
      // Advisory rescore tasks keyed by the exact artifact id (owner downvotes carry the voted uid). Never promoted to a signed negative label.
      reviewItems.set(`${kind}:${id}`, {
        id,
        kind,
        domain,
        seat: stringValue(payload.seat),
        currentLabel: kind === 'owner_downvote' ? 'owner_down' : 'judge_below_floor',
        numericScore: numberValue(payload.judgeScore),
        requestedAction: 'rescore',
        reason: stringValue(record.reason),
      });
      continue;
    }

    skippedItems++;
  }

  await fs.mkdir(options.outputDir, { recursive: true });
  await fs.mkdir(path.dirname(options.rescoreOutput), { recursive: true });
  await fs.mkdir(path.dirname(options.reviewOutput), { recursive: true });
  const hardRows = [...hardNegativeLabels.values()].map((row) => {
    const stored = numberValue(row.stored);
    return { ...row, delta: stored === undefined ? null : -stored };
  });
  const confirmationRows = [...baselineConfirmationLabels.values()];
  const reviewRows = [...reviewItems.values()];
  await writeJsonl(options.rescoreOutput, [...hardRows, ...confirmationRows]);
  await writeJsonl(options.reviewOutput, reviewRows);

  const report: GrowthMaterializeReport = {
    schemaVersion: 1,
    createdAt: options.now ?? new Date().toISOString(),
    growthQueueJsonl: displayPath(options.growthQueueJsonl),
    outputDir: displayPath(options.outputDir),
    rescoreOutput: displayPath(options.rescoreOutput),
    reviewOutput: displayPath(options.reviewOutput),
    counts: {
      queueItems: rows.length,
      hardNegativeLabels: hardRows.length,
      baselineConfirmationLabels: confirmationRows.length,
      reviewItems: reviewRows.length,
      skippedItems,
    },
  };
  await fs.writeFile(path.join(options.outputDir, 'materialize-report.json'), `${JSON.stringify(report, null, 2)}\n`);
  await fs.writeFile(path.join(options.outputDir, 'materialize-report.md'), renderReport(report));
  return report;
}

function renderReport(report: GrowthMaterializeReport): string {
  return [
    '# SINTER evaluator growth materialization',
    '',
    `Created: ${report.createdAt}`,
    '',
    '## Outputs',
    '',
    `- Hard-negative rescore labels: ${report.rescoreOutput}`,
    `- Human/rescore review queue: ${report.reviewOutput}`,
    '',
    '## Counts',
    '',
    `- Queue items: ${report.counts.queueItems}`,
    `- Hard-negative labels: ${report.counts.hardNegativeLabels}`,
    `- Baseline confirmation labels: ${report.counts.baselineConfirmationLabels}`,
    `- Review items: ${report.counts.reviewItems}`,
    `- Skipped items: ${report.counts.skippedItems}`,
    '',
  ].join('\n');
}

async function readJsonl(filePath: string): Promise<unknown[]> {
  const text = await fs.readFile(filePath, 'utf8');
  return text.split(/\r?\n/).filter((line) => line.trim()).map((line) => JSON.parse(line));
}

async function writeJsonl(filePath: string, rows: unknown[]): Promise<void> {
  const body = rows.map((row) => JSON.stringify(row)).join('\n');
  await fs.writeFile(filePath, body.length > 0 ? `${body}\n` : '');
}

function displayPath(filePath: string): string {
  const home = homedir();
  if (filePath.startsWith(`${home}${path.sep}`)) return `~${filePath.slice(home.length)}`;
  const cwd = process.cwd();
  if (filePath.startsWith(`${cwd}${path.sep}`)) return `repo:${filePath.slice(cwd.length + 1)}`;
  return path.isAbsolute(filePath) ? `external:${path.basename(filePath)}` : filePath;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}
