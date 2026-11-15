/**
 * Wave 3 execution ledger — pure schema + launch-bit derivation.
 *
 * SoT path: docs/agents/waves/wave-3-execution-state.json
 * Plan: .omx/plans/prd-wave3-ralplan-sol-glm-iter2.md (ralplan dual APPROVE)
 *
 * Does NOT authorize paid calls alone — see wave3-spend-gate.mjs.
 */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const LEDGER_SCHEMA = 'sinter-wave3-execution-state-v1';
export const GENESIS_PREV_HASH = '0'.repeat(64);

export const LIFECYCLE_STATES = Object.freeze([
  'absent',
  'implemented-unverified',
  'verified-offline',
  'verified-live',
  'merged',
  'owner-deferred',
  'forbidden',
]);

export const DISPOSITIONS = Object.freeze([
  'applied',
  'verified-applied',
  'applied-at-close',
  'applied-to-selected-seam',
  'applied-as-grilled-dossier-only',
  'rejected-with-measure',
  'not-triggered-exact-one-owner-manifest',
  'not-triggered-tool-run-evidence',
  'not-triggered-named-invariant-expiry',
  'owner-deferred-with-expiry',
  'forbidden-by-lock',
  'pending',
]);

/** G × disposition allow-list (closed). Any other combo is schema-invalid. */
export const G_DISPOSITION_ALLOW = Object.freeze({
  G1: ['verified-applied'],
  G2: ['forbidden-by-lock'],
  G3: ['applied'],
  G4: ['applied-at-close'],
  G5: ['applied', 'not-triggered-exact-one-owner-manifest'],
  G6: ['applied-to-selected-seam'],
  G7: ['applied-as-grilled-dossier-only'],
  G8: ['applied', 'rejected-with-measure'],
  G9: ['applied', 'not-triggered-tool-run-evidence'],
  G10: ['applied', 'not-triggered-tool-run-evidence'],
  G11: ['not-triggered-named-invariant-expiry', 'applied', 'owner-deferred-with-expiry'],
});

export const REQUIRED_ROW_IDS = Object.freeze([
  'G1', 'G2', 'G3', 'G4', 'G5', 'G6', 'G7', 'G8', 'G9', 'G10', 'G11',
  'OML-1', 'OML-2', 'OML-3', 'OML-4', 'OML-5', 'OML-6', 'OML-7',
  'compound.passA', 'compound.passB', 'compound.merge',
  'tour.freeze', 'tour.fingerprint',
  'gate.preflight', 'gate.negativeClaims',
  'budget', 'launch', 'slice.identityFeedForward',
]);

/** Dispositions that require non-empty evidence[]. */
export const DISPOSITIONS_REQUIRING_EVIDENCE = Object.freeze(new Set([
  'verified-applied',
  'applied',
  'applied-at-close',
  'applied-to-selected-seam',
  'applied-as-grilled-dossier-only',
  'rejected-with-measure',
  'not-triggered-exact-one-owner-manifest',
  'not-triggered-tool-run-evidence',
  'not-triggered-named-invariant-expiry',
]));

/** Dispositions that require expiresAt ISO. */
export const DISPOSITIONS_REQUIRING_EXPIRY = Object.freeze(new Set([
  'not-triggered-named-invariant-expiry',
  'owner-deferred-with-expiry',
]));

/** Dispositions that require implementedCommit or verifiedAtCommit. */
export const DISPOSITIONS_REQUIRING_COMMIT = Object.freeze(new Set([
  'verified-applied',
  'applied',
  'applied-at-close',
  'applied-to-selected-seam',
]));

export const DEBIT_STATUSES = Object.freeze(['reserved', 'settled', 'released']);
export const DEBIT_KINDS = Object.freeze(['live_call', 'infra_retry', 'pr_attempt']);
export const DEBIT_ROLES = Object.freeze(['harness', 'generator', 'evaluator', 'chat', 'k3', 'other']);
export const INFRA_CLASSES = Object.freeze([
  'http_5xx',
  'network_timeout',
  'auth_unavailable_flap',
]);

export const DEFAULT_BUDGET_CAPS = Object.freeze({
  maxUsd: 50,
  maxInputTokens: 2_000_000,
  maxOutputTokens: 500_000,
  maxWallMinutes: 240,
});

export function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
}

export function sha256Hex(input) {
  return createHash('sha256').update(String(input), 'utf8').digest('hex');
}

/** Hash body for debit chain — excludes prevHash/hash so they can be appended. */
export function debitBodyForHash(debit) {
  const {
    id, ts, phase, role, kind, model, pipe,
    inputTokens, outputTokens, usd, wallMs, status,
    infraClass, qualityLabeledAsInfra, prContractFailId,
  } = debit;
  return stableStringify({
    id, ts, phase, role, kind, model, pipe,
    inputTokens, outputTokens, usd, wallMs, status,
    infraClass: infraClass ?? null,
    qualityLabeledAsInfra: qualityLabeledAsInfra ?? false,
    prContractFailId: prContractFailId ?? null,
  });
}

export function computeDebitHash(debit, prevHash) {
  return sha256Hex(`${prevHash || GENESIS_PREV_HASH}|${debitBodyForHash(debit)}`);
}

export function isGRowId(id) {
  return /^G([1-9]|1[01])$/.test(String(id));
}

/**
 * Field-level disposition requirements (evidence / expiry / commit / lock ref).
 * @returns {string[]} error codes
 */
export function validateDispositionFields(row) {
  const errors = [];
  const d = row.disposition;
  const evidence = Array.isArray(row.evidence) ? row.evidence : [];
  if (DISPOSITIONS_REQUIRING_EVIDENCE.has(d) && evidence.length === 0) {
    errors.push('evidence_required');
  }
  if (DISPOSITIONS_REQUIRING_EXPIRY.has(d)) {
    if (!row.expiresAt || Number.isNaN(Date.parse(row.expiresAt))) {
      errors.push('expiresAt_required');
    }
  }
  if (DISPOSITIONS_REQUIRING_COMMIT.has(d)) {
    if (!row.implementedCommit && !row.verifiedAtCommit) {
      errors.push('commit_required');
    }
  }
  if (d === 'forbidden-by-lock' && !row.ownerLockRef) {
    errors.push('ownerLockRef_required');
  }
  if (d === 'owner-deferred-with-expiry' && !row.owner) {
    errors.push('owner_required');
  }
  return errors;
}

/**
 * Validate G allow-list when row id is a G row.
 */
export function validateGDisposition(row) {
  if (!isGRowId(row.id)) return [];
  const allowed = G_DISPOSITION_ALLOW[row.id];
  if (!allowed) return [`unknown_g_row:${row.id}`];
  // pending is only legal pre-phase0; once disposition is non-pending must be on allow-list
  if (row.disposition === 'pending') return [];
  if (!allowed.includes(row.disposition)) {
    return [`invalid_g_disposition:${row.id}:${row.disposition}`];
  }
  return [];
}

/**
 * Invalid lifecycle transitions (immutable once terminal).
 */
export function isInvalidTransition(fromState, toState) {
  if (fromState === 'forbidden' && toState === 'merged') return true;
  if (fromState === 'merged' && toState === 'absent') return true;
  if (fromState === 'forbidden' && toState === 'applied') return true;
  return false;
}

/**
 * Deterministic blocksSpend for a single row.
 */
export function computeBlocksSpend(row, opts = {}) {
  const reasons = [];
  if (!row || typeof row !== 'object') {
    return { blocksSpend: true, reasons: ['row_missing'] };
  }

  const gErrors = validateGDisposition(row);
  if (gErrors.length) reasons.push(...gErrors);

  const fieldErrors = validateDispositionFields(row);
  if (fieldErrors.length) reasons.push(...fieldErrors);

  if (!LIFECYCLE_STATES.includes(row.state)) {
    reasons.push(`invalid_state:${row.state}`);
  }
  if (!DISPOSITIONS.includes(row.disposition)) {
    reasons.push(`invalid_disposition:${row.disposition}`);
  }

  if (row.requiredForPhase01 === true) {
    if (row.state === 'absent' || row.state === 'implemented-unverified') {
      reasons.push('phase01_incomplete');
    }
  }

  if (row.criticalPath === true) {
    const terminalOk = isTerminalOkDisposition(row);
    if (!terminalOk) reasons.push('critical_path_not_terminal');
  }

  // Forbidden disposition always blocks spend if criticalPath or phase01
  if (row.disposition === 'forbidden-by-lock' && (row.criticalPath || row.requiredForPhase01)) {
    // G2 is intentionally forbidden — blocksSpend only if someone put it on criticalPath for spend
    if (row.criticalPath === true && row.id !== 'G2') {
      reasons.push('forbidden_blocks');
    }
  }

  // G2 is the beauty lock: it must stay forbidden-by-lock and must not alone open seats.
  // It does not blocksSpend for phase01 unless marked requiredForPhase01.

  return {
    blocksSpend: reasons.length > 0,
    reasons,
  };
}

function isTerminalOkDisposition(row) {
  if (row.disposition === 'pending') return false;
  if (row.disposition === 'forbidden-by-lock' && row.id === 'G2') return true;
  if (isGRowId(row.id)) {
    const allowed = G_DISPOSITION_ALLOW[row.id] || [];
    return allowed.includes(row.disposition);
  }
  // Non-G rows: any non-pending disposition that passes field validation
  return row.disposition !== 'pending' && validateDispositionFields(row).length === 0;
}

/**
 * Validate debit hash chain: order, hashes, no duplicates.
 * @returns {{ ok: boolean, errors: string[] }}
 */
export function validateDebitChain(debits) {
  const errors = [];
  if (!Array.isArray(debits)) {
    return { ok: false, errors: ['debits_not_array'] };
  }
  const seenIds = new Set();
  let prevHash = GENESIS_PREV_HASH;
  for (let i = 0; i < debits.length; i++) {
    const d = debits[i];
    if (!d || typeof d !== 'object') {
      errors.push(`debit_${i}_not_object`);
      continue;
    }
    if (!d.id || seenIds.has(d.id)) {
      errors.push(d?.id ? `duplicate_debit_id:${d.id}` : `debit_${i}_missing_id`);
    } else {
      seenIds.add(d.id);
    }
    if (!DEBIT_STATUSES.includes(d.status)) errors.push(`debit_${i}_bad_status`);
    if (!DEBIT_KINDS.includes(d.kind)) errors.push(`debit_${i}_bad_kind`);
    if (!DEBIT_ROLES.includes(d.role)) errors.push(`debit_${i}_bad_role`);
    if (d.prevHash !== prevHash) {
      errors.push(`debit_${i}_prevHash_mismatch`);
    }
    const expected = computeDebitHash(d, prevHash);
    if (d.hash !== expected) {
      errors.push(`debit_${i}_hash_mismatch`);
    }
    prevHash = d.hash || prevHash;
  }
  return { ok: errors.length === 0, errors };
}

/**
 * Full ledger schema validation (structure + G table + debit chain).
 * @param {object} ledger
 * @param {{ head?: string }} [opts]
 */
export function validateLedgerSchema(ledger, opts = {}) {
  const errors = [];
  if (!ledger || typeof ledger !== 'object') {
    return { ok: false, errors: ['ledger_missing'], rows: {}, launch: null };
  }
  if (ledger.schema !== LEDGER_SCHEMA) {
    errors.push(`schema_mismatch:${ledger.schema}`);
  }
  if (!ledger.tip || typeof ledger.tip !== 'string' || ledger.tip.length < 7) {
    errors.push('tip_missing');
  }
  if (!ledger.budget || typeof ledger.budget !== 'object') {
    errors.push('budget_missing');
  } else {
    for (const k of ['maxUsd', 'maxInputTokens', 'maxOutputTokens', 'maxWallMinutes']) {
      if (typeof ledger.budget[k] !== 'number' || !(ledger.budget[k] > 0)) {
        errors.push(`budget_${k}_invalid`);
      }
    }
    if (typeof ledger.budget.simonConfirmedMaxUsd !== 'boolean') {
      errors.push('budget_simonConfirmedMaxUsd_missing');
    }
  }

  const rows = ledger.rows;
  if (!rows || typeof rows !== 'object' || Array.isArray(rows)) {
    errors.push('rows_missing');
  } else {
    for (const id of REQUIRED_ROW_IDS) {
      if (!rows[id]) errors.push(`missing_row:${id}`);
    }
    for (const [id, row] of Object.entries(rows)) {
      if (!row || typeof row !== 'object') {
        errors.push(`row_bad:${id}`);
        continue;
      }
      if (row.id && row.id !== id) errors.push(`row_id_mismatch:${id}`);
      const gErr = validateGDisposition({ ...row, id });
      errors.push(...gErr);
      const fErr = validateDispositionFields({ ...row, id });
      // pending may skip field requirements
      if (row.disposition !== 'pending') {
        errors.push(...fErr.map((e) => `${id}:${e}`));
      }
      if (!LIFECYCLE_STATES.includes(row.state)) {
        errors.push(`${id}:invalid_state`);
      }
      if (!DISPOSITIONS.includes(row.disposition)) {
        errors.push(`${id}:invalid_disposition`);
      }
    }
  }

  const debits = ledger.budget?.debits ?? ledger.debits ?? [];
  const chain = validateDebitChain(debits);
  if (!chain.ok) errors.push(...chain.errors.map((e) => `debit:${e}`));

  return {
    ok: errors.length === 0,
    errors,
    tip: ledger.tip ?? null,
    head: opts.head ?? null,
  };
}

/**
 * Tip is authorized when it equals HEAD or is a git ancestor of HEAD.
 * Exact equality alone breaks after every tip-pin/HITL follow-up commit.
 * @param {string} tip
 * @param {string} head
 * @param {{ repoRoot?: string, isAncestor?: (tip: string, head: string) => boolean }} [opts]
 */
export function isTipAuthorized(tip, head, opts = {}) {
  if (!tip || !head) return false;
  if (tip === head) return true;
  if (typeof opts.isAncestor === 'function') {
    return Boolean(opts.isAncestor(tip, head));
  }
  const repoRoot = opts.repoRoot || process.cwd();
  try {
    const r = spawnSync('git', ['merge-base', '--is-ancestor', tip, head], {
      cwd: repoRoot,
      encoding: 'utf8',
    });
    return r.status === 0;
  } catch {
    return false;
  }
}

/**
 * Single tip-lag policy module (Wave 3A P0-1).
 * Both seat-spend and phase01 gates MUST use this — no dual predicates.
 *
 * @param {'seat-spend'|'phase01-machine'|'hard-equal'} mode
 * @param {string} tip
 * @param {string} head
 * @param {{ repoRoot?: string, isAncestor?: Function }} [opts]
 * @returns {{ ok: boolean, soft: boolean, mode: string, tip: string, head: string, detail: string }}
 */
export function shouldGateOnTip(mode, tip, head, opts = {}) {
  const m = mode || 'seat-spend';
  if (!tip || !head) {
    return {
      ok: false,
      soft: m === 'phase01-machine',
      mode: m,
      tip: tip || '',
      head: head || '',
      detail: 'tip_or_head_missing',
    };
  }
  if (m === 'hard-equal') {
    const ok = tip === head;
    return {
      ok,
      soft: false,
      mode: m,
      tip,
      head,
      detail: ok ? 'exact_match' : `exact_mismatch tip=${tip} head=${head}`,
    };
  }
  if (m === 'phase01-machine') {
    // Soft: lag does not fail phase01 machine green; still report status.
    const auth = isTipAuthorized(tip, head, opts);
    return {
      ok: true,
      soft: true,
      mode: m,
      tip,
      head,
      detail: auth
        ? (tip === head ? 'tip_matches_head' : 'tip_ancestor_of_head')
        : `tip_lag tip=${tip} head=${head} (ok for AFK land; re-pin before seat spend)`,
    };
  }
  // seat-spend (default): ancestor-or-equal required
  const auth = isTipAuthorized(tip, head, opts);
  return {
    ok: auth,
    soft: false,
    mode: 'seat-spend',
    tip,
    head,
    detail: auth
      ? (tip === head ? 'tip_matches_head' : 'tip_ancestor_of_head')
      : `tip_stale:ledger=${tip} head=${head}`,
  };
}

/**
 * Branch-aware tip pin record (Wave 3A P1-3).
 * @param {{ repoRoot?: string, tip?: string }} [opts]
 */
export function buildTipPin(opts = {}) {
  const repoRoot = opts.repoRoot || process.cwd();
  let sha = opts.tip || '';
  let ref = null;
  let detached = true;
  try {
    if (!sha) {
      const h = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' });
      sha = h.status === 0 ? h.stdout.trim() : '';
    }
    const ab = spawnSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd: repoRoot,
      encoding: 'utf8',
    });
    if (ab.status === 0) {
      const name = ab.stdout.trim();
      if (name && name !== 'HEAD') {
        ref = name;
        detached = false;
      } else {
        detached = true;
        ref = null;
      }
    }
  } catch {
    /* keep defaults */
  }
  return {
    sha,
    ref,
    detached,
    pinnedAt: new Date().toISOString(),
  };
}

/**
 * Derive launch.seatSpendAllowed — sole launch bit formula.
 * @param {object} ledger
 * @param {{ head: string, repoRoot?: string, isAncestor?: Function }} opts
 */
export function computeSeatSpendAllowed(ledger, opts = {}) {
  const reasons = [];
  const head = opts.head || '';
  const schema = validateLedgerSchema(ledger, { head });
  if (!schema.ok) {
    reasons.push(...schema.errors.map((e) => `schema:${e}`));
  }

  const tipGate = shouldGateOnTip('seat-spend', ledger?.tip, head, opts);
  if (!tipGate.ok) {
    reasons.push(tipGate.detail.startsWith('tip_stale') ? tipGate.detail : `tip_stale:${tipGate.detail}`);
  }
  const tipOk = tipGate.ok;

  if (!ledger?.budget?.simonConfirmedMaxUsd) {
    reasons.push('simon_max_usd_unconfirmed');
  }

  const debits = ledger?.budget?.debits ?? ledger?.debits ?? [];
  const chain = validateDebitChain(debits);
  if (!chain.ok) {
    reasons.push(...chain.errors.map((e) => `debit:${e}`));
  }

  // Tour freeze must not be pending / missing expiry when deferred
  const tour = ledger?.rows?.['tour.freeze'];
  if (!tour) {
    reasons.push('tour_freeze_missing');
  } else {
    const tourBlock = computeBlocksSpend({ ...tour, id: 'tour.freeze' });
    // Tour is requiredForPhase01 in initial ledger — if it blocks, launch false
    if (tour.requiredForPhase01 && tourBlock.blocksSpend) {
      reasons.push(...tourBlock.reasons.map((r) => `tour:${r}`));
    }
    if (tour.disposition === 'pending') {
      reasons.push('tour_freeze_pending');
    }
  }

  // Phase-01 required rows
  if (ledger?.rows) {
    for (const [id, row] of Object.entries(ledger.rows)) {
      const r = { ...row, id: row.id || id };
      if (r.requiredForPhase01 !== true) continue;
      const b = computeBlocksSpend(r);
      if (b.blocksSpend) {
        reasons.push(...b.reasons.map((x) => `${id}:${x}`));
      }
    }
  }

  const seatSpendAllowed = reasons.length === 0;
  return {
    seatSpendAllowed,
    reasons,
    tipMatchesHead: tipOk,
    tipAuthorized: tipOk,
    simonConfirmedMaxUsd: Boolean(ledger?.budget?.simonConfirmedMaxUsd),
    schemaOk: schema.ok,
  };
}

/**
 * Annotate every row with derived blocksSpend (non-mutating copy).
 */
export function annotateBlocksSpend(ledger) {
  const rows = {};
  for (const [id, row] of Object.entries(ledger.rows || {})) {
    const r = { ...row, id: row.id || id };
    const b = computeBlocksSpend(r);
    rows[id] = { ...r, blocksSpend: b.blocksSpend, blocksSpendReasons: b.reasons };
  }
  return { ...ledger, rows };
}

export function defaultLedgerPath(repoRoot) {
  return path.join(repoRoot, 'docs/agents/waves/wave-3-execution-state.json');
}

export function loadLedger(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8');
  return JSON.parse(raw);
}

export function saveLedger(filePath, ledger) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(ledger, null, 2)}\n`, 'utf8');
}

/**
 * Build a Phase 0–1 starter ledger at a tip. Seats stay closed (simonConfirmed=false).
 * Phase 0–1 machinery rows are verified-offline with evidence placeholders for the landed suite.
 */
export function buildPhase01Ledger({
  tip,
  ts = new Date().toISOString(),
  evidenceCommit = tip,
  repoRoot = null,
} = {}) {
  if (!tip) throw new Error('buildPhase01Ledger requires tip');

  const mk = (id, partial) => ({
    id,
    state: 'pending' === partial.disposition ? 'absent' : (partial.state || 'verified-offline'),
    disposition: partial.disposition || 'pending',
    requiredForPhase01: partial.requiredForPhase01 ?? false,
    criticalPath: partial.criticalPath ?? false,
    evidence: partial.evidence || [],
    ...(partial.implementedCommit ? { implementedCommit: partial.implementedCommit } : {}),
    ...(partial.verifiedAtCommit ? { verifiedAtCommit: partial.verifiedAtCommit } : {}),
    ...(partial.expiresAt ? { expiresAt: partial.expiresAt } : {}),
    ...(partial.owner ? { owner: partial.owner } : {}),
    ...(partial.ownerLockRef ? { ownerLockRef: partial.ownerLockRef } : {}),
    ...(partial.notes ? { notes: partial.notes } : {}),
  });

  const phaseEvidence = [
    `phase01 suite @ ${evidenceCommit}`,
    'scripts/rotation/wave3-execution-ledger.mjs',
    'scripts/rotation/wave3-spend-gate.mjs',
  ];

  const rows = {
    // G dispositions — product not yet applied; not phase01-required (machinery is)
    G1: mk('G1', { disposition: 'pending', state: 'absent', criticalPath: false }),
    G2: mk('G2', {
      disposition: 'forbidden-by-lock',
      state: 'forbidden',
      ownerLockRef: 'docs/agent-law/architecture-to-beauty-switchover.md#beauty-paused',
      evidence: ['beauty paused owner lock'],
      notes: 'Beauty locked for Wave 3 architecture phase',
    }),
    G3: mk('G3', { disposition: 'pending', state: 'absent' }),
    G4: mk('G4', { disposition: 'pending', state: 'absent' }),
    G5: mk('G5', { disposition: 'pending', state: 'absent' }),
    G6: mk('G6', { disposition: 'pending', state: 'absent' }),
    G7: mk('G7', {
      disposition: 'applied-as-grilled-dossier-only',
      state: 'verified-offline',
      evidence: ['docs/agents/waves/wave-3-G7-domain-exploration-dossier.md'],
      notes: 'Dossier + kill-list only; no generator ship',
    }),
    G8: mk('G8', { disposition: 'pending', state: 'absent' }),
    G9: mk('G9', { disposition: 'pending', state: 'absent' }),
    G10: mk('G10', { disposition: 'pending', state: 'absent' }),
    G11: mk('G11', {
      disposition: 'owner-deferred-with-expiry',
      state: 'owner-deferred',
      owner: 'simon',
      expiresAt: '2026-09-01T00:00:00.000Z',
      evidence: ['architecture-and-compound-first owner lock'],
    }),
    'OML-1': mk('OML-1', { disposition: 'pending', state: 'absent' }),
    'OML-2': mk('OML-2', { disposition: 'pending', state: 'absent' }),
    'OML-3': mk('OML-3', { disposition: 'pending', state: 'absent' }),
    'OML-4': mk('OML-4', { disposition: 'pending', state: 'absent' }),
    'OML-5': mk('OML-5', { disposition: 'pending', state: 'absent' }),
    'OML-6': mk('OML-6', { disposition: 'pending', state: 'absent' }),
    'OML-7': mk('OML-7', { disposition: 'pending', state: 'absent' }),
    'compound.passA': mk('compound.passA', { disposition: 'pending', state: 'absent' }),
    'compound.passB': mk('compound.passB', { disposition: 'pending', state: 'absent' }),
    'compound.merge': mk('compound.merge', { disposition: 'pending', state: 'absent' }),
    // Tour: deferred until Simon HITL (#585) — expires so reuse of W2 seats is honest
    'tour.freeze': mk('tour.freeze', {
      disposition: 'owner-deferred-with-expiry',
      state: 'owner-deferred',
      requiredForPhase01: true,
      owner: 'simon',
      expiresAt: '2026-08-15T00:00:00.000Z',
      evidence: [
        'docs/agents/waves/tour-seat-live-freeze.json#wave3',
        'HITL #585: confirm pin or write nextRotation',
      ],
      notes: 'Provisional W3 pin present; Simon must confirm or defer with nextRotation',
    }),
    'tour.fingerprint': mk('tour.fingerprint', {
      disposition: 'applied',
      state: 'verified-offline',
      requiredForPhase01: true,
      implementedCommit: evidenceCommit,
      evidence: phaseEvidence.concat(['tour instrumentation fingerprint tooling']),
    }),
    'gate.preflight': mk('gate.preflight', {
      disposition: 'applied',
      state: 'verified-offline',
      requiredForPhase01: true,
      implementedCommit: evidenceCommit,
      evidence: phaseEvidence.concat(['wave3-phase01-gate.mjs']),
    }),
    'gate.negativeClaims': mk('gate.negativeClaims', {
      disposition: 'applied',
      state: 'verified-offline',
      requiredForPhase01: true,
      implementedCommit: evidenceCommit,
      evidence: phaseEvidence.concat(['structural-cap negatives in test suite']),
    }),
    budget: mk('budget', {
      disposition: 'applied',
      state: 'verified-offline',
      requiredForPhase01: true,
      implementedCommit: evidenceCommit,
      evidence: phaseEvidence.concat(['provisional maxUsd=50 pending Simon confirm']),
    }),
    launch: mk('launch', {
      disposition: 'applied',
      state: 'verified-offline',
      requiredForPhase01: true,
      implementedCommit: evidenceCommit,
      evidence: phaseEvidence.concat(['single seatSpendAllowed formula']),
    }),
    'slice.identityFeedForward': mk('slice.identityFeedForward', {
      disposition: 'applied',
      state: 'verified-offline',
      requiredForPhase01: true,
      implementedCommit: evidenceCommit,
      evidence: phaseEvidence.concat([
        'SelfImproveCompoundLoop adaptation id inject',
        'LLMModeSelfImprovementRuntime.prepare() consumer',
      ]),
    }),
  };

  // Branch-aware tip pin when repo is available (P1-3); else sha-only stub.
  const tipPin = repoRoot
    ? buildTipPin({ repoRoot, tip })
    : { sha: tip, ref: null, detached: true, pinnedAt: ts };

  return {
    schema: LEDGER_SCHEMA,
    schemaVersion: 2,
    wave: 3,
    tip,
    tipPin,
    updatedAt: ts,
    budget: {
      ...DEFAULT_BUDGET_CAPS,
      simonConfirmedMaxUsd: false,
      simonConfirmedAt: null,
      simonConfirmedBy: null,
      debits: [],
    },
    launch: {
      // Derived at runtime; persisted snapshot for humans (always recompute for authority)
      seatSpendAllowed: false,
      note: 'Derived only by computeSeatSpendAllowed; never flip by hand. SoT is formula + tip + Simon confirm.',
    },
    dualBitsRetired: {
      wave3Allowed: 'non-authoritative instruments bit — not seat spend',
      wave3SeatSpendAllowed: 'must equal launch.seatSpendAllowed from this ledger only',
    },
    rows,
    notes: [
      'Phase 0–1 machinery rows verified-offline after suite land.',
      'Seat spend remains blocked until simonConfirmedMaxUsd + tip authorized + no blocksSpend.',
      'G/OML/compound product rows stay pending until inheritance slice.',
      'schemaVersion 2: tipPin {sha,ref,detached} + shouldGateOnTip single policy.',
      'Tip policy: seat-spend requires tip==HEAD or tip ancestor-of-HEAD (not exact equality alone).',
    ],
  };
}

function spawnHead(repoRoot) {
  const r = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : '';
}

/** CLI: validate | build | launch-bit */
export function main(argv = process.argv.slice(2)) {
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const repoRoot = path.resolve(__dirname, '../..');
  const cmd = argv[0] || 'validate';
  const ledgerPath = defaultLedgerPath(repoRoot);

  if (cmd === 'build') {
    const tip = argv.includes('--tip')
      ? argv[argv.indexOf('--tip') + 1]
      : (spawnHead(repoRoot) || 'unknown');
    const ledger = buildPhase01Ledger({ tip });
    saveLedger(ledgerPath, ledger);
    console.log(JSON.stringify({ ok: true, path: ledgerPath, tip, seatSpendAllowed: false }, null, 2));
    return 0;
  }

  if (cmd === 'validate' || cmd === 'launch-bit') {
    if (!fs.existsSync(ledgerPath)) {
      console.error(JSON.stringify({ ok: false, error: 'ledger_missing', path: ledgerPath }));
      return 2;
    }
    const ledger = loadLedger(ledgerPath);
    const head = spawnHead(repoRoot);
    const schema = validateLedgerSchema(ledger, { head });
    const launch = computeSeatSpendAllowed(ledger, { head });
    const out = {
      ok: schema.ok,
      path: ledgerPath,
      tip: ledger.tip,
      head,
      schema,
      launch,
      seatSpendAllowed: launch.seatSpendAllowed,
    };
    console.log(JSON.stringify(out, null, 2));
    // validate exits 0 on schema ok even if seats blocked; launch-bit exits 1 if seats blocked
    if (cmd === 'launch-bit') return launch.seatSpendAllowed ? 0 : 1;
    return schema.ok ? 0 : 2;
  }

  console.error('usage: wave3-execution-ledger.mjs <validate|build|launch-bit>');
  return 2;
}

const isMain = process.argv[1] && (
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
  || process.argv[1].endsWith('wave3-execution-ledger.mjs')
);
if (isMain) {
  process.exit(main());
}
