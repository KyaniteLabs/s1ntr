#!/usr/bin/env node
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { assignCluster, CLUSTERS } from './clusters.mjs';

export function listTrackedFiles(cwd = process.cwd()) {
  const out = execSync('git ls-files -z', { cwd, encoding: 'buffer' });
  return out
    .toString('utf8')
    .split('\0')
    .filter(Boolean)
    .map((p) => p.replace(/\\/g, '/'));
}

export function buildManifest(cwd = process.cwd()) {
  const files = listTrackedFiles(cwd);
  const rows = [];
  const unowned = [];
  const double = []; // reserved if multi-assign ever happens
  const byCluster = Object.fromEntries(Object.keys(CLUSTERS).map((k) => [k, 0]));
  let excluded = 0;

  for (const file of files) {
    const a = assignCluster(file);
    if (a.kind === 'exclude') {
      excluded += 1;
      rows.push({ path: file, status: 'exclude', reason: a.reason });
      continue;
    }
    if (a.kind === 'unowned') {
      unowned.push(file);
      rows.push({ path: file, status: 'unowned' });
      continue;
    }
    byCluster[a.clusterId] = (byCluster[a.clusterId] || 0) + 1;
    rows.push({ path: file, status: 'owned', clusterId: a.clusterId });
  }

  const sha = execSync('git rev-parse HEAD', { cwd, encoding: 'utf8' }).trim();
  return {
    schema: 'sinter-mece-manifest-v1',
    commitSha: sha,
    generatedAt: new Date().toISOString(),
    counts: {
      tracked: files.length,
      owned: files.length - unowned.length - excluded,
      excluded,
      unowned: unowned.length,
      byCluster,
    },
    unowned,
    doubleOwned: double,
    rows,
  };
}

export function validateManifest(manifest) {
  const errors = [];
  if (manifest.unowned?.length) {
    errors.push(`unowned paths: ${manifest.unowned.length} (e.g. ${manifest.unowned.slice(0, 5).join(', ')})`);
  }
  if (manifest.doubleOwned?.length) {
    errors.push(`double-owned paths: ${manifest.doubleOwned.length}`);
  }
  return { ok: errors.length === 0, errors };
}

export function main(argv = process.argv.slice(2)) {
  const writeIdx = argv.indexOf('--write');
  const writePath = writeIdx >= 0 ? argv[writeIdx + 1] : null;
  const check = argv.includes('--check');
  const manifest = buildManifest();
  const v = validateManifest(manifest);
  if (writePath) {
    fs.mkdirSync(path.dirname(writePath), { recursive: true });
    const slim = { ...manifest, rows: undefined, sampleRows: manifest.rows.slice(0, 20) };
    // full rows optional heavy — write summary + unowned only for default write
    fs.writeFileSync(writePath, JSON.stringify({ ...slim, unowned: manifest.unowned }, null, 2));
  }
  if (check || !writePath) {
    console.log(JSON.stringify({ ok: v.ok, counts: manifest.counts, unownedSample: manifest.unowned.slice(0, 10), errors: v.errors }, null, 2));
  }
  process.exit(v.ok ? 0 : 1);
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('manifest.mjs')) {
  main();
}
