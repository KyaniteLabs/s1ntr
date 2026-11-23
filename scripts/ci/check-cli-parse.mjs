#!/usr/bin/env node
// Fails when a CLI entry file does not parse. bin/sinter is plain JavaScript, so tsc and the organ
// check pass over a syntax error (a dropped `finally` once shipped through a merge that way).
import { execFileSync } from 'node:child_process';
import { readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const binDir = join(root, 'bin');
const files = existsSync(binDir)
  ? readdirSync(binDir).filter(f => f === 'sinter' || /\.(mjs|js)$/.test(f)).sort().map(f => join(binDir, f))
  : [];
let bad = 0;
for (const f of files) {
  try { execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' }); }
  catch (e) { bad += 1; console.error(`${f}: does not parse\n${String(e.stderr ?? e.message).split('\n').slice(0, 6).join('\n')}`); }
}
if (!files.length) { console.error('check:cli-parse: no CLI entry files found under bin/'); process.exit(1); }
if (bad) process.exit(1);
console.log(`CLI entry files parse: ${files.length} checked`);
