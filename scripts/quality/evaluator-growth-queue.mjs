#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { buildEvaluatorGrowthQueue } from '../../dist/learning/SinterEvaluatorGrowthQueue.js';

function valueAfter(flag) {
  const idx = process.argv.indexOf(flag);
  return idx >= 0 ? process.argv[idx + 1] : undefined;
}

if (process.argv.includes('--help')) {
  console.log(`Usage: pnpm build && node scripts/quality/evaluator-growth-queue.mjs --dataset-dir DIR --baseline-dir DIR [--out DIR] [--owner-downvotes FILE]\n\nBuilds a prioritized queue for the next SINTER evaluator labels.`);
  process.exit(0);
}

const cleanedDatasetDir = valueAfter('--dataset-dir') ?? '.omx/generated/sinter-evaluator-dataset/latest';
const baselineDir = valueAfter('--baseline-dir') ?? '.omx/generated/sinter-evaluator-baseline/latest';
const outputDir = valueAfter('--out') ?? '.omx/generated/sinter-evaluator-growth/latest';

// ratings_to_negatives.py writes owner-downvotes.jsonl into the art home's learning/ dir; read it from there unless told otherwise.
const artHome = process.env.S1NTR_ART_HOME ?? `${process.env.HOME}/s1ntr-art`;
const ownerDownvotesFile = valueAfter('--owner-downvotes') ?? (existsSync(`${artHome}/learning/owner-downvotes.jsonl`) ? `${artHome}/learning/owner-downvotes.jsonl` : undefined);

const report = await buildEvaluatorGrowthQueue({ cleanedDatasetDir, baselineDir, outputDir, ownerDownvotesFile });
console.log(JSON.stringify(report, null, 2));
