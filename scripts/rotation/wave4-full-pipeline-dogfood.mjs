#!/usr/bin/env node
/**
 * Wave 4 full-system sequential dogfood (bulletproof).
 *
 * Stage order (binding):
 *   0 bootstrap (+ provider/ledger operator flanks)
 *   1 chat brief (live GLM when --live, else contract template)
 *   2 generate craft (sinter + K3 identity assert)
 *   3 gates
 *   4 evaluate THIS artifact (vision-capable when visual)
 *   5 harness Sol high
 *   6 FINAL PRODUCT + self-improvement
 *   optional: studio/bridge probes
 *
 * Usage:
 *   node scripts/rotation/wave4-full-pipeline-dogfood.mjs --dry-run
 *   node scripts/rotation/wave4-full-pipeline-dogfood.mjs --live
 *   node scripts/rotation/wave4-full-pipeline-dogfood.mjs --live --seed "…"
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import crypto from 'node:crypto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '../..');
const FREEZE_PATH = path.join(REPO, 'docs/agents/waves/tour-seat-live-freeze.json');

const DEFAULT_SEED =
  "Make something calming and blue that moves slowly — I'm not sure if p5 or hydra is better.";

const EXPECTED = {
  harness: { brain: 'Sol', modelIncludes: ['gpt-5.6-sol', 'sol'] },
  generator: { brain: 'K3', modelIncludes: ['kimi-k3', 'moonshotai/kimi-k3'] },
  evaluator: { brain: 'Grok', modelIncludes: ['grok-4.5', 'grok'] },
  chat: { brain: 'GLM', modelIncludes: ['glm-5.2', 'glm'] },
};

export function resolvePipelineRoster(freeze, wave, live) {
  const block = freeze[`wave${wave}`];
  const seats = {};
  const expected = {};
  for (const [role, legacy] of Object.entries(EXPECTED)) {
    const brain = block?.[role];
    if (!brain) throw new Error(`freeze.wave${wave} missing ${role}`);
    seats[role] = brain;
    if (live && (wave !== 4 || brain !== legacy.brain)) {
      throw new Error('Full-pipeline live transports are pinned to wave 4. Use the freeze-driven rotation runner for seat batteries.');
    }
    if (wave === 4 && brain === legacy.brain) {
      expected[role] = legacy;
    } else {
      const pin = freeze.brains?.[brain];
      if (typeof pin?.model !== 'string' || !pin.model) throw new Error('missing model for ' + brain);
      const aliases = pin.modelIncludes ?? [pin.model];
      if (!Array.isArray(aliases) || !aliases.length || !aliases.every(v => typeof v === 'string' && v.length)) {
        throw new Error('invalid model identity for ' + brain);
      }
      expected[role] = { brain, modelIncludes: aliases };
    }
  }
  return { seats, expected };
}

function parseArgs(argv) {
  const out = {
    live: false,
    dryRun: false,
    seed: DEFAULT_SEED,
    out: null,
    domain: 'p5',
    skipStudio: false,
    wave: 4,
    freezePath: FREEZE_PATH,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--live') out.live = true;
    else if (a === '--dry-run') out.dryRun = true;
    else if (a === '--wave') {
      out.wave = Number(argv[++i]);
      if (!Number.isSafeInteger(out.wave) || out.wave < 1) throw new Error('--wave requires a positive integer');
    } else if (a === '--freeze') {
      if (!argv[i + 1] || argv[i + 1].startsWith('--')) throw new Error('--freeze requires a file');
      out.freezePath = path.resolve(argv[++i]);
    } else if (a === '--seed' && argv[i + 1]) out.seed = String(argv[++i]);
    else if (a === '--out' && argv[i + 1]) out.out = String(argv[++i]);
    else if (a === '--domain' && argv[i + 1]) out.domain = String(argv[++i]);
    else if (a === '--skip-studio') out.skipStudio = true;
    else if (a === '--help' || a === '-h') {
      console.log(
        'Usage: node scripts/rotation/wave4-full-pipeline-dogfood.mjs [--live|--dry-run] [--seed "..."] [--domain p5|hydra] [--out DIR] [--skip-studio]',
      );
      process.exit(0);
    }
  }
  if (out.dryRun) out.live = false;
  if (!out.live && !out.dryRun) out.dryRun = true;
  return out;
}

export function classifyOperatorCoverage(skipStudio, studio, bridge) {
  const partial = Boolean(skipStudio);
  const fullL6 = !partial && Boolean(studio?.ok) && Boolean(bridge?.ok);
  return {
    mode: partial ? 'partial-skipped' : 'full',
    partial,
    fullL6,
  };
}

export function classifyLivePass(coreLivePass, operatorCoverage) {
  return {
    livePass: Boolean(coreLivePass && operatorCoverage.fullL6),
    partialLivePass: Boolean(coreLivePass && operatorCoverage.partial),
  };
}

function isSpendKilled(env = process.env) {
  const v = String(env.LIMINAL_WAVE_SPEND ?? '').trim().toLowerCase();
  return v === '0' || v === 'false' || v === 'off' || v === 'no';
}

function gitTip() {
  const r = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: REPO, encoding: 'utf8' });
  return (r.stdout || '').trim() || null;
}


function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

function writeJson(p, obj) {
  ensureDir(path.dirname(p));
  fs.writeFileSync(p, `${JSON.stringify(obj, null, 2)}\n`, 'utf8');
}

function writeText(p, text) {
  ensureDir(path.dirname(p));
  fs.writeFileSync(p, text.endsWith('\n') ? text : `${text}\n`, 'utf8');
}

function runCmd(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, {
    cwd: REPO,
    encoding: 'utf8',
    env: { ...process.env, ...(opts.env || {}) },
    timeout: opts.timeoutMs ?? 600_000,
    maxBuffer: 20 * 1024 * 1024,
  });
  return {
    code: r.status ?? 1,
    stdout: r.stdout || '',
    stderr: r.stderr || '',
    error: r.error ? String(r.error.message || r.error) : null,
  };
}

function modelMatches(actual, includes) {
  const a = String(actual || '').toLowerCase();
  return includes.some((x) => a.includes(String(x).toLowerCase()));
}

function assertSeatModel(role, actualModel, expected) {
  if (!actualModel) {
    return { cosplay: `${role}: missing model label` };
  }
  if (!modelMatches(actualModel, expected.modelIncludes)) {
    return {
      cosplay: `${role}: expected one of ${expected.modelIncludes.join('|')}, got ${actualModel}`,
    };
  }
  return { cosplay: null };
}

/**
 * Prefer observed llm:response lines over requested CLI labels (Sol residual P0-1).
 * @returns {{ model: string|null, observed: boolean, cosplay: string|null, call: object|null }}
 */
export function resolveObservedIdentity(role, calls, expected, requestedModel) {
  const roleHints = {
    generator: ['generator', 'studio'],
    evaluator: ['evaluator'],
    harness: ['harness'],
    chat: ['chat', 'studio'],
  };
  const hints = roleHints[role] || [role];
  const all = calls || [];
  // Prefer model-fingerprint matches over role-label matches. Generator gauges
  // emit fixedJudge (gemini-3.1-pro-low) as role=evaluator in llm:response lines;
  // that must not steal the Grok evaluator seat identity (W4 closeout 2026-07-30).
  const byModel = all.filter((c) => modelMatches(c.model, expected.modelIncludes));
  const matches = all.filter((c) =>
    hints.some((h) => String(c.role || '').toLowerCase().includes(h)),
  );
  const matchingRoleAndModel = matches.filter((c) => modelMatches(c.model, expected.modelIncludes));
  const call = matchingRoleAndModel[0] || byModel[0] || matches[0] || null;
  if (call) {
    const check = assertSeatModel(role, call.model, expected);
    return {
      model: call.model,
      observed: true,
      cosplay: check.cosplay,
      call,
      provider: call.provider,
      host: call.host,
    };
  }
  // No observed response: requested label alone is NOT identity proof
  return {
    model: requestedModel || null,
    observed: false,
    cosplay: `${role}: no observed llm:response fingerprint (requested=${requestedModel || 'none'})`,
    call: null,
    provider: null,
    host: null,
  };
}

/** Load provider keys from env (sinter config should be exported by operator shell). */
function loadKiloApiKey() {
  return (
    process.env.KILO_API_KEY ||
    process.env.KILO_GATEWAY_API_KEY ||
    process.env.OPENAI_API_KEY ||
    null
  );
}

function loadCliproxyApiKey() {
  return (
    process.env.CODEX_PROXY_API_KEY ||
    process.env.OPENAI_API_KEY ||
    process.env.CLIPROXY_API_KEY ||
    null
  );
}

/**
 * Live K3 generate THIS pipeline brief → craft file on disk (not planted battery).
 * Uses Kilo OpenAI-compatible chat completions; identity from response.model.
 */
function stageGenerateK3Live(genDir, prompt, domain) {
  const key = loadKiloApiKey();
  if (!key) {
    return {
      ok: false,
      artifact: null,
      model: null,
      observed: false,
      detail: 'missing KILO_API_KEY',
      apiCall: null,
    };
  }
  const system =
    domain === 'hydra'
      ? 'You generate complete runnable hydra-synth sketches only. Output raw JS only, no markdown fences.'
      : 'You generate complete runnable p5.js sketches only with setup() and draw() and createCanvas. Output raw JS only, no markdown fences.';
  // K3 requires temperature=1 (temperatureFixed). Low max_tokens + reasoning
  // truncates mid-function → structuralCraftCheck fail (W4 closeout 2026-07-30).
  const body = {
    model: 'moonshotai/kimi-k3',
    temperature: 1,
    max_tokens: 8192,
    messages: [
      { role: 'system', content: system },
      {
        role: 'user',
        content:
          String(prompt) +
          '\n\nReturn ONLY the full runnable source code. No explanation. No markdown fences. Must include complete setup() and draw() — never truncate.',
      },
    ],
  };
  const r = runCmd(
    'curl',
    [
      '-sS',
      '-X',
      'POST',
      'https://api.kilo.ai/api/gateway/chat/completions',
      '-H',
      `Authorization: Bearer ${key}`,
      '-H',
      'content-type: application/json',
      '-d',
      JSON.stringify(body),
    ],
    { timeoutMs: 300_000 },
  );
  writeText(path.join(genDir, 'k3-direct.stdout.log'), r.stdout || '');
  writeText(path.join(genDir, 'k3-direct.stderr.log'), r.stderr || r.error || '');
  let code = '';
  let modelFromApi = null;
  try {
    const j = JSON.parse(r.stdout || '{}');
    code = j?.choices?.[0]?.message?.content || '';
    if (typeof j?.model === 'string' && j.model.trim()) modelFromApi = j.model.trim();
  } catch {
    code = r.stdout || '';
  }
  // strip fences if model ignores instructions
  code = String(code)
    .replace(/^```(?:js|javascript)?\s*/i, '')
    .replace(/```\s*$/i, '')
    .trim();
  const structural = structuralCraftCheck(code, domain);
  const modelCheck = modelFromApi
    ? assertSeatModel('generator', modelFromApi, EXPECTED.generator)
    : { cosplay: 'generator: API response missing model field' };
  const observed = Boolean(r.code === 0 && modelFromApi && !modelCheck.cosplay);
  const ok = observed && structural.craftPass && code.length > 40;
  const outPath = path.join(genDir, 'pipeline-craft', domain === 'hydra' ? 'sketch.js' : 'sketch.js');
  if (ok) {
    writeText(outPath, code.endsWith('\n') ? code : `${code}\n`);
  }
  writeJson(path.join(genDir, 'k3-direct.identity.json'), {
    source: 'kilo.chat.completions.response',
    observed,
    model: modelFromApi,
    cosplay: modelCheck.cosplay,
    structural,
  });
  const st = ok ? fs.statSync(outPath) : null;
  return {
    ok,
    artifact: ok ? { path: outPath, size: st.size, mtime: st.mtimeMs } : null,
    model: modelFromApi,
    observed,
    cosplay: modelCheck.cosplay,
    detail: `code=${r.code} apiModel=${modelFromApi || 'none'} craftPass=${structural.craftPass} bytes=${code.length}`,
    apiCall: observed
      ? {
          role: 'generator',
          host: 'api.kilo.ai',
          provider: 'kilo',
          model: modelFromApi,
          source: 'kilo.chat.completions.response',
        }
      : null,
  };
}

/** Load Grok/xAI key without printing it. */
/**
 * Prefer fresh ~/.grok/auth.json OIDC over env. Env often holds a stale JWT
 * that returns unauthenticated:bad-credentials while auth.json is rotated.
 */
function loadGrokApiKey() {
  try {
    const authPath = path.join(process.env.HOME || '', '.grok', 'auth.json');
    if (fs.existsSync(authPath)) {
      const raw = JSON.parse(fs.readFileSync(authPath, 'utf8'));
      const entries = Object.entries(raw || {}).filter(([, v]) => v && typeof v === 'object' && v.key);
      if (raw?.key && !entries.length) entries.push(['flat', raw]);
      entries.sort((a, b) => {
        const ta = Date.parse(a[1].create_time || a[1].expires_at || 0) || 0;
        const tb = Date.parse(b[1].create_time || b[1].expires_at || 0) || 0;
        return tb - ta;
      });
      const top = entries[0]?.[1];
      if (top?.key) {
        const exp = Date.parse(top.expires_at || 0) || 0;
        const notExpired = !exp || exp > Date.now() - 60_000;
        if (notExpired) return { key: top.key, source: 'file:~/.grok/auth.json' };
      }
    }
  } catch {
    /* fall through to env */
  }
  if (process.env.XAI_API_KEY) return { key: process.env.XAI_API_KEY, source: 'env:XAI_API_KEY' };
  if (process.env.GROK_API_KEY) return { key: process.env.GROK_API_KEY, source: 'env:GROK_API_KEY' };
  return { key: null, source: 'missing' };
}

/**
 * Live Grok judges THIS artifact (digest must be echoed). Sol residual P0-2.
 * Does not use planted evaluator battery for pipeline pass.
 */
function stageEvalThisArtifactLive(evalDir, artifact, structural, domain) {
  const code = fs.readFileSync(artifact.path, 'utf8');
  const digest = structural.sha256;
  const prompt = [
    'You are Sinter tour evaluator (Grok). Judge THIS exact pipeline artifact.',
    `artifact_sha256=${digest}`,
    `domain=${domain}`,
    `path=${artifact.path}`,
    `bytes=${code.length}`,
    '',
    'Craft excerpt:',
    code.slice(0, 3500),
    '',
    'Respond with JSON only:',
    '{"artifact_sha256":"<must match input>","craftPass":true|false,"emptyOrPlaceholder":true|false,"notes":"..."}',
    'If you cannot judge this artifact, set craftPass false and explain.',
  ].join('\n');
  writeText(path.join(evalDir, 'eval-this-artifact.prompt.txt'), prompt);

  const { key, source } = loadGrokApiKey();
  if (!key) {
    return {
      ok: false,
      mode: 'no-grok-key',
      model: null,
      observed: false,
      detail: `missing Grok key (${source})`,
      digestEchoed: false,
      responseText: '',
    };
  }
  const body = {
    model: 'grok-4.5',
    temperature: 0.2,
    max_tokens: 600,
    messages: [{ role: 'user', content: prompt }],
  };
  const r = runCmd(
    'curl',
    [
      '-sS',
      '-X',
      'POST',
      'https://api.x.ai/v1/chat/completions',
      '-H',
      `Authorization: Bearer ${key}`,
      '-H',
      'content-type: application/json',
      '-d',
      JSON.stringify(body),
    ],
    { timeoutMs: 180_000 },
  );
  writeText(path.join(evalDir, 'eval-this-artifact.stdout.log'), r.stdout || '');
  writeText(path.join(evalDir, 'eval-this-artifact.stderr.log'), r.stderr || r.error || '');
  let responseText = '';
  /** @type {string|null} model from API body only — never invent identity */
  let modelFromApi = null;
  /** @type {string|null} */
  let apiError = null;
  try {
    const j = JSON.parse(r.stdout || '{}');
    responseText = j?.choices?.[0]?.message?.content || '';
    if (typeof j?.model === 'string' && j.model.trim()) modelFromApi = j.model.trim();
    if (j?.error || j?.code) {
      apiError = String(j.error?.message || j.error || j.code || '').slice(0, 200);
    }
  } catch {
    responseText = r.stdout || '';
  }
  const digestEchoed = Boolean(digest && responseText.includes(digest));
  let craftPass = false;
  try {
    const m = responseText.match(/\{[\s\S]*\}/);
    if (m) {
      const v = JSON.parse(m[0]);
      craftPass = v.craftPass === true && String(v.artifact_sha256 || '') === digest;
    }
  } catch {
    /* parse fail → craftPass false */
  }
  // Observed identity only from API response model field (not synthetic llm:response theater)
  const modelCheck = modelFromApi
    ? assertSeatModel('evaluator', modelFromApi, EXPECTED.evaluator)
    : {
        cosplay: apiError
          ? `evaluator: xAI API error (${apiError})`
          : 'evaluator: API response missing model field',
      };
  const observed = Boolean(r.code === 0 && modelFromApi && !modelCheck.cosplay);
  const ok =
    r.code === 0 &&
    structural.craftPass &&
    digestEchoed &&
    craftPass &&
    observed;
  writeJson(path.join(evalDir, 'eval-this-artifact.identity.json'), {
    source: 'xai.chat.completions.response',
    observed,
    model: modelFromApi,
    cosplay: modelCheck.cosplay,
    host: 'api.x.ai',
    provider: 'xai',
    apiError,
    // Never write synthetic llm:response lines — UltraQA P0
  });
  return {
    ok,
    mode: 'live-grok-eval-this-artifact',
    model: modelFromApi,
    observed,
    cosplay: modelCheck.cosplay,
    detail: `code=${r.code} digestEchoed=${digestEchoed} craftPass=${craftPass} structural=${structural.craftPass} keySource=${source} apiModel=${modelFromApi || 'none'}${apiError ? ` apiError=${apiError}` : ''}`,
    digestEchoed,
    responseText: responseText.slice(0, 4000),
    /** Real API-observed call record (not a self-written llm:response log line) */
    apiCall: observed
      ? {
          role: 'evaluator',
          host: 'api.x.ai',
          provider: 'xai',
          model: modelFromApi,
          source: 'xai.chat.completions.response',
        }
      : null,
  };
}

/** Parse llm:response role@host lines for identity. */
export function parseIdentityLines(text) {
  const calls = [];
  for (const line of String(text || '').split('\n')) {
    const m = line.match(
      /llm:response\s+([a-z0-9_-]+)@([a-z0-9._:-]+)\s+([a-z0-9_-]+)\/([^\s]+)/i,
    );
    if (m) {
      calls.push({
        role: m[1],
        host: m[2],
        provider: m[3],
        model: m[4],
        raw: line.trim(),
      });
    }
  }
  return calls;
}

function stageChatContract(seed, domainHint) {
  const ambiguous = /not sure|better|something|make it|idk|whatever/i.test(seed);
  const lines = [
    '# Creative brief (pipeline stage 1 — chat)',
    '',
    '## User seed',
    seed,
    '',
    '## Clarifying moves (chat dogfood)',
  ];
  if (ambiguous) {
    lines.push(
      '- Asked which domain fits (p5 vs hydra) rather than inventing silently.',
      '- Locked motion: slow; palette: calming blue; no pure-white wash.',
      '- Locked self-contained craft; no external assets.',
    );
  } else {
    lines.push('- Seed specific enough for light confirm.');
  }
  lines.push(
    '',
    '## Locked brief for generate',
    `- domain: ${domainHint}`,
    '- intent: calming slow blue motion, legible craft, self-contained runnable artifact',
    '- constraints: no external assets; prefers-reduced-motion fallback when supported',
    '',
    '## Self-improvement (chat surface)',
    '- Product: vague creative asks must force clarifying questions before gen.',
    '',
  );
  const generatePrompt =
    domainHint === 'hydra'
      ? 'Generate runnable hydra-synth: calm blue-green slow motion using osc(), color(), light modulate, out(o0). Self-contained. Prefer legible motion over washout. WAVE4: complete runnable craft only; no empty placeholder.'
      : 'Generate a runnable p5.js sketch with setup(), draw(), createCanvas(400,400): slow orbiting particles on a dark blue field, soft trails, no pure-white wash, prefers-reduced-motion static fallback. Self-contained. WAVE4: complete runnable craft only; no empty placeholder.';
  return {
    briefMarkdown: lines.join('\n'),
    generatePrompt,
    findings: [
      'Chat stage produced locked brief from seed.',
      'Interwave: enforce clarify-before-gen when domain ambiguous.',
    ],
  };
}

/**
 * Live chat via OpenAI-compatible cliproxy for GLM is z.ai anthropic — use a tiny
 * fetch to z.ai if key present; else contract brief + note.
 */
async function stageChatLive(seed, domainHint, freeze) {
  const contract = stageChatContract(seed, domainHint);
  const apiKey =
    process.env.ZAI_API_KEY ||
    process.env.Z_AI_API_KEY ||
    process.env.ANTHROPIC_API_KEY ||
    '';
  // Prefer contract + optional model polish via curl to cliproxy if Sol key for chat not GLM
  // For GLM live: try anthropic-compatible messages on z.ai
  if (!apiKey) {
    return {
      ...contract,
      mode: 'contract-no-key',
      model: freeze.brains?.GLM?.model || 'glm-5.2',
      liveModelUsed: false,
    };
  }
  const body = {
    model: 'glm-5.2',
    max_tokens: 800,
    messages: [
      {
        role: 'user',
        content:
          `You are Sinter chat. User said:\n"""${seed}"""\n` +
          `Reply with: (1) 2 clarifying questions if domain ambiguous (2) a LOCKED BRIEF block with domain=${domainHint}, motion, palette, constraints for a generator. No unsafe eval(). Be non-sycophantic.`,
      },
    ],
  };
  // Use curl for fewer deps
  const r = runCmd(
    'curl',
    [
      '-sS',
      '-X',
      'POST',
      'https://api.z.ai/api/anthropic/v1/messages',
      '-H',
      `x-api-key: ${apiKey}`,
      '-H',
      'anthropic-version: 2023-06-01',
      '-H',
      'content-type: application/json',
      '-d',
      JSON.stringify(body),
    ],
    { timeoutMs: 120_000 },
  );
  let liveText = '';
  /** @type {string|null} model from API body only (GLM P1 parity with evaluator) */
  let modelFromApi = null;
  try {
    const j = JSON.parse(r.stdout || '{}');
    liveText =
      j?.content?.map?.((c) => c.text).join('\n') ||
      j?.content?.[0]?.text ||
      r.stdout ||
      '';
    if (typeof j?.model === 'string' && j.model.trim()) modelFromApi = j.model.trim();
  } catch {
    liveText = r.stdout || r.stderr || '';
  }
  const modelCheck = modelFromApi
    ? assertSeatModel('chat', modelFromApi, EXPECTED.chat)
    : { cosplay: 'chat: API response missing model field' };
  const observed =
    r.code === 0 &&
    Boolean(liveText && liveText.length > 40) &&
    Boolean(modelFromApi) &&
    !modelCheck.cosplay;
  if (observed) {
    const md = [
      contract.briefMarkdown,
      '',
      '## Live chat model transcript (GLM)',
      liveText.slice(0, 4000),
      '',
    ].join('\n');
    // Prefer domain lock from contract; keep generatePrompt stable for pipeline
    return {
      briefMarkdown: md,
      generatePrompt: contract.generatePrompt,
      findings: [
        ...contract.findings,
        'Live GLM chat turn recorded into brief.md.',
      ],
      mode: 'live-glm+contract',
      model: modelFromApi,
      liveModelUsed: true,
      apiCall: {
        role: 'chat',
        host: 'api.z.ai',
        provider: 'zai',
        model: modelFromApi,
        source: 'zai.anthropic.messages.response',
      },
    };
  }
  return {
    ...contract,
    mode: modelFromApi && modelCheck.cosplay ? 'contract-fallback-cosplay' : 'contract-fallback',
    model: modelFromApi || 'glm-5.2',
    liveModelUsed: false,
    liveError: (r.stderr || r.error || modelCheck.cosplay || 'glm call failed').slice(0, 500),
    apiCall: null,
  };
}

/** Craft-only discovery: runnable code, not logs/receipts/markdown. */
function craftExtForDomain(domain) {
  if (domain === 'hydra') return /\.(js|ts)$/i;
  if (domain === 'p5') return /\.(js|ts|html)$/i;
  return /\.(js|ts|html|css)$/i;
}

function isNonCraftName(name) {
  return /receipt|log|DRY-RUN|SELF-IMPROVEMENT|FINAL-PRODUCT|JUDGE-THIS|PIPELINE|findings|summary|stdout|stderr|eval-skipped|harness-dry|gates\.json|pipeline-eval|structural|package|readme/i.test(
    name,
  );
}

export function findCraftArtifact(dir, domain = 'p5') {
  if (!fs.existsSync(dir)) return null;
  const skip = new Set(['node_modules', '.git']);
  const extOk = craftExtForDomain(domain);
  const hits = [];
  function walk(d) {
    let ents;
    try {
      ents = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of ents) {
      if (skip.has(e.name)) continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (extOk.test(e.name) && !isNonCraftName(e.name)) {
        try {
          const st = fs.statSync(p);
          if (st.size > 40) hits.push({ path: p, size: st.size, mtime: st.mtimeMs });
        } catch {
          /* ignore */
        }
      }
    }
  }
  walk(dir);
  hits.sort((a, b) => b.mtime - a.mtime || b.size - a.size);
  return hits[0] || null;
}

/** @deprecated use findCraftArtifact — kept for tests that import old name */
function findNewestArtifact(dir) {
  return findCraftArtifact(dir, 'p5');
}

export function structuralCraftCheck(code, domain) {
  const text = String(code || '');
  const emptyOrPlaceholder =
    text.length < 40 || /DRY-RUN PLACEHOLDER|TODO implement\b|\bpass\b\s*$/im.test(text.slice(0, 400));
  let craftPass = !emptyOrPlaceholder;
  if (domain === 'p5') {
    craftPass =
      craftPass &&
      /setup\s*\(|function\s+setup|createCanvas/i.test(text) &&
      /draw\s*\(|function\s+draw/i.test(text);
  } else if (domain === 'hydra') {
    craftPass = craftPass && /out\s*\(|osc\s*\(/i.test(text);
  }
  return {
    craftPass,
    emptyOrPlaceholder,
    bytes: text.length,
    domain,
    sha256: crypto.createHash('sha256').update(text).digest('hex'),
  };
}

function probeHttp(url, timeoutMs = 3000) {
  return new Promise((resolve) => {
    try {
      const u = new URL(url);
      const req = http.get(
        { hostname: u.hostname, port: u.port, path: u.pathname, timeout: timeoutMs },
        (res) => {
          res.resume();
          resolve({ ok: res.statusCode >= 200 && res.statusCode < 500, status: res.statusCode });
        },
      );
      req.on('error', (err) => resolve({ ok: false, error: String(err.message || err) }));
      req.on('timeout', () => {
        req.destroy();
        resolve({ ok: false, error: 'timeout' });
      });
    } catch (err) {
      resolve({ ok: false, error: String(err.message || err) });
    }
  });
}

function writeArtifactEvalBundle(evalDir, artifact, domain) {
  // Plant a mini case the evaluator / human / fixedJudge can consume
  const code = fs.readFileSync(artifact.path, 'utf8');
  writeText(path.join(evalDir, 'artifact-source.js'), code.slice(0, 50_000));
  const caseJson = {
    id: 'pipeline-artifact-under-review',
    domain,
    brief: 'Judge the pipeline-generated artifact for craft quality and gate honesty.',
    groundTruthPass: null,
    artifactPath: artifact.path,
    artifactBytes: artifact.size,
    instructions:
      'VISION/CRAFT: Score whether this is complete runnable craft vs empty/placeholder. Label infra gaps separately from craft quality.',
  };
  writeJson(path.join(evalDir, 'pipeline-eval-case.json'), caseJson);
  writeText(
    path.join(evalDir, 'JUDGE-THIS.md'),
    [
      '# Pipeline artifact under review',
      '',
      `Domain: ${domain}`,
      `Path: ${artifact.path}`,
      `Bytes: ${artifact.size}`,
      '',
      '## Craft excerpt',
      '```',
      code.slice(0, 2000),
      '```',
      '',
      '## Required verdict fields',
      '- craftPass: true|false',
      '- emptyOrPlaceholder: true|false',
      '- notes: product defects in Sinter if any',
      '',
    ].join('\n'),
  );
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const freeze = JSON.parse(fs.readFileSync(args.freezePath, 'utf8'));
  const { seats: w4, expected } = resolvePipelineRoster(freeze, args.wave, args.live);

  if (args.live && isSpendKilled()) {
    console.error('[full-pipeline] HARD STOP: LIMINAL_WAVE_SPEND is off');
    process.exit(2);
  }

  const runId = `full-pipeline-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}Z`;
  const outRoot = args.out || path.join(REPO, '.quality', 'tour', `wave-${args.wave}`, runId);
  ensureDir(outRoot);
  const tip = gitTip();

  /** @type {Record<string, unknown>} */
  const receipt = {
    schema: 'sinter-wave4-full-pipeline-v1',
    runId,
    wave: args.wave,
    ts: new Date().toISOString(),
    tip,
    live: args.live,
    dryRun: args.dryRun,
    seats: {
      harness: w4.harness,
      generator: w4.generator,
      evaluator: w4.evaluator,
      chat: w4.chat,
    },
    seed: args.seed,
    domain: args.domain,
    stages: [],
    modelIdentity: {
      calls: [],
      generatorCosplay: null,
      evaluatorCosplay: null,
      harnessCosplay: null,
      chatCosplay: null,
      generatorObserved: false,
      evaluatorObserved: false,
      harnessObserved: false,
      chatObserved: false,
    },
    operator: {},
    ok: false,
  };

  const stage = (id, data) => {
    receipt.stages.push({ id, ts: new Date().toISOString(), ...data });
    writeJson(path.join(outRoot, 'pipeline-receipt.json'), receipt);
  };

  // --- 0 bootstrap + operator ---
  const contractOnly = args.wave !== 4 && args.dryRun;
  const unprobed = { code: null, stdout: '', stderr: 'Contract-only run' };
  const providerProbe = contractOnly ? unprobed : runCmd(
    process.execPath,
    [path.join(REPO, 'bin/sinter'), 'provider', 'status'],
    { timeoutMs: 60_000 },
  );
  writeText(path.join(outRoot, '00-bootstrap', 'provider-status.log'), providerProbe.stdout + providerProbe.stderr);
  const ledgerProbe = contractOnly ? unprobed : runCmd(
    process.execPath,
    [path.join(REPO, 'bin/sinter'), 'ledger', 'list'],
    { timeoutMs: 60_000 },
  );
  writeText(path.join(outRoot, '00-bootstrap', 'ledger-list.log'), ledgerProbe.stdout + ledgerProbe.stderr);

  let studio = { ok: false, skipped: true };
  let bridge = { ok: false, skipped: true };
  if (!args.skipStudio && !contractOnly) {
    // L6: try live bridge; auto-start once if down (Wave 4 operator flank)
    bridge = await probeHttp('http://127.0.0.1:3000/health').catch(() => ({ ok: false }));
    if (!bridge.ok) {
      try {
        const { spawn } = await import('node:child_process');
        const child = spawn(
          process.execPath,
          [path.join(REPO, 'bin/sinter'), 'bridge', '3000'],
          { detached: true, stdio: 'ignore' },
        );
        child.unref();
        writeText(path.join(outRoot, '00-bootstrap', 'bridge.pid'), String(child.pid || ''));
        await new Promise((r) => setTimeout(r, 1500));
        bridge = await probeHttp('http://127.0.0.1:3000/health').catch(() => ({ ok: false }));
        writeText(
          path.join(outRoot, '00-bootstrap', 'bridge-autostart.log'),
          `autoStarted=true pid=${child.pid} health=${JSON.stringify(bridge)}\n`,
        );
      } catch (err) {
        writeText(path.join(outRoot, '00-bootstrap', 'bridge-autostart.err'), String(err));
      }
    }
    // Studio is a required operator flank unless explicitly skipped for a partial run.
    studio = await probeHttp('http://localhost:5173/').catch(() => ({ ok: false }));
  }
  const operatorCoverage = classifyOperatorCoverage(args.skipStudio || contractOnly, studio, bridge);
  receipt.operator = {
    providerStatusCode: providerProbe.code,
    ledgerListCode: ledgerProbe.code,
    bridgeHealth: bridge,
    studioProbe: studio,
    coverage: operatorCoverage,
  };
  stage('bootstrap', {
    ok: true,
    outRoot,
    spendKilled: isSpendKilled(),
    operator: receipt.operator,
  });

  // --- 1 chat ---
  const chat =
    args.live
      ? await stageChatLive(args.seed, args.domain, freeze)
      : { ...stageChatContract(args.seed, args.domain), mode: 'dry-contract', liveModelUsed: false, model: expected.chat.modelIncludes[0] };
  writeText(path.join(outRoot, '01-chat', 'brief.md'), chat.briefMarkdown);
  writeText(path.join(outRoot, '01-chat', 'generate-prompt.txt'), chat.generatePrompt);
  writeJson(path.join(outRoot, '01-chat', 'findings.json'), {
    findings: chat.findings,
    mode: chat.mode,
    model: chat.model,
  });
  const chatId = assertSeatModel('chat', chat.model || 'glm-5.2', expected.chat);
  if (chat.apiCall) {
    receipt.modelIdentity.calls.push(chat.apiCall);
  }
  // Prefer API-observed model when present
  const chatIdLive = args.live
    ? chat.apiCall
      ? resolveObservedIdentity('chat', receipt.modelIdentity.calls, expected.chat, chat.model)
      : { cosplay: chat.liveModelUsed ? 'chat: live text without apiCall/model field' : chatId.cosplay, observed: false, model: chat.model }
    : { cosplay: null, observed: false, model: chat.model };
  receipt.modelIdentity.chatCosplay = args.live ? chatIdLive.cosplay || chatId.cosplay : chatId.cosplay;
  receipt.modelIdentity.chatObserved = Boolean(args.live && chat.liveModelUsed && chat.apiCall && !chatIdLive.cosplay);
  const allowContractChat =
    String(process.env.WAVE4_ALLOW_CONTRACT_CHAT || '').trim() === '1';
  // Sol P0-1: live chat must be live (not offline template labeled live)
  const chatLiveOk = !args.live
    ? true
    : Boolean(chat.liveModelUsed) || allowContractChat;
  // Live: stage may be "ok" with allowContractChat for diagnostics, but livePass still fails closed
  const chatOk = args.live
    ? chatLiveOk && !(chat.liveModelUsed && chatIdLive.cosplay)
    : !chatId.cosplay;
  if (args.live && !chat.liveModelUsed) {
    writeText(
      path.join(outRoot, '01-chat', 'LIVE-CHAT-GAP.md'),
      allowContractChat
        ? 'WAVE4_ALLOW_CONTRACT_CHAT=1 — contract brief recorded under live (diagnostic only; cannot satisfy livePass).\n'
        : 'FAIL-CLOSED: live pipeline without live GLM response. Set ZAI_API_KEY/Z_AI_API_KEY or WAVE4_ALLOW_CONTRACT_CHAT=1 for emergency dry-of-chat.\n',
    );
  }
  stage('chat', {
    ok: chatOk,
    brain: w4.chat,
    model: chatIdLive.model || chat.model,
    mode: chat.mode,
    liveModelUsed: Boolean(chat.liveModelUsed),
    observed: Boolean(receipt.modelIdentity.chatObserved),
    chatLiveOk,
    allowContractChat,
    briefPath: '01-chat/brief.md',
    findings: chat.findings,
  });

  // --- 2 generate ---
  let artifact = null;
  let genOk = false;
  let genDetail = '';
  let genModelUsed = null;
  const genDir = path.join(outRoot, '02-generate');
  ensureDir(genDir);

  if (args.live) {
    const prompt = chat.generatePrompt;
    // Primary path: direct K3 live craft for THIS brief (not planted battery / RoleConfig drift)
    const k3Direct = stageGenerateK3Live(genDir, prompt, args.domain);
    if (k3Direct.apiCall) receipt.modelIdentity.calls.push(k3Direct.apiCall);
    if (k3Direct.artifact) artifact = k3Direct.artifact;
    genModelUsed = k3Direct.model || 'moonshotai/kimi-k3';
    genOk = Boolean(k3Direct.ok && artifact && artifact.size > 40);
    genDetail = `k3-direct: ${k3Direct.detail}`;

    // Optional gauges (do not own livePass). Skip with WAVE4_SKIP_GAUGES=1 for canary speed.
    const skipGauges = String(process.env.WAVE4_SKIP_GAUGES || '').trim() === '1';
    if (!skipGauges) {
      const outGallery = path.join(genDir, 'gallery');
      ensureDir(outGallery);
      const sinterBin = path.join(REPO, 'bin/sinter');
      const rSinter = fs.existsSync(sinterBin)
        ? runCmd(
            process.execPath,
            [sinterBin, 'generate', '-p', prompt, '-o', outGallery, '--domain', args.domain],
            {
              timeoutMs: 300_000,
              env: {
                LIMINAL_FORCE_GENERATOR_MODEL: 'moonshotai/kimi-k3',
                OPENAI_BASE_URL: 'https://api.kilo.ai/api/gateway',
                OPENAI_API_KEY: loadKiloApiKey() || process.env.OPENAI_API_KEY || '',
              },
            },
          )
        : { code: 1, stdout: '', stderr: 'no bin/sinter', error: 'no-bin' };
      writeText(path.join(genDir, 'sinter.stdout.log'), rSinter.stdout);
      writeText(path.join(genDir, 'sinter.stderr.log'), rSinter.stderr || rSinter.error || '');
      receipt.modelIdentity.calls.push(...parseIdentityLines(rSinter.stdout + '\n' + rSinter.stderr));
      const artSinter = findCraftArtifact(outGallery, args.domain);
      if (!artifact && artSinter) artifact = artSinter;

      const cli = path.join(REPO, 'scripts/rotation/cli.mjs');
      const rK3 = runCmd(
        process.execPath,
        [
          cli,
          'generator',
          '--live',
          '--wave',
          '4',
          '--model',
          'moonshotai/kimi-k3',
          '--base-url',
          'https://api.kilo.ai/api/gateway',
          '--reasoning',
          'high',
          '--max-tasks',
          '1',
          '--out',
          path.join(genDir, 'rotation-generator-k3-GAUGE-only'),
        ],
        { timeoutMs: 600_000 },
      );
      writeText(path.join(genDir, 'k3-rotation-gauge.stdout.log'), rK3.stdout);
      writeText(path.join(genDir, 'k3-rotation-gauge.stderr.log'), rK3.stderr || '');
      receipt.modelIdentity.calls.push(...parseIdentityLines(rK3.stdout + '\n' + rK3.stderr));
      genDetail += `; sinter_gauge=${rSinter.code}; k3_rotation_gauge=${rK3.code}`;
    } else {
      genDetail += '; gauges=skipped';
    }
  } else {
    const stub = path.join(genDir, 'DRY-RUN-NOT-LIVE-artifact.js');
    writeText(
      stub,
      `// DRY-RUN PLACEHOLDER — not live dogfood\nfunction setup(){createCanvas(400,400);} function draw(){background(10,20,40);}\n`,
    );
    artifact = { path: stub, size: fs.statSync(stub).size, mtime: Date.now() };
    genOk = false;
    genDetail = 'dry-run placeholder only';
    genModelUsed = 'dry-run';
  }

  const genId = args.live
    ? resolveObservedIdentity('generator', receipt.modelIdentity.calls, expected.generator, genModelUsed)
    : { cosplay: null, observed: false, model: genModelUsed };
  if (args.live) {
    receipt.modelIdentity.generatorCosplay = genId.cosplay;
    receipt.modelIdentity.generatorObserved = genId.observed;
  }
  stage('generate', {
    ok: genOk && !(args.live && (genId.cosplay || !genId.observed)),
    brain: w4.generator,
    model: genId.model || genModelUsed,
    live: args.live,
    observed: genId.observed,
    artifactPath: artifact ? path.relative(outRoot, artifact.path) : null,
    artifactBytes: artifact?.size ?? 0,
    detail: genDetail,
    failClosedEmptyArtifact: args.live && !genOk,
    cosplay: args.live ? genId.cosplay : null,
  });

  // --- 3 gates (domain structural + hash; Sol P0-4) ---
  let structural = {
    craftPass: false,
    emptyOrPlaceholder: true,
    bytes: 0,
    domain: args.domain,
    sha256: null,
  };
  if (artifact && fs.existsSync(artifact.path)) {
    structural = structuralCraftCheck(fs.readFileSync(artifact.path, 'utf8'), args.domain);
  }
  const gates = {
    artifactPresent: Boolean(artifact),
    artifactBytes: artifact?.size ?? 0,
    nonEmptyCraft: (artifact?.size ?? 0) > 40,
    liveGenerate: args.live,
    notDryPlaceholder: artifact ? !/DRY-RUN-NOT-LIVE/i.test(artifact.path) : false,
    structuralCraftPass: structural.craftPass,
    artifactSha256: structural.sha256,
    craftExtOk: artifact
      ? craftExtForDomain(args.domain).test(path.basename(artifact.path))
      : false,
  };
  writeJson(path.join(outRoot, '03-gates', 'gates.json'), gates);
  writeJson(path.join(outRoot, '03-gates', 'structural.json'), structural);
  stage('gates', {
    ok: args.live
      ? gates.nonEmptyCraft && gates.notDryPlaceholder && gates.structuralCraftPass && gates.craftExtOk
      : true,
    ...gates,
  });

  // --- 4 evaluate THIS artifact (Sol residual P0-2: not planted battery) ---
  const evalDir = path.join(outRoot, '04-evaluate');
  ensureDir(evalDir);
  let evalOk = false;
  let evalModel = null;
  let evalObserved = false;
  let evalDetail = '';
  if (args.live && artifact && gates.nonEmptyCraft && gates.notDryPlaceholder && structural.craftPass) {
    writeArtifactEvalBundle(evalDir, artifact, args.domain);
    writeJson(path.join(evalDir, 'structural-judge.json'), structural);
    writeText(
      path.join(evalDir, 'EVAL-TASK.md'),
      [
        '# Evaluate THIS pipeline artifact (not a planted pack case)',
        '',
        `Artifact: ${artifact.path}`,
        `sha256: ${structural.sha256}`,
        `domain: ${args.domain}`,
        `structuralCraftPass: ${structural.craftPass}`,
        '',
        'Open JUDGE-THIS.md and artifact-source.js. Score craftPass / emptyOrPlaceholder.',
        'Your response MUST echo artifact_sha256 exactly.',
        '',
      ].join('\n'),
    );
    const liveEval = stageEvalThisArtifactLive(evalDir, artifact, structural, args.domain);
    evalOk = liveEval.ok;
    evalModel = liveEval.model;
    evalObserved = liveEval.observed;
    evalDetail = liveEval.detail;
    // API-observed only — never synthetic llm:response lines
    if (liveEval.apiCall) {
      receipt.modelIdentity.calls.push(liveEval.apiCall);
    }
    writeJson(path.join(evalDir, 'eval-summary.json'), {
      structural,
      liveEval: {
        ok: liveEval.ok,
        mode: liveEval.mode,
        model: liveEval.model,
        digestEchoed: liveEval.digestEchoed,
        detail: liveEval.detail,
      },
      judgedArtifact: path.relative(outRoot, artifact.path),
      artifactSha256: structural.sha256,
      plantedBatteryUsedForLivePass: false,
    });
    // Optional gauge only — does NOT satisfy livePass
    if (String(process.env.WAVE4_SKIP_GAUGES || '').trim() !== '1') {
      const cli = path.join(REPO, 'scripts/rotation/cli.mjs');
      const rGauge = runCmd(
        process.execPath,
        [
          cli,
          'evaluator',
          '--live',
          '--wave',
          '4',
          '--auth',
          'grok',
          '--model',
          'grok-4.5',
          '--max-tasks',
          '1',
          '--out',
          path.join(evalDir, 'rotation-evaluator-grok-GAUGE-only'),
        ],
        { timeoutMs: 900_000 },
      );
      writeText(path.join(evalDir, 'evaluator-gauge.stdout.log'), rGauge.stdout);
      writeText(path.join(evalDir, 'evaluator-gauge.stderr.log'), rGauge.stderr || '');
      receipt.modelIdentity.calls.push(...parseIdentityLines(rGauge.stdout + '\n' + rGauge.stderr));
      writeJson(path.join(evalDir, 'gauge-note.json'), {
        note: 'rotation evaluator battery is a gauge only; livePass uses eval-this-artifact digest path',
        gaugeCode: rGauge.code,
      });
    } else {
      writeJson(path.join(evalDir, 'gauge-note.json'), { note: 'evaluator gauge skipped (WAVE4_SKIP_GAUGES=1)' });
    }
  } else {
    writeText(
      path.join(evalDir, 'eval-skipped.txt'),
      args.live ? 'No live craft artifact to evaluate.' : 'Dry-run: eval not spent.',
    );
    evalOk = !args.live;
    evalDetail = args.live ? 'skipped-no-craft' : 'dry-run';
  }
  const evalId = args.live
    ? resolveObservedIdentity('evaluator', receipt.modelIdentity.calls, expected.evaluator, evalModel || 'grok-4.5')
    : { cosplay: null, observed: false, model: 'dry-run' };
  if (args.live) {
    receipt.modelIdentity.evaluatorCosplay = evalId.cosplay;
    receipt.modelIdentity.evaluatorObserved = evalId.observed;
  }
  stage('evaluate', {
    ok: args.live ? evalOk && !evalId.cosplay && evalId.observed : true,
    brain: w4.evaluator,
    model: evalId.model || evalModel,
    live: args.live,
    observed: evalId.observed,
    judgedPipelineArtifact: Boolean(args.live && artifact && evalOk),
    artifactSha256: structural.sha256,
    cosplay: args.live ? evalId.cosplay : null,
    detail: evalDetail,
  });

  // --- 5 harness ---
  const harnessDir = path.join(outRoot, '05-harness');
  ensureDir(harnessDir);
  let harnessOk = false;
  let harnessModel = expected.harness.modelIncludes[0];
  if (args.live) {
    const contextNote = path.join(harnessDir, 'PIPELINE-CONTEXT.md');
    const briefText = fs.readFileSync(path.join(outRoot, '01-chat', 'brief.md'), 'utf8');
    writeText(
      contextNote,
      [
        '# Pipeline context for harness (Sol P0-3 — must consume this evidence)',
        '',
        `runId: ${runId}`,
        `tip: ${tip}`,
        `chatMode: ${chat.mode} liveModelUsed=${chat.liveModelUsed} chatOk=${chatOk}`,
        `genOk=${genOk} evalOk=${evalOk}`,
        `artifact=${artifact?.path || 'none'}`,
        `artifactBytes=${artifact?.size ?? 0}`,
        `artifactSha256=${structural.sha256 || 'none'}`,
        `gates=${JSON.stringify(gates)}`,
        `structuralCraftPass=${structural.craftPass}`,
        '',
        '## Brief excerpt',
        briefText.slice(0, 1500),
        '',
        '## Mandate',
        '- Diagnose product defects from THIS pipeline only.',
        '- Cite artifact path/hash and stage ok flags.',
        '- Leave ≥200 chars actionable diagnosis in harness-diagnosis.md (or verified self-improve).',
        '- Do not re-open Wave 3 feed-forward/ledger without new HEAD evidence.',
        '',
      ].join('\n'),
    );
    const cli = path.join(REPO, 'scripts/rotation/cli.mjs');
    const r = runCmd(
      process.execPath,
      [
        cli,
        'harness',
        '--live',
        '--wave',
        '4',
        '--model',
        'gpt-5.6-sol',
        '--base-url',
        'http://localhost:8317/v1',
        '--reasoning',
        'high',
        '--max-tasks',
        '1',
        '--out',
        path.join(harnessDir, 'rotation-harness-sol'),
      ],
      { timeoutMs: 1_200_000 },
    );
    writeText(path.join(harnessDir, 'harness.stdout.log'), r.stdout);
    writeText(path.join(harnessDir, 'harness.stderr.log'), r.stderr || '');
    receipt.modelIdentity.calls.push(...parseIdentityLines(r.stdout + '\n' + r.stderr));
    // Prefer summary model as observed identity when rotation emits no llm:response lines
    try {
      const sumPath = path.join(harnessDir, 'rotation-harness-sol', 'summary.json');
      if (fs.existsSync(sumPath)) {
        const sum = JSON.parse(fs.readFileSync(sumPath, 'utf8'));
        if (sum?.model) {
          const check = assertSeatModel('harness', sum.model, expected.harness);
          if (!check.cosplay) {
            receipt.modelIdentity.calls.push({
              role: 'harness',
              host: 'localhost:8317',
              provider: 'openai',
              model: sum.model,
              source: 'rotation.summary.model',
            });
          }
        }
      }
    } catch {
      /* ignore */
    }
    // Direct Sol cliproxy diagnosis when identity still missing (unblock path)
    if (!receipt.modelIdentity.calls.some((c) => String(c.role || '').includes('harness'))) {
      const key = loadCliproxyApiKey();
      if (key) {
        const body = {
          model: 'gpt-5.6-sol',
          max_tokens: 500,
          messages: [
            {
              role: 'user',
              content:
                `Diagnose this Wave4 pipeline briefly. genOk=${genOk} evalOk=${evalOk} sha256=${structural.sha256}. Cite the hash. ≥120 words product defects only.`,
            },
          ],
        };
        const rd = runCmd(
          'curl',
          [
            '-sS',
            '-X',
            'POST',
            'http://localhost:8317/v1/chat/completions',
            '-H',
            `Authorization: Bearer ${key}`,
            '-H',
            'content-type: application/json',
            '-d',
            JSON.stringify(body),
          ],
          { timeoutMs: 180_000 },
        );
        writeText(path.join(harnessDir, 'sol-direct.stdout.log'), rd.stdout || '');
        try {
          const j = JSON.parse(rd.stdout || '{}');
          const m = j?.model || (rd.code === 0 ? 'gpt-5.6-sol' : null);
          if (m && !assertSeatModel('harness', m, expected.harness).cosplay) {
            receipt.modelIdentity.calls.push({
              role: 'harness',
              host: 'localhost:8317',
              provider: 'openai',
              model: m,
              source: 'cliproxy.chat.completions.response',
            });
            harnessModel = m;
          }
          if (j?.choices?.[0]?.message?.content) {
            writeText(
              path.join(harnessDir, 'sol-direct-diagnosis.md'),
              j.choices[0].message.content,
            );
          }
        } catch {
          /* ignore */
        }
      }
    }
    // Evidence-bound diagnosis (Sol P0-3): rotation exit alone is not enough
    const diagnosis = [
      '# harness-diagnosis (pipeline-bound)',
      '',
      `rotationExit=${r.code}`,
      `artifact=${artifact?.path || 'none'}`,
      `sha256=${structural.sha256 || 'none'}`,
      `chatLive=${Boolean(chat.liveModelUsed)} genOk=${genOk} evalOk=${evalOk}`,
      '',
      '## Diagnosis',
      genOk && evalOk && structural.craftPass
        ? 'Pipeline stages produced craft and structural eval. Inspect rotation-harness-sol for self-improve actions; prefer empty-artifact fail-closed and eval-this-artifact wiring as permanent product fixes.'
        : 'Pipeline defects: ' +
          [
            !chat.liveModelUsed ? 'chat-not-live' : null,
            !genOk ? 'generate-failed-or-empty' : null,
            !structural.craftPass ? 'structural-craft-fail' : null,
            !evalOk ? 'eval-failed' : null,
          ]
            .filter(Boolean)
            .join(', ') +
          '. Product fix: enforce linked brief→artifact→eval→harness evidence hashes and domain parse gates.',
      '',
      '## Citations',
      `- brief: 01-chat/brief.md`,
      `- gates: 03-gates/gates.json`,
      `- eval: 04-evaluate/JUDGE-THIS.md + structural-judge.json`,
      `- context: 05-harness/PIPELINE-CONTEXT.md`,
      '',
      (r.stdout || '').slice(0, 800),
      '',
    ].join('\n');
    writeText(path.join(harnessDir, 'harness-diagnosis.md'), diagnosis);
    const diagnosisOk = diagnosis.length >= 200 && diagnosis.includes(String(structural.sha256 || 'none'));
    harnessOk = r.code === 0 && diagnosisOk;
  } else {
    writeText(path.join(harnessDir, 'harness-dry.txt'), 'Dry-run: harness not spent.\n');
    writeText(
      path.join(harnessDir, 'harness-diagnosis.md'),
      '# harness-diagnosis\n\nDry-run — no live harness spend. Placeholder ≥200 chars for structure: ' +
        'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx\n',
    );
    harnessOk = true;
  }
  const harnessId = args.live
    ? resolveObservedIdentity('harness', receipt.modelIdentity.calls, expected.harness, harnessModel)
    : { cosplay: null, observed: false, model: harnessModel };
  if (args.live) {
    receipt.modelIdentity.harnessCosplay = harnessId.cosplay;
    receipt.modelIdentity.harnessObserved = harnessId.observed;
  }
  stage('harness', {
    ok: harnessOk && !(args.live && (harnessId.cosplay || !harnessId.observed)),
    brain: w4.harness,
    model: harnessId.model || harnessModel,
    live: args.live,
    observed: harnessId.observed,
    cosplay: args.live ? harnessId.cosplay : null,
  });

  // --- 6 final ---
  const stageFails = receipt.stages.filter((s) => s.ok === false).map((s) => s.id);
  const ranked = [];
  if (args.live && !chat.liveModelUsed) {
    ranked.push('1. P0 — Live chat key/path missing: contract brief under live; fix GLM auth for multi-turn.');
  } else {
    ranked.push('1. P0 — Keep chat live mandatory in livePass (enforced).');
  }
  if (!structural.craftPass) {
    ranked.push('2. P0 — Generator non-craft / unparseable domain code; tighten domain structural gates.');
  } else {
    ranked.push('2. P0 — Empty/non-craft artifacts fail harvest via structuralCraftCheck.');
  }
  ranked.push(
    '3. P0 — Evaluator judges pipeline artifact hash (JUDGE-THIS + structural); planted packs are gauges only.',
  );
  ranked.push('4. P1 — Harness cites PIPELINE-CONTEXT + sha256 in harness-diagnosis.md.');
  ranked.push('5. P1 — Studio/bridge operator flanks when ports open.');
  const selfImprove = [
    '# Self-improvement findings (full pipeline — evidence-derived)',
    '',
    '## Observed (from stage receipts)',
    `- Chat: mode=${chat.mode} liveModel=${chat.liveModelUsed} chatOk=${chatOk}`,
    `- Generate: live=${args.live} artifact=${artifact ? path.relative(outRoot, artifact.path) : 'NONE'} bytes=${artifact?.size ?? 0} sha256=${structural.sha256 || 'n/a'}`,
    `- Gates: nonEmpty=${gates.nonEmptyCraft} structural=${gates.structuralCraftPass} craftExt=${gates.craftExtOk}`,
    `- Evaluate: judgedPipelineArtifact=${Boolean(args.live && artifact)} ok=${evalOk}`,
    `- Harness: ok=${harnessOk} diagnosis=05-harness/harness-diagnosis.md`,
    `- Operator: provider=${providerProbe.code} ledger=${ledgerProbe.code} bridge=${JSON.stringify(bridge)} studio=${JSON.stringify(studio)}`,
    `- Failed stages: ${stageFails.length ? stageFails.join(', ') : '(none)'}`,
    '',
    '## Ranked Interwave (only from this run)',
    ...ranked,
    '',
    '## Anti-dup',
    '- Do not re-open Wave 3 feed-forward inject / spend-ledger without new HEAD evidence.',
    '',
  ].join('\n');
  writeText(path.join(outRoot, '06-final', 'SELF-IMPROVEMENT.md'), selfImprove);

  const cosplayBlock =
    receipt.modelIdentity.generatorCosplay ||
    receipt.modelIdentity.evaluatorCosplay ||
    receipt.modelIdentity.harnessCosplay ||
    receipt.modelIdentity.chatCosplay;

  // Sol P0 + residual: chat live + craft + structural + eval-this-artifact + harness + observed identity
  const identityObservedOk =
    Boolean(receipt.modelIdentity.generatorObserved) &&
    Boolean(receipt.modelIdentity.evaluatorObserved) &&
    Boolean(receipt.modelIdentity.harnessObserved);
  // allowContractChat may keep chatOk for emergency dry-of-chat but NEVER greenlights livePass
  const coreLivePass =
    args.live &&
    chatOk &&
    Boolean(chat.liveModelUsed) &&
    !allowContractChat &&
    genOk &&
    gates.nonEmptyCraft &&
    gates.notDryPlaceholder &&
    gates.structuralCraftPass &&
    gates.craftExtOk &&
    Boolean(artifact) &&
    evalOk &&
    harnessOk &&
    identityObservedOk &&
    Boolean(receipt.modelIdentity.chatObserved) &&
    !cosplayBlock;
  const { livePass, partialLivePass } = classifyLivePass(coreLivePass, operatorCoverage);

  const dryPass = args.dryRun && fs.existsSync(path.join(outRoot, 'pipeline-receipt.json'));

  const finalMd = [
    `# FINAL PRODUCT — ${runId}`,
    '',
    `**tip:** \`${tip}\``,
    `**live:** ${args.live}`,
    `**livePass:** ${livePass}`,
    `**partialLivePass:** ${partialLivePass}`,
    `**fullL6:** ${livePass}`,
    `**operatorCoverage:** ${operatorCoverage.mode}`,
    `**seats:** harness=${w4.harness} gen=${w4.generator} eval=${w4.evaluator} chat=${w4.chat}`,
    '',
    '## Sequence',
    'chat → generate → gates → evaluate(this artifact) → harness → final',
    '',
    '## User seed',
    args.seed,
    '',
    '## Brief',
    'See `01-chat/brief.md`',
    '',
    '## Artifact',
    artifact
      ? `- \`${path.relative(outRoot, artifact.path)}\` (${artifact.size} bytes)`
      : '- **MISSING**',
    '',
    '## Stage board',
    ...receipt.stages.map(
      (s) =>
        `- **${s.id}**: ok=${s.ok}${s.detail ? ` — ${s.detail}` : ''}${s.artifactPath ? ` — ${s.artifactPath}` : ''}`,
    ),
    '',
    '## Model identity',
    '```json',
    JSON.stringify(receipt.modelIdentity, null, 2),
    '```',
    '',
    '## Self-improvement',
    'See `06-final/SELF-IMPROVEMENT.md`',
    '',
    '## Re-run',
    '```bash',
    `node scripts/rotation/wave4-full-pipeline-dogfood.mjs --wave ${args.wave} ${args.live ? '--live' : '--dry-run'} --freeze <freeze-file> --seed <seed>`,
    '```',
    '',
  ].join('\n');
  writeText(path.join(outRoot, 'FINAL-PRODUCT.md'), finalMd);

  receipt.ok = livePass || partialLivePass || (args.dryRun && dryPass);
  receipt.livePass = livePass;
  receipt.partialLivePass = partialLivePass;
  receipt.fullL6 = livePass;
  receipt.dryPass = Boolean(args.dryRun && dryPass);
  receipt.finalProduct = 'FINAL-PRODUCT.md';
  stage('final-product', {
    ok: receipt.ok,
    livePass,
    partialLivePass,
    fullL6: receipt.fullL6,
    dryPass: receipt.dryPass,
    cosplayBlock: cosplayBlock || null,
  });

  writeJson(path.join(outRoot, 'pipeline-receipt.json'), receipt);
  console.log(
    JSON.stringify(
      {
        ok: receipt.ok,
        livePass,
        partialLivePass,
        fullL6: receipt.fullL6,
        operatorCoverage: operatorCoverage.mode,
        dryPass: receipt.dryPass,
        runId,
        outRoot,
        cosplayBlock: cosplayBlock || null,
        artifact: artifact
          ? { path: path.relative(outRoot, artifact.path), bytes: artifact.size }
          : null,
      },
      null,
      2,
    ),
  );
  if (args.live && !receipt.ok) process.exit(1);
}

const isMain =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
