#!/usr/bin/env node
/**
 * IW-K01 / L4: stage diagnose inputs into allowlisted paths.
 * Allowlist SSOT: src/harness/DiagnosePathAllowlist (loaded from dist).
 * Does not widen allowlist to .quality/.
 *
 * Usage:
 *   node scripts/rotation/stage-diagnose-inputs.mjs \
 *     --from .quality/wave6/META_FOR_KIMI.md \
 *     --to docs/agents/waves/staged/META_FOR_KIMI.md
 */
import { copyFileSync, mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve, relative, join } from 'node:path';
import { createHash } from 'node:crypto';
import { execSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

async function loadIsPathAllowlisted() {
  const candidates = [
    join(process.cwd(), 'dist/harness/DiagnosePathAllowlist.js'),
    join(process.cwd(), 'dist/src/harness/DiagnosePathAllowlist.js'),
  ];
  for (const c of candidates) {
    if (existsSync(c)) {
      const mod = await import(pathToFileURL(c).href);
      if (typeof mod.isPathAllowlisted === 'function') return mod.isPathAllowlisted;
    }
  }
  throw new Error(
    'DiagnosePathAllowlist dist missing — run build; refuse dual local ALLOW_PREFIXES (W9-L4-01)',
  );
}

function parseArgs(argv) {
  const out = { from: null, to: null };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--from') out.from = argv[++i];
    else if (argv[i] === '--to') out.to = argv[++i];
  }
  return out;
}

const { from, to } = parseArgs(process.argv);
if (!from || !to) {
  console.error('Usage: stage-diagnose-inputs.mjs --from <path> --to <docs|tmp path>');
  process.exit(2);
}

const isPathAllowlisted = await loadIsPathAllowlisted();
const root = process.cwd();
const src = resolve(root, from);
const dest = resolve(root, to);
const relDest = relative(root, dest).replace(/\\/g, '/');
if (!existsSync(src)) {
  console.error(`INPUT_UNREACHABLE: source missing: ${from}`);
  process.exit(1);
}
if (!isPathAllowlisted(relDest)) {
  console.error(`INPUT_UNREACHABLE: dest not allowlisted: ${relDest}`);
  process.exit(1);
}

let tip = 'unknown';
try {
  tip = execSync('git rev-parse HEAD', { encoding: 'utf8' }).trim().slice(0, 12);
} catch {
  /* ok */
}
const dedupKey = createHash('sha256').update(`${from}|${to}|${tip}`).digest('hex').slice(0, 16);
const ledgerPath = resolve(root, 'tmp/wave-stage-dedup.json');
let ledger = { keys: [] };
try {
  if (existsSync(ledgerPath)) ledger = JSON.parse(readFileSync(ledgerPath, 'utf8'));
} catch {
  /* ok */
}
if (!Array.isArray(ledger.keys)) ledger.keys = [];
if (ledger.keys.includes(dedupKey)) {
  console.log(JSON.stringify({ staged: false, dedup_hit: true, dedup_key: dedupKey, from, to: relDest }, null, 2));
  process.exit(0);
}
mkdirSync(dirname(dest), { recursive: true });
copyFileSync(src, dest);
ledger.keys.push(dedupKey);
mkdirSync(dirname(ledgerPath), { recursive: true });
writeFileSync(ledgerPath, JSON.stringify(ledger, null, 2) + '\n');
console.log(JSON.stringify({ staged: true, dedup_key: dedupKey, from, to: relDest }, null, 2));
