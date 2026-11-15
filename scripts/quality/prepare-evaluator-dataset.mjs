#!/usr/bin/env node
import { prepareEvaluatorDataset } from '../../dist/learning/SinterEvaluatorDatasetPreparer.js';

function valueAfter(flag) {
  const idx = process.argv.indexOf(flag);
  return idx >= 0 ? process.argv[idx + 1] : undefined;
}

if (process.argv.includes('--help')) {
  console.log(`Usage: pnpm build && node scripts/quality/prepare-evaluator-dataset.mjs [--role-export-dir DIR | --input FILE] [--out DIR] [--seed STRING]\n\nConsumes evaluator_system_quality_v0.jsonl, quarantines unsafe labels, and writes train/val/test/quarantine splits plus a dataset card.`);
  process.exit(0);
}

const roleExportDir = valueAfter('--role-export-dir') ?? '.omx/generated/sinter-training-bundles/latest';
const inputJsonl = valueAfter('--input');
const outputDir = valueAfter('--out') ?? '.omx/generated/sinter-evaluator-dataset/latest';
const seed = valueAfter('--seed');

const summary = await prepareEvaluatorDataset({ roleExportDir, inputJsonl, outputDir, seed });
console.log(JSON.stringify(summary, null, 2));
