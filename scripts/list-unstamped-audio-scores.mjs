#!/usr/bin/env node
/**
 * READ-ONLY. Lists stored audio scores that carry no capture-version stamp
 * (result.evidence.audio.captureVersion absent). A missing stamp identifies
 * candidates for review. The stored bytes alone cannot date the capture.
 *
 * node scripts/list-unstamped-audio-scores.mjs [--domain tone|strudel|all] [--json] [file-or-directory ...]
 */
import { existsSync, readdirSync, readFileSync, statSync, realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const args = process.argv.slice(2);
let domain = 'tone';
let asJson = false;
const targets = [];
for (let i = 0; i < args.length; i += 1) {
  if (args[i] === '--domain') domain = args[++i];
  else if (args[i] === '--json') asJson = true;
  else targets.push(args[i]);
}
if (!['tone', 'strudel', 'all'].includes(domain)) {
  console.error('--domain requires tone, strudel, or all');
  process.exit(2);
}
if (targets.length === 0) targets.push(path.join(process.env.SINTER_LIMINAL_RUNTIME_ROOT ||
  path.join(os.homedir(), '.sinter', 'liminal-runtime'), 'product-projections.json'));

function* findProjections(target, depth = 0) {
  if (!existsSync(target)) return;
  const st = statSync(target);
  if (st.isFile()) { yield target; return; }
  if (depth > 6) return;
  for (const item of readdirSync(target, { withFileTypes: true })) {
    const name = item.name;
    if (name === 'node_modules' || name === '.trash') continue;
    const full = path.join(target, name);
    if (item.isDirectory()) yield* findProjections(full, depth + 1);
    else if (item.isFile() && name === 'product-projections.json') yield full;
  }
}

const rows = [];
const seen = new Set();
let files = 0;
let stamped = 0;
for (const target of targets) {
  for (const file of findProjections(target)) {
    const canonical = realpathSync(file);
    if (seen.has(canonical)) continue;
    seen.add(canonical);
    let data;
    try { data = JSON.parse(readFileSync(file, 'utf8')); } catch (error) {
      console.error(`skip ${file}: ${error.message}`); continue;
    }
    files += 1;
    for (const [key, record] of Object.entries(data)) {
      const result = record?.result;
      const audio = result?.evidence?.audio;
      if (!audio || audio.relevant === false) continue;
      if (domain !== 'all' && result.domain !== domain) continue;
      if (audio.captureVersion !== undefined) { stamped += 1; continue; }
      rows.push({ file, key, domain: result.domain, score: result.evaluation?.score ?? null,
        scoreState: result.evaluation?.scoreState ?? null });
    }
  }
}
if (asJson) console.log(JSON.stringify({ files, stamped, unstamped: rows.length, rows }, null, 2));
else {
  for (const r of rows) console.log(`${r.domain}\tscore=${r.score}\t${r.scoreState ?? '-'}\t${r.key}\t${r.file}`);
  console.log(`# ${rows.length} unstamped ${domain} audio score(s) to review; ${stamped} stamped; ${files} store file(s) read`);
}
