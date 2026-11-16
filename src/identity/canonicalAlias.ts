/**
 * Canonical provider/model alias resolver for W8C-03 (#716).
 *
 * Identity normalization is the foundation of the "Luna never harness" law.
 * Substring matching is forbidden — model identity must be resolved through
 * this table so that an ambiguous alias fails closed and an attacker cannot
 * slip a Luna harness past a substring check.
 *
 * Spec: `.omx/plans/prd-wave8-closure-wave9-admission.md` (W8C-03).
 */

import type { ExecutorIdentity, ModelEffort, ProviderFamily } from './types.js';

/**
 * Canonical Luna model id. All provider-qualified aliases normalize to this.
 * The canonical form is what the eligibility policy compares against.
 */
export const LUNA_MODEL_ID = 'gpt-5.6-luna';
export const CURRENT_LUNA_MODEL_ID = 'gpt-6-luna';

/**
 * Provider-qualified aliases that normalize to {@link LUNA_MODEL_ID}. These
 * mirror the existing capability table in `src/llm/CapabilityRegistry.ts` and
 * `src/config/KiloGateway.ts` (cliproxy fallback seat → `gpt-5.6-luna`).
 *
 * The alias set is closed: any new alias must be added here explicitly. An
 * unknown alias does *not* silently resolve to Luna.
 */
export const LUNA_ALIASES: readonly string[] = [
  LUNA_MODEL_ID,
  'openai/gpt-5.6-luna',
  'anthropic/gpt-5.6-luna',
  'google/gpt-5.6-luna',
  'moonshotai/gpt-5.6-luna',
  'openai/gpt-5.6-luna-high',
  'gpt-5.6-luna-high',
];

const LUNA_ALIAS_SET: ReadonlySet<string> = new Set(
  LUNA_ALIASES.map((alias) => normalizeAliasToken(alias)),
);
const CURRENT_LUNA_ALIAS_SET: ReadonlySet<string> = new Set([
  CURRENT_LUNA_MODEL_ID,
  `openai/${CURRENT_LUNA_MODEL_ID}`,
]);

/**
 * Result of alias resolution. `kind` distinguishes a known canonical identity
 * from an unknown one — the policy treats unknown identities as fail-closed.
 */
export interface AliasResolution {
  readonly ok: boolean;
  readonly canonicalProvider: ProviderFamily;
  readonly canonicalModel: string;
  readonly isLuna: boolean;
  readonly ambiguity: readonly string[];
}

function normalizeAliasToken(alias: string): string {
  return alias.trim().toLowerCase();
}

function detectProviderFamily(alias: string): {
  provider: ProviderFamily;
  bareModel: string;
} {
  let token = normalizeAliasToken(alias);
  // llama.cpp names a served model by its file path; the file stem is the model.
  if (token.endsWith('.gguf')) token = token.slice(token.lastIndexOf('/') + 1, -'.gguf'.length);
  // This authorized gateway ID contains a vendor namespace, not a provider.
  // Resolve it before generic provider/model splitting; retain the full ID.
  if (token === 'deepseek-ai/deepseek-v4-flash-0731') {
    return { provider: 'openai', bareModel: token };
  }
  if (token === 'dots-studio/dots-3-note-preview:free') {
    return { provider: 'openai', bareModel: token };
  }
  const slashIndex = token.indexOf('/');
  if (slashIndex >= 0) {
    const providerToken = token.slice(0, slashIndex);
    const bareModel = token.slice(slashIndex + 1);
    return { provider: mapProviderToken(providerToken), bareModel };
  }
  // Bare ids: match known prefixes. Keep this list narrow — we never guess.
  if (token.startsWith('claude')) return { provider: 'anthropic', bareModel: token };
  if (token.startsWith('gpt') || token.startsWith('o3') || token.startsWith('o4')) {
    return { provider: 'openai', bareModel: token };
  }
  // Grok uses the product's OpenAI-compatible transport and provider hint.
  if (/^grok(?:-|$)/.test(token)) return { provider: 'openai', bareModel: token };
  if (token.startsWith('gemini') || token.startsWith('gemma')) {
    return { provider: 'google', bareModel: token };
  }
  if (token.startsWith('glm') || token.startsWith('codegeex')) {
    return { provider: 'glm', bareModel: token };
  }
  if (token.startsWith('minimax')) return { provider: 'minimax', bareModel: token };
  if (token.startsWith('kimi')) return { provider: 'kimi', bareModel: token };
  // Qwen (L8 rotation generator seat) rides the LAN LiteLLM OpenAI-compatible
  // transport; map the bare prefix so the identity canonicalizes fail-open here
  // while eligibility still guards everything else.
  if (token.startsWith('qwen')) return { provider: 'openai', bareModel: token };
  if (token.startsWith('moonshot')) return { provider: 'moonshot', bareModel: token };
  // Kilo fleet free seat (probed 2026-08-29, 23s/1.3KB real code): the bare
  // name on the kilo gateway, which echoes tencent/hy3 back.
  if (token.startsWith('hy3')) return { provider: 'openai', bareModel: token };
  // Xiaomi MiMo: direct Token Plan seat since 2026-08-30 (CEO ruling — xiaomi
  // rides its own tp- plan on token-plan-sgp, NEVER kilo tokens).
  if (token.startsWith('mimo') || token.startsWith('xiaomi/mimo')) return { provider: 'openai', bareModel: token };
  // DeepSeek models are served through the local Ollama transport in the
  // tour rotation (deepseek-v4-flash:cloud). Map the bare prefix to the
  // 'ollama' family so the alias canonicalizes instead of failing closed,
  // matching the deepseek-r1 → ollama routing already used in ProviderRuntime.
  if (token.startsWith('deepseek')) return { provider: 'ollama', bareModel: token };
  // Liquid LFM3 runs on a local OpenAI-compatible llama.cpp server.
  if (token.startsWith('lfm3')) return { provider: 'lmstudio', bareModel: token };
  return { provider: 'unknown', bareModel: token };
}

function mapProviderToken(token: string): ProviderFamily {
  switch (token) {
    case 'openai':
    case 'grok-cli':
      return 'openai';
    case 'anthropic':
      return 'anthropic';
    case 'google':
      return 'google';
    case 'glm':
    case 'zhipu':
      return 'glm';
    case 'minimax':
      return 'minimax';
    case 'moonshot':
    case 'moonshotai':
      return 'moonshot';
    case 'kimi':
      return 'kimi';
    // Vendor-prefixed gateway ids (kilo serves 'qwen/qwen3.8-27b') must
    // canonicalize to the SAME identity as the bare LAN-gateway id so the L8
    // generator seat holds one identity across transports.
    case 'qwen':
      return 'openai';
    case 'kilo':
      return 'kilo';
    // Kilo-gateway vendor segments (aggregator ids like stepfun/step-3.7-flash:free):
    // they all ride the same OpenAI-compatible transport, so the vendor token
    // canonicalizes to the openai family rather than failing closed as unknown.
    case 'stepfun':
    case 'tencent':
    case 'meituan':
    case 'poolside':
    case 'liquid':
    case 'nvidia':
    case 'thinkingmachines':
    case 'deepseek':
    case 'deepinfra':
      return 'openai';
    case 'ollama':
    case 'ollama-cloud':
      return 'ollama';
    case 'lmstudio':
      return 'lmstudio';
    case 'openrouter':
      return 'openrouter';
    default:
      return 'unknown';
  }
}

/**
 * Resolve a model alias to its canonical identity. Returns `ok: false` when
 * the alias is unknown — callers must treat unknowns as fail-closed.
 *
 * Resolution is *not* substring-based. Only exact matches against the closed
 * alias table or a recognized bare prefix produce a canonical identity.
 */
export function resolveExecutorAlias(
  modelAlias: string,
  options?: { providerHint?: string; effort?: ModelEffort },
): AliasResolution {
  const token = normalizeAliasToken(modelAlias);
  if (!token) {
    return { ok: false, canonicalProvider: 'unknown', canonicalModel: '', isLuna: false, ambiguity: [] };
  }
  // A hint that names no family ('custom', 'cli', 'unknown') adds no
  // information: the model id decides, and an unknown id still fails closed.
  // Letting it win turned every custom seat's known model into 'unknown' (#1748).
  const mappedHint = options?.providerHint === undefined
    ? undefined
    : mapProviderToken(normalizeAliasToken(options.providerHint));
  const providerHint = mappedHint === 'unknown' ? undefined : mappedHint;
  if (LUNA_ALIAS_SET.has(token)) {
    const { provider } = detectProviderFamily(modelAlias);
    return {
      ok: true,
      canonicalProvider: providerHint ?? provider,
      canonicalModel: LUNA_MODEL_ID,
      isLuna: true,
      ambiguity: [],
    };
  }
  if (CURRENT_LUNA_ALIAS_SET.has(token)) {
    const { provider } = detectProviderFamily(modelAlias);
    return { ok: true, canonicalProvider: providerHint ?? provider,
      canonicalModel: CURRENT_LUNA_MODEL_ID, isLuna: true, ambiguity: [] };
  }
  const { provider, bareModel } = detectProviderFamily(modelAlias);
  // A local server (LM Studio, Ollama) names its models freely, so the local
  // provider the user chose vouches for the name. Hosted providers never do.
  if (provider === 'unknown' && (providerHint === 'lmstudio' || providerHint === 'ollama')) {
    return { ok: true, canonicalProvider: providerHint, canonicalModel: bareModel, isLuna: false, ambiguity: [] };
  }
  if (provider === 'unknown') {
    return {
      ok: false,
      canonicalProvider: 'unknown',
      canonicalModel: bareModel,
      isLuna: false,
      ambiguity: [],
    };
  }
  return {
    ok: true,
    canonicalProvider: providerHint ?? provider,
    canonicalModel: bareModel,
    isLuna: false,
    ambiguity: [],
  };
}

/**
 * Build an {@link ExecutorIdentity} from a resolved alias and effort. Returns
 * `null` when the alias is unknown so callers can fail closed explicitly.
 */
export function buildExecutorIdentity(
  modelAlias: string,
  effort: ModelEffort,
  options?: { providerHint?: string },
): ExecutorIdentity | null {
  const resolution = resolveExecutorAlias(modelAlias, { ...options, effort });
  if (!resolution.ok) return null;
  return {
    provider: resolution.canonicalProvider,
    model: resolution.canonicalModel,
    effort,
    alias: modelAlias,
  };
}

/**
 * Predicate form of the Luna check. Used by the eligibility policy.
 */
export function isLunaIdentity(identity: { provider: ProviderFamily; model: string }): boolean {
  if (identity.model === LUNA_MODEL_ID || identity.model === CURRENT_LUNA_MODEL_ID) return true;
  const resolution = resolveExecutorAlias(identity.model, { providerHint: identity.provider });
  return resolution.ok && resolution.isLuna;
}

/**
 * Accept only closed, directional model aliases that an official transport
 * truthfully returns for a more specific requested route. The provider and
 * effort remain independently bound by the signed completion.
 *
 * The cliproxy serves Google models via an OpenAI-compatible transport. The
 * canonical alias resolver maps gemini-* models to provider 'google' based on
 * the model prefix, regardless of the transport-level provider hint. Both
 * 'openai' (transport hint) and 'google' (model family) are accepted here
 * so the alias holds whichever layer won the identity resolution.
 */
export function isKnownResponseModelAlias(
  resolved: Pick<ExecutorIdentity, 'provider' | 'model'>,
  response: Pick<ExecutorIdentity, 'provider' | 'model'>,
): boolean {
  if (resolved.provider !== response.provider) return false;
  if (resolved.model === response.model) return true;
  // The LAN LiteLLM gateway (L8 generator seat) serves the owner-authorized
  // qwen3.6-27b-mtp route with Qwen3.8-27B weights and echoes the deployment
  // name in the response — same closed, directional alias class as cliproxy's
  // gemini route. Case-normalized: the gateway echoes 'Qwen3.8-27B'.
  const norm = (value: string) => value.toLowerCase();
  if (resolved.provider === 'openai'
    && (norm(resolved.model) === norm(response.model)
      || (norm(resolved.model) === 'qwen3.6-27b-mtp' && norm(response.model) === 'qwen3.8-27b'))) {
    return true;
  }
  // Kilo-style aggregator gateways echo the fully-qualified id when asked for
  // the bare model: deepseek-v4-flash -> deepseek/deepseek-v4-flash,
  // hy3 -> tencent/hy3. One extra leading vendor segment, same tail —
  // same closed directional-alias class as the qwen route.
  if ((resolved.provider === 'openai' || resolved.provider === 'google')
    && response.model.endsWith(`/${resolved.model}`)
    && !resolved.model.includes('/')) {
    return true;
  }
  // The router serves gemini flash seats with the '-high' effort suffix
  // stripped in the response model field — family-wide, not per-version.
  if (resolved.provider === 'openai' || resolved.provider === 'google') {
    const match = /^(gemini-.+-flash)-high$/.exec(resolved.model);
    if (match && response.model === match[1]) return true;
  }
  return (resolved.provider === 'openai' || resolved.provider === 'google')
    && resolved.model === 'gemini-3.6-flash-high'
    && response.model === 'gemini-3.6-flash';
}
