/**
 * Wave-gate Sol adversarial review check (Wave 3A P2-2).
 * Default: warn mode (exit 0 with warning). --enforce fails loud if receipt missing.
 *
 * Usage:
 *   node scripts/rotation/wave3-sol-adversarial-gate.mjs
 *   node scripts/rotation/wave3-sol-adversarial-gate.mjs --enforce
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RECEIPT = 'docs/agents/waves/wave-3-SOL-adversarial-review.md';
const LAW = 'docs/agent-law/pre-wave-sol-adversarial-review.md';

export function checkSolAdversarialReceipt(repoRoot) {
  const receiptPath = path.join(repoRoot, RECEIPT);
  const lawPath = path.join(repoRoot, LAW);
  const present = fs.existsSync(receiptPath);
  let verdict = null;
  let bodySnippet = '';
  if (present) {
    const body = fs.readFileSync(receiptPath, 'utf8');
    bodySnippet = body.slice(0, 200);
    const m = body.match(/VERDICT\s*[=:]\s*(APPROVE|ITERATE|REJECT)/i)
      || body.match(/\b(APPROVE|ITERATE|REJECT)\b/);
    verdict = m ? m[1].toUpperCase() : 'UNKNOWN';
  }
  return {
    ok: present,
    present,
    path: RECEIPT,
    lawPresent: fs.existsSync(lawPath),
    verdict,
    bodySnippet,
  };
}

export function main(argv = process.argv.slice(2)) {
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const repoRoot = path.resolve(__dirname, '../..');
  const enforce = argv.includes('--enforce');
  const r = checkSolAdversarialReceipt(repoRoot);
  const out = {
    schema: 'sinter-wave3-sol-adversarial-gate-v1',
    mode: enforce ? 'enforce' : 'warn',
    ...r,
  };
  // Presence-only gate: verdict quality (APPROVE/ITERATE/REJECT) is operator-owned.
  // --enforce fails only when the receipt file is missing, not on ITERATE.
  out.note = 'enforce=presence-only; ITERATE/REJECT not auto-blocking';
  console.log(JSON.stringify(out, null, 2));
  if (!r.present) {
    if (enforce) {
      console.error(`[wave3-sol-adversarial-gate] ENFORCE FAIL: missing ${RECEIPT}`);
      return 1;
    }
    console.error(`[wave3-sol-adversarial-gate] WARN: missing ${RECEIPT} (warn-mode; not blocking)`);
    return 0;
  }
  return 0;
}

const isMain = process.argv[1] && (
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
  || process.argv[1].endsWith('wave3-sol-adversarial-gate.mjs')
);
if (isMain) process.exit(main());
