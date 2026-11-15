#!/usr/bin/env node
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { buildManifest } from './manifest.mjs';
import { CLUSTERS } from './clusters.mjs';
import { checkBudget, loadBudget } from './budget.mjs';

export function countLoc(filePath) {
  try {
    const text = fs.readFileSync(filePath, 'utf8');
    return text.split(/\r?\n/).length;
  } catch {
    return 0;
  }
}

export function buildLedger(cwd = process.cwd(), opts = {}) {
  const manifest = buildManifest(cwd);
  const sha = manifest.commitSha;
  const dirty = execSync('git status --porcelain', { cwd, encoding: 'utf8' }).trim().length > 0;
  const clusters = {};
  for (const id of Object.keys(CLUSTERS)) {
    clusters[id] = {
      clusterId: id,
      status: 'mapped',
      locAtInventory: 0,
      fileCount: 0,
      lastWave: opts.waveId || 'inventory',
      receiptPath: null,
      orphan: false,
    };
  }
  for (const row of manifest.rows) {
    if (row.status !== 'owned') continue;
    const c = clusters[row.clusterId];
    if (!c) continue;
    c.fileCount += 1;
    c.locAtInventory += countLoc(path.join(cwd, row.path));
  }
  return {
    schema: 'sinter-mece-coverage-v1',
    commitSha: sha,
    dirtyWorkingTree: dirty,
    stale: dirty,
    generatedAt: new Date().toISOString(),
    unownedCount: manifest.unowned.length,
    clusters,
    budgetCheck: checkBudget({ calls: 1, tokens: 0, usd: 0, ms: 0 }, loadBudget()),
  };
}

export function writeLedger(ledger, outPath) {
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(ledger, null, 2));
}

export function main(argv = process.argv.slice(2)) {
  const writeIdx = argv.indexOf('--write');
  const out = writeIdx >= 0 ? argv[writeIdx + 1] : path.join(process.cwd(), '.quality/mece/ledger.json');
  const ledger = buildLedger();
  writeLedger(ledger, out);
  console.log(JSON.stringify({ ok: true, out, commitSha: ledger.commitSha, stale: ledger.stale, clusters: Object.keys(ledger.clusters).length }, null, 2));
  process.exit(0);
}

if (process.argv[1]?.endsWith('inventory.mjs')) main();
