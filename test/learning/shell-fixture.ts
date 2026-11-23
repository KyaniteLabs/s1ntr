/**
 * Fixture + harness for the learning shell entrypoint (scripts/learning/post-batch-learn.sh). Everything runs the REAL shell and the
 * REAL scripts; only the LLM-backed `sinter` verbs (generate, dream run/transfer/activate) are stubbed by one wrapper script. The
 * wrapper hands `dream autoseal` and `dream guard` to the real bin/sinter (they are pure code over the fixture stores).
 * The workspace path contains a space on purpose (LEARN_SCAN is a whitespace-separated list, so the scan dir has none).
 */
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isolatedCliEnv } from '../helpers/isolatedCli.js';

export const repoRoot = path.resolve(import.meta.dirname, '../..');
export const SHELL = path.join(repoRoot, 'scripts/learning/post-batch-learn.sh');
export const sha = (text: string): string => createHash('sha256').update(text).digest('hex');
export const RENDERER = 'a'.repeat(64);
export const JUDGE = 'judge-fixture';

export interface Piece { seat: string; piece: string; family: string; score: number; domain?: string }
export interface World {
  root: string; scan: string; prompts: string; piecePrompts: string; state: string; knowledge: string; dreamRoot: string; holdoutFile: string;
  bin: string; calls: string; splits: Record<string, { family: string; split: string }>;
}

export function makeWorld(pieces: readonly Piece[], opts: { stubSuccess?: Record<string, string> } = {}): World {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'learn e2e '));
  const w: World = { root, scan: fs.mkdtempSync(path.join(os.tmpdir(), 'learn-scan-')),  // LEARN_SCAN is a whitespace-separated list, so this one has no space
     prompts: path.join(root, 'prompts.tsv'), piecePrompts: path.join(root, 'piece-prompts.tsv'),
    state: path.join(root, 'state'), knowledge: path.join(root, 'knowledge'), dreamRoot: path.join(root, 'dream root'), holdoutFile: path.join(root, 'holdout.json'),
    bin: path.join(root, 'fake-sinter'), calls: path.join(root, 'calls.jsonl'), splits: {} };
  for (const d of [w.scan, w.knowledge, w.dreamRoot]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(w.holdoutFile, '{}'); fs.writeFileSync(w.calls, '');
  const families = [...new Set(pieces.map(p => p.family))];
  fs.writeFileSync(w.prompts, families.map(f => `q-${f}\tDraw. Subject: ${f}`).join('\n') + '\n');
  fs.writeFileSync(w.piecePrompts, pieces.map(p => `${p.piece}\tDraw. Subject: ${p.family}`).join('\n') + '\n');
  for (const p of pieces) {
    const dir = path.join(w.scan, p.seat, p.piece); const op = `op-${p.piece}`;
    fs.mkdirSync(path.join(dir, 'artifacts', sha(op)), { recursive: true });
    fs.writeFileSync(path.join(dir, 'artifacts', sha(op), 'source.txt'), `<html>${p.piece} ${p.family}</html>`);
    fs.writeFileSync(path.join(dir, 'product-projections.json'), JSON.stringify({ [`ck-${p.piece}`]: { kind: 'create', result: {
      operationId: op, domain: p.domain ?? 'html', lineageId: `lin-${p.piece}`, roles: { generator: p.seat },
      evaluation: { score: p.score, admissionEligible: true, degraded: false, identityValid: true, evaluatorIdentity: JUDGE, failureClass: 'none' },
      evidence: { status: 'rendered', rendererEnvironmentDigest: RENDERER },
      receipt: { artifactDigest: sha(`artifact-${p.piece}`), authorityKeyDigest: 'k'.repeat(64) } } } }));
  }
  // The real splitter decides which families are calibration/test, so tests never re-implement it.
  const sp = path.join(root, 'probe-splits.json');
  spawnSync('python3', [path.join(repoRoot, 'scripts/learning/split-prompts.py'), w.prompts, sp]);
  w.splits = JSON.parse(fs.readFileSync(sp, 'utf8')).prompts;
  const realCli = path.join(repoRoot, 'bin/sinter');
  const stub = (verb: string): string => opts.stubSuccess?.[verb] ?? 'exit 1';
  fs.writeFileSync(w.bin, `#!/usr/bin/env bash
printf '%s\\n' "$*" >> '${w.calls}'
case "$1 $2" in
  "dream autoseal"|"dream guard") exec node '${realCli}' "$@";;
  "dream run") ${stub('dream run')};;
  "dream transfer") ${stub('dream transfer')};;
  "dream activate") ${stub('dream activate')};;
esac
if [ "$1" = generate ]; then
  while [ $# -gt 0 ]; do [ "$1" = -o ] && OUT=$2; shift; done
  mkdir -p "$OUT"
  echo 'Teaching: activated knowledge fixture-snapshot'   # the real CLI prints this when --teach applied a snapshot
  echo '{"k":{"kind":"create","result":{"operationId":"op","evidence":{"status":"rendered"},"evaluation":{"score":0.5,"failureClass":"none"}}}}' > "$OUT/product-projections.json"
  exit 0
fi
exit 0
`, { mode: 0o755 });
  return w;
}

export function shellEnv(w: World, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  // The real bin/sinter runs behind this wrapper: pin HOME/SINTER_CONFIG_PATH and drop provider env so it can never reach the owner's default seat.
  return { ...isolatedCliEnv().env, SINTER_BIN: w.bin, SINTER_LIMINAL_KNOWLEDGE_ROOT: w.knowledge, SINTER_DREAM_HOLDOUT_FILE: w.holdoutFile,
    SINTER_LEARN_JUDGE: JUDGE, LEARN_SCAN: w.scan, LEARN_DREAM_ROOT: w.dreamRoot, LEARN_PROMPTS: w.prompts,
    LEARN_PIECE_PROMPTS: w.piecePrompts, LEARN_STATE_DIR: w.state, LEARN_DEBOUNCE_SECONDS: '0', LEARN_PARALLEL: '1', ...extra };
}

export function runShell(w: World, extra: Record<string, string> = {}, args: string[] = []) {
  return spawnSync('bash', [SHELL, ...args], { env: shellEnv(w, extra), encoding: 'utf8', timeout: 45_000, cwd: w.root });
}

/** Every file under dir -> sha256 of bytes (relative paths); used to prove pre-existing state is byte-for-byte intact. */
export function tree(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string): void => { for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else out[path.relative(dir, p)] = sha(fs.readFileSync(p, 'latin1')); } };
  if (fs.existsSync(dir)) walk(dir);
  return out;
}
export const calls = (w: World): string[] => fs.readFileSync(w.calls, 'utf8').split('\n').filter(Boolean);
export const runDirs = (w: World): string[] => fs.existsSync(w.state) ? fs.readdirSync(w.state).filter(n => n.startsWith('run-')).map(n => path.join(w.state, n)) : [];
