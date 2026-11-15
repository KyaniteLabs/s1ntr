/**
 * RoleConfig - Three-role model configuration for model-agnostic LLM routing
 *
 * Each role (Generator, Evaluator, Harness) is independently configurable
 * with its own provider, model, and parameters. Config is loaded from:
 *   1. Environment variables (explicit user intent — SINTER_/LIMINAL_ prefixed)
 *   2. ./config/sinter.json (project-level)
 *   3. ~/.sinter/config.json (user-level)
 *   4. Conservative defaults
 *
 * Priority: Env vars > Project config > User config > Defaults
 * (env-over-file matches ConfigLoader.getEffectiveConfig; env vars are the
 * user's explicit runtime intent and must beat persisted file values.)
 */

import { readFile } from 'fs/promises';
import { join } from 'path';
import { homedir } from 'os';
import { env } from '../utils/env.js';
import { CapabilityRegistry } from '../llm/CapabilityRegistry.js';
import { Logger } from '../utils/Logger.js';
import { TIMEOUT_DEFAULT_MS, TIMEOUT_EVALUATOR_MS } from '../constants/limits.js';
import type { ModelCapabilities } from '../llm/CapabilityRegistry.js';
import type { ThinkingConfig } from '../llm/ProviderTypes.js';
import { getEffectiveConfig, updateConfig } from './ConfigLoader.js';
import { selectApiKeyForEndpoint } from './ProviderKeyResolver.js';
import { PROVIDER_DEFAULTS, detectRoleProviderType, resolveProviderAlias } from './ProviderRuntime.js';
import {
  KILO_SEAT_MODELS,
  CODEX_PROXY_HARNESS_SEAT,
  CODEX_PROXY_GENERATOR_SEAT,
  CODEX_PROXY_EVALUATOR_SEAT,
  isKiloGatewayUrl,
  isOllamaCloudUrl,
  isCodexProxyUrl,
  isSeatFrontedUrl,
  getCodexProxyApiKey,
  getCodexProxyApiKeyFromEnv,
  getCodexProxyBaseUrl,
} from './KiloGateway.js';
import { resolveRoleConfig as evaluateRoleConfig } from '../identity/roleIntegration.js';

// ── Types ──

export type ModelRole = 'generator' | 'evaluator' | 'harness' | 'studio';
export type FatalRoleConfigCode = 'CODEX_PROXY_API_KEY_REQUIRED' | 'HARNESS_ROLE_CONFIG_REJECTED' | 'USER_CONFIG_INVALID'
  | 'DECISION_MODEL_AT_WRITING_SEAT' | 'DECISION_HEAD_INVALID';

export class FatalRoleConfigError extends Error {
  constructor(readonly code: FatalRoleConfigCode, detail: string) {
    super(`${code}: ${detail}`);
    this.name = 'FatalRoleConfigError';
  }
}

export function isFatalRoleConfigError(error: unknown): error is FatalRoleConfigError {
  return error instanceof FatalRoleConfigError;
}
export type ProviderType =
  | 'openai'
  | 'anthropic'
  | 'ollama'
  | 'openrouter'
  | 'google'
  | 'minimax'
  | 'glm'
  | 'lmstudio'
  | 'kimi'
  | 'moonshot'
  | 'kilo'
  | 'custom';

export interface RoleProviderConfig {
  /** Provider type — auto-detected from baseUrl if omitted */
  provider?: ProviderType;
  baseUrl: string;
  apiKey?: string;
  model: string;
  temperature?: number;
  maxTokens?: number;
  timeout?: number;
  thinking?: ThinkingConfig;
  streaming?: boolean;
  /** True when this role rides the owner-authorized z.ai coding-plan seat. */
  glmCodingPlanSeat?: boolean;
  /**
   * Optional decision head (e.g. Liquid AI d1-2B) paired with this seat's chat
   * model: the chat model writes, the decision head answers the seat's typed
   * gate/pick/score questions through DecisionModelClient. Any seat may have one.
   */
  decisionHead?: DecisionHeadConfig;
}

export interface DecisionHeadConfig {
  baseUrl: string;
  model: string;
  timeout?: number;
}

export interface EvolutionTunables {
  enabled?: boolean;
  temperatureRange?: { min: number; max: number };
  maxTokensRange?: { min: number; max: number };
  mutationRate?: number;
}

export interface RoleConfigFile {
  roles: {
    generator: RoleProviderConfig;
    evaluator?: RoleProviderConfig;
    harness?: RoleProviderConfig;
    studio?: RoleProviderConfig;
    /**
     * Optional local (e.g. local host) generator endpoint. When set, the hybrid
     * router sends local-favored domains here instead of the cloud `generator`;
     * absent → everything stays on `generator` (no behavior change).
     */
    generatorLocal?: RoleProviderConfig;
  };
  /** Fallback chain per role — try these if primary fails */
  fallbacks?: Partial<Record<ModelRole, RoleProviderConfig[]>>;
  /** Capability overrides — takes priority over static CapabilityRegistry */
  capabilities?: Record<string, Partial<ModelCapabilities>>;
  /** Evolution tuning parameters */
  evolution?: EvolutionTunables;
}

export interface ResolvedRoleConfig {
  provider?: ProviderType;
  glmCodingPlanSeat?: boolean;
  baseUrl: string;
  apiKey?: string;
  model: string;
  temperature: number;
  maxTokens: number;
  timeout: number;
  thinking: ThinkingConfig;
  streaming: boolean;
  decisionHead?: Required<DecisionHeadConfig>;
}

/**
 * Seats whose job is writing (code, plans, conversation) need a generative
 * model; a decision model there could never produce the seat's output. Only
 * the evaluator may run a decision model alone, because scoring is decision-shaped.
 */
const DECISION_SOLO_SEATS: ReadonlySet<ModelRole> = new Set(['evaluator']);

function resolveDecisionHead(role: ModelRole, fileRole: RoleProviderConfig | undefined,
  timeout: number): Required<DecisionHeadConfig> | undefined {
  const upper = role.toUpperCase();
  const envModel = firstEnvValue([`${upper}_DECISION_MODEL`]);
  const envBaseUrl = firstEnvValue([`${upper}_DECISION_BASE_URL`]);
  const file = fileRole?.decisionHead;
  // Endpoint and model come from the same layer, like the seat's own config.
  const fromEnv = Boolean(envModel || envBaseUrl);
  const model = fromEnv ? envModel?.value : file?.model;
  const baseUrl = fromEnv ? envBaseUrl?.value : file?.baseUrl;
  if (!model && !baseUrl) return undefined;
  if (!model || !baseUrl || !/^https?:\/\//.test(baseUrl)) {
    throw new FatalRoleConfigError('DECISION_HEAD_INVALID',
      `role '${role}' decision head needs both a model and an http(s) baseUrl`);
  }
  if (!CapabilityRegistry.isDecisionModel(model)) {
    throw new FatalRoleConfigError('DECISION_HEAD_INVALID',
      `role '${role}' decision head ${model} is not a decision model`);
  }
  return { model, baseUrl, timeout: file?.timeout ?? timeout };
}

// ── Defaults ──

// Anthropic is the product's default provider (bring your own ANTHROPIC_API_KEY).
// A fresh user with no config file but ANTHROPIC_API_KEY set resolves every role
// to the Claude Messages API. The private instance / local-dev setups override
// these via ~/.sinter/config.json or SINTER_LLM_* env vars.
const DEFAULT_BASE_URL = PROVIDER_DEFAULTS.anthropic.baseUrl;
const DEFAULT_MODEL = PROVIDER_DEFAULTS.anthropic.model;
const DEFAULT_TEMPERATURES: Record<ModelRole, number> = {
  generator: 0.7,   // Creative — needs variety
  evaluator: 0.2,   // Precise — needs consistency
  harness: 0.5,     // Balanced — reasoning + action
  studio: 0.6,      // Conversational — creative-first, structured enough to delegate
};
const DEFAULT_MAX_TOKENS = 4096;
// Role defaults sized for reasoning models: a 120 s default cut long generator
// calls (#708). The evaluator judge answers with a short JSON verdict (#709).
function defaultRoleTimeout(role: string): number {
  return role === 'evaluator' ? TIMEOUT_EVALUATOR_MS : TIMEOUT_DEFAULT_MS;
}

function envTimeout(role: string): number | undefined {
  const upper = role.toUpperCase();
  const raw =
    process.env[`SINTER_${upper}_TIMEOUT_MS`] ??
    process.env[`LIMINAL_${upper}_TIMEOUT_MS`] ??
    process.env.SINTER_LLM_TIMEOUT_MS ??
    process.env.LIMINAL_LLM_TIMEOUT_MS;
  if (raw === undefined) return undefined;
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

// ── Config Loading ──

const CONFIG_DIR = join(homedir(), '.sinter');
const DEFAULT_USER_CONFIG_PATH = join(CONFIG_DIR, 'config.json');

/**
 * Resolve the user config path. Honors `SINTER_CONFIG_PATH` (preferred) or
 * `LIMINAL_CONFIG_PATH` (back-compat, matching the TUI bridge launcher) so a single
 * process — e.g. a background daemon that should run on a different/cheaper model than
 * interactive runs — can point at its own config file WITHOUT mutating the shared
 * ~/.sinter/config.json. Read per call so the override is honored at use time.
 */
export function resolveUserConfigPath(): string {
  const override = (process.env.SINTER_CONFIG_PATH ?? process.env.LIMINAL_CONFIG_PATH)?.trim();
  return override ? override : DEFAULT_USER_CONFIG_PATH;
}

/**
 * Load and resolve role-based configuration from all sources.
 *
 * Resolution order per role (per field: baseUrl, model, apiKey):
 *   1. Environment variables (role-specific then generic)
 *   2. Project config (config/sinter.json) `roles.<role>`
 *   3. User config (~/.sinter/config.json) `roles.<role>`
 *   4. Conservative defaults
 *
 * After loading, applies capability overrides to CapabilityRegistry.
 */
export async function loadRoleConfig(projectDir?: string): Promise<Record<ModelRole, ResolvedRoleConfig>> {
  const fileConfig = await loadConfigFile();
  const projectConfig = await loadProjectConfig(projectDir);

  // Merge: project > user (project overrides user for same keys)
  let merged = mergeConfigs(fileConfig, projectConfig);

  // No explicit role config from files? Derive the generator default from the
  // effective config so a provider KEY the user actually has — OpenAI, Google,
  // OpenRouter, MiniMax, GLM, a custom OpenAI-/Anthropic-compatible endpoint, … —
  // wins over the bare Anthropic fallback. "Use whatever provider you need" then
  // works from a single env var (e.g. OPENAI_API_KEY) with no config file.
  // getEffectiveConfig key-sniffs every provider via providerFromAvailableApiKey;
  // it only yields an apiKey when a real provider was detected, so with NO key we
  // fall through to the Anthropic default in resolveRole(). This also still covers
  // the legacy UserConfig (defaultProvider/providers) shape.
  // Guard on !env('LLM_BASE_URL'): when an explicit base URL is set via env,
  // resolveRole() already reads it (and its matching key) directly. Detouring
  // through getEffectiveConfig() there would let an unrelated ambient provider
  // key in the environment (e.g. a stray GLM_API_KEY) shadow the user's explicit
  // key. So this key-detection fallback only fires for the key-only case.
  if (!merged?.roles && !env('LLM_BASE_URL')) {
    const effective = await getEffectiveConfig();
    if (effective.baseUrl && effective.apiKey) {
      merged = {
        roles: {
          generator: {
            baseUrl: effective.baseUrl,
            model: effective.model || DEFAULT_MODEL,
            apiKey: effective.apiKey,
          },
        },
      };
    }
  }

  // Apply capability overrides to registry
  if (merged?.capabilities) {
    for (const [model, caps] of Object.entries(merged.capabilities)) {
      CapabilityRegistry.override(model, caps);
    }
  }

  // Resolve each role. Generator resolves first; the other roles inherit its
  // provider identity (model + key + url) when not explicitly configured, so
  // configuring a single model makes every role work — only the role-specific
  // sampling (temperature/streaming) differs. Without this, an unset role
  // silently fell back to the local LM Studio default with model "unknown",
  // breaking harness/studio flows whenever the user set only generator/evaluator.
  // OPENAI_* footgun notice (wave-10 defect #5): OPENAI_BASE_URL / OPENAI_API_KEY
  // are NOT read by Sinter (the canonical surface is LIMINAL_/SINTER_ vars or
  // ~/.sinter/config.json). Warn once when they are set but no Sinter endpoint is
  // active, so the misroute is visible instead of a silent fall-through.
  warnIfOpenAiEnvIgnored(merged);

  const generator = resolveRole('generator', merged);
  const evaluator = resolveRole('evaluator', merged, generator);
  const harness = resolveRole('harness', merged, generator);
  const studio = resolveRole('studio', merged, generator);

  const harnessSource = merged?.roles?.harness
    ? 'project-config' as const
    : 'generator-to-harness-inheritance' as const;
  const harnessDecision = evaluateRoleConfig({
    role: 'harness', sourceLayer: harnessSource, phase: 'post-merged-resolution',
    requestedModelAlias: harness.model,
    requestedEffort: harness.thinking.effort ?? 'high',
    providerHint: harness.provider === 'custom' ? 'unknown' : harness.provider,
    policyInvokedAt: ['post-merged-resolution'], substitutionAllowed: false,
  });
  if (!harnessDecision.allowed && !harnessDecision.decision.ok
    && harnessDecision.decision.reason === 'role-luna-harness-forbidden') {
    const decision = harnessDecision.decision;
    const reason = decision.ok ? 'unknown' : `${decision.reason}: ${decision.detail}`;
    throw new FatalRoleConfigError('HARNESS_ROLE_CONFIG_REJECTED', reason);
  }

  return { generator, evaluator, harness, studio };
}

/**
 * Resolve a single role's configuration from merged file config + env vars.
 *
 * Env vars beat file values per field (env = explicit user intent). A file
 * apiKey is NEVER paired with an env/flag endpoint: endpoint and credential
 * come from the same layer, or the key is chosen endpoint-aware from env.
 */

// Notices for overridden file role values are emitted once per process (the
// resolver can run several times per CLI invocation; the user needs the
// override exactly once, not a flood).
const emittedOverrideNotices = new Set<string>();

/**
 * Clear the dedupe cache for override notices. Exported for tests, mirroring
 * LLMClient.clearGlobalCache().
 */
export function clearRoleOverrideNoticeCache(): void {
  emittedOverrideNotices.clear();
}

function emitOverrideNotice(line: string): void {
  if (emittedOverrideNotices.has(line)) return;
  emittedOverrideNotices.add(line);
  console.error(line); // eslint-disable-line no-console -- intentional user-facing config notice
}
/**
 * Wave-10 defect #5: OPENAI_BASE_URL is the de-facto standard for the OpenAI SDK,
 * so users expect Sinter to route through it. Sinter does not — it reads
 * LIMINAL_/SINTER_ vars or ~/.sinter/config.json. (OPENAI_API_KEY IS sniffed by
 * getEffectiveConfig, but the URL is not, so a custom proxy URL silently routes
 * to the provider default instead.) Warn once when OPENAI_BASE_URL is set but no
 * explicit LIMINAL_/SINTER_ endpoint is active, pointing at the correct surface.
 *
 * The guard checks only the explicit env signal: the merged file config is
 * unreliable here because getEffectiveConfig may have synthesized a generator
 * baseUrl from the very OPENAI_API_KEY we are warning about.
 */
function warnIfOpenAiEnvIgnored(_fileConfig: RoleConfigFile | null): void {
  const openaiBase = process.env.OPENAI_BASE_URL;
  if (!openaiBase) return;
  // An explicit LIMINAL_/SINTER_ endpoint is the active Sinter surface →
  // OPENAI_BASE_URL is ambient shell noise; do not warn.
  if (firstEnvValue(['LLM_BASE_URL'])) return;
  emitOverrideNotice(
    `[config] OPENAI_BASE_URL detected but ignored — Sinter reads SINTER_LLM_BASE_URL / ` +
    `SINTER_LLM_API_KEY and ~/.sinter/config.json. ` +
    `Set those instead to route the generator.`,
  );
}

/**
 * First set env var from `keys` (in priority order), with the winning full
 * variable name (SINTER_ preferred, LIMINAL_ back-compat) for notices.
 */
/**
 * Resolve thinking/reasoning config from env (highest priority) or file.
 * Env keys (via env()): LLM_THINKING_EFFORT, REASONING_EFFORT, LLM_THINKING
 * Values: off|false|0|none → disabled; true|on|1 → high; low|medium|high|max.
 */
export function resolveThinkingConfig(fileThinking?: ThinkingConfig): ThinkingConfig {
  const fromEnv = firstEnvValue(['LLM_THINKING_EFFORT', 'REASONING_EFFORT', 'LLM_THINKING']);
  if (fromEnv?.value) {
    const v = fromEnv.value.trim().toLowerCase();
    if (v === '0' || v === 'false' || v === 'off' || v === 'none' || v === 'disabled') {
      return { enabled: false };
    }
    const effort = (v === '1' || v === 'true' || v === 'on' ? 'high' : v) as 'low' | 'medium' | 'high' | 'max';
    if (effort === 'low' || effort === 'medium' || effort === 'high' || effort === 'max') {
      const budgetTokens = effort === 'max' ? 32_000
        : effort === 'high' ? 16_000 : effort === 'medium' ? 8_000 : 4_000;
      return { enabled: true, effort, budgetTokens };
    }
  }
  return fileThinking ?? { enabled: false };
}

function firstEnvValue(keys: string[]): { name: string; value: string } | undefined {
  for (const key of keys) {
    const value = env(key);
    if (value) {
      const name = process.env[`SINTER_${key}`] !== undefined ? `SINTER_${key}` : `LIMINAL_${key}`;
      return { name, value };
    }
  }
  return undefined;
}

function resolveRole(
  role: ModelRole,
  fileConfig: RoleConfigFile | null,
  inherit?: ResolvedRoleConfig,
): ResolvedRoleConfig {
  const fileRole = fileConfig?.roles?.[role];

  // Environment variable fallbacks per role
  // env() adds the LIMINAL_ prefix automatically, so these are the base names
  const envMap: Record<ModelRole, { baseUrl: string[]; model: string[]; apiKey: string[] }> = {
    generator: {
      baseUrl: ['GENERATOR_BASE_URL', 'LLM_BASE_URL'],
      model: ['GENERATOR_MODEL', 'LLM_MODEL'],
      apiKey: ['GENERATOR_API_KEY', 'LLM_API_KEY'],
    },
    // SEAT ISOLATION (adversary catch on #1094): the generic LLM_* env is the
    // loop's GENERATOR lane channel; it must never steer the cached
    // harness/evaluator/studio role configs (the constructor-side gate misses
    // this loader path). Role-specific env only for non-generator seats.
    evaluator: {
      baseUrl: ['EVALUATOR_BASE_URL'],
      model: ['EVALUATOR_MODEL'],
      apiKey: ['EVALUATOR_API_KEY'],
    },
    harness: {
      baseUrl: ['HARNESS_BASE_URL'],
      model: ['HARNESS_MODEL'],
      apiKey: ['HARNESS_API_KEY'],
    },
    studio: {
      baseUrl: ['STUDIO_BASE_URL', 'HARNESS_BASE_URL'],
      model: ['STUDIO_MODEL', 'HARNESS_MODEL'],
      apiKey: ['STUDIO_API_KEY', 'HARNESS_API_KEY'],
    },
  };

  const envSources = envMap[role];
  // Env beats file per field: an env/flag value is the user's explicit runtime
  // intent and wins over any persisted file role value. Each overridden file
  // value gets exactly one stderr notice naming the role and winning source.
  const envBaseUrl = firstEnvValue(envSources.baseUrl);
  const envModel = firstEnvValue(envSources.model);
  const envProvider = firstEnvValue(role === 'generator'
    ? ['GENERATOR_PROVIDER', 'LLM_PROVIDER']
    : ['LLM_PROVIDER']);
  if (envBaseUrl && fileRole?.baseUrl) {
    emitOverrideNotice(`[config] role '${role}': env ${envBaseUrl.name} overrides file baseUrl`);
  }
  if (envModel && fileRole?.model) {
    emitOverrideNotice(`[config] role '${role}': env ${envModel.name} overrides file model`);
  }
  if (envBaseUrl && fileRole?.apiKey) {
    emitOverrideNotice(`[config] role '${role}': file apiKey not applied (endpoint from env ${envBaseUrl.name})`);
  }
  // Explicit = configured by role/generic env var or file. Only when a role has
  // no explicit endpoint do we inherit the generator's identity (then the local
  // default as a last resort).
  const explicitBaseUrl = envBaseUrl?.value || fileRole?.baseUrl;
  const explicitModel = envModel?.value || fileRole?.model;
  // Official seats (#379 + #411): when the generator is seat-fronted
  // (Codex proxy or Kilo) and a role has no explicit endpoint, resolve
  // independent seats instead of inheriting the generator endpoint:
  //   harness   → cliproxy (kimi-k3) via CODEX_PROXY_*
  //   evaluator → cliproxy (gemini-3.1-pro-low)
  //   studio    → cliproxy (gemini-3.6-flash-high)
  // MiniMax-M3 is a repair lane only — never the evaluator doctrine seat.
  const inheritSeatFronted = isSeatFrontedUrl(inherit?.baseUrl);
  const cliproxyHarnessSeat = role === 'harness' && !explicitBaseUrl && inheritSeatFronted;
  const cliproxyEvaluatorSeat = role === 'evaluator' && !explicitBaseUrl && inheritSeatFronted;
  const cliproxyStudioSeat = role === 'studio' && !explicitBaseUrl && inheritSeatFronted;
  const doctrineCliproxySeat = cliproxyHarnessSeat || cliproxyEvaluatorSeat || cliproxyStudioSeat;
  const doctrineSeat = doctrineCliproxySeat;
  const baseUrl = explicitBaseUrl
    || (doctrineCliproxySeat ? getCodexProxyBaseUrl() : undefined)
    || inherit?.baseUrl || DEFAULT_BASE_URL;
  // Seat model defaults (explicit env/file always wins):
  //   harness doctrine / explicit cliproxy harness → kimi-k3
  //   evaluator doctrine / explicit cliproxy evaluator → gemini-3.1-pro-low
  //   generator / studio on cliproxy → gemini-3.6-flash-high
  //   cliproxy / explicit ollama.com harness endpoint → kimi-k3
  //   Kilo gateway → opus-5 only (+ free evaluator model)
  const seatModel = cliproxyHarnessSeat
    ? CODEX_PROXY_HARNESS_SEAT.model
    : cliproxyEvaluatorSeat
      ? CODEX_PROXY_EVALUATOR_SEAT.model
      : cliproxyStudioSeat
        ? CODEX_PROXY_GENERATOR_SEAT.model
        : isCodexProxyUrl(baseUrl) && role === 'harness'
          ? CODEX_PROXY_HARNESS_SEAT.model
          : isCodexProxyUrl(baseUrl) && role === 'evaluator'
            ? CODEX_PROXY_EVALUATOR_SEAT.model
            : isCodexProxyUrl(baseUrl)
              ? CODEX_PROXY_GENERATOR_SEAT.model
              : isOllamaCloudUrl(baseUrl)
                ? CODEX_PROXY_HARNESS_SEAT.model
                : isKiloGatewayUrl(baseUrl)
                  ? KILO_SEAT_MODELS[role]
                  : undefined;
  const model = explicitModel || seatModel || inherit?.model || DEFAULT_MODEL;
  // Provider must follow the winning endpoint layer. A file-stored provider
  // (e.g. paid GLM) must never stick under an env/flag endpoint (e.g. --provider
  // lmstudio → LIMINAL_LLM_BASE_URL / LIMINAL_LLM_PROVIDER); that is the silent
  // cross-provider claim ADV-MISO-004 forbids. Prefer explicit LLM_PROVIDER,
  // then re-detect from the env endpoint; only then fall back to the file provider.
  //
  // Notice contract (W1.5 + ADV-MISO-004): one stderr notice per overridden
  // file role *field* the user env/flag actually set. When only the endpoint
  // changes, baseUrl (+ apiKey suppress) already announce the layer flip —
  // re-detecting provider from that endpoint must not emit a second notice.
  // Explicit LLM_PROVIDER is its own field override and does get a notice.
  const resolvedEnvProvider = resolveProviderAlias(envProvider?.value) as ProviderType | undefined;
  if (resolvedEnvProvider && fileRole?.provider && resolvedEnvProvider !== fileRole.provider) {
    emitOverrideNotice(
      `[config] role '${role}': env ${envProvider!.name} overrides file provider ('${fileRole.provider}' → '${resolvedEnvProvider}')`,
    );
  }
  const provider: ProviderType = resolvedEnvProvider
    || (envBaseUrl ? detectProviderType(baseUrl, model) : undefined)
    || fileRole?.provider
    || (explicitBaseUrl || doctrineSeat ? detectProviderType(baseUrl, model) : inherit?.provider)
    || detectProviderType(baseUrl, model);
  // Endpoint and credential stay in the same layer: when the endpoint (or an
  // explicit provider flag) comes from env/flags the file apiKey is skipped
  // (never send one provider's key to another provider's endpoint);
  // endpoint-aware env selection picks the matching key instead.
  // File endpoint → file key, inherited → inherited key. Doctrine seats
  // (cliproxy harness / evaluator / studio) count as their own layer — the
  // inherited key must never be sent to a different endpoint.
  // The cliproxy generator requires CODEX_PROXY_API_KEY. Inventing a dummy
  // bearer turns a local configuration error into a provider attempt and 401.
  const failClosedProxySeat = cliproxyHarnessSeat || cliproxyEvaluatorSeat;
  const endpointFromEnv = Boolean(envBaseUrl || resolvedEnvProvider);
  const explicitRoleKey = firstEnvValue(envSources.apiKey.filter(key => key !== 'LLM_API_KEY'));
  const apiKey = (endpointFromEnv ? undefined : fileRole?.apiKey)
    || explicitRoleKey?.value
    || selectApiKeyForEndpoint(baseUrl, model, envSources.apiKey)
    || (isCodexProxyUrl(baseUrl)
      ? (failClosedProxySeat ? getCodexProxyApiKeyFromEnv() : getCodexProxyApiKey())
      : undefined)
    || (explicitBaseUrl || doctrineSeat ? undefined : inherit?.apiKey);

  if (role === 'generator' && isCodexProxyUrl(baseUrl) && !apiKey) {
    throw new FatalRoleConfigError(
      'CODEX_PROXY_API_KEY_REQUIRED',
      'set CODEX_PROXY_API_KEY before using the cliproxy generator endpoint',
    );
  }

  if (CapabilityRegistry.isDecisionModel(model) && !DECISION_SOLO_SEATS.has(role)) {
    throw new FatalRoleConfigError('DECISION_MODEL_AT_WRITING_SEAT',
      `role '${role}' model ${model} is a decision model and cannot write; give the seat a generative model and set ${model} as its decisionHead`);
  }
  const timeout = envTimeout(role) ?? fileRole?.timeout ?? defaultRoleTimeout(role);
  const decisionHead = resolveDecisionHead(role, fileRole, timeout);

  return {
    provider,
    baseUrl,
    apiKey,
    model,
    ...(decisionHead ? { decisionHead } : {}),
    temperature: fileRole?.temperature ?? DEFAULT_TEMPERATURES[role],
    maxTokens: fileRole?.maxTokens ?? DEFAULT_MAX_TOKENS,
    timeout,
    thinking: resolveThinkingConfig(fileRole?.thinking),
    streaming: fileRole?.streaming ?? (role === 'harness' || role === 'studio'),
    glmCodingPlanSeat: fileRole?.glmCodingPlanSeat === true,
  };
}

/**
 * Auto-detect provider type from baseUrl and model name.
 */
export function detectProviderType(baseUrl: string, model?: string): ProviderType {
  return detectRoleProviderType(baseUrl, model) as ProviderType;
}

// ── File Loading ──

async function loadConfigFile(): Promise<RoleConfigFile | null> {
  const configPath = resolveUserConfigPath();
  try {
    const content = await readFile(configPath, 'utf-8');
    return JSON.parse(content) as RoleConfigFile;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      // No user config file — that's fine, env vars work
      return null;
    }
    // A malformed or unreadable user config must not silently reroute every
    // role through key-sniffing defaults (different seat, model, and bill).
    const message = error instanceof Error ? error.message : String(error);
    throw new FatalRoleConfigError('USER_CONFIG_INVALID', `${configPath}: ${message}`);
  }
}

async function loadProjectConfig(projectDir?: string): Promise<RoleConfigFile | null> {
  if (!projectDir) {
    projectDir = process.cwd();
  }

  // Canonical sinter.json, with back-compat fallbacks to legacy filenames.
  const candidates = ['sinter.json', 'liminal.json', 'atelier.json'];
  let lastErr: unknown = null;
  for (const filename of candidates) {
    const configPath = join(projectDir, 'config', filename);
    try {
      const content = await readFile(configPath, 'utf-8');
      const parsed = JSON.parse(content);
      // Project config uses different shape — extract role info from it
      return projectToRoleConfig(parsed);
    } catch (err) {
      lastErr = err;
    }
  }
  Logger.debug('RoleConfig', `Failed to load role config from config/{${candidates.join(',')}}:`, lastErr);
  return null;
}

interface ProjectConfigLike {
  llm?: {
    baseUrl?: string;
    model?: string;
    apiKey?: string;
    temperature?: number;
    maxTokens?: number;
  };
  multiModel?: {
    primary?: {
      baseUrl?: string;
      model?: string;
      temperature?: number;
      maxTokens?: number;
    };
    secondary?: {
      baseUrl?: string;
      model?: string;
      temperature?: number;
      maxTokens?: number;
    };
  };
}

/**
 * Map existing ProjectConfig shape to RoleConfigFile.
 * The existing project config has `llm` and `multiModel` fields
 * that map to generator and harness roles.
 */
function projectToRoleConfig(project: ProjectConfigLike): RoleConfigFile | null {
  if (!project.llm && !project.multiModel) return null;

  const roles: RoleConfigFile['roles'] = {
    generator: {
      baseUrl: project.llm?.baseUrl || project.multiModel?.primary?.baseUrl || '',
      model: project.llm?.model || project.multiModel?.primary?.model || '',
      apiKey: project.llm?.apiKey,
      temperature: project.llm?.temperature || project.multiModel?.primary?.temperature,
      maxTokens: project.llm?.maxTokens || project.multiModel?.primary?.maxTokens,
    },
  };

  if (project.multiModel?.secondary) {
    roles.harness = {
      baseUrl: project.multiModel.secondary.baseUrl || '',
      model: project.multiModel.secondary.model || '',
      temperature: project.multiModel.secondary.temperature,
      maxTokens: project.multiModel.secondary.maxTokens,
    };
  }

  return { roles };
}

/**
 * Merge two RoleConfigFile objects. `overlay` takes priority.
 */
function mergeConfigs(base: RoleConfigFile | null, overlay: RoleConfigFile | null): RoleConfigFile | null {
  if (!base) return overlay;
  if (!overlay) return base;

  return {
    roles: {
      generator: { ...base.roles.generator, ...overlay.roles.generator },
      evaluator: overlay.roles.evaluator || base.roles.evaluator,
      harness: overlay.roles.harness || base.roles.harness,
      studio: overlay.roles.studio || base.roles.studio,
    },
    fallbacks: { ...base.fallbacks, ...overlay.fallbacks },
    capabilities: { ...base.capabilities, ...overlay.capabilities },
    evolution: { ...base.evolution, ...overlay.evolution },
  };
}

/**
 * Merge a role config through the canonical private atomic config writer.
 */
export async function saveRoleConfig(config: RoleConfigFile, configPath?: string): Promise<void> {
  const target = configPath || resolveUserConfigPath();
  const result = await updateConfig(config as unknown as Record<string, unknown>, target);
  if (result.isErr()) throw result.error;
}

/**
 * Get fallback configs for a role.
 */
export function getFallbacks(
  role: ModelRole,
  config: RoleConfigFile | null,
): RoleProviderConfig[] {
  const fallbacks = config?.fallbacks?.[role] || [];
  if (role !== 'harness') return fallbacks;
  for (const [fallbackOrdinal, fallback] of fallbacks.entries()) {
    const decision = evaluateRoleConfig({
      role, sourceLayer: 'fallbacks-harness', phase: 'pre-fallback-transport',
      requestedModelAlias: fallback.model, requestedEffort: fallback.thinking?.effort ?? 'high',
      providerHint: fallback.provider === 'custom' || fallback.provider === undefined ? 'unknown' : fallback.provider,
      fallbackOrdinal, policyInvokedAt: ['pre-fallback-transport'], substitutionAllowed: false,
    });
    if (!decision.allowed && !decision.decision.ok
      && decision.decision.reason === 'role-luna-harness-forbidden') {
      const rejected = decision.decision;
      const reason = rejected.ok ? 'unknown' : `${rejected.reason}: ${rejected.detail}`;
      throw new Error(`HARNESS_FALLBACK_CONFIG_REJECTED: ${reason}`);
    }
  }
  return fallbacks;
}

/**
 * Get evolution tunables with sensible defaults.
 */
export function getEvolutionTunables(config: RoleConfigFile | null): EvolutionTunables {
  return {
    enabled: config?.evolution?.enabled ?? false,
    temperatureRange: config?.evolution?.temperatureRange ?? { min: 0.0, max: 1.0 },
    maxTokensRange: config?.evolution?.maxTokensRange ?? { min: 512, max: 8192 },
    mutationRate: config?.evolution?.mutationRate ?? 0.1,
  };
}

/**
 * Get a single role's resolved config from an already-loaded roles record.
 * Returns undefined if the role was not configured.
 */
export function getRoleConfig(
  role: ModelRole,
  roles: Partial<Record<ModelRole, ResolvedRoleConfig>>,
): ResolvedRoleConfig | undefined {
  return roles[role];
}

/**
 * Format role config for display.
 */
export function formatRoleConfig(roles: Record<ModelRole, ResolvedRoleConfig>): string {
  const lines: string[] = ['Role Configuration:', '=================='];

  for (const [role, cfg] of Object.entries(roles)) {
    lines.push('');
    lines.push(`  ${role.toUpperCase()}:`);
    lines.push(`    Provider: ${cfg.provider || 'auto'}`);
    lines.push(`    Model:    ${cfg.model}`);
    lines.push(`    Base URL: ${cfg.baseUrl}`);
    lines.push(`    Temp:     ${cfg.temperature}`);
    lines.push(`    Tokens:   ${cfg.maxTokens}`);
    lines.push(`    Thinking: ${cfg.thinking.enabled ? 'on' : 'off'}`);
    lines.push(`    Stream:   ${cfg.streaming ? 'on' : 'off'}`);
    if (cfg.decisionHead) lines.push(`    Decision: ${cfg.decisionHead.model} @ ${cfg.decisionHead.baseUrl}`);
  }

  return lines.join('\n');
}
