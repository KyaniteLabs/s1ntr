import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { runEvaluatorBaseline } from '../../../src/learning/SinterEvaluatorBaseline.js';

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = join(tmpdir(), `sinter-baseline-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  tempDirs.push(dir);
  return dir;
}

function writeJsonl(file: string, rows: unknown[]): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`);
}

function row(id: string, source: string, domain: string, bucket: string, score: number, weight = 1): unknown {
  return {
    id,
    source,
    input: { domain },
    target: { scoreBucket: bucket, passFail: score >= 0.7 ? 'pass' : 'fail', numericScore: score },
    metadata: { labelWeight: weight, trustTier: source === 'rescore' ? 'high' : 'medium', trainingUse: 'primary' },
  };
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe('SinterEvaluatorBaseline', () => {
  it('writes metrics, confusion matrix, errors, and report', async () => {
    const root = makeTempDir();
    const dataset = join(root, 'dataset');
    const out = join(root, 'baseline');
    writeJsonl(join(dataset, 'primary-train.jsonl'), [
      row('a', 'rescore', 'p5', 'excellent', 0.9),
      row('b', 'rescore', 'p5', 'excellent', 0.88),
      row('c', 'quality_archive', 'svg', 'poor', 0.2, 0.7),
      row('d', 'quality_archive', 'svg', 'poor', 0.3, 0.7),
    ]);
    writeJsonl(join(dataset, 'primary-val.jsonl'), [row('e', 'rescore', 'p5', 'excellent', 0.87)]);
    writeJsonl(join(dataset, 'primary-test.jsonl'), [
      row('f', 'rescore', 'p5', 'excellent', 0.89),
      row('g', 'quality_archive', 'svg', 'poor', 0.25, 0.7),
    ]);

    const report = await runEvaluatorBaseline({ datasetDir: dataset, outputDir: out, mode: 'primary', now: '2026-07-06T00:00:00Z' });

    expect(report.metrics.map((metric) => metric.model)).toContain('majority');
    expect(report.metrics.map((metric) => metric.model)).toContain('domainSourceLookup');
    expect(report.metrics.map((metric) => metric.model)).toContain('renderStatsHeuristic');
    expect(report.testRows).toBe(2);
    expect(readFileSync(join(out, 'metrics.json'), 'utf8')).toContain('macroF1');
    expect(readFileSync(join(out, 'confusion-matrix.json'), 'utf8')).toContain('domainSourceLookup');
    expect(readFileSync(join(out, 'baseline-report.md'), 'utf8')).toContain('SINTER evaluator baseline report');
  });

  it('recommends more data when primary split is too small for LoRA confidence', async () => {
    const root = makeTempDir();
    const dataset = join(root, 'dataset');
    const out = join(root, 'baseline');
    writeJsonl(join(dataset, 'primary-train.jsonl'), [row('a', 'rescore', 'p5', 'excellent', 0.9)]);
    writeJsonl(join(dataset, 'primary-val.jsonl'), [row('b', 'rescore', 'p5', 'good', 0.75)]);
    writeJsonl(join(dataset, 'primary-test.jsonl'), [row('c', 'rescore', 'p5', 'poor', 0.2)]);

    const report = await runEvaluatorBaseline({ datasetDir: dataset, outputDir: out, mode: 'primary' });

    expect(report.recommendation.verdict).toBe('collect_more_data');
  });
});
