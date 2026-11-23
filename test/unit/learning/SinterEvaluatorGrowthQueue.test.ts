import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { buildEvaluatorGrowthQueue } from '../../../src/learning/SinterEvaluatorGrowthQueue.js';
import { createHash } from 'node:crypto';
import { buildLegacyBackfillRow, legacyNegativeRow } from '../../../src/learning/LegacyBackfill.js';
import { judgeNegativeRow } from '../../../src/learning/JudgeNegativeRow.js';
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
  it('queues admitted judge-scoring hard negatives and ignores unadmitted or mismatched ones', async () => {
    const root = makeTempDir();
    const dataset = join(root, 'dataset'); const baseline = join(root, 'baseline'); const out = join(root, 'out');
    const digest = createHash('sha256').update('weak').digest('hex');
    const label = (uses: ('hard-negative' | 'few-shot')[], artifactDigest = digest) =>
      createCreativeLabelAdmission({ trustKind: 'judge-scoring', allowedUses: uses, artifactDigest,
        evidenceDigest: 'b'.repeat(64), decisionDigest: 'c'.repeat(64), rendered: true,
        identityValid: true, digestMatched: true, degraded: false });
    writeJsonl(join(dataset, 'primary-train.jsonl'), []);
    writeJsonl(join(dataset, 'primary-val.jsonl'), []);
    writeJsonl(join(dataset, 'primary-test.jsonl'), []);
    writeJsonl(join(dataset, 'quarantine.jsonl'), []);
    writeJsonl(join(dataset, 'judge-negatives.jsonl'), [
      { id: 'weak-1', source: 'judge-scoring', input: { domain: 'p5', artifact_sha256: digest },
        label: { creative_label: label(['hard-negative']) }, metadata: { judgeScore: 0.31, judge: 'glm/flash' } },
      { id: 'positive', source: 'judge-scoring', input: { domain: 'p5', artifact_sha256: digest },
        label: { creative_label: label(['few-shot']) }, metadata: { judgeScore: 0.9 } },
      { id: 'swapped', source: 'judge-scoring', input: { domain: 'p5', artifact_sha256: 'f'.repeat(64) },
        label: { creative_label: label(['hard-negative']) }, metadata: { judgeScore: 0.2 } },
    ]);
    mkdirSync(join(baseline, 'primary'), { recursive: true });
    writeJsonl(join(baseline, 'primary', 'errors.jsonl'), []);
    const report = await buildEvaluatorGrowthQueue({ cleanedDatasetDir: dataset, baselineDir: baseline, outputDir: out });
    expect(report.counts.judgeNegatives).toBe(1);
    const queue = readFileSync(join(out, 'growth-queue.jsonl'), 'utf8');
    expect(queue).toContain('judge_hard_negative');
    expect(queue).toContain('weak-1');
    expect(queue).not.toContain('"positive"');
    expect(queue).not.toContain('swapped');
  });
  it('persists then consumes a legacy-backfill negative below a live judge negative', async () => {
    const root = makeTempDir();
    const dataset = join(root, 'dataset'); const baseline = join(root, 'baseline'); const out = join(root, 'out');
    for (const f of ['primary-train', 'primary-val', 'primary-test', 'quarantine']) writeJsonl(join(dataset, `${f}.jsonl`), []);
    const legacy = legacyNegativeRow(buildLegacyBackfillRow({ sourceBytes: '<p>weak</p>',
      renderDigest: 'd'.repeat(64), judge: 'glm-5.3-flash', judgeVersion: 'v1', score: 0.1 }))!;
    const liveDigest = 'e'.repeat(64);
    const live = judgeNegativeRow({ createKey: 'live-1', decision: 'rejected', domain: 'p5',
      artifactDigest: liveDigest, score: 0.3, judge: 'glm-5.3-flash', ruleId: 'judge-score-floor-v2-simon40',
      label: createCreativeLabelAdmission({ trustKind: 'judge-scoring', allowedUses: ['hard-negative'],
        artifactDigest: liveDigest, evidenceDigest: 'b'.repeat(64), decisionDigest: 'c'.repeat(64),
        rendered: true, identityValid: true, digestMatched: true, degraded: false }) })!;
    writeJsonl(join(dataset, 'judge-negatives.jsonl'), [legacy, live]);
    mkdirSync(join(baseline, 'primary'), { recursive: true });
    writeJsonl(join(baseline, 'primary', 'errors.jsonl'), []);
    const report = await buildEvaluatorGrowthQueue({ cleanedDatasetDir: dataset, baselineDir: baseline, outputDir: out });
    expect(report.counts.judgeNegatives).toBe(2);
    const lines = readFileSync(join(out, 'growth-queue.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
    const ids = lines.filter(l => l.kind === 'judge_hard_negative').map(l => l.payload.id);
    expect(ids[0]).toBe('live-1');
    expect(ids[1]).toMatch(/^legacy:/);
  });

  it('queues owner thumbs-downs, ranking detector-confirmed mud-camo first', async () => {
    const root = makeTempDir();
    const dataset = join(root, 'dataset'); const baseline = join(root, 'baseline'); const out = join(root, 'out');
    for (const f of ['primary-train', 'primary-val', 'primary-test', 'quarantine']) writeJsonl(join(dataset, `${f}.jsonl`), []);
    writeJsonl(join(dataset, 'owner-downvotes.jsonl'), [
      { seat: 'ds0731', id: 'hydra-organic-high-r1', vote: 'down', reason: 'mud-camo', measure: { lightP98: 0.4 } },
      { seat: 'mimo', id: 'hydra-kaleid-low-r1', vote: 'down', reason: 'owner-downvote' },
      { seat: 'mimo', id: 'liked', vote: 'up', reason: 'mud-camo' },
    ]);
    mkdirSync(join(baseline, 'primary'), { recursive: true });
    writeJsonl(join(baseline, 'primary', 'errors.jsonl'), []);
    await buildEvaluatorGrowthQueue({ cleanedDatasetDir: dataset, baselineDir: baseline, outputDir: out });
    const rows = readFileSync(join(out, 'growth-queue.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    const owner = rows.filter((r) => r.kind === 'owner_downvote');
    expect(owner.map((r) => r.payload.id)).toEqual(['hydra-organic-high-r1', 'hydra-kaleid-low-r1']);
    expect(owner[0].reason).toContain('overmixed / lost value structure');
    expect(JSON.stringify(rows)).not.toContain('"liked"');
  });

  it('reads owner downvotes from the learning dir the converter writes to, not only the dataset dir (F05)', async () => {
    const root = makeTempDir();
    const dataset = join(root, 'dataset'); const baseline = join(root, 'baseline'); const out = join(root, 'out'); const learning = join(root, 'learning');
    for (const f of ['primary-train', 'primary-val', 'primary-test', 'quarantine']) writeJsonl(join(dataset, `${f}.jsonl`), []);
    writeJsonl(join(learning, 'owner-downvotes.jsonl'), [{ seat: 'ds0731', id: 'hydra-organic-high-r1', uid: 'ds0731-81a2ddfb62', vote: 'down', reason: 'owner-downvote' }]);
    mkdirSync(join(baseline, 'primary'), { recursive: true });
    writeJsonl(join(baseline, 'primary', 'errors.jsonl'), []);
    await buildEvaluatorGrowthQueue({ cleanedDatasetDir: dataset, baselineDir: baseline, outputDir: out, ownerDownvotesFile: join(learning, 'owner-downvotes.jsonl') });
    const rows = readFileSync(join(out, 'growth-queue.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(rows.filter((r) => r.kind === 'owner_downvote').map((r) => r.payload.id)).toEqual(['ds0731-81a2ddfb62']);   // the voted uid, not the seat-scoped alias
  });
});
