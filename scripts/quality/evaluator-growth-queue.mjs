#!/usr/bin/env node
import { buildEvaluatorGrowthQueue } from '../../dist/learning/SinterEvaluatorGrowthQueue.js';

function valueAfter(flag) {
  const idx = process.argv.indexOf(flag);
  return idx >= 0 ? process.argv[idx + 1] : undefined;
}

if (process.argv.includes('--help')) {
  console.log(`Usage: pnpm build && node scripts/quality/evaluator-growth-queue.mjs --dataset-dir DIR --baseline-dir DIR [--out DIR]\n\nBuilds a prioritized queue for the next SINTER evaluator labels.`);
  process.exit(0);
}

const cleanedDatasetDir = valueAfter('--dataset-dir') ?? '.omx/generated/sinter-evaluator-dataset/latest';
const baselineDir = valueAfter('--baseline-dir') ?? '.omx/generated/sinter-evaluator-baseline/latest';
const outputDir = valueAfter('--out') ?? '.omx/generated/sinter-evaluator-growth/latest';

const report = await buildEvaluatorGrowthQueue({ cleanedDatasetDir, baselineDir, outputDir });
console.log(JSON.stringify(report, null, 2));
