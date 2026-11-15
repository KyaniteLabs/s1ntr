#!/usr/bin/env node
import { runEvaluatorBaseline } from '../../dist/learning/SinterEvaluatorBaseline.js';

function valueAfter(flag) {
  const idx = process.argv.indexOf(flag);
  return idx >= 0 ? process.argv[idx + 1] : undefined;
}

if (process.argv.includes('--help')) {
  console.log(`Usage: pnpm build && node scripts/quality/baseline-evaluator-dataset.mjs [--dataset-dir DIR] [--out DIR] [--mode primary|full|proxy]\n\nRuns no-dependency baselines for the prepared SINTER evaluator dataset.`);
  process.exit(0);
}

const datasetDir = valueAfter('--dataset-dir') ?? '.omx/generated/sinter-evaluator-dataset/latest';
const outputDir = valueAfter('--out') ?? '.omx/generated/sinter-evaluator-baseline/latest';
const mode = valueAfter('--mode') ?? 'primary';

const report = await runEvaluatorBaseline({ datasetDir, outputDir, mode });
console.log(JSON.stringify(report, null, 2));
