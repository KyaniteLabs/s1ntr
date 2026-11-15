import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { materializeEvaluatorGrowth } from '../../../src/learning/SinterEvaluatorGrowthMaterializer.js';

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = join(tmpdir(), `sinter-materialize-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  tempDirs.push(dir);
  return dir;
}

function writeJsonl(file: string, rows: unknown[]): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`);
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe('SinterEvaluatorGrowthMaterializer', () => {
  it('promotes hard negatives and quality-archive baseline confirmations while queueing ambiguous misses', async () => {
    const root = makeTempDir();
    const queue = join(root, 'growth-queue.jsonl');
    const out = join(root, 'out');
    const rescoreOut = join(root, 'rescore', 'hard.jsonl');
    const reviewOut = join(root, 'review', 'review.jsonl');
    writeJsonl(queue, [
      { kind: 'quarantined_hard_negative', reason: 'too dark', payload: { id: 'bad', domain: 'svg', numericScore: 0.88 } },
      { kind: 'baseline_error', reason: 'archive miss', payload: { id: 'confirmed', domain: 'strudel', source: 'quality_archive', actual: 'excellent', predicted: 'poor', numericScore: 0.85, model: 'majority' } },
      { kind: 'baseline_error', reason: 'missed', payload: { id: 'ambiguous', domain: 'p5', source: 'rescore', actual: 'good', predicted: 'poor', numericScore: 0.8, model: 'majority' } },
      { kind: 'bucket_gap', payload: { bucket: 'poor' } },
    ]);

    const report = await materializeEvaluatorGrowth({ growthQueueJsonl: queue, outputDir: out, rescoreOutput: rescoreOut, reviewOutput: reviewOut, now: '2026-07-06T00:00:00Z' });

    expect(report.counts.hardNegativeLabels).toBe(1);
    expect(report.counts.baselineConfirmationLabels).toBe(1);
    expect(report.counts.reviewItems).toBe(1);
    expect(report.counts.skippedItems).toBe(1);
    expect(readFileSync(rescoreOut, 'utf8')).toContain('hard_negative_rescore');
    expect(readFileSync(rescoreOut, 'utf8')).toContain('baseline_challenge_confirmation');
    expect(readFileSync(rescoreOut, 'utf8')).toContain('"fresh":0');
    expect(readFileSync(reviewOut, 'utf8')).toContain('human_or_rescore_label');
  });
});
