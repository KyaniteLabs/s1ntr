/**
 * Wave 3 Phase 0–1 aggregate machine gate.
 *
 * Exits 0 when Phase 0–1 machinery is schema-valid at HEAD (suite landable).
 * Does NOT imply seatSpendAllowed — that also needs Simon HITL (#585).
 *
 * Usage: node scripts/rotation/wave3-phase01-gate.mjs
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

const REQUIRED_MODULES = [
  'scripts/rotation/wave3-execution-ledger.mjs',
  'scripts/rotation/wave3-spend-gate.mjs',
  'scripts/rotation/wave3-phase01-gate.mjs',
  'docs/agents/waves/wave-3-execution-state.json',
];

export function evaluatePhase01Gate(repoRoot, opts = {}) {
  const checks = [];
  const head = opts.head ?? spawnHead(repoRoot);

  for (const rel of REQUIRED_MODULES) {
    const p = path.join(repoRoot, rel);
    checks.push({
      id: `module:${rel}`,
      ok: fs.existsSync(p),
      detail: fs.existsSync(p) ? 'present' : 'missing',
    });
  }

  const ledgerPath = defaultLedgerPath(repoRoot);
  let ledger = null;
  if (fs.existsSync(ledgerPath)) {
    try {
      ledger = loadLedger(ledgerPath);
      checks.push({ id: 'ledger_parse', ok: true, detail: 'ok' });
    } catch (e) {
      checks.push({ id: 'ledger_parse', ok: false, detail: String(e) });
    }
  }

  let schema = { ok: false, errors: ['no_ledger'] };
  let launch = { seatSpendAllowed: false, reasons: ['no_ledger'] };
  if (ledger) {
    schema = validateLedgerSchema(ledger, { head });
    launch = computeSeatSpendAllowed(ledger, { head });
    checks.push({
      id: 'ledger_schema',
      ok: schema.ok,
      detail: schema.ok ? 'valid' : schema.errors.slice(0, 8).join('; '),
    });
    // Single tip policy (P0-1): phase01-machine is soft; seat-spend is hard via launch bit.
    const tipGate = shouldGateOnTip('phase01-machine', ledger.tip, head, { repoRoot });
    checks.push({
      id: 'tip_matches_head',
      ok: tipGate.ok,
      soft: tipGate.soft,
      detail: tipGate.detail,
    });
    // Phase01 machinery green ≠ seats open
    checks.push({
      id: 'seat_spend_blocked_until_hitl',
      ok: !launch.seatSpendAllowed || Boolean(ledger.budget?.simonConfirmedMaxUsd),
      detail: launch.seatSpendAllowed
        ? 'seatSpendAllowed=true (HITL+machine green)'
        : `seatSpendAllowed=false reasons=${(launch.reasons || []).slice(0, 5).join(',')}`,
    });
  }

  // Dual-bit retirement: ready.json may exist but must not be sole authority.
  // Soft when dual-true but launch false (tip lag on shallow CI, post-merge HEAD move).
  // Phase01 machine green = modules + schema + inject surface — not live launch bit.
  const readyPath = path.join(repoRoot, 'docs/agents/waves/wave-3-ready.json');
  if (fs.existsSync(readyPath)) {
    try {
      const ready = JSON.parse(fs.readFileSync(readyPath, 'utf8'));
      const dual = ready.wave3Allowed === true && ready.wave3SeatSpendAllowed === true;
      const dualOk = !dual || launch.seatSpendAllowed === true;
      checks.push({
        id: 'no_dual_true_without_ledger',
        ok: dualOk,
        soft: !dualOk, // dual drift is operator SoT honesty, not phase01 module land fail
        detail: dualOk
          ? (dual ? 'ready dual true matches ledger launch' : 'ready dual not both true (ok)')
          : `ready dual true but launch=false reasons=${(launch.reasons || []).slice(0, 4).join(',')}`,
      });
    } catch (e) {
      checks.push({ id: 'ready_json_parse', ok: false, detail: String(e) });
    }
  }

  // Identity inject surface exists in compound loop source
  const compoundSrc = path.join(repoRoot, 'src/harness/SelfImproveCompoundLoop.ts');
  if (fs.existsSync(compoundSrc)) {
    const body = fs.readFileSync(compoundSrc, 'utf8');
    const hasTag = body.includes('[adaptation:') || body.includes('formatAdaptationGuidanceLine');
    checks.push({
      id: 'adaptation_id_inject_surface',
      ok: hasTag,
      detail: hasTag ? 'formatAdaptationGuidanceLine / [adaptation:] present' : 'missing inject',
    });
  }

  const hardFail = checks.filter((c) => !c.ok && !c.soft);
  return {
    ok: hardFail.length === 0,
    head,
    schemaOk: schema.ok,
    seatSpendAllowed: launch.seatSpendAllowed,
    launchReasons: launch.reasons || [],
    checks,
    hardFailIds: hardFail.map((c) => c.id),
    note: 'Phase 0–1 machine green does not open seats without Simon maxUsd + launch formula.',
  };
}

function spawnHead(repoRoot) {
  const r = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : '';
}

export function main() {
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const repoRoot = path.resolve(__dirname, '../..');
  const result = evaluatePhase01Gate(repoRoot);
  console.log(JSON.stringify(result, null, 2));
  return result.ok ? 0 : 1;
}

const isMain = process.argv[1] && (
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
  || process.argv[1].endsWith('wave3-phase01-gate.mjs')
);
if (isMain) {
  process.exit(main());
}
