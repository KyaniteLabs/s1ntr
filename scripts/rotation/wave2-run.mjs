#!/usr/bin/env node
/**
 * Wave 2 full battery orchestration — driven by tour-seat-live-freeze.json wave2 map.
 *
 * Current freeze (owner pin): K3 harness · Grok generator · GLM evaluator · Sol chat.
 * fixedJudge for gen/chat NS remains AGY Gemini (not a rotating seat).
 *
 * Usage:
 *   node scripts/rotation/wave2-run.mjs [--wave 2|3|4] [--max-tasks N]
 *   node scripts/rotation/wave2-run.mjs --wave 4          # freeze.wave4 seats
 *   node scripts/rotation/wave2-run.mjs --harness-smoke   # harness max-tasks=1
 *   node scripts/rotation/wave2-run.mjs --full-harness    # full harness pack
 *   node scripts/rotation/wave2-run.mjs --skip-harness
 *   node scripts/rotation/wave2-run.mjs --skip-generator|--skip-evaluator|--skip-chat|--skip-harness
 *   node scripts/rotation/wave2-run.mjs --only-seat generator
 *   node scripts/rotation/wave2-run.mjs --resume-stamp 2026-07-29T05-00-00
 *   node scripts/rotation/wave2-run.mjs --dry-resolve     # print argv only
 *   node scripts/rotation/wave2-run.mjs --sequential      # debug only; default is PARALLEL
 *
 * Default: all active seats run as **real parallel child processes** so gen/eval/chat/harness
 * contend on cliproxy, home ledger, disk, and auth the way a live tour must observe.
 *
 * Kill-switch: LIMINAL_WAVE_SPEND=0 (or false/off/no) → hard stop before any seat spend.
 */
import { promises as fs } from 'node:fs';
import fsSync from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadGrokOidcAuth } from './grok-auth.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '../..');
const FREEZE_PATH = path.join(REPO, 'docs/agents/waves/tour-seat-live-freeze.json');
const WAVE2_QUALITY = path.join(REPO, '.quality', 'tour', 'wave-2');
const CLI_PATH = path.join(__dirname, 'cli.mjs');

export const SEAT_ORDER = ['generator', 'evaluator', 'chat', 'harness'];

/** Brain → default model + transport flags for rotation CLI. */
const BRAIN_TRANSPORT = {
  Grok: {
    model: 'grok-4.6',
    flags: ['--auth', 'grok', '--model', 'grok-4.6'],
  },
  K3: {
    model: 'kimi-k3',
    flags: ['--model', 'kimi-k3', '--base-url', 'http://localhost:8317/v1'],
  },
  GLM: {
    model: 'glm-5.2',
    flags: ['--model', 'glm-5.2:latest', '--base-url', 'http://localhost:11434/v1'],
  },
  Sol: {
    model: 'gpt-5.6-sol',
    flags: ['--model', 'gpt-5.6-sol', '--base-url', 'http://localhost:8317/v1', '--reasoning', 'high'],
  },
  GeminiPro: {
    model: 'gemini-3.1-pro-low',
    flags: ['--model', 'gemini-3.1-pro-low', '--base-url', 'http://localhost:8317/v1'],
  },
  GeminiFlash: {
    model: 'gemini-3.6-flash-high',
    flags: ['--model', 'gemini-3.6-flash-high', '--base-url', 'http://localhost:8317/v1'],
  },
};

/**
 * Load freeze.waveN seat map (default wave 2 for back-compat).
 * @param {string} [freezePath]
 * @param {string|number} [wave=2]
 */
export function loadWaveSeatMap(freezePath = FREEZE_PATH, wave = 2) {
  const freeze = JSON.parse(fsSync.readFileSync(freezePath, 'utf8'));
  const key = `wave${wave}`;
  const block = freeze[key];
  if (!block?.harness || !block?.generator || !block?.evaluator || !block?.chat) {
    throw new Error(`freeze.${key} must define harness, generator, evaluator, chat brains`);
  }
  return {
    freeze,
    wave: String(wave),
    waveKey: key,
    seats: {
      harness: block.harness,
      generator: block.generator,
      evaluator: block.evaluator,
      chat: block.chat,
    },
    waveBlock: block,
    fixedJudge: freeze.fixedJudge || null,
  };
}

/** @deprecated use loadWaveSeatMap(path, 2) */
export function loadWave2SeatMap(freezePath = FREEZE_PATH) {
  return loadWaveSeatMap(freezePath, 2);
}

export function buildSeatArgv(seat, brain, { wave = '2', outDir, maxTasks = null, extra = [] } = {}) {
  const t = BRAIN_TRANSPORT[brain];
  if (!t) throw new Error(`unknown brain ${brain} for seat ${seat}`);
  const argv = [
    seat,
    '--live',
    '--wave',
    String(wave),
    ...t.flags,
    '--out',
    outDir,
    ...extra,
  ];
  if (maxTasks != null) argv.push('--max-tasks', String(maxTasks));
  return { argv, model: t.model, brain, label: `${seat}-${brain.toLowerCase()}-${t.model.replace(/\//g, '_')}` };
}

/** Hard kill-switch — any of 0/false/off/no (case-insensitive). */
export function isWaveSpendKilled(env = process.env) {
  const raw = env.LIMINAL_WAVE_SPEND;
  if (raw == null || raw === '') return false;
  const v = String(raw).trim().toLowerCase();
  return v === '0' || v === 'false' || v === 'off' || v === 'no';
}

/**
 * @param {string[]} argv
 */
export function parseArgs(argv) {
  let maxTasks = null;
  let harnessMode = 'full'; // full | smoke | skip
  let dryResolve = false;
  let resumeStamp = null;
  let onlySeat = null;
  let wave = 2;
  /** Default parallel — tour law: observe 4-role contention with other systems. */
  let concurrency = 'parallel'; // parallel | sequential
  /** @type {Set<string>} */
  const skipSeats = new Set();

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--max-tasks' && argv[i + 1]) maxTasks = Number.parseInt(argv[++i], 10);
    else if (a === '--wave' && argv[i + 1]) {
      wave = Number.parseInt(argv[++i], 10);
      if (!Number.isFinite(wave) || wave < 1) {
        throw new Error(`--wave must be a positive integer, got ${argv[i]}`);
      }
    } else if (a === '--harness-smoke') harnessMode = 'smoke';
    else if (a === '--full-harness') harnessMode = 'full';
    else if (a === '--dry-resolve') dryResolve = true;
    else if (a === '--sequential') concurrency = 'sequential';
    else if (a === '--parallel') concurrency = 'parallel';
    else if (a === '--resume-stamp' && argv[i + 1]) resumeStamp = String(argv[++i]);
    else if (a === '--only-seat' && argv[i + 1]) {
      onlySeat = String(argv[++i]).toLowerCase();
      if (!SEAT_ORDER.includes(onlySeat)) {
        throw new Error(`--only-seat must be one of ${SEAT_ORDER.join('|')}, got ${onlySeat}`);
      }
    } else if (a === '--skip-harness') skipSeats.add('harness');
    else if (a === '--skip-generator') skipSeats.add('generator');
    else if (a === '--skip-evaluator') skipSeats.add('evaluator');
    else if (a === '--skip-chat') skipSeats.add('chat');
    else if (a.startsWith('--skip-') && a.length > 7) {
      const seat = a.slice('--skip-'.length).toLowerCase();
      if (!SEAT_ORDER.includes(seat)) {
        throw new Error(`unknown --skip seat: ${seat} (want ${SEAT_ORDER.join('|')})`);
      }
      skipSeats.add(seat);
    }
  }

  // --skip-harness + --harness-smoke: skip wins
  if (skipSeats.has('harness')) harnessMode = 'skip';

  return {
    maxTasks,
    harnessMode,
    dryResolve,
    resumeStamp,
    onlySeat,
    concurrency,
    skipSeats: [...skipSeats],
    wave,
  };
}

/** True if seat outDir already has a scorable live summary (resume skip). */
export function seatHasLiveSummary(outDir) {
  const summaryPath = path.join(outDir, 'summary.json');
  if (!fsSync.existsSync(summaryPath)) return false;
  try {
    const s = JSON.parse(fsSync.readFileSync(summaryPath, 'utf8'));
    return s?.mode === 'live';
  } catch {
    return false;
  }
}

export function hashFreezeFile(freezePath = FREEZE_PATH) {
  const body = fsSync.readFileSync(freezePath);
  return `sha256:${createHash('sha256').update(body).digest('hex')}`;
}

export function resolveGitTip(repo = REPO) {
  try {
    return execSync('git rev-parse HEAD', { cwd: repo, encoding: 'utf8' }).trim();
  } catch {
    return process.env.LIMINAL_TOUR_TIP || null;
  }
}

/**
 * Build ordered plan entries (run | skip with reason).
 * Pure enough for unit tests — no LLM.
 */
export function buildWave2Plan({
  seats,
  maxTasks = null,
  harnessMode = 'full',
  skipSeats = [],
  onlySeat = null,
  root,
  resume = false,
  wave = '2',
}) {
  const skip = new Set(skipSeats);
  const order = onlySeat ? SEAT_ORDER.filter((s) => s === onlySeat) : SEAT_ORDER;
  const plan = [];

  for (const seat of order) {
    const brain = seats[seat];
    const outDir = path.join(root, `${seat}-${String(brain).toLowerCase()}`);

    if (skip.has(seat) || (seat === 'harness' && harnessMode === 'skip')) {
      plan.push({
        seat,
        brain,
        skipped: true,
        skipReason: 'flag',
        label: `${seat}-${String(brain).toLowerCase()}-skipped`,
        outDir,
      });
      continue;
    }

    if (resume && seatHasLiveSummary(outDir)) {
      plan.push({
        seat,
        brain,
        skipped: true,
        skipReason: 'resume-live-summary',
        label: `${seat}-${String(brain).toLowerCase()}-resume-skip`,
        outDir,
      });
      continue;
    }

    let seatMax = maxTasks;
    if (seat === 'harness' && harnessMode === 'smoke') seatMax = 1;

    const built = buildSeatArgv(seat, brain, {
      outDir,
      maxTasks: seatMax,
      wave: String(wave),
    });
    // K3 high reasoning on generator/harness when seated
    if (brain === 'K3' && !built.argv.includes('--reasoning')) {
      built.argv.push('--reasoning', 'high');
    }
    plan.push({ seat, brain, skipped: false, outDir, ...built });
  }

  return plan;
}

export function buildCheckpoint({
  stamp,
  root,
  tip,
  freezeHash,
  seats,
  fixedJudge,
  plan,
  results = [],
  spendKilled = false,
}) {
  const done = [];
  const pending = [];
  const skipped = [];
  for (const step of plan) {
    if (step.skipped) {
      skipped.push({ seat: step.seat, reason: step.skipReason || 'flag', outDir: step.outDir });
      continue;
    }
    const r = results.find((x) => x.seat === step.seat || x.label === step.label);
    if (r && r.code === 0 && !r.skipped) {
      done.push({ seat: step.seat, outDir: step.outDir, label: step.label });
    } else if (r && r.skipped) {
      skipped.push({ seat: step.seat, reason: r.skipReason || 'skipped', outDir: step.outDir });
    } else {
      pending.push({ seat: step.seat, outDir: step.outDir, label: step.label });
    }
  }
  return {
    schema: 'sinter-wave2-checkpoint-v1',
    updatedAt: new Date().toISOString(),
    stamp,
    root,
    tip,
    freezeHash,
    seats,
    fixedJudge,
    spendKilled,
    done,
    pending,
    skipped,
    results: results.map((r) => ({
      seat: r.seat ?? null,
      label: r.label,
      code: r.code,
      skipped: Boolean(r.skipped),
      skipReason: r.skipReason || null,
    })),
  };
}

async function writeCheckpoint(root, checkpoint) {
  const p = path.join(root, 'wave2-checkpoint.json');
  await fs.writeFile(p, `${JSON.stringify(checkpoint, null, 2)}\n`);
  return p;
}

/** Serialize checkpoint writes when seats finish out of order. */
function createCheckpointLock() {
  let chain = Promise.resolve();
  return (fn) => {
    const run = chain.then(fn, fn);
    chain = run.then(() => undefined, () => undefined);
    return run;
  };
}

/**
 * Run one seat as a **separate Node process** (not in-process await).
 * Parallel processes share host systems: cliproxy, ~/.sinter ledger, disk, APIs.
 *
 * @param {{ seat: string, label: string, argv: string[], outDir?: string }} step
 * @param {{ tip?: string|null, wave?: string|number, stamp?: string, env?: NodeJS.ProcessEnv, spawnImpl?: typeof spawn }} opts
 */
export function runSeatChildProcess(step, opts = {}) {
  const {
    tip = null,
    wave = '2',
    stamp = '',
    env = process.env,
    spawnImpl = spawn,
  } = opts;
  const startedAt = Date.now();
  const logPath = step.outDir
    ? path.join(step.outDir, 'wave2-seat.log')
    : null;

  return new Promise((resolve) => {
    if (step.outDir) {
      try {
        fsSync.mkdirSync(step.outDir, { recursive: true });
      } catch {
        /* best effort */
      }
    }
    const logStream = logPath
      ? fsSync.createWriteStream(logPath, { flags: 'a' })
      : null;

    const childEnv = {
      ...env,
      LIMINAL_TOUR_WAVE: String(wave),
      LIMINAL_TOUR_TIP: tip || env.LIMINAL_TOUR_TIP || '',
      LIMINAL_WAVE_STAMP: stamp || env.LIMINAL_WAVE_STAMP || '',
      LIMINAL_TOUR_SEAT: step.seat,
    };

    console.log(`\n======== WAVE2 PARALLEL START ${step.label} ========`);
    console.log('[wave2-run] argv:', step.argv.join(' '));
    if (logPath) console.log('[wave2-run] seat log:', logPath);

    const child = spawnImpl(process.execPath, [CLI_PATH, ...step.argv], {
      cwd: REPO,
      env: childEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const pid = child.pid ?? null;
    console.log(`[wave2-run] ${step.seat} pid=${pid}`);

    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (buf) => {
      const s = buf.toString();
      stdout += s;
      process.stdout.write(`[${step.seat}] ${s}`);
      logStream?.write(s);
    });
    child.stderr?.on('data', (buf) => {
      const s = buf.toString();
      stderr += s;
      process.stderr.write(`[${step.seat}] ${s}`);
      logStream?.write(s);
    });

    child.on('error', (err) => {
      logStream?.end();
      console.error(`[wave2-run] ${step.seat} spawn error`, err);
      resolve({
        seat: step.seat,
        label: step.label,
        code: 1,
        argv: step.argv,
        pid,
        parallel: true,
        latencyMs: Date.now() - startedAt,
        error: err instanceof Error ? err.message : String(err),
      });
    });

    child.on('close', (code, signal) => {
      logStream?.end();
      const exitCode = code == null ? (signal ? 1 : 0) : code;
      console.log(
        `[wave2-run] PARALLEL END ${step.label} exit=${exitCode}`
          + (signal ? ` signal=${signal}` : '')
          + ` latencyMs=${Date.now() - startedAt}`,
      );
      resolve({
        seat: step.seat,
        label: step.label,
        code: exitCode,
        argv: step.argv,
        pid,
        parallel: true,
        latencyMs: Date.now() - startedAt,
        signal: signal || null,
        stdoutBytes: Buffer.byteLength(stdout),
        stderrBytes: Buffer.byteLength(stderr),
      });
    });
  });
}

/**
 * Execute plan: default all active seats in parallel (Promise.all).
 * Skipped seats recorded immediately. Checkpoint updated as each seat finishes.
 */
export async function executeWave2Plan(plan, {
  concurrency = 'parallel',
  tip = null,
  freezeHash = null,
  seats = null,
  fixedJudge = null,
  stamp = '',
  root = '',
  wave = '2',
  runSeat = runSeatChildProcess,
  writeCheckpointFn = writeCheckpoint,
} = {}) {
  const withLock = createCheckpointLock();
  /** @type {Map<string, object>} */
  const bySeat = new Map();

  const persist = async () => {
    if (!root) return;
    const results = SEAT_ORDER
      .filter((s) => bySeat.has(s))
      .map((s) => bySeat.get(s));
    // also include any non-order seats
    for (const [s, r] of bySeat) {
      if (!SEAT_ORDER.includes(s)) results.push(r);
    }
    await withLock(() => writeCheckpointFn(
      root,
      buildCheckpoint({
        stamp,
        root,
        tip,
        freezeHash,
        seats,
        fixedJudge,
        plan,
        results: [...bySeat.values()],
      }),
    ));
  };

  // Record skips first
  for (const step of plan) {
    if (step.skipped) {
      bySeat.set(step.seat, {
        seat: step.seat,
        label: step.label,
        code: 0,
        skipped: true,
        skipReason: step.skipReason,
        argv: ['(skipped)'],
        parallel: concurrency === 'parallel',
      });
      console.log(`[wave2-run] skip ${step.seat} reason=${step.skipReason}`);
    }
  }
  await persist();

  const active = plan.filter((s) => !s.skipped);
  if (active.length === 0) {
    return [...bySeat.values()];
  }

  if (concurrency === 'sequential') {
    for (const step of active) {
      const r = await runSeat(step, { tip, wave, stamp });
      bySeat.set(step.seat, r);
      await persist();
    }
  } else {
    console.log(
      `[wave2-run] PARALLEL fan-out seats=${active.map((s) => s.seat).join(',')}`
        + ` n=${active.length}`,
    );
    await Promise.all(
      active.map(async (step) => {
        const r = await runSeat(step, { tip, wave, stamp });
        bySeat.set(step.seat, r);
        await persist();
        return r;
      }),
    );
  }

  // Stable order in return
  return SEAT_ORDER.filter((s) => bySeat.has(s)).map((s) => bySeat.get(s));
}

async function main() {
  if (isWaveSpendKilled()) {
    console.error(
      '[wave2-run] HARD STOP: LIMINAL_WAVE_SPEND is off (0/false/off/no). '
        + 'Unset or set LIMINAL_WAVE_SPEND=1 to spend.',
    );
    process.exit(2);
  }

  const args = parseArgs(process.argv.slice(2));
  const { seats, fixedJudge, freeze, wave: waveStr, waveKey } = loadWaveSeatMap(
    FREEZE_PATH,
    args.wave,
  );
  const tip = resolveGitTip();
  const freezeHash = hashFreezeFile();

  const stamp = args.resumeStamp
    || new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const qualityRoot = path.join(REPO, '.quality', 'tour', `wave-${waveStr}`);
  const ROOT = path.join(qualityRoot, stamp);
  await fs.mkdir(ROOT, { recursive: true });

  console.log(`[wave2-run] freeze.${waveKey}`, JSON.stringify(seats));
  console.log('[wave2-run] fixedJudge', fixedJudge?.model, fixedJudge?.route);
  console.log(
    '[wave2-run] wave',
    waveStr,
    'concurrency',
    args.concurrency,
    'harnessMode',
    args.harnessMode,
    'maxTasks',
    args.maxTasks,
    'onlySeat',
    args.onlySeat,
    'skip',
    args.skipSeats,
    'resumeStamp',
    args.resumeStamp,
  );
  console.log('[wave2-run] tip', tip, 'freezeHash', freezeHash.slice(0, 20) + '…');
  if (args.concurrency === 'parallel') {
    console.log(
      '[wave2-run] mode=PARALLEL child processes — seats contend on host systems (ledger/cliproxy/APIs)',
    );
  }

  // Fail fast: Grok transport when seated and we will actually run Grok
  const planPreview = buildWave2Plan({
    seats,
    maxTasks: args.maxTasks,
    harnessMode: args.harnessMode,
    skipSeats: args.skipSeats,
    onlySeat: args.onlySeat,
    root: ROOT,
    resume: Boolean(args.resumeStamp),
    wave: waveStr,
  });
  const willRunGrok = planPreview.some(
    (s) => !s.skipped && seats[s.seat] === 'Grok',
  );
  let grokMeta = null;
  if (willRunGrok) {
    const grok = await loadGrokOidcAuth({ model: 'grok-4.5' });
    if (!process.env.XAI_API_KEY && !process.env.GROK_API_KEY && grok.apiKey) {
      process.env.XAI_API_KEY = grok.apiKey;
    }
    grokMeta = { keySource: grok.keySource, expiresAt: grok.expiresAt || null };
    console.log(
      `[wave2-run] Grok auth ok keySource=${grok.keySource}`
        + (grok.expiresAt ? ` expires=${grok.expiresAt}` : ''),
    );
  }

  const plan = planPreview;

  if (args.dryResolve) {
    const checkpoint = buildCheckpoint({
      stamp,
      root: ROOT,
      tip,
      freezeHash,
      seats,
      fixedJudge,
      plan,
      results: [],
    });
    console.log(JSON.stringify({
      root: ROOT,
      seats,
      tip,
      freezeHash,
      concurrency: args.concurrency,
      plan,
      checkpoint,
    }, null, 2));
    process.exit(0);
  }

  // Initial checkpoint (crash reattach)
  await writeCheckpoint(
    ROOT,
    buildCheckpoint({ stamp, root: ROOT, tip, freezeHash, seats, fixedJudge, plan, results: [] }),
  );

  process.env.LIMINAL_WAVE_STAMP = stamp;
  if (tip) process.env.LIMINAL_TOUR_TIP = tip;
  process.env.LIMINAL_TOUR_WAVE = waveStr;

  const results = await executeWave2Plan(plan, {
    concurrency: args.concurrency,
    tip,
    freezeHash,
    seats,
    fixedJudge,
    stamp,
    root: ROOT,
    wave: waveStr,
  });

  const report = {
    schema: 'sinter-wave2-run-report-v1',
    stamp,
    root: ROOT,
    tip,
    freezeHash,
    wave: waveStr,
    freezeKey: waveKey,
    seats,
    fixedJudge,
    grok: grokMeta,
    concurrency: args.concurrency,
    parallel: args.concurrency === 'parallel',
    harnessMode: args.harnessMode,
    onlySeat: args.onlySeat,
    skipSeats: args.skipSeats,
    resumeStamp: args.resumeStamp,
    results,
    wallClockNote:
      args.concurrency === 'parallel'
        ? 'wall ≈ max(seat latency); seats ran as concurrent child processes'
        : 'wall ≈ sum(seat latency); --sequential debug mode',
    ok: results.every((r) => r.code === 0),
  };
  await fs.writeFile(path.join(ROOT, 'wave2-run-report.json'), `${JSON.stringify(report, null, 2)}\n`);
  await writeCheckpoint(
    ROOT,
    buildCheckpoint({
      stamp,
      root: ROOT,
      tip,
      freezeHash,
      seats,
      fixedJudge,
      plan,
      results,
    }),
  );
  console.log('\n[wave2-run] report', JSON.stringify(report, null, 2));

  // OML-7: outer meta loop draft (harvest/claims/dreams/priors) unless disabled
  const outerOff = ['0', 'false', 'off', 'no'].includes(
    String(process.env.LIMINAL_OUTER_META || '1').trim().toLowerCase(),
  );
  if (!outerOff) {
    try {
      const { runOuterMetaLoop } = await import('./outer-meta-loop.mjs');
      const waveNum = waveStr;
      const meta = await runOuterMetaLoop({
        stampDir: ROOT,
        wave: waveNum,
        applyDocs: true,
        applyClaims: true,
        applyPriors: true,
        applyFreeze: false,
        dryRun: false,
      });
      console.log('[wave2-run] outer-meta-loop', JSON.stringify({
        claimsOpened: meta.claimsOpened,
        productCandidateCount: meta.productCandidateCount,
        harvest: meta.artifacts?.harvestPath,
      }));
      report.outerMeta = {
        claimsOpened: meta.claimsOpened,
        productCandidateCount: meta.productCandidateCount,
        metaDir: path.join(ROOT, 'outer-meta'),
      };
      await fs.writeFile(path.join(ROOT, 'wave2-run-report.json'), `${JSON.stringify(report, null, 2)}\n`);
    } catch (err) {
      console.error(
        '[wave2-run] outer-meta-loop failed (non-fatal):',
        err instanceof Error ? err.message : err,
      );
    }
  } else {
    console.log('[wave2-run] outer-meta-loop skipped (LIMINAL_OUTER_META=0)');
  }

  process.exit(report.ok ? 0 : 1);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]).endsWith('wave2-run.mjs');
if (isMain) {
  main().catch((err) => {
    console.error('[wave2-run] FATAL', err);
    process.exit(1);
  });
}
