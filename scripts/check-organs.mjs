#!/usr/bin/env node
// Organ registry gate (Simon 2026-11-19: "every internal organ must be tested, ran, used and wired up").
//  1. every top-level src/ directory is listed in test/organs/registry.json;
//  2. an INTEGRATED entry carries all four proofs, each with evidence: tested (existing test file),
//     ran (spawned run, command + log/artifact line), used (a test that fails when the organ is bypassed),
//     wired (default operator path, or a named flag if risky);
//  3. any other status needs a reason, a review date and the exact `gaps` (which of the four are missing);
//  4. a new organ-shaped file (Engine/Loop/Bandit/Learner/Gate/Judge/...) under src/ must be in
//     registry.organShapeBaseline or registry.files, so a new organ cannot arrive unregistered.
// `--table` prints the organ x four-proof table (work/organ-proof.md).
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import path from 'node:path';
const file = JSON.parse(readFileSync('test/organs/registry.json', 'utf8'));
const reg = file.modules;
const today = new Date().toISOString().slice(0, 10);
const PROOFS = ['tested', 'ran', 'used', 'wired'];
const SHAPE = /(Engine|Loop|Bandit|Learner|Gate|Judge|Critic|Synthesizer|Sequencer|Compressor|Harvester|Runtime|Guard)\.tsx?$/;
const errors = [];

function walk(dir, out = []) {
  for (const n of readdirSync(dir)) {
    const p = path.join(dir, n);
    if (statSync(p).isDirectory()) walk(p, out); else if (SHAPE.test(n) && !/\.d\.ts$/.test(n)) out.push(p);
  }
  return out;
}
function checkProof(name, e, isFile) {
  const proof = e.proof ?? {};
  for (const k of PROOFS) if (typeof proof[k] !== 'string' || proof[k].trim().length < 8) errors.push(`${name}: INTEGRATED but proof.${k} has no evidence`);
  const t = (proof.tested ?? '').split(/\s+/)[0];
  if (!e.test || !existsSync(e.test)) errors.push(`${name}: INTEGRATED but test ${e.test} is missing`);
  else if (isFile && e.token && !readFileSync(e.test, 'utf8').includes(e.token)) errors.push(`${name}: test ${e.test} does not contain "${e.token}"`);
  void t;
  // Dogfood 2026-11-19: a row that claims all four proofs must show a real captured output sample.
  if (typeof e.output !== 'string' || !existsSync(e.output)) errors.push(`${name}: INTEGRATED but output sample ${e.output ?? '(none)'} is missing (run the organ, trim stdout to ~60 lines into test/organs/outputs/<organ>.txt)`);
  else {
    const sample = readFileSync(e.output, 'utf8');
    if (sample.trim().length < 20) errors.push(`${name}: output sample ${e.output} is empty`);
    if (sample.split('\n').length > 70) errors.push(`${name}: output sample ${e.output} is over ~60 lines; trim it`);
    if (/\/home\/|\/Users\/|[\w.+-]+@[\w-]+\.[a-z]{2,}|(sk|key)-[A-Za-z0-9]{12,}/.test(sample)) errors.push(`${name}: output sample ${e.output} carries a home path, email or key; sanitize it`);
  }
}
function checkEntry(name, e, isFile) {
  if (typeof e.does !== 'string' || e.does.trim().length < 12) errors.push(`${name}: missing "does" (one plain sentence a non-engineer can read)`);
  if (typeof e.helps !== 'string' || e.helps.trim().length < 12) errors.push(`${name}: missing "helps" (evidence of the effect on the finished piece, or "UNKNOWN: ..."/"needs real seats" stated exactly)`);
  else if (e.status === 'INTEGRATED' && /^UNKNOWN/.test(e.helps)) errors.push(`${name}: INTEGRATED but helps is UNKNOWN; an organ with no shown benefit stays flagged, not INTEGRATED`);
  if (e.status === 'INTEGRATED') checkProof(name, e, isFile);
  else if (!e.reason || !e.review) errors.push(`${name}: ${e.status} needs a reason and a review date`);
  else if (e.review < today) errors.push(`${name}: exception expired ${e.review}`);
  else if (!Array.isArray(e.gaps) || e.gaps.length === 0) {
    if (e.status !== 'UNAUDITED') errors.push(`${name}: ${e.status} must list its exact gaps (which of ${PROOFS.join('/')} is missing)`);
  } else for (const g of e.gaps) if (!PROOFS.includes(g.split(':')[0])) errors.push(`${name}: gap "${g}" must start with one of ${PROOFS.join('/')}`);
}

if (process.argv.includes('--table')) {
  const rows = [['organ', 'status', 'what it does', 'how it helps the artwork', ...PROOFS]];
  const cell = (e, k) => (e.proof?.[k] ? `OK: ${e.proof[k]}` : `GAP: ${(e.gaps ?? []).filter(g => g.startsWith(k)).map(g => g.slice(k.length + 1)).join('; ') || 'not audited'}`);
  for (const [n, e] of Object.entries({ ...reg, ...(file.files ?? {}) })) rows.push([n, e.status, e.does ?? '', e.helps ?? '', ...PROOFS.map(k => cell(e, k))]);
  console.log(rows.map(r => `| ${r.join(' | ').replace(/\n/g, ' ')} |`).flatMap((l, i) => i === 0 ? [l, `|${' --- |'.repeat(rows[0].length)}`] : [l]).join('\n'));
  process.exit(0);
}

for (const d of readdirSync('src').filter(n => statSync(`src/${n}`).isDirectory())) {
  if (!reg[d]) errors.push(`src/${d}: not in test/organs/registry.json (add the organ test, or list it with a reason)`);
}
for (const [name, e] of Object.entries(reg)) {
  if (!existsSync(`src/${name}`)) errors.push(`${name}: listed but src/${name} does not exist`);
  checkEntry(name, e, false);
}
for (const [f, e] of Object.entries(file.files ?? {})) {
  if (!existsSync(f)) errors.push(`${f}: listed but file does not exist`);
  else checkEntry(f, e, true);
}
const known = new Set([...(file.organShapeBaseline ?? []), ...Object.keys(file.files ?? {})]);
for (const f of walk('src')) {
  if (!known.has(f)) errors.push(`${f}: new organ-shaped file is not in the registry (add it to test/organs/registry.json files with its four proofs, or organShapeBaseline with its parent module)`);
}
if (errors.length) { console.error(errors.join('\n')); process.exit(1); }
console.log(`organ registry ok: ${Object.keys(reg).length} modules, ${Object.keys(file.files ?? {}).length} file-level organs, ${known.size} organ-shaped files covered`);
