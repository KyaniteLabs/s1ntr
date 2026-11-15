/**
 * SinterEvaluatorBaseline
 *
 * No-dependency baselines for the prepared SINTER evaluator dataset. This tells
 * us whether simple source/domain/render/score features already explain the
 * labels before attempting LoRA.
 */

import { promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

export type BaselineLabel = 'poor' | 'marginal' | 'good' | 'excellent' | 'unscored';
export type BaselineModel = 'majority' | 'domainSourceLookup' | 'renderStatsHeuristic';

export interface EvaluatorBaselineOptions {
  datasetDir: string;
  outputDir: string;
  mode?: 'primary' | 'full' | 'proxy';
  now?: string;
}

export interface BaselineRow {
  id: string;
  source: string;
  input: Record<string, unknown>;
  target: { scoreBucket: BaselineLabel; passFail: string; numericScore?: number };
  metadata: { labelWeight?: number; trustTier?: string; trainingUse?: string; split?: string };
}

export interface ModelMetrics {
  model: BaselineModel;
  accuracy: number;
  weightedAccuracy: number;
  macroF1: number;
  total: number;
  correct: number;
  confusion: Record<string, Record<string, number>>;
}

export interface EvaluatorBaselineReport {
  schemaVersion: 1;
  createdAt: string;
  datasetDir: string;
  outputDir: string;
  mode: 'primary' | 'full' | 'proxy';
  trainRows: number;
  valRows: number;
  testRows: number;
  labelDistribution: Record<string, number>;
  metrics: ModelMetrics[];
  recommendation: {
    verdict: 'collect_more_data' | 'baseline_sufficient' | 'try_lora_after_more_eval';
    rationale: string;
    nextDataTargets: string[];
  };
}

const LABELS: BaselineLabel[] = ['poor', 'marginal', 'good', 'excellent', 'unscored'];

type Predictor = (row: BaselineRow) => BaselineLabel;

export async function runEvaluatorBaseline(options: EvaluatorBaselineOptions): Promise<EvaluatorBaselineReport> {
  const mode = options.mode ?? 'primary';
  const train = await readSplit(options.datasetDir, mode, 'train');
  const val = await readSplit(options.datasetDir, mode, 'val');
  const test = await readSplit(options.datasetDir, mode, 'test');
  const evalRows = test.length > 0 ? test : val;
  const trainForModels = [...train, ...val];

  const predictors = buildPredictors(trainForModels);
  const metrics = (Object.entries(predictors) as Array<[BaselineModel, Predictor]>).map(([model, predictor]) =>
    evaluate(model, predictor, evalRows),
  );
  const report: EvaluatorBaselineReport = {
    schemaVersion: 1,
    createdAt: options.now ?? new Date().toISOString(),
    datasetDir: displayPath(options.datasetDir),
    outputDir: displayPath(options.outputDir),
    mode,
    trainRows: train.length,
    valRows: val.length,
    testRows: test.length,
    labelDistribution: distribution([...train, ...val, ...test]),
    metrics,
    recommendation: recommend({ mode, train, val, test, metrics }),
  };

  await fs.mkdir(options.outputDir, { recursive: true });
  await fs.writeFile(path.join(options.outputDir, 'metrics.json'), `${JSON.stringify(report, null, 2)}\n`);
  await fs.writeFile(path.join(options.outputDir, 'confusion-matrix.json'), `${JSON.stringify(Object.fromEntries(metrics.map((m) => [m.model, m.confusion])), null, 2)}\n`);
  await writeJsonl(path.join(options.outputDir, 'errors.jsonl'), collectErrors(predictors, evalRows));
  await fs.writeFile(path.join(options.outputDir, 'baseline-report.md'), renderReport(report));
  return report;
}

async function readSplit(datasetDir: string, mode: 'primary' | 'full' | 'proxy', split: 'train' | 'val' | 'test'): Promise<BaselineRow[]> {
  const file = mode === 'full' ? `${split}.jsonl` : `${mode}-${split}.jsonl`;
  return (await readJsonl(path.join(datasetDir, file))).map(normalizeRow);
}

function buildPredictors(trainRows: BaselineRow[]): Record<BaselineModel, Predictor> {
  const majority = majorityLabel(trainRows);
  const domainSource = buildLookup(trainRows, (row) => `${stringValue(row.input.domain) ?? 'unknown'}|${row.source}`);
  const sourceOnly = buildLookup(trainRows, (row) => row.source);
  const lookupPredictor: Predictor = (row) => domainSource.get(`${stringValue(row.input.domain) ?? 'unknown'}|${row.source}`) ?? sourceOnly.get(row.source) ?? majority;
  return {
    majority: () => majority,
    domainSourceLookup: lookupPredictor,
    renderStatsHeuristic: (row) => predictFromRenderStats(row) ?? lookupPredictor(row),
  };
}

function predictFromRenderStats(row: BaselineRow): BaselineLabel | undefined {
  const render = asRecord(row.input.render_measure);
  const meanLuminance = numberValue(render.meanLuminance);
  const brightFraction = numberValue(render.brightFraction);
  const brightnessStd = numberValue(render.brightnessStd);
  const verdict = stringValue(render.verdict)?.trim().toLowerCase().replace(/\s+/g, '_');
  if (verdict && ['too_dark', 'too-dark', 'black', 'blank', 'washout', 'washed_out', 'washed-out', 'too_bright', 'highlight-clipped', 'failed', 'fail'].includes(verdict)) return 'poor';
  if (meanLuminance !== undefined && brightFraction !== undefined) {
    if (meanLuminance <= 0.08 && brightFraction <= 0.02) return 'poor';
    if (meanLuminance >= 0.9 && brightFraction >= 0.95) return 'poor';
  }
  if (brightnessStd !== undefined && brightnessStd <= 1 && meanLuminance !== undefined && (meanLuminance <= 0.12 || meanLuminance >= 0.88)) return 'poor';
  return undefined;
}

function buildLookup(rows: BaselineRow[], keyFn: (row: BaselineRow) => string): Map<string, BaselineLabel> {
  const counts = new Map<string, Map<BaselineLabel, number>>();
  for (const row of rows) {
    const key = keyFn(row);
    const bucket = counts.get(key) ?? new Map<BaselineLabel, number>();
    bucket.set(row.target.scoreBucket, (bucket.get(row.target.scoreBucket) ?? 0) + weight(row));
    counts.set(key, bucket);
  }
  const out = new Map<string, BaselineLabel>();
  for (const [key, bucket] of counts.entries()) out.set(key, maxLabel(bucket));
  return out;
}

function evaluate(model: BaselineModel, predictor: Predictor, rows: BaselineRow[]): ModelMetrics {
  let correct = 0;
  let weightedCorrect = 0;
  let totalWeight = 0;
  const confusion: Record<string, Record<string, number>> = {};
  for (const row of rows) {
    const actual = row.target.scoreBucket;
    const predicted = predictor(row);
    if (actual === predicted) correct++;
    const rowWeight = weight(row);
    if (actual === predicted) weightedCorrect += rowWeight;
    totalWeight += rowWeight;
    confusion[actual] = confusion[actual] ?? {};
    confusion[actual][predicted] = (confusion[actual][predicted] ?? 0) + 1;
  }
  return {
    model,
    accuracy: rows.length > 0 ? correct / rows.length : 0,
    weightedAccuracy: totalWeight > 0 ? weightedCorrect / totalWeight : 0,
    macroF1: macroF1(confusion),
    total: rows.length,
    correct,
    confusion,
  };
}

function macroF1(confusion: Record<string, Record<string, number>>): number {
  const f1s: number[] = [];
  for (const label of LABELS) {
    const tp = confusion[label]?.[label] ?? 0;
    const fp = LABELS.reduce((sum, actual) => actual === label ? sum : sum + (confusion[actual]?.[label] ?? 0), 0);
    const fn = Object.entries(confusion[label] ?? {}).reduce((sum, [pred, count]) => pred === label ? sum : sum + count, 0);
    if (tp + fp + fn === 0) continue;
    const precision = tp + fp > 0 ? tp / (tp + fp) : 0;
    const recall = tp + fn > 0 ? tp / (tp + fn) : 0;
    f1s.push(precision + recall > 0 ? 2 * precision * recall / (precision + recall) : 0);
  }
  return f1s.length > 0 ? f1s.reduce((a, b) => a + b, 0) / f1s.length : 0;
}

function collectErrors(predictors: Record<BaselineModel, Predictor>, rows: BaselineRow[]): unknown[] {
  const errors: unknown[] = [];
  for (const row of rows) {
    for (const [model, predictor] of Object.entries(predictors) as Array<[BaselineModel, Predictor]>) {
      const predicted = predictor(row);
      if (predicted !== row.target.scoreBucket) {
        errors.push({ model, id: row.id, source: row.source, domain: row.input.domain, actual: row.target.scoreBucket, predicted, numericScore: row.target.numericScore, trustTier: row.metadata.trustTier, trainingUse: row.metadata.trainingUse });
      }
    }
  }
  return errors;
}

function recommend(params: { mode: string; train: BaselineRow[]; val: BaselineRow[]; test: BaselineRow[]; metrics: ModelMetrics[] }): EvaluatorBaselineReport['recommendation'] {
  const best = [...params.metrics].sort((a, b) => b.macroF1 - a.macroF1)[0];
  const totalEval = params.test.length || params.val.length;
  if (params.mode === 'primary' && (params.train.length < 500 || totalEval < 100)) {
    return {
      verdict: 'collect_more_data',
      rationale: `Primary split is too small for LoRA confidence (${params.train.length} train, ${totalEval} eval). Best baseline ${best?.model ?? 'none'} macro-F1=${format(best?.macroF1 ?? 0)}.`,
      nextDataTargets: ['more rescore rows', 'more hard negative visual failures', 'balanced marginal/poor primary labels', 'explicit pairwise/human labels'],
    };
  }
  if (best && best.macroF1 >= 0.75) {
    return {
      verdict: 'baseline_sufficient',
      rationale: `Simple baseline ${best.model} is already strong (macro-F1=${format(best.macroF1)}); improve labels/features before LoRA.`,
      nextDataTargets: ['inspect baseline errors', 'add labels for failure clusters only'],
    };
  }
  return {
    verdict: 'try_lora_after_more_eval',
    rationale: `Baseline is not strong enough (best macro-F1=${format(best?.macroF1 ?? 0)}), but add eval rows before LoRA so gains are measurable.`,
    nextDataTargets: ['larger held-out primary test set', 'domain-balanced rescore set', 'explicit label rubric'],
  };
}

function majorityLabel(rows: BaselineRow[]): BaselineLabel {
  const counts = new Map<BaselineLabel, number>();
  for (const row of rows) counts.set(row.target.scoreBucket, (counts.get(row.target.scoreBucket) ?? 0) + weight(row));
  return maxLabel(counts);
}

function maxLabel(counts: Map<BaselineLabel, number>): BaselineLabel {
  let best: BaselineLabel = 'unscored';
  let bestCount = -1;
  for (const label of LABELS) {
    const count = counts.get(label) ?? 0;
    if (count > bestCount) {
      best = label;
      bestCount = count;
    }
  }
  return best;
}

function distribution(rows: BaselineRow[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const row of rows) out[row.target.scoreBucket] = (out[row.target.scoreBucket] ?? 0) + 1;
  return out;
}

function normalizeRow(row: unknown): BaselineRow {
  const record = asRecord(row);
  return {
    id: stringValue(record.id) ?? 'unknown',
    source: stringValue(record.source) ?? 'unknown',
    input: asRecord(record.input),
    target: asRecord(record.target) as BaselineRow['target'],
    metadata: asRecord(record.metadata) as BaselineRow['metadata'],
  };
}

function renderReport(report: EvaluatorBaselineReport): string {
  return [
    '# SINTER evaluator baseline report',
    '',
    `Created: ${report.createdAt}`,
    `Mode: ${report.mode}`,
    '',
    '## Rows',
    '',
    `- Train: ${report.trainRows}`,
    `- Validation: ${report.valRows}`,
    `- Test: ${report.testRows}`,
    '',
    '## Metrics',
    '',
    '| Model | Accuracy | Weighted accuracy | Macro-F1 | Correct/Total |',
    '|---|---:|---:|---:|---:|',
    ...report.metrics.map((m) => `| ${m.model} | ${format(m.accuracy)} | ${format(m.weightedAccuracy)} | ${format(m.macroF1)} | ${m.correct}/${m.total} |`),
    '',
    '## Recommendation',
    '',
    `**${report.recommendation.verdict}** — ${report.recommendation.rationale}`,
    '',
    'Next data targets:',
    ...report.recommendation.nextDataTargets.map((target) => `- ${target}`),
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

function weight(row: BaselineRow): number {
  const value = row.metadata.labelWeight;
  return typeof value === 'number' && Number.isFinite(value) ? value : 1;
}

function format(value: number): string {
  return value.toFixed(3);
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
