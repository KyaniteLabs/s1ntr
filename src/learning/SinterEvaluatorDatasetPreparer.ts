/**
 * SinterEvaluatorDatasetPreparer
 *
 * Converts the role-aware evaluator bundle into a cleaner train-ready dataset:
 * deterministic splits, quarantine hygiene, source trust weights, primary vs
 * proxy separation, and duplicate/canonical-label handling.
 */

import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { isCreativeLabelAdmitted, type CreativeLabelAdmission }
  from './CreativeLabelAdmission.js';

export type DatasetSplit = 'train' | 'val' | 'test' | 'quarantine';
export type TrainingUse = 'primary' | 'proxy' | 'quarantine';
export type TrustTier = 'high' | 'medium' | 'proxy' | 'untrusted';

export interface EvaluatorDatasetPrepareOptions {
  roleExportDir?: string;
  inputJsonl?: string;
  outputDir: string;
  now?: string;
  seed?: string;
  splitRatios?: { train: number; val: number; test: number };
  includeQuarantinedInSplits?: boolean;
}

export interface PreparedEvaluatorRow {
  id: string;
  source: string;
  input: Record<string, unknown>;
  label: Record<string, unknown>;
  target: {
    scoreBucket: string;
    passFail: 'pass' | 'fail' | 'unknown';
    numericScore?: number;
  };
  metadata: {
    split: DatasetSplit;
    quarantineReasons: string[];
    labelProvenance: string;
    trustTier: TrustTier;
    labelWeight: number;
    trainingUse: TrainingUse;
    groupKey: string;
    duplicateOf?: string;
  };
}

export interface EvaluatorDatasetPrepSummary {
  schemaVersion: 1;
  createdAt: string;
  inputJsonl: string;
  outputDir: string;
  splitRatios: { train: number; val: number; test: number };
  counts: {
    total: number;
    included: number;
    primaryIncluded: number;
    proxyIncluded: number;
    quarantined: number;
    train: number;
    val: number;
    test: number;
    primaryTrain: number;
    primaryVal: number;
    primaryTest: number;
  };
  bySource: Record<string, number>;
  byBucket: Record<string, number>;
  byTrustTier: Record<string, number>;
  byTrainingUse: Record<string, number>;
  quarantineReasons: Record<string, number>;
  outputFiles: Record<string, string>;
}

const DEFAULT_SPLITS = { train: 0.8, val: 0.1, test: 0.1 };
const PASS_THRESHOLD = 0.7;
const SAFE_FAILURE_CLASSES = new Set(['none', 'render']);
const SAFE_RENDER_VERDICTS = new Set(['ok', 'pass', 'passed', 'visible', 'acceptable']);
const BAD_RENDER_VERDICTS = new Set([
  'too_dark', 'too-dark', 'dark', 'black', 'blank', 'flat', 'washout', 'washed_out',
  'washed-out', 'too_bright', 'too-bright', 'highlight-clipped', 'invisible', 'failed', 'fail',
]);

export async function prepareEvaluatorDataset(options: EvaluatorDatasetPrepareOptions): Promise<EvaluatorDatasetPrepSummary> {
  const splitRatios = normalizeSplits(options.splitRatios ?? DEFAULT_SPLITS);
  const seed = options.seed ?? 'sinter-evaluator-v0';
  const inputJsonl = options.inputJsonl ?? path.join(
    options.roleExportDir ?? '.omx/generated/sinter-training-bundles/latest',
    'bundles',
    'evaluator_system_quality_v0.jsonl',
  );

  const rawRows = await readJsonl(inputJsonl);
  const prepared = canonicalizeRows(rawRows.map((row) => toPreparedRow(row)));
  const included = options.includeQuarantinedInSplits
    ? prepared
    : prepared.filter((row) => row.metadata.quarantineReasons.length === 0);
  const quarantined = prepared.filter((row) => row.metadata.quarantineReasons.length > 0);

  assignSplits(included, seed, splitRatios);
  for (const row of quarantined) {
    row.metadata.split = 'quarantine';
    row.metadata.trainingUse = 'quarantine';
  }

  const primary = included.filter((row) => row.metadata.trainingUse === 'primary');
  const proxy = included.filter((row) => row.metadata.trainingUse === 'proxy');

  await fs.mkdir(options.outputDir, { recursive: true });
  await writeJsonl(path.join(options.outputDir, 'train.jsonl'), included.filter((row) => row.metadata.split === 'train'));
  await writeJsonl(path.join(options.outputDir, 'val.jsonl'), included.filter((row) => row.metadata.split === 'val'));
  await writeJsonl(path.join(options.outputDir, 'test.jsonl'), included.filter((row) => row.metadata.split === 'test'));
  await writeJsonl(path.join(options.outputDir, 'primary-train.jsonl'), primary.filter((row) => row.metadata.split === 'train'));
  await writeJsonl(path.join(options.outputDir, 'primary-val.jsonl'), primary.filter((row) => row.metadata.split === 'val'));
  await writeJsonl(path.join(options.outputDir, 'primary-test.jsonl'), primary.filter((row) => row.metadata.split === 'test'));
  await writeJsonl(path.join(options.outputDir, 'proxy-train.jsonl'), proxy.filter((row) => row.metadata.split === 'train'));
  await writeJsonl(path.join(options.outputDir, 'proxy-val.jsonl'), proxy.filter((row) => row.metadata.split === 'val'));
  await writeJsonl(path.join(options.outputDir, 'proxy-test.jsonl'), proxy.filter((row) => row.metadata.split === 'test'));
  await writeJsonl(path.join(options.outputDir, 'quarantine.jsonl'), quarantined);

  const summary = buildSummary({
    createdAt: options.now ?? new Date().toISOString(),
    inputJsonl,
    outputDir: options.outputDir,
    splitRatios,
    rows: prepared,
  });
  await fs.writeFile(path.join(options.outputDir, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
  await fs.writeFile(path.join(options.outputDir, 'dataset-card.md'), renderDatasetCard(summary));
  return summary;
}

function toPreparedRow(row: unknown): PreparedEvaluatorRow {
  const record = asRecord(row);
  const input = asRecord(record.input);
  const label = asRecord(record.label);
  const id = stringValue(record.artifact_id) ?? stringValue(record.event_id) ?? stableHash(row);
  const source = stringValue(record.source) ?? 'unknown';
  const numericScore = numberValue(label.score);
  const scoreBucket = stringValue(label.bucket) ?? scoreBucketFromScore(numericScore);
  const trust = trustFor(source, stringValue(label.kind));
  const quarantineReasons = quarantineReasonsFor({ source, input, label,
    numericScore, scoreBucket });
  const groupKey = artifactGroupKey({ id, source, input, label });

  return {
    id,
    source,
    input,
    label,
    target: {
      scoreBucket,
      passFail: numericScore === undefined ? 'unknown' : numericScore >= PASS_THRESHOLD ? 'pass' : 'fail',
      numericScore,
    },
    metadata: {
      split: 'train',
      quarantineReasons,
      labelProvenance: stringValue(label.provenance) ?? source,
      trustTier: trust.trustTier,
      labelWeight: trust.labelWeight,
      trainingUse: trust.trainingUse,
      groupKey,
    },
  };
}

function canonicalizeRows(rows: PreparedEvaluatorRow[]): PreparedEvaluatorRow[] {
  const byGroup = new Map<string, PreparedEvaluatorRow[]>();
  for (const row of rows) {
    const group = byGroup.get(row.metadata.groupKey) ?? [];
    group.push(row);
    byGroup.set(row.metadata.groupKey, group);
  }

  for (const group of byGroup.values()) {
    if (group.length <= 1) continue;
    group.sort((a, b) => rowPriority(b) - rowPriority(a) || a.source.localeCompare(b.source));
    const canonical = group[0];
    for (const duplicate of group.slice(1)) {
      duplicate.metadata.duplicateOf = canonical.id;
      duplicate.metadata.quarantineReasons.push('duplicate_superseded_by_higher_trust_label');
    }
  }
  return rows;
}

function rowPriority(row: PreparedEvaluatorRow): number {
  const trustScore: Record<TrustTier, number> = { high: 4, medium: 3, proxy: 2, untrusted: 1 };
  const quarantinePenalty = row.metadata.quarantineReasons.length > 0 ? -10 : 0;
  const labelKind = stringValue(row.label.kind);
  const hardNegativeBonus = labelKind === 'hard_negative_rescore' ? 2 : 0;
  return (trustScore[row.metadata.trustTier] ?? 0) + row.metadata.labelWeight + hardNegativeBonus + quarantinePenalty;
}

function trustFor(source: string, labelKind: string | undefined): { trustTier: TrustTier; labelWeight: number; trainingUse: TrainingUse } {
  if (source === 'rescore' || labelKind === 'rescore_quality_score') {
    return { trustTier: 'high', labelWeight: 1.0, trainingUse: 'primary' };
  }
  if (source === 'quality_archive' || labelKind === 'quality_score') {
    return { trustTier: 'medium', labelWeight: 0.7, trainingUse: 'primary' };
  }
  if (source === 'routing' || labelKind === 'routing_quality_score') {
    return { trustTier: 'proxy', labelWeight: 0.35, trainingUse: 'proxy' };
  }
  return { trustTier: 'untrusted', labelWeight: 0.2, trainingUse: 'proxy' };
}

function artifactGroupKey(params: {
  id: string;
  source: string;
  input: Record<string, unknown>;
  label: Record<string, unknown>;
}): string {
  if (params.source === 'routing') return `routing:${params.id}`;
  const artifactId = params.id || stringValue(params.input.artifact_id) || stringValue(params.label.artifact_id);
  return artifactId ? `artifact:${artifactId}` : stableHash(params);
}

function quarantineReasonsFor(params: {
  source: string;
  input: Record<string, unknown>;
  label: Record<string, unknown>;
  numericScore?: number;
  scoreBucket: string;
}): string[] {
  const reasons: string[] = [];
  const { source, input, label, numericScore, scoreBucket } = params;

  if (['quality_archive', 'rescore'].includes(source)) {
    const admission = asRecord(label.creative_label) as unknown as CreativeLabelAdmission;
    if (!isCreativeLabelAdmitted(admission, 'evaluator-training')) {
      reasons.push('creative_label_admission_missing_or_invalid');
    } else if (stringValue(input.artifact_sha256) !== admission.artifactDigest) {
      reasons.push('creative_label_artifact_digest_mismatch');
    }
  }

  if (numericScore === undefined) reasons.push('missing_numeric_score');
  if (numericScore !== undefined && (numericScore < 0 || numericScore > 1)) reasons.push('score_out_of_range');

  const positiveLabel = numericScore !== undefined ? numericScore >= PASS_THRESHOLD : scoreBucket === 'good' || scoreBucket === 'excellent';
  const failureClass = normalizeToken(stringValue(label.failure_class) ?? stringValue(input.failure_class));
  if (positiveLabel && failureClass && !SAFE_FAILURE_CLASSES.has(failureClass)) {
    reasons.push(`positive_label_with_degraded_failure_class:${failureClass}`);
  }

  const render = asRecord(input.render_measure);
  const verdict = normalizeToken(stringValue(render.verdict));
  if (positiveLabel && verdict) {
    if (BAD_RENDER_VERDICTS.has(verdict)) reasons.push(`positive_label_with_bad_render_verdict:${verdict}`);
    if (!SAFE_RENDER_VERDICTS.has(verdict) && !BAD_RENDER_VERDICTS.has(verdict)) {
      reasons.push(`positive_label_with_unknown_render_verdict:${verdict}`);
    }
  }

  const meanLuminance = numberValue(render.meanLuminance);
  const brightFraction = numberValue(render.brightFraction);
  const brightnessStd = numberValue(render.brightnessStd);
  if (positiveLabel && meanLuminance !== undefined && brightFraction !== undefined) {
    if (meanLuminance <= 0.08 && brightFraction <= 0.02) reasons.push('positive_label_too_dark_render_stats');
    if (meanLuminance >= 0.9 && brightFraction >= 0.95) reasons.push('positive_label_washout_render_stats');
  }
  if (positiveLabel && brightnessStd !== undefined && brightnessStd <= 1 && meanLuminance !== undefined) {
    if (meanLuminance <= 0.12 || meanLuminance >= 0.88) reasons.push('positive_label_flat_frame_render_stats');
  }

  return [...new Set(reasons)];
}

function assignSplits(rows: PreparedEvaluatorRow[], seed: string, ratios: { train: number; val: number; test: number }): void {
  const strata = new Map<string, Map<string, PreparedEvaluatorRow[]>>();
  for (const row of rows) {
    const stratumKey = `${row.metadata.trainingUse}:${row.source}:${row.target.scoreBucket}`;
    const units = strata.get(stratumKey) ?? new Map<string, PreparedEvaluatorRow[]>();
    const unit = units.get(row.metadata.groupKey) ?? [];
    unit.push(row);
    units.set(row.metadata.groupKey, unit);
    strata.set(stratumKey, units);
  }

  for (const units of strata.values()) {
    const grouped = [...units.entries()].sort((a, b) => stableHash(`${seed}:${a[0]}`).localeCompare(stableHash(`${seed}:${b[0]}`)));
    const n = grouped.length;
    let trainCount = Math.floor(n * ratios.train);
    let valCount = Math.floor(n * ratios.val);
    let testCount = n - trainCount - valCount;

    if (n >= 3) {
      if (valCount === 0 && ratios.val > 0) valCount = 1;
      if (testCount === 0 && ratios.test > 0) testCount = 1;
      trainCount = Math.max(1, n - valCount - testCount);
    } else {
      trainCount = n;
      valCount = 0;
      testCount = 0;
    }

    grouped.forEach(([, groupRows], index) => {
      const split: DatasetSplit = index < trainCount ? 'train' : index < trainCount + valCount ? 'val' : 'test';
      for (const row of groupRows) row.metadata.split = split;
    });
  }
}

function buildSummary(params: {
  createdAt: string;
  inputJsonl: string;
  outputDir: string;
  splitRatios: { train: number; val: number; test: number };
  rows: PreparedEvaluatorRow[];
}): EvaluatorDatasetPrepSummary {
  const counts = {
    total: params.rows.length, included: 0, primaryIncluded: 0, proxyIncluded: 0, quarantined: 0,
    train: 0, val: 0, test: 0, primaryTrain: 0, primaryVal: 0, primaryTest: 0,
  };
  const bySource: Record<string, number> = {};
  const byBucket: Record<string, number> = {};
  const byTrustTier: Record<string, number> = {};
  const byTrainingUse: Record<string, number> = {};
  const quarantineReasons: Record<string, number> = {};

  for (const row of params.rows) {
    bySource[row.source] = (bySource[row.source] ?? 0) + 1;
    byBucket[row.target.scoreBucket] = (byBucket[row.target.scoreBucket] ?? 0) + 1;
    byTrustTier[row.metadata.trustTier] = (byTrustTier[row.metadata.trustTier] ?? 0) + 1;
    byTrainingUse[row.metadata.trainingUse] = (byTrainingUse[row.metadata.trainingUse] ?? 0) + 1;
    if (row.metadata.quarantineReasons.length > 0) {
      counts.quarantined++;
      for (const reason of row.metadata.quarantineReasons) quarantineReasons[reason] = (quarantineReasons[reason] ?? 0) + 1;
    } else {
      counts.included++;
      if (row.metadata.trainingUse === 'primary') counts.primaryIncluded++;
      if (row.metadata.trainingUse === 'proxy') counts.proxyIncluded++;
      if (row.metadata.split === 'train') counts.train++;
      if (row.metadata.split === 'val') counts.val++;
      if (row.metadata.split === 'test') counts.test++;
      if (row.metadata.trainingUse === 'primary' && row.metadata.split === 'train') counts.primaryTrain++;
      if (row.metadata.trainingUse === 'primary' && row.metadata.split === 'val') counts.primaryVal++;
      if (row.metadata.trainingUse === 'primary' && row.metadata.split === 'test') counts.primaryTest++;
    }
  }

  return {
    schemaVersion: 1,
    createdAt: params.createdAt,
    inputJsonl: displayPath(params.inputJsonl),
    outputDir: displayPath(params.outputDir),
    splitRatios: params.splitRatios,
    counts,
    bySource,
    byBucket,
    byTrustTier,
    byTrainingUse,
    quarantineReasons,
    outputFiles: {
      train: 'train.jsonl',
      val: 'val.jsonl',
      test: 'test.jsonl',
      primaryTrain: 'primary-train.jsonl',
      primaryVal: 'primary-val.jsonl',
      primaryTest: 'primary-test.jsonl',
      proxyTrain: 'proxy-train.jsonl',
      proxyVal: 'proxy-val.jsonl',
      proxyTest: 'proxy-test.jsonl',
      quarantine: 'quarantine.jsonl',
      datasetCard: 'dataset-card.md',
      summary: 'summary.json',
    },
  };
}

function displayPath(filePath: string): string {
  const home = homedir();
  if (filePath.startsWith(`${home}${path.sep}`)) return `~${filePath.slice(home.length)}`;
  const cwd = process.cwd();
  if (filePath.startsWith(`${cwd}${path.sep}`)) return `repo:${filePath.slice(cwd.length + 1)}`;
  return path.isAbsolute(filePath) ? `external:${path.basename(filePath)}` : filePath;
}

function renderDatasetCard(summary: EvaluatorDatasetPrepSummary): string {
  return [
    '# SINTER evaluator dataset card',
    '',
    `Created: ${summary.createdAt}`,
    '',
    '## Purpose',
    '',
    'Train/evaluate a SINTER system-quality evaluator or ranker. This is not a Simon preference model.',
    '',
    '## Counts',
    '',
    `- Total rows: ${summary.counts.total}`,
    `- Included rows: ${summary.counts.included}`,
    `- Primary clean rows: ${summary.counts.primaryIncluded}`,
    `- Proxy rows: ${summary.counts.proxyIncluded}`,
    `- Quarantined rows: ${summary.counts.quarantined}`,
    `- Full train/val/test: ${summary.counts.train}/${summary.counts.val}/${summary.counts.test}`,
    `- Primary train/val/test: ${summary.counts.primaryTrain}/${summary.counts.primaryVal}/${summary.counts.primaryTest}`,
    '',
    '## Source mix',
    '',
    renderBullets(summary.bySource),
    '',
    '## Label buckets',
    '',
    renderBullets(summary.byBucket),
    '',
    '## Trust tiers',
    '',
    renderBullets(summary.byTrustTier),
    '',
    '## Training use',
    '',
    renderBullets(summary.byTrainingUse),
    '',
    '## Quarantine reasons',
    '',
    renderBullets(summary.quarantineReasons),
    '',
    '## Cleaning policy',
    '',
    '- Rescore labels are high-trust primary rows with weight 1.0.',
    '- Quality archive labels are medium-trust primary rows with weight 0.7.',
    '- Routing labels are proxy rows with weight 0.35; use them for baselines, not as the sole LoRA target.',
    '- Duplicate artifact labels are canonicalized to the highest-trust label and lower-trust duplicates are quarantined.',
    '- Splits are group-safe by artifact/event key so duplicate labels cannot leak across train/val/test.',
    '',
    '## Leakage policy',
    '',
    '- Raw reasoning and thinking traces are not used as targets.',
    '- Artifact text is present only if the upstream role export opted into artifact text.',
    '- Known-bad/degraded visual labels are quarantined rather than treated as positives.',
    '- Human preference labels remain separate from automated SINTER quality labels.',
    '',
    '## Files',
    '',
    `- Full train: ${summary.outputFiles.train}`,
    `- Full validation: ${summary.outputFiles.val}`,
    `- Full test: ${summary.outputFiles.test}`,
    `- Primary train: ${summary.outputFiles.primaryTrain}`,
    `- Primary validation: ${summary.outputFiles.primaryVal}`,
    `- Primary test: ${summary.outputFiles.primaryTest}`,
    `- Proxy train: ${summary.outputFiles.proxyTrain}`,
    `- Proxy validation: ${summary.outputFiles.proxyVal}`,
    `- Proxy test: ${summary.outputFiles.proxyTest}`,
    `- Quarantine: ${summary.outputFiles.quarantine}`,
    `- Summary: ${summary.outputFiles.summary}`,
    '',
  ].join('\n');
}

function renderBullets(counts: Record<string, number>): string {
  const entries = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  if (entries.length === 0) return '- none';
  return entries.map(([key, value]) => `- ${key}: ${value}`).join('\n');
}

function normalizeSplits(ratios: { train: number; val: number; test: number }): { train: number; val: number; test: number } {
  const total = ratios.train + ratios.val + ratios.test;
  if (!Number.isFinite(total) || total <= 0) return DEFAULT_SPLITS;
  return { train: ratios.train / total, val: ratios.val / total, test: ratios.test / total };
}

async function readJsonl(filePath: string): Promise<unknown[]> {
  const text = await fs.readFile(filePath, 'utf8');
  const rows: unknown[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    rows.push(JSON.parse(line));
  }
  return rows;
}

async function writeJsonl(filePath: string, rows: unknown[]): Promise<void> {
  const body = rows.map((row) => JSON.stringify(row)).join('\n');
  await fs.writeFile(filePath, body.length > 0 ? `${body}\n` : '');
}

function scoreBucketFromScore(score: number | undefined): string {
  if (score === undefined) return 'unscored';
  if (score >= 0.85) return 'excellent';
  if (score >= 0.7) return 'good';
  if (score >= 0.5) return 'marginal';
  return 'poor';
}

function normalizeToken(value: string | undefined): string | undefined {
  return value?.trim().toLowerCase().replace(/\s+/g, '_');
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

function stableHash(value: unknown): string {
  return createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
}
