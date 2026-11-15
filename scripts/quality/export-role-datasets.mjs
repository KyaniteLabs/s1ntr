#!/usr/bin/env node
import { exportSinterRoleDatasets } from '../../dist/learning/SinterRoleDatasetExporter.js';

function valueAfter(flag) {
  const idx = process.argv.indexOf(flag);
  return idx >= 0 ? process.argv[idx + 1] : undefined;
}

const outputDir = valueAfter('--out') ?? '.omx/generated/sinter-training-bundles/latest';
const repoRoot = valueAfter('--repo-root') ?? process.cwd();
const sinterHome = valueAfter('--sinter-home');
const includeArtifactText = process.argv.includes('--include-artifact-text');
const maxDiagnosticRowsRaw = valueAfter('--max-diagnostic-rows');
const maxDiagnosticRows = maxDiagnosticRowsRaw ? Number(maxDiagnosticRowsRaw) : undefined;

if (process.argv.includes('--help')) {
  console.log(`Usage: pnpm build && node scripts/quality/export-role-datasets.mjs [--out DIR] [--repo-root DIR] [--sinter-home DIR] [--include-artifact-text] [--max-diagnostic-rows N]\n\nWrites a role-aware SINTER fine-tuning manifest plus safe starter JSONL bundle indexes.`);
  process.exit(0);
}

const manifest = await exportSinterRoleDatasets({
  repoRoot,
  sinterHome,
  outputDir,
  includeArtifactText,
  maxDiagnosticRows,
});

console.log(JSON.stringify({
  outputDir,
  bundles: manifest.bundles.map((bundle) => ({
    id: bundle.id,
    role: bundle.role,
    trainability: bundle.trainability,
    rowCountEstimate: bundle.rowCountEstimate,
  })),
  recommendation: manifest.recommendation,
}, null, 2));
