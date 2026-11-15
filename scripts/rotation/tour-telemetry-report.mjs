#!/usr/bin/env node
/**
 * H-TELEM-01: Tour telemetry report — historical + live home ledger / pack ledgers.
 *
 * Honest about forensic pre-T0 days (tourWaveId coverage 0%) — never rewrites history.
 *
 * Usage:
 *   node scripts/rotation/tour-telemetry-report.mjs --day 2026-07-28
 *   node scripts/rotation/tour-telemetry-report.mjs --wave 1
 *   node scripts/rotation/tour-telemetry-report.mjs --pack-dir .quality/tour/wave-1/generator-grok-agy
 *   node scripts/rotation/tour-telemetry-report.mjs --home   # all recent home lanes
 */
import { promises as fs } from 'node:fs';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '../..');
const DEFAULT_HOME = path.join(os.homedir(), '.sinter', 'telemetry', 'events');

export function parseArgs(argv) {
  const out = { day: null, wave: null, packDir: null, home: false, lanes: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--day' && argv[i + 1]) out.day = argv[++i];
    else if (argv[i] === '--wave' && argv[i + 1]) out.wave = String(argv[++i]);
    else if (argv[i] === '--pack-dir' && argv[i + 1]) out.packDir = path.resolve(argv[++i]);
    else if (argv[i] === '--home') out.home = true;
    else if (argv[i] === '--lanes' && argv[i + 1]) out.lanes = argv[++i].split(',').map((s) => s.trim());
  }
  return out;
}

function emptyHist() {
  return Object.create(null);
}

function bump(hist, key) {
  const k = key == null || key === '' ? '(null)' : String(key);
  hist[k] = (hist[k] || 0) + 1;
}

/**
 * Parse one JSONL file into rows (invalid lines counted).
 */
export function readJsonl(filePath) {
  if (!fsSync.existsSync(filePath)) return { rows: [], missing: true, badLines: 0 };
  const text = fsSync.readFileSync(filePath, 'utf8');
  const rows = [];
  let badLines = 0;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      rows.push(JSON.parse(line));
    } catch {
      badLines += 1;
    }
  }
  return { rows, missing: false, badLines };
}

/**
 * Summarize event rows for coverage metrics.
 */
export function summarizeEvents(rows, { waveFilter = null } = {}) {
  const byEvent = emptyHist();
  const gapClass = emptyHist();
  const mode = emptyHist();
  const seats = emptyHist();
  let withTourWaveId = 0;
  let withMode = 0;
  let withGapClass = 0;
  let usagePresentTrue = 0;
  let usagePresentFalse = 0;
  let productCandidates = [];
  let packCompletes = [];
  let evaluatorCases = 0;
  let n = 0;

  for (const row of rows) {
    const pl = row.payload && typeof row.payload === 'object' ? row.payload : {};
    const tourWaveId = pl.tourWaveId ?? row.tourWaveId ?? null;
    const wave = pl.wave ?? row.wave ?? null;
    if (waveFilter != null) {
      const wf = String(waveFilter);
      const tw = tourWaveId ? String(tourWaveId) : '';
      const wv = wave != null ? String(wave) : '';
      if (!tw.includes(`wave-${wf}`) && wv !== wf && !tw.startsWith(`wave-${wf}@`)) {
        // also accept exact wave number match only
        if (wv !== wf) continue;
      }
    }
    n += 1;
    const event = row.event || pl.event || '(unknown)';
    bump(byEvent, event);
    bump(seats, pl.seat ?? row.domain ?? row.role ?? '(null)');

    if (tourWaveId) withTourWaveId += 1;
    const m = pl.mode ?? row.mode ?? null;
    if (m != null && m !== '') {
      withMode += 1;
      bump(mode, m);
    } else {
      bump(mode, '(null)');
    }
    const gc = pl.gapClass ?? row.gapClass ?? null;
    if (gc) {
      withGapClass += 1;
      bump(gapClass, gc);
    }

    const up = pl.usagePresent;
    if (up === true) usagePresentTrue += 1;
    else if (up === false) usagePresentFalse += 1;

    if (pl.productCandidate === true) {
      productCandidates.push(pl.taskId || row.episodeId || 'unknown');
    }
    if (event === 'seat.pack_complete') {
      packCompletes.push({
        seat: pl.seat,
        mode: pl.mode,
        northStar: pl.northStar,
        tourWaveId: pl.tourWaveId,
        productCandidates: pl.productCandidates || [],
      });
    }
    // H-TELEM-02: planted cases live in eval/ lane as eval.planted_case
    // (legacy seat.evaluator_case counted if any early builds wrote it)
    if (event === 'eval.planted_case' || event === 'seat.evaluator_case') evaluatorCases += 1;
  }

  return {
    n,
    byEvent,
    seats,
    gapClass,
    mode,
    tourWaveIdCoverage: n === 0 ? null : withTourWaveId / n,
    modeCoverage: n === 0 ? null : withMode / n,
    gapClassCoverage: n === 0 ? null : withGapClass / n,
    usagePresent: { true: usagePresentTrue, false: usagePresentFalse },
    productCandidates,
    packCompletes,
    evaluatorCases,
    forensic: n > 0 && withTourWaveId === 0,
  };
}

export async function reportHomeDay(homeBase, day, lanes) {
  const laneList = lanes || ['seat', 'eval', 'generation', 'harness', 'infra'];
  const report = { schema: 'sinter-tour-telemetry-report-v1', source: 'home', day, lanes: {} };
  for (const lane of laneList) {
    const file = path.join(homeBase, lane, `${day}.jsonl`);
    const { rows, missing, badLines } = readJsonl(file);
    report.lanes[lane] = {
      file,
      missing,
      badLines,
      ...summarizeEvents(rows),
    };
  }
  return report;
}

export async function reportPackDir(packDir) {
  const ledgerSeat = path.join(packDir, 'ledger', 'seat');
  const summaryPath = path.join(packDir, 'summary.json');
  let summary = null;
  if (fsSync.existsSync(summaryPath)) {
    try {
      summary = JSON.parse(fsSync.readFileSync(summaryPath, 'utf8'));
    } catch {
      summary = null;
    }
  }
  const rows = [];
  if (fsSync.existsSync(ledgerSeat)) {
    for (const name of fsSync.readdirSync(ledgerSeat)) {
      if (!name.endsWith('.jsonl')) continue;
      const { rows: r } = readJsonl(path.join(ledgerSeat, name));
      rows.push(...r);
    }
  }
  // also receipts metrics
  const receiptsDir = path.join(packDir, 'receipts');
  const receiptMeta = [];
  if (fsSync.existsSync(receiptsDir)) {
    for (const name of fsSync.readdirSync(receiptsDir)) {
      if (!name.endsWith('.json') || name.includes('envelope') || name.includes('-plan')) continue;
      try {
        const rec = JSON.parse(fsSync.readFileSync(path.join(receiptsDir, name), 'utf8'));
        receiptMeta.push({
          taskId: rec.taskId || name.replace(/\.json$/, ''),
          verdict: rec.verdict,
          domain: rec.extra?.domain ?? null,
          gapClass: rec.metrics?.gapClass ?? rec.extra?.gapClass ?? null,
          productCandidate: rec.extra?.raw?.productCandidate ?? rec.metrics?.productCandidate ?? null,
        });
      } catch {
        /* skip */
      }
    }
  }
  return {
    schema: 'sinter-tour-telemetry-report-v1',
    source: 'pack',
    packDir,
    summary: summary
      ? {
          mode: summary.mode,
          northStar: summary.northStar?.value ?? summary.metrics?.northStar ?? null,
          seat: summary.seat,
          model: summary.model,
          join: summary.join || null,
          fixedJudge: summary.fixedJudge || null,
        }
      : null,
    ledger: summarizeEvents(rows),
    receipts: receiptMeta,
  };
}

export async function reportWave(homeBase, wave, packRoot) {
  const w = String(wave);
  // scan home seat days
  const seatDir = path.join(homeBase, 'seat');
  const homeRows = [];
  if (fsSync.existsSync(seatDir)) {
    for (const name of fsSync.readdirSync(seatDir)) {
      if (!name.endsWith('.jsonl')) continue;
      const { rows } = readJsonl(path.join(seatDir, name));
      homeRows.push(...rows);
    }
  }
  const packs = [];
  const root = packRoot || path.join(REPO, '.quality', 'tour', `wave-${w}`);
  if (fsSync.existsSync(root)) {
    for (const name of fsSync.readdirSync(root)) {
      const p = path.join(root, name);
      if (!fsSync.statSync(p).isDirectory()) continue;
      if (!fsSync.existsSync(path.join(p, 'summary.json'))) continue;
      packs.push(await reportPackDir(p));
    }
  }
  return {
    schema: 'sinter-tour-telemetry-report-v1',
    source: 'wave',
    wave: w,
    homeSeat: summarizeEvents(homeRows, { waveFilter: w }),
    packs,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const homeBase = process.env.LIMINAL_TELEMETRY_HOME || DEFAULT_HOME;
  let report;
  if (args.packDir) {
    report = await reportPackDir(args.packDir);
  } else if (args.wave) {
    report = await reportWave(homeBase, args.wave);
  } else if (args.day) {
    report = await reportHomeDay(homeBase, args.day, args.lanes);
  } else if (args.home) {
    // last 3 days of seat if present
    const seatDir = path.join(homeBase, 'seat');
    const days = fsSync.existsSync(seatDir)
      ? fsSync.readdirSync(seatDir).filter((f) => f.endsWith('.jsonl')).map((f) => f.replace(/\.jsonl$/, '')).sort().slice(-3)
      : [];
    report = { schema: 'sinter-tour-telemetry-report-v1', source: 'home-multi', days: {} };
    for (const d of days) {
      report.days[d] = await reportHomeDay(homeBase, d, args.lanes);
    }
  } else {
    console.error('Usage: --day YYYY-MM-DD | --wave N | --pack-dir PATH | --home');
    process.exit(2);
  }
  console.log(JSON.stringify(report, null, 2));
}

const isMain = process.argv[1] && path.resolve(process.argv[1]).endsWith('tour-telemetry-report.mjs');
if (isMain) {
  main().catch((err) => {
    console.error('[tour-telemetry-report] FATAL', err);
    process.exit(1);
  });
}
