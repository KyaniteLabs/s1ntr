import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { buildEvaluatorGrowthQueue } from '../../../src/learning/SinterEvaluatorGrowthQueue.js';
import { createHash } from 'node:crypto';
import { createCreativeLabelAdmission } from
  '../../../src/learning/CreativeLabelAdmission.js';

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = join(tmpdir(), `sinter-growth-${Date.now()}-${Math.random().toString(36).slice(2)}`);
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

describe('SinterEvaluatorGrowthQueue', () => {
  it('prioritizes baseline errors, hard negatives, bucket gaps, and domain gaps', async () => {
    const root = makeTempDir();
    const dataset = join(root, 'dataset');
    const baseline = join(root, 'baseline');
    const out = join(root, 'out');
    const artifactDigest = createHash('sha256').update('bad').digest('hex');
    const hardNegative = createCreativeLabelAdmission({ trustKind: 'universal-criterion',
      allowedUses: ['hard-negative'], artifactDigest, evidenceDigest: 'b'.repeat(64),
      decisionDigest: 'c'.repeat(64), rendered: true, identityValid: true,
      digestMatched: true, degraded: false });
    writeJsonl(join(dataset, 'primary-train.jsonl'), [
      { id: 'a', input: { domain: 'p5' }, target: { scoreBucket: 'excellent' } },
      { id: 'bad-confirmed', input: { domain: 'svg' }, target: { scoreBucket: 'poor' }, metadata: { trustTier: 'high' } },
    ]);
    writeJsonl(join(dataset, 'primary-val.jsonl'), []);
    writeJsonl(join(dataset, 'primary-test.jsonl'), []);
    writeJsonl(join(dataset, 'quarantine.jsonl'), [
      { id: 'bad', source: 'quality_archive', input: { domain: 'svg', artifact_sha256:
        artifactDigest }, label: { creative_label: hardNegative },
      metadata: { quarantineReasons: ['positive_label_too_dark_render_stats'] } },
      { id: 'bad-confirmed', source: 'quality_archive', input: { domain: 'svg' }, metadata: { quarantineReasons: ['positive_label_too_dark_render_stats', 'duplicate_superseded_by_higher_trust_label'] } },
      { id: 'static-bad', source: 'quality_archive', input: { domain: 'svg' },
        metadata: { quarantineReasons: ['positive_label_too_dark_render_stats'] } },
    ]);
    mkdirSync(join(baseline, 'primary'), { recursive: true });
    writeJsonl(join(baseline, 'primary', 'errors.jsonl'), [
      { id: 'err', source: 'quality_archive', trustTier: 'medium', domain: 'p5', actual: 'poor', predicted: 'good', model: 'domainSourceLookup' },
      { id: 'confirmed', source: 'rescore', trustTier: 'high', domain: 'p5', actual: 'poor', predicted: 'good', model: 'domainSourceLookup' },
      { id: 'majority-miss', source: 'quality_archive', trustTier: 'medium', domain: 'p5', actual: 'excellent', predicted: 'poor', model: 'majority' },
    ]);

    const report = await buildEvaluatorGrowthQueue({ cleanedDatasetDir: dataset, baselineDir: baseline, outputDir: out, now: '2026-07-06T00:00:00Z' });

    expect(report.counts.baselineErrors).toBe(1);
    expect(report.counts.quarantineItems).toBe(1);
    expect(report.counts.bucketGaps).toBeGreaterThan(0);
    expect(report.counts.domainGaps).toBeGreaterThan(0);
    const queue = readFileSync(join(out, 'growth-queue.jsonl'), 'utf8');
    expect(queue).toContain('baseline_error');
    expect(queue).toContain('quarantined_hard_negative');
    expect(queue).not.toContain('bad-confirmed');
    expect(queue).not.toContain('static-bad');
    expect(queue).not.toContain('confirmed');
    expect(queue).not.toContain('majority-miss');
    expect(readFileSync(join(out, 'growth-report.md'), 'utf8')).toContain('SINTER evaluator data growth queue');
  });
});
