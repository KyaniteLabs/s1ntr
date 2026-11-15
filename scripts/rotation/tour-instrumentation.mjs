#!/usr/bin/env node
/**
 * Tour instrumentation helpers (Wave 0 residual).
 *
 * Join keys, claim lifecycle, operator.invoke receipts, contention samples.
 * Pure-ish library + small CLI for preflight smoke.
 *
 * Usage:
 *   node scripts/rotation/tour-instrumentation.mjs self-check
 *   node scripts/rotation/tour-instrumentation.mjs sample-contention
 *   node scripts/rotation/tour-instrumentation.mjs operator-invoke --class market.status --exit 0 --ms 12
 *   node scripts/rotation/tour-instrumentation.mjs claim open --id TI-1 --status open
 */
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(__dirname, '../..');

export const TOUR_ID = 'umd-rotation-tour-4x4';
export const CLAIM_LEDGER_SCHEMA = 'sinter-tour-claim-ledger-v1';
export const DEFAULT_CLAIM_LEDGER = path.join(
  REPO_ROOT,
  'docs/agents/waves/tour-claim-ledger.json',
);
export const DEFAULT_TOUR_QUALITY_ROOT = path.join(REPO_ROOT, '.quality', 'tour');

/** Instrumentation claim ids seeded for Wave 0 → Wave 1 joinability. */
export const INSTRUMENTATION_CLAIM_IDS = ['TI-1', 'TI-2', 'TI-3', 'TI-4', 'TI-5'];

/**
 * @param {string|number} wave
 * @param {string} [tip]
 */
export function makeTourWaveId(wave, tip = 'unknown') {
  const w = String(wave ?? 'unset').replace(/[^0-9A-Za-z._-]/g, '');
  const short = String(tip || 'unknown').replace(/[^0-9a-fA-F]/g, '').slice(0, 8) || 'unknown';
  return `wave-${w}@${short}`;
}

/**
 * Stable MECE fingerprint for a finding title + optional path hints.
 * @param {{ title: string, seat?: string, pathHints?: string[] }} args
 */
export function claimFingerprint(args) {
  const title = String(args?.title || '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
  const seat = String(args?.seat || '').toLowerCase();
  const paths = (args?.pathHints || [])
    .map((p) => String(p).toLowerCase())
    .sort()
    .join('|');
  return createHash('sha256')
    .update(`${seat}\n${title}\n${paths}`)
    .digest('hex')
    .slice(0, 16);
}

/**
 * @param {{
 *   wave?: string|number|null,
 *   seat?: string|null,
 *   role?: string|null,
 *   model?: string|null,
 *   pipeHost?: string|null,
 *   tip?: string|null,
 *   tourId?: string|null,
 * }} opts
 */
export function resolveJoinKeys(opts = {}) {
  const wave = opts.wave ?? process.env.LIMINAL_TOUR_WAVE ?? null;
  const tip = opts.tip ?? process.env.LIMINAL_TOUR_TIP ?? null;
  const tourId = opts.tourId || process.env.LIMINAL_TOUR_ID || TOUR_ID;
  const seat = opts.seat ?? null;
  return {
    tourId,
    tourWaveId: wave != null ? makeTourWaveId(wave, tip || 'unknown') : null,
    wave: wave != null && wave !== '' ? Number.isNaN(Number(wave)) ? wave : Number(wave) : null,
    seat,
    role: opts.role ?? seat,
    model: opts.model ?? null,
    pipeHost: opts.pipeHost ?? null,
  };
}

/**
 * Non-destructive stamp: preserves original fields, adds `join`.
 * @template {Record<string, unknown>} T
 * @param {T} obj
 * @param {ReturnType<typeof resolveJoinKeys>} keys
 * @returns {T & { join: ReturnType<typeof resolveJoinKeys> }}
 */
export function stampJoinKeys(obj, keys) {
  return { ...obj, join: { ...keys } };
}

/**
 * Host only — never credentials.
 * @param {string|null|undefined} baseUrl
 */
export function pipeHostFromBaseUrl(baseUrl) {
  if (!baseUrl) return null;
  try {
    const u = new URL(baseUrl);
    return u.host || null;
  } catch {
    const s = String(baseUrl);
    return s.replace(/^https?:\/\//, '').split('/')[0] || s.slice(0, 64);
  }
}

/**
 * @param {string} [cwd]
 * @returns {string|null}
 */
export function resolveGitTip(cwd = REPO_ROOT) {
  const r = spawnSync('git', ['rev-parse', 'HEAD'], {
    cwd,
    encoding: 'utf8',
    timeout: 10_000,
  });
  if (r.status !== 0) return null;
  return (r.stdout || '').trim() || null;
}

/**
 * Disk free MiB + coarse load snapshot for factory contention diagnosis.
 * @param {{ cwd?: string, now?: () => Date }} [opts]
 */
export function sampleContention(opts = {}) {
  const cwd = opts.cwd || REPO_ROOT;
  const now = (opts.now || (() => new Date()))().toISOString();
  let freeMb = null;
  const df = spawnSync('df', ['-m', cwd], { encoding: 'utf8', timeout: 10_000 });
  if (df.status === 0) {
    const lines = (df.stdout || '').trim().split('\n');
    if (lines.length >= 2) {
      const parts = lines[1].split(/\s+/);
      freeMb = Number(parts[3]);
      if (Number.isNaN(freeMb)) freeMb = null;
    }
  }
  let loadAvg = null;
  try {
    loadAvg = os.loadavg?.() ?? null;
  } catch {
    loadAvg = null;
  }
  return {
    schema: 'sinter-tour-contention-v1',
    ts: now,
    freeMb,
    loadAvg,
    freememMb: Math.round(os.freemem() / (1024 * 1024)),
    totalmemMb: Math.round(os.totalmem() / (1024 * 1024)),
    platform: process.platform,
  };
}

/**
 * Append one operator.invoke receipt (JSONL).
 * @param {{
 *   commandClass: string,
 *   exitCode?: number|null,
 *   durationMs?: number|null,
 *   seat?: string|null,
 *   model?: string|null,
 *   pipeHost?: string|null,
 *   wave?: string|number|null,
 *   tip?: string|null,
 *   detail?: string|null,
 *   baseDir?: string,
 *   now?: () => Date,
 * }} args
 */
export function recordOperatorInvoke(args) {
  const baseDir = args.baseDir || DEFAULT_TOUR_QUALITY_ROOT;
  const tip = args.tip ?? resolveGitTip();
  const join = resolveJoinKeys({
    wave: args.wave,
    seat: args.seat,
    model: args.model,
    pipeHost: args.pipeHost,
    tip,
  });
  const rec = {
    schema: 'sinter-tour-operator-invoke-v1',
    ts: (args.now || (() => new Date()))().toISOString(),
    commandClass: String(args.commandClass || 'unknown'),
    exitCode: args.exitCode ?? null,
    durationMs: args.durationMs ?? null,
    detail: args.detail ? String(args.detail).slice(0, 240) : null,
    join,
  };
  const day = rec.ts.slice(0, 10);
  const filePath = path.join(baseDir, 'operator-invoke', `${day}.jsonl`);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.appendFileSync(filePath, `${JSON.stringify(rec)}\n`, 'utf8');
  return { filePath, record: rec };
}

/**
 * @param {string} [ledgerPath]
 */
export function readClaimLedger(ledgerPath = DEFAULT_CLAIM_LEDGER) {
  const raw = fs.readFileSync(ledgerPath, 'utf8');
  const j = JSON.parse(raw);
  if (j.schema !== CLAIM_LEDGER_SCHEMA || !Array.isArray(j.claims)) {
    throw new Error(`bad claim ledger schema at ${ledgerPath}`);
  }
  return j;
}

/**
 * Append claim lifecycle entry to ledger.lifecycle[] and optional JSONL.
 * Does not invent claim rows — only mutates status when claim id exists and action maps.
 *
 * @param {{
 *   action: 'open'|'claim'|'defer'|'merge'|'subtract'|'note',
 *   claimId: string,
 *   fingerprint?: string|null,
 *   seat?: string|null,
 *   model?: string|null,
 *   wave?: string|number|null,
 *   detail?: string|null,
 *   pr?: string|null,
 *   ledgerPath?: string,
 *   baseDir?: string,
 *   tip?: string|null,
 *   now?: () => Date,
 * }} args
 */
export function appendClaimLifecycle(args) {
  const ledgerPath = args.ledgerPath || DEFAULT_CLAIM_LEDGER;
  const tip = args.tip ?? resolveGitTip();
  const ts = (args.now || (() => new Date()))().toISOString();
  const join = resolveJoinKeys({
    wave: args.wave,
    seat: args.seat,
    model: args.model,
    tip,
  });
  const entry = {
    schema: 'sinter-tour-claim-lifecycle-v1',
    ts,
    action: args.action,
    claimId: String(args.claimId),
    fingerprint: args.fingerprint ?? null,
    detail: args.detail ? String(args.detail).slice(0, 400) : null,
    pr: args.pr ?? null,
    join,
  };

  const ledger = readClaimLedger(ledgerPath);
  if (!Array.isArray(ledger.lifecycle)) ledger.lifecycle = [];
  ledger.lifecycle.push(entry);

  const claim = ledger.claims.find((c) => c && c.id === args.claimId);
  if (claim) {
    if (args.action === 'claim' || args.action === 'open') claim.status = claim.status === 'merged' ? claim.status : 'open';
    if (args.action === 'defer') claim.status = 'deferred';
    if (args.action === 'merge') {
      claim.status = 'merged';
      if (args.pr) claim.pr = args.pr;
    }
    if (args.action === 'subtract') claim.status = 'subtracted';
    claim.updatedAt = ts;
  }

  fs.writeFileSync(ledgerPath, `${JSON.stringify(ledger, null, 2)}\n`, 'utf8');

  const baseDir = args.baseDir || DEFAULT_TOUR_QUALITY_ROOT;
  const day = ts.slice(0, 10);
  const jsonl = path.join(baseDir, 'claim-lifecycle', `${day}.jsonl`);
  fs.mkdirSync(path.dirname(jsonl), { recursive: true });
  fs.appendFileSync(jsonl, `${JSON.stringify(entry)}\n`, 'utf8');

  return { entry, ledgerPath, jsonl, claimFound: Boolean(claim) };
}

/**
 * Preflight / self-check: module + ledger schema + write probes under tmp.
 * @param {{ ledgerPath?: string, tmpRoot?: string }} [opts]
 */
export function instrumentationSelfCheck(opts = {}) {
  const errors = [];
  const ledgerPath = opts.ledgerPath || DEFAULT_CLAIM_LEDGER;
  try {
    const ledger = readClaimLedger(ledgerPath);
    const ids = new Set((ledger.claims || []).map((c) => c?.id).filter(Boolean));
    for (const id of INSTRUMENTATION_CLAIM_IDS) {
      if (!ids.has(id)) errors.push(`missing instrumentation claim ${id} in ledger`);
    }
  } catch (e) {
    errors.push(`ledger: ${e instanceof Error ? e.message : String(e)}`);
  }

  const join = resolveJoinKeys({
    wave: 0,
    seat: 'harness',
    model: 'self-check',
    pipeHost: 'localhost',
    tip: 'deadbeef',
  });
  if (!join.tourWaveId || !join.tourWaveId.startsWith('wave-0@')) {
    errors.push(`join keys malformed: ${JSON.stringify(join)}`);
  }

  const stamped = stampJoinKeys({ kind: 'test' }, join);
  if (!stamped.join?.tourId) errors.push('stampJoinKeys failed');

  const fp = claimFingerprint({ title: 'Example finding', seat: 'harness', pathHints: ['a'] });
  if (!/^[a-f0-9]{16}$/.test(fp)) errors.push(`fingerprint shape ${fp}`);

  const cont = sampleContention();
  if (cont.freeMb == null && process.platform !== 'win32') {
    // soft: still ok if df parse fails on odd platforms
  }

  const tmpRoot = opts.tmpRoot || path.join(os.tmpdir(), `sinter-tour-inst-${process.pid}`);
  fs.mkdirSync(tmpRoot, { recursive: true });
  try {
    const inv = recordOperatorInvoke({
      commandClass: 'self-check',
      exitCode: 0,
      durationMs: 1,
      seat: 'harness',
      wave: 0,
      tip: 'deadbeef',
      baseDir: tmpRoot,
    });
    if (!fs.existsSync(inv.filePath)) errors.push('operator-invoke write failed');
  } catch (e) {
    errors.push(`operator-invoke: ${e instanceof Error ? e.message : String(e)}`);
  }

  return {
    ok: errors.length === 0,
    errors,
    join,
    instrumentationClaimIds: INSTRUMENTATION_CLAIM_IDS,
  };
}

// --- CLI -------------------------------------------------------------------

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (!next || next.startsWith('--')) out[key] = true;
      else {
        out[key] = next;
        i++;
      }
    } else out._.push(a);
  }
  return out;
}

function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const cmd = args._[0] || 'self-check';

  if (cmd === 'self-check') {
    const r = instrumentationSelfCheck();
    console.log(JSON.stringify(r, null, 2));
    process.exit(r.ok ? 0 : 1);
  }

  if (cmd === 'sample-contention') {
    const s = sampleContention();
    console.log(JSON.stringify(s, null, 2));
    process.exit(0);
  }

  if (cmd === 'operator-invoke') {
    const r = recordOperatorInvoke({
      commandClass: args.class || args._[1] || 'unknown',
      exitCode: args.exit != null ? Number(args.exit) : 0,
      durationMs: args.ms != null ? Number(args.ms) : null,
      seat: args.seat || null,
      model: args.model || null,
      pipeHost: args.pipeHost || null,
      wave: args.wave ?? process.env.LIMINAL_TOUR_WAVE ?? null,
      detail: args.detail || null,
    });
    console.log(JSON.stringify({ ok: true, filePath: r.filePath, join: r.record.join }, null, 2));
    process.exit(0);
  }

  if (cmd === 'claim') {
    const action = args._[1] || args.action;
    const claimId = args.id || args._[2];
    if (!action || !claimId) {
      console.error('usage: claim <open|claim|defer|merge|subtract|note> --id TI-1 [--detail ...] [--pr ...]');
      process.exit(2);
    }
    const r = appendClaimLifecycle({
      action,
      claimId,
      fingerprint: args.fingerprint || null,
      seat: args.seat || null,
      model: args.model || null,
      wave: args.wave ?? process.env.LIMINAL_TOUR_WAVE ?? null,
      detail: args.detail || null,
      pr: args.pr || null,
    });
    console.log(JSON.stringify({ ok: true, claimFound: r.claimFound, entry: r.entry }, null, 2));
    process.exit(0);
  }

  console.error(`unknown command: ${cmd}`);
  process.exit(2);
}

const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) main();
