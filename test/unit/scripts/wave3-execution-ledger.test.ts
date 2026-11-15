/**
 * Wave 3 execution ledger + spend gate (Phase 0–1 #580–#582).
 */
import { describe, expect, it } from 'vitest';
import {
  G_DISPOSITION_ALLOW,
  REQUIRED_ROW_IDS,
  buildPhase01Ledger,
  computeBlocksSpend,
  computeDebitHash,
  computeSeatSpendAllowed,
  GENESIS_PREV_HASH,
  validateDebitChain,
  validateGDisposition,
  validateLedgerSchema,
  validateDispositionFields,
} from '../../../scripts/rotation/wave3-execution-ledger.mjs';
import {
  authorizePaidCall,
  applySimonMaxUsdConfirm,
  applyTourPinConfirm,
  checkStructuralCaps,
  finalizeDebit,
  reserveDebit,
  SPEND_GATE_REFUSALS,
} from '../../../scripts/rotation/wave3-spend-gate.mjs';
import { evaluatePhase01Gate } from '../../../scripts/rotation/wave3-phase01-gate.mjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TIP = 'a'.repeat(40);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

function baseLedger(overrides: Record<string, unknown> = {}) {
  const ledger = buildPhase01Ledger({ tip: TIP, evidenceCommit: TIP });
  return { ...ledger, ...overrides, budget: { ...ledger.budget, ...(overrides.budget as object || {}) } };
}

describe('wave3-execution-ledger schema (#580)', () => {
  it('buildPhase01Ledger includes all required row ids', () => {
    const ledger = buildPhase01Ledger({ tip: TIP });
    for (const id of REQUIRED_ROW_IDS) {
      expect(ledger.rows[id], id).toMatchObject({ id });
      expect(ledger.rows[id].id).toBe(id);
    }
    expect(ledger.schema).toBe('sinter-wave3-execution-state-v1');
    expect(ledger.budget.simonConfirmedMaxUsd).toBe(false);
    expect(ledger.launch.seatSpendAllowed).toBe(false);
  });

  it('rejects invalid G disposition combinations', () => {
    expect(validateGDisposition({ id: 'G1', disposition: 'applied' })).toEqual([
      'invalid_g_disposition:G1:applied',
    ]);
    expect(validateGDisposition({ id: 'G1', disposition: 'verified-applied' })).toEqual([]);
    expect(validateGDisposition({ id: 'G2', disposition: 'applied' })).toEqual([
      'invalid_g_disposition:G2:applied',
    ]);
    expect(validateGDisposition({ id: 'G7', disposition: 'applied-as-grilled-dossier-only' })).toEqual([]);
    expect(G_DISPOSITION_ALLOW.G11).toContain('owner-deferred-with-expiry');
  });

  it('requires evidence / expiresAt / commit for dispositions', () => {
    expect(validateDispositionFields({ disposition: 'applied', evidence: [] })).toContain('evidence_required');
    expect(validateDispositionFields({ disposition: 'applied', evidence: ['x'] })).toContain('commit_required');
    expect(
      validateDispositionFields({
        disposition: 'owner-deferred-with-expiry',
        owner: 'simon',
        expiresAt: '2026-08-01T00:00:00.000Z',
      }),
    ).toEqual([]);
    expect(
      validateDispositionFields({ disposition: 'owner-deferred-with-expiry', owner: 'simon' }),
    ).toContain('expiresAt_required');
  });

  it('blocksSpend on phase01 incomplete and invalid G', () => {
    const incomplete = computeBlocksSpend({
      id: 'gate.preflight',
      state: 'absent',
      disposition: 'pending',
      requiredForPhase01: true,
    });
    expect(incomplete.blocksSpend).toBe(true);
    expect(incomplete.reasons).toContain('phase01_incomplete');

    const badG = computeBlocksSpend({
      id: 'G1',
      state: 'verified-offline',
      disposition: 'applied',
      evidence: ['x'],
      implementedCommit: TIP,
    });
    expect(badG.blocksSpend).toBe(true);
    expect(badG.reasons.some((r) => r.includes('invalid_g_disposition'))).toBe(true);
  });

  it('validateLedgerSchema accepts phase01 starter at tip', () => {
    const ledger = buildPhase01Ledger({ tip: TIP });
    const r = validateLedgerSchema(ledger, { head: TIP });
    expect(r.ok).toBe(true);
    expect(r.errors).toEqual([]);
  });
});

describe('wave3 launch bit (#581)', () => {
  it('seatSpendAllowed false when tip is not HEAD and not an ancestor', () => {
    const ledger = baseLedger();
    // Simon confirm alone is not enough with unrelated tip
    ledger.budget.simonConfirmedMaxUsd = true;
    const launch = computeSeatSpendAllowed(ledger, {
      head: 'b'.repeat(40),
      isAncestor: () => false,
    });
    expect(launch.seatSpendAllowed).toBe(false);
    expect(launch.reasons.some((r) => r.startsWith('tip_stale'))).toBe(true);
  });

  it('seatSpendAllowed true when tip is git ancestor of HEAD (post tip-pin)', () => {
    const ledger = baseLedger();
    ledger.budget.simonConfirmedMaxUsd = true;
    const tour = applyTourPinConfirm(ledger, { action: 'confirm-pin' });
    const launch = computeSeatSpendAllowed(tour.ledger!, {
      head: 'b'.repeat(40),
      isAncestor: (tip, head) => tip === TIP && head === 'b'.repeat(40),
    });
    expect(launch.seatSpendAllowed).toBe(true);
    expect(launch.tipAuthorized).toBe(true);
  });

  it('seatSpendAllowed false when simonConfirmedMaxUsd false even if tip matches', () => {
    const ledger = baseLedger();
    const launch = computeSeatSpendAllowed(ledger, { head: TIP });
    expect(launch.seatSpendAllowed).toBe(false);
    expect(launch.reasons).toContain('simon_max_usd_unconfirmed');
  });

  it('seatSpendAllowed true only when tip matches + Simon confirm + phase01 green + debit ok', () => {
    const ledger = baseLedger();
    ledger.budget.simonConfirmedMaxUsd = true;
    // Confirm tour pin fully (applied) — deferred also ok for phase01, but clear path:
    const tour = applyTourPinConfirm(ledger, { action: 'confirm-pin' });
    expect(tour.ok).toBe(true);
    const launch = computeSeatSpendAllowed(tour.ledger!, { head: TIP });
    expect(launch.seatSpendAllowed).toBe(true);
    expect(launch.reasons).toEqual([]);
  });

  it('ignores hand-flipped launch.seatSpendAllowed when formula says false (adversarial)', () => {
    const ledger = baseLedger();
    ledger.launch.seatSpendAllowed = true; // hostile edit
    ledger.budget.simonConfirmedMaxUsd = false;
    const launch = computeSeatSpendAllowed(ledger, { head: TIP });
    expect(launch.seatSpendAllowed).toBe(false);
    expect(launch.reasons).toContain('simon_max_usd_unconfirmed');
  });

  it('seatSpendAllowed false when phase01Required row still absent', () => {
    const ledger = baseLedger();
    ledger.budget.simonConfirmedMaxUsd = true;
    ledger.rows['gate.preflight'] = {
      id: 'gate.preflight',
      state: 'absent',
      disposition: 'pending',
      requiredForPhase01: true,
      evidence: [],
    };
    const launch = computeSeatSpendAllowed(ledger, { head: TIP });
    expect(launch.seatSpendAllowed).toBe(false);
    expect(launch.reasons.some((r) => r.includes('phase01_incomplete'))).toBe(true);
  });
});

describe('wave3 debit chain + spend gate (#582)', () => {
  function mkDebit(partial: Record<string, unknown>, prevHash = GENESIS_PREV_HASH) {
    const body = {
      id: partial.id as string,
      ts: '2026-07-29T12:00:00.000Z',
      phase: '3',
      role: (partial.role as string) || 'harness',
      kind: (partial.kind as string) || 'live_call',
      model: (partial.model as string) || 'moonshotai/kimi-k3',
      pipe: (partial.pipe as string) || 'kilo',
      inputTokens: (partial.inputTokens as number) ?? 10,
      outputTokens: (partial.outputTokens as number) ?? 5,
      usd: (partial.usd as number) ?? 0.01,
      wallMs: (partial.wallMs as number) ?? 1000,
      status: (partial.status as string) || 'settled',
      infraClass: partial.infraClass ?? null,
      qualityLabeledAsInfra: partial.qualityLabeledAsInfra ?? false,
      prContractFailId: partial.prContractFailId ?? null,
    };
    const hash = computeDebitHash(body, prevHash);
    return { ...body, prevHash, hash };
  }

  it('rejects tampered / reordered / duplicate debit hashes', () => {
    const d1 = mkDebit({ id: 'debit_1' });
    const d2 = mkDebit({ id: 'debit_2', role: 'generator' }, d1.hash);
    expect(validateDebitChain([d1, d2]).ok).toBe(true);

    const tampered = { ...d2, usd: 99, hash: d2.hash };
    expect(validateDebitChain([d1, tampered]).ok).toBe(false);

    // reorder
    expect(validateDebitChain([d2, d1]).ok).toBe(false);

    // duplicate id
    const dup = mkDebit({ id: 'debit_1', role: 'chat' }, d1.hash);
    expect(validateDebitChain([d1, dup]).errors.some((e) => e.includes('duplicate'))).toBe(true);
  });

  it('refuses second K3 / second same-role / second infra before provider', () => {
    const d1 = mkDebit({ id: 'debit_1', role: 'k3', kind: 'live_call' });
    expect(checkStructuralCaps([d1], { role: 'k3', kind: 'live_call' })).toContain(
      SPEND_GATE_REFUSALS.CAP_K3,
    );
    expect(checkStructuralCaps([d1], { role: 'generator', kind: 'live_call' })).toEqual([]);
    const gen = mkDebit({ id: 'debit_2', role: 'generator' }, d1.hash);
    expect(checkStructuralCaps([d1, gen], { role: 'generator', kind: 'live_call' })).toContain(
      SPEND_GATE_REFUSALS.CAP_ROLE,
    );

    const infra = mkDebit({
      id: 'debit_infra',
      role: 'other',
      kind: 'infra_retry',
      infraClass: 'http_5xx',
    });
    expect(
      checkStructuralCaps([infra], {
        role: 'other',
        kind: 'infra_retry',
        infraClass: 'http_5xx',
      }),
    ).toContain(SPEND_GATE_REFUSALS.CAP_INFRA);
  });

  it('quality failure cannot mint infra_retry', () => {
    expect(
      checkStructuralCaps([], {
        role: 'other',
        kind: 'infra_retry',
        infraClass: 'http_5xx',
        qualityLabeledAsInfra: true,
      }),
    ).toContain(SPEND_GATE_REFUSALS.QUALITY_AS_INFRA);
  });

  it('authorizePaidCall refuses when seats blocked (Simon unconfirmed)', () => {
    const ledger = baseLedger();
    const auth = authorizePaidCall(
      ledger,
      { role: 'harness', kind: 'live_call', model: 'k3', pipe: 'kilo', usd: 0.1 },
      { head: TIP },
    );
    expect(auth.allowed).toBe(false);
    expect(auth.refuseBeforeProvider).toBe(true);
    expect(auth.refusals).toContain(SPEND_GATE_REFUSALS.LAUNCH_BLOCKED);
    expect(auth.refusals).toContain(SPEND_GATE_REFUSALS.SIMON_UNCONFIRMED);
  });

  it('authorizePaidCall refuses budget exhaustion before provider', () => {
    const ledger = baseLedger();
    ledger.budget.simonConfirmedMaxUsd = true;
    const confirmed = applyTourPinConfirm(ledger, { action: 'confirm-pin' }).ledger!;
    const auth = authorizePaidCall(
      confirmed,
      {
        role: 'generator',
        kind: 'live_call',
        model: 'grok-4.5',
        pipe: 'xai',
        usd: 999,
        inputTokens: 0,
        outputTokens: 0,
        wallMs: 0,
      },
      { head: TIP },
    );
    expect(auth.allowed).toBe(false);
    expect(auth.refusals).toContain(SPEND_GATE_REFUSALS.BUDGET_USD);
  });

  it('authorizePaidCall refuses model/pipe mismatch', () => {
    const ledger = baseLedger();
    ledger.budget.simonConfirmedMaxUsd = true;
    const confirmed = applyTourPinConfirm(ledger, { action: 'confirm-pin' }).ledger!;
    const auth = authorizePaidCall(
      confirmed,
      {
        role: 'generator',
        kind: 'live_call',
        model: 'wrong-model',
        pipe: 'xai',
        allowedModels: ['grok-4.5'],
        allowedPipes: ['xai'],
        usd: 0.01,
      },
      { head: TIP },
    );
    expect(auth.allowed).toBe(false);
    expect(auth.refusals).toContain(SPEND_GATE_REFUSALS.MODEL_PIPE_MISMATCH);
  });

  it('reserve + settle rebuilds valid hash chain', () => {
    let ledger = baseLedger();
    ledger.budget.simonConfirmedMaxUsd = true;
    ledger = applyTourPinConfirm(ledger, { action: 'confirm-pin' }).ledger!;
    const reserved = reserveDebit(
      ledger,
      {
        role: 'generator',
        kind: 'live_call',
        model: 'grok-4.5',
        pipe: 'xai',
        usd: 0.02,
        inputTokens: 100,
        outputTokens: 50,
        wallMs: 500,
      },
      { head: TIP, now: '2026-07-29T12:00:00.000Z' },
    );
    expect(reserved.ok).toBe(true);
    const settled = finalizeDebit(reserved.ledger!, reserved.debit!.id, 'settled', {
      usd: 0.03,
      inputTokens: 120,
    });
    expect(validateDebitChain(settled.ledger.budget.debits).ok).toBe(true);
    expect(settled.debit.status).toBe('settled');
    expect(settled.debit.usd).toBe(0.03);
  });
});

describe('HITL scaffolding (#585)', () => {
  it('applySimonMaxUsdConfirm only accepts confirmer=simon and matching maxUsd', () => {
    const ledger = baseLedger();
    expect(applySimonMaxUsdConfirm(ledger, { maxUsd: 50, confirmer: 'agent' }).ok).toBe(false);
    expect(applySimonMaxUsdConfirm(ledger, { maxUsd: 99, confirmer: 'simon' }).ok).toBe(false);
    const ok = applySimonMaxUsdConfirm(ledger, { maxUsd: 50, confirmer: 'simon' });
    expect(ok.ok).toBe(true);
    expect(ok.ledger!.budget.simonConfirmedMaxUsd).toBe(true);
  });

  it('tour defer requires nextRotation or expiresAt', () => {
    const ledger = baseLedger();
    expect(applyTourPinConfirm(ledger, { action: 'defer' }).ok).toBe(false);
    const defer = applyTourPinConfirm(ledger, {
      action: 'defer',
      nextRotation: '2026-09-01T00:00:00.000Z',
    });
    expect(defer.ok).toBe(true);
    expect(defer.ledger!.rows['tour.freeze'].disposition).toBe('owner-deferred-with-expiry');
  });
});

describe('phase01 aggregate gate (#584)', () => {
  it('evaluatePhase01Gate reports modules and ledger on this worktree', () => {
    const result = evaluatePhase01Gate(root);
    // On a fresh worktree before ledger file: may fail module check for json
    // After build, should pass machine checks. Tolerate missing node_modules-independent files.
    expect(result.checks.some((c) => c.id.startsWith('module:'))).toBe(true);
    expect(Array.isArray(result.hardFailIds)).toBe(true);
    // Machine green ignores soft dual-bit drift (shallow CI tip lag).
    expect(result.ok).toBe(true);
    expect(result.hardFailIds).toEqual([]);
    // seatSpendAllowed is derived from live ledger (Simon may already be confirmed on main)
    expect(result.seatSpendAllowed === true || result.seatSpendAllowed === false).toBe(true);
  });

  it('dual-true ready drift is soft when launch is false (CI shallow tip lag)', () => {
    const result = evaluatePhase01Gate(root, {
      head: 'f'.repeat(40),
    });
    // With unrelated head, tip is not authorized → launch false; dual check soft-fails.
    const dual = result.checks.find((c) => c.id === 'no_dual_true_without_ledger');
    if (dual && !dual.ok) {
      expect(dual.soft).toBe(true);
      expect(result.ok).toBe(true);
      expect(result.hardFailIds).not.toContain('no_dual_true_without_ledger');
    } else {
      // if dual already matches launch, still machine green
      expect(result.ok).toBe(true);
    }
  });
});
