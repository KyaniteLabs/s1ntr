/**
 * Official seat map from #379 audition (owner decision 2026-07-26) plus
 * harness repoint #411. Primary seats front local cliproxyapi — not Kilo:
 *
 *   harness   → kimi-k3                 via cliproxy (CODEX_PROXY_*; doctrine
 *                                        seat requires CODEX_PROXY_API_KEY —
 *                                        fail closed, no dummy default)
 *   generator → gemini-3.6-flash-high   via same cliproxy (AGY OAuth)
 *   studio    → gemini-3.6-flash-high   via same cliproxy (chat / studio)
 *   evaluator → gemini-3.1-pro-low      via same cliproxy (replaces MiniMax-M3
 *                                        as the evaluator seat; M3 lost the
 *                                        judge exam: 0.73 acc / 0.068 cons.)
 *
 * Fallbacks (seat-fronted only, no file fallbacks):
 *   generator / hard-piece director → gpt-5.6-luna via cliproxy
 *   evaluator                       → gpt-5.6-luna via cliproxy
 *   harness                         → none (Kilo not a kimi-k3 fallback)
 *
 * Repair lane (NOT a seat): MiniMax-M3 direct Token Plan
 *   (api.minimax.io/anthropic, MINIMAX_API_KEY). Deterministic-gate repair
 *   path only — never the evaluator seat.
 *
 * Kilo gateway (https://api.kilo.ai/api/gateway, KILO_API_KEY) is reserved for
 * anthropic/claude-opus-5 (+ -fast) and free models not in Pushing Dispatch.
 * kimi-k3 / gemini-3.x / gpt-5.6-luna are NOT Kilo seats.
 *
 * Key isolation (#410): CODEX_PROXY_API_KEY only for localhost:8317 (or the
 * configured CODEX_PROXY_BASE_URL); MINIMAX_API_KEY only for api.minimax.io.
 *
 * Everything here is a DEFAULT: explicit env/file config always wins.
 * RoleConfig.resolveRole applies doctrine seats when the generator is on a
 * seat-fronted endpoint (Codex proxy or Kilo) and the role has no explicit
 * endpoint; LLMClient applies fallback chains only for seat-fronted setups
 * with no file-defined fallbacks for that role.
 */

import type { ModelRole, RoleProviderConfig } from './RoleConfig.js';

export const KILO_GATEWAY_BASE_URL = 'https://api.kilo.ai/api/gateway';
/** @deprecated Not a doctrine seat; kept for explicit ollama.com detection. */
export const OLLAMA_CLOUD_BASE_URL = 'https://ollama.com/v1';
export const DEFAULT_CODEX_PROXY_BASE_URL = 'http://localhost:8317/v1';

export function isKiloGatewayUrl(baseUrl: string | undefined): boolean {
  return typeof baseUrl === 'string' && baseUrl.toLowerCase().includes('kilo.ai');
}

export function isOllamaCloudUrl(baseUrl: string | undefined): boolean {
  return typeof baseUrl === 'string' && baseUrl.toLowerCase().includes('ollama.com');
}

/**
 * Codex proxy base URL. Configurable via CODEX_PROXY_BASE_URL (also honors
 * SINTER_/LIMINAL_ prefixed forms). Default: local CLIProxyAPI-style endpoint.
 */
export function getCodexProxyBaseUrl(): string {
  return (
    process.env.CODEX_PROXY_BASE_URL?.trim()
    || process.env.SINTER_CODEX_PROXY_BASE_URL?.trim()
    || process.env.LIMINAL_CODEX_PROXY_BASE_URL?.trim()
    || DEFAULT_CODEX_PROXY_BASE_URL
  );
}

/**
 * API key for the Codex OpenAI-compatible endpoint. The local proxy validates
 * this bearer independently from upstream OAuth, so an invented default would
 * spend a provider attempt on a deterministic 401.
 */
export function getCodexProxyApiKey(): string | undefined {
  return getCodexProxyApiKeyFromEnv();
}

/**
 * Env-only Codex proxy key (no dummy default). Used by harness / evaluator
 * doctrine seats so missing CODEX_PROXY_API_KEY fails closed instead of
 * inventing a key or leaking KILO_API_KEY / MINIMAX_API_KEY.
 */
export function getCodexProxyApiKeyFromEnv(): string | undefined {
  return (
    process.env.CODEX_PROXY_API_KEY?.trim()
    || process.env.SINTER_CODEX_PROXY_API_KEY?.trim()
    || process.env.LIMINAL_CODEX_PROXY_API_KEY?.trim()
    || undefined
  );
}

export function isCodexProxyUrl(baseUrl: string | undefined): boolean {
  if (typeof baseUrl !== 'string' || !baseUrl.trim()) return false;
  const normalize = (value: string): string | null => {
    try {
      const parsed = new URL(value);
      if (parsed.username || parsed.password || parsed.search || parsed.hash) return null;
      const path = parsed.pathname.replace(/\/+$/, '') || '/';
      return `${parsed.protocol}//${parsed.host}${path}`.toLowerCase();
    } catch {
      return null;
    }
  };
  const candidate = normalize(baseUrl);
  if (!candidate) return false;
  const configured = normalize(getCodexProxyBaseUrl());
  if (configured && candidate === configured) return true;
  return candidate === 'http://localhost:8317/v1'
    || candidate === 'http://127.0.0.1:8317/v1';
}

/**
 * True when the generator (or other inherit identity) is on a seat-fronted
 * endpoint that should light up independent harness/evaluator/studio doctrine seats.
 */
export function isSeatFrontedUrl(baseUrl: string | undefined): boolean {
  return isKiloGatewayUrl(baseUrl) || isCodexProxyUrl(baseUrl);
}

/**
 * Default model per role when the role's endpoint IS the Kilo gateway.
 * Reserved for anthropic/claude-opus-5 (+ -fast). Free models not in Pushing
 * Dispatch may be selected explicitly. No kimi-k3 / gpt-5.6-luna / gemini-3.x.
 * evaluator entry is the free Kilo-side model used only when someone
 * EXPLICITLY points the evaluator at the gateway without a model.
 */
export const KILO_SEAT_MODELS: Partial<Record<ModelRole, string>> = {
  harness: 'anthropic/claude-opus-5',
  generator: 'anthropic/claude-opus-5',
  evaluator: 'google/gemini-3.5-flash',
};

/**
 * Harness seat: Kimi K3 on local cliproxyapi (OpenAI-compatible).
 * baseUrl/apiKey resolved at use time via getCodexProxyBaseUrl() /
 * CODEX_PROXY_API_KEY (env only — no dummy default; fail closed).
 * Kilo is not a fallback for this seat.
 */
export const CODEX_PROXY_HARNESS_SEAT = {
  model: 'kimi-k3',
} as const;

/**
 * @deprecated Prefer CODEX_PROXY_HARNESS_SEAT. Alias kept so older imports
 * that only need the model id still resolve.
 */
export const OLLAMA_CLOUD_HARNESS_SEAT = {
  baseUrl: OLLAMA_CLOUD_BASE_URL,
  model: CODEX_PROXY_HARNESS_SEAT.model,
} as const;

/**
 * Generator (and studio/chat) seat model on the Codex / cliproxy proxy.
 * baseUrl/apiKey resolved at use time via getCodexProxyBaseUrl() /
 * getCodexProxyApiKey(). AGY OAuth for Gemini; Codex OAuth for Luna fallback.
 */
export const CODEX_PROXY_GENERATOR_SEAT = {
  model: 'gemini-3.6-flash-high',
} as const;

/**
 * Evaluator seat model on the Codex / cliproxy proxy (#379: gemini-3.1-pro-low
 * beat MiniMax-M3 on the judge exam). Fail-closed without CODEX_PROXY_API_KEY.
 */
export const CODEX_PROXY_EVALUATOR_SEAT = {
  model: 'gemini-3.1-pro-low',
} as const;

/**
 * Shared cliproxy fallback / hard-piece director model (generator + evaluator).
 */
export const CODEX_PROXY_FALLBACK_SEAT = {
  model: 'gpt-5.6-luna',
} as const;

/**
 * Repair lane — MiniMax M3 on the direct Token Plan endpoint
 * (Anthropic-compatible), key from MINIMAX_API_KEY. NOT a seat: used only by
 * deterministic-gate repair paths that still route MiniMax direct.
 */
export const MINIMAX_REPAIR_LANE = {
  baseUrl: 'https://api.minimax.io/anthropic',
  model: 'MiniMax-M3',
} as const;

/**
 * @deprecated MiniMax is a repair lane, not the evaluator seat (#379).
 * Prefer MINIMAX_REPAIR_LANE. Kept so older imports still resolve.
 */
export const MINIMAX_EVALUATOR_SEAT = MINIMAX_REPAIR_LANE;

/**
 * Default fallback chain per role for seat-fronted setups. apiKey is
 * intentionally absent — resolved endpoint-aware at instantiation
 * (CODEX_PROXY_API_KEY for cliproxy) and never stored here.
 *
 * harness is intentionally absent: Kilo is not a fallback for kimi-k3
 * (credits scarce). baseUrl uses the default cliproxy host; live resolution
 * still keys the credential via selectApiKeyForEndpoint.
 */
export const KILO_SEAT_FALLBACKS: Partial<Record<ModelRole, RoleProviderConfig[]>> = {
  generator: [
    { baseUrl: DEFAULT_CODEX_PROXY_BASE_URL, model: CODEX_PROXY_FALLBACK_SEAT.model },
  ],
  evaluator: [
    { baseUrl: DEFAULT_CODEX_PROXY_BASE_URL, model: CODEX_PROXY_FALLBACK_SEAT.model },
  ],
};
