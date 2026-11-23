import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildEvaluatorGrowthQueue } from '../../../src/learning/SinterEvaluatorGrowthQueue.js';

const dirs: string[] = [];
afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }); });

/** F08: one malformed line must not wipe the valid rows, and must be reported, not hidden. */
describe('growth queue input robustness (F08)', () => {
  it('keeps valid owner-downvote rows around a corrupt line and reports the corrupt line', async () => {
    const root = mkdtempSync(join(tmpdir(), 'growth-corrupt-')); dirs.push(root);
    const dataset = join(root, 'dataset'); mkdirSync(dataset, { recursive: true });
    mkdirSync(join(root, 'baseline', 'primary'), { recursive: true });
    for (const f of ['primary-train', 'primary-val', 'primary-test', 'quarantine', 'judge-negatives']) writeFileSync(join(dataset, `${f}.jsonl`), '');
    writeFileSync(join(dataset, 'owner-downvotes.jsonl'), [
      JSON.stringify({ id: 'a', vote: 'down', reason: 'mud-camo' }), '{not json', JSON.stringify({ id: 'b', vote: 'down' }), ''].join('\n'));
    const report = await buildEvaluatorGrowthQueue({ cleanedDatasetDir: dataset, baselineDir: join(root, 'baseline'), outputDir: join(root, 'out') });
    const queue = readFileSync(join(root, 'out', 'growth-queue.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
    expect(queue.filter(i => i.kind === 'owner_downvote').map(i => i.payload.id).sort()).toEqual(['a', 'b']);
    expect(report.malformedRows).toEqual([{ file: 'owner-downvotes.jsonl', line: 2 }]);
  });
});
