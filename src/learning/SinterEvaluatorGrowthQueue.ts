/**
 * SinterEvaluatorGrowthQueue
 *
 * Turns baseline + cleaned dataset outputs into a concrete next-labeling queue.
 * It does not call models or mutate the archive; it prioritizes examples that
 * would most improve the evaluator dataset.
 */

import { promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { isCreativeLabelAdmitted, type CreativeLabelAdmission }
  from './CreativeLabelAdmission.js';

export interface GrowthQueueOptions {
  cleanedDatasetDir: string;
  baselineDir: string;
  outputDir: string;
  now?: string;
}

export interface GrowthQueueItem {
  priority: number;
  kind: 'baseline_error' | 'quarantined_hard_negative' | 'bucket_gap' | 'domain_gap';
  action: 'rescore' | 'human_label' | 'generate_more' | 'inspect_quarantine';
  reason: string;
  payload: Record<string, unknown>;
}

export interface GrowthQueueReport {
  schemaVersion: 1;
  createdAt: string;
  cleanedDatasetDir: string;
  baselineDir: string;
  outputDir: string;
  counts: {
    queueItems: number;
    baselineErrors: number;
    quarantineItems: number;
    bucketGaps: number;
    domainGaps: number;
  };
  topActions: Record<string, number>;
  nextTargets: string[];
}

const TARGET_MIN_BUCKET_PRIMARY = 75;
const TARGET_MIN_DOMAIN_PRIMARY = 20;

export async function buildEvaluatorGrowthQueue(options: GrowthQueueOptions): Promise<GrowthQueueReport> {
  const primaryRows = [
    ...await readRows(path.join(options.cleanedDatasetDir, 'primary-train.jsonl')),
    ...await readRows(path.join(options.cleanedDatasetDir, 'primary-val.jsonl')),
    ...await readRows(path.join(options.cleanedDatasetDir, 'primary-test.jsonl')),
  ];
  const quarantineRows = await readRows(path.join(options.cleanedDatasetDir, 'quarantine.jsonl'));
  const baselineErrors = await readRows(path.join(options.baselineDir, 'primary', 'errors.jsonl'));
  const queue: GrowthQueueItem[] = [];
  const confirmedPoorIds = new Set(primaryRows
    .filter((row) => {
      const record = asRecord(row);
      const target = asRecord(record.target);
      const metadata = asRecord(record.metadata);
      return stringValue(metadata.trustTier) === 'high' && stringValue(target.scoreBucket) === 'poor';
    })
    .map((row) => stringValue(asRecord(row).id))
    .filter((id): id is string => id !== undefined));

  for (const error of baselineErrors.slice(0, 100)) {
    const record = asRecord(error);
    const source = stringValue(record.source);
    const trustTier = stringValue(record.trustTier);
    const model = stringValue(record.model);
    if (model === 'majority') continue;
    if (source === 'rescore' || trustTier === 'high') continue;
    queue.push({
      priority: 90,
      kind: 'baseline_error',
      action: 'human_label',
      reason: `Baseline missed ${stringValue(record.domain) ?? 'unknown'} ${stringValue(record.actual) ?? 'unknown'} as ${stringValue(record.predicted) ?? 'unknown'}`,
      payload: pick(record, ['id', 'source', 'domain', 'actual', 'predicted', 'numericScore', 'model']),
    });
  }

  for (const row of quarantineRows.slice(0, 100)) {
    const record = asRecord(row);
    const id = stringValue(record.id);
    if (id && confirmedPoorIds.has(id)) continue;
    const metadata = asRecord(record.metadata);
    const reasons = Array.isArray(metadata.quarantineReasons) ? metadata.quarantineReasons.map(String) : [];
    const input = asRecord(record.input);
    const admission = asRecord(asRecord(record.label).creative_label) as unknown as
      CreativeLabelAdmission;
    const admitted = isCreativeLabelAdmitted(admission, 'hard-negative')
      && stringValue(input.artifact_sha256) === admission.artifactDigest;
    if (admitted && reasons.some((reason) => reason.includes('too_dark') || reason.includes('washout')
      || reason.includes('highlight-clipped') || reason.includes('bad_render'))) {
      queue.push({
        priority: 85,
        kind: 'quarantined_hard_negative',
        action: 'inspect_quarantine',
        reason: `Hard visual negative: ${reasons.join(', ')}`,
        payload: { id: record.id, source: record.source, domain: input.domain, reasons },
      });
    }
  }

  const byBucket = countBy(primaryRows, (row) => stringValue(asRecord(asRecord(row).target).scoreBucket) ?? 'unknown');
  for (const [bucket, count] of Object.entries(byBucket)) {
    if (count < TARGET_MIN_BUCKET_PRIMARY) {
      queue.push({
        priority: 70 - count / 10,
        kind: 'bucket_gap',
        action: 'generate_more',
        reason: `Primary ${bucket} bucket has ${count}; target ${TARGET_MIN_BUCKET_PRIMARY}`,
        payload: { bucket, current: count, target: TARGET_MIN_BUCKET_PRIMARY },
      });
    }
  }
  for (const bucket of ['poor', 'marginal', 'good', 'excellent']) {
    if (!(bucket in byBucket)) {
      queue.push({
        priority: 75,
        kind: 'bucket_gap',
        action: 'generate_more',
        reason: `Primary ${bucket} bucket has 0; target ${TARGET_MIN_BUCKET_PRIMARY}`,
        payload: { bucket, current: 0, target: TARGET_MIN_BUCKET_PRIMARY },
      });
    }
  }

  const byDomain = countBy(primaryRows, (row) => stringValue(asRecord(asRecord(row).input).domain) ?? 'unknown');
  for (const [domain, count] of Object.entries(byDomain)) {
    if (count < TARGET_MIN_DOMAIN_PRIMARY) {
      queue.push({
        priority: 60 - count / 10,
        kind: 'domain_gap',
        action: 'generate_more',
        reason: `Primary ${domain} domain has ${count}; target ${TARGET_MIN_DOMAIN_PRIMARY}`,
        payload: { domain, current: count, target: TARGET_MIN_DOMAIN_PRIMARY },
      });
    }
  }

  queue.sort((a, b) => b.priority - a.priority);
  await fs.mkdir(options.outputDir, { recursive: true });
  await writeJsonl(path.join(options.outputDir, 'growth-queue.jsonl'), queue);
  const report = makeReport(options, queue);
  await fs.writeFile(path.join(options.outputDir, 'growth-report.json'), `${JSON.stringify(report, null, 2)}\n`);
  await fs.writeFile(path.join(options.outputDir, 'growth-report.md'), renderReport(report, queue.slice(0, 25)));
  return report;
}

function makeReport(options: GrowthQueueOptions, queue: GrowthQueueItem[]): GrowthQueueReport {
  const topActions = countBy(queue, (item) => item.action);
  return {
    schemaVersion: 1,
    createdAt: options.now ?? new Date().toISOString(),
    cleanedDatasetDir: displayPath(options.cleanedDatasetDir),
    baselineDir: displayPath(options.baselineDir),
    outputDir: displayPath(options.outputDir),
    counts: {
      queueItems: queue.length,
      baselineErrors: queue.filter((item) => item.kind === 'baseline_error').length,
      quarantineItems: queue.filter((item) => item.kind === 'quarantined_hard_negative').length,
      bucketGaps: queue.filter((item) => item.kind === 'bucket_gap').length,
      domainGaps: queue.filter((item) => item.kind === 'domain_gap').length,
    },
    topActions,
    nextTargets: [
      'Convert baseline errors into explicit human/rescore labels.',
      'Promote quarantined hard negatives into a dedicated poor/fail eval set.',
      'Fill underrepresented primary buckets, especially poor and marginal.',
      'Balance primary labels per visual domain before LoRA.',
    ],
  };
}

function renderReport(report: GrowthQueueReport, top: GrowthQueueItem[]): string {
  return [
    '# SINTER evaluator data growth queue',
    '',
    `Created: ${report.createdAt}`,
    '',
    '## Counts',
    '',
    `- Queue items: ${report.counts.queueItems}`,
    `- Baseline errors: ${report.counts.baselineErrors}`,
    `- Quarantined hard negatives: ${report.counts.quarantineItems}`,
    `- Bucket gaps: ${report.counts.bucketGaps}`,
    `- Domain gaps: ${report.counts.domainGaps}`,
    '',
    '## Next targets',
    '',
    ...report.nextTargets.map((target) => `- ${target}`),
    '',
    '## Top queue items',
    '',
    ...top.map((item, index) => `${index + 1}. **${item.action} / ${item.kind}** (${item.priority.toFixed(1)}): ${item.reason}`),
    '',
  ].join('\n');
}

async function readRows(filePath: string): Promise<unknown[]> {
  try {
    const text = await fs.readFile(filePath, 'utf8');
    return text.split(/\r?\n/).filter((line) => line.trim()).map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

async function writeJsonl(filePath: string, rows: unknown[]): Promise<void> {
  const body = rows.map((row) => JSON.stringify(row)).join('\n');
  await fs.writeFile(filePath, body.length > 0 ? `${body}\n` : '');
}

function countBy<T>(rows: T[], keyFn: (row: T) => string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const row of rows) {
    const key = keyFn(row);
    out[key] = (out[key] ?? 0) + 1;
  }
  return out;
}

function pick(record: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  return Object.fromEntries(keys.map((key) => [key, record[key]]).filter(([, value]) => value !== undefined));
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
