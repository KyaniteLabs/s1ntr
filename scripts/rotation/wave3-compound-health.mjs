/**
 * Operator compound-loop health one-pager (Wave 3A P3-2).
 *
 * Usage: node scripts/rotation/wave3-compound-health.mjs [--json]
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  computeSeatSpendAllowed,
  defaultLedgerPath,
  loadLedger,
  shouldGateOnTip,
  validateLedgerSchema,
} from './wave3-execution-ledger.mjs';

export function collectCompoundHealth(repoRoot) {
  const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' });
  const headSha = head.status === 0 ? head.stdout.trim() : '';
  const ledgerPath = defaultLedgerPath(repoRoot);
  const health = {
    schema: 'sinter-wave3-compound-health-v1',
    ts: new Date().toISOString(),
    head: headSha,
    ledgerPresent: fs.existsSync(ledgerPath),
    schemaOk: false,
    seatSpendAllowed: false,
    tipGate: null,
    simonConfirmed: false,
    tipPin: null,
    hitlReceiptCountToday: 0,
    adaptationInjectSurface: false,
    solAdversarialReceipt: null,
    notes: [],
  };

  if (health.ledgerPresent) {
    try {
      const ledger = loadLedger(ledgerPath);
      const schema = validateLedgerSchema(ledger, { head: headSha });
      const launch = computeSeatSpendAllowed(ledger, { head: headSha, repoRoot });
      health.schemaOk = schema.ok;
      health.seatSpendAllowed = launch.seatSpendAllowed;
      health.simonConfirmed = Boolean(ledger.budget?.simonConfirmedMaxUsd);
      health.tipPin = ledger.tipPin || { sha: ledger.tip, ref: null, detached: null };
      health.tipGate = shouldGateOnTip('seat-spend', ledger.tip, headSha, { repoRoot });
      health.launchReasons = launch.reasons;
    } catch (e) {
      health.notes.push(`ledger_error:${e}`);
    }
  }

  const hitlDir = path.join(repoRoot, '.quality', 'tour', 'wave-3', 'hitl-receipts');
  const day = new Date().toISOString().slice(0, 10);
  const hitlFile = path.join(hitlDir, `${day}.jsonl`);
  if (fs.existsSync(hitlFile)) {
    health.hitlReceiptCountToday = fs.readFileSync(hitlFile, 'utf8').split('\n').filter(Boolean).length;
  }

  const compoundSrc = path.join(repoRoot, 'src/harness/SelfImproveCompoundLoop.ts');
  if (fs.existsSync(compoundSrc)) {
    const body = fs.readFileSync(compoundSrc, 'utf8');
    health.adaptationInjectSurface = body.includes('formatAdaptationGuidanceLine') || body.includes('[adaptation:');
  }

  const solPath = path.join(repoRoot, 'docs/agents/waves/wave-3-SOL-adversarial-review.md');
  health.solAdversarialReceipt = fs.existsSync(solPath)
    ? { present: true, path: 'docs/agents/waves/wave-3-SOL-adversarial-review.md' }
    : { present: false, path: null };

  return health;
}

export function main(argv = process.argv.slice(2)) {
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const repoRoot = path.resolve(__dirname, '../..');
  const health = collectCompoundHealth(repoRoot);
  if (argv.includes('--json') || !process.stdout.isTTY) {
    console.log(JSON.stringify(health, null, 2));
  } else {
    console.log('Wave 3 compound health');
    console.log(`  head: ${health.head.slice(0, 12)}`);
    console.log(`  ledger: ${health.ledgerPresent ? 'yes' : 'NO'} schemaOk=${health.schemaOk}`);
    console.log(`  tipGate: ${health.tipGate?.detail || 'n/a'}`);
    console.log(`  seatSpendAllowed: ${health.seatSpendAllowed}`);
    console.log(`  simonConfirmed: ${health.simonConfirmed}`);
    console.log(`  tipPin: ${JSON.stringify(health.tipPin)}`);
    console.log(`  hitlReceiptsToday: ${health.hitlReceiptCountToday}`);
    console.log(`  adaptationInject: ${health.adaptationInjectSurface}`);
    console.log(`  solAdversarial: ${health.solAdversarialReceipt?.present}`);
  }
  return health.ledgerPresent && health.schemaOk ? 0 : 1;
}

const isMain = process.argv[1] && (
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
  || process.argv[1].endsWith('wave3-compound-health.mjs')
);
if (isMain) process.exit(main());
