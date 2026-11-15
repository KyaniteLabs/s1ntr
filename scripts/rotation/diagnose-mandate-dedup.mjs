#!/usr/bin/env node
/**
 * IW-K02 / #472 — diagnose mandate dedup.
 * Stable key so retries do not fan out duplicate MECE diagnose seats.
 *
 * Key formula (documented):
 *   sha256(wave|round|lane|model|briefDigest|tip).slice(0, 16)
 *
 * Usage:
 *   node scripts/rotation/diagnose-mandate-dedup.mjs key '{"wave":50,"round":0,"lane":"L1",...}'
 *   node scripts/rotation/diagnose-mandate-dedup.mjs claim --ledger tmp/diagnose-mandates.json --key <k> --meta '{...}'
 *   node scripts/rotation/diagnose-mandate-dedup.mjs help
 *
 * Active claims expire after TTL so SIGKILL/OOM cannot false-green retries.
 * TTL ms: options.ttlMs | LIMINAL_MANDATE_TTL_MS | LIMINAL_HARNESS_TIMEOUT+120s | 1320000
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

/** Default: harness timeout 20m + 2m slack (ms). Overridable via LIMINAL_MANDATE_TTL_MS. */
export const DEFAULT_MANDATE_TTL_MS = 1_320_000;

export function resolveMandateTtlMs(overrideMs) {
  if (typeof overrideMs === 'number' && Number.isFinite(overrideMs) && overrideMs > 0) return overrideMs;
  const envTtl = Number(process.env.LIMINAL_MANDATE_TTL_MS);
  if (Number.isFinite(envTtl) && envTtl > 0) return envTtl;
  const harness = Number(process.env.LIMINAL_HARNESS_TIMEOUT);
  if (Number.isFinite(harness) && harness > 0) return harness + 120_000;
  return DEFAULT_MANDATE_TTL_MS;
}

export function isActiveClaimStale(entry, nowMs = Date.now(), ttlMs = resolveMandateTtlMs()) {
  if (!entry || entry.status !== 'active') return false;
  const claimedAt = Date.parse(entry.claimedAt || '');
  if (!Number.isFinite(claimedAt)) return true; // corrupt → allow reclaim
  return nowMs - claimedAt > ttlMs;
}

export function briefDigest(briefText = '') {
  return createHash('sha256').update(String(briefText)).digest('hex').slice(0, 16);
}

/**
 * @param {{ wave?: string|number, round?: string|number, lane?: string, model?: string, briefDigest?: string, brief?: string, tip?: string }} parts
 */
export function mandateKey(parts = {}) {
  const dig =
    parts.briefDigest ||
    (parts.brief != null ? briefDigest(parts.brief) : '') ||
    '';
  const raw = [
    parts.wave ?? '',
    parts.round ?? '',
    parts.lane ?? '',
    parts.model ?? '',
    dig,
    parts.tip ?? '',
  ].join('|');
  return createHash('sha256').update(raw).digest('hex').slice(0, 16);
}

function loadLedger(ledgerPath) {
  try {
    if (existsSync(ledgerPath)) {
      const j = JSON.parse(readFileSync(ledgerPath, 'utf8'));
      if (j && typeof j === 'object' && j.entries && typeof j.entries === 'object') return j;
    }
  } catch {
    /* empty */
  }
  return { version: 1, entries: {} };
}

function saveLedger(ledgerPath, ledger) {
  mkdirSync(dirname(ledgerPath), { recursive: true });
  writeFileSync(ledgerPath, JSON.stringify(ledger, null, 2) + '\n', 'utf8');
}

/**
 * Claim a mandate key. Same key already active → not claimed (dedup hit).
 * @returns {{ claimed: boolean, dedup_hit: boolean, key: string, entry?: object }}
 */
/**
 * Claim a mandate key.
 * Active + fresh → dedup hit.
 * Active + stale (past TTL) → re-claim (expired leak from SIGKILL/OOM).
 * @param {string} ledgerPath
 * @param {string} key
 * @param {object} meta
 * @param {{ ttlMs?: number, nowMs?: number }} [options]
 */
export function claimMandate(ledgerPath, key, meta = {}, options = {}) {
  const k = String(key || '');
  if (!k) throw new Error('mandate key required');
  const ttlMs = resolveMandateTtlMs(options.ttlMs);
  const nowMs = typeof options.nowMs === 'number' ? options.nowMs : Date.now();
  const ledger = loadLedger(ledgerPath);
  const existing = ledger.entries[k];
  if (existing && existing.status === 'active' && !isActiveClaimStale(existing, nowMs, ttlMs)) {
    return { claimed: false, dedup_hit: true, key: k, entry: existing, expired: false };
  }
  const expired = Boolean(existing && existing.status === 'active' && isActiveClaimStale(existing, nowMs, ttlMs));
  const entry = {
    status: 'active',
    claimedAt: new Date(nowMs).toISOString(),
    ...meta,
    ...(expired ? { reclaimedAfterExpiry: true } : {}),
  };
  ledger.entries[k] = entry;
  saveLedger(ledgerPath, ledger);
  return { claimed: true, dedup_hit: false, key: k, entry, expired };
}

export function releaseMandate(ledgerPath, key) {
  const ledger = loadLedger(ledgerPath);
  const k = String(key || '');
  if (ledger.entries[k]) {
    ledger.entries[k] = {
      ...ledger.entries[k],
      status: 'released',
      releasedAt: new Date().toISOString(),
    };
    saveLedger(ledgerPath, ledger);
    return { released: true, key: k };
  }
  return { released: false, key: k };
}

function main(argv) {
  const cmd = argv[2];
  if (cmd === 'key') {
    const parts = JSON.parse(argv[3] || '{}');
    process.stdout.write(JSON.stringify({ key: mandateKey(parts), briefDigest: parts.briefDigest || briefDigest(parts.brief || '') }) + '\n');
    return;
  }
  if (cmd === 'claim') {
    let ledger = 'tmp/diagnose-mandates.json';
    let key = '';
    let meta = {};
    for (let i = 3; i < argv.length; i++) {
      if (argv[i] === '--ledger') ledger = argv[++i];
      else if (argv[i] === '--key') key = argv[++i];
      else if (argv[i] === '--meta') meta = JSON.parse(argv[++i] || '{}');
    }
    const r = claimMandate(resolve(process.cwd(), ledger), key, meta);
    process.stdout.write(JSON.stringify(r) + '\n');
    process.exit(r.claimed ? 0 : 3); // 3 = dedup hit
    return;
  }
  if (cmd === 'release') {
    let ledger = 'tmp/diagnose-mandates.json';
    let key = '';
    for (let i = 3; i < argv.length; i++) {
      if (argv[i] === '--ledger') ledger = argv[++i];
      else if (argv[i] === '--key') key = argv[++i];
    }
    const r = releaseMandate(resolve(process.cwd(), ledger), key);
    process.stdout.write(JSON.stringify(r) + '\n');
    process.exit(r.released ? 0 : 1);
    return;
  }
  if (cmd === 'help' || !cmd) {
    process.stdout.write(
      'diagnose-mandate-dedup: key | claim | release --ledger PATH --key K [--meta JSON]\n' +
        'Key = sha256(wave|round|lane|model|briefDigest|tip).slice(0,16)\n',
    );
    return;
  }
  console.error(`unknown command: ${cmd}`);
  process.exit(2);
}

const isMain =
  process.argv[1] &&
  (process.argv[1].endsWith('diagnose-mandate-dedup.mjs') ||
    process.argv[1].includes('diagnose-mandate-dedup'));
if (isMain) main(process.argv);
