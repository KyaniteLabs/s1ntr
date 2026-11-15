#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { evaluateCreativeProof } from '../../dist/quality/CreativeProofGate.js';

function receiptPath(argv) {
  const flagIndex = argv.indexOf('--receipt');
  const value = flagIndex >= 0 ? argv[flagIndex + 1] : argv[0];
  if (!value) {
    throw new Error('usage: pnpm quality:creative-proof -- --receipt <receipt.json>');
  }
  return value;
}

export async function validateCreativeProofFile(path) {
  const input = JSON.parse(await readFile(path, 'utf8'));
  return evaluateCreativeProof(input);
}

async function main() {
  const report = await validateCreativeProofFile(receiptPath(process.argv.slice(2)));
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (report.outcome !== 'PASS') process.exitCode = 1;
}

if (process.argv[1]?.endsWith('validate-creative-proof.mjs')) {
  main().catch(error => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
