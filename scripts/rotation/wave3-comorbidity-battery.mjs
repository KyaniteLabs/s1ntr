/**
 * Wave 3A P2-1 — automated comorbidity probes for residual split-brain / quiet-fail modes.
 * Offline only (no LLM spend). Exit 0 when all probes pass; 1 on any hard fail.
 *
 * Usage: node scripts/rotation/wave3-comorbidity-battery.mjs [--json]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import {
  buildPhase01Ledger,
  computeSeatSpendAllowed,
  shouldGateOnTip,
} from './wave3-execution-ledger.mjs';
import { canonicalizeHost, hostsMatch, classifyEndpoint } from './host-identity.mjs';
import { writeHitlFailureReceipt } from './wave3-spend-gate.mjs';
import { checkSolAdversarialReceipt } from './wave3-sol-adversarial-gate.mjs';
import { collectCompoundHealth } from './wave3-compound-health.mjs';

const PROBES = [];

function probe(id, severity, fn) {
  try {
    const detail = fn();
    PROBES.push({ id, severity, ok: true, detail: detail || 'ok' });
  } catch (e) {
    PROBES.push({ id, severity, ok: false, detail: String(e?.message || e) });
  }
}

export function runComorbidityBattery(repoRoot) {
  PROBES.length = 0;
  const tip = 'a'.repeat(40);
  const head = 'b'.repeat(40);

  // C1: dual tip predicates must not diverge (P0-1)
  probe('C1_tip_policy_single_module', 'hard', () => {
    const soft = shouldGateOnTip('phase01-machine', tip, head, { isAncestor: () => false });
    const hard = shouldGateOnTip('seat-spend', tip, head, { isAncestor: () => false });
    if (!soft.ok || soft.soft !== true) throw new Error('phase01 must be soft-ok on lag');
    if (hard.ok) throw new Error('seat-spend must hard-fail on non-ancestor tip');
    const anc = shouldGateOnTip('seat-spend', tip, head, { isAncestor: () => true });
    if (!anc.ok) throw new Error('seat-spend must allow ancestor tip');
    return 'phase01 soft + seat-spend hard via shouldGateOnTip';
  });

  // C2: host identity aliases + path-injection resistance (P0-2 / Terra)
  probe('C2_host_identity_loopback', 'hard', () => {
    if (!hostsMatch('http://127.0.0.1:8317/v1', 'http://localhost:8317/v1')) {
      throw new Error('127.0.0.1 must match localhost');
    }
    if (canonicalizeHost('https://api.x.ai/v1') !== 'api.x.ai') {
      throw new Error('xai host normalize failed');
    }
    if (classifyEndpoint('http://localhost:8317/v1') !== 'cliproxy') {
      throw new Error('cliproxy classify failed');
    }
    if (hostsMatch('https://api.x.ai/v1', 'http://localhost:8317/v1')) {
      throw new Error('xai must not match cliproxy');
    }
    // Path injection must NOT reclassify as cliproxy/kilo
    if (classifyEndpoint('https://attacker.invalid/127.0.0.1:8317/v1') !== 'unknown') {
      throw new Error('path injection classified as non-unknown');
    }
    if (classifyEndpoint('https://not-kilo.ai.evil/v1') !== 'unknown') {
      throw new Error('lookalike kilo host classified as kilo');
    }
    return 'loopback aliases + family classify + path-injection closed';
  });

  // C3: HITL quiet failure still receipts (P1-1)
  probe('C3_hitl_failure_receipt', 'hard', () => {
    const parent = path.join(repoRoot, '.quality');
    fs.mkdirSync(parent, { recursive: true });
    const tmp = fs.mkdtempSync(path.join(parent, 'tmp-comorbidity-'));
    try {
      const file = writeHitlFailureReceipt(tmp, {
        class: 'hitl_missing_flag',
        error: 'probe',
        tip,
      });
      if (!fs.existsSync(file)) throw new Error('receipt file missing');
      const line = fs.readFileSync(file, 'utf8').trim().split('\n').pop();
      const j = JSON.parse(line);
      if (j.schema !== 'sinter-wave3-hitl-receipt-v1') throw new Error('bad schema');
      if (j.class !== 'hitl_missing_flag') throw new Error('class missing');
      return file;
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  // C4: hand-flipped launch bit cannot open seats
  probe('C4_launch_bit_formula_only', 'hard', () => {
    const ledger = buildPhase01Ledger({ tip });
    ledger.launch.seatSpendAllowed = true; // hostile
    ledger.budget.simonConfirmedMaxUsd = false;
    const launch = computeSeatSpendAllowed(ledger, { head: tip });
    if (launch.seatSpendAllowed) throw new Error('hostile flip opened seats');
    return 'formula rejects hostile launch flip';
  });

  // C5: Sol adversarial receipt surface exists (warn if missing, hard only on law missing)
  probe('C5_sol_adversarial_surface', 'soft', () => {
    const r = checkSolAdversarialReceipt(repoRoot);
    if (!r.lawPresent) throw new Error('pre-wave Sol law missing');
    return r.present ? `receipt present verdict=${r.verdict}` : 'receipt missing (warn-mode ok)';
  });

  // C6: compound health collector runs
  probe('C6_compound_health_collects', 'hard', () => {
    const h = collectCompoundHealth(repoRoot);
    if (h.schema !== 'sinter-wave3-compound-health-v1') throw new Error('bad health schema');
    if (!h.head) throw new Error('no HEAD');
    return `ledgerPresent=${h.ledgerPresent} seatSpend=${h.seatSpendAllowed}`;
  });

  // C7: feed-forward source surface present (identity tag API)
  probe('C7_feed_forward_source_surface', 'hard', () => {
    const p = path.join(repoRoot, 'src/harness/SelfImproveCompoundLoop.ts');
    if (!fs.existsSync(p)) throw new Error('SelfImproveCompoundLoop missing');
    const body = fs.readFileSync(p, 'utf8');
    for (const needle of [
      'formatAdaptationGuidanceLine',
      'identityOracleContainsAdaptationId',
      '[adaptation:',
      'withLearnedGuidance',
    ]) {
      if (!body.includes(needle)) throw new Error(`missing ${needle}`);
    }
    return 'adaptation id inject surface present';
  });

  // C8: freeze wave3 evaluator is GeminiPro after A/B
  probe('C8_wave3_evaluator_gemini_pro', 'hard', () => {
    const freezePath = path.join(repoRoot, 'docs/agents/waves/tour-seat-live-freeze.json');
    const freeze = JSON.parse(fs.readFileSync(freezePath, 'utf8'));
    if (freeze.wave3?.evaluator !== 'GeminiPro') {
      throw new Error(`expected GeminiPro got ${freeze.wave3?.evaluator}`);
    }
    return 'wave3.evaluator=GeminiPro';
  });

  const hardFails = PROBES.filter((p) => !p.ok && p.severity === 'hard');
  const softFails = PROBES.filter((p) => !p.ok && p.severity === 'soft');
  return {
    schema: 'sinter-wave3-comorbidity-battery-v1',
    ts: new Date().toISOString(),
    ok: hardFails.length === 0,
    hardFails: hardFails.map((p) => p.id),
    softFails: softFails.map((p) => p.id),
    probes: [...PROBES],
  };
}

export function main(argv = process.argv.slice(2)) {
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const repoRoot = path.resolve(__dirname, '../..');
  const report = runComorbidityBattery(repoRoot);
  if (argv.includes('--json') || !process.stdout.isTTY) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log('Wave 3A comorbidity battery');
    for (const p of report.probes) {
      console.log(`  ${p.ok ? 'PASS' : 'FAIL'} [${p.severity}] ${p.id}: ${p.detail}`);
    }
    console.log(report.ok ? 'OK' : `HARD FAIL: ${report.hardFails.join(', ')}`);
  }
  // Optional write under .quality
  const outDir = path.join(repoRoot, '.quality', 'tour', 'wave-3');
  try {
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(
      path.join(outDir, 'comorbidity-battery-latest.json'),
      `${JSON.stringify(report, null, 2)}\n`,
      'utf8',
    );
  } catch {
    /* non-fatal */
  }
  return report.ok ? 0 : 1;
}

const isMain = process.argv[1] && (
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
  || process.argv[1].endsWith('wave3-comorbidity-battery.mjs')
);
if (isMain) process.exit(main());
