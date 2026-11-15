/**
 * Wave 3A residual suite: tip policy, tipPin, HITL receipts, compound health,
 * Sol adversarial gate, comorbidity battery, feed-forward identity closure.
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildPhase01Ledger,
  buildTipPin,
  shouldGateOnTip,
} from '../../../scripts/rotation/wave3-execution-ledger.mjs';
import {
  authorizePaidCall,
  writeHitlFailureReceipt,
  SPEND_GATE_REFUSALS,
  applySimonMaxUsdConfirm,
  applyTourPinConfirm,
  pinLedgerTipToHead,
} from '../../../scripts/rotation/wave3-spend-gate.mjs';
import { collectCompoundHealth } from '../../../scripts/rotation/wave3-compound-health.mjs';
import { checkSolAdversarialReceipt } from '../../../scripts/rotation/wave3-sol-adversarial-gate.mjs';
import { runComorbidityBattery } from '../../../scripts/rotation/wave3-comorbidity-battery.mjs';
import { resolveBaseUrlCredentials } from '../../../scripts/rotation/cli.mjs';

const TIP = 'a'.repeat(40);
const HEAD = 'b'.repeat(40);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

describe('P0-1 shouldGateOnTip single policy', () => {
  it('phase01-machine is soft-ok on lag', () => {
    const g = shouldGateOnTip('phase01-machine', TIP, HEAD, { isAncestor: () => false });
    expect(g.ok).toBe(true);
    expect(g.soft).toBe(true);
    expect(g.detail).toMatch(/tip_lag/);
  });

  it('seat-spend hard-fails non-ancestor tip', () => {
    const g = shouldGateOnTip('seat-spend', TIP, HEAD, { isAncestor: () => false });
    expect(g.ok).toBe(false);
    expect(g.soft).toBe(false);
    expect(g.detail).toMatch(/tip_stale/);
  });

  it('seat-spend allows ancestor tip', () => {
    const g = shouldGateOnTip('seat-spend', TIP, HEAD, { isAncestor: () => true });
    expect(g.ok).toBe(true);
    expect(g.detail).toBe('tip_ancestor_of_head');
  });

  it('hard-equal requires exact match', () => {
    expect(shouldGateOnTip('hard-equal', TIP, TIP).ok).toBe(true);
    expect(shouldGateOnTip('hard-equal', TIP, HEAD).ok).toBe(false);
  });

  it('authorizePaidCall uses seat-spend tip policy', () => {
    const ledger = buildPhase01Ledger({ tip: TIP });
    ledger.budget.simonConfirmedMaxUsd = true;
    const confirmed = applyTourPinConfirm(ledger, { action: 'confirm-pin' }).ledger!;
    const denied = authorizePaidCall(
      confirmed,
      { role: 'harness', kind: 'live_call', model: 'k3', pipe: 'kilo', usd: 0.01 },
      { head: HEAD, isAncestor: () => false },
    );
    expect(denied.allowed).toBe(false);
    expect(denied.refusals).toContain(SPEND_GATE_REFUSALS.TIP_STALE);

    const allowedTip = authorizePaidCall(
      confirmed,
      { role: 'harness', kind: 'live_call', model: 'k3', pipe: 'kilo', usd: 0.01 },
      { head: HEAD, isAncestor: () => true, repoRoot: root },
    );
    // may still block on model/pipe or other caps; tip alone must not refuse
    expect(allowedTip.refusals).not.toContain(SPEND_GATE_REFUSALS.TIP_STALE);
  });
});

describe('pinLedgerTipToHead (3B preflight)', () => {
  it('advances tip when prior tip is ancestor of head', () => {
    const ledger = buildPhase01Ledger({ tip: TIP });
    ledger.budget.simonConfirmedMaxUsd = true;
    const tour = applyTourPinConfirm(ledger, { action: 'confirm-pin' }).ledger!;
    const head = 'c'.repeat(40);
    const r = pinLedgerTipToHead(tour, {
      head,
      repoRoot: root,
      isAncestor: (tip, h) => tip === TIP && h === head,
    });
    expect(r.ok).toBe(true);
    expect(r.ledger.tip).toBe(head);
    expect(r.ledger.schemaVersion).toBe(2);
    expect(r.ledger.tipPin.sha).toBe(head);
    expect(r.prevTip).toBe(TIP);
  });

  it('rejects pin when prior tip is not ancestor of head', () => {
    const ledger = buildPhase01Ledger({ tip: TIP });
    const head = 'd'.repeat(40);
    const r = pinLedgerTipToHead(ledger, {
      head,
      repoRoot: root,
      isAncestor: () => false,
    });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/tip_not_ancestor_of_head/);
    expect(ledger.tip).toBe(TIP); // unchanged
  });
});

describe('P1-3 branch-aware tipPin', () => {
  it('buildTipPin returns sha + ref shape', () => {
    const pin = buildTipPin({ repoRoot: root, tip: TIP });
    expect(pin.sha).toBe(TIP);
    expect(pin.detached === true || pin.detached === false).toBe(true);
    expect(pin.pinnedAt).toMatch(/^\d{4}-/);
    // on a branch worktree: ref is branch name; detached HEAD: ref null
    if (pin.detached) {
      expect(pin.ref).toBe(null);
    } else {
      expect(pin.ref).toEqual(expect.any(String));
      expect(pin.ref!.length).toBeGreaterThan(0);
    }
  });

  it('buildPhase01Ledger includes schemaVersion 2 + tipPin', () => {
    const ledger = buildPhase01Ledger({ tip: TIP });
    expect(ledger.schemaVersion).toBe(2);
    expect(ledger.tipPin.sha).toBe(TIP);
    expect(ledger.tipPin).toHaveProperty('detached');
  });
});

describe('P1-1 writeHitlFailureReceipt', () => {
  it('appends structured jsonl under hitl-receipts', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hitl-'));
    try {
      const file = writeHitlFailureReceipt(tmp, {
        class: 'hitl_max_usd_mismatch',
        error: 'maxUsd mismatch',
        tip: TIP,
        detail: { expected: 50 },
      });
      expect(fs.existsSync(file)).toBe(true);
      const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
      expect(lines.length).toBe(1);
      const row = JSON.parse(lines[0]!);
      expect(row.schema).toBe('sinter-wave3-hitl-receipt-v1');
      expect(row.class).toBe('hitl_max_usd_mismatch');
      expect(row.tip).toBe(TIP);
      expect(row.error).toBe('maxUsd mismatch');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('redacts secret-like error strings (Terra PR#589)', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hitl-'));
    try {
      const file = writeHitlFailureReceipt(tmp, {
        class: 'hitl_error',
        error: 'Authorization: Bearer sk-secret-value-here',
        tip: TIP,
        detail: { authorization: 'Bearer eyJabc1234567890', ok: true },
      });
      const row = JSON.parse(fs.readFileSync(file, 'utf8').trim());
      expect(String(row.error)).toContain('redacted');
      expect(String(row.error)).not.toContain('sk-secret');
      expect(row.detail.authorization).toBe('[redacted]');
      expect(row.detail.ok).toBe(true);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('P0-2 host-matched credentials', () => {
  it('prefers host-matched donor over wrong-family key', () => {
    const roles = {
      harness: {
        baseUrl: 'http://127.0.0.1:8317/v1',
        apiKey: 'loopback-key',
        provider: 'openai',
      },
      generator: {
        baseUrl: 'https://api.x.ai/v1',
        apiKey: 'xai-key',
        provider: 'openai',
      },
      studio: {},
      evaluator: {},
    };
    const r = resolveBaseUrlCredentials('http://localhost:8317/v1', roles, { role: 'studio' });
    expect(r.patch.apiKey).toBe('loopback-key');
    expect(r.patch.apiKey).not.toBe('xai-key');
  });
});

describe('P3 compound health + Sol adversarial', () => {
  it('collectCompoundHealth returns schema', () => {
    const h = collectCompoundHealth(root);
    expect(h.schema).toBe('sinter-wave3-compound-health-v1');
    expect(h.head).toMatch(/^[0-9a-f]{40}$/);
    expect(h.seatSpendAllowed === true || h.seatSpendAllowed === false).toBe(true);
  });

  it('checkSolAdversarialReceipt reports wave-3 receipt', () => {
    const r = checkSolAdversarialReceipt(root);
    expect(r.lawPresent).toBe(true);
    // receipt exists in this repo
    expect(r.present).toBe(true);
    expect(['APPROVE', 'ITERATE', 'REJECT', 'UNKNOWN']).toContain(r.verdict);
  });
});

describe('P2-1 comorbidity battery', () => {
  it('all hard probes pass on this worktree', () => {
    const report = runComorbidityBattery(root);
    expect(report.schema).toBe('sinter-wave3-comorbidity-battery-v1');
    expect(report.ok).toBe(true);
    expect(report.hardFails).toEqual([]);
    expect(report.probes.length).toBeGreaterThanOrEqual(8);
  });
});

describe('P1-2 feed-forward identity closure E2E (offline)', () => {
  it('pass-A adaptation id survives into pass-B next-brief packet', async () => {
    const ADAPT_ID = 'adapt_w3a_e2e_deadbeef';
    const {
      formatAdaptationGuidanceLine,
      formatLearnedGuidanceSection,
      prependLearnedToDescription,
      identityOracleContainsAdaptationId,
      extractAdaptationId,
    } = await import('../../../src/harness/SelfImproveCompoundLoop.js');

    // Pass A: record adaptation guidance line (as HarnessMemory would mint)
    const line = formatAdaptationGuidanceLine(
      { id: ADAPT_ID, description: 'Persist receipts/*-plan.md on diagnose success' },
      { provenance: 'harness-memory' },
    );
    expect(extractAdaptationId(line)).toBe(ADAPT_ID);

    // Pass B: compose next diagnose brief from learned lines (prepare consumer path)
    const section = formatLearnedGuidanceSection([line]);
    const passB = prependLearnedToDescription(
      'ARCHITECT DIAGNOSE ONLY — compound residual',
      section,
    );

    expect(identityOracleContainsAdaptationId(passB, ADAPT_ID)).toBe(true);
    expect(passB).toContain('[adaptation:adapt_w3a_e2e_deadbeef');
    expect(passB).toContain('ARCHITECT DIAGNOSE ONLY');
    expect(passB).toContain('Persist receipts');

    // Simon confirm path remains independent of feed-forward
    const ledger = buildPhase01Ledger({ tip: TIP });
    const confirmed = applySimonMaxUsdConfirm(ledger, { maxUsd: 50, confirmer: 'simon' });
    expect(confirmed.ok).toBe(true);
  });
});
