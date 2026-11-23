/**
 * Organ: judge negatives.  A negative written to the cleaned dataset (owner thumbs-down, judge hard negative) must be read by
 * the growth queue AND survive the materializer into a file the evaluator labelling step consumes.  Before the fix the
 * materializer counted owner_downvote and judge_hard_negative queue items as "skipped", so the loop ended there.
 */
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildEvaluatorGrowthQueue } from '../../src/learning/SinterEvaluatorGrowthQueue.js';
import { materializeEvaluatorGrowth } from '../../src/learning/SinterEvaluatorGrowthMaterializer.js';

const jsonl = (rows: unknown[]) => rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : '');

async function loop(downvotes: unknown[]) {
  const root = await mkdtemp(path.join(tmpdir(), 'organ-negatives-'));
  const dataset = path.join(root, 'dataset'); const baseline = path.join(root, 'baseline'); await mkdir(dataset); await mkdir(path.join(baseline, 'primary'), { recursive: true });
  await writeFile(path.join(dataset, 'owner-downvotes.jsonl'), jsonl(downvotes));
  const growth = path.join(root, 'growth');
  const report = await buildEvaluatorGrowthQueue({ cleanedDatasetDir: dataset, baselineDir: baseline, outputDir: growth });
  const mat = await materializeEvaluatorGrowth({ growthQueueJsonl: path.join(growth, 'growth-queue.jsonl'), outputDir: path.join(root, 'mat'),
    rescoreOutput: path.join(root, 'rescore.jsonl'), reviewOutput: path.join(root, 'review.jsonl') });
  const review = (await readFile(path.join(root, 'review.jsonl'), 'utf8')).split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const queue = (await readFile(path.join(growth, 'growth-queue.jsonl'), 'utf8')).split('\n').filter(Boolean).map((l) => JSON.parse(l));
  return { report, mat, review, queue };
}

describe('organ: judge negatives', () => {
  it('a written owner down-vote is read by the queue and reaches the rescore review file', async () => {
    const { queue, review, mat } = await loop([{ seat: 'mimo', id: 'hydra-olive-r1', vote: 'down', reason: 'mud-camo', measure: { lightP98: 0.4 } }]);
    expect(queue.some((q) => q.kind === 'owner_downvote' && q.payload.id === 'hydra-olive-r1' && q.action === 'rescore')).toBe(true);
    expect(review.map((r) => r.id)).toContain('hydra-olive-r1');
    expect(review.find((r) => r.id === 'hydra-olive-r1').requestedAction).toBe('rescore');
    expect(mat.counts.reviewItems).toBe(1);
  });

  it('with nothing written the loop produces nothing (perturbation: remove the negative, the review row disappears)', async () => {
    const { review } = await loop([]);
    expect(review.map((r) => r.id)).not.toContain('hydra-olive-r1');
  });

  it('an up-vote is never a negative', async () => {
    const { queue } = await loop([{ seat: 'mimo', id: 'liked', vote: 'up' }]);
    expect(queue.some((q) => q.payload.id === 'liked')).toBe(false);
  });
});
