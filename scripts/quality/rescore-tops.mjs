// Re-score report (and, with --persist, re-normalization) for visual archive entries.
//
// Builds must run first so this script uses the compiled runtime under dist/.
// Default and --floors modes are READ-ONLY. --persist mutates ONLY through
// QualityArchive.rescoreEntry (class-mutation rule) after writing a timestamped
// backup of the archive file, and verifies by reloading.
//
// Flags:
//   --floors   re-score the BOTTOM-2 non-quarantined entries per visual domain
//              and emit each record with `position: "floor"`.
//   --all      re-score EVERY non-quarantined entry per visual domain.
//   --domain <d[,d2]>  restrict to the given visual domain(s) (default: all).
//   --persist  write fresh scores back via QualityArchive.rescoreEntry.
//              PAUSE the self-improve daemon first — concurrent saves race.
//              (Simon-approved re-normalization, 2026-06-12.)

import { randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';
import { withEvaluatorScope } from '../../dist/core/EvaluatorScope.js';
import { runProductionCliProviderEffect } from '../../dist/cli/LiminalProductionProviderEffect.js';
import fs from 'node:fs/promises';
import { QualityArchive } from '../../dist/learning/QualityArchive.js';
import { eventBus } from '../../dist/core/EventBus.js';
import { HeadlessRenderer } from '../../dist/render/HeadlessRenderer.js';
import { resolveChromiumExecutablePath, allDegradedGuard } from '../../dist/utils/browserAssetFallbacks.js';
import { scoreRenderedEvidence } from '../../dist/core/ScoringEngine.js';

const VISUAL_DOMAINS = ['p5', 'glsl', 'three', 'hydra', 'svg', 'ascii', 'textgen', 'kinetic'];
const TOP_N = 2;
let flags;
try {
  ({ values: flags } = parseArgs({ options: { floors: { type: 'boolean' }, all: { type: 'boolean' },
    persist: { type: 'boolean' }, domain: { type: 'string' }, 'max-provider-calls': { type: 'string' } } }));
} catch (error) { console.error(`[rescore] ${error.message}`); process.exit(2); }
const { floors: FLOORS_MODE, all: ALL_MODE, persist: PERSIST } = flags;
const domains = flags.domain?.split(',').map(d => d.trim()) ?? VISUAL_DOMAINS;
if (domains.some(d => !VISUAL_DOMAINS.includes(d))) {
  console.error(`[rescore] unknown visual domain (known: ${VISUAL_DOMAINS.join(', ')})`);
  process.exit(1);
}
const DOMAINS = VISUAL_DOMAINS.filter(d => domains.includes(d));
const cap = Number(flags['max-provider-calls']);
if (flags['max-provider-calls'] !== undefined && (!Number.isSafeInteger(cap) || cap < 1)) {
  console.error('[rescore] --max-provider-calls requires a positive integer');
  process.exit(2);
}
let remaining = flags['max-provider-calls'] === undefined ? Infinity : cap;
let exhausted = false;

// EventBus normally mirrors LLM timing events to stdout; this report's stdout
// contract is newline-delimited JSON, so suppress those process-wide event logs.
eventBus.enableTuiMode();

function isNonQuarantined(entry) {
  return !(entry && entry.metadata && entry.metadata.quarantinedAt);
}

function rankedEntriesForDomain(archives, domain, { ascending }) {
  const entries = Array.isArray(archives[domain]) ? archives[domain] : [];
  return entries
    .filter(isNonQuarantined)
    .map((entry, index) => ({ entry, index }))
    .sort((a, b) => {
      const scoreDelta = ascending
        ? (a.entry.qualityScore ?? 0) - (b.entry.qualityScore ?? 0)
        : (b.entry.qualityScore ?? 0) - (a.entry.qualityScore ?? 0);
      return scoreDelta || a.index - b.index;
    })
    .slice(0, TOP_N)
    .map(({ entry }) => entry);
}

function topEntriesForDomain(archives, domain) {
  return rankedEntriesForDomain(archives, domain, { ascending: false });
}

function floorEntriesForDomain(archives, domain) {
  return rankedEntriesForDomain(archives, domain, { ascending: true });
}

function roundScore(value) {
  return Math.round(value * 10000) / 10000;
}

async function readArchiveData() {
  const archivePath = process.env.QUALITY_ARCHIVE_PATH ?? QualityArchive.DEFAULT_PATH;
  let raw;
  try { raw = await fs.readFile(archivePath, 'utf-8'); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    console.error(`[rescore] no quality archive at ${archivePath}; nothing to re-score`);
    return null;
  }
  const data = JSON.parse(raw);
  return data && typeof data.archives === 'object' && data.archives ? data.archives : {};
}

// Preflight: verify Playwright chromium is available before doing any work.
// If the browser binary is missing, every evaluation will short-circuit to
// failureClass='infra', score=0 — silently producing 16 all-zero records.
// Detecting the missing binary early lets operators fix it (npx playwright install
// chromium) before wasting API quota on synthetic zeros.
//
// Uses the shared resolveChromiumExecutablePath() resolver so preflight and
// HeadlessRenderer agree on the same multi-tier fallback chain (override,
// playwright default, PLAYWRIGHT_BROWSERS_PATH scan).
async function checkChromiumPreflight() {
  const resolved = resolveChromiumExecutablePath();
  if (resolved) return; // browser found

  // Build a useful diagnostic message.
  const override = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
  if (override) {
    console.error(`[rescore] FATAL: PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH set but not found: ${override}`);
  } else {
    const browsersPath = process.env.PLAYWRIGHT_BROWSERS_PATH ?? '/opt/pw-browsers';
    console.error(`[rescore] FATAL: No Chromium binary found.`);
    console.error(`[rescore]   Checked: PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH (not set)`);
    console.error(`[rescore]   Checked: playwright default (not present)`);
    console.error(`[rescore]   Checked: ${browsersPath}/chromium*/chrome-linux/chrome (not found)`);
  }
  console.error('[rescore] Fix: npx playwright install chromium');
  process.exit(1);
}

const stampDate = new Date().toISOString().slice(0, 10);
const archives = await readArchiveData();
if (archives === null) process.exit(0);

// Preflight check before any scoring work.
await checkChromiumPreflight();

const selected = new Map();
for (const domain of DOMAINS) {
  const entries = ALL_MODE
    ? (Array.isArray(archives[domain]) ? archives[domain] : []).filter(isNonQuarantined)
    : FLOORS_MODE
      ? floorEntriesForDomain(archives, domain)
      : topEntriesForDomain(archives, domain);
  if (!ALL_MODE && entries.length < TOP_N) {
    console.error(`[rescore] RESCORE_ARCHIVE_TOO_SMALL: expected ${TOP_N} non-quarantined ${domain} entries, found ${entries.length}`);
    process.exit(2);
  }
  selected.set(domain, entries);
}
if (![...selected.values()].some(entries => entries.length)) process.exit(0);

const renderer = new HeadlessRenderer();

let persistArchive = null;
if (PERSIST) {
  const archivePath = process.env.QUALITY_ARCHIVE_PATH ?? QualityArchive.DEFAULT_PATH;
  const backupPath = `${archivePath}.bak-renorm-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  await fs.copyFile(archivePath, backupPath);
  console.error(`[persist] backup written: ${backupPath}`);
  persistArchive = new QualityArchive({ path: archivePath });
  await persistArchive.load();
}

// Track honest evidence vs. infra-degraded so we can fail closed on 100% degradation.
let totalEntries = 0;
let honestEntries = 0;

try {
  for (const [domain, entries] of selected) {
    for (const entry of entries) {
      totalEntries++;
      const evidence = await renderer.renderWithEvidence(entry.output, { domain });
      const idempotencyKey = `archive-rescore:${randomUUID()}`;
      const evaluation = await withEvaluatorScope(call => {
        if (remaining <= 0) {
          exhausted = true;
          throw new Error('RESCORE_PROVIDER_CAP_EXHAUSTED');
        }
        remaining--;
        return runProductionCliProviderEffect({ role: 'evaluator', idempotencyKey,
          binding: { surface: 'cli-rescore', domain, entry: entry.id, prompt: entry.prompt, output: entry.output },
          effect: call });
      }, () => scoreRenderedEvidence(
        evidence,
        entry.output,
        entry.prompt ?? `Archive ${domain} entry ${entry.id}`,
        undefined,
        domain,
      ));
      const stored = roundScore(entry.qualityScore ?? 0);
      const fresh = roundScore(evaluation.score ?? 0);
      // Sol L3-03: an unscored verdict (parse/scorer/infra) carries a placeholder number, never a grade.
      const unscored = evaluation.scoreState === 'unscored'
        || evaluation.failureClass === 'parse' || evaluation.failureClass === 'scorer'
        || evaluation.failureClass === 'infra';
      const record = {
        id: entry.id,
        domain,
        stored,
        fresh: unscored ? null : fresh,
        delta: unscored ? null : roundScore(fresh - stored),
        failureClass: evaluation.failureClass ?? 'none',
        scoreState: unscored ? 'unscored' : 'scored',
        ...(evaluation.unscoredReason ? { unscoredReason: evaluation.unscoredReason } : {}),
      };
      if (FLOORS_MODE) {
        record.position = 'floor';
      }
      if (persistArchive && !unscored) {
        record.persisted = await persistArchive.rescoreEntry(
          entry.id, fresh, `banded-judge renorm ${stampDate}`,
        );
      } else if (persistArchive) {
        record.persisted = false;
        record.skipReason = evaluation.failureClass;
      }
      console.log(JSON.stringify(record));

      // Honest evidence = a real verdict: failureClass 'none' (scored) or 'render' (the candidate
      // itself failed to render). Parse, scorer and infra outcomes gave no grade (Sol L3-03).
      const isHonest = !unscored;
      if (isHonest) {
        honestEntries++;
      }
    }
  }
} finally {
  await renderer.close();
}

if (persistArchive) {
  const verify = new QualityArchive({ path: process.env.QUALITY_ARCHIVE_PATH ?? QualityArchive.DEFAULT_PATH });
  await verify.load();
  const total = VISUAL_DOMAINS.reduce((n, d) => n + verify.getAll(d).length, 0);
  console.error(`[persist] reload-verify: ${total} visual entries present after re-normalization`);
}

// Fail closed when 100% of entries came back infra-degraded. The records are
// still printed (they're useful for debugging), but the non-zero exit signals
// that something is wrong and the cadence should NOT proceed silently.
const guard = allDegradedGuard(totalEntries, honestEntries);
if (guard.allDegraded) {
  console.error(guard.message);
  process.exit(1);
}

if (exhausted) { console.error('[rescore] RESCORE_PROVIDER_CAP_EXHAUSTED'); process.exitCode = 2; }
