/**
 * Loads golden-suite candidates from a directory: one file per case, named `<caseId>` plus any extension
 * (`case-1.html`, `case-1.glsl`). The runner refuses to judge a placeholder, so `quality run|gate` needs real saved
 * output for every case (Sol audit F05).
 */
import fs from 'node:fs';
import path from 'node:path';
import type { EvaluationCandidate, GoldenSuite } from '../evaluation/types.js';

export function loadGoldenCandidates(suite: GoldenSuite, dir: string): Map<string, EvaluationCandidate> {
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
    throw new Error(`GOLDEN_CANDIDATES_DIR_MISSING: ${dir} is not a directory`);
  }
  const files = fs.readdirSync(dir).sort();
  const out = new Map<string, EvaluationCandidate>();
  const missing: string[] = [];
  for (const c of suite.cases) {
    const file = files.find(f => f === c.id || path.parse(f).name === c.id);
    if (!file) { missing.push(c.id); continue; }
    const code = fs.readFileSync(path.join(dir, file), 'utf8');
    if (!code.trim()) { missing.push(`${c.id} (empty file ${file})`); continue; }
    out.set(c.id, { code, prompt: c.prompt, domain: c.domain, metadata: { goldenCaseId: c.id, source: path.join(dir, file) } });
  }
  if (missing.length) throw new Error(`GOLDEN_CANDIDATES_MISSING: no saved candidate for case(s): ${missing.join(', ')}`);
  return out;
}
