#!/usr/bin/env node
import { materializeEvaluatorGrowth } from '../../dist/learning/SinterEvaluatorGrowthMaterializer.js';

function valueAfter(flag) {
  const idx = process.argv.indexOf(flag);
  return idx >= 0 ? process.argv[idx + 1] : undefined;
}

if (process.argv.includes('--help')) {
  console.log(`Usage: pnpm build && node scripts/quality/materialize-evaluator-growth.mjs --growth-queue FILE [--out DIR] [--rescore-out FILE] [--review-out FILE]\n\nPromotes objective hard negatives to explicit rescore labels and writes ambiguous baseline misses to a review queue.`);
  process.exit(0);
}

const growthQueueJsonl = valueAfter('--growth-queue');
if (!growthQueueJsonl) {
  console.error('--growth-queue is required');
  process.exit(2);
}
const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
const outputDir = valueAfter('--out') ?? `.omx/generated/sinter-evaluator-growth/materialized-${stamp}`;
const rescoreOutput = valueAfter('--rescore-out') ?? `docs/validation/rescore/evaluator-hard-negatives-${stamp}.jsonl`;
const reviewOutput = valueAfter('--review-out') ?? `docs/validation/evaluator-review/evaluator-review-${stamp}.jsonl`;

const report = await materializeEvaluatorGrowth({ growthQueueJsonl, outputDir, rescoreOutput, reviewOutput });
console.log(JSON.stringify(report, null, 2));
