#!/usr/bin/env node
/**
 * sinter rotation — standing per-seat batteries for model rotation (#401)
 */
import { isSeatRateLimit, RATE_LIMIT_EXIT } from './rate-sub.mjs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { runBattery, loadSummary } from './batteries.mjs';
import {
  GROK_DEFAULT_MODEL,
  isGrokModelId,
  loadGrokOidcAuth,
} from './grok-auth.mjs';
import {
  compareSummaries,
  parseRotationArgs,
  roleForSeat,
  usageText,
  WAVE_SCHEDULE,
  writeJson,
} from './shared.mjs';
import { canonicalizeHost, classifyEndpoint, hostsMatch } from './host-identity.mjs';

/**
 * Pick apiKey for an explicit --base-url so tour brains (Sol/GLM/K3) do not inherit
 * the wrong RoleConfig seat's credentials.
 * Uses canonicalizeHost / classifyEndpoint (Wave 3A P0-2) — not brittle raw-string compares alone.
 * @param {string} baseUrl
 * @param {Record<string, { apiKey?: string, baseUrl?: string, provider?: string, model?: string }>} roles
 * @param {{ role?: string, modelOverride?: string|null, env?: NodeJS.ProcessEnv }} [opts]
 * @returns {{ patch: Record<string, unknown>, keySource: string }}
 */
export function resolveBaseUrlCredentials(baseUrl, roles = {}, opts = {}) {
  const env = opts.env || process.env;
  const role = opts.role || 'generator';
  const prev = roles[role] || {};
  const gen = roles.generator || {};
  const harness = roles.harness || {};
  const studio = roles.studio || {};
  const evaluator = roles.evaluator || {};
  const all = [harness, gen, studio, evaluator, prev];

  // Hostname/port family only — never raw URL path (Terra PR#589 high finding).
  const family = classifyEndpoint(baseUrl);
  const cliproxy = family === 'cliproxy';
  const ollama = family === 'ollama';
  const kilo = family === 'kilo';
  const zai = family === 'zai';
  const xai = family === 'xai';
  const deepseek = family === 'deepseek';
  const targetHost = canonicalizeHost(baseUrl);

  const isCliproxyRole = (r) => r?.apiKey && classifyEndpoint(r.baseUrl) === 'cliproxy';
  const isKiloRole = (r) => r?.apiKey && classifyEndpoint(r.baseUrl) === 'kilo';
  const isZaiRole = (r) => r?.apiKey && classifyEndpoint(r.baseUrl) === 'zai';
  const hostMatchedDonor = (r) =>
    r?.apiKey && targetHost && hostsMatch(r.baseUrl, baseUrl);

  if (cliproxy) {
    // Prefer host-matched RoleConfig seat, then any cliproxy seat, never Grok xAI key.
    // Do not fall back to "any harness.apiKey" unless harness is itself cliproxy-classified.
    const donor = all.find(hostMatchedDonor) || all.find(isCliproxyRole);
    if (donor?.apiKey) {
      return {
        keySource: 'RoleConfig.cliproxy+base-url',
        patch: {
          apiKey: donor.apiKey,
          provider: donor.provider || 'openai',
          keySource: 'RoleConfig.cliproxy+base-url',
        },
      };
    }
    return {
      keySource: 'missing-cliproxy-key',
      patch: {
        apiKey: undefined,
        provider: 'openai',
        keySource: 'missing-cliproxy-key',
      },
    };
  }

  if (ollama) {
    // Ollama (localhost:11434) needs no real key — the OpenAI-compatible API
    // accepts any value. Return a dummy key so the client doesn't fail closed.
    return {
      keySource: 'ollama-local-no-key-required',
      patch: {
        apiKey: 'ollama',
        provider: 'openai',
        keySource: 'ollama-local-no-key-required',
      },
    };
  }

  if (kilo) {
    // Only Kilo-classified seats — never "first any apiKey" (would leak xAI/cliproxy).
    const kiloDonor = all.find(hostMatchedDonor) || all.find(isKiloRole);
    if (kiloDonor?.apiKey) {
      return {
        keySource: 'RoleConfig.kilo+base-url',
        patch: {
          apiKey: kiloDonor.apiKey,
          provider: 'kilo',
          keySource: 'RoleConfig.kilo+base-url',
        },
      };
    }
    return {
      keySource: 'missing-kilo-key',
      patch: { apiKey: undefined, provider: 'kilo', keySource: 'missing-kilo-key' },
    };
  }

  if (zai) {
    // GLM on z.ai — zai-classified RoleConfig first, then env. Never Kilo JWT.
    const zaiDonor = all.find(hostMatchedDonor) || all.find(isZaiRole);
    const zaiKey =
      zaiDonor?.apiKey
      || env.HARNESS_API_KEY
      || env.GLM_API_KEY
      || env.Z_AI_API_KEY
      || env.ZAI_API_KEY
      || env.LLM_API_KEY
      || null;
    if (zaiKey) {
      const fromStudio = zaiDonor && zaiDonor === studio;
      return {
        keySource: fromStudio ? 'RoleConfig.studio+base-url' : (zaiDonor ? 'RoleConfig.zai+base-url' : 'env.glm/z.ai+base-url'),
        patch: {
          apiKey: zaiKey,
          provider: 'anthropic',
          keySource: fromStudio ? 'RoleConfig.studio+base-url' : (zaiDonor ? 'RoleConfig.zai+base-url' : 'env.glm/z.ai+base-url'),
        },
      };
    }
    return {
      keySource: 'missing-glm-key',
      patch: {
        apiKey: undefined,
        provider: 'anthropic',
        keySource: 'missing-glm-key',
      },
    };
  }

  if (xai) {
    // xAI should use --auth grok; if we land here, do not invent keys
    return {
      keySource: 'xai-use-auth-grok',
      patch: {
        apiKey: undefined,
        provider: 'openai',
        keySource: 'xai-use-auth-grok',
      },
    };
  }

  if (deepseek) {
    const donor = prev.apiKey && classifyEndpoint(prev.baseUrl) === 'deepseek' ? prev : null;
    const key = donor?.apiKey || env.DEEPSEEK_API_KEY || env.DEEPSEEK_PRO_API_KEY;
    const keySource = donor ? 'RoleConfig.deepseek+base-url'
      : (key ? 'env.deepseek+base-url' : 'missing-deepseek-key');
    return {
      keySource,
      patch: { apiKey: key || undefined, provider: 'openai', keySource },
    };
  }

  // A rejected DeepSeek transport must not reuse a host-matched key below.
  if (targetHost?.split(':')[0] === 'api.deepseek.com') {
    return {
      keySource: 'unknown-host-no-credentials',
      patch: { apiKey: undefined, keySource: 'unknown-host-no-credentials' },
    };
  }

  // Unknown host: fail closed unless prev seat is host-matched (Terra PR#589 medium).
  if (prev.apiKey && targetHost && hostsMatch(prev.baseUrl, baseUrl)) {
    return {
      keySource: 'RoleConfig.host-matched',
      patch: {
        apiKey: prev.apiKey,
        provider: prev.provider,
        keySource: 'RoleConfig.host-matched',
      },
    };
  }
  return {
    keySource: 'unknown-host-no-credentials',
    patch: { apiKey: undefined, keySource: 'unknown-host-no-credentials' },
  };
}

export async function main(argv = process.argv.slice(2), deps = {}) {
  // Live rotation against RoleConfig cliproxy (localhost:8317) needs SSRF
  // localhost LLM allow — same flag e2e suites set. Only default-on when unset.
  if (process.env.LIMINAL_ALLOW_LOCALHOST_LLM == null) {
    process.env.LIMINAL_ALLOW_LOCALHOST_LLM = 'true';
  }

  // F9/F23: durable browser home + system Chrome before any seat battery
  try {
    const { ensureRotationBrowserEnv, resolveChromeExecutable } = await import('./chrome.mjs');
    ensureRotationBrowserEnv();
    if (!process.env.PUPPETEER_EXECUTABLE_PATH) {
      const chrome = resolveChromeExecutable();
      if (chrome) process.env.PUPPETEER_EXECUTABLE_PATH = chrome;
    }
  } catch {
    /* optional — batteries still try chrome.mjs at launch */
  }

  let args;
  try {
    args = parseRotationArgs(argv);
  } catch (err) {
    console.error(`[rotation] ${err instanceof Error ? err.message : err}`);
    console.error(usageText());
    return 2;
  }

  if (args.help) {
    console.log(usageText());
    console.log('');
    console.log('Wave schedule (encoded):');
    console.log(JSON.stringify(WAVE_SCHEDULE.waves.map((w) => ({ id: w.id, name: w.name, seats: w.seats })), null, 2));
    return 0;
  }

  if (args.subcommand === 'report') {
    return runReport(args, deps);
  }

  const seat = args.seat;
  // One decision for every spend-affecting mode. The host CLI's global parser consumes --dry-run before this
  // helper sees argv and hands it back as deps.dryRun, so dry-run must be merged exactly like live/mock.
  // Dry-run is the no-spend mode and wins over --live: a contradictory pair never reaches a provider.
  const dryRunMerged = Boolean(args.dryRun || deps.dryRun);
  const liveMerged = Boolean(args.live || deps.live) && !dryRunMerged;
  const mockMerged = Boolean(args.mock || deps.mock);

  // F24: live generator/harness shells bin/sinter → dist/index.js
  if (
    liveMerged
    && !mockMerged
    && process.env.LIMINAL_SKIP_DIST_PREFLIGHT !== '1'
    && (seat === 'generator' || seat === 'harness')
  ) {
    const fs = await import('node:fs');
    const distIndex = path.join(process.cwd(), 'dist', 'index.js');
    if (!fs.existsSync(distIndex)) {
      console.error(
        `[rotation] FATAL F24: missing ${distIndex}. Run \`pnpm build\` in this worktree before live ${seat}.`,
      );
      return 2;
    }
  }

  // --- Transport resolution: Grok OIDC / base-url override -----------------
  let modelOverride = args.model || deps.model || null;
  let loadRoleConfig = deps.loadRoleConfig || null;
  let authNote = null;

  const wantGrok =
    args.auth === 'grok'
    || isGrokModelId(modelOverride)
    || (args.auth == null && modelOverride && isGrokModelId(modelOverride));

  if (wantGrok && liveMerged && !mockMerged) {
    try {
      const grok = await loadGrokOidcAuth({
        model: modelOverride || GROK_DEFAULT_MODEL,
        baseUrl: args.baseUrl || undefined,
      });
      modelOverride = modelOverride || grok.model;
      const role = roleForSeat(seat);
      const innerLoader = loadRoleConfig;
      loadRoleConfig = async (projectDir) => {
        let roles = {};
        if (innerLoader) {
          roles = await innerLoader(projectDir);
        } else {
          try {
            const mod = await import(
              pathToFileURL(path.join(process.cwd(), 'dist', 'config', 'RoleConfig.js')).href
            ); // eslint-disable-line
            roles = await mod.loadRoleConfig(projectDir);
          } catch {
            roles = {};
          }
        }
        const prev = roles[role] || {};
        return {
          ...roles,
          [role]: {
            ...prev,
            model: modelOverride,
            baseUrl: grok.baseUrl,
            apiKey: grok.apiKey,
            provider: grok.provider,
            keySource: grok.keySource,
            grokSubscriptionSeat: grok.keySource === 'grok-oidc',
          },
        };
      };
      if (!process.env.XAI_API_KEY && !process.env.GROK_API_KEY && grok.apiKey) {
        process.env.XAI_API_KEY = grok.apiKey;
      }
      authNote = `auth=grok-oidc endpoint=${grok.baseUrl} keySource=${grok.keySource}`
        + (grok.expiresAt ? ` expires=${grok.expiresAt}` : '');
      console.log(`[rotation] ${authNote}`);
    } catch (err) {
      console.error(`[rotation] Grok auth failed: ${err instanceof Error ? err.message : err}`);
      return 3;
    }
  } else if (args.baseUrl && liveMerged) {
    // Explicit endpoint override without Grok auth.
    // Match credentials to the TARGET host — never reuse Grok xAI JWT on cliproxy
    // or Kilo JWT on z.ai (Wave 2 failure: chat 401 + eval missing-glm-key).
    const role = roleForSeat(seat);
    const baseUrl = args.baseUrl;
    const innerLoader = loadRoleConfig;
    loadRoleConfig = async (projectDir) => {
      let roles = {};
      if (innerLoader) roles = await innerLoader(projectDir);
      else {
        try {
          const mod = await import(
            pathToFileURL(path.join(process.cwd(), 'dist', 'config', 'RoleConfig.js')).href
          );
          roles = await mod.loadRoleConfig(projectDir);
        } catch {
          roles = {};
        }
      }
      const cred = resolveBaseUrlCredentials(baseUrl, roles, {
        role,
        modelOverride,
        env: process.env,
      });
      return {
        ...roles,
        [role]: {
          ...(roles[role] || {}),
          baseUrl,
          model: modelOverride || roles[role]?.model,
          ...cred.patch,
        },
      };
    };
  }

  console.log(
    `[rotation] seat=${seat} model=${modelOverride || '(RoleConfig)'} `
    + `dryRun=${dryRunMerged} mock=${mockMerged} live=${liveMerged}`
    + (args.wave != null ? ` wave=${args.wave}` : ''),
  );

  let result;
  try {
    result = await (deps.runBattery || runBattery)(seat, {
      modelOverride,
      reasoning: args.reasoning,
      out: args.out,
      dryRun: dryRunMerged,
      mock: mockMerged,
      live: liveMerged,
      rateLimitModel: liveMerged && !mockMerged ? modelOverride : null,
      maxTasks: args.maxTasks ?? deps.maxTasks ?? null,
      loadRoleConfig,
      seatRunner: deps.seatRunner,
      liveAdapters: deps.liveAdapters,
      recordEvent: deps.recordEvent,
      wave: args.wave ?? deps.wave ?? null,
    });
  } catch (error) {
    if (liveMerged && !mockMerged && isSeatRateLimit(error, modelOverride)) return RATE_LIMIT_EXIT;
    throw error;
  }

  console.log(`[rotation] mode=${result.mode}`);
  if (result.mode === 'live-partial' && result.gapTaskIds?.length) {
    console.log(`[rotation] gapTasks=${result.gapTaskIds.join(',')}`);
  }
  if (result.mode === 'INVALID') {
    console.error('[rotation] INVALID pack — authenticity/auth preflight failed; do not promote scoreboard');
  }
  console.log(`[rotation] runDir=${result.runDir}`);
  console.log(`[rotation] tasks=${result.receipts.length}`);
  console.log(`[rotation] metrics=${JSON.stringify(result.metrics)}`);
  if (result.summary?.seatResolution) {
    console.log(`[rotation] seatResolution=${JSON.stringify(result.summary.seatResolution)}`);
  }
  if (result.findings?.length) {
    console.log(`[rotation] findings (${result.findings.length}):`);
    for (const f of result.findings.slice(0, 12)) console.log(`  - ${f}`);
  }
  if (result.blindPack) {
    const nBlind = result.blindPack.index
      ? Object.keys(result.blindPack.index).length
      : (result.blindPack.entries?.length ?? 0);
    console.log(`[rotation] blind-pack entries=${nBlind}`);
  }
  // Fail-closed exit codes for automation (never green-wash bad measurement packs)
  if (result.mode === 'INVALID') return 3;
  if (result.mode === 'live-partial' && liveMerged) return 1;
  return 0;
}

async function runReport(args, deps) {
  if (!args.compareA || !args.compareB) {
    console.error('[rotation] report requires --a <runDirA> --b <runDirB>');
    return 2;
  }
  if (!args.seat) {
    console.error('[rotation] report requires seat: sinter rotation report <seat> --a ... --b ...');
    return 2;
  }

  const load = deps.loadSummary || loadSummary;
  const summaryA = await load(args.compareA);
  const summaryB = await load(args.compareB);
  const report = compareSummaries(summaryA, summaryB, { seat: args.seat });

  const outPath = args.out
    || path.join(args.compareA, '..', `report-${summaryA.model}-vs-${summaryB.model}.json`);
  await writeJson(outPath, report);

  console.log(`[rotation] report seat=${args.seat}`);
  console.log(`  A: ${report.modelA} (n=${report.nA})`);
  console.log(`  B: ${report.modelB} (n=${report.nB})`);
  console.log('');
  console.log('metric | a | b | winner');
  console.log('-------|---|---|-------');
  for (const row of report.rows) {
    console.log(`${row.metric} | ${fmt(row.a)} | ${fmt(row.b)} | ${row.winner}`);
  }
  console.log('');
  for (const c of report.caveats) console.log(`  caveat: ${c}`);
  console.log(`[rotation] wrote ${outPath}`);
  return 0;
}

function fmt(v) {
  if (v == null) return '—';
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : v.toFixed(4);
  return String(v);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().then((code) => process.exit(code ?? 0)).catch((err) => {
    console.error(`[rotation] FATAL: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  });
}
