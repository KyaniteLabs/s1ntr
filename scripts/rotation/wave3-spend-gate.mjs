/**
 * Wave 3 sole paid-call authority.
 *
 * Atomic sequence (refuse before any provider call):
 * 1. ledger.tip is HEAD or a git ancestor of HEAD (shouldGateOnTip seat-spend)
 * 2. Validate ledger schema + G disposition table
 * 3. Compute launch.seatSpendAllowed
 * 4. Confirm budget.simonConfirmedMaxUsd
 * 5. Project debit for this call
 * 6. Structural + budget caps → refuse-before-provider
 * 7. Append reservation (status: reserved)
 * 8. Provider call (caller-owned)
 * 9. settle / release
 *
 * scripts/mece/budget.mjs is non-authoritative alone.
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  GENESIS_PREV_HASH,
  INFRA_CLASSES,
  DEFAULT_BUDGET_CAPS,
  computeDebitHash,
  buildTipPin,
  computeSeatSpendAllowed,
  defaultLedgerPath,
  isTipAuthorized,
  loadLedger,
  saveLedger,
  shouldGateOnTip,
  validateDebitChain,
  validateLedgerSchema,
} from './wave3-execution-ledger.mjs';

const SECRETISH_RE = /(authorization|bearer|api[_-]?key|token|jwt|password|secret|sk-[a-z0-9]|eyJ[a-zA-Z0-9_-]{10,})/i;

/** Redact secret-bearing strings for durable HITL receipts (Terra PR#589). */
export function sanitizeHitlField(value, maxLen = 240) {
  if (value == null) return null;
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'object') {
    if (Array.isArray(value)) {
      return value.slice(0, 8).map((v) => sanitizeHitlField(v, Math.min(maxLen, 80)));
    }
    const out = {};
    for (const [k, v] of Object.entries(value).slice(0, 12)) {
      if (SECRETISH_RE.test(k)) {
        out[k] = '[redacted]';
        continue;
      }
      out[k] = sanitizeHitlField(v, Math.min(maxLen, 120));
    }
    return out;
  }
  let s = String(value);
  if (SECRETISH_RE.test(s)) s = '[redacted-secret-like]';
  if (s.length > maxLen) s = `${s.slice(0, maxLen - 1)}…`;
  return s;
}

/**
 * Write a structured HITL/quiet-path failure receipt (Wave 3A P1-1).
 * Never silent: every quieted operator-facing failure still leaves a countable line.
 * Fields are sanitized — never persist raw Authorization / API keys.
 */
export function writeHitlFailureReceipt(repoRoot, entry) {
  const dir = path.join(repoRoot, '.quality', 'tour', 'wave-3', 'hitl-receipts');
  fs.mkdirSync(dir, { recursive: true });
  const day = new Date().toISOString().slice(0, 10);
  const file = path.join(dir, `${day}.jsonl`);
  const line = JSON.stringify({
    schema: 'sinter-wave3-hitl-receipt-v1',
    ts: new Date().toISOString(),
    class: sanitizeHitlField(entry.class || 'hitl_error', 64),
    seat: sanitizeHitlField(entry.seat || 'wave3-spend-gate', 64),
    tip: typeof entry.tip === 'string' && /^[0-9a-f]{7,40}$/i.test(entry.tip) ? entry.tip : null,
    error: sanitizeHitlField(entry.error, 240),
    detail: sanitizeHitlField(entry.detail, 240),
  });
  fs.appendFileSync(file, `${line}\n`, 'utf8');
  return file;
}

/** Shared post-HITL tip / tipPin / schemaVersion migration (P1-3 both confirm paths). */
export function applyHitlTipPinMigration(ledger, repoRoot) {
  const head = spawnHead(repoRoot);
  if (head) ledger.tip = head;
  ledger.tipPin = buildTipPin({ repoRoot, tip: ledger.tip });
  ledger.schemaVersion = ledger.schemaVersion || 2;
  return { ledger, head };
}

/**
 * Advance ledger.tip to HEAD after land (Wave 3B preflight).
 * Safe only when prior tip is missing, equal to HEAD, or a git ancestor of HEAD.
 * Never rewrites tip to an unrelated SHA (would hide stale/wrong-branch tips).
 */
export function pinLedgerTipToHead(ledger, opts = {}) {
  const repoRoot = opts.repoRoot || process.cwd();
  const head = opts.head || spawnHead(repoRoot);
  if (!head) {
    return { ok: false, error: 'head_unreadable', ledger };
  }
  const prevTip = ledger?.tip || '';
  if (prevTip && prevTip !== head) {
    const auth = isTipAuthorized(prevTip, head, {
      repoRoot,
      isAncestor: opts.isAncestor,
    });
    if (!auth) {
      return {
        ok: false,
        error: `tip_not_ancestor_of_head:ledger=${prevTip} head=${head}`,
        ledger,
      };
    }
  }
  // Prefer explicit head for tests/ops; still fill tipPin ref from repo when available.
  ledger.tip = head;
  ledger.tipPin = buildTipPin({ repoRoot, tip: head });
  // When opts.head is synthetic (tests), force sha to match even if git rev-parse differs.
  ledger.tipPin.sha = head;
  ledger.schemaVersion = ledger.schemaVersion || 2;
  const launch = computeSeatSpendAllowed(ledger, {
    head,
    repoRoot,
    isAncestor: opts.isAncestor,
  });
  ledger.launch = {
    ...(ledger.launch || {}),
    seatSpendAllowed: launch.seatSpendAllowed,
    lastComputedAt: new Date().toISOString(),
    lastReasons: launch.reasons || [],
    note: ledger.launch?.note
      || 'Derived only by computeSeatSpendAllowed; never flip by hand. SoT is formula + tip + Simon confirm.',
  };
  ledger.updatedAt = new Date().toISOString();
  ledger.notes = Array.isArray(ledger.notes) ? ledger.notes : [];
  const pinNote = `tip re-pinned to HEAD ${head.slice(0, 12)} @ ${ledger.updatedAt}`;
  if (!ledger.notes.includes(pinNote)) ledger.notes.push(pinNote);
  return { ok: true, head, prevTip, launch, ledger };
}

function spawnHead(repoRoot) {
  const r = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : '';
}

export const SPEND_GATE_REFUSALS = Object.freeze({
  TIP_STALE: 'tip_stale',
  SCHEMA_INVALID: 'schema_invalid',
  LAUNCH_BLOCKED: 'launch_blocked',
  SIMON_UNCONFIRMED: 'simon_max_usd_unconfirmed',
  CAP_K3: 'cap_k3_live',
  CAP_ROLE: 'cap_role_live',
  CAP_INFRA: 'cap_infra_retry',
  CAP_PR: 'cap_pr_attempt',
  QUALITY_AS_INFRA: 'quality_cannot_mint_infra_retry',
  BAD_INFRA_CLASS: 'infra_class_not_closed',
  BUDGET_USD: 'budget_usd',
  BUDGET_INPUT: 'budget_input_tokens',
  BUDGET_OUTPUT: 'budget_output_tokens',
  BUDGET_WALL: 'budget_wall_minutes',
  MODEL_PIPE_MISMATCH: 'model_pipe_mismatch',
  DEBIT_CHAIN: 'debit_chain_invalid',
  SEAT_SPEND_KILLED: 'env_spend_killed',
});

const REQUIRED_ROLES = Object.freeze(['harness', 'generator', 'evaluator', 'chat', 'k3']);

/**
 * Env kill switch (mirrors wave2 LIMINAL_WAVE_SPEND).
 */
export function isWaveSpendKilled(env = process.env) {
  const v = String(env.LIMINAL_WAVE_SPEND ?? env.SINTER_WAVE_SPEND ?? '1').toLowerCase();
  return v === '0' || v === 'false' || v === 'off' || v === 'no';
}

function settledDebits(debits) {
  return (debits || []).filter((d) => d.status === 'settled' || d.status === 'reserved');
}

/**
 * Structural caps from debit log.
 * @returns {string[]} refusal codes
 */
export function checkStructuralCaps(debits, request) {
  const refusals = [];
  const active = settledDebits(debits);

  if (request.kind === 'live_call' && (request.role === 'k3' || request.role === 'harness')) {
    // K3 live ≤ 1 (harness seat is K3 on Wave 3 map)
    const k3Count = active.filter(
      (d) => d.kind === 'live_call' && (d.role === 'k3' || d.role === 'harness'),
    ).length;
    if (k3Count >= 1 && (request.role === 'k3' || request.role === 'harness')) {
      refusals.push(SPEND_GATE_REFUSALS.CAP_K3);
    }
  }

  if (request.kind === 'live_call' && REQUIRED_ROLES.includes(request.role)) {
    const roleCount = active.filter(
      (d) => d.kind === 'live_call' && d.role === request.role,
    ).length;
    if (roleCount >= 1) {
      refusals.push(SPEND_GATE_REFUSALS.CAP_ROLE);
    }
  }

  if (request.kind === 'infra_retry') {
    if (request.qualityLabeledAsInfra) {
      refusals.push(SPEND_GATE_REFUSALS.QUALITY_AS_INFRA);
    }
    if (!INFRA_CLASSES.includes(request.infraClass)) {
      refusals.push(SPEND_GATE_REFUSALS.BAD_INFRA_CLASS);
    }
    const infraCount = active.filter((d) => d.kind === 'infra_retry').length;
    if (infraCount >= 1) {
      refusals.push(SPEND_GATE_REFUSALS.CAP_INFRA);
    }
  }

  if (request.kind === 'pr_attempt') {
    const prCount = active.filter((d) => d.kind === 'pr_attempt').length;
    const maxPr = request.prContractFailId ? 2 : 1;
    if (prCount >= maxPr) {
      refusals.push(SPEND_GATE_REFUSALS.CAP_PR);
    }
  }

  return refusals;
}

/**
 * Project totals including this request's estimate.
 */
export function projectBudgetUsage(debits, request, caps = DEFAULT_BUDGET_CAPS) {
  const active = settledDebits(debits);
  let usd = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let wallMs = 0;
  for (const d of active) {
    usd += Number(d.usd) || 0;
    inputTokens += Number(d.inputTokens) || 0;
    outputTokens += Number(d.outputTokens) || 0;
    wallMs += Number(d.wallMs) || 0;
  }
  usd += Number(request.usd) || 0;
  inputTokens += Number(request.inputTokens) || 0;
  outputTokens += Number(request.outputTokens) || 0;
  wallMs += Number(request.wallMs) || 0;

  const refusals = [];
  if (usd > caps.maxUsd) refusals.push(SPEND_GATE_REFUSALS.BUDGET_USD);
  if (inputTokens > caps.maxInputTokens) refusals.push(SPEND_GATE_REFUSALS.BUDGET_INPUT);
  if (outputTokens > caps.maxOutputTokens) refusals.push(SPEND_GATE_REFUSALS.BUDGET_OUTPUT);
  if (wallMs / 60_000 > caps.maxWallMinutes) refusals.push(SPEND_GATE_REFUSALS.BUDGET_WALL);

  return {
    projected: { usd, inputTokens, outputTokens, wallMs },
    refusals,
  };
}

/**
 * Optional model/pipe allow-list on request.allowedPipes / allowedModels.
 */
export function checkModelPipe(request) {
  if (Array.isArray(request.allowedModels) && request.allowedModels.length > 0) {
    if (!request.allowedModels.includes(request.model)) {
      return [SPEND_GATE_REFUSALS.MODEL_PIPE_MISMATCH];
    }
  }
  if (Array.isArray(request.allowedPipes) && request.allowedPipes.length > 0) {
    if (!request.allowedPipes.includes(request.pipe)) {
      return [SPEND_GATE_REFUSALS.MODEL_PIPE_MISMATCH];
    }
  }
  return [];
}

/**
 * Authorize a paid call — refuse before provider when any gate fails.
 * Pure: does not mutate ledger. Use reserveDebit after ok.
 *
 * @param {object} ledger
 * @param {object} request
 * @param {{ head: string, env?: NodeJS.ProcessEnv, now?: string }} opts
 */
export function authorizePaidCall(ledger, request, opts = {}) {
  const head = opts.head || '';
  const env = opts.env || process.env;
  const refusals = [];

  if (isWaveSpendKilled(env)) {
    refusals.push(SPEND_GATE_REFUSALS.SEAT_SPEND_KILLED);
  }

  const schema = validateLedgerSchema(ledger, { head });
  if (!schema.ok) {
    refusals.push(SPEND_GATE_REFUSALS.SCHEMA_INVALID);
  }

  const tipGate = shouldGateOnTip('seat-spend', ledger.tip, head, opts);
  if (!tipGate.ok) {
    refusals.push(SPEND_GATE_REFUSALS.TIP_STALE);
  }

  const launch = computeSeatSpendAllowed(ledger, { head, repoRoot: opts.repoRoot, isAncestor: opts.isAncestor });
  if (!launch.seatSpendAllowed) {
    refusals.push(SPEND_GATE_REFUSALS.LAUNCH_BLOCKED);
    if (!launch.simonConfirmedMaxUsd) {
      refusals.push(SPEND_GATE_REFUSALS.SIMON_UNCONFIRMED);
    }
  }

  const debits = ledger.budget?.debits ?? [];
  const chain = validateDebitChain(debits);
  if (!chain.ok) {
    refusals.push(SPEND_GATE_REFUSALS.DEBIT_CHAIN);
  }

  refusals.push(...checkStructuralCaps(debits, request));
  const caps = {
    maxUsd: ledger.budget?.maxUsd ?? DEFAULT_BUDGET_CAPS.maxUsd,
    maxInputTokens: ledger.budget?.maxInputTokens ?? DEFAULT_BUDGET_CAPS.maxInputTokens,
    maxOutputTokens: ledger.budget?.maxOutputTokens ?? DEFAULT_BUDGET_CAPS.maxOutputTokens,
    maxWallMinutes: ledger.budget?.maxWallMinutes ?? DEFAULT_BUDGET_CAPS.maxWallMinutes,
  };
  const budget = projectBudgetUsage(debits, request, caps);
  refusals.push(...budget.refusals);
  refusals.push(...checkModelPipe(request));

  const unique = [...new Set(refusals)];
  return {
    allowed: unique.length === 0,
    refusals: unique,
    launch,
    projected: budget.projected,
    refuseBeforeProvider: unique.length > 0,
  };
}

/**
 * Append a reserved debit to a ledger copy (immutable-style return).
 */
export function reserveDebit(ledger, request, opts = {}) {
  const auth = authorizePaidCall(ledger, request, opts);
  if (!auth.allowed) {
    return { ok: false, auth, ledger };
  }
  const debits = [...(ledger.budget?.debits ?? [])];
  const prevHash = debits.length ? debits[debits.length - 1].hash : GENESIS_PREV_HASH;
  const ts = opts.now || new Date().toISOString();
  const id = request.id || `debit_${Date.now()}_${debits.length + 1}`;
  const body = {
    id,
    ts,
    phase: request.phase || '3',
    role: request.role,
    kind: request.kind,
    model: request.model || '',
    pipe: request.pipe || '',
    inputTokens: Number(request.inputTokens) || 0,
    outputTokens: Number(request.outputTokens) || 0,
    usd: Number(request.usd) || 0,
    wallMs: Number(request.wallMs) || 0,
    status: 'reserved',
    infraClass: request.infraClass ?? null,
    qualityLabeledAsInfra: Boolean(request.qualityLabeledAsInfra),
    prContractFailId: request.prContractFailId ?? null,
  };
  const hash = computeDebitHash(body, prevHash);
  const debit = { ...body, prevHash, hash };
  const next = {
    ...ledger,
    budget: {
      ...ledger.budget,
      debits: [...debits, debit],
    },
  };
  return { ok: true, auth, ledger: next, debit };
}

/**
 * Settle or release a reserved debit by id.
 */
export function finalizeDebit(ledger, debitId, status, actual = {}) {
  if (status !== 'settled' && status !== 'released') {
    throw new Error(`finalizeDebit status must be settled|released, got ${status}`);
  }
  const debits = [...(ledger.budget?.debits ?? [])];
  const idx = debits.findIndex((d) => d.id === debitId);
  if (idx < 0) throw new Error(`debit not found: ${debitId}`);
  const prev = debits[idx];
  if (prev.status !== 'reserved') {
    throw new Error(`debit ${debitId} not reserved (status=${prev.status})`);
  }
  // Rebuild chain from idx with updated fields (status + actuals) — re-hash tail
  const head = debits.slice(0, idx);
  let prevHash = idx === 0 ? GENESIS_PREV_HASH : debits[idx - 1].hash;
  const updatedBody = {
    id: prev.id,
    ts: prev.ts,
    phase: prev.phase,
    role: prev.role,
    kind: prev.kind,
    model: actual.model ?? prev.model,
    pipe: actual.pipe ?? prev.pipe,
    inputTokens: actual.inputTokens ?? prev.inputTokens,
    outputTokens: actual.outputTokens ?? prev.outputTokens,
    usd: actual.usd ?? prev.usd,
    wallMs: actual.wallMs ?? prev.wallMs,
    status,
    infraClass: prev.infraClass ?? null,
    qualityLabeledAsInfra: Boolean(prev.qualityLabeledAsInfra),
    prContractFailId: prev.prContractFailId ?? null,
  };
  const hash = computeDebitHash(updatedBody, prevHash);
  const rebuilt = [...head, { ...updatedBody, prevHash, hash }];
  prevHash = hash;
  for (let i = idx + 1; i < debits.length; i++) {
    const d = debits[i];
    const body = {
      id: d.id,
      ts: d.ts,
      phase: d.phase,
      role: d.role,
      kind: d.kind,
      model: d.model,
      pipe: d.pipe,
      inputTokens: d.inputTokens,
      outputTokens: d.outputTokens,
      usd: d.usd,
      wallMs: d.wallMs,
      status: d.status,
      infraClass: d.infraClass ?? null,
      qualityLabeledAsInfra: Boolean(d.qualityLabeledAsInfra),
      prContractFailId: d.prContractFailId ?? null,
    };
    const h = computeDebitHash(body, prevHash);
    rebuilt.push({ ...body, prevHash, hash: h });
    prevHash = h;
  }
  return {
    ledger: {
      ...ledger,
      budget: { ...ledger.budget, debits: rebuilt },
    },
    debit: rebuilt[idx],
  };
}

/**
 * HITL: Simon maxUsd confirm. Does not open seats without tip match + phase01 green.
 * Requires explicit confirmer === 'simon' and maxUsd matching ledger budget.
 */
export function applySimonMaxUsdConfirm(ledger, { maxUsd, confirmer, at } = {}) {
  if (confirmer !== 'simon') {
    return { ok: false, error: 'confirmer_must_be_simon', ledger };
  }
  const expected = ledger.budget?.maxUsd;
  if (typeof maxUsd !== 'number' || maxUsd !== expected) {
    return {
      ok: false,
      error: `maxUsd_mismatch:got=${maxUsd} expected=${expected}`,
      ledger,
    };
  }
  return {
    ok: true,
    ledger: {
      ...ledger,
      budget: {
        ...ledger.budget,
        simonConfirmedMaxUsd: true,
        simonConfirmedAt: at || new Date().toISOString(),
        simonConfirmedBy: 'simon',
      },
    },
  };
}

/**
 * HITL: confirm tour freeze pin (or write nextRotation defer).
 */
export function applyTourPinConfirm(ledger, { action, nextRotation, expiresAt, at } = {}) {
  const row = ledger.rows?.['tour.freeze'];
  if (!row) return { ok: false, error: 'tour_freeze_missing', ledger };
  if (action === 'confirm-pin') {
    const next = {
      ...row,
      disposition: 'applied',
      state: 'verified-offline',
      implementedCommit: ledger.tip,
      evidence: [
        ...(Array.isArray(row.evidence) ? row.evidence : []),
        `simon tour pin confirm @ ${at || new Date().toISOString()}`,
        'docs/agents/waves/tour-seat-live-freeze.json#wave3',
      ],
      notes: 'Simon confirmed Wave 3 tour pin',
    };
    delete next.expiresAt;
    return {
      ok: true,
      ledger: {
        ...ledger,
        rows: { ...ledger.rows, 'tour.freeze': next },
      },
    };
  }
  if (action === 'defer') {
    if (!nextRotation && !expiresAt) {
      return { ok: false, error: 'defer_requires_nextRotation_or_expiresAt', ledger };
    }
    return {
      ok: true,
      ledger: {
        ...ledger,
        rows: {
          ...ledger.rows,
          'tour.freeze': {
            ...row,
            disposition: 'owner-deferred-with-expiry',
            state: 'owner-deferred',
            owner: 'simon',
            expiresAt: expiresAt || nextRotation,
            evidence: [
              ...(Array.isArray(row.evidence) ? row.evidence : []),
              `simon defer @ ${at || new Date().toISOString()} nextRotation=${nextRotation || expiresAt}`,
            ],
            notes: `Deferred tour pin; nextRotation=${nextRotation || expiresAt}`,
          },
        },
      },
    };
  }
  return { ok: false, error: `unknown_action:${action}`, ledger };
}

export function main(argv = process.argv.slice(2)) {
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const repoRoot = path.resolve(__dirname, '../..');
  const ledgerPath = defaultLedgerPath(repoRoot);
  const cmd = argv[0] || 'check';

  if (!fs.existsSync(ledgerPath) && cmd !== 'help') {
    console.error(JSON.stringify({ ok: false, error: 'ledger_missing', path: ledgerPath }));
    return 2;
  }

  if (cmd === 'check') {
    const ledger = loadLedger(ledgerPath);
    const head = spawnHead(repoRoot);
    const role = argv.includes('--role') ? argv[argv.indexOf('--role') + 1] : 'harness';
    const kind = argv.includes('--kind') ? argv[argv.indexOf('--kind') + 1] : 'live_call';
    const request = {
      role,
      kind,
      model: argv.includes('--model') ? argv[argv.indexOf('--model') + 1] : '',
      pipe: argv.includes('--pipe') ? argv[argv.indexOf('--pipe') + 1] : '',
      usd: Number(argv.includes('--usd') ? argv[argv.indexOf('--usd') + 1] : 0) || 0,
      inputTokens: 0,
      outputTokens: 0,
      wallMs: 0,
    };
    const auth = authorizePaidCall(ledger, request, { head });
    console.log(JSON.stringify({ path: ledgerPath, head, request, auth }, null, 2));
    return auth.allowed ? 0 : 1;
  }

  if (cmd === 'confirm-max-usd') {
    // HITL only — requires --i-am-simon and matching --max
    if (!argv.includes('--i-am-simon')) {
      const err = 'HITL requires --i-am-simon (Simon only). Do not agent-auto-confirm.';
      writeHitlFailureReceipt(repoRoot, {
        class: 'hitl_missing_flag',
        error: err,
        tip: fs.existsSync(ledgerPath) ? loadLedger(ledgerPath).tip : null,
      });
      console.error(JSON.stringify({ ok: false, error: err }));
      return 3;
    }
    const maxUsd = Number(argv.includes('--max') ? argv[argv.indexOf('--max') + 1] : NaN);
    const ledger = loadLedger(ledgerPath);
    const result = applySimonMaxUsdConfirm(ledger, { maxUsd, confirmer: 'simon' });
    if (!result.ok) {
      writeHitlFailureReceipt(repoRoot, {
        class: 'hitl_max_usd_mismatch',
        error: result.error,
        tip: ledger.tip,
        detail: { maxUsd, expected: ledger.budget?.maxUsd },
      });
      // Do not dump full ledger on error (noisy / accidental context leak in logs).
      console.error(JSON.stringify({ ok: false, error: result.error }));
      return 2;
    }
    // Keep tip current on confirm + branch-aware tipPin (P1-3)
    const { head } = applyHitlTipPinMigration(result.ledger, repoRoot);
    saveLedger(ledgerPath, result.ledger);
    const launch = computeSeatSpendAllowed(result.ledger, { head, repoRoot });
    console.log(JSON.stringify({
      ok: true,
      simonConfirmedMaxUsd: true,
      seatSpendAllowed: launch.seatSpendAllowed,
      tipPin: result.ledger.tipPin,
      launch,
    }, null, 2));
    return 0;
  }

  if (cmd === 'confirm-tour') {
    if (!argv.includes('--i-am-simon')) {
      const err = 'HITL requires --i-am-simon (Simon only).';
      writeHitlFailureReceipt(repoRoot, { class: 'hitl_missing_flag', error: err });
      console.error(JSON.stringify({ ok: false, error: err }));
      return 3;
    }
    const action = argv.includes('--defer') ? 'defer' : 'confirm-pin';
    const nextRotation = argv.includes('--next-rotation')
      ? argv[argv.indexOf('--next-rotation') + 1]
      : undefined;
    const expiresAt = argv.includes('--expires')
      ? argv[argv.indexOf('--expires') + 1]
      : undefined;
    const ledger = loadLedger(ledgerPath);
    const result = applyTourPinConfirm(ledger, { action, nextRotation, expiresAt });
    if (!result.ok) {
      writeHitlFailureReceipt(repoRoot, {
        class: 'hitl_tour_reject',
        error: result.error,
        tip: ledger.tip,
        detail: { action, nextRotation: nextRotation || null, expiresAt: expiresAt || null },
      });
      console.error(JSON.stringify({ ok: false, error: result.error }));
      return 2;
    }
    applyHitlTipPinMigration(result.ledger, repoRoot);
    saveLedger(ledgerPath, result.ledger);
    console.log(JSON.stringify({
      ok: true,
      action,
      tour: result.ledger.rows['tour.freeze'],
      tipPin: result.ledger.tipPin,
    }, null, 2));
    return 0;
  }

  if (cmd === 'pin-tip') {
    // Operator post-land: advance tip to HEAD when prior tip is ancestor (no Simon needed).
    const ledger = loadLedger(ledgerPath);
    const result = pinLedgerTipToHead(ledger, { repoRoot });
    if (!result.ok) {
      writeHitlFailureReceipt(repoRoot, {
        class: 'tip_pin_rejected',
        error: result.error,
        tip: ledger.tip,
      });
      console.error(JSON.stringify({ ok: false, error: result.error }));
      return 2;
    }
    saveLedger(ledgerPath, result.ledger);
    console.log(JSON.stringify({
      ok: true,
      prevTip: result.prevTip,
      tip: result.ledger.tip,
      tipPin: result.ledger.tipPin,
      schemaVersion: result.ledger.schemaVersion,
      seatSpendAllowed: result.launch.seatSpendAllowed,
      launch: result.launch,
    }, null, 2));
    return 0;
  }

  console.error('usage: wave3-spend-gate.mjs <check|confirm-max-usd|confirm-tour|pin-tip> [flags]');
  return 2;
}

const isMain = process.argv[1] && (
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
  || process.argv[1].endsWith('wave3-spend-gate.mjs')
);
if (isMain) {
  process.exit(main());
}
