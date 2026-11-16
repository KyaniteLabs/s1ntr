#!/usr/bin/env node
// Pack-time census for npm installs (#1590). Runs after `npm run build` in
// prepack: scans the governed entrypoints in the real src tree and records the
// git refs it was packed from, so the shipped dist can prove both without src or git.
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const dist = (file) => import(path.join(root, 'dist', file));
const { scanProductionEntrypointAuthorityLocators } = await dist('runtime-core/ProductionAuthorityScanner.js');
const { resolveProductionSourceRefs } = await dist('runtime-core/ProductionLiminalRuntime.js');
const { enforceProductionAuthorityEntrypoints } = await dist('runtime-core/ProductionAuthorityRegistry.js');
const { PRODUCTION_AUTHORITY_ENTRYPOINTS, PRODUCTION_AUTHORITY_STAMP, buildProductionAuthorityStamp } =
  await dist('runtime-core/ProductionPackageStamp.js');

// The stamp names a commit, so the packed bytes must be exactly that commit.
const dirty = execFileSync('git', ['status', '--porcelain', '--', 'src', 'bin', 'vendor', 'scripts/packaging',
  'package.json'], { cwd: root, encoding: 'utf8' }).trim();
if (dirty) throw new Error(`PRODUCTION_AUTHORITY_STAMP_DIRTY_TREE: commit or discard first\n${dirty}`);

const refs = resolveProductionSourceRefs({ repoRoot: root });
if (refs.sourceKind !== 'git-origin-main') {
  throw new Error(`PRODUCTION_AUTHORITY_STAMP_NEEDS_SOURCE_TREE: pack from a full git clone with origin/main (got ${refs.sourceKind})`);
}
const entrypoints = {};
for (const entry of PRODUCTION_AUTHORITY_ENTRYPOINTS) {
  entrypoints[entry] = [...await scanProductionEntrypointAuthorityLocators(root, [entry])];
  // Refuse to ship a census every install would reject on its first command.
  enforceProductionAuthorityEntrypoints(entrypoints[entry]);
}
const stamp = buildProductionAuthorityStamp(root, {
  sourceHeadSha: refs.sourceHeadSha, canonicalMainSha: refs.canonicalMainSha, entrypoints });
writeFileSync(path.join(root, PRODUCTION_AUTHORITY_STAMP), `${JSON.stringify(stamp, null, 2)}\n`);
console.log(`[prepack] ${PRODUCTION_AUTHORITY_STAMP}: ${refs.sourceKind} ${refs.sourceHeadSha.slice(0, 9)}`);
