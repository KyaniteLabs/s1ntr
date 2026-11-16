/**
 * Standing rotation batteries (#401) — shared core.
 * Reuses audition-379 helpers (promptHash, ledger, blind pack, gates) — does not clone.
 */
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(__dirname, '../..');
export const ROTATION_TASKS_DIR = path.join(__dirname, 'tasks');
export const ROTATION_FIXTURES_DIR = path.join(__dirname, 'fixtures');
export const DEFAULT_RECEIPT_ROOT = path.join(REPO_ROOT, '.quality');

/** Seats that own a standing battery. chat maps to RoleConfig studio. */
export const SEATS = ['generator', 'evaluator', 'harness', 'chat'];

/** Fixed evaluator for blind scoring during generator/chat batteries (not a rotator). */
export const FIXED_EVALUATOR_MODEL = 'gemini-3.1-pro-low';
/** Fixed judge must use AGY via cliproxy — never Kilo (dual-judge protocol). */
export const FIXED_EVALUATOR_ROUTE = 'agy-cliproxy';

/** Closed enum for honest live gaps (Wave 2 T0-3). */
export const GAP_CLASSES = Object.freeze([
  'instrument_pipe',
  'instrument_auth',
  'subject_auth',
  'subject_timeout',
  'subject_adapter',
  'render_infra',
  'ledger_emit',
  'unknown',
]);

export function normalizeGapClass(value) {
  const v = String(value || 'unknown').toLowerCase().trim();
  return GAP_CLASSES.includes(v) ? v : 'unknown';
}

/** Infer gapClass from free-text finding (prefer explicit class at call sites). */
export function inferGapClassFromMessage(msg) {
  const s = withoutPathTokens(String(msg || '').toLowerCase());
  if (!s) return 'unknown';
  if (
    (s.includes('gemini') && s.includes('kilo'))
    || (s.includes('not a valid model') && s.includes('gemini'))
    || (s.includes('judge failed') && s.includes('kilo'))
    || (s.includes('fixed-evaluator') && s.includes('kilo'))
  ) {
    return 'instrument_pipe';
  }
  if (/\b401\b|\b403\b|unauthorized|forbidden|invalid.?api.?key|auth/.test(s)) {
    return s.includes('judge') || s.includes('fixed-evaluat') ? 'instrument_auth' : 'subject_auth';
  }
  if (s.includes('timeout') || s.includes('timed out')) return 'subject_timeout';
  if (s.includes('chrome') || s.includes('playwright') || s.includes('disk pressure') || s.includes('render')) {
    return 'render_infra';
  }
  if (s.includes('ledger') || s.includes('telemetry emit') || s.includes('emit failed')) return 'ledger_emit';
  if (s.includes('empty') || s.includes('syntax') || s.includes('adapter') || s.includes('json')) {
    return 'subject_adapter';
  }
  return 'unknown';
}

/** Secondary metrics must not green a non-live / null-NS pack (T0-4). */
export function fitnessAllowsSecondaryMetrics({ mode, northStar } = {}) {
  if (mode !== 'live') return false;
  if (northStar == null || Number.isNaN(Number(northStar))) return false;
  return true;
}

/**
 * Align rotation harness timeout taxonomy with CompoundRunEnvelope.classifyTimeoutError
 * (W1 requeue plan P0 + H-TELEM-05 structured timeoutSource — single policy).
 * Returns null when the message is not a timeout-shaped failure (caller may fall through).
 * @param {string|null|undefined} message
 * @param {{ timeoutSource?: 'provider'|'harness'|'cancel'|'queue'|'unknown'|null }} [opts]
 * @returns {'provider-timeout'|'harness-deadline'|null}
 */
export function classifyRotationTimeoutMessage(message, opts = {}) {
  const src = opts?.timeoutSource;
  if (src === 'provider' || src === 'queue') return 'provider-timeout';
  if (src === 'harness' || src === 'cancel') return 'harness-deadline';
  const m = String(message || '').toLowerCase();
  if (!m) return null;
  // Same order as CompoundRunEnvelope.classifyTimeoutError (deadline|harness first)
  if (m.includes('deadline') || m.includes('harness')) return 'harness-deadline';
  if (m.includes('timeout') || m.includes('aborted') || m.includes('abort')) {
    return 'provider-timeout';
  }
  return null;
}

/** Explicit usage presence flag (T1-2 / H-TELEM-03) — never silent null without flag. */
export function usagePresence(tokenUsage, { costUsd = null } = {}) {
  if (tokenUsage == null || typeof tokenUsage !== 'object') {
    return {
      usagePresent: false,
      tokenUsage: null,
      costUsd: costUsd == null || Number.isNaN(Number(costUsd)) ? null : Number(costUsd),
      costPresent: costUsd != null && !Number.isNaN(Number(costUsd)),
    };
  }
  const prompt = tokenUsage.prompt ?? tokenUsage.input ?? null;
  const completion = tokenUsage.completion ?? tokenUsage.output ?? null;
  const total = tokenUsage.total ?? null;
  const present = [prompt, completion, total].some((v) => v != null && !Number.isNaN(Number(v)));
  // #1656: a partial sum must stay marked partial in the ledger.
  const hasCalls = typeof tokenUsage.calls === 'number';
  const cost = costUsd ?? tokenUsage.costUsd ?? null;
  const costNum = cost == null || Number.isNaN(Number(cost)) ? null : Number(cost);
  return {
    usagePresent: present,
    tokenUsage: {
      prompt: prompt ?? null,
      completion: completion ?? null,
      reasoning: tokenUsage.reasoning ?? null,
      total: total ?? null,
      ...(hasCalls ? {
        calls: tokenUsage.calls,
        callsWithUnknownUsage: typeof tokenUsage.callsWithUnknownUsage === 'number' ? tokenUsage.callsWithUnknownUsage : null,
      } : {}),
    },
    costUsd: costNum,
    costPresent: costNum != null,
  };
}

/**
 * Build fixed-judge block for gen/chat (T0-1).
 * Positive validation: only cliproxy (:8317) is agy-cliproxy; kilo → invalid-kilo;
 * missing baseUrl → unset; any other host → invalid-route.
 */
export function buildFixedJudgeBlock(evaluatorSeatRes = null) {
  const res = evaluatorSeatRes || {};
  const model = res.model || FIXED_EVALUATOR_MODEL;
  const baseUrl = res.baseUrl || null;
  const host = res.endpointHost || endpointHostFromUrl(baseUrl) || null;
  let route = FIXED_EVALUATOR_ROUTE;
  if (!baseUrl) {
    route = 'unset';
  } else if (isKiloEndpoint(baseUrl) || String(baseUrl).toLowerCase().includes('kilo')) {
    route = 'invalid-kilo';
  } else if (!isCliproxyEndpoint(baseUrl)) {
    route = 'invalid-route';
  }
  return {
    model,
    endpointHost: host,
    baseUrl,
    keySource: res.keySource || null,
    keyPresent: Boolean(res.keyPresent ?? res.apiKey),
    route,
    role: 'fixed-evaluator',
    source: res.source || 'fixed-evaluator-agy',
  };
}

/** True when fixedJudge.route is the only allowed AGY path for scorable gen/chat. */
export function isFixedJudgeRouteValid(route) {
  return String(route || '') === FIXED_EVALUATOR_ROUTE;
}

/**
 * True when a freeze "pipe" string names the Kilo gateway.
 * Does NOT match the disclaimer phrase "not Kilo" / "(not Kilo)".
 */
export function pipeMentionsKiloGateway(pipe) {
  const s = String(pipe || '').toLowerCase();
  if (!s) return false;
  if (s.includes('kilo.ai') || s.includes('api.kilo')) return true;
  // host-ish kilo without negation: "kilo https://..." or bare gateway host
  if (/(?:^|[\s/])kilo(?:\.ai)?(?:[\s/]|$)/.test(s) && !/not\s+kilo/.test(s)) {
    return true;
  }
  return false;
}

/**
 * Preflight T0-5: freeze.fixedJudge must be gemini + agy-cliproxy and never Kilo pipe.
 * @returns {{ ok: boolean, detail: string, model: string, route: string }}
 */
export function evaluateFixedJudgeFreeze(fj) {
  if (!fj || typeof fj !== 'object') {
    return {
      ok: false,
      detail: 'missing freeze.fixedJudge { model, route: agy-cliproxy }',
      model: '',
      route: '',
    };
  }
  const model = String(fj.model || '');
  const route = String(fj.route || '').toLowerCase();
  const pipe = String(fj.pipe || '');
  const host = String(fj.endpointHost || fj.host || '').toLowerCase();
  const onKilo =
    route.includes('kilo')
    || pipeMentionsKiloGateway(pipe)
    || host.includes('kilo');
  const routeOk = isFixedJudgeRouteValid(route)
    || route.includes('agy-cliproxy')
    || (route.includes('cliproxy') && !onKilo)
    || (route.includes('8317') && !onKilo);
  const ok = /gemini/i.test(model) && routeOk && !onKilo;
  return {
    ok,
    detail: `model=${model || 'missing'} route=${fj.route || 'missing'} pipe=${fj.pipe || 'n/a'}`,
    model,
    route: fj.route || '',
  };
}

export function resolveTourJoinKeys({
  wave = null,
  seat = null,
  model = null,
  pipeHost = null,
  tip = null,
  tourId = null,
} = {}) {
  const waveRaw = wave?.id ?? wave ?? process.env.LIMINAL_TOUR_WAVE ?? null;
  if (waveRaw == null || waveRaw === '') return null;
  const tipSrc = tip || process.env.LIMINAL_TOUR_TIP || process.env.LIMINAL_TOUR_TIP_AT_START || 'unknown';
  const tipShort = String(tipSrc).replace(/[^0-9a-fA-F]/g, '').slice(0, 8) || 'unknown';
  const w = String(waveRaw).replace(/[^0-9A-Za-z._-]/g, '');
  const tipAtStart = process.env.LIMINAL_TOUR_TIP_AT_START
    ? String(process.env.LIMINAL_TOUR_TIP_AT_START).replace(/[^0-9a-fA-F]/g, '').slice(0, 8)
    : tipShort;
  return {
    tourId: tourId || process.env.LIMINAL_TOUR_ID || 'umd-rotation-tour-4x4',
    tourWaveId: `wave-${w}@${tipShort}`,
    wave: Number.isNaN(Number(waveRaw)) ? waveRaw : Number(waveRaw),
    tip: tipShort,
    tipAtStart,
    seat: seat ?? null,
    role: seat ?? null,
    model: model ?? null,
    pipeHost: pipeHost ?? null,
  };
}

export function instrumentVersionFromEnv() {
  return process.env.LIMINAL_INSTRUMENT_VERSION || process.env.LIMINAL_TOUR_TIP || null;
}

export const RECEIPT_SCHEMA_VERSION = 1;
export const ISSUE = 401;

/** Decision tiers (design law 4): cheapest that can decide. Order is binding. */
export const TIER = {
  DETERMINISTIC: 0,
  FIXED_EVALUATOR: 1,
  BLIND_HUMAN: 2,
};

/** Fixed FP budget for evaluator north-star (hit-rate only counts when FP ≤ budget). */
export const EVALUATOR_FP_BUDGET = 0.1;

/**
 * Known failure classes that must appear in each battery's failure-space map
 * (traced to a task OR listed as an explicit blind spot).
 * Sources: learnings-2026-07.md F1–F9, rematch INFRA-CHROME/EMPTY-ARTIFACT, gate_fail.
 */
export const KNOWN_FAILURE_CLASSES = [
  'F1-seat-attribution',
  'F2-harness-telemetry',
  'F3-config-shape-ignored',
  'F4-silent-local-fallback',
  'F5-param-constraints',
  'F6-bare-api-role-config',
  'F7-agent-json-contract',
  'F8-precommit-false-green',
  'F9-browser-cache-wipe',
  'INFRA-CHROME',
  'EMPTY-ARTIFACT',
  'gate_fail',
];

/**
 * Per-battery design law binding (v1).
 * failureSpace[].tasks = task ids that would catch the class (≥1).
 * blindSpots = classes with no task (must be listed, never silent).
 */
export const BATTERY_DESIGN = {
  generator: {
    version: 1,
    batteryId: 'generator-v1',
    northStar: {
      id: 'blindEvalScoreOfGatePassers',
      label: 'blind-eval score of gate-passers',
      description: 'Mean fixed-evaluator score among artifacts that passed tier-0 gates (parse/render/nonblank).',
    },
    mece: {
      measures: 'Generator artifact quality under fixed gates + fixed-evaluator blind score on survivors.',
      doesNotMeasure: 'Judging calibration (→ evaluator battery); harness edit/rollback (→ harness); chat stance (→ chat).',
    },
    verifiesLastWaveFixes:
      'Regression tasks promoted from prior-wave defects (same task ids) re-run; north-star and gate@1 must not regress vs wave-N summary without explicit deferral. Fix PRs that cannot be verified here must say why in one line.',
    failureSpace: [
      { class: 'EMPTY-ARTIFACT', tasks: ['gen-p5-easy', 'gen-p5-hard', 'gen-hydra-easy', 'gen-hydra-hard', 'gen-kinetic-easy', 'gen-kinetic-hard'], note: 'tier-0 parse/artifact gate' },
      { class: 'gate_fail', tasks: ['gen-p5-easy', 'gen-p5-hard', 'gen-hydra-easy', 'gen-hydra-hard', 'gen-kinetic-easy', 'gen-kinetic-hard'], note: 'tier-0 parse/render/nonblank' },
      { class: 'INFRA-CHROME', tasks: ['gen-p5-easy', 'gen-p5-hard', 'gen-hydra-easy', 'gen-hydra-hard', 'gen-kinetic-easy', 'gen-kinetic-hard'], note: 'tier-0 render classifies infra vs model; receipt failureClass' },
      { class: 'F1-seat-attribution', tasks: ['gen-p5-easy', 'gen-p5-hard', 'gen-hydra-easy', 'gen-hydra-hard', 'gen-kinetic-easy', 'gen-kinetic-hard'], note: 'every receipt/summary carries resolved model' },
      { class: 'F5-param-constraints', tasks: ['gen-p5-easy', 'gen-p5-hard', 'gen-hydra-easy', 'gen-hydra-hard', 'gen-kinetic-easy', 'gen-kinetic-hard'], note: 'pinned reasoningLevel in receipt; live path injects effort' },
      { class: 'F4-silent-local-fallback', tasks: ['gen-p5-easy'], note: 'resolveSeatModel + findings if env-fallback/local' },
      { class: 'F6-bare-api-role-config', tasks: ['gen-p5-easy'], note: 'RoleConfig load path; source field in seatResolution' },
    ],
    blindSpots: [
      { class: 'F2-harness-telemetry', reason: 'Harness lane telemetry is harness battery scope' },
      { class: 'F3-config-shape-ignored', reason: 'Loader shape warnings are harness/config; generator only sees resolved RoleConfig' },
      { class: 'F7-agent-json-contract', reason: 'Agent JSON mode is harness self-improve path' },
      { class: 'F8-precommit-false-green', reason: 'Tooling/hook honesty — not a generation task' },
      { class: 'F9-browser-cache-wipe', reason: 'Host ops root cause; symptom covered as INFRA-CHROME classification only' },
    ],
  },
  evaluator: {
    version: 1,
    batteryId: 'evaluator-v1',
    northStar: {
      id: 'hitRateAtFixedFpBudget',
      label: 'hit-rate at fixed FP budget',
      description: `Hit rate only scores when falsePositiveRate ≤ ${EVALUATOR_FP_BUDGET}; otherwise north-star is null (budget miss).`,
    },
    mece: {
      measures: 'Evaluator calibration vs pinned ground truth (hit/FP/consistency/can\'t-tell).',
      doesNotMeasure: 'Artifact beauty (→ generator); harness edits (→ harness); chat stance (→ chat).',
    },
    verifiesLastWaveFixes:
      'Planted cases promoted from prior false-pos/false-neg defects must flip to correct verdict; north-star hitRateAtFixedFpBudget must not drop vs wave-N without deferral.',
    failureSpace: [
      { class: 'gate_fail', tasks: ['eval-friction-subtle-syntax', 'eval-friction-subtle-syntax-2'], note: 'judge must not full-pass subtle syntax that still renders' },
      { class: 'EMPTY-ARTIFACT', tasks: ['eval-friction-rubric-gaming', 'eval-friction-rubric-gaming-2'], note: 'prose-only / empty code must fail' },
      { class: 'INFRA-CHROME', tasks: ['eval-friction-blank-shot', 'eval-friction-blank-shot-2'], note: 'blank screenshot evidence path' },
      { class: 'F1-seat-attribution', tasks: ['eval-clean-01', 'eval-friction-blank-shot'], note: 'receipt model + rejudge pair attribution' },
      { class: 'F2-harness-telemetry', tasks: ['eval-clean-01'], note: 'seat.observation ledger emit per case; gap recorded as finding' },
    ],
    blindSpots: [
      { class: 'F3-config-shape-ignored', reason: 'Config loader — harness/config, not judge suite' },
      { class: 'F4-silent-local-fallback', reason: 'Harness/generator seat resolve; evaluator uses fixed model override in waves' },
      { class: 'F5-param-constraints', reason: 'Param coercion is harness/generator live path' },
      { class: 'F6-bare-api-role-config', reason: 'Bare-script RoleConfig gap is harness/docs' },
      { class: 'F7-agent-json-contract', reason: 'Harness agent JSON mode' },
      { class: 'F8-precommit-false-green', reason: 'Tooling hook — not evaluator planted suite' },
      { class: 'F9-browser-cache-wipe', reason: 'Host ops; blank-shot covers evidence absence not cache wipe' },
    ],
  },
  harness: {
    version: 1,
    batteryId: 'harness-v1',
    northStar: {
      id: 'verifiedEditsPerBoundedPass',
      label: 'verified edits per bounded pass',
      description: 'Fraction of harness tasks that land a verified edit (or clean resume) within the step bound.',
    },
    mece: {
      measures: 'Self-improve edit path: verified edit, rollback, self-checks, resume, telemetry honesty.',
      doesNotMeasure: 'Creative gates/beauty (→ generator); judge calibration (→ evaluator); chat stance (→ chat).',
    },
    verifiesLastWaveFixes:
      'Defect-promoted tasks (e.g. F7 JSON contract, F5 temperature) re-run; verifiedEditsPerBoundedPass and F-class findings must show the fix or document residual. Fix PR one-liner if untestable here.',
    failureSpace: [
      { class: 'F1-seat-attribution', tasks: ['harness-tighten-packet-shaping', 'harness-fix-one-lint-class', 'harness-add-one-guarded-test', 'harness-resume-from-suspend'], note: 'summary/run.json model + seatResolution' },
      { class: 'F2-harness-telemetry', tasks: ['harness-tighten-packet-shaping', 'harness-fix-one-lint-class', 'harness-add-one-guarded-test', 'harness-resume-from-suspend'], note: 'ledger emit required; gap is a finding not a silent skip' },
      { class: 'F3-config-shape-ignored', tasks: ['harness-tighten-packet-shaping'], note: 'RoleConfig resolve + findings if mis-shaped fallback' },
      { class: 'F4-silent-local-fallback', tasks: ['harness-tighten-packet-shaping', 'harness-fix-one-lint-class'], note: 'seat resolve must not silently use localhost defaults' },
      { class: 'F5-param-constraints', tasks: ['harness-tighten-packet-shaping', 'harness-add-one-guarded-test'], note: 'pinned reasoning + live harness param path' },
      { class: 'F6-bare-api-role-config', tasks: ['harness-tighten-packet-shaping'], note: 'loadRoleConfig before run' },
      { class: 'F7-agent-json-contract', tasks: ['harness-tighten-packet-shaping', 'harness-fix-one-lint-class', 'harness-add-one-guarded-test'], note: 'self-improve packet/agent path' },
    ],
    blindSpots: [
      { class: 'F8-precommit-false-green', reason: 'Hook prints green on test fail — no harness task executes the git hook; declared open' },
      { class: 'F9-browser-cache-wipe', reason: 'Host environment; not a self-improve edit task' },
      { class: 'INFRA-CHROME', reason: 'Generator render lane — generator battery' },
      { class: 'EMPTY-ARTIFACT', reason: 'Generator parse/artifact — generator battery' },
      { class: 'gate_fail', reason: 'Generator deterministic gates — generator battery' },
    ],
  },
  chat: {
    version: 1,
    batteryId: 'chat-v1',
    northStar: {
      id: 'stanceAdherence',
      label: 'stance adherence under adversarial script',
      description: 'Mean stanceAdherence score across the 10 audit-stance scripts (tier-1 fixed evaluator / mock rubric).',
    },
    mece: {
      measures: 'Chat/studio audit stance: honesty, usefulness, stance under adversarial scripts + claim tags.',
      doesNotMeasure: 'Code gates (→ generator); planted judge calibration (→ evaluator); verified harness edits (→ harness).',
    },
    verifiesLastWaveFixes:
      'Scripts promoted from prior stance defects re-run; stanceAdherence north-star and claim-tag rate must hold or improve vs wave-N unless deferred.',
    failureSpace: [
      { class: 'F1-seat-attribution', tasks: ['chat-ambiguous-ask', 'chat-hard-truth'], note: 'receipt model field on every script' },
      { class: 'F2-harness-telemetry', tasks: ['chat-ambiguous-ask'], note: 'seat.observation per turn-set; gap as finding' },
      { class: 'F7-agent-json-contract', tasks: ['chat-two-turn-consistency'], note: 'structured consistency across turns (claim tags / deterministic checks)' },
    ],
    blindSpots: [
      { class: 'F3-config-shape-ignored', reason: 'Config loader — not chat scripts' },
      { class: 'F4-silent-local-fallback', reason: 'Harness/generator seat resolve' },
      { class: 'F5-param-constraints', reason: 'Provider param coercion — harness/generator' },
      { class: 'F6-bare-api-role-config', reason: 'Bare-script RoleConfig — harness/docs' },
      { class: 'F8-precommit-false-green', reason: 'Git hook tooling' },
      { class: 'F9-browser-cache-wipe', reason: 'Host ops / render' },
      { class: 'INFRA-CHROME', reason: 'Generator render' },
      { class: 'EMPTY-ARTIFACT', reason: 'Generator artifact' },
      { class: 'gate_fail', reason: 'Generator gates' },
    ],
  },
};

/**
 * Validate failure-space map: every KNOWN class is either traced or blind.
 * Accepts a seat id (looks up BATTERY_DESIGN) or a raw design object (for negative tests).
 * Vacuous maps (empty failureSpace / zero traced) fail closed.
 */
export function validateFailureSpaceMap(seatOrDesign) {
  const design = typeof seatOrDesign === 'string'
    ? BATTERY_DESIGN[seatOrDesign]
    : seatOrDesign;
  if (!design) {
    return { ok: false, errors: [`unknown seat ${seatOrDesign}`], version: null, northStarId: null };
  }
  const failureSpace = Array.isArray(design.failureSpace) ? design.failureSpace : [];
  const blindSpots = Array.isArray(design.blindSpots) ? design.blindSpots : [];
  const traced = new Set(failureSpace.map((f) => f.class).filter(Boolean));
  const blinds = new Set(blindSpots.map((b) => b.class).filter(Boolean));
  const errors = [];

  if (failureSpace.length === 0) {
    errors.push('failureSpace empty');
  }
  if (traced.size === 0) {
    errors.push('no traced failure classes');
  }

  for (const c of KNOWN_FAILURE_CLASSES) {
    if (!traced.has(c) && !blinds.has(c)) {
      errors.push(`unmapped failure class: ${c}`);
    }
    if (traced.has(c) && blinds.has(c)) {
      errors.push(`class both traced and blind: ${c}`);
    }
  }
  for (const f of failureSpace) {
    if (!Array.isArray(f.tasks) || f.tasks.length < 1) {
      errors.push(`class ${f.class} has no tasks`);
    }
  }
  return {
    ok: errors.length === 0,
    errors,
    version: design.version ?? null,
    northStarId: design.northStar?.id ?? null,
    tracedCount: traced.size,
  };
}

export function getBatteryMeta(seat, taskCount) {
  const design = BATTERY_DESIGN[seat];
  if (!design) throw new Error(`Unknown battery seat: ${seat}`);
  return {
    batteryVersion: design.version,
    batteryId: design.batteryId,
    taskCount: taskCount ?? null,
    northStar: design.northStar,
    mece: design.mece,
    verifiesLastWaveFixes: design.verifiesLastWaveFixes,
    blindSpots: design.blindSpots,
    failureSpace: design.failureSpace,
  };
}

/**
 * Tier discipline (design law 4).
 * Tier-0 deterministic first; tier-1 fixed-evaluator only on survivors; tier-2 blind-human only for seat calls.
 */
export function applyTierDiscipline(seat, task, raw) {
  const tiers = {
    order: [TIER.DETERMINISTIC, TIER.FIXED_EVALUATOR, TIER.BLIND_HUMAN],
    labels: { 0: 'deterministic', 1: 'fixed-evaluator', 2: 'blind-human' },
  };

  // ── Tier 0 ──
  let tier0 = { pass: true, reasons: [] };
  if (seat === 'generator') {
    const gates = raw.gatesFinal || raw.gatesAtShot1;
    const allPass = Boolean(raw.gateAtLte3 || gates?.allPass || (gates?.parse?.pass && gates?.render?.pass && gates?.nonblank?.pass));
    tier0 = {
      pass: allPass,
      reasons: allPass ? ['gates-pass'] : ['gate_fail'],
      gates: gates || null,
    };
  } else if (seat === 'evaluator') {
    const fixtureOk = raw.fixturePresent !== false;
    const gtPinned = typeof task.groundTruthPass === 'boolean' || typeof raw.groundTruthPass === 'boolean';
    tier0 = {
      pass: fixtureOk && gtPinned,
      reasons: [
        fixtureOk ? 'fixture-ok' : 'fixture-missing',
        gtPinned ? 'ground-truth-pinned' : 'ground-truth-missing',
      ],
    };
  } else if (seat === 'harness') {
    // Deterministic: task shape + (when present) self-check flags recorded
    const structured = task.kind === 'resume' || task.kind === 'self-improve' || Boolean(task.brief);
    tier0 = {
      pass: structured,
      reasons: structured ? ['task-structured'] : ['task-malformed'],
    };
  } else {
    // chat: deterministic claim-tag / structure checks when present
    const det = raw.deterministic?.claimTagsObservedInferredGuessed;
    const turnsOk = Array.isArray(task.turns) && task.turns.length > 0;
    tier0 = {
      pass: turnsOk,
      reasons: [
        turnsOk ? 'script-present' : 'script-missing',
        det === true ? 'claim-tags-present' : det === false ? 'claim-tags-absent' : 'claim-tags-unchecked',
      ],
      claimTagsPresent: det ?? null,
    };
  }

  // ── Tier 1 (only on tier-0 survivors) ──
  let tier1 = { skipped: true, pass: null, reasons: ['tier-0-failed'] };
  if (tier0.pass) {
    if (seat === 'generator') {
      // Honest live gap: evaluator unreachable/throws → null score + explicit reason
      // (never silent fixed-evaluator-missing after a real attempt).
      if (raw.verdict === 'telemetry-gap' || raw.verdict === 'unavailable' || raw.livePath === 'gap') {
        const score = raw.scores?.eval ?? raw.scores?.evaluator ?? null;
        if (typeof score === 'number') {
          tier1 = {
            skipped: false,
            pass: true,
            reasons: ['fixed-evaluator-scored'],
            score,
            fixedEvaluator: FIXED_EVALUATOR_MODEL,
          };
        } else {
          tier1 = {
            skipped: false,
            pass: true, // honest gap is tier-1 complete (not a silent miss)
            reasons: ['telemetry-gap-honest'],
            score: null,
            fixedEvaluator: FIXED_EVALUATOR_MODEL,
          };
        }
      } else {
        const score = raw.scores?.eval ?? raw.scores?.evaluator ?? null;
        tier1 = {
          skipped: false,
          pass: typeof score === 'number',
          reasons: typeof score === 'number' ? ['fixed-evaluator-scored'] : ['fixed-evaluator-missing'],
          score,
          fixedEvaluator: FIXED_EVALUATOR_MODEL,
        };
      }
    } else if (seat === 'evaluator') {
      // Honest live gap: telemetry-gap is a valid tier-1 outcome (not a silent skip).
      if (raw.verdict === 'telemetry-gap' || raw.verdict === 'unavailable') {
        tier1 = {
          skipped: false,
          pass: true,
          reasons: ['telemetry-gap-honest'],
          passVerdict: null,
          cantTell: false,
        };
      } else if (raw.preCheckRejected || raw.verdict === 'pre_check_rejected') {
        // F15: perception pre-check rejected before LLM judge — counted separately
        tier1 = {
          skipped: false,
          pass: true,
          reasons: ['pre-check-rejected'],
          passVerdict: null,
          cantTell: false,
          preCheckRejected: true,
        };
      } else {
        const judged = raw.cantTell || typeof raw.pass === 'boolean' || raw.verdict === 'cant_tell';
        tier1 = {
          skipped: false,
          pass: Boolean(judged),
          reasons: judged ? ['judge-verdict'] : ['judge-missing'],
          passVerdict: raw.pass,
          cantTell: Boolean(raw.cantTell),
        };
      }
    } else if (seat === 'harness') {
      // Optional GLM is not required; verified-edit is the tier-1 signal for live/mock
      const verified = Boolean(raw.success && (raw.stepsToVerifiedEdit != null || raw.resumed === true || raw.verdict === 'ok'));
      tier1 = {
        skipped: false,
        pass: verified || raw.verdict === 'telemetry-gap' || raw.verdict === 'unavailable', // gap is honest, not a silent skip
        reasons: verified
          ? ['verified-edit-or-resume']
          : [(raw.verdict === 'telemetry-gap' || raw.verdict === 'unavailable') ? 'telemetry-gap-honest' : 'no-verified-edit'],
        glmOptional: true,
      };
    } else {
      // chat: scores required on real path; honest gap counts as tier-1 complete
      if (raw.verdict === 'telemetry-gap' || raw.verdict === 'unavailable') {
        tier1 = {
          skipped: false,
          pass: true,
          reasons: ['telemetry-gap-honest'],
          stanceAdherence: null,
          fixedEvaluator: FIXED_EVALUATOR_MODEL,
        };
      } else {
        const stance = raw.scores?.stanceAdherence;
        tier1 = {
          skipped: false,
          pass: typeof stance === 'number',
          reasons: typeof stance === 'number' ? ['stance-scored'] : ['stance-missing'],
          stanceAdherence: stance ?? null,
          fixedEvaluator: FIXED_EVALUATOR_MODEL,
        };
      }
    }
  }

  // ── Tier 2: blind human only for seat-call decisions (never auto-pass) ──
  let tier2 = { skipped: true, status: 'not-applicable', reasons: ['not-seat-call'] };
  if (tier0.pass && tier1.pass !== false && !tier1.skipped) {
    // Eligible for human seat-call pack; never auto-decides
    tier2 = {
      skipped: false,
      status: 'deferred-to-human',
      reasons: ['seat-call-only', 'no-auto-verdict'],
      includeInBlindPack: seat === 'generator',
    };
  } else if (!tier0.pass) {
    tier2 = { skipped: true, status: 'blocked-by-tier-0', reasons: ['tier-0-failed'] };
  } else {
    tier2 = { skipped: true, status: 'blocked-by-tier-1', reasons: ['tier-1-failed-or-skipped'] };
  }

  const stoppedAt = !tier0.pass ? TIER.DETERMINISTIC
    : (tier1.skipped || tier1.pass === false) ? TIER.FIXED_EVALUATOR
      : TIER.BLIND_HUMAN;

  return {
    ...raw,
    tiers: {
      ...tiers,
      0: tier0,
      1: tier1,
      2: tier2,
      stoppedAt,
    },
  };
}

const REASONING_LEVELS = new Set(['high', 'medium', 'low', 'off', null]);

export function sha256Text(text) {
  return createHash('sha256').update(String(text), 'utf8').digest('hex');
}

export function roleForSeat(seat) {
  if (seat === 'chat') return 'studio';
  return seat;
}

export function parseRotationArgs(argv = []) {
  const out = {
    seat: null,
    subcommand: null,
    model: null,
    out: null,
    reasoning: null,
    dryRun: false,
    live: false,
    help: false,
    a: null,
    b: null,
    mock: false,
    compareA: null,
    compareB: null,
    maxTasks: null,
    auth: null,
    baseUrl: null,
    wave: null,
  };

  if (argv.length === 0) {
    out.help = true;
    return out;
  }

  const head = String(argv[0] || '').toLowerCase();
  if (head === 'help' || head === '--help' || head === '-h') {
    out.help = true;
    return out;
  }
  if (head === 'report') {
    out.subcommand = 'report';
    out.seat = argv[1] ? String(argv[1]).toLowerCase() : null;
  } else if (SEATS.includes(head)) {
    out.subcommand = 'run';
    out.seat = head;
  } else {
    throw new Error(`Unknown rotation subcommand "${head}". Use: generator|evaluator|harness|chat|report`);
  }

  for (let i = out.subcommand === 'report' ? 2 : 1; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') out.help = true;
    else if (a === '--model' && argv[i + 1]) out.model = String(argv[++i]);
    else if (a === '--out' && argv[i + 1]) out.out = path.resolve(argv[++i]);
    else if (a === '--base-url' && argv[i + 1]) out.baseUrl = String(argv[++i]);
    else if (a === '--auth' && argv[i + 1]) {
      const auth = String(argv[++i]).toLowerCase();
      if (!['grok', 'xai', 'roleconfig', 'none'].includes(auth)) {
        throw new Error(`Invalid --auth ${auth} (use grok|xai|roleconfig|none)`);
      }
      out.auth = auth === 'xai' ? 'grok' : auth;
    } else if (a === '--wave' && argv[i + 1]) {
      const w = String(argv[++i]);
      out.wave = w;
    } else if (a === '--reasoning' && argv[i + 1]) {
      const lvl = String(argv[++i]).toLowerCase();
      if (!['high', 'medium', 'low', 'off'].includes(lvl)) {
        throw new Error(`Invalid --reasoning ${lvl} (use high|medium|low|off)`);
      }
      out.reasoning = lvl;
    } else if (a === '--dry-run') out.dryRun = true;
    else if (a === '--live') out.live = true;
    else if (a === '--mock') out.mock = true;
    else if (a === '--a' && argv[i + 1]) out.compareA = path.resolve(argv[++i]);
    else if (a === '--b' && argv[i + 1]) out.compareB = path.resolve(argv[++i]);
    else if (a === '--max-tasks' && argv[i + 1]) {
      const n = Number.parseInt(String(argv[++i]), 10);
      if (!Number.isFinite(n) || n < 1) {
        throw new Error(`Invalid --max-tasks ${argv[i]} (use positive integer)`);
      }
      out.maxTasks = n;
    }
    else if (a.startsWith('-')) {
      throw new Error(`Unknown flag: ${a}`);
    }
  }

  if (out.subcommand === 'run' && !SEATS.includes(out.seat)) {
    throw new Error(`Unknown seat: ${out.seat}`);
  }
  if (out.subcommand === 'report' && out.seat && !SEATS.includes(out.seat)) {
    throw new Error(`Unknown seat for report: ${out.seat}`);
  }
  return out;
}

export function usageText() {
  return `
sinter rotation <seat|report> [flags]

Seats (standing batteries — identical task set across models):
  generator   6 tasks (p5/hydra/kinetic × easy/hard); gates + blind eval
  evaluator   20-case planted suite (hit/FP/consistency/can't-tell)
  harness     3 self-improve tasks + resume-from-suspend
  chat        10 audit-stance scripted conversations

Report:
  sinter rotation report <seat> --a <runDirA> --b <runDirB>

Flags:
  --model <id>       Override seat model (rotation runs). Default: RoleConfig for seat.
  --auth grok|xai    Use Grok OIDC from ~/.grok/auth.json (api.x.ai) for this seat's transport
  --base-url <url>   Override endpoint (with RoleConfig/env key unless --auth supplies one)
  --wave <id>        Tag receipts + ledger payload (e.g. 2) for wave harvest
  --reasoning <lvl>  high|medium|low|off (pinned in receipts; battery default if omitted)
  --out <dir>        Receipt root (default .quality/rotation-<seat>/<model>/<ts>/)
  --dry-run          Load tasks + write empty/mock receipts (no live LLM)
  --mock             Force mock seat runner (CI)
  --live             Attempt live seat calls (requires keys / proxy)
  --max-tasks <n>    Cap task count (proof/smoke; still runs consistency rejudge per task)

Receipts: .quality/rotation-<seat>/<model>/<timestamp>/
Telemetry: seat.observation → runDir/ledger + ~/.sinter/telemetry/events (dual emit).
`.trim();
}

/** Extract hostname (or raw) from a base URL for seatResolution audit. */
export function endpointHostFromUrl(baseUrl) {
  if (!baseUrl || typeof baseUrl !== 'string') return null;
  try {
    return new URL(baseUrl).host || baseUrl;
  } catch {
    return baseUrl;
  }
}

/** Gemini model ids — must use AGY via cliproxy only (never Kilo / bare Google API). */
export function isGeminiModel(model) {
  if (!model || typeof model !== 'string') return false;
  const m = model.toLowerCase();
  return m.includes('gemini') || m.startsWith('google/gemini');
}

/** True when base URL is the Kilo gateway (forbidden for Gemini). */
export function isKiloEndpoint(baseUrl) {
  if (!baseUrl || typeof baseUrl !== 'string') return false;
  const s = baseUrl.toLowerCase();
  return s.includes('kilo.ai') || s.includes('api.kilo');
}

/** True when base URL is local cliproxy (AGY/Codex front door). */
export function isCliproxyEndpoint(baseUrl) {
  if (!baseUrl || typeof baseUrl !== 'string') return false;
  const s = baseUrl.toLowerCase();
  return (
    s.includes('localhost:8317')
    || s.includes('127.0.0.1:8317')
    || s.includes('[::1]:8317')
  );
}

/**
 * Resolve AGY/cliproxy transport for Gemini models.
 * Doctrine: Google Gemini only via AGY OAuth fronted by cliproxy (:8317).
 * Never inherit Kilo evaluator credentials when tour evaluator is K3.
 *
 * @param {{ loadRoleConfig?: Function|null, projectDir?: string }} [opts]
 * @returns {Promise<{ baseUrl: string|null, apiKey: string|null, keySource: string, provider: string|null, findings: string[] }>}
 */
export async function resolveGeminiAgyTransport(opts = {}) {
  const findings = [];
  const projectDir = opts.projectDir || REPO_ROOT;
  const defaultCliproxy =
    process.env.CODEX_PROXY_BASE_URL?.trim()
    || process.env.CLIPROXY_BASE_URL?.trim()
    || 'http://localhost:8317/v1';

  let baseUrl = null;
  let apiKey = null;
  let keySource = 'none';
  let provider = 'openai';

  // 1) Explicit env (preferred)
  if (process.env.CODEX_PROXY_API_KEY?.trim()) {
    apiKey = process.env.CODEX_PROXY_API_KEY.trim();
    keySource = 'env.CODEX_PROXY_API_KEY';
    baseUrl = defaultCliproxy;
  }

  // 2) RoleConfig: any role already on cliproxy (harness Sol often holds the key)
  if (!apiKey || !baseUrl) {
    let loader = opts.loadRoleConfig;
    if (!loader) {
      try {
        const mod = await import(pathToDist('config/RoleConfig.js'));
        loader = mod.loadRoleConfig;
      } catch {
        loader = null;
      }
    }
    if (loader) {
      try {
        const roles = await loader(projectDir);
        for (const roleName of ['harness', 'generator', 'studio', 'evaluator', 'chat']) {
          const r = roles?.[roleName];
          if (!r) continue;
          const b = r.baseUrl || '';
          if (isCliproxyEndpoint(b) && r.apiKey && !isKiloEndpoint(b)) {
            if (!baseUrl) baseUrl = b;
            if (!apiKey) {
              apiKey = r.apiKey;
              keySource = `RoleConfig.${roleName}`;
            }
            provider = r.provider || 'openai';
            break;
          }
        }
      } catch (e) {
        findings.push(
          `Gemini AGY transport: RoleConfig load failed: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }
  }

  if (!baseUrl) baseUrl = defaultCliproxy;
  if (isKiloEndpoint(baseUrl)) {
    findings.push('INVALID: Gemini AGY transport resolved to Kilo — refuse');
    return {
      baseUrl: null,
      apiKey: null,
      keySource: 'none',
      provider: null,
      findings,
    };
  }
  if (!apiKey) {
    findings.push(
      'Gemini AGY transport: missing CODEX_PROXY_API_KEY / cliproxy RoleConfig key — fail closed',
    );
  }
  return { baseUrl, apiKey, keySource, provider, findings };
}

/**
 * True when endpoint is a typical unkeyed local LLM (LM Studio / Ollama).
 * Cliproxy :8317 is NOT unkeyed — it needs a real key.
 */
export function isUnkeyedLocalEndpoint(baseUrl) {
  if (!baseUrl || typeof baseUrl !== 'string') return false;
  try {
    const u = new URL(baseUrl);
    const host = (u.hostname || '').toLowerCase();
    const port = u.port || (u.protocol === 'https:' ? '443' : '80');
    const localHost = host === 'localhost' || host === '127.0.0.1' || host === '::1';
    if (!localHost) return false;
    // Common local inference ports that accept dummy/no key
    return port === '1234' || port === '11434' || port === '8080';
  } catch {
    return /localhost:(1234|11434|8080)\b/i.test(baseUrl);
  }
}

/** Auth / key-class failures — must not be scored as model cantTell skill. */
function withoutPathTokens(text) {
  return text.replace(/(^|[\s"'=(,:[{])(?:[a-z][a-z0-9+.-]*:\/\/|~?\.{0,2}\/)[^\s"',)\]}]*/g, '$1 ');
}

export function isAuthFailureMessage(msg) {
  if (!msg) return false;
  const s = withoutPathTokens(String(msg).toLowerCase());
  // Keep tight: bare "authentication" matches audit-stance prose and false-trips cantTell paths.
  return (
    /\b401\b/.test(s)
    || /\b403\b/.test(s)
    || /\bunauthorized\b/.test(s)
    || /\bforbidden\b/.test(s)
    || /invalid.?api.?key/.test(s)
    || /incorrect.?api.?key/.test(s)
    || /authentication\s*(?:fail|error|denied|required)/.test(s)
    || /auth(?:entication|z)?\s*(?:fail|error|denied)/.test(s)
    || /api[_ ]?key.+(?:missing|invalid|denied|rejected)/.test(s)
    || /\bmissing.?api.?key\b/.test(s)
    // Wave 2: Kilo paid-model gate + cliproxy provider-slot empty
    || /paid_model_auth_required/.test(s)
    || /auth_unavailable/.test(s)
    || /sign in to use this model/.test(s)
    || /no auth available\s*\(providers=/.test(s)
    || /executor_authority_unavailable/.test(s)
  );
}

/** A harness call refused by policy before transport (not a credential problem). */
export function isExecutorBlockMessage(msg) {
  return /executor blocked before transport/i.test(String(msg || ''));
}

/**
 * Join findings / error text for auth detection before productCandidate stamping.
 * Auth/instrument fails must not open Interwave product claims.
 */
export function findingsIndicateAuthFailure(findings = [], ...extra) {
  const parts = [
    ...(Array.isArray(findings) ? findings : [findings]),
    ...extra,
  ].filter((x) => x != null && x !== '');
  return parts.some((p) => isAuthFailureMessage(p));
}

/**
 * Build audit-facing seatResolution (never embeds secret key material).
 */
export function buildSeatResolutionView(seatRes) {
  if (!seatRes) return null;
  const baseUrl = seatRes.baseUrl || null;
  const keyPresent = Boolean(seatRes.apiKey || seatRes.keyPresent);
  let keySource = seatRes.keySource || null;
  if (!keySource) {
    if (seatRes.apiKey && seatRes.source === 'flag') keySource = 'RoleConfig';
    else if (seatRes.apiKey && seatRes.source === 'RoleConfig') keySource = 'RoleConfig';
    else if (seatRes.apiKey && seatRes.source === 'env-fallback') keySource = 'env';
    else if (keyPresent) keySource = 'unknown';
    else keySource = 'none';
  }
  return {
    source: seatRes.source ?? null,
    role: seatRes.role ?? null,
    model: seatRes.model ?? null,
    baseUrl,
    endpointHost: seatRes.endpointHost ?? endpointHostFromUrl(baseUrl),
    provider: seatRes.provider ?? null,
    keyPresent,
    keySource,
  };
}

/**
 * Live transport preflight — fail closed before spending N task calls.
 * seatRunner injects skip transport checks (unit tests).
 */
export function preflightLiveSeat(seatRes, { seatRunner = null } = {}) {
  const findings = [];
  if (seatRunner) {
    return { ok: true, findings };
  }
  if (!seatRes?.baseUrl) {
    findings.push(
      'INVALID: live requested but seatResolution.baseUrl is null '
      + '(--model must keep RoleConfig/env endpoint; refuse silent local fallback)',
    );
    return { ok: false, findings };
  }
  const unkeyedLocal = isUnkeyedLocalEndpoint(seatRes.baseUrl);
  // cli:// seats (CliProvider: codex / claude) authenticate through the CLI's own login,
  // so they carry no apiKey. Only exempt them when the provider really is 'cli'.
  const cliSeat = seatRes.provider === 'cli' && /^cli:\/\//i.test(seatRes.baseUrl);
  if (!seatRes.apiKey && !unkeyedLocal && !cliSeat) {
    findings.push(
      'INVALID: live remote endpoint without apiKey '
      + `(host=${endpointHostFromUrl(seatRes.baseUrl) || '?'}) — refuse wrong-class/null key packs`,
    );
    return { ok: false, findings };
  }
  // Cliproxy / non-local without key already blocked; flag silent :8317 default risk
  if (/localhost:8317|127\.0\.0\.1:8317/i.test(seatRes.baseUrl) && !seatRes.apiKey) {
    findings.push('INVALID: localhost:8317 without apiKey is not an authentic live pack');
    return { ok: false, findings };
  }
  return { ok: true, findings };
}

function hasTokenUsage(u) {
  if (!u) return false;
  return (u.total || 0) > 0 || (u.prompt || 0) > 0 || (u.completion || 0) > 0;
}

/**
 * Post-run authenticity: mode=live with ms latency and no tokens is INVALID.
 * Unit tests that inject tokenUsage still pass even with low latency.
 */
export function detectInauthenticLive({ useMock, taskResults = [] } = {}) {
  if (useMock) return { invalid: false, findings: [] };
  const primary = taskResults.filter((r) => !r.rejudge);
  const authFails = primary.filter(
    (r) => r.verdict === 'auth_invalid' || r.failureClass === 'auth',
  );
  const refused = primary.filter((r) => authFails.includes(r) || r.failureClass === 'executor-blocked');
  const refusal = refused.flatMap((r) => r.findings || [])
    .find((f) => isAuthFailureMessage(f) || isExecutorBlockMessage(f));
  const refusalNote = refusal ? `: ${String(refusal).slice(0, 240)}` : '';
  if (authFails.length > 0 && authFails.length >= Math.ceil(primary.length / 2)) {
    return {
      invalid: true,
      findings: [
        `INVALID: majority auth_invalid (${authFails.length}/${primary.length}${refusalNote}) — not a model skill measurement`,
      ],
    };
  }
  const answered = primary.filter(
    (r) => r.livePath !== 'gap'
      && !refused.includes(r)
      && !(r.resumed != null && !hasTokenUsage(r.tokenUsage)),
  );
  if (refused.length > 0 && answered.length === 0) {
    return {
      invalid: true,
      findings: [
        `INVALID: no primary task answered (${refused.length}/${primary.length} refused before transport${refusalNote}) — not a model skill measurement`,
      ],
    };
  }
  const real = primary.filter(
    (r) => r.livePath !== 'gap'
      && r.verdict !== 'telemetry-gap'
      && r.verdict !== 'unavailable'
      && r.verdict !== 'auth_invalid',
  );
  const withLat = real.filter((r) => typeof r.latencyMs === 'number');
  if (withLat.length === 0) return { invalid: false, findings: [] };
  const sorted = withLat.map((r) => r.latencyMs).sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  const anyTokens = withLat.some((r) => hasTokenUsage(r.tokenUsage));
  if (median < 200 && !anyTokens) {
    return {
      invalid: true,
      findings: [
        `INVALID authenticity: median latency ${median}ms with no token usage — likely auth/local/fake live`,
      ],
    };
  }
  return { invalid: false, findings: [] };
}

/**
 * Resolve seat model from RoleConfig — never hardcode the rotating model.
 * --model flag overrides ONLY the model id; baseUrl/apiKey/provider stay from
 * RoleConfig (or env fallback). Nulling credentials on flag was a P0 defect.
 */
export async function resolveSeatModel(seat, {
  modelOverride = null,
  loadRoleConfig = null,
  projectDir = REPO_ROOT,
} = {}) {
  const role = roleForSeat(seat);
  const findings = [];

  let loader = loadRoleConfig;
  if (!loader) {
    try {
      const mod = await import(pathToDist('config/RoleConfig.js'));
      loader = mod.loadRoleConfig;
    } catch {
      loader = null;
    }
  }

  let roleModel = null;
  let baseUrl = null;
  let apiKey = null;
  let provider = null;
  let temperature;
  let thinking;
  let source = 'RoleConfig';
  let keySource = 'none';

  if (!loader) {
    roleModel = process.env.SINTER_LLM_MODEL || process.env.LIMINAL_LLM_MODEL || 'unresolved';
    baseUrl = process.env.SINTER_LLM_BASE_URL || process.env.LIMINAL_LLM_BASE_URL || process.env.LLM_BASE_URL || null;
    apiKey = process.env.SINTER_LLM_API_KEY || process.env.LIMINAL_LLM_API_KEY || process.env.LLM_API_KEY || null;
    source = 'env-fallback';
    keySource = apiKey ? 'env' : 'none';
    findings.push('RoleConfig module unavailable — used env/fallback; live rotation needs pnpm build');
  } else {
    const roles = await loader(projectDir);
    const resolved = roles[role] || roles.generator || {};
    roleModel = resolved.model ?? null;
    baseUrl = resolved.baseUrl || null;
    apiKey = resolved.apiKey || null;
    provider = resolved.provider || null;
    temperature = resolved.temperature;
    thinking = resolved.thinking;
    // Allow loadRoleConfig injectors (e.g. --auth grok) to label key provenance
    keySource = resolved.keySource
      || (apiKey ? 'RoleConfig' : 'none');
  }

  // Fill gaps from env without inventing localhost defaults
  if (!baseUrl) {
    const envBase = process.env.SINTER_LLM_BASE_URL || process.env.LIMINAL_LLM_BASE_URL || process.env.LLM_BASE_URL || null;
    if (envBase) baseUrl = envBase;
  }
  // An explicit endpoint credential decision must not be refilled by a generic key.
  if (!apiKey && keySource === 'none') {
    const envKey = process.env.SINTER_LLM_API_KEY || process.env.LIMINAL_LLM_API_KEY || process.env.LLM_API_KEY || null;
    if (envKey) {
      apiKey = envKey;
      keySource = 'env';
    }
  }

  const model = modelOverride || roleModel || 'unresolved';
  if (modelOverride) source = 'flag';

  // Law: Gemini only via AGY/cliproxy — never Kilo (tour evaluator may be K3 on Kilo).
  if (isGeminiModel(model)) {
    if (isKiloEndpoint(baseUrl) || !isCliproxyEndpoint(baseUrl)) {
      const agy = await resolveGeminiAgyTransport({
        loadRoleConfig: loader,
        projectDir,
      });
      findings.push(
        ...(agy.findings || []),
        `Gemini model ${model}: forced AGY/cliproxy (was host=${endpointHostFromUrl(baseUrl) || 'null'})`,
      );
      baseUrl = agy.baseUrl;
      apiKey = agy.apiKey;
      keySource = agy.keySource;
      provider = agy.provider || 'openai';
      source = source === 'flag' ? 'flag+agy-cliproxy' : 'agy-cliproxy';
    }
  }

  return {
    seat,
    role,
    model,
    baseUrl,
    provider,
    source,
    apiKey,
    temperature,
    thinking,
    keyPresent: Boolean(apiKey),
    keySource,
    endpointHost: endpointHostFromUrl(baseUrl),
    findings: findings.length ? findings : undefined,
  };
}

/**
 * Fixed evaluator seat for batteries: always FIXED_EVALUATOR_MODEL on AGY/cliproxy.
 * Do not use tour evaluator role credentials when that role is K3/Kilo.
 */
export async function resolveFixedEvaluatorSeat(opts = {}) {
  const agy = await resolveGeminiAgyTransport(opts);
  const findings = [
    ...(agy.findings || []),
  ];
  if (!agy.apiKey || !agy.baseUrl) {
    findings.push(
      `INVALID: fixed evaluator ${FIXED_EVALUATOR_MODEL} cannot resolve AGY/cliproxy credentials`,
    );
  }
  return {
    seat: 'evaluator',
    role: 'evaluator',
    model: FIXED_EVALUATOR_MODEL,
    baseUrl: agy.baseUrl,
    provider: agy.provider || 'openai',
    source: 'fixed-evaluator-agy',
    apiKey: agy.apiKey,
    temperature: 0.2,
    thinking: undefined,
    keyPresent: Boolean(agy.apiKey),
    keySource: agy.keySource,
    endpointHost: endpointHostFromUrl(agy.baseUrl),
    findings: findings.length ? findings : undefined,
  };
}

function pathToDist(rel) {
  return pathToFileURL(path.join(REPO_ROOT, 'dist', rel)).href;
}

export async function loadTaskPack(seat) {
  const file = path.join(ROTATION_TASKS_DIR, seat === 'evaluator' ? 'evaluator-cases.json' : `${seat}.json`);
  const raw = JSON.parse(await fs.readFile(file, 'utf8'));
  if (raw.issue !== ISSUE) {
    throw new Error(`Task pack issue mismatch: expected ${ISSUE}, got ${raw.issue}`);
  }
  return raw;
}

export function listTaskIds(pack) {
  if (Array.isArray(pack.tasks)) return pack.tasks.map((t) => t.id);
  if (Array.isArray(pack.cases)) return pack.cases.map((c) => c.id);
  return [];
}

export function promptHashForTask(task) {
  const text = task.prompt || task.brief || JSON.stringify(task.turns || task);
  return sha256Text(text);
}

export function makeRunDir(seat, model, {
  root = DEFAULT_RECEIPT_ROOT,
  timestamp = new Date().toISOString().replace(/[:.]/g, '-'),
} = {}) {
  const safeModel = String(model).replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 64) || 'unknown';
  return path.join(root, `rotation-${seat}`, safeModel, timestamp);
}

export async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true });
}

export async function writeJson(filePath, data) {
  await ensureDir(path.dirname(filePath));
  await fs.writeFile(filePath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
}

export function buildTaskReceipt({
  seat,
  model,
  taskId,
  promptHash,
  reasoningLevel,
  latencyMs,
  tokenUsage = null,
  verdict,
  metrics = {},
  findings = [],
  telemetryEmitted = true,
  telemetryGap = null,
  batteryVersion = null,
  taskCount = null,
  northStarId = null,
  tiers = null,
  extra = {},
  wave = null,
  pipeHost = null,
  tip = null,
  join = null,
}) {
  const meta = BATTERY_DESIGN[seat];
  const receipt = {
    schemaVersion: RECEIPT_SCHEMA_VERSION,
    issue: ISSUE,
    kind: 'rotation.task',
    seat,
    model,
    taskId,
    promptHash,
    batteryVersion: batteryVersion ?? meta?.version ?? null,
    taskCount: taskCount ?? null,
    northStarId: northStarId ?? meta?.northStar?.id ?? null,
    reasoningLevel: reasoningLevel ?? null,
    latencyMs: latencyMs ?? null,
    tokenUsage: tokenUsage ?? { prompt: null, completion: null, reasoning: null, total: null },
    verdict: verdict ?? null,
    metrics,
    tiers: tiers ?? null,
    findings: [...findings],
    telemetry: {
      emitted: Boolean(telemetryEmitted),
      gap: telemetryGap,
    },
    ts: new Date().toISOString(),
    ...extra,
  };
  // Tour join keys (TI-1): stamp when wave/env present; never invent a fake wave.
  const waveId = wave ?? process.env.LIMINAL_TOUR_WAVE ?? null;
  if (join) {
    receipt.join = join;
  } else if (waveId != null && waveId !== '') {
    receipt.join = {
      tourId: process.env.LIMINAL_TOUR_ID || 'umd-rotation-tour-4x4',
      tourWaveId: `wave-${String(waveId).replace(/[^0-9A-Za-z._-]/g, '')}@${String(tip || process.env.LIMINAL_TOUR_TIP || 'unknown').replace(/[^0-9a-fA-F]/g, '').slice(0, 8) || 'unknown'}`,
      wave: Number.isNaN(Number(waveId)) ? waveId : Number(waveId),
      seat,
      role: seat,
      model,
      pipeHost: pipeHost ?? null,
    };
  }
  return receipt;
}

export function buildSummary({
  seat,
  model,
  batteryId,
  reasoningLevel,
  runDir,
  taskReceipts,
  metrics,
  findings = [],
  seatResolution = null,
  wave = null,
  batteryVersion = null,
  taskCount = null,
  northStar = null,
  design = null,
  mode = null,
  gapTaskIds = null,
  tip = null,
  pipeHost = null,
  join = null,
  fixedJudge = null,
  instrumentVersion = null,
  tipAtStart = null,
}) {
  const meta = BATTERY_DESIGN[seat];
  const ns = northStar || (meta
    ? {
        id: meta.northStar.id,
        label: meta.northStar.label,
        value: metrics?.northStar ?? null,
      }
    : null);
  const resolvedMode = mode ?? null;
  const nsValue = ns && typeof ns === 'object' ? ns.value : metrics?.northStar ?? null;
  const secondaryOk = fitnessAllowsSecondaryMetrics({
    mode: resolvedMode,
    northStar: nsValue,
  });
  const summary = {
    schemaVersion: RECEIPT_SCHEMA_VERSION,
    issue: ISSUE,
    kind: 'rotation.summary',
    seat,
    model,
    batteryId: batteryId ?? meta?.batteryId,
    batteryVersion: batteryVersion ?? meta?.version ?? null,
    taskCount: taskCount ?? (Array.isArray(taskReceipts) ? taskReceipts.filter((r) => !String(r.taskId).endsWith('__re')).length : null),
    northStar: ns,
    mece: design?.mece ?? meta?.mece ?? null,
    verifiesLastWaveFixes: design?.verifiesLastWaveFixes ?? meta?.verifiesLastWaveFixes ?? null,
    blindSpots: design?.blindSpots ?? meta?.blindSpots ?? null,
    reasoningLevel: reasoningLevel ?? null,
    runDir,
    n: taskReceipts.length,
    taskIds: taskReceipts.map((r) => r.taskId),
    metrics,
    findings: [...findings],
    seatResolution,
    wave,
    // mode: 'mock' | 'live' | 'live-partial' — live only when every task took a real live path
    mode: resolvedMode,
    gapTaskIds: Array.isArray(gapTaskIds) ? [...gapTaskIds] : null,
    ts: new Date().toISOString(),
    instrumentVersion: instrumentVersion ?? instrumentVersionFromEnv(),
    tipAtRun: tip || process.env.LIMINAL_TOUR_TIP || null,
    tipAtStart: tipAtStart || process.env.LIMINAL_TOUR_TIP_AT_START || tip || null,
    fitness: {
      scorable: resolvedMode === 'live' && nsValue != null,
      secondaryMetricsAllowed: secondaryOk,
    },
  };
  // Tour join keys (TI-1) + pipeHost always from seatResolution when missing
  const host =
    pipeHost
    ?? seatResolution?.endpointHost
    ?? seatResolution?.baseUrlHost
    ?? null;
  const waveRaw = wave?.id ?? wave ?? process.env.LIMINAL_TOUR_WAVE ?? null;
  if (join) {
    summary.join = { ...join, pipeHost: join.pipeHost ?? host };
  } else if (waveRaw != null && waveRaw !== '') {
    summary.join = resolveTourJoinKeys({
      wave: waveRaw,
      seat,
      model,
      pipeHost: host,
      tip: tip || process.env.LIMINAL_TOUR_TIP,
    });
  }
  // T0-1: fixed judge for gen/chat (and any pack that scored with FIXED_EVALUATOR)
  if (fixedJudge) {
    summary.fixedJudge = fixedJudge;
  } else if (seat === 'generator' || seat === 'chat') {
    summary.fixedJudge = buildFixedJudgeBlock({
      model: FIXED_EVALUATOR_MODEL,
      baseUrl: null,
      endpointHost: null,
      keySource: null,
      source: 'unset',
    });
  }
  // Non-scorable if fixed judge route is not agy-cliproxy (gen/chat)
  if (
    (seat === 'generator' || seat === 'chat')
    && summary.fixedJudge
    && !isFixedJudgeRouteValid(summary.fixedJudge.route)
  ) {
    summary.fitness = {
      scorable: false,
      secondaryMetricsAllowed: false,
      reason: `fixedJudge.route=${summary.fixedJudge.route}`,
    };
  }
  return summary;
}

/**
 * Resolve summary/run mode from whether mock was used and which tasks gapped.
 * live ONLY when every task took a real live path (no mock, no telemetry-gap).
 * INVALID when preflight/authenticity fail — never promote as live skill scoreboard.
 */
export function resolveRunMode({ useMock, gapTaskIds = [], invalid = false } = {}) {
  if (invalid) return 'INVALID';
  if (useMock) return 'mock';
  if (Array.isArray(gapTaskIds) && gapTaskIds.length > 0) return 'live-partial';
  return 'live';
}

/**
 * Honest-null live result (F12). Never fake latency/tokens/scores in live mode.
 * Use when a live seat path is unavailable or fails without real telemetry.
 */
export function honestLiveGap(seat, task, findings = [], {
  verdict = 'telemetry-gap',
  gapClass = null,
} = {}) {
  const inferred = gapClass
    || inferGapClassFromMessage((findings || []).join(' '))
    || 'unknown';
  const klass = normalizeGapClass(inferred);
  const base = {
    success: false,
    verdict,
    latencyMs: null,
    tokenUsage: null,
    findings: [...findings],
    livePath: 'gap',
    gapClass: klass,
    usagePresent: false,
  };
  if (seat === 'generator') {
    return {
      ...base,
      gatesAtShot1: null,
      gatesFinal: null,
      attemptsUsed: null,
      scores: null,
      gateAt1: false,
      gateAtLte3: false,
      domain: task?.domain ?? null,
    };
  }
  if (seat === 'evaluator') {
    return {
      ...base,
      pass: null,
      cantTell: false,
      score: null,
      groundTruthPass: task?.groundTruthPass ?? null,
      label: task?.label ?? null,
      friction: task?.friction ?? null,
      fixturePresent: false,
    };
  }
  if (seat === 'harness') {
    return {
      ...base,
      stepsToVerifiedEdit: null,
      rollbackCorrect: null,
      selfCheckUsed: { build: false, test: false, typecheck: false },
      proposalQuality: null,
      resumed: null,
    };
  }
  // chat
  return {
    ...base,
    scores: null,
    claimTagsPresent: null,
    deterministic: {
      claimTagsObservedInferredGuessed: null,
    },
  };
}

export function buildRotationLedgerEvent({
  seat,
  model,
  taskId,
  runId,
  promptHash,
  latencyMs,
  tokenUsage,
  verdict,
  receiptPath,
  batteryId,
  reasoningLevel,
  wave = null,
  provider = null,
  keySource = null,
  endpointHost = null,
  mode = null,
  tip = null,
  gapClass = null,
  fixedJudge = null,
  usagePresent = null,
  productCandidate = null,
  failureClass = null,
  costUsd = null,
}) {
  const join = resolveTourJoinKeys({
    wave,
    seat,
    model,
    pipeHost: endpointHost ?? null,
    tip,
  });
  const usage = usagePresence(tokenUsage, { costUsd });
  const payload = {
    note: 'rotation-battery',
    seat,
    actorModel: model,
    taskId,
    batteryId,
    reasoningLevel: reasoningLevel ?? null,
    tokenUsage: usage.tokenUsage,
    usagePresent: usagePresent ?? usage.usagePresent,
    costPresent: usage.costPresent,
    wave: wave ?? join?.wave ?? null,
    keySource: keySource ?? null,
    endpointHost: endpointHost ?? null,
    pipeHost: endpointHost ?? null,
    mode: mode ?? null,
    campaign: wave != null ? `wave-${wave}` : 'rotation',
    gapClass: gapClass ? normalizeGapClass(gapClass) : null,
    // T0-2: full join keys dual-emitted (not only on pack receipt)
    tourId: join?.tourId ?? null,
    tourWaveId: join?.tourWaveId ?? null,
    tip: join?.tip ?? null,
    tipAtStart: join?.tipAtStart ?? null,
    instrumentVersion: instrumentVersionFromEnv(),
    productCandidate: productCandidate ?? null,
    failureClass: failureClass ?? null,
  };
  if (fixedJudge) {
    payload.judge = fixedJudge;
    payload.judgeModel = fixedJudge.model ?? null;
    payload.judgeHost = fixedJudge.endpointHost ?? null;
  }
  return {
    event: 'seat.observation',
    model: model ?? null,
    provider: provider ?? null,
    role: roleForSeat(seat),
    runId,
    episodeId: `${seat}:${taskId}:${(promptHash || '').slice(0, 12)}`,
    domain: seat,
    inputHash: promptHash ? `sha256:${promptHash}` : null,
    verdict: verdict ?? null,
    latencyMs: latencyMs ?? null,
    costUsd: usage.costUsd,
    evidenceRefs: [receiptPath].filter(Boolean).map(String),
    payload,
  };
}

/**
 * H-TELEM-02 / T1-1: planted evaluator case → home eval lane (not Gemini fixedJudge).
 * instrument = planted-GT; subjectModel = tour evaluator brain.
 */
export function buildEvaluatorCaseEvent({
  model,
  taskId,
  runId,
  promptHash,
  latencyMs,
  tokenUsage,
  verdict,
  receiptPath,
  batteryId,
  reasoningLevel,
  wave = null,
  provider = null,
  keySource = null,
  endpointHost = null,
  mode = null,
  tip = null,
  pass = null,
  cantTell = null,
  preCheckRejected = null,
  score = null,
  groundTruthPass = null,
  label = null,
  friction = null,
  failureClass = null,
  gapClass = null,
  costUsd = null,
}) {
  const join = resolveTourJoinKeys({
    wave,
    seat: 'evaluator',
    model,
    pipeHost: endpointHost ?? null,
    tip,
  });
  const usage = usagePresence(tokenUsage, { costUsd });
  return {
    // Lane = first dotted segment → home ~/.sinter/telemetry/events/eval/
    // Must NOT use seat.* (would collide seat.observation analytics) or eval.verdict
    // (generator fixedJudge scores). Dedicated planted-GT event name.
    event: 'eval.planted_case',
    model: model ?? null,
    provider: provider ?? null,
    role: roleForSeat('evaluator'),
    runId,
    episodeId: `evaluator:${taskId}:${(promptHash || '').slice(0, 12)}`,
    domain: 'evaluator',
    inputHash: promptHash ? `sha256:${promptHash}` : null,
    verdict: verdict ?? null,
    latencyMs: latencyMs ?? null,
    costUsd: usage.costUsd,
    evidenceRefs: [receiptPath].filter(Boolean).map(String),
    payload: {
      note: 'planted-gt-case',
      seat: 'evaluator',
      subjectModel: model,
      instrument: 'planted-GT',
      eventKind: 'planted_case',
      taskId,
      batteryId,
      reasoningLevel: reasoningLevel ?? null,
      tokenUsage: usage.tokenUsage,
      usagePresent: usage.usagePresent,
      costPresent: usage.costPresent,
      pass,
      cantTell,
      preCheckRejected,
      score,
      groundTruthPass,
      label,
      friction,
      failureClass: failureClass ?? null,
      gapClass: gapClass ? normalizeGapClass(gapClass) : null,
      wave: wave ?? join?.wave ?? null,
      keySource: keySource ?? null,
      endpointHost: endpointHost ?? null,
      pipeHost: endpointHost ?? null,
      mode: mode ?? null,
      campaign: wave != null ? `wave-${wave}` : 'rotation',
      tourId: join?.tourId ?? null,
      tourWaveId: join?.tourWaveId ?? null,
      tip: join?.tip ?? null,
      tipAtStart: join?.tipAtStart ?? null,
      instrumentVersion: instrumentVersionFromEnv(),
    },
  };
}

/**
 * H-TELEM-04 / T2-1: final pack mode + NS for home-ledger filtering without joining packs.
 */
export function buildPackCompleteEvent({
  seat,
  model,
  runId,
  batteryId,
  mode,
  northStar = null,
  northStarId = null,
  wave = null,
  tip = null,
  endpointHost = null,
  provider = null,
  fixedJudge = null,
  taskCount = null,
  gapTaskIds = null,
  productCandidates = null,
}) {
  const join = resolveTourJoinKeys({
    wave,
    seat,
    model,
    pipeHost: endpointHost ?? null,
    tip,
  });
  return {
    event: 'seat.pack_complete',
    model: model ?? null,
    provider: provider ?? null,
    role: roleForSeat(seat),
    runId,
    episodeId: `${seat}:pack:${(runId || '').slice(0, 12)}`,
    domain: seat,
    inputHash: null,
    verdict: mode === 'live' ? 'ok' : mode,
    latencyMs: null,
    costUsd: null,
    evidenceRefs: [],
    payload: {
      note: 'pack-complete',
      seat,
      actorModel: model,
      batteryId,
      mode,
      northStar,
      northStarId,
      taskCount,
      gapTaskIds: gapTaskIds || [],
      productCandidates: productCandidates || [],
      wave: wave ?? join?.wave ?? null,
      campaign: wave != null ? `wave-${wave}` : 'rotation',
      endpointHost: endpointHost ?? null,
      pipeHost: endpointHost ?? null,
      tourId: join?.tourId ?? null,
      tourWaveId: join?.tourWaveId ?? null,
      tip: join?.tip ?? null,
      tipAtStart: join?.tipAtStart ?? null,
      instrumentVersion: instrumentVersionFromEnv(),
      fixedJudge: fixedJudge || null,
    },
  };
}

/**
 * Prefer EventLedger when available; otherwise write audition-style JSONL under runDir/ledger.
 * Never invent telemetry — record gap as finding when emission fails.
 */
export async function emitLedgerEvent(event, { runDir, recordEvent = null } = {}) {
  const findings = [];
  let filePath = null;
  const ledgerBase = path.join(runDir, 'ledger');
  /** Dual emit: pack-local ledger + durable home ~/.sinter/telemetry (wave harvest). */
  const homeTelemetryBase = path.join(os.homedir(), '.sinter', 'telemetry', 'events');

  try {
    let recorder = recordEvent;
    if (!recorder) {
      try {
        const mod = await import(pathToDist('telemetry/EventLedger.js'));
        recorder = mod.recordEvent;
      } catch {
        recorder = null;
      }
    }

    if (recorder) {
      const result = await recorder(event, {
        baseDir: ledgerBase,
        forceInTest: true,
      });
      filePath = result?.filePath || null;
      // Best-effort home mirror for cross-wave query (never fail pack on home write)
      try {
        await recorder(event, { baseDir: homeTelemetryBase, forceInTest: true });
      } catch (homeErr) {
        findings.push(
          `Home telemetry mirror failed: ${homeErr instanceof Error ? homeErr.message : String(homeErr)}`,
        );
      }
      return { ok: true, filePath, findings };
    }

    // Fallback: raw JSONL (still on-disk evidence). Lane = first dotted event segment
    // (same as EventLedger.laneForEvent) so eval.planted_case → eval/, not seat/.
    const eventName = String(event?.event || 'seat.observation');
    const lane = eventName.includes('.') ? eventName.slice(0, eventName.indexOf('.')) : eventName;
    await ensureDir(path.join(ledgerBase, lane));
    const day = new Date().toISOString().slice(0, 10);
    filePath = path.join(ledgerBase, lane, `${day}.jsonl`);
    const row = {
      schemaVersion: 2,
      ts: new Date().toISOString(),
      ...event,
    };
    await fs.appendFile(filePath, `${JSON.stringify(row)}\n`, 'utf8');
    findings.push(
      `EventLedger module unavailable — wrote raw ${lane} JSONL under runDir/ledger`,
    );
    try {
      await ensureDir(path.join(homeTelemetryBase, lane));
      await fs.appendFile(
        path.join(homeTelemetryBase, lane, `${day}.jsonl`),
        `${JSON.stringify(row)}\n`,
        'utf8',
      );
    } catch {
      /* home mirror optional */
    }
    return { ok: true, filePath, findings, degraded: true };
  } catch (err) {
    findings.push(`Telemetry emit failed: ${err instanceof Error ? err.message : String(err)}`);
    return { ok: false, filePath: null, findings };
  }
}

/** Deterministic mock seat response for CI — no live calls. */
export function mockSeatResult(seat, task, { passBias = 0.7 } = {}) {
  const hash = promptHashForTask(task);
  const seed = parseInt(hash.slice(0, 8), 16);
  const pass = (seed % 100) / 100 < passBias;
  const latencyMs = 50 + (seed % 200);
  const tokens = {
    prompt: 100 + (seed % 50),
    completion: 80 + (seed % 40),
    reasoning: seat === 'harness' ? 20 + (seed % 30) : null,
    total: null,
  };
  tokens.total = tokens.prompt + tokens.completion + (tokens.reasoning || 0);

  if (seat === 'generator') {
    return {
      success: pass,
      verdict: pass ? 'ok' : 'fail',
      latencyMs,
      tokenUsage: tokens,
      gatesAtShot1: { parse: { pass }, render: { pass }, nonblank: { pass }, allPass: pass },
      gatesFinal: { parse: { pass }, render: { pass }, nonblank: { pass }, allPass: pass },
      attemptsUsed: pass ? 1 : 2,
      scores: { eval: pass ? 0.72 : 0.31 },
      gateAt1: pass,
      gateAtLte3: pass,
    };
  }
  if (seat === 'evaluator') {
    const gt = task.groundTruthPass;
    // mock: high accuracy but not perfect; some can't-tell
    const cantTell = (seed % 17) === 0;
    let predicted = gt;
    if (!cantTell && (seed % 11) === 0) predicted = !gt;
    return {
      success: !cantTell,
      verdict: cantTell ? 'cant_tell' : predicted ? 'pass' : 'fail',
      latencyMs,
      tokenUsage: tokens,
      pass: cantTell ? null : predicted,
      cantTell,
      score: cantTell ? null : predicted ? 0.78 : 0.22,
      groundTruthPass: gt,
      label: task.label,
      friction: task.friction,
    };
  }
  if (seat === 'harness') {
    return {
      success: pass,
      verdict: pass ? 'ok' : 'fail',
      latencyMs,
      tokenUsage: tokens,
      stepsToVerifiedEdit: pass ? 4 + (seed % 8) : null,
      rollbackCorrect: pass,
      selfCheckUsed: { build: true, test: pass, typecheck: true },
      proposalQuality: pass ? 0.7 : 0.4,
      resumed: task.kind === 'resume' ? pass : null,
    };
  }
  // chat
  const hasClaimTags = (seed % 5) !== 0;
  return {
    success: pass,
    verdict: pass ? 'ok' : 'fail',
    latencyMs,
    tokenUsage: tokens,
    scores: {
      honesty: pass ? 0.8 : 0.4,
      usefulness: pass ? 0.75 : 0.45,
      stanceAdherence: pass ? 0.82 : 0.5,
    },
    claimTagsPresent: hasClaimTags,
    deterministic: {
      claimTagsObservedInferredGuessed: hasClaimTags,
    },
  };
}

export function computeGeneratorMetrics(results) {
  const n = results.length;
  let gateAt1 = 0;
  let gateAtLte3 = 0;
  let attemptsSum = 0;
  let latencySum = 0;
  let evalSum = 0;
  let evalN = 0;
  // North-star: blind-eval score of gate-passers only (design law 3)
  let blindSum = 0;
  let blindN = 0;
  for (const r of results) {
    if (r.gateAt1 || r.gatesAtShot1?.allPass) gateAt1 += 1;
    const attempts = r.attemptsUsed ?? 1;
    const gatePass = Boolean(r.gateAtLte3 || r.gatesFinal?.allPass || r.success);
    if (gatePass && attempts <= 3) gateAtLte3 += 1;
    attemptsSum += attempts;
    latencySum += r.latencyMs || 0;
    const s = r.scores?.eval ?? r.scores?.evaluator;
    if (typeof s === 'number') {
      evalSum += s;
      evalN += 1;
    }
    if (gatePass && typeof s === 'number') {
      blindSum += s;
      blindN += 1;
    }
  }
  const blindEvalScoreOfGatePassers = blindN ? blindSum / blindN : null;
  return {
    n,
    gateAt1,
    gateAt1Rate: n ? gateAt1 / n : null,
    gateAtLte3,
    gateAtLte3Rate: n ? gateAtLte3 / n : null,
    meanAttempts: n ? attemptsSum / n : null,
    meanLatencyMs: n ? latencySum / n : null,
    meanEvalScore: evalN ? evalSum / evalN : null,
    blindEvalScoreOfGatePassers,
    northStar: blindEvalScoreOfGatePassers,
    northStarId: 'blindEvalScoreOfGatePassers',
  };
}

export function computeEvaluatorMetrics(results) {
  let hit = 0;
  let hitDenom = 0;
  let fp = 0;
  let fpDenom = 0;
  let cantTell = 0;
  let preCheckRejected = 0;
  let authInvalid = 0;
  let scored = 0;
  const byCase = new Map();

  for (const r of results) {
    // Consistency pairs use primary + rejudge; primary north-star rates exclude rejudge.
    const key = r.taskId || r.itemId || r.id;
    if (!byCase.has(key)) byCase.set(key, []);
    if (typeof r.pass === 'boolean' || r.pass === null) {
      byCase.get(key).push(r.pass);
    }

    if (r.rejudge) continue;

    scored += 1;
    // Auth is not a judge skill outcome
    if (r.verdict === 'auth_invalid' || r.failureClass === 'auth') {
      authInvalid += 1;
      continue;
    }
    // F15: pre-check/render rejection is its own bucket — never a judge hit or miss.
    if (
      r.preCheckRejected === true
      || r.verdict === 'pre_check_rejected'
      || r.failureClass === 'render'
    ) {
      preCheckRejected += 1;
      continue;
    }
    // Telemetry gaps are not judge verdicts either
    if (r.verdict === 'telemetry-gap' || r.verdict === 'unavailable' || r.livePath === 'gap') {
      continue;
    }
    if (r.cantTell || r.verdict === 'cant_tell') {
      cantTell += 1;
      continue;
    }
    const predicted = r.pass;
    const gt = r.groundTruthPass;
    if (typeof predicted === 'boolean' && typeof gt === 'boolean') {
      hitDenom += 1;
      if (predicted === gt) hit += 1;
      if (gt === false) {
        fpDenom += 1;
        if (predicted === true) fp += 1;
      }
    }
  }

  // consistency: cases judged twice with same predicted pass (judge verdicts only)
  let consistentPairs = 0;
  let pairDenom = 0;
  for (const preds of byCase.values()) {
    if (preds.length < 2) continue;
    pairDenom += 1;
    if (preds[0] === preds[1]) consistentPairs += 1;
  }

  const hitRate = hitDenom ? hit / hitDenom : null;
  const falsePositiveRate = fpDenom ? fp / fpDenom : null;
  // North-star: hit-rate only when FP stays under fixed budget (design law 3).
  // Unknown FP (null, e.g. all cant_tell → fpDenom=0) is a budget miss — never fake 1.0.
  // Measured on real judge verdicts only (F15); preCheckRejected excluded from denom.
  const budgetOk = typeof falsePositiveRate === 'number' && falsePositiveRate <= EVALUATOR_FP_BUDGET;
  const hitRateAtFixedFpBudget = budgetOk ? hitRate : null;
  return {
    n: scored,
    hitRate,
    hits: hit,
    hitDenom,
    falsePositiveRate,
    falsePositives: fp,
    fpDenom,
    fpBudget: EVALUATOR_FP_BUDGET,
    fpBudgetHeld: budgetOk,
    cantTellRate: scored ? cantTell / scored : null,
    cantTell,
    authInvalid,
    authInvalidRate: scored ? authInvalid / scored : null,
    preCheckRejected,
    preCheckRejectedRate: scored ? preCheckRejected / scored : null,
    consistencyRate: pairDenom ? consistentPairs / pairDenom : null,
    consistencyPairs: pairDenom,
    hitRateAtFixedFpBudget,
    northStar: hitRateAtFixedFpBudget,
    northStarId: 'hitRateAtFixedFpBudget',
  };
}

export function computeHarnessMetrics(results) {
  const n = results.length;
  let stepsSum = 0;
  let stepsN = 0;
  let rollbackOk = 0;
  let rollbackN = 0;
  let build = 0;
  let test = 0;
  let typecheck = 0;
  let propSum = 0;
  let propN = 0;
  let resumeOk = 0;
  let resumeN = 0;
  let success = 0;
  let verifiedEdits = 0;

  for (const r of results) {
    if (r.success) success += 1;
    // Verified edit: success with steps recorded, or clean resume
    if (r.success && (typeof r.stepsToVerifiedEdit === 'number' || r.resumed === true)) {
      verifiedEdits += 1;
    } else if (r.success && r.verdict === 'ok') {
      verifiedEdits += 1;
    }
    if (typeof r.stepsToVerifiedEdit === 'number') {
      stepsSum += r.stepsToVerifiedEdit;
      stepsN += 1;
    }
    if (typeof r.rollbackCorrect === 'boolean') {
      rollbackN += 1;
      if (r.rollbackCorrect) rollbackOk += 1;
    }
    if (r.selfCheckUsed?.build) build += 1;
    if (r.selfCheckUsed?.test) test += 1;
    if (r.selfCheckUsed?.typecheck) typecheck += 1;
    if (typeof r.proposalQuality === 'number') {
      propSum += r.proposalQuality;
      propN += 1;
    }
    if (r.resumed != null) {
      resumeN += 1;
      if (r.resumed) resumeOk += 1;
    }
  }

  const verifiedEditsPerBoundedPass = n ? verifiedEdits / n : null;
  return {
    n,
    successRate: n ? success / n : null,
    meanStepsToVerifiedEdit: stepsN ? stepsSum / stepsN : null,
    rollbackCorrectRate: rollbackN ? rollbackOk / rollbackN : null,
    selfCheckUsage: {
      buildRate: n ? build / n : null,
      testRate: n ? test / n : null,
      typecheckRate: n ? typecheck / n : null,
    },
    meanProposalQuality: propN ? propSum / propN : null,
    resumeSuccessRate: resumeN ? resumeOk / resumeN : null,
    verifiedEditsPerBoundedPass,
    northStar: verifiedEditsPerBoundedPass,
    northStarId: 'verifiedEditsPerBoundedPass',
  };
}

export function computeChatMetrics(results) {
  const n = results.length;
  let honesty = 0;
  let usefulness = 0;
  let stance = 0;
  let scored = 0;
  let claimTags = 0;
  let success = 0;
  for (const r of results) {
    if (r.success) success += 1;
    const s = r.scores || {};
    if (typeof s.honesty === 'number') {
      honesty += s.honesty;
      usefulness += s.usefulness || 0;
      stance += s.stanceAdherence || 0;
      scored += 1;
    }
    if (r.claimTagsPresent || r.deterministic?.claimTagsObservedInferredGuessed) claimTags += 1;
  }
  const stanceAdherence = scored ? stance / scored : null;
  return {
    n,
    successRate: n ? success / n : null,
    meanHonesty: scored ? honesty / scored : null,
    meanUsefulness: scored ? usefulness / scored : null,
    meanStanceAdherence: stanceAdherence,
    claimTagRate: n ? claimTags / n : null,
    stanceAdherence,
    northStar: stanceAdherence,
    northStarId: 'stanceAdherence',
  };
}

/**
 * Compare two summary.json runs. Small-n caveats always included.
 * Cross-mode / INVALID packs do not declare skill winners.
 */
export function compareSummaries(summaryA, summaryB, { seat } = {}) {
  const a = summaryA?.metrics || {};
  const b = summaryB?.metrics || {};
  const modeA = summaryA?.mode ?? null;
  const modeB = summaryB?.mode ?? null;
  const bothModeMissing = modeA == null && modeB == null;
  // Legacy summaries without mode remain comparable. Explicit modes must match.
  // INVALID is never skill-comparable. Same-mode mock is comparable only with caveats.
  const modesComparable = bothModeMissing
    || (
      Boolean(modeA)
      && Boolean(modeB)
      && modeA === modeB
      && modeA !== 'INVALID'
    );
  const modeMismatch = Boolean(modeA) && Boolean(modeB) && modeA !== modeB;
  const anyInvalid = modeA === 'INVALID' || modeB === 'INVALID';
  const anyMock = modeA === 'mock' || modeB === 'mock';

  const keys = new Set([...Object.keys(flattenMetrics(a)), ...Object.keys(flattenMetrics(b))]);
  const rows = [];
  for (const key of [...keys].sort()) {
    const va = flattenMetrics(a)[key];
    const vb = flattenMetrics(b)[key];
    if (typeof va !== 'number' && typeof vb !== 'number') continue;
    let winner = 'tie';
    if (!modesComparable) {
      winner = 'incomparable';
    } else if (typeof va === 'number' && typeof vb === 'number') {
      // lower-is-better keys
      const lowerBetter = /latency|falsePositive|cantTell|authInvalid|meanAttempts|meanSteps/i.test(key);
      if (Math.abs(va - vb) < 1e-9) winner = 'tie';
      else if (lowerBetter) winner = va < vb ? 'a' : 'b';
      else winner = va > vb ? 'a' : 'b';
    } else if (typeof va === 'number') winner = 'a';
    else winner = 'b';
    rows.push({ metric: key, a: va ?? null, b: vb ?? null, winner });
  }
  const caveats = [
    'n is small — treat deltas as directional, not statistically significant.',
    'Do not overclaim from single-wave receipts.',
    'Attribution: non-touring seats must stay pinned while a model tours.',
  ];
  if (modeMismatch) {
    caveats.unshift(
      `MODE MISMATCH: A.mode=${modeA} vs B.mode=${modeB} — winners marked incomparable; do not promote skill ranking.`,
    );
  }
  if (anyInvalid) {
    caveats.unshift('INVALID pack present — authenticity/auth failed; not a model skill comparison.');
  }
  if (anyMock && !anyInvalid) {
    caveats.unshift('mock pack present — not a live skill comparison.');
  }
  if (modeA === 'live-partial' || modeB === 'live-partial') {
    caveats.push('live-partial: some tasks gapped — deltas are directional only.');
  }
  return {
    schemaVersion: RECEIPT_SCHEMA_VERSION,
    issue: ISSUE,
    kind: 'rotation.report',
    seat: seat || summaryA?.seat || summaryB?.seat,
    modelA: summaryA?.model ?? null,
    modelB: summaryB?.model ?? null,
    modeA,
    modeB,
    modesComparable: Boolean(modesComparable),
    nA: summaryA?.n ?? null,
    nB: summaryB?.n ?? null,
    rows,
    caveats,
    ts: new Date().toISOString(),
  };
}

function flattenMetrics(obj, prefix = '', out = {}) {
  if (obj == null || typeof obj !== 'object') return out;
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (typeof v === 'number') out[key] = v;
    else if (v && typeof v === 'object' && !Array.isArray(v)) flattenMetrics(v, key, out);
  }
  return out;
}

export function validateReceiptSchema(receipt) {
  const errors = [];
  if (receipt?.schemaVersion !== RECEIPT_SCHEMA_VERSION) errors.push('schemaVersion');
  if (receipt?.issue !== ISSUE) errors.push('issue');
  if (!receipt?.kind) errors.push('kind');
  if (!receipt?.seat) errors.push('seat');
  if (!receipt?.model && receipt.kind === 'rotation.task') errors.push('model');
  if (receipt.kind === 'rotation.task' && !receipt.taskId) errors.push('taskId');
  if (receipt.kind === 'rotation.task' && !receipt.promptHash) errors.push('promptHash');
  return { ok: errors.length === 0, errors };
}

/** Wave schedule (Simon, 2026-07-27) — encoded for docs + tooling. */
export const WAVE_SCHEDULE = {
  approvedAt: '2026-07-27',
  attributionRule: 'non-touring seats stay pinned while a model tours',
  gateBeforeWave2: 'baseline capture — flash + pro-low run their seat batteries first (control group)',
  waves: [
    {
      id: 0,
      name: 'baseline',
      note: 'Control group before wave 2',
      seats: {
        generator: 'gemini-3.6-flash-high',
        evaluator: 'gemini-3.1-pro-low',
        harness: null,
        chat: 'gemini-3.6-flash-high',
      },
    },
    {
      id: 1,
      name: 'wave-1',
      seats: {
        harness: 'kimi-k3',
        generator: 'gemini-3.6-flash-high',
        evaluator: 'gemini-3.1-pro-low',
        chat: 'gemini-3.6-flash-high',
      },
    },
    {
      id: 2,
      name: 'wave-2',
      seats: {
        harness: 'anthropic/claude-opus-5',
        harnessReasoning: 'medium',
        harnessRoute: 'Kilo paid gateway',
        // Grok 4.5 via Grok OIDC (~/.grok/auth.json → api.x.ai); K3 parked; Sol demoted to alt
        generator: 'grok-4.5',
        generatorRoute: 'xAI OIDC (grok auth)',
        generatorAlt: 'gpt-5.6-sol',
        generatorNote: 'K3 parked; Grok 4.5 primary generator tour for wave 2',
        evaluator: 'gemini-3.1-pro-low',
        chat: 'gemini-3.6-flash-high',
      },
    },
    {
      id: 3,
      name: 'wave-3',
      seats: {
        // Owner 2026-07-28: K3 spends Kilo credits as architect-diagnose (NO product edits).
        // Sol/Grok implement after K3 plan is fully specced.
        harness: 'moonshotai/kimi-k3',
        harnessMode: 'diagnose-plan-only',
        harnessRoute: 'Kilo gateway — FORBID mutations; complete(params.plan) only',
        harnessReasoning: 'high',
        generator: 'gpt-5.6-sol',
        generatorReasoning: 'high',
        generatorRoute: 'cliproxy — implementer after K3 plan (not primary this wave)',
        evaluator: 'grok-4.5',
        evaluatorReasoning: 'high',
        evaluatorRoute: 'xAI OIDC (grok auth)',
        chat: 'gemini-3.6-flash-high',
        chatNote: 'control pin',
        note: 'K3 harness DIAGNOSE/PLAN only · Sol gen HIGH · Grok eval HIGH · flash chat',
      },
    },
    {
      id: 4,
      name: 'wave-4',
      seats: {
        harness: 'gpt-5.6-sol',
        harnessReasoning: 'high',
        harnessRoute: 'cliproxy — implement K3 wave-3 plan (product mutations allowed)',
        generator: 'grok-4.5',
        generatorReasoning: 'high',
        generatorRoute: 'xAI OIDC (grok auth)',
        evaluator: 'moonshotai/kimi-k3',
        evaluatorRoute: 'Kilo — judge/diagnose residual only; still no product edits',
        evaluatorMode: 'diagnose-or-judge',
        chat: 'gemini-3.6-flash-high',
        note: 'Sol implements K3 plan · Grok gen HIGH · K3 eval/diagnose',
      },
    },
    {
      id: 5,
      name: 'wave-5',
      seats: {
        harness: 'grok-4.5',
        harnessReasoning: 'high',
        harnessRoute: 'xAI OIDC — implement remaining plan items',
        generator: 'gpt-5.6-sol',
        generatorReasoning: 'high',
        generatorRoute: 'cliproxy / RoleConfig',
        evaluator: 'moonshotai/kimi-k3',
        evaluatorRoute: 'Kilo diagnose/judge; no product edits',
        chat: 'gemini-3.6-flash-high',
        note: 'Grok harness HIGH · Sol gen HIGH · K3 eval (no implement)',
      },
    },
    {
      id: 6,
      name: 'wave-6-8-chat-tour',
      seats: {
        chat: 'rotators-tour',
        order: ['gpt-5.6-sol', 'moonshotai/kimi-k3', 'grok-4.5'],
        solReasoning: 'high',
        grokReasoning: 'high',
        kimiNote: 'K3 chat is stance/diagnose only — never product code edits',
        note: 'one rotator on chat per wave; Sol+Grok high; K3 no implement',
      },
    },
  ],
  retrospectiveGate: [
    'harvest',
    'synthesis',
    'triage-to-work',
    'memory-consolidation',
    'dreaming-pass',
    'gate-check',
  ],
};

export { REASONING_LEVELS };
