#!/usr/bin/env node
/**
 * Wave 0 tour preflight — free/cheap checks only.
 * Exit 0 only if hard gates pass. Never starts tour cells.
 *
 * Usage: node scripts/rotation/tour-preflight.mjs [--write path]
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { evaluateFixedJudgeFreeze } from './shared.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../..');
// Default under .quality/ (gitignored) so writing the receipt cannot change
// computeProofSourceFingerprint and invalidate market studio/live smokes.
// Optional: --write docs/agents/waves/wave-0-tour-preflight.json for durable docs.
const writeIdx = process.argv.indexOf('--write');
const writePath =
  writeIdx >= 0
    ? path.resolve(process.argv[writeIdx + 1] || path.join(repoRoot, '.quality', 'tour', 'wave-0-tour-preflight.json'))
    : path.join(repoRoot, '.quality', 'tour', 'wave-0-tour-preflight.json');

const checks = [];

function add(id, ok, detail, severity = 'hard') {
  checks.push({ id, ok: Boolean(ok), detail: String(detail), severity });
}

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, {
    cwd: repoRoot,
    encoding: 'utf8',
    timeout: opts.timeout ?? 60_000,
    env: process.env,
  });
  return {
    status: r.status,
    stdout: (r.stdout || '').slice(0, 4000),
    stderr: (r.stderr || '').slice(0, 2000),
    error: r.error ? String(r.error.message || r.error) : null,
  };
}

// 1) git tip
const head = run('git', ['rev-parse', 'HEAD']);
const origin = run('git', ['rev-parse', 'origin/main']);
const synced = head.status === 0 && origin.status === 0 && head.stdout.trim() === origin.stdout.trim();
add('git-sync', synced, synced ? head.stdout.trim() : `HEAD=${head.stdout.trim()} origin=${origin.stdout.trim()}`, 'hard');

// 2) disk
const df = run('df', ['-m', repoRoot]);
let freeMb = null;
const lines = (df.stdout || '').trim().split('\n');
if (lines.length >= 2) {
  const parts = lines[1].split(/\s+/);
  // df -m: Filesystem 1M-blocks Used Available Capacity ...
  freeMb = Number(parts[3]);
}
add('disk-free-mb', freeMb != null && freeMb >= 2048, freeMb == null ? 'df parse fail' : `${freeMb} MiB free (need ≥2048)`, 'hard');

// 3) mece CLI must NOT start generation
const mece = run(process.execPath, [path.join(repoRoot, 'bin/sinter'), 'mece', 'manifest'], { timeout: 45_000 });
const meceLooksLikeGen = /Generating:|RalphLoop|Creative Coding Agent/i.test(mece.stdout + mece.stderr);
const meceOk =
  mece.status === 0 &&
  !meceLooksLikeGen &&
  (/"ok"\s*:\s*true/.test(mece.stdout) || /unowned/.test(mece.stdout) || /tracked/.test(mece.stdout) || mece.stdout.includes('{'));
add('mece-manifest-not-gen', meceOk, meceOk ? 'mece routed without paid gen' : `status=${mece.status} gen=${meceLooksLikeGen} out=${(mece.stdout || mece.stderr || mece.error || '').slice(0, 200)}`, 'hard');

// 4) image validate alias
const fixture = path.join(repoRoot, 'test/fixtures/images/attach-test.png');
const imgColon = run(process.execPath, [path.join(repoRoot, 'bin/sinter'), 'image:validate', fixture], { timeout: 45_000 });
const imgSpace = run(process.execPath, [path.join(repoRoot, 'bin/sinter'), 'image', 'validate', fixture], { timeout: 45_000 });
const imgGen = /Generating:|RalphLoop/i.test(imgColon.stdout + imgColon.stderr + imgSpace.stdout + imgSpace.stderr);
const imgOk =
  !imgGen &&
  (imgColon.status === 0 || imgSpace.status === 0) &&
  (/sha256|mime|attachment|ok/i.test(imgColon.stdout + imgSpace.stdout) || imgColon.status === 0 || imgSpace.status === 0);
add('image-validate-not-gen', imgOk && !imgGen, imgGen ? 'image validate fell into generation' : `colon=${imgColon.status} space=${imgSpace.status}`, 'hard');

// 5) claim ledger
const ledgerPath = path.join(repoRoot, 'docs/agents/waves/tour-claim-ledger.json');
let ledgerOk = false;
let ledgerDetail = 'missing';
try {
  const j = JSON.parse(fs.readFileSync(ledgerPath, 'utf8'));
  ledgerOk = j.schema === 'sinter-tour-claim-ledger-v1' && Array.isArray(j.claims);
  ledgerDetail = ledgerOk ? `claims=${j.claims.length}` : 'bad schema';
} catch (e) {
  ledgerDetail = e.message;
}
add('claim-ledger', ledgerOk, ledgerDetail, 'hard');

// 5b) tour instrumentation self-check (TI-5) — join keys + TI claims present
try {
  const inst = await import(path.join(repoRoot, 'scripts/rotation/tour-instrumentation.mjs'));
  const check = inst.instrumentationSelfCheck({ ledgerPath });
  add(
    'tour-instrumentation',
    check.ok,
    check.ok
      ? `TI-1..5 present; join=${check.join?.tourWaveId || 'ok'}`
      : (check.errors || []).join('; ').slice(0, 240),
    'hard',
  );
  if (check.ok) {
    try {
      inst.recordOperatorInvoke({
        commandClass: 'tour.preflight',
        exitCode: 0,
        durationMs: 0,
        seat: 'orchestrator',
        wave: 0,
        tip: (head.stdout || '').trim(),
        detail: 'preflight self-check',
      });
      const cont = inst.sampleContention({ cwd: repoRoot });
      add(
        'contention-sample',
        cont.freeMb == null || cont.freeMb >= 0,
        cont.freeMb == null ? 'freeMb=null' : `freeMb=${cont.freeMb}`,
        'soft',
      );
    } catch (e) {
      add('contention-sample', false, String(e.message || e), 'soft');
    }
  }
} catch (e) {
  add('tour-instrumentation', false, String(e.message || e), 'hard');
}

// 6) mocks free
const beauty = run(process.execPath, [path.join(repoRoot, 'scripts/rotation/beauty-v1.mjs'), '--mock'], { timeout: 30_000 });
add('beauty-mock', beauty.status === 0 && /"ok"\s*:\s*true/.test(beauty.stdout), beauty.stdout.slice(0, 120), 'soft');
const o1 = run(process.execPath, [path.join(repoRoot, 'scripts/mece/o1-image-slice.mjs')], { timeout: 30_000 });
add('o1-mock', o1.status === 0 && /"ok"\s*:\s*true/.test(o1.stdout), o1.stdout.slice(0, 120), 'soft');

// 7) seat freeze presence (config advisory if unreadable)
const seatFreeze = {
  Sol: 'gpt-5.6-sol high',
  Grok: 'grok high',
  GLM: 'claude-glm ultracode',
  K3: 'moonshotai/kimi-k3 high on kilo',
  K3Failsafe: 'kilo free model labeled kilo-free-failsafe',
};
add('seat-freeze-documented', true, JSON.stringify(seatFreeze), 'soft');

// Residual gates block Wave 1 until seats + market + free failsafe id are live.
const residual = [];
const freezePath = path.join(repoRoot, 'docs/agents/waves/tour-seat-live-freeze.json');
let freeze = null;
try {
  freeze = JSON.parse(fs.readFileSync(freezePath, 'utf8'));
} catch (e) {
  residual.push({ id: 'tour-seat-freeze-file', detail: String(e.message || e) });
}
const expected = {
  harness: 'gpt-5.6-sol',
  generator: 'grok-4.5',
  evaluator: 'moonshotai/kimi-k3',
  studio: 'glm-5.2',
};
// Check smoke receipts directly; `sinter market status` reports Wave 7/8 release truth.
const market = run(process.execPath, ['--input-type=module', '--eval', `
  import { collectRepositoryMarketReadinessStatus, formatMarketReadinessStatus } from './dist/market/MarketReadinessStatus.js';
  const status = collectRepositoryMarketReadinessStatus();
  console.log(formatMarketReadinessStatus(status));
  process.exit(status.ready ? 0 : 2);
`], { timeout: 30_000 });
const marketReady = market.status === 0 && /^Smoke checks: PASS$/m.test(market.stdout);
if (!marketReady) {
  residual.push({
    id: 'market-smoke-fresh',
    detail: (market.stdout || market.stderr || market.error || 'Smoke checks: FAIL').slice(0, 240),
  });
}
// Free failsafe id recorded
const freeId = freeze?.brains?.K3Failsafe?.model;
if (!freeId || freeId !== 'kilo-auto/free') {
  residual.push({
    id: 'kilo-free-failsafe-id',
    detail: `expected kilo-auto/free in tour-seat-live-freeze.json, got ${freeId || 'missing'}`,
  });
} else {
  add('kilo-free-failsafe-id', true, freeId, 'soft');
}
// Role models via freeze file wave1 map (config is local; freeze is SoT for probe results)
if (freeze?.brains) {
  const ok =
    freeze.brains.Sol?.model === expected.harness &&
    freeze.brains.Grok?.model === expected.generator &&
    freeze.brains.K3?.model === expected.evaluator &&
    freeze.brains.GLM?.model === expected.studio;
  add('tour-seats-live-config', ok, JSON.stringify({ expected, freeze: freeze.brains }), ok ? 'soft' : 'hard');
  if (!ok) residual.push({ id: 'tour-seats-live-config', detail: 'freeze file models mismatch expected tour brains' });

  // Law: Gemini models only via AGY/cliproxy — never Kilo (scan freeze + live roles if readable).
try {
  const freezeG = freeze?.brains || {};
  const geminiOnKilo = [];
  for (const [name, brain] of Object.entries(freezeG)) {
    const model = String(brain?.model || '');
    const pipe = String(brain?.pipe || '').toLowerCase();
    // Match real Kilo gateway hosts only — not the disclaimer "(not Kilo)".
    if (/gemini/i.test(model) && (pipe.includes('kilo.ai') || pipe.includes('api.kilo'))) {
      geminiOnKilo.push(`${name}:${model}`);
    }
  }
  // Live config check (best-effort)
  try {
    const home = process.env.HOME || process.env.USERPROFILE || '';
    const cfgPath = path.join(home, '.sinter', 'config.json');
    if (fs.existsSync(cfgPath)) {
      const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
      for (const [role, r] of Object.entries(cfg.roles || {})) {
        const model = String(r?.model || '');
        const base = String(r?.baseUrl || '').toLowerCase();
        if (/gemini/i.test(model) && (base.includes('kilo.ai') || base.includes('api.kilo'))) {
          geminiOnKilo.push(`live.${role}:${model}`);
        }
      }
    }
  } catch {
    /* ignore */
  }
  add(
    'gemini-agy-only',
    geminiOnKilo.length === 0,
    geminiOnKilo.length === 0
      ? 'no Gemini on Kilo in freeze/live roles'
      : `Gemini on Kilo forbidden: ${geminiOnKilo.join(', ')}`,
    'hard',
  );
} catch (e) {
  add('gemini-agy-only', false, String(e.message || e), 'hard');
}

// Law: Grok is direct xAI only — never Kilo gateway / x-ai/ slug.
  // Note: pipe text may say "not Kilo"; only treat kilo.ai / api.kilo as bad pipe.
  const grokPipe = String(freeze.brains.Grok?.pipe || '').toLowerCase();
  const grokModel = String(freeze.brains.Grok?.model || '');
  const pipeOnKilo = /(?:api\.)?kilo\.ai|kilo\s+https?:\/\//i.test(grokPipe);
  const grokDirect =
    grokPipe.includes('api.x.ai') &&
    !pipeOnKilo &&
    !grokModel.startsWith('x-ai/');
  add(
    'grok-direct-xai',
    grokDirect,
    `model=${grokModel} pipe=${freeze.brains.Grok?.pipe || 'missing'}`,
    'hard',
  );
  if (!grokDirect) {
    residual.push({
      id: 'grok-direct-xai',
      detail: 'Grok must be api.x.ai direct (model grok-4.5), not Kilo x-ai/grok-*',
    });
  }
} else {
  residual.push({ id: 'tour-seats-live-config', detail: 'no freeze brains' });
  // Without brains, doctrine checks for Gemini/Grok seats cannot run — hard-fail.
  add('gemini-agy-only', false, 'no freeze.brains — cannot verify Gemini not on Kilo', 'hard');
  add('grok-direct-xai', false, 'no freeze.brains — cannot verify Grok direct xAI', 'hard');
}

// T0-5: fixedJudge must be AGY/cliproxy Gemini (never Kilo) — pure helper + hard gate
const fj = freeze?.fixedJudge || freeze?.brains?.FixedJudge || null;
const fjEval = evaluateFixedJudgeFreeze(fj);
const fjStrict = fjEval.ok;
add('fixed-judge-agy', fjStrict, fjEval.detail, 'hard');
if (!fjStrict) {
  residual.push({
    id: 'fixed-judge-agy',
    detail: 'freeze.fixedJudge required: gemini-* with route=agy-cliproxy (never Kilo, including pipe)',
  });
}

// T1: operator path matrix residual (does not require paid gen)
const opDir = path.join(repoRoot, '.quality', 'tour', 'operator-invoke');
const requiredOps = freeze?.operatorMatrixRequired || [
  'provider.status',
  'market.status',
  'mece.manifest',
];
const seenOps = new Set();
try {
  if (fs.existsSync(opDir)) {
    for (const day of fs.readdirSync(opDir)) {
      if (!day.endsWith('.jsonl')) continue;
      const lines = fs.readFileSync(path.join(opDir, day), 'utf8').split('\n');
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const e = JSON.parse(line);
          if (e.commandClass) seenOps.add(e.commandClass);
        } catch {
          /* ignore */
        }
      }
    }
  }
} catch {
  /* ignore */
}
const missingOps = requiredOps.filter((c) => !seenOps.has(c));
if (missingOps.length) {
  residual.push({
    id: 'operator-matrix',
    detail: `missing operator.invoke classes: ${missingOps.join(', ')} (record via tour-instrumentation operator-invoke)`,
  });
  add('operator-matrix', false, missingOps.join(','), 'soft');
} else {
  add('operator-matrix', true, `ok ${requiredOps.join(',')}`, 'soft');
}

// H-TELEM-08: preferred operator surfaces (studio/bridge/chat) — soft report only,
// never blocks wave2Allowed (scoreboard ≠ front door; dogfood claims require these).
const preferredOps = freeze?.operatorMatrixPreferred || [
  'studio.smoke',
  'bridge.health',
  'chat.session',
];
const missingPreferred = preferredOps.filter((c) => !seenOps.has(c));
const preferredResidual = missingPreferred.map((c) => ({
  id: `operator-preferred:${c}`,
  detail: `preferred operator.invoke missing: ${c} (record for full dogfood; not wave2Allowed hard)`,
}));
if (missingPreferred.length) {
  add('operator-matrix-preferred', false, missingPreferred.join(','), 'soft');
} else {
  add('operator-matrix-preferred', true, `ok ${preferredOps.join(',')}`, 'soft');
}

// Wave 1 closed flag (file written by harvest)
const w1ClosedPath = path.join(repoRoot, 'docs/agents/waves/wave-1-closed.json');
let w1Closed = false;
try {
  if (fs.existsSync(w1ClosedPath)) {
    const c = JSON.parse(fs.readFileSync(w1ClosedPath, 'utf8'));
    w1Closed = c.closed === true || c.wave1Closed === true;
  }
} catch {
  w1Closed = false;
}
add('wave1-closed', w1Closed, w1Closed ? 'wave-1-closed.json present' : 'missing docs/agents/waves/wave-1-closed.json', 'soft');
if (!w1Closed) {
  residual.push({
    id: 'wave1-closed',
    detail: 'Wave 1 not marked closed (write wave-1-closed.json after harvest/Interwave)',
  });
}

// ── W2-CREDS (#547): cliproxy AGY, Grok OIDC TTL, K3 credit / failsafe ──
const creds = {
  cliproxyAgy: false,
  grokOidc: null,
  k3OrFailsafe: null,
  checkedAt: new Date().toISOString(),
};
// cliproxy :8317 must answer (fixed judge path)
try {
  const health = run('curl', ['-sS', '-m', '3', '-o', '/dev/null', '-w', '%{http_code}', 'http://127.0.0.1:8317/v1/models'], {
    timeout: 8_000,
  });
  const code = String(health.stdout || '').trim();
  // 200 or 401 both mean the proxy is up (auth may be required)
  creds.cliproxyAgy = /^(200|401|403)$/.test(code);
  add(
    'w2-creds-cliproxy',
    creds.cliproxyAgy,
    `cliproxy :8317 http=${code || health.error || 'down'}`,
    'hard',
  );
  if (!creds.cliproxyAgy) {
    residual.push({
      id: 'w2-creds-cliproxy',
      detail: 'fixed judge AGY unreachable — wave2Allowed cannot be true',
    });
  }
} catch (e) {
  add('w2-creds-cliproxy', false, String(e.message || e), 'hard');
  residual.push({ id: 'w2-creds-cliproxy', detail: 'cliproxy probe failed' });
}

// Grok OIDC / key — canonical probe lives in grok-auth.mjs (shared with wave2-run/cli)
const wave2HasGrok =
  freeze?.wave2?.harness === 'Grok'
  || freeze?.wave2?.generator === 'Grok'
  || freeze?.wave2?.chat === 'Grok'
  || freeze?.wave2?.evaluator === 'Grok';
if (wave2HasGrok) {
  let grokOk = false;
  let grokDetail = 'missing';
  try {
    const { inspectGrokOidcAuth, GROK_MIN_TTL_MS_DEFAULT } = await import(
      path.join(repoRoot, 'scripts/rotation/grok-auth.mjs')
    );
    const oidc = inspectGrokOidcAuth({ minTtlMs: GROK_MIN_TTL_MS_DEFAULT });
    grokOk = oidc.ok;
    grokDetail = oidc.detail;
    // Fallback: RoleConfig generator already pinned to direct xAI with key
    if (!grokOk) {
      try {
        const cfgPath = path.join(process.env.HOME || '', '.sinter', 'config.json');
        if (fs.existsSync(cfgPath)) {
          const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
          const g = cfg.roles?.generator || {};
          const base = String(g.baseUrl || '').toLowerCase();
          const model = String(g.model || '');
          if (/grok/i.test(model) && base.includes('api.x.ai') && g.apiKey) {
            grokOk = true;
            grokDetail = `RoleConfig.generator ${model} @ api.x.ai keyPresent`;
          }
        }
      } catch {
        /* ignore */
      }
    }
  } catch (e) {
    grokDetail = String(e.message || e);
  }
  creds.grokOidc = { ok: grokOk, detail: grokDetail };
  add('w2-creds-grok', grokOk, grokDetail, 'soft');
  if (!grokOk) {
    residual.push({ id: 'w2-creds-grok', detail: `Grok seated in wave2 but auth weak: ${grokDetail}` });
  }
} else {
  add('w2-creds-grok', true, 'Grok not in wave2 seats — skip', 'soft');
}

// K3 credit or labeled failsafe
const failsafe = freeze?.brains?.K3Failsafe?.model;
const k3FailsafeLabeled = failsafe === 'kilo-auto/free';
creds.k3OrFailsafe = { failsafe, labeled: k3FailsafeLabeled };
add(
  'w2-creds-k3-failsafe',
  k3FailsafeLabeled,
  k3FailsafeLabeled ? `failsafe=${failsafe}` : 'K3Failsafe must be kilo-auto/free when K3 credit unknown',
  'soft',
);
if (!k3FailsafeLabeled) {
  residual.push({ id: 'w2-creds-k3-failsafe', detail: 'label K3 failsafe kilo-auto/free in freeze' });
}

// GRILL #549: T1 evaluator home-ledger emit is SOFT residual, not hard wave2Allowed
// (recorded decision: preferred before W2 but not blocking spend gate).
const grillEvalHomeLedger = freeze?.grill?.evaluatorHomeLedgerHard;
if (grillEvalHomeLedger === true) {
  residual.push({
    id: 't1-eval-home-ledger',
    detail: 'freeze.grill.evaluatorHomeLedgerHard=true but emit not verified',
  });
  add('t1-eval-home-ledger', false, 'hard per freeze.grill', 'soft');
} else {
  add(
    't1-eval-home-ledger',
    true,
    'GRILL #549: soft — not required for wave2Allowed (land during W2 OK)',
    'soft',
  );
}

const hardFail = checks.filter((c) => c.severity === 'hard' && !c.ok);
const report = {
  schema: 'sinter-tour-preflight-v1',
  generatedAt: new Date().toISOString(),
  tip: (head.stdout || '').trim(),
  hardPass: hardFail.length === 0,
  hardFailIds: hardFail.map((c) => c.id),
  residual,
  // Preferred operator dogfood gaps — informational; do not gate wave2Allowed
  preferredResidual,
  checks,
  creds,
  // Free operator hard gates only — residual must clear before tour spend.
  wave1Allowed: hardFail.length === 0 && residual.filter((r) => r.id !== 'wave1-closed' && r.id !== 'operator-matrix').length === 0,
  // Wave 2: all hard + residual including wave1-closed + operator matrix + fixed judge + creds residuals
  wave2Allowed: hardFail.length === 0 && residual.length === 0 && w1Closed && fjStrict,
  grill: {
    issue: 549,
    evaluatorHomeLedger: 'soft',
    note: 'T1 evaluator home-ledger dual-emit preferred during Wave 2, not hard gate',
  },
  operatorDogfood: {
    required: requiredOps,
    preferred: preferredOps,
    missingPreferred,
    note: 'H-TELEM-08: preferred studio/bridge/chat.session for full dogfood claims',
  },
};

fs.mkdirSync(path.dirname(writePath), { recursive: true });
fs.writeFileSync(writePath, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));
process.exit(hardFail.length === 0 ? 0 : 1);
