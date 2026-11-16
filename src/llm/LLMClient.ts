// ── Config & Response ──

import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join as pathJoin } from 'node:path';
import { AsyncLocalStorage } from 'node:async_hooks';
import {
  debitCurrentCampaignFunding,
  claimCurrentCampaignTransportProof,
  hasCurrentCampaignFundingContext,
  settleCurrentCampaignFunding,
} from '../creative-run/CampaignExecutionAuthority.js';
import { verifyCreativeAdmission, type CreativeAdmissionProof } from
  '../runtime-core/CreativeAdmissionAuthority.js';

import { LLMError, LLMTimeoutError, LLMAuthError, LLMRateLimitError, isTransientNetworkError } from './errors.js';
import { providerRequestDigest } from './ProviderRequestDigest.js';
import { LLMGenerationError } from '../errors/LLMGenerationError.js';
export { LLMError, LLMTimeoutError, LLMRateLimitError, LLMAuthError } from './errors.js';

import { CircuitBreaker } from './CircuitBreaker.js';

import { SERVICE_DEFAULTS } from '../constants/index.js';
import { PromptLibrary } from '../prompts/index.js';
import { resolvePromptTier, tiered } from '../prompts/PromptTier.js';
import { CapabilityRegistry } from './CapabilityRegistry.js';
import { RetryManager } from './RetryManager.js';
import { TIMEOUT_DEFAULT_MS, TIMEOUT_EVALUATOR_MS, TIMEOUT_OLLAMA_MS, TRUNCATE_SHORT, TRUNCATE_LONG, TOKEN_LIMIT_XL } from '../constants/limits.js';
import { CacheManager } from './CacheManager.js';
import { eventBus, EventTypes } from '../core/EventBus.js';
import { isCodeComplete as isCodeCompleteShared } from '../core/isCodeComplete.js';
import { pickCodeBlock, proseOutsideFences, splitThinking } from './ModelOutput.js';
import { validateUrl, getAllowedHostsFromEnv, SSRFError } from '../security/UrlValidator.js';
import { failureLogger } from '../harness/FailureLogger.js';
import { detectProviderFromUrl } from '../harness/MultiProviderConfig.js';
import { env } from '../utils/env.js';
import { Logger } from '../utils/Logger.js';
import { Provider } from '../types/providers.js';
import { recordEvent } from '../telemetry/EventLedger.js';
import {
  buildGenerationAttemptEventV1,
  type GenerationAttemptCounterDelta,
  type GenerationAttemptEventV1,
  type GenerationAttemptFailureReason,
  type GenerationAttemptStage,
  type GenerationAttemptTelemetryContext,
} from '../telemetry/generationAttemptEvent.js';

const LOCAL_MODEL_DETECT_TIMEOUT_MS = 2500;
const LEGACY_LM_STUDIO_MODEL_PLACEHOLDER = 'local-model';

/** Default when callers pass empty/whitespace system content (Kilo/OpenAI 400). */
const DEFAULT_SYSTEM_PROMPT = 'You are a helpful assistant.';

export type ProviderAttemptGuard = () => void;

/**
 * Decision models (e.g. Liquid AI d1-2B) never generate tokens; a chat prompt
 * sent to one is a routing bug, not a degraded call. Fail before any spend.
 * Use DecisionModelClient for them.
 */
export function assertGenerativeModel(model: string): void {
  if (CapabilityRegistry.isDecisionModel(model)) {
    throw new Error(`DECISION_MODEL_NOT_GENERATIVE: ${model} answers typed questions only; route it through DecisionModelClient`);
  }
}
const providerAttemptGuards = new AsyncLocalStorage<ProviderAttemptGuard>();
const harnessTransportAuthorities = new AsyncLocalStorage<HarnessTransportAuthority>();
export type ProductTransportPurpose = 'generation' | 'evaluation' | 'studio' | 'harness';

export function productPurposeForRole(role: ModelRole | undefined): ProductTransportPurpose | undefined {
  if (role === 'generator') return 'generation';
  if (role === 'evaluator') return 'evaluation';
  if (role === 'studio' || role === 'harness') return role;
  return undefined;
}

export interface LiminalProductTransportGrant {
  readonly scope: {
    readonly schema: 'sinter.product-transport-scope';
    readonly schemaVersion: 1;
    readonly operationId: string;
    readonly effectId: string;
    readonly reservationDigest: string;
    readonly purpose: ProductTransportPurpose;
    readonly role: ModelRole;
  };
  readonly proof: CreativeAdmissionProof;
}
const productTransportAuthority = new AsyncLocalStorage<LiminalProductTransportGrant>();

export function withProviderAttemptGuard<T>(
  guard: ProviderAttemptGuard | undefined,
  operation: () => Promise<T>,
): Promise<T> {
  return guard ? providerAttemptGuards.run(guard, operation) : operation();
}

/** Inject a host-owned authority across CLI/Studio call stacks without global mutable state. */
export function withHarnessTransportAuthority<T>(
  authority: HarnessTransportAuthority,
  operation: () => Promise<T>,
): Promise<T> {
  return harnessTransportAuthorities.run(authority, operation);
}

/** Run inside one journal-reserved, role-bound product transport grant. */
export function withLiminalProductTransportAuthority<T>(
  grant: LiminalProductTransportGrant, operation: () => Promise<T>,
): Promise<T> {
  return productTransportAuthority.run(grant, operation);
}

export function assertProviderAttemptAllowed(): void {
  providerAttemptGuards.getStore()?.();
}

/** Production transports must be attributable to one governed product role. */
export function assertRoleBoundProviderAttempt(
  role: ModelRole | undefined,
  environment = process.env.NODE_ENV,
): void {
  if (!role && environment !== 'test') {
    throw new LLMError('Roleless provider transport is forbidden', 'authority',
      undefined, false);
  }
  const grant = productTransportAuthority.getStore();
  const expectedPurpose = productPurposeForRole(role);
  if (environment !== 'test' && !hasCurrentCampaignFundingContext()
    && (!grant || !expectedPurpose || grant.scope.role !== role
      || grant.scope.purpose !== expectedPurpose
      || !verifyCreativeAdmission(grant.scope, grant.proof))) {
    throw new LLMError('Provider transport requires Liminal product command authority',
      'authority', undefined, false);
  }
}

/**
 * Coerce blank system prompts so providers never receive empty system content.
 * Wave 4: K3 via Kilo rejects with "system message must have content".
 */
export function normalizeSystemPrompt(systemPrompt: string | undefined | null): string {
  if (typeof systemPrompt === 'string' && systemPrompt.trim().length > 0) {
    return systemPrompt;
  }
  return DEFAULT_SYSTEM_PROMPT;
}

// ── Provider system imports ──
import { createProvider, transportEndpoint } from './ProviderFactory.js';
import { BaseProvider } from './providers/BaseProvider.js';
import type { ProviderImageInput, ProviderRequest, ProviderResponse, StreamEvent, ThinkingConfig, TokenUsage } from './ProviderTypes.js';
import type { ModelRole, ResolvedRoleConfig, RoleConfigFile } from '../config/RoleConfig.js';
import { loadRoleConfig, getFallbacks, isFatalRoleConfigError, resolveUserConfigPath, resolveThinkingConfig, envRoleTimeout } from '../config/RoleConfig.js';
import { GLM_CODING_PLAN_MODEL as GLMCodingPlanModelRef } from '../identity/GLMCodingPlanSeat.js';
import { KILO_SEAT_FALLBACKS, isKiloGatewayUrl, isCodexProxyUrl, isOllamaCloudUrl } from '../config/KiloGateway.js';
import { getActiveGeneratorOverride } from './generatorOverrideContext.js';
import { selectApiKeyForEndpoint } from '../config/ProviderKeyResolver.js';
import {
  PROVIDER_ORDER,
  apiKeyEnvNamesForProvider,
  detectProviderLabel,
  firstUsableApiKey,
  readRuntimeEnv,
  apiStyleForEndpoint,
} from '../config/ProviderRuntime.js';
import { compactLLMErrorProvenance, extractLLMErrorProvenance, type LLMRequestProvenance } from './ErrorProvenance.js';
import { buildExecutorIdentity, isKnownResponseModelAlias } from '../identity/canonicalAlias.js';
import { decideRoleEligibility } from '../identity/roleEligibilityPolicy.js';
import type { EligibilityPhase, ExecutorIdentity, ModelEffort } from '../identity/types.js';
import { sha256Hex } from '../identity/hostAdapterRegistry.js';
import type { ExecutorAttestationV2, ExecutorAttestationV3 } from '../identity/executorAttestation.js';
import { classifyProviderSurface, isOwnerLanGatewayUrl, resolveRuntimeExecutorAuthority, loadPinnedProductionHostAuthority } from '../identity/executorAuthorityBootstrap.js';
import { canonicalCliSeatUrl } from '../identity/cliSeatUrl.js';
import { loadGLMCodingPlanSeat } from '../identity/GLMCodingPlanSeat.js';
import { parseHermesSeat } from '../identity/cliSeatUrl.js';
import type {
  ExecutorAttemptRecord,
  ExecutorAttestationRef,
  HarnessAttemptContext,
  HarnessExecutorProjection,
  HarnessTransportAuthority,
} from '../identity/harnessTransportGuard.js';
import {
  projectExecutorAttemptHistory,
  toExecutorAttemptRecord,
  toExecutorAttestationRef,
} from '../identity/harnessTransportGuard.js';

interface VerifiedHarnessCompletion {
  readonly ref: ExecutorAttestationRef;
  readonly attestation: ExecutorAttestationV2 | ExecutorAttestationV3;
}

export interface LLMConfig {
  /** Base URL for the LLM API (OpenAI-compatible) */
  baseUrl: string;
  /** API key (optional for local endpoints) */
  apiKey?: string;
  /** Model name to use */
  model: string;
  /** Provider metadata for diagnostics and compatibility with provider templates. */
  provider?: string;
  /** Human-readable provider name, when supplied by provider templates. */
  name?: string;
  /** Human-readable provider description, when supplied by provider templates. */
  description?: string;
  /** Temperature for generation (0-2) */
  temperature?: number;
  /** Maximum tokens to generate */
  maxTokens?: number;
  /**
   * Per-request abort timeout (ms) for provider HTTP calls.
   * Without this field, callers pass timeout and it is silently dropped.
   */
  timeout?: number;
  /**
   * Optional role — when set, resolves config from RoleConfig system
   * (generator/evaluator/harness). Overrides baseUrl/model/apiKey from
   * role-based configuration if available.
   */
  role?: ModelRole;
  /** Host-owned authority required for every harness provider attempt. */
  harnessTransportAuthority?: HarnessTransportAuthority;
  /**
   * API style - DEPRECATED, silently ignored.
   * Provider detection is now handled by ProviderFactory.
   * Kept for backward compatibility.
   * @deprecated
   */
  apiStyle?: 'openai' | 'ollama' | 'anthropic';
  /**
   * Custom endpoint path (overrides defaults)
   * e.g., '/v1/chat/completions', '/api/generate'
   */
  endpointPath?: string;
  /** Custom headers to add to requests */
  headers?: Record<string, string>;
  /**
   * Custom request body transformation
   * Allows adapting to any provider's specific requirements
   */
  transformRequest?: (body: unknown) => unknown;
  /**
   * Custom response parsing
   * Allows extracting content from any provider's response format
   */
  parseResponse?: (data: unknown) => { content: string; reasoning?: string } | null;
  /** Extended thinking / reasoning effort (OpenAI effort, Anthropic budget, …) */
  thinking?: ThinkingConfig;
  /** Grok OIDC / grok-cli subscription seat. Hostname alone is not enough. */
  grokSubscriptionSeat?: boolean;
  glmCodingPlanSeat?: boolean;
  /** MiniMax Token Plan seat: flat subscription on the exact api.minimax.io/anthropic endpoint. */
  minimaxTokenPlanSeat?: boolean;
  /** Credential provenance; `grok-oidc` marks the Grok subscription seat. */
  keySource?: string;
}

const TRANSPORT_FAILURE_PATTERN = /fetch failed|econnrefused|econnreset|enotfound|etimedout|socket hang up|network/i;

/**
 * Whether an error says the provider itself is unhealthy, so it should count
 * toward the circuit breaker: timeouts, transport failures and 5xx only.
 * Aborts, authority refusals, auth, rate limits, other 4xx and model-declared
 * failures do not (#1423 bug 29).
 */
export function isBreakerFailure(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (error.name === 'AbortError') return false;
  if (error instanceof LLMTimeoutError) return true;
  if (error instanceof LLMAuthError || error instanceof LLMRateLimitError) return false;
  if (error instanceof LLMError && error.statusCode !== undefined) return error.statusCode >= 500;
  return TRANSPORT_FAILURE_PATTERN.test(error.message);
}

export interface LLMResponse {
  code: string;
  explanation?: string;
  reasoning?: string;
  /** Raw thinking text from models that output reasoning tags */
  thinking?: string;
  /** True if code was recovered from thinking/reasoning tags */
  recoveredFromThinking?: boolean;
  success: boolean;
  error?: string;
  fromCache?: boolean;
  isComplete?: boolean;
  /** Provider finish reason; 'length' means the reply hit the output-token cap
   * (#1643), and then success is false (#1423 bug 7). */
  finishReason?: ProviderResponse['finishReason'];
  /** Trace ID linking to a ReasoningCapture file */
  reasoningTraceId?: string;
  /** Source of thinking extraction (think_tags, narrative, provider_api, none) */
  thinkingSource?: string;
  /** Reasoning quality score 0-1 from ReasoningCapture */
  reasoningQuality?: number;
  /** Pattern types detected in reasoning */
  detectedPatterns?: string[];
  provenance?: LLMRequestProvenance;
  /** Token usage when the provider reports it */
  usage?: TokenUsage;
  /**
   * Ordered signed completion refs collected across every provider call that
   * contributed to this response (primary + retries + fallbacks). Empty when
   * no host-signed transport authority was bound to this client (#717).
   */
  executorAttestations?: readonly ExecutorAttestationRef[];
}

export interface LLMCompleteResult {
  text: string;
  success: boolean;
  error?: string;
  provider?: string;
  model?: string;
  endpoint?: string;
  statusCode?: number;
  retryable?: boolean;
  responseBody?: string;
  provenance?: LLMRequestProvenance;
  endpointStyle?: LLMRequestProvenance['endpointStyle'];
  fallbackUsed?: boolean;
  fallbackFrom?: string;
  fallbackTo?: string;
  errorSource?: 'provider' | 'client' | 'network' | 'unknown';
  /** Token usage when the provider reports it (incl. thinkingTokens) */
  usage?: TokenUsage;
  /**
   * Ordered signed completion refs collected across every provider call that
   * contributed to this result (primary + retries + fallbacks). Empty when no
   * host-signed transport authority was bound (#717).
   */
  executorAttestations?: readonly ExecutorAttestationRef[];
}

/**
 * Universal LLM Client - model agnostic, provider agnostic
 *
 * Works with any OpenAI-compatible endpoint:
 * - Ollama (http://localhost:11434)
 * - LM Studio (http://localhost:1234/v1)
 * - OpenAI (https://api.openai.com/v1)
 * - OpenRouter (https://openrouter.ai/api/v1)
 * - Anthropic (https://api.anthropic.com)
 * - Google Gemini (https://generativelanguage.googleapis.com)
 * - Any other compatible API
 *
 * Delegates to provider instances via ProviderFactory.
 * Philosophy: Clean the output, don't choose the model.
 */
export class LLMClient {
  private config: LLMConfig;
  private cache = new CacheManager({ enabled: true });
  private provider: BaseProvider | null = null;
  private role: ModelRole | undefined;
  private readonly harnessTransportAuthority: HarnessTransportAuthority | undefined;
  private readonly hasExplicitHarnessTransportAuthority: boolean;
  private harnessExecutorProjection: HarnessExecutorProjection = { status: 'idle', attempts: [] };
  private readonly executorAttemptHistory: ExecutorAttemptRecord[] = [];
  private readonly currentExecutorAttempts: ExecutorAttemptRecord[] = [];
  private lastRoleTraceDigest: string | null = null;
  private readonly explicitEndpointConfig: boolean;
  private readonly explicitTemperatureConfig: boolean;
  private readonly explicitMaxTokensConfig: boolean;
  private roleConfigResolutionPromise: Promise<void> | null = null;
  /** Cached role config — populated lazily when role is used */
  private static roleConfigs: Record<ModelRole, ResolvedRoleConfig> | null = null;
  private static codingPlanVerified: boolean | undefined;
  /** A005 (Sol): a declared glm coding-plan seat counts only when the pinned
   *  owner-signed binding loads and verifies (signature, expiry, exact model).
   *  Memoized per process; any failure drops the flag (honest glm-direct). */
  private static codingPlanDeclarationVerified(requestedModel: string | undefined): boolean {
    // The binding must verify AND the requesting client must ride the exact
    // bound model — a seat flag declared for a different model on the same
    // endpoint stays glm-direct (Sol follow-up round 2, 2026-08-26).
    if (requestedModel !== GLMCodingPlanModelRef) {
      return false;
    }
    if (LLMClient.codingPlanVerified === undefined) {
      try {
        const { binding } = loadGLMCodingPlanSeat({
          registry: loadPinnedProductionHostAuthority().registry,
        });
        LLMClient.codingPlanVerified = binding.subject.model === GLMCodingPlanModelRef;
      } catch {
        LLMClient.codingPlanVerified = false;
      }
    }
    return LLMClient.codingPlanVerified;
  }
  /** Cached raw config file — needed for fallback resolution */
  private static roleConfigFile: RoleConfigFile | null = null;
  /** Resolved fallback providers — lazily populated */
  private fallbackProviders: BaseProvider[] | null = null;
  /** Circuit breakers per provider for fault isolation */
  private breakers = new Map<string, CircuitBreaker>();

  private formatFallbackFailure(model: string, error: unknown): string {
    const reason = error instanceof Error ? error.message : String(error);
    return `${model}: ${reason}`;
  }

  private withFallbackDiagnostics(primaryError: unknown, failures: string[]): Error {
    const suffix = failures.length > 0
      ? ` Fallbacks exhausted (${failures.join(' | ')})`
      : '';

    if (primaryError instanceof LLMError) {
      return new LLMError(
        `${primaryError.message}${suffix}`,
        primaryError.provider,
        primaryError.statusCode,
        primaryError.retryable,
        {
          model: primaryError.model,
          endpoint: primaryError.endpoint,
          statusText: primaryError.statusText,
          responseBody: primaryError.responseBody,
        },
      );
    }

    if (primaryError instanceof Error) {
      return new Error(`${primaryError.message}${suffix}`, { cause: primaryError });
    }

    return new Error(`Unknown error${suffix}`);
  }

  private parseToolArguments(raw: string, toolName: string): Record<string, unknown> {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
      throw new Error('arguments must be a JSON object');
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(`Tool ${toolName} arguments invalid: ${reason}`);
    }
  }

  private extractToolCodeCandidate(args: Record<string, unknown>, toolResult: string): string | null {
    if (typeof args.code !== 'string' || args.code.trim().length === 0) return null;
    try {
      const parsed = JSON.parse(toolResult);
      if (
        parsed &&
        typeof parsed === 'object' &&
        ((parsed as { valid?: unknown }).valid === false ||
          (parsed as { success?: unknown }).success === false ||
          (parsed as { ok?: unknown }).ok === false)
      ) {
        return null;
      }
    } catch {
      if (/\b(error|invalid|failed|failure)\b/i.test(toolResult)) return null;
    }
    return args.code;
  }

  private contentOrToolCodeCandidate(content: string, fallbackCode: string | null): string {
    return content && content.trim().length > 0 ? content : fallbackCode || '';
  }

  constructor(rawConfig?: Partial<LLMConfig>) {
    // Hybrid router: a role:'generator' client is redirected to a local (e.g.
    // local host) generator for the current generation when one is active (set only by
    // GenerationOrchestrator for a local-favored domain). The override wins even
    // over an explicit baseUrl, because real generators build their client with an
    // explicit endpoint from getEffectiveConfig — gating on `!baseUrl` would let
    // them bypass routing entirely. No active override → behavior unchanged.
    const override = rawConfig?.role === 'generator'
      ? getActiveGeneratorOverride()
      : undefined;
    const config: Partial<LLMConfig> | undefined = override
      ? { ...rawConfig, baseUrl: override.baseUrl, model: override.model, ...(override.apiKey ? { apiKey: override.apiKey } : {}) }
      : rawConfig;
    this.role = config?.role;
    this.hasExplicitHarnessTransportAuthority = config?.harnessTransportAuthority !== undefined;
    this.harnessTransportAuthority = this.role
      ? resolveRuntimeExecutorAuthority(config?.harnessTransportAuthority)
      : config?.harnessTransportAuthority;
    const durableAttempts = this.harnessTransportAuthority?.readAttemptHistory?.() ?? [];
    this.executorAttemptHistory.push(...durableAttempts);
    this.currentExecutorAttempts.push(...durableAttempts);
    this.lastRoleTraceDigest = durableAttempts.at(-1)?.policyTraceDigest ?? null;
    this.harnessExecutorProjection = projectExecutorAttemptHistory(this.executorAttemptHistory);
    this.explicitEndpointConfig = Boolean(config?.baseUrl || config?.model || config?.apiKey || env('LLM_BASE_URL') || env('LLM_MODEL'));
    this.explicitTemperatureConfig = config?.temperature !== undefined;
    this.explicitMaxTokensConfig = config?.maxTokens !== undefined;

    // If a role is specified, try to resolve from RoleConfig system
    let roleBaseUrl: string | undefined;
    let roleApiKey: string | undefined;
    let roleModel: string | undefined;
    let roleTemperature: number | undefined;
    let roleMaxTokens: number | undefined;
    let roleThinking: ThinkingConfig | undefined;
    let roleTimeout: number | undefined;

    let roleSeatFlag: boolean | undefined;
    let roleMinimaxSeatFlag: boolean | undefined;
    if (this.role) {
      const roleCfg = LLMClient.getRoleConfigSync(this.role);
      if (roleCfg) {
        roleSeatFlag = roleCfg.glmCodingPlanSeat;
        roleMinimaxSeatFlag = roleCfg.minimaxTokenPlanSeat;
        roleBaseUrl = roleCfg.baseUrl;
        roleApiKey = roleCfg.apiKey;
        roleModel = roleCfg.model;
        roleTemperature = roleCfg.temperature;
        roleMaxTokens = roleCfg.maxTokens;
        roleThinking = roleCfg.thinking;
        roleTimeout = roleCfg.timeout;
      }
    }

    // Env beats the cached role config (defense in depth — RoleConfig already
    // resolves env-over-file at load time; this covers a cache populated before
    // the env was set). Explicit constructor config still wins overall, and a
    // role-cached key is never paired with an env endpoint.
    // SEAT-ISOLATION FIX (2026-09-01): the generic LLM_* env is the loop's
    // GENERATOR lane channel. It must NEVER steer the harness/evaluator/
    // studio seats — a rotation-lane env leaked into the harness seat made
    // every tournament child die AFTER transport on an unclassified surface
    // (EXECUTOR_AUTHORITY_UNAVAILABLE), burning 13-15 min per kill. Those
    // seats are file-pinned (per role-specific env only) — the same intent
    // the loop's own "file-pinned seats take precedence" banner states.
    const genericEnvAllowed = !this.role || this.role === 'generator';
    const envBaseUrl = genericEnvAllowed ? env('LLM_BASE_URL') : undefined;
    const envModel = genericEnvAllowed ? env('LLM_MODEL') : undefined;
    const baseUrl = config?.baseUrl || envBaseUrl || roleBaseUrl || SERVICE_DEFAULTS.LOCAL_LLM_URL;

    const model = config?.model || envModel || roleModel || SERVICE_DEFAULTS.DEFAULT_MODEL;

    this.config = {
      baseUrl,
      apiKey: config?.apiKey ?? (envBaseUrl ? undefined : roleApiKey) ?? selectApiKeyForEndpoint(baseUrl, model, genericEnvAllowed ? ['LLM_API_KEY'] : []),
      model,
      provider: config?.provider,
      name: config?.name,
      description: config?.description,
      temperature: config?.temperature ?? roleTemperature ?? 0.7,
      maxTokens: config?.maxTokens ?? roleMaxTokens ?? 4096,
      // Role timeout (env SINTER_<ROLE>_TIMEOUT_MS > file > role default,
      // resolved in RoleConfig) outranks the legacy global env (#1423 bug 32).
      timeout: config?.timeout
        ?? roleTimeout
        ?? (() => {
          const n = Number.parseInt(
            process.env.LIMINAL_HARNESS_TIMEOUT || process.env.LIMINAL_LLM_TIMEOUT || '',
            10,
          );
          return Number.isFinite(n) && n > 0 ? n : undefined;
        })(),
      role: this.role,
      thinking: config?.thinking ?? resolveThinkingConfig(roleThinking),
      glmCodingPlanSeat: (config?.glmCodingPlanSeat ?? roleSeatFlag) === true
        ? LLMClient.codingPlanDeclarationVerified(model) : false,
      minimaxTokenPlanSeat: (config?.minimaxTokenPlanSeat ?? roleMinimaxSeatFlag) === true,
      // apiStyle is deprecated — silently accepted but ignored
      apiStyle: config?.apiStyle,
      endpointPath: config?.endpointPath,
      headers: config?.headers,
      transformRequest: config?.transformRequest,
      parseResponse: config?.parseResponse,
    };

    // Dev-mode guard: detect if config has keys this constructor silently drops
    if (process.env.NODE_ENV !== 'production' && config) {
      const knownKeys = new Set(Object.keys(this.config));
      knownKeys.add('harnessTransportAuthority');
      const providedKeys = Object.keys(config) as (keyof LLMConfig)[];
      const dropped = providedKeys.filter(k => !knownKeys.has(k as string));
      if (dropped.length > 0) {
        Logger.warn('LLMClient', `Config properties silently dropped: ${dropped.join(', ')}. Add to LLMConfig or constructor.`);
      }
    }
  }

  /**
   * Resolve role config synchronously (uses cached or env-var-only fallback).
   * Full RoleConfig loading is async, but constructors can't be async.
   * Call `LLMClient.loadRoles()` once at startup to populate the cache.
   */
  private static getRoleConfigSync(role: ModelRole): ResolvedRoleConfig | null {
    if (LLMClient.roleConfigs) {
      return LLMClient.roleConfigs[role] || null;
    }
    // Synchronous env-var fallback for each role
    const envMap: Record<ModelRole, { baseUrl: string[]; model: string[]; apiKey: string[] }> = {
      generator: {
        baseUrl: ['LLM_BASE_URL'],
        model: ['LLM_MODEL'],
        apiKey: ['LLM_API_KEY'],
      },
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
    const sources = envMap[role];
    const baseUrl = sources.baseUrl.map(k => env(k)).find(Boolean);
    const model = sources.model.map(k => env(k)).find(Boolean);
    const apiKey = selectApiKeyForEndpoint(baseUrl || '', model, sources.apiKey);

    if (baseUrl || model) {
      return {
        baseUrl: baseUrl || SERVICE_DEFAULTS.LOCAL_LLM_URL,
        model: model || SERVICE_DEFAULTS.DEFAULT_MODEL,
        apiKey,
        temperature: role === 'generator' ? 0.7 : role === 'evaluator' ? 0.2 : 0.5,
        maxTokens: 4096,
        // Generator and harness calls reach reasoning models that think for
        // minutes before answering (#708); the evaluator judge gets 3 minutes (#709).
        timeout: envRoleTimeout(role) ?? (role === 'evaluator' ? TIMEOUT_EVALUATOR_MS
          : role === 'studio' ? TIMEOUT_OLLAMA_MS : TIMEOUT_DEFAULT_MS),
        thinking: resolveThinkingConfig(),
        streaming: role === 'harness',
      };
    }
    return null;
  }

  /**
   * Load role configs from file (async). Call once at startup.
   * After this, constructors with `role` will use cached file config.
   */
  static async loadRoles(projectDir?: string): Promise<void> {
    try {
      const { configs, rawFile } = await LLMClient.loadRoleConfigWithFile(projectDir);
      // eslint-disable-next-line require-atomic-updates
      LLMClient.roleConfigs = configs;
      // eslint-disable-next-line require-atomic-updates
      LLMClient.roleConfigFile = rawFile;
    } catch (err) {
      Logger.warn('LLMClient', 'Role config loading failed:', err);
      if (isFatalRoleConfigError(err)) {
        throw err;
      }
      // Role config loading failure is non-fatal — env vars still work
      // eslint-disable-next-line require-atomic-updates
      LLMClient.roleConfigs = null;
      // eslint-disable-next-line require-atomic-updates
      LLMClient.roleConfigFile = null;
    }
  }

  /**
   * Clear global static caches to enable environment isolation.
   * This is essential when running tests with different model configurations
   * to prevent configuration leakage between runs.
   */
  static clearGlobalCache(): void {
    LLMClient.roleConfigs = null;
    LLMClient.roleConfigFile = null;
  }

  /**
   * The resolved config for a role (cached by {@link loadRoles}), or null when
   * roles have not been loaded. Lets the CLI report the endpoint a role will
   * actually use after env-over-file resolution.
   */
  static getResolvedRoleConfig(role: ModelRole): ResolvedRoleConfig | null {
    return LLMClient.roleConfigs?.[role] ?? null;
  }

  /**
   * The raw loaded role config file (cached by {@link loadRoles}), or null if not
   * loaded. Lets the hybrid router read `roles.generatorLocal` without reaching
   * into RoleConfig's async loader on a hot path.
   */
  static getRawRoleConfig(): RoleConfigFile | null {
    return LLMClient.roleConfigFile;
  }

  private async resolveRoleConfigForRequest(): Promise<void> {
    if (!this.role || this.explicitEndpointConfig) return;

    if (!this.roleConfigResolutionPromise) {
      this.roleConfigResolutionPromise = this.doResolveRoleConfigForRequest();
    }

    return this.roleConfigResolutionPromise;
  }

  private async doResolveRoleConfigForRequest(): Promise<void> {
    if (!LLMClient.roleConfigs) {
      await LLMClient.loadRoles(process.cwd());
    }

    const roleConfig = this.role ? LLMClient.roleConfigs?.[this.role] : undefined;
    if (!roleConfig || !this.hasUsableRoleEndpoint(roleConfig)) return;

    if (
      this.config.baseUrl === roleConfig.baseUrl &&
      this.config.model === roleConfig.model &&
      this.config.apiKey === roleConfig.apiKey
    ) {
      return;
    }

    const roleSeat = roleConfig as ResolvedRoleConfig & {
      grokSubscriptionSeat?: boolean;
      glmCodingPlanSeat?: boolean;
      minimaxTokenPlanSeat?: boolean;
      keySource?: string;
    };
    this.config = {
      ...this.config,
      baseUrl: roleConfig.baseUrl,
      apiKey: roleConfig.apiKey,
      model: roleConfig.model,
      provider: roleConfig.provider,
      temperature: this.explicitTemperatureConfig ? this.config.temperature : roleConfig.temperature,
      maxTokens: this.explicitMaxTokensConfig ? this.config.maxTokens : roleConfig.maxTokens,
      // Env reasoning pin wins over stale file/role thinking
      thinking: resolveThinkingConfig(roleConfig.thinking),
      grokSubscriptionSeat: this.config.grokSubscriptionSeat
        || roleSeat.grokSubscriptionSeat
        || roleSeat.keySource === 'grok-oidc',
      glmCodingPlanSeat: this.config.glmCodingPlanSeat
        || roleSeat.glmCodingPlanSeat,
      minimaxTokenPlanSeat: this.config.minimaxTokenPlanSeat
        || roleSeat.minimaxTokenPlanSeat,
      keySource: this.config.keySource ?? roleSeat.keySource,
    };
    this.provider = null;
    this.fallbackProviders = null;
    this.resolvedModel = null;
  }

  private hasUsableRoleEndpoint(roleConfig: ResolvedRoleConfig): boolean {
    const configuredBaseUrl = roleConfig.baseUrl && roleConfig.baseUrl !== SERVICE_DEFAULTS.LOCAL_LLM_URL;
    const configuredModel = Boolean(
      roleConfig.model &&
      roleConfig.model !== SERVICE_DEFAULTS.DEFAULT_MODEL &&
      roleConfig.model !== 'unknown'
    );
    return Boolean(configuredBaseUrl || configuredModel || roleConfig.apiKey);
  }

  /** Get the role this client was configured for */
  getRole(): ModelRole | undefined {
    return this.role;
  }

  /** Canonical executor/blocker truth shared by CLI and Studio projections. */
  getHarnessExecutorProjection(): HarnessExecutorProjection {
    return this.harnessExecutorProjection;
  }

  /** Verify a persisted V2 completion with this client's host trust root. */
  verifyPersistedExecutorCompletion(attestation: ExecutorAttestationV2 | ExecutorAttestationV3) {
    const authority = this.currentHarnessAuthority();
    return authority?.guard.verifyPersistedCompletion(attestation)
      ?? { ok: false as const, reason: 'authority-unavailable' as const };
  }

  // ── Fallback provider chain ──

  /**
   * Load role config and also return the raw file for fallback resolution.
   */
  private static async loadRoleConfigWithFile(
    projectDir?: string,
  ): Promise<{ configs: Record<ModelRole, ResolvedRoleConfig>; rawFile: RoleConfigFile | null }> {
    // Re-use the existing loadRoleConfig for resolved configs.
    // For the raw file, we load it separately here to avoid changing the
    // public API of loadRoleConfig.
    const configs = await loadRoleConfig(projectDir);

    // Load raw file for fallbacks
    let rawFile: RoleConfigFile | null = null;
    try {
      const { readFile } = await import('fs/promises');
      // Honor SINTER_CONFIG_PATH (matches loadRoleConfig) so the raw file —
      // fallbacks and roles.generatorLocal — comes from the SAME config a daemon
      // or test points at, not always ~/.sinter/config.json.
      const content = await readFile(resolveUserConfigPath(), 'utf-8');
      rawFile = JSON.parse(content) as RoleConfigFile;
    } catch (err) {
      Logger.debug('LLMClient', 'No config file found, fallbacks come from env or are empty:', err);
      // No config file — fallbacks come from env or are empty
    }

    return { configs, rawFile };
  }

  /**
   * Resolve fallback providers for this client's role.
   * Returns cached instances if already resolved.
   */
  private getFallbackProviders(): BaseProvider[] {
    if (this.fallbackProviders) {
      return this.fallbackProviders;
    }

    if (!this.role) {
      this.fallbackProviders = [];
      return this.fallbackProviders;
    }

    const rawFile = LLMClient.roleConfigFile;
    let fallbackConfigs = getFallbacks(this.role, rawFile);

    // Doctrine seat fallbacks: only when this role is seat-fronted (Codex
    // proxy / Kilo / Ollama Cloud, or the evaluator while the generator is
    // seat-fronted) and the config file defines no explicit fallback chain
    // for the role. Explicit file fallbacks always win.
    // Defaults (#379): generator + evaluator → gpt-5.6-luna on cliproxy.
    // Harness has no registered fallback (Kilo is not a kimi-k3 fallback).
    if (fallbackConfigs.length === 0 && this.isSeatFrontedForFallbacks()) {
      fallbackConfigs = KILO_SEAT_FALLBACKS[this.role] ?? [];
    }

    if (fallbackConfigs.length === 0) {
      this.fallbackProviders = [];
      return this.fallbackProviders;
    }

    this.fallbackProviders = fallbackConfigs.map((cfg) => {
      const providerCfg: import('../llm/ProviderTypes.js').ProviderConfig = {
        baseUrl: cfg.baseUrl,
        // The fallback entry carries its own logical family and seat
        // declarations — the primary role's must not shadow them (A005/Sol).
        logicalProvider: cfg.provider,
        glmCodingPlanSeat: cfg.glmCodingPlanSeat === true,
        minimaxTokenPlanSeat: cfg.minimaxTokenPlanSeat === true,
        // Fallback configs may omit apiKey — resolve it endpoint-aware from
        // the environment (KILO_API_KEY for kilo.ai, GLM_API_KEY for z.ai).
        apiKey: cfg.apiKey ?? selectApiKeyForEndpoint(cfg.baseUrl, cfg.model),
        model: cfg.model,
        temperature: cfg.temperature,
        maxTokens: cfg.maxTokens,
        timeout: cfg.timeout,
      };
      Logger.info('LLMClient.fallback', `Registered fallback provider: ${cfg.model} @ ${cfg.baseUrl}`);
      return createProvider(providerCfg);
    });

    return this.fallbackProviders;
  }

  /**
   * True when this client belongs to a seat-fronted setup for doctrine
   * fallback purposes: the role fronts Codex proxy / Kilo / Ollama Cloud, or
   * it is the evaluator while the generator is seat-fronted (covers legacy
   * MiniMax-direct evaluator configs still hanging off a seat-fronted gen).
   */
  private isSeatFrontedForFallbacks(): boolean {
    if (
      isKiloGatewayUrl(this.config.baseUrl)
      || isCodexProxyUrl(this.config.baseUrl)
      || isOllamaCloudUrl(this.config.baseUrl)
    ) {
      return true;
    }
    const genUrl = LLMClient.roleConfigs?.generator?.baseUrl;
    return this.role === 'evaluator'
      && (isKiloGatewayUrl(genUrl) || isCodexProxyUrl(genUrl));
  }

  /** Final fail-closed role check at the real provider boundary. */
  private assertRoleAttemptEligible(
    provider: BaseProvider,
    phase: Extract<EligibilityPhase, 'pre-primary-transport' | 'pre-fallback-transport' | 'pre-retry-transport'>,
    fallbackOrdinal = 0,
    retryOrdinal = 0,
  ): void {
    if (this.role !== 'harness') return;
    // identityFor reads the provider family from CLI seat URLs (cli://hermes/openai-api/...);
    // the raw config provider there is just 'cli', which names no model family.
    const requested = this.identityFor(this.config.model);
    const actualModel = provider.getModel();
    const resolved = this.identityFor(actualModel);
    const decision = decideRoleEligibility({
      role: 'harness', sourceLayer: phase === 'pre-fallback-transport' ? 'fallbacks-harness' : 'explicit-harness-client',
      phase, requestedIdentity: requested, resolvedIdentity: resolved,
      fallbackOrdinal, retryOrdinal,
      priorDigest: null, policyInvokedAt: [phase], substitutionAllowed: false,
    });
    if (!decision.ok) {
      throw new LLMError(`Harness executor blocked before transport: ${decision.reason}: ${decision.detail}`,
        provider.name, undefined, false, { model: actualModel, endpoint: this.providerEndpoint(provider.getConfig().baseUrl, actualModel) });
    }
  }

  /** A003: fallback providers hitting the exact GLM coding-plan endpoint
   * inherit the seat declaration from the role config, so they classify as
   * glm-coding-plan-seat instead of dying on glm-direct metered evidence. */
  private glmCodingPlanEndpointFlag(baseUrl: string, declared?: boolean): boolean {
    if (!((declared ?? this.config.glmCodingPlanSeat) === true)) return false;
    return String(baseUrl).replace(/\/+$/, '') === 'https://api.z.ai/api/anthropic';
  }

  private classifySurface(provider: string, baseUrl: string,
    fallbackSeatOverride?: boolean, minimaxTokenPlanSeat?: boolean) {
    return classifyProviderSurface(provider, baseUrl, {
      grokSubscriptionSeat: this.config.grokSubscriptionSeat === true
        || this.config.keySource === 'grok-oidc',
      glmCodingPlanSeat: fallbackSeatOverride ?? this.config.glmCodingPlanSeat === true,
      // Per attempt: a fallback on the same host with a pay-per-token key
      // must not inherit the primary's subscription declaration.
      minimaxTokenPlanSeat: (minimaxTokenPlanSeat ?? this.config.minimaxTokenPlanSeat) === true,
      model: this.config.model,
    });
  }

  private identityFor(model: string): ExecutorIdentity {
    const effort = (this.config.thinking?.effort ?? 'high') as ModelEffort;
    const cliSeatUrl = canonicalCliSeatUrl(this.config.baseUrl);
    const hermesSeat = parseHermesSeat(this.config.baseUrl);
    const providerHint = cliSeatUrl === 'cli://codex' ? 'openai'
      : cliSeatUrl === 'cli://claude' ? 'anthropic'
      : cliSeatUrl === 'cli://agy' ? 'google'
        : cliSeatUrl === 'cli://command-code' ? undefined
          // Hermes provider names: openai-api is OpenAI's API; the rest map as-is.
          : hermesSeat ? (hermesSeat.provider === 'openai-api' ? 'openai' : hermesSeat.provider)
            : this.config.provider;
    return buildExecutorIdentity(model, effort, {
      providerHint,
    }) ?? {
      provider: 'unknown', model: model || 'unknown', effort, alias: model || 'unknown',
    };
  }

  private assertHarnessAuthorityBeforeResolution(): void {
    if (!this.role) return;
    const identity = this.identityFor(this.config.model);
    const context: HarnessAttemptContext = {
      role: this.role,
      requestDigest: 'not-yet-authorized',
      routeDigest: 'not-yet-resolved',
      requestedIdentity: identity,
      resolvedIdentity: identity,
      phase: 'pre-primary-transport',
      fallbackOrdinal: 0,
      retryOrdinal: 0,
      attemptOrdinal: 0,
      priorTraceDigest: null,
      policyTraceDigest: 'preflight',
      fallbackChain: [{ ordinal: 0, identity }],
      surface: this.classifySurface(this.config.provider ?? identity.provider, this.config.baseUrl),
      seatDigest: sha256Hex(this.config.apiKey ?? this.config.baseUrl),
    };
    const decision = decideRoleEligibility({
      role: this.role, sourceLayer: 'explicit-harness-client', phase: 'pre-primary-transport',
      requestedIdentity: identity, resolvedIdentity: identity, fallbackOrdinal: 0, retryOrdinal: 0,
      priorDigest: null, policyInvokedAt: ['pre-primary-transport'], substitutionAllowed: false,
    });
    if (!decision.ok && decision.reason !== 'unknown-resolved-identity') {
      return this.blockHarnessAttempt(context, `${decision.reason}: ${decision.detail}`);
    }
    if (decision.ok) this.lastRoleTraceDigest = decision.trace.digest;
    if (!this.currentHarnessAuthority()) {
      return this.blockHarnessAttempt(context, 'host-owned completion authority is required');
    }
  }

  private currentHarnessAuthority(): HarnessTransportAuthority | undefined {
    if (this.hasExplicitHarnessTransportAuthority) return this.harnessTransportAuthority;
    return harnessTransportAuthorities.getStore() ?? this.harnessTransportAuthority;
  }

  private requestDigest(req: ProviderRequest): string {
    return providerRequestDigest(req);
  }

  private startExecutorAttemptSequence(): void {
    // Durable history is retained. Request-digest filtering in
    // beginHarnessAttempt preserves ordinals and trace lineage across restart.
  }

  private blockHarnessAttempt(context: HarnessAttemptContext, terminalReason: string): never {
    this.harnessExecutorProjection = {
      status: 'blocked',
      attempts: [...this.executorAttemptHistory],
      requested: context.requestedIdentity,
      resolved: context.resolvedIdentity,
      fallbackOrdinal: context.fallbackOrdinal,
      retryOrdinal: context.retryOrdinal,
      terminalReason,
    };
    throw new LLMError(`Harness executor blocked before transport: ${terminalReason}`, context.resolvedIdentity.provider,
      undefined, false, { model: context.resolvedIdentity.model });
  }

  private async beginHarnessAttempt(
    provider: BaseProvider,
    req: ProviderRequest,
    phase: Extract<EligibilityPhase, 'pre-primary-transport' | 'pre-fallback-transport' | 'pre-retry-transport'>,
    fallbackOrdinal = 0,
    retryOrdinal = 0,
  ): Promise<{ context: HarnessAttemptContext; reservation?: import('../identity/executorReservation.js').ExecutorReservationV1 } | null> {
    assertProviderAttemptAllowed();
    assertRoleBoundProviderAttempt(this.role);
    this.assertRoleAttemptEligible(provider, phase, fallbackOrdinal, retryOrdinal);
    if (!this.role) return null;

    const requestDigest = this.requestDigest(req);
    // Attempts classify with the TRANSPORT's own family — a fallback riding
    // the primary client must not inherit the primary's provider identity.
    const attemptProviderCfg = provider.getConfig();
    const providerFamily = attemptProviderCfg.logicalProvider
      ?? this.config.provider ?? provider.name;
    const routeDigest = sha256Hex(JSON.stringify({
        provider: providerFamily,
        model: provider.getModel(),
        baseUrl: provider.getConfig().baseUrl,
        phase,
        fallbackOrdinal,
        retryOrdinal,
      }));
    const requestedIdentity = this.identityFor(this.config.model);
    const resolvedIdentity = this.identityFor(provider.getModel());
    const priorTraceDigest = this.lastRoleTraceDigest;
    const previousAttempts = this.currentExecutorAttempts.filter(item => item.requestDigest === requestDigest);
    const baseContext = {
      role: this.role, requestDigest, routeDigest, requestedIdentity, resolvedIdentity,
      phase, fallbackOrdinal, retryOrdinal, attemptOrdinal: previousAttempts.length,
      priorTraceDigest,
      fallbackChain: [
        // Ordinals are normalized to index positions: stored attemptOrdinal values
        // can go non-contiguous when durable attempts reload across process
        // restarts, and the attestation gate requires 0..N-1 exactly.
        ...previousAttempts.map((item, index) => ({ ordinal: index,
          identity: item.attestation.subject.resolvedIdentity,
          reason: item.attestation.subject.terminalReason })),
        { ordinal: previousAttempts.length, identity: resolvedIdentity },
      ],
      surface: this.classifySurface(providerFamily, attemptProviderCfg.baseUrl,
        this.glmCodingPlanEndpointFlag(attemptProviderCfg.baseUrl,
          attemptProviderCfg.glmCodingPlanSeat === true)
          || undefined,
        attemptProviderCfg.minimaxTokenPlanSeat === true),
      seatDigest: sha256Hex(attemptProviderCfg.apiKey ?? routeDigest),
    };
    const authority = this.currentHarnessAuthority();
    if (!authority) return this.blockHarnessAttempt({ ...baseContext, policyTraceDigest: 'authority-unavailable' }, 'host-owned completion authority is required');
    if (!authority.guard.isDurable) {
      return this.blockHarnessAttempt({ ...baseContext, policyTraceDigest: 'authority-not-durable' }, 'host-owned transport authority requires durable atomic replay ledgers');
    }

    const genericDecision = decideRoleEligibility({
      role: this.role,
      sourceLayer: phase === 'pre-fallback-transport' ? 'fallbacks-harness' : phase === 'pre-retry-transport' ? 'internal-retry' : 'explicit-harness-client',
      phase,
      requestedIdentity,
      resolvedIdentity,
      fallbackOrdinal,
      retryOrdinal,
      priorDigest: priorTraceDigest,
      policyInvokedAt: [phase],
      substitutionAllowed: this.role === 'harness' ? false : undefined,
    });
    const context: HarnessAttemptContext = { ...baseContext, policyTraceDigest: genericDecision.trace.digest };
    if (!genericDecision.ok) {
      return this.blockHarnessAttempt(context, `${genericDecision.reason}: ${genericDecision.detail}`);
    }
    this.lastRoleTraceDigest = genericDecision.trace.digest;
    if (this.role !== 'harness') return { context };

    let reservation: import('../identity/executorReservation.js').ExecutorReservationV1;
    try {
      reservation = await authority.reserveAttempt(context);
    } catch (error) {
      return this.blockHarnessAttempt(context,
        `reservation unavailable: ${error instanceof Error ? error.message : String(error)}`);
    }
    const authorization = authority.guard.authorizeTransport({
      policy: {
        role: 'harness',
        sourceLayer: phase === 'pre-fallback-transport' ? 'fallbacks-harness' : phase === 'pre-retry-transport' ? 'internal-retry' : 'explicit-harness-client',
        phase,
        requestedIdentity: context.requestedIdentity,
        resolvedIdentity: context.resolvedIdentity,
        fallbackOrdinal,
        retryOrdinal,
        priorDigest: context.priorTraceDigest,
        policyInvokedAt: [phase],
        substitutionAllowed: false,
      },
      reservation,
      now: new Date().toISOString(),
      expectedRequestDigest: context.requestDigest,
      expectedRouteDigest: context.routeDigest,
    });
    if (!authorization.ok) {
      return this.blockHarnessAttempt(context, `${authorization.reason}: ${authorization.detail}`);
    }
    this.lastRoleTraceDigest = authorization.policyTraceDigest;
    return { context, reservation };
  }

  private async finishHarnessAttempt(
    attempt: Awaited<ReturnType<LLMClient['beginHarnessAttempt']>>,
    response: { readonly model: string; readonly content?: string; readonly success: boolean;
      readonly usage?: TokenUsage; readonly durationMs: number; readonly terminalReason?: string },
  ): Promise<VerifiedHarnessCompletion | null> {
    if (!attempt) return null;
    const authority = this.currentHarnessAuthority();
    if (!authority) return this.blockHarnessAttempt(attempt.context, 'host-owned transport authority disappeared');
    let attestation: ExecutorAttestationV2 | ExecutorAttestationV3;
    try {
      attestation = await authority.attestCompletion({ ...attempt, response });
    } catch (error) {
      // COMMITTEE FIX 2026-09-02 (deep-diver trace + fleet census): the
      // reservation path gates ONLY harness-role attempts, but this
      // completion attestation ran for EVERY role — so a generator whose
      // primary seat failed (glm 429/fetch-fail) engaged a fallback, and the
      // fallback's metered-class surface threw HERE, discarding completed
      // work and killing the child (15 fleet kills, 622-895s each; the
      // laptop's 'unknown' tails, srv's 'minimax-direct' tails). Attestation
      // stays AUTHORITY-BINDING for the harness role; for other roles a
      // failed attestation degrades to unattested — the turn proceeds and
      // the gap is observable, never lethal.
      if (this.role === 'harness') {
        return this.blockHarnessAttempt(attempt.context,
          `completion attestation unavailable: ${error instanceof Error ? error.message : String(error)}`);
      }
      Logger.warn('LLMClient', `[attestation] non-harness ${String(this.role ?? 'roleless')} attempt completes unattested: ${error instanceof Error ? error.message : String(error)}`.slice(0, 300));
      return null;
    }
    const signed = attestation.subject;
    const responseIdentity = this.identityFor(response.model);
    if (signed.requestDigest !== attempt.context.requestDigest
      || signed.routeDigest !== attempt.context.routeDigest
      || signed.attemptOrdinal !== attempt.context.attemptOrdinal
      || signed.fallbackOrdinal !== attempt.context.fallbackOrdinal
      || signed.retryOrdinal !== attempt.context.retryOrdinal
      || signed.priorTraceDigest !== attempt.context.priorTraceDigest
      || signed.policyTraceDigest !== attempt.context.policyTraceDigest
      || JSON.stringify(signed.fallbackChain) !== JSON.stringify(attempt.context.fallbackChain)
      || signed.requestedIdentity.model !== attempt.context.requestedIdentity.model
      || signed.requestedIdentity.provider !== attempt.context.requestedIdentity.provider
      || signed.resolvedIdentity.model !== attempt.context.resolvedIdentity.model
      || signed.resolvedIdentity.provider !== attempt.context.resolvedIdentity.provider
      || signed.resolvedIdentity.effort !== attempt.context.resolvedIdentity.effort
      || signed.resolvedIdentity.provider !== responseIdentity.provider
      || (!isCodexProxyUrl(this.config.baseUrl) && !isOwnerLanGatewayUrl(this.config.baseUrl)
        && signed.resolvedIdentity.model !== responseIdentity.model)
      || ((isCodexProxyUrl(this.config.baseUrl) || isOwnerLanGatewayUrl(this.config.baseUrl))
        && !isKnownResponseModelAlias(signed.resolvedIdentity, responseIdentity))) {
      return this.blockHarnessAttempt(attempt.context, 'identity-mismatch: completion does not bind exact request, route, and response model');
    }
    const verified = authority.guard.verifyCompletion({
      attestation,
      reservation: attempt.reservation,
      role: attempt.context.role,
      sourceLayer: attempt.context.phase === 'pre-fallback-transport' ? 'fallbacks-harness' : attempt.context.phase === 'pre-retry-transport' ? 'internal-retry' : 'explicit-harness-client',
      phase: attempt.context.phase,
      policyInvokedAt: [attempt.context.phase],
      now: new Date().toISOString(),
    });
    if (!verified.ok) {
      return this.blockHarnessAttempt(attempt.context, `${verified.reason}: ${verified.detail}`);
    }
    if (verified.attestation.subject.schemaVersion === 'executor-attestation.v1') {
      return this.blockHarnessAttempt(attempt.context, 'legacy completion cannot authorize exact attempt telemetry');
    }
    const delta = verified.attestation.subject.quotaCounterDelta;
    const expected = {
      calls: 1,
      inputTokens: response.usage?.inputTokens ?? 0,
      outputTokens: response.usage?.outputTokens ?? 0,
      activeSeconds: response.durationMs / 1_000,
    };
    if (delta.calls !== expected.calls
      || delta.inputTokens !== expected.inputTokens
      || delta.outputTokens !== expected.outputTokens
      || Math.abs(delta.activeSeconds - expected.activeSeconds) > Number.EPSILON) {
      return this.blockHarnessAttempt(attempt.context, 'signed per-attempt quota delta does not match transport result');
    }
    if (verified.attestation.subject.success !== response.success) {
      return this.blockHarnessAttempt(attempt.context, 'signed attempt outcome does not match transport result');
    }
    const record: ExecutorAttemptRecord = toExecutorAttemptRecord(verified.attestation);
    this.executorAttemptHistory.push(record);
    this.currentExecutorAttempts.push(record);
    this.harnessExecutorProjection = projectExecutorAttemptHistory(this.executorAttemptHistory);
    const ref = toExecutorAttestationRef(record);
    if (!ref) return this.blockHarnessAttempt(attempt.context, 'verified V2 completion ref is unavailable');
    return Object.freeze({ ref, attestation });
  }

  private async executeProviderAttempt(
    provider: BaseProvider,
    req: ProviderRequest,
    phase: Extract<EligibilityPhase, 'pre-primary-transport' | 'pre-fallback-transport' | 'pre-retry-transport'>,
    fallbackOrdinal = 0,
    retryOrdinal = 0,
    collector?: ExecutorAttestationRef[],
  ): Promise<ProviderResponse> {
    const attempt = await this.beginHarnessAttempt(provider, req, phase, fallbackOrdinal, retryOrdinal);
    if (!attempt && hasCurrentCampaignFundingContext()) {
      throw new Error('CAMPAIGN_FUNDING_REQUIRES_CANONICAL_MODEL_ROLE');
    }
    const campaignActive = hasCurrentCampaignFundingContext();
    const transport = attempt && campaignActive ? provider.reserveTransport() : undefined;
    const campaignProfile = attempt && transport ? {
        executorRouteDigest: attempt.context.routeDigest,
        requestDigest: attempt.context.requestDigest,
        role: attempt.context.role,
        identity: attempt.context.resolvedIdentity,
        phase: attempt.context.phase, mode: 'generate' as const,
        attemptOrdinal: attempt.context.attemptOrdinal,
        fallbackOrdinal: attempt.context.fallbackOrdinal,
        retryOrdinal: attempt.context.retryOrdinal,
        maxInputTokens: Math.ceil((req.systemPrompt.length + req.userPrompt.length) / 4),
        maxOutputTokens: req.maxTokens ?? 0,
        baseUrl: transport.baseUrl,
        credentialDigest: transport.credentialDigest,
        transportProvider: transport.provider,
        transportModel: transport.model,
      } : undefined;
    let campaignDebit;
    try {
      const campaignProof = campaignProfile
        ? claimCurrentCampaignTransportProof(campaignProfile) : undefined;
      campaignDebit = campaignProfile && campaignProof
        ? await debitCurrentCampaignFunding({ ...campaignProfile, ...campaignProof }) : undefined;
    } catch (error) {
      if (transport) provider.cancelReservedTransport(transport);
      throw error;
    }
    const startedAt = Date.now();
    let result: Awaited<ReturnType<BaseProvider['generate']>>;
    try {
      result = await provider.generate(req, transport);
    } catch (error) {
      if (attempt) {
        const completion = await this.finishHarnessAttempt(attempt, {
          model: provider.getModel(), success: false,
          durationMs: Date.now() - startedAt,
          terminalReason: error instanceof Error ? error.message : String(error),
        });
        if (completion && collector) collector.push(completion.ref);
        if (completion && campaignDebit) await settleCurrentCampaignFunding(campaignDebit, completion.attestation);
      }
      throw error;
    }
    if (result.isErr()) {
      if (attempt) {
        const completion = await this.finishHarnessAttempt(attempt, {
          model: provider.getModel(), success: false, durationMs: Date.now() - startedAt,
          terminalReason: result.error.message,
        });
        if (completion && collector) collector.push(completion.ref);
        if (completion && campaignDebit) await settleCurrentCampaignFunding(campaignDebit, completion.attestation);
      }
      throw result.error;
    }
    const completion = await this.finishHarnessAttempt(attempt, {
      model: result.value.model,
      content: result.value.content,
      success: result.value.success,
      usage: result.value.usage,
      durationMs: Date.now() - startedAt,
      terminalReason: result.value.error,
    });
    if (completion && collector) collector.push(completion.ref);
    if (completion && campaignDebit) await settleCurrentCampaignFunding(campaignDebit, completion.attestation);
    return result.value;
  }

  private async *executeProviderStreamAttempt(
    provider: BaseProvider,
    req: ProviderRequest,
    phase: Extract<EligibilityPhase, 'pre-primary-transport' | 'pre-fallback-transport' | 'pre-retry-transport'>,
    fallbackOrdinal = 0,
    retryOrdinal = 0,
    collector?: ExecutorAttestationRef[],
  ): AsyncGenerator<StreamEvent> {
    const attempt = await this.beginHarnessAttempt(provider, req, phase, fallbackOrdinal, retryOrdinal);
    if (!attempt && hasCurrentCampaignFundingContext()) {
      throw new Error('CAMPAIGN_FUNDING_REQUIRES_CANONICAL_MODEL_ROLE');
    }
    const campaignActive = hasCurrentCampaignFundingContext();
    const transport = attempt && campaignActive ? provider.reserveTransport() : undefined;
    const campaignProfile = attempt && transport ? {
        executorRouteDigest: attempt.context.routeDigest,
        requestDigest: attempt.context.requestDigest,
        role: attempt.context.role,
        identity: attempt.context.resolvedIdentity,
        phase: attempt.context.phase, mode: 'stream' as const,
        attemptOrdinal: attempt.context.attemptOrdinal,
        fallbackOrdinal: attempt.context.fallbackOrdinal,
        retryOrdinal: attempt.context.retryOrdinal,
        maxInputTokens: Math.ceil((req.systemPrompt.length + req.userPrompt.length) / 4),
        maxOutputTokens: req.maxTokens ?? 0,
        baseUrl: transport.baseUrl,
        credentialDigest: transport.credentialDigest,
        transportProvider: transport.provider,
        transportModel: transport.model,
      } : undefined;
    let campaignDebit;
    try {
      const campaignProof = campaignProfile
        ? claimCurrentCampaignTransportProof(campaignProfile) : undefined;
      campaignDebit = campaignProfile && campaignProof
        ? await debitCurrentCampaignFunding({ ...campaignProfile, ...campaignProof }) : undefined;
    } catch (error) {
      if (transport) provider.cancelReservedTransport(transport);
      throw error;
    }
    if (!attempt) {
      yield* provider.stream(req);
      return;
    }
    const buffered: StreamEvent[] = [];
    const startedAt = Date.now();
    try {
      for await (const event of provider.stream(req, transport)) buffered.push(event);
    } catch (error) {
      const completion = await this.finishHarnessAttempt(attempt, {
        model: provider.getModel(), success: false,
        durationMs: Date.now() - startedAt,
        terminalReason: error instanceof Error ? error.message : String(error),
      });
      if (completion && collector) collector.push(completion.ref);
      if (completion && campaignDebit) await settleCurrentCampaignFunding(campaignDebit, completion.attestation);
      throw error;
    }
    const done = [...buffered].reverse().find(event => event.type === 'done');
    const failed = buffered.find(event => event.type === 'error');
    const completion = await this.finishHarnessAttempt(attempt, {
      model: provider.getModel(),
      content: buffered.filter(event => event.type === 'content')
        .map(event => event.content).join(''),
      success: failed === undefined,
      usage: done?.type === 'done' ? done.usage : undefined,
      durationMs: Date.now() - startedAt,
      terminalReason: failed?.type === 'error' ? failed.error : undefined,
    });
    if (completion && collector) collector.push(completion.ref);
    if (completion && campaignDebit) await settleCurrentCampaignFunding(campaignDebit, completion.attestation);
    for (const event of buffered) yield event;
  }

  /**
   * Determine if an error is a network/auth issue that warrants fallback.
   * Do NOT fallback on malformed responses — those are prompt/model issues.
   */
  private isFallbackableError(error: unknown): boolean {
    if (error instanceof LLMTimeoutError) return true;
    if (error instanceof LLMAuthError) return true;
    if (error instanceof LLMRateLimitError) return true;
    if (error instanceof LLMError) {
      // Network-level errors (connection refused, DNS failure, etc.)
      const msg = error.message.toLowerCase();
      if (msg.includes('econnrefused') || msg.includes('enotfound') ||
          msg.includes('econnreset') || msg.includes('fetch failed') ||
          msg.includes('network') || msg.includes('socket hang up')) {
        return true;
      }
      // Server errors (5xx) and HTTP 429 (createLLMHttpError raises a plain
      // LLMError for 429, not LLMRateLimitError, so a rate-limited or
      // quota-spent primary never reached its fallback seat).
      if (error.statusCode && (error.statusCode >= 500 || error.statusCode === 429)) return true;
    }
    if (error instanceof Error) {
      const msg = error.message.toLowerCase();
      if (msg.includes('econnrefused') || msg.includes('enotfound') ||
          msg.includes('econnreset') || msg.includes('fetch failed') ||
          msg.includes('network') || msg.includes('socket hang up')) {
        return true;
      }
    }
    return false;
  }

  // ── Circuit Breaker integration ──

  /**
   * Get or create circuit breaker for a provider
   */
  private getBreaker(provider: string): CircuitBreaker {
    if (!this.breakers.has(provider)) {
      this.breakers.set(provider, new CircuitBreaker({
        failureThreshold: 5,
        resetTimeoutMs: 30000,
        halfOpenMaxAttempts: 1,
      }));
    }
    return this.breakers.get(provider)!;
  }

  /**
   * Execute LLM call with circuit breaker protection
   * Prevents cascading failures when a provider is down
   */
  private async generateWithBreaker<T>(provider: string, fn: () => Promise<T>): Promise<T> {
    const breaker = this.getBreaker(provider);

    if (!breaker.canExecute()) {
      throw new LLMError(
        `Circuit breaker open for provider: ${provider}. Too many recent failures.`,
        provider,
        undefined,
        false
      );
    }

    try {
      const result = await fn();
      breaker.recordSuccess();
      return result;
    } catch (error) {
      // Only provider-health failures trip the breaker: timeouts, transport
      // errors and 5xx. Aborts, authority refusals, 4xx and model-declared
      // failures say nothing about whether the provider is up (#1423 bug 29).
      if (isBreakerFailure(error)) breaker.recordFailure();
      throw error;
    }
  }

  // ── Provider delegation ──

  /** Get or create the provider instance (async for DNS-based SSRF validation) */
  private async getProvider(): Promise<BaseProvider> {
    if (!this.provider) {
      // SSRF validation on base URL before creating provider.
      // Local LLM providers are explicit first-class provider endpoints; keep
      // arbitrary private IPs gated, but do not make LM Studio/Ollama require
      // an extra env escape hatch for normal localhost use.
      const allowLocalhost = process.env.LIMINAL_ALLOW_LOCALHOST_LLM === 'true' || this.isKnownLocalLlmEndpoint();
      const allowPrivateIPs = process.env.LIMINAL_ALLOW_PRIVATE_IP_LLM === 'true';
      const allowedHosts = getAllowedHostsFromEnv();

      // These allowlisted endpoints invoke local subscription CLIs, not HTTP.
      // Rotation may append the OpenAI-compatible path to the CLI address.
      const localCli = /^cli:\/\/(?:codex|agy|command-code|claude|grok)$/.test(
        canonicalCliSeatUrl(this.config.baseUrl).replace(/^(cli:\/\/grok)\/chat\/completions$/, '$1')
      ) || parseHermesSeat(this.config.baseUrl) !== null;
      if (!localCli && !this.config.baseUrl.startsWith('grok-cli:')) {
        try {
          await validateUrl(this.config.baseUrl, { allowedHosts, allowPrivateIPs, allowLocalhost });
        } catch (err) {
          if (err instanceof SSRFError) {
            throw new LLMError(`SSRF Protection: ${err.message}`, 'llm', undefined, false);
          }
          throw err;
        }
      }

      const timeoutMs = this.config.timeout ?? TIMEOUT_DEFAULT_MS;
      this.provider = createProvider({
        baseUrl: this.config.baseUrl,
        logicalProvider: this.config.provider,
        minimaxTokenPlanSeat: this.config.minimaxTokenPlanSeat === true,
        apiKey: this.config.apiKey,
        model: this.config.model,
        temperature: this.config.temperature,
        maxTokens: this.config.maxTokens,
        timeout: timeoutMs,
        headers: this.config.headers,
      });
    }
    return this.provider;
  }

  private isKnownLocalLlmEndpoint(): boolean {
    let hostname = '';
    let port = '';
    try {
      const u = new URL(this.config.baseUrl);
      hostname = u.hostname.toLowerCase();
      port = u.port || (u.protocol === 'https:' ? '443' : '80');
    } catch {
      return false;
    }
    const isLoopback = hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
    if (!isLoopback) return false;
    // Local OpenAI-compatible proxies used by rotation/dogfood (cliproxy :8317)
    // and classic local inference ports. detectProvider() labels :8317 as "custom",
    // so LM Studio/Ollama-only checks were SSRF-blocking real cliproxy wave packs.
    if (port === '8317' || port === '8318' || port === '1234' || port === '11434' || port === '8080') {
      return true;
    }
    // The operator's declared local provider counts on loopback, whatever the port.
    const declared = this.config.provider ?? env('LLM_PROVIDER');
    if (declared === 'lmstudio' || declared === 'ollama') return true;
    const provider = this.detectProvider();
    return provider === Provider.LMSTUDIO || provider === Provider.OLLAMA;
  }

  private providerEndpoint(baseUrl = this.config.baseUrl, model = this.config.model): string {
    return transportEndpoint({ baseUrl, model });
  }

  private requestProvenanceForProvider(
    provider: BaseProvider,
    fallback?: Pick<LLMRequestProvenance, 'fallbackUsed' | 'fallbackFrom'>,
  ): LLMRequestProvenance {
    const config = provider.getConfig();
    const providerName = provider.name;
    const model = provider.getModel();
    return {
      provider: providerName,
      model,
      endpoint: this.providerEndpoint(config.baseUrl, model),
      endpointStyle: apiStyleForEndpoint(config.baseUrl),
      fallbackUsed: fallback?.fallbackUsed ?? false,
      fallbackFrom: fallback?.fallbackFrom,
      fallbackTo: fallback?.fallbackUsed ? `${providerName}:${model}` : undefined,
    };
  }

  /** (from,to) pairs already announced, so repeated fallbacks don't spam stderr. */
  private readonly emittedFallbackNotices = new Set<string>();

  /**
   * One user-facing stderr line when a runtime fallback provider actually wins.
   * Logger.info stays for operators; this is the charting-decision D2 surface.
   * Emitted at most once per (from,to) pair per client.
   */
  private emitFallbackNotice(from: string, to: string, endpoint?: string): void {
    const key = `${from}→${to}`;
    if (this.emittedFallbackNotices.has(key)) return;
    this.emittedFallbackNotices.add(key);
    const endpointPart = endpoint ? ` @ ${endpoint}` : '';
    // eslint-disable-next-line no-console -- intentional user-facing config notice
    console.error(`[config] fallback: requested ${from} → resolved ${to}${endpointPart} (fallback beats requested)`);
  }

  private currentRequestProvenance(): LLMRequestProvenance {
    return {
      provider: this.detectProvider(),
      model: this.config.model,
      endpoint: this.providerEndpoint(),
      endpointStyle: apiStyleForEndpoint(this.config.baseUrl),
      fallbackUsed: false,
    };
  }

  /** Detect provider name from baseUrl or model for logging */
  private detectProvider(): string {
    if (this.config.baseUrl.startsWith('grok-cli:')) return 'grok-cli';
    // A Hermes seat names its provider in the path: cli://hermes/<provider>/<reasoning>.
    const hermesSeat = /^cli:\/\/hermes\/([a-z0-9-]+)\//.exec(this.config.baseUrl);
    if (hermesSeat) return `hermes:${hermesSeat[1]}`;
    const model = this.config.model.toLowerCase();
    const provider = detectProviderLabel(this.config.baseUrl, this.config.model);

    if (provider !== 'llm' && provider !== 'unknown') return provider;

    const baseUrl = this.config.baseUrl.toLowerCase();
    if (baseUrl.includes('anthropic')) return 'anthropic';
    if (model.includes('qwen')) return Provider.LMSTUDIO;
    if (model.includes('llama')) return Provider.OLLAMA;
    if (model.includes('gemma') || model.includes('mistral')) return 'local';

    return 'local';
  }

  /** Host only (no path/key) for operator host-per-call logs (W1-F03). */
  private endpointHostForTelemetry(): string | null {
    const base = this.config.baseUrl;
    if (!base || typeof base !== 'string') return null;
    try {
      return new URL(base).host || null;
    } catch {
      return base.replace(/^https?:\/\//, '').split('/')[0] || null;
    }
  }

  // ── Cache management ──

  /** Enable response caching */
  enableCache(options?: { ttlMs?: number; maxEntries?: number }): void {
    this.cache = new CacheManager({ enabled: true, ...options });
  }

  /** Clear the LLM response cache */
  clearCache(): void {
    this.cache = new CacheManager({ enabled: false });
    this.enableCache();
  }

  /** Disable caching entirely */
  disableCache(): void {
    this.cache = new CacheManager({ enabled: false });
  }

  /** Get cache statistics */
  getCacheStats(): { size: number; enabled: boolean } {
    return {
      size: this.cache.size,
      enabled: this.cache.enabled,
    };
  }

  /** Get current config */
  getConfig(): LLMConfig {
    return { ...this.config };
  }

  /**
   * Get config with sensitive fields redacted
   * Safe for logging
   */
  getSafeConfig(): LLMConfig {
    const config = this.getConfig();
    return {
      ...config,
      apiKey: config.apiKey ? '[REDACTED]' : undefined,
    };
  }

  private resolvedModel: string | null = null;
  private resolveModelPromise: Promise<string> | null = null;

  /** Auto-detect model from LM Studio /v1/models endpoint */
  private async resolveModel(): Promise<string> {
    if (this.resolvedModel) return this.resolvedModel;

    // Race-safe lazy initialization: only first caller creates the promise
    if (!this.resolveModelPromise) {
      this.resolveModelPromise = this.doResolveModel();
    }

    return this.resolveModelPromise;
  }

  /**
   * Resolve and apply the effective model before a visible run starts.
   * Operator surfaces use this to avoid showing local placeholders after the
   * client has enough evidence to name the loaded LM Studio model.
   */
  async resolveEffectiveModel(): Promise<string> {
    const resolvedModel = await this.resolveModel();
    this.syncResolvedModel(resolvedModel);
    return resolvedModel;
  }

  private async doResolveModel(): Promise<string> {
    await this.resolveRoleConfigForRequest();

    // Only auto-detect for local endpoints (LM Studio, etc.)
    const baseUrl = this.config.baseUrl;
    const isLocal = baseUrl.includes('localhost') || baseUrl.includes('127.0.0.1');
    const shouldAutoDetectLocalModel = this.shouldAutoDetectLocalModel(baseUrl, this.config.model);

    if (!isLocal) {
      this.resolvedModel = this.config.model;
      return this.resolvedModel;
    }

    try {
      const response = await this.fetchLocalModels(baseUrl);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);

      const data = await response.json() as { data?: Array<{ id: string }> };
      const models = data.data || [];

      if (!shouldAutoDetectLocalModel) {
        const modelIds = new Set(models.map(model => model.id));
        if (models.length > 0 && !modelIds.has(this.config.model)) {
          Logger.info('LLMClient', `Configured local model not advertised by /models; preserving explicit model: ${this.config.model}`);
        }
        this.resolvedModel = this.config.model;
        return this.resolvedModel;
      }

      if (models.length > 0) {
        // "auto" and the legacy LM Studio GUI placeholder both mean:
        // use a model the local server reports as actually loaded.
        this.resolvedModel = this.config.model === LEGACY_LM_STUDIO_MODEL_PLACEHOLDER
          ? this.selectBestLocalModel(models)
          : models[0].id;
        Logger.info('LLMClient', `Auto-detected model: ${this.resolvedModel}`);
        return this.resolvedModel;
      }
    } catch (err) {
      Logger.info('LLMClient', `Auto-detect failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    if (shouldAutoDetectLocalModel) {
      throw new LLMError(
        `No LLM model detected at ${baseUrl}/models. Set ANTHROPIC_API_KEY to use the Anthropic API (Claude), run "sinter --configure", or set SINTER_LLM_BASE_URL and SINTER_LLM_MODEL for a custom endpoint.`,
        this.detectProvider(),
        undefined,
        false,
      );
    }

    this.resolvedModel = this.config.model;
    Logger.info('LLMClient', `Using configured fallback model: ${this.resolvedModel}`);
    return this.resolvedModel;
  }

  private shouldAutoDetectLocalModel(baseUrl: string, model: string): boolean {
    if (model === SERVICE_DEFAULTS.DEFAULT_MODEL) return true;
    return model === LEGACY_LM_STUDIO_MODEL_PLACEHOLDER && detectProviderLabel(baseUrl, model) === 'lmstudio';
  }

  private selectBestLocalModel(models: Array<{ id: string }>): string {
    const ranked = [...models].sort((a, b) => this.scoreLocalModel(b.id) - this.scoreLocalModel(a.id));
    return ranked[0]?.id || models[0].id;
  }

  private scoreLocalModel(modelId: string): number {
    const id = modelId.toLowerCase();
    let score = 0;

    // LM Studio may list old tiny helper models before the production model.
    // Visible GUI runs using the legacy placeholder should prefer capable,
    // code-oriented loaded models while avoiding embedding/test/draft entries.
    const explicitBillions = id.match(/(?:^|[^a-z0-9])(\d+(?:\.\d+)?)\s*b(?:[^a-z0-9]|$)/i);
    const compactQwenSize = id.match(/qwen\s*[-_ ]?(\d{2})(?![\d.])/i);
    const size = explicitBillions?.[1]
      ? Number(explicitBillions[1])
      : compactQwenSize?.[1]
        ? Number(compactQwenSize[1])
        : 0;
    score += size * 10;

    if (/\b(code|coder|coding|repo|pipeline|prod|instruct|chat)\b/.test(id)) score += 30;
    if (/\b(qwen|llama|mistral|gemma|glm|gpt)\b/.test(id)) score += 10;
    if (/\b(embed|embedding|rerank|election|draft|test)\b/.test(id)) score -= 20;
    if (/\b(0\.\d+|1|2)\s*b\b/.test(id)) score -= 10;

    return score;
  }

  private async fetchLocalModels(baseUrl: string): Promise<Response> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), LOCAL_MODEL_DETECT_TIMEOUT_MS);
    try {
      return await fetch(`${baseUrl}/models`, { signal: controller.signal });
    } finally {
      clearTimeout(timeout);
    }
  }

  /** Sync resolved model back to config and provider */
  private syncResolvedModel(resolvedModel: string): void {
    if (resolvedModel !== this.config.model) {
      this.config.model = resolvedModel;
      // Update provider if already created
      if (this.provider) {
        this.provider.setModel(resolvedModel);
      }
    }
  }

  // ── Core generation ──

  /**
   * Generate code from prompts
   * Universal interface - works with any provider via ProviderFactory
   */
  async generate(
    systemPrompt: string,
    userPrompt: string,
    signal?: AbortSignal,
    bypassCache?: boolean,
    imageInputs?: ProviderImageInput[],
    opts?: { jsonMode?: boolean; maxTokens?: number },
  ): Promise<LLMResponse> {
    await this.resolveRoleConfigForRequest();
    this.startExecutorAttemptSequence();
    this.assertHarnessAuthorityBeforeResolution();
    const llmStartTime = Date.now();
    systemPrompt = normalizeSystemPrompt(systemPrompt);
    // Auto-detect model on first use (for local endpoints like LM Studio)
    const resolvedModel = await this.resolveModel();
    this.syncResolvedModel(resolvedModel);
    assertGenerativeModel(resolvedModel);

    // Drop image input for text-only models. Without this, sending a rendered
    // screenshot to a text-only model (e.g. a local qwen via LiteLLM, or any
    // non-vision evaluator) fails with "image input is not supported". The
    // caller then scores from code/text instead of the screenshot. The drop is
    // LOUD: a degradation record on the failure channel plus a warn log, so a
    // text-only evaluator can never silently masquerade as visual evaluation.
    if (imageInputs && imageInputs.length > 0 && !CapabilityRegistry.supportsVision(resolvedModel)) {
      const dropReason = `Model ${resolvedModel} is not vision-capable; dropped ${imageInputs.length} image input(s) and proceeded text-only. Visual evidence was NOT seen by the model.`;
      Logger.warn('LLMClient', `[vision-degraded] ${dropReason}`);
      failureLogger.log({
        model: resolvedModel,
        provider: this.detectProvider(),
        domain: 'unknown', // Determined by caller context; LLMClient only sees prompts
        prompt: userPrompt.slice(0, TRUNCATE_LONG),
        error: `[vision-degraded] ${dropReason}`,
        errorType: 'degraded',
        duration: 0,
      });
      // Additive eval.verdict lane (#400) for vision degradation.
      const visionRefs = imageInputs
        .map((img, index) => {
          const labeled = img as { path?: string; label?: string; mimeType?: string };
          if (typeof labeled.path === 'string' && labeled.path.length > 0) return labeled.path;
          if (typeof labeled.label === 'string' && labeled.label.length > 0) return labeled.label;
          return `image-input:${index}:${labeled.mimeType ?? 'unknown'}`;
        });
      void recordEvent({
        event: 'eval.verdict',
        model: resolvedModel,
        provider: this.detectProvider(),
        role: 'evaluator',
        runId: null,
        episodeId: null,
        domain: 'unknown',
        inputHash: null,
        verdict: 'vision-degraded',
        latencyMs: 0,
        costUsd: null,
        evidenceRefs: visionRefs,
        payload: {
          // score/confidence omitted when unknown — same optional shape as other producers
          failureClass: 'scorer',
          degraded: true,
          reason: 'vision-degraded',
          visionEvidenceRefs: visionRefs,
        },
      }).catch(err => {
        Logger.warn('LLMClient', 'Failed to record eval.verdict event:', err instanceof Error ? err.message : err);
      });
      imageInputs = undefined;
    }

    try {
      // Check cache
      const hasImages = !!(imageInputs && imageInputs.length > 0);
      const cacheScope = JSON.stringify([this.detectProvider(), this.config.baseUrl ?? '', resolvedModel,
        opts?.jsonMode ?? false, opts?.maxTokens ?? null]);
      const cached = this.role === 'harness' || bypassCache || hasImages ? null : this.cache.get(systemPrompt, userPrompt, cacheScope);
      if (cached) {
        return { code: cached, success: true, fromCache: true, provenance: this.currentRequestProvenance() };
      }

      eventBus.emit(EventTypes.LLM_REQUEST, 'LLMClient', {
        provider: this.detectProvider(),
        model: this.config.model,
        promptPreview: userPrompt.slice(0, TRUNCATE_SHORT)
      });

      const providerName = this.detectProvider();
      let primaryAttemptOrdinal = 0;
      const executorAttestations: ExecutorAttestationRef[] = [];

      // The breaker wraps the retry loop, so one logical request counts as at
      // most one breaker failure however many retries it spent (#1423 bug 6).
      const result = await this.generateWithBreaker(providerName, () => RetryManager.executeWithRetry(async () => {
          const provider = await this.getProvider();
          const req: ProviderRequest = {
            systemPrompt,
            userPrompt,
            temperature: this.config.temperature,
            maxTokens: opts?.maxTokens ?? this.config.maxTokens,
            thinking: this.config.thinking,
            signal,
            imageInputs,
            jsonMode: opts?.jsonMode,
          };

        const retryOrdinal = primaryAttemptOrdinal++;
        const response = await this.executeProviderAttempt(provider, req,
          retryOrdinal === 0 ? 'pre-primary-transport' : 'pre-retry-transport', 0, retryOrdinal, executorAttestations);
        if (!response.success) {
          // A provider-declared failure is deterministic unless its text names
          // a transient network fault; retrying it only burns backoff (#1423 bug 30).
          throw new LLMError(
            response.error || 'Provider returned unsuccessful response',
            provider.name,
            undefined,
            isTransientNetworkError(response.error ?? ''),
            {
              model: provider.getModel(),
              endpoint: this.providerEndpoint(provider.getConfig().baseUrl, provider.getModel()),
              responseBody: response.error,
            },
          );
        }
        return {
          ...this.mapProviderResponse(response),
          provenance: this.requestProvenanceForProvider(provider),
        };
      }, { signal })).catch(async (primaryError: unknown) => {
        // Only attempt fallbacks on network/auth errors
        if (!this.isFallbackableError(primaryError)) {
          throw primaryError;
        }

        const fallbacks = this.getFallbackProviders();
        if (fallbacks.length === 0) {
          throw primaryError;
        }

        Logger.info('LLMClient.fallback',
          `Primary provider failed (${primaryError instanceof Error ? primaryError.message : 'unknown'}), trying ${fallbacks.length} fallback(s)`);

        const req: ProviderRequest = {
          systemPrompt,
          userPrompt,
          temperature: this.config.temperature,
          maxTokens: opts?.maxTokens ?? this.config.maxTokens,
          thinking: this.config.thinking,
          signal,
          imageInputs,
          jsonMode: opts?.jsonMode,
        };

        const fallbackFailures: string[] = [];
        for (const [fallbackIndex, fallback] of fallbacks.entries()) {
          try {
            Logger.info('LLMClient.fallback', `Trying fallback: ${fallback.getModel()}`);
            const fbResponse = await this.executeProviderAttempt(fallback, req, 'pre-fallback-transport', fallbackIndex + 1, 0, executorAttestations);
            // P0 (K3 audit): a provider Ok with success===false is a fake-success
            // response. Fail closed into the catch below, which records the reason
            // in fallbackFailures and tries the next provider — mirrors the primary
            // path (above) and complete()'s fallback guard.
            if (!fbResponse.success) {
              throw new LLMError(
                fbResponse.error || 'Provider returned unsuccessful response',
                fallback.name,
                undefined,
                false,
                {
                  model: fallback.getModel(),
                  endpoint: this.providerEndpoint(fallback.getConfig().baseUrl, fallback.getModel()),
                  responseBody: fbResponse.error,
                },
              );
            }
            const mapped = this.mapProviderResponse(fbResponse);
            Logger.info('LLMClient.fallback', `Fallback succeeded: ${fallback.getModel()}`);
            const fallbackFrom = `${this.detectProvider()}:${this.config.model}`;
            const provenance = this.requestProvenanceForProvider(fallback, {
              fallbackUsed: true,
              fallbackFrom,
            });
            this.emitFallbackNotice(
              fallbackFrom,
              `${provenance.provider}:${provenance.model}`,
              fallback.getConfig().baseUrl,
            );
            return {
              ...mapped,
              provenance,
            };
          } catch (fallbackErr) {
            fallbackFailures.push(this.formatFallbackFailure(fallback.getModel(), fallbackErr));
            Logger.info('LLMClient.fallback',
              `Fallback ${fallback.getModel()} failed: ${fallbackErr instanceof Error ? fallbackErr.message : 'unknown'}`);
            continue;
          }
        }

        // All fallbacks exhausted — preserve the primary error and add fallback provenance.
        throw this.withFallbackDiagnostics(primaryError, fallbackFailures);
      });

      // Write to cache on success
      if (result.success && result.code && !bypassCache && !hasImages) {
        this.cache.set(systemPrompt, userPrompt, result.code, cacheScope);
      }

      eventBus.emit(EventTypes.LLM_RESPONSE, 'LLMClient', {
        provider: this.detectProvider(),
        model: this.config.model,
        // W1-F03 / host-per-call: operator logs must show which role+host answered
        role: this.role ?? null,
        endpointHost: this.endpointHostForTelemetry(),
        baseUrl: this.config.baseUrl ?? null,
        success: true,
        latencyMs: Date.now() - llmStartTime,
        reasoningTraceId: result.reasoningTraceId,
        thinkingSource: result.thinkingSource,
        reasoningQuality: result.reasoningQuality,
        reasoningLength: result.reasoning?.length ?? result.thinking?.length,
        detectedPatterns: result.detectedPatterns,
        recoveredFromThinking: result.recoveredFromThinking,
      });

      return { ...result, executorAttestations };
    } catch (error) {
      // Synthetic aborts can be Errors with an empty .message — fall through
      // to String(error) so telemetry never reads "err: undefined" (audit F21).
      const errMsg = (error instanceof Error && error.message) ? error.message : String(error ?? 'Unknown error');
      const isRetryable = error instanceof LLMError && error.retryable;
      Logger.error('LLMClient', 'LLMClient.generate failed:', errMsg, isRetryable ? '(retryable, retries exhausted)' : '');
      eventBus.emit(EventTypes.LLM_RESPONSE, 'LLMClient', {
        provider: this.detectProvider(),
        model: this.config.model,
        role: this.role ?? null,
        endpointHost: this.endpointHostForTelemetry(),
        baseUrl: this.config.baseUrl ?? null,
        success: false,
        latencyMs: Date.now() - llmStartTime,
        error: errMsg
      });

      // Log failure to Meta-Harness for pattern detection
      failureLogger.log({
        model: this.config.model,
        domain: 'unknown', // Will be determined by caller context
        prompt: userPrompt.slice(0, TRUNCATE_LONG), // Truncate for privacy/size
        error: errMsg,
        errorType: error instanceof LLMTimeoutError ? 'timeout' :
                   error instanceof LLMAuthError ? 'validation' : 'generation',
        duration: Date.now() - llmStartTime,
      });

      const provenance = compactLLMErrorProvenance(
        extractLLMErrorProvenance(error),
        {
          provider: this.detectProvider(),
          model: this.config.model,
          endpoint: this.providerEndpoint(),
          endpointStyle: apiStyleForEndpoint(this.config.baseUrl),
          fallbackUsed: false,
          errorSource: 'client',
          retryable: isRetryable,
        },
      );

      throw new LLMGenerationError(`LLM generation failed: ${errMsg}`, {
        cause: error instanceof Error ? error : undefined,
        model: provenance.model,
        provider: provenance.provider,
        endpoint: provenance.endpoint,
        endpointStyle: provenance.endpointStyle,
        fallbackUsed: provenance.fallbackUsed,
        fallbackFrom: provenance.fallbackFrom,
        fallbackTo: provenance.fallbackTo,
        errorSource: provenance.errorSource,
        statusCode: provenance.statusCode,
        retryable: provenance.retryable,
        responseBody: provenance.responseBody,
        duration: Date.now() - llmStartTime,
      });
    }
  }

  async generateWithImages(
    systemPrompt: string,
    userPrompt: string,
    imageInputs: ProviderImageInput[],
    signal?: AbortSignal,
    bypassCache = true,
    opts?: { jsonMode?: boolean; maxTokens?: number },
  ): Promise<LLMResponse> {
    return this.generate(systemPrompt, userPrompt, signal, bypassCache, imageInputs, opts);
  }

  async generateP5Sketch(prompt: string, context?: string, signal?: AbortSignal, bypassCache?: boolean): Promise<LLMResponse> {
    const promptTier = resolvePromptTier(this.config.model, detectProviderFromUrl(this.config.baseUrl));
    const simplifiedSystem = `You are a creative coder specializing in p5.js.

<rules>
- Output raw JavaScript only
- Use function setup() and function draw()
- Include createCanvas()
- No markdown fences or explanations
</rules>`;

    const simplifiedUser = [
      '<request>',
      `Create a p5.js sketch: ${prompt}`,
      '</request>',
      context ? `<context>\n${context}\n</context>` : '',
    ].filter(Boolean).join('\n');

    const rendered = PromptLibrary.render('p5.generate', { prompt, context: context || '' });
    return this.generate(
      tiered({ full: rendered.system, compact: simplifiedSystem }, promptTier),
      tiered({ full: rendered.user, compact: simplifiedUser }, promptTier),
      signal,
      bypassCache,
    );
  }

  async improveP5Sketch(currentCode: string): Promise<LLMResponse> {
    const rendered = PromptLibrary.render('p5.improve', { code: currentCode });
    return this.generate(rendered.system, rendered.user);
  }

  /** Check if LLM is configured */
  static isConfigured(): boolean {
    const configuredProviderKey = PROVIDER_ORDER.some(provider => firstUsableApiKey(
      ...apiKeyEnvNamesForProvider(provider).map(key => readRuntimeEnv(process.env, key)),
    ));
    const hasExplicitConfig = !!(env('LLM_BASE_URL') || env('LLM_API_KEY') || configuredProviderKey);
    if (hasExplicitConfig) return true;
    // In test environments, don't treat the hardcoded default local URL as configured,
    // otherwise E2E tests try to call a non-existent localhost endpoint and timeout.
    return process.env.NODE_ENV !== 'test' && !!SERVICE_DEFAULTS.LOCAL_LLM_URL;
  }

  /**
   * Raw completion interface for agent/conversation mode
   * Returns raw text response for multi-turn conversations
   */
  async complete(options: {
    prompt: string;
    systemPrompt?: string;
    maxTokens?: number;
    temperature?: number;
    signal?: AbortSignal;
    jsonMode?: boolean;
    imageInputs?: ProviderImageInput[];
  }): Promise<LLMCompleteResult> {
    this.startExecutorAttemptSequence();
    try {
      await this.resolveRoleConfigForRequest();
      this.assertHarnessAuthorityBeforeResolution();
    } catch (error) {
      return {
        text: '',
        success: false,
        error: error instanceof Error ? error.message : String(error),
        provider: this.detectProvider(),
        model: this.config.model,
        endpoint: this.providerEndpoint(),
        endpointStyle: apiStyleForEndpoint(this.config.baseUrl),
        fallbackUsed: false,
        errorSource: 'client',
        retryable: false,
      };
    }
    const {
      prompt,
      systemPrompt: systemPromptRaw,
      maxTokens = TOKEN_LIMIT_XL,
      temperature = 0.7,
      signal,
      jsonMode,
      imageInputs,
    } = options;
    // Explicit empty string must not bypass default — providers 400 on empty system content
    // (Wave 4: K3 via Kilo — "system message must have content").
    const systemPrompt = normalizeSystemPrompt(systemPromptRaw);

    // Auto-detect model on first use (for local endpoints like LM Studio)
    const resolvedModel = await this.resolveModel();
    this.syncResolvedModel(resolvedModel);
    assertGenerativeModel(resolvedModel);

    // Same guard as generate(): text-only models must not receive image
    // input or the provider call fails outright. The caller (e.g. the
    // harness agent) is responsible for loud degradation logging.
    let effectiveImageInputs = imageInputs;
    if (effectiveImageInputs && effectiveImageInputs.length > 0 && !CapabilityRegistry.supportsVision(resolvedModel)) {
      Logger.debug('LLMClient', `Model ${resolvedModel} is text-only; dropping ${effectiveImageInputs.length} image input(s) and proceeding text-only.`);
      effectiveImageInputs = undefined;
    }

    const startTime = Date.now();
    const executorAttestations: ExecutorAttestationRef[] = [];

    try {
      eventBus.emit(EventTypes.LLM_REQUEST, 'LLMClient', {
        provider: this.detectProvider(),
        model: this.config.model,
        method: 'complete',
        promptPreview: systemPrompt?.slice(0, 100),
      });

      let primaryAttemptOrdinal = 0;
      const result = await RetryManager.executeWithRetry(async () => {
        const provider = await this.getProvider();
        const req: ProviderRequest = {
          systemPrompt,
          userPrompt: prompt,
          temperature,
          maxTokens,
          thinking: this.config.thinking,
          signal,
          jsonMode,
          imageInputs: effectiveImageInputs,
        };

        const retryOrdinal = primaryAttemptOrdinal++;
        const response = await this.executeProviderAttempt(provider, req,
          retryOrdinal === 0 ? 'pre-primary-transport' : 'pre-retry-transport', 0, retryOrdinal, executorAttestations);

        if (!response.success) {
          throw new LLMError(
            response.error || 'Provider returned unsuccessful response',
            provider.name,
            undefined,
            false,
            {
              model: provider.getModel(),
              endpoint: this.providerEndpoint(provider.getConfig().baseUrl, provider.getModel()),
              responseBody: response.error,
            },
          );
        }

        return {
          text: response.content,
          success: true as const,
          provider: provider.name,
          model: provider.getModel(),
          endpoint: this.providerEndpoint(provider.getConfig().baseUrl, provider.getModel()),
          endpointStyle: apiStyleForEndpoint(provider.getConfig().baseUrl),
          fallbackUsed: false,
          provenance: this.requestProvenanceForProvider(provider),
          usage: response.usage,
        };
      }, { signal }).catch(async (primaryError: unknown) => {
        if (!this.isFallbackableError(primaryError)) {
          throw primaryError;
        }

        const fallbacks = this.getFallbackProviders();
        if (fallbacks.length === 0) {
          throw primaryError;
        }

        Logger.info('LLMClient.fallback',
          `complete(): primary failed, trying ${fallbacks.length} fallback(s)`);

        const req: ProviderRequest = {
          systemPrompt,
          userPrompt: prompt,
          temperature,
          maxTokens,
          thinking: this.config.thinking,
          signal,
          imageInputs: effectiveImageInputs,
        };

        const fallbackFailures: string[] = [];
        for (const [fallbackIndex, fallback] of fallbacks.entries()) {
          try {
            Logger.info('LLMClient.fallback', `complete() trying fallback: ${fallback.getModel()}`);
            const fbResponse = await this.executeProviderAttempt(fallback, req, 'pre-fallback-transport', fallbackIndex + 1, 0, executorAttestations);
            if (fbResponse.success) {
              Logger.info('LLMClient.fallback', `complete() fallback succeeded: ${fallback.getModel()}`);
              const fallbackFrom = `${this.detectProvider()}:${this.config.model}`;
              const provenance = this.requestProvenanceForProvider(fallback, {
                fallbackUsed: true,
                fallbackFrom,
              });
              this.emitFallbackNotice(
                fallbackFrom,
                `${provenance.provider}:${provenance.model}`,
                fallback.getConfig().baseUrl,
              );
              return {
                text: fbResponse.content,
                success: true as const,
                provider: provenance.provider,
                model: provenance.model,
                endpoint: provenance.endpoint,
                endpointStyle: provenance.endpointStyle,
                fallbackUsed: provenance.fallbackUsed,
                fallbackFrom: provenance.fallbackFrom,
                fallbackTo: provenance.fallbackTo,
                provenance,
                usage: fbResponse.usage,
              };
            }
          } catch (err) {
            fallbackFailures.push(this.formatFallbackFailure(fallback.getModel(), err));
            Logger.debug('LLMClient', 'Fallback provider failed in complete():', err);
            continue;
          }
        }

        throw this.withFallbackDiagnostics(primaryError, fallbackFailures);
      });

      eventBus.emit(EventTypes.LLM_RESPONSE, 'LLMClient', {
        provider: this.detectProvider(),
        model: this.config.model,
        role: this.role ?? null,
        endpointHost: this.endpointHostForTelemetry(),
        baseUrl: this.config.baseUrl ?? null,
        method: 'complete',
        success: true,
        duration: Date.now() - startTime,
      });

      return { ...result, executorAttestations };
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : 'Unknown error';
      const isRetryable = error instanceof LLMError ? error.retryable : undefined;
      const provenance = compactLLMErrorProvenance(
        extractLLMErrorProvenance(error),
        {
          provider: this.detectProvider(),
          model: this.config.model,
          endpoint: this.providerEndpoint(),
          endpointStyle: apiStyleForEndpoint(this.config.baseUrl),
          fallbackUsed: false,
          errorSource: 'client',
          retryable: isRetryable,
        },
      );
      eventBus.emit(EventTypes.LLM_RESPONSE, 'LLMClient', {
        provider: provenance.provider,
        model: provenance.model,
        role: this.role ?? null,
        endpointHost: this.endpointHostForTelemetry(),
        baseUrl: this.config.baseUrl ?? null,
        endpoint: provenance.endpoint,
        statusCode: provenance.statusCode,
        endpointStyle: provenance.endpointStyle,
        fallbackUsed: provenance.fallbackUsed,
        fallbackFrom: provenance.fallbackFrom,
        fallbackTo: provenance.fallbackTo,
        errorSource: provenance.errorSource,
        retryable: provenance.retryable,
        method: 'complete',
        success: false,
        duration: Date.now() - startTime,
        error: errMsg,
      });
      return {
        text: '',
        success: false,
        error: errMsg,
        provider: provenance.provider,
        model: provenance.model,
        endpoint: provenance.endpoint,
        endpointStyle: provenance.endpointStyle,
        fallbackUsed: provenance.fallbackUsed,
        fallbackFrom: provenance.fallbackFrom,
        fallbackTo: provenance.fallbackTo,
        errorSource: provenance.errorSource,
        statusCode: provenance.statusCode,
        retryable: provenance.retryable,
        responseBody: provenance.responseBody,
        provenance,
        executorAttestations: executorAttestations,
      };
    }
  }

  /**
   * Generate with native tool calling support.
   * Returns structured tool calls instead of JSON-in-text parsing.
   */
  async generateWithTools(options: {
    systemPrompt: string;
    userPrompt: string;
    tools: import('./ProviderTypes.js').ToolDefinition[];
    toolResults?: import('./ProviderTypes.js').ToolResultMessage[];
    maxTokens?: number;
    temperature?: number;
    signal?: AbortSignal;
    jsonMode?: boolean;
  }): Promise<{
    content: string;
    toolCalls?: import('./ProviderTypes.js').ToolCallResult[];
    finishReason?: string;
    success: boolean;
    error?: string;
    provenance?: LLMRequestProvenance;
    usage?: TokenUsage;
    executorAttestations?: readonly ExecutorAttestationRef[];
  }> {
    await this.resolveRoleConfigForRequest();
    this.startExecutorAttemptSequence();
    this.assertHarnessAuthorityBeforeResolution();
    const resolvedModel = await this.resolveModel();
    this.syncResolvedModel(resolvedModel);
    const systemPrompt = normalizeSystemPrompt(options.systemPrompt);
    const executorAttestations: ExecutorAttestationRef[] = [];

    try {
      const provider = await this.getProvider();

      // Only use native tools if the provider supports them
      if (!provider.supportsToolUse()) {
        // Fall back to text-based tool calling
        const result = await this.complete({
          prompt: options.userPrompt,
          systemPrompt,
          maxTokens: options.maxTokens,
          temperature: options.temperature,
          signal: options.signal,
          jsonMode: options.jsonMode,
        });
        return {
          content: result.text,
          success: result.success,
          error: result.error,
          finishReason: 'stop',
          provenance: result.provenance,
          usage: result.usage,
          executorAttestations: [...executorAttestations, ...(result.executorAttestations ?? [])],
        };
      }

      const req: ProviderRequest = {
        systemPrompt,
        userPrompt: options.userPrompt,
        tools: options.tools,
        toolResults: options.toolResults,
        temperature: options.temperature ?? this.config.temperature,
        maxTokens: options.maxTokens ?? this.config.maxTokens,
        thinking: this.config.thinking,
        signal: options.signal,
        jsonMode: options.jsonMode,
      };

      const response = await this.executeProviderAttempt(provider, req, 'pre-primary-transport', 0, 0, executorAttestations);

      return {
        content: response.content,
        toolCalls: response.toolCalls,
        finishReason: response.finishReason,
        success: response.success,
        error: response.error,
        provenance: this.requestProvenanceForProvider(provider),
        usage: response.usage,
        executorAttestations,
      };
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : 'Unknown error';
      return {
        content: '',
        success: false,
        error: errMsg,
        finishReason: 'error',
        // Provider throw / Err terminal paths still bind their signed completion
        // ref via executeProviderAttempt's collector — surface them on the typed
        // failure so the ledger can bind the terminal receipt (#717 / W8C-04).
        executorAttestations,
      };
    }
  }

  /**
   * Agentic tool-calling loop. Calls generateWithTools() in a cycle:
   * generate -> if tool calls, execute them -> feed results back -> repeat.
   * Stops when the model returns content (no tool calls) or max iterations reached.
   */
  async generateWithToolLoop(options: {
    systemPrompt: string;
    userPrompt: string;
    tools: import('./ProviderTypes.js').ToolDefinition[];
    toolExecutor: (name: string, args: Record<string, unknown>) => Promise<string>;
    maxIterations?: number;
    maxTokens?: number;
    temperature?: number;
    signal?: AbortSignal;
    jsonMode?: boolean;
    /** Coordinator-owned durable attempt context. Raw prompts and payloads are never emitted. */
    attemptTelemetry?: GenerationAttemptTelemetryContext;
  }): Promise<{
    content: string;
    iterations: number;
    toolCallsMade: number;
    success: boolean;
    error?: string;
    provenance?: LLMRequestProvenance;
    /**
     * Ordered signed completion refs collected from every provider call in
     * this loop (including retries/fallbacks and the post-iteration final
     * turn). Multiple tool turns produce multiple ordered refs (#717).
     */
    executorAttestations?: readonly ExecutorAttestationRef[];
  }> {
    const maxIterations = options.maxIterations ?? 5;
    let toolResults: import('./ProviderTypes.js').ToolResultMessage[] | undefined;
    let iterations = 0;
    let toolCallsMade = 0;
    let lastArtifactCandidate: string | null = null;
    let lastArtifactProvenance: LLMRequestProvenance | undefined;
    const executorAttestations: ExecutorAttestationRef[] = [];
    const telemetry = options.attemptTelemetry;
    const declaredTools = new Set(options.tools.map((tool) => tool.name));
    const safeToolName = (name: string): string => declaredTools.has(name) ? name : 'unknown-tool';
    const payloadDigest = (payload: string): string => sha256Hex(payload);
    /**
     * Build the counter delta from the signed W8C-03 quota-counter delta and
     * signed durationMs. Never hard-code providerCalls/quotaUnits=1 — count
     * every retry/fallback attempt truthfully. Stays zero when no signed ref
     * was produced (e.g. Luna/harness policy blocked before transport).
     */
    const signedCounterDelta = (refs: readonly ExecutorAttestationRef[]): GenerationAttemptCounterDelta => {
      if (refs.length === 0) return {};
      const delta = refs.reduce((acc, ref) => ({
        providerCalls: acc.providerCalls + ref.quotaCounterDelta.calls,
        inputTokens: acc.inputTokens + ref.quotaCounterDelta.inputTokens,
        outputTokens: acc.outputTokens + ref.quotaCounterDelta.outputTokens,
        activeTimeMs: acc.activeTimeMs + Math.round(ref.quotaCounterDelta.activeSeconds * 1_000),
        quotaUnits: acc.quotaUnits + ref.quotaCounterDelta.calls,
      }), { providerCalls: 0, inputTokens: 0, outputTokens: 0, activeTimeMs: 0, quotaUnits: 0 });
      return delta;
    };
    const signedDurationMs = (refs: readonly ExecutorAttestationRef[]): number | undefined => {
      if (refs.length === 0) return undefined;
      return refs.reduce((sum, ref) => sum + ref.durationMs, 0);
    };
    const emit = async (
      stage: GenerationAttemptStage,
      partial: Partial<GenerationAttemptEventV1> = {},
      counters?: GenerationAttemptCounterDelta,
      newRefs?: readonly ExecutorAttestationRef[],
    ): Promise<void> => {
      if (!telemetry) return;
      await telemetry.emit(buildGenerationAttemptEventV1({
        runId: telemetry.runId,
        candidateId: telemetry.candidateId,
        attemptId: telemetry.attemptId,
        attemptOrdinal: telemetry.attemptOrdinal,
        domain: telemetry.domain,
        recoveryOfAttemptId: telemetry.recoveryOfAttemptId,
        executorReservationDigest: telemetry.executorReservationDigest,
        campaignFundingReservationDigest: telemetry.campaignFundingReservationDigest,
        requestedExecutor: this.config.model,
        stage,
        ...partial,
      }), counters, newRefs);
    };

    await emit('request');

    for (let i = 0; i < maxIterations; i++) {
      iterations++;
      const result = await this.generateWithTools({
        systemPrompt: options.systemPrompt,
        userPrompt: i === 0 ? options.userPrompt : `Tool results received. Continue generating the artifact for: ${options.userPrompt}`,
        tools: options.tools,
        toolResults,
        maxTokens: options.maxTokens,
        temperature: options.temperature,
        signal: options.signal,
        jsonMode: options.jsonMode,
      });
      // Capture any new signed refs from this turn (primary + retry/fallback).
      const turnRefs = result.executorAttestations ?? [];
      if (turnRefs.length > 0) executorAttestations.push(...turnRefs);
      const failedRefs = turnRefs.filter((ref) => ref.outcome === 'failure');
      const payloadRefs = turnRefs.filter((ref) => ref.outcome === 'success');
      for (const ref of failedRefs) {
        await emit('failure_class', { failureReason: 'unknown' }, signedCounterDelta([ref]), [ref]);
      }
      await emit('assistant_payload', {
        payloadByteLength: Buffer.byteLength(result.content ?? '', 'utf8'),
        payloadDigest: result.content ? payloadDigest(result.content) : undefined,
        durationMs: signedDurationMs(turnRefs),
        resolvedExecutor: result.provenance?.model,
        providerFamily: result.provenance?.provider,
      }, signedCounterDelta(payloadRefs), payloadRefs);
      if (result.content && result.content.trim().length > 0) {
        lastArtifactCandidate = result.content;
        lastArtifactProvenance = result.provenance;
      }

      if (!result.success) {
        const failureReason = /tim(?:e|ed)\s*out|abort/i.test(result.error ?? '')
          ? 'timeout' as const
          : /denied|forbidden|unauthori[sz]ed|payment|quota/i.test(result.error ?? '')
            ? 'provider_denied' as const
            : 'unknown' as const;
        await emit('failure_class', { failureReason });
        return {
          content: this.contentOrToolCodeCandidate(result.content || '', lastArtifactCandidate),
          iterations,
          toolCallsMade,
          success: !!lastArtifactCandidate,
          error: lastArtifactCandidate ? undefined : result.error,
          provenance: result.content?.trim() ? result.provenance : lastArtifactProvenance,
          executorAttestations,
        };
      }
      if (!result.toolCalls || result.toolCalls.length === 0 || result.finishReason === 'stop') {
        await emit('extracted_artifact', {
          extractionOutcome: this.contentOrToolCodeCandidate(result.content, lastArtifactCandidate).trim() ? 'pass' : 'fail',
        }, undefined, turnRefs);
        return {
          content: this.contentOrToolCodeCandidate(result.content, lastArtifactCandidate),
          iterations,
          toolCallsMade,
          success: true,
          provenance: result.content?.trim() ? result.provenance : lastArtifactProvenance,
          executorAttestations,
        };
      }

      toolResults = [];
      for (const tc of result.toolCalls) {
        toolCallsMade++;
        const toolName = safeToolName(tc.name);
        await emit('tool_selection', { toolName });
        await emit('tool_call', {
          toolName,
          toolStatus: declaredTools.has(tc.name) ? 'success' : 'forbidden',
          payloadByteLength: Buffer.byteLength(tc.arguments ?? '', 'utf8'),
          payloadDigest: tc.arguments ? payloadDigest(tc.arguments) : undefined,
        });

        // Coding-agent convention: models like Kimi K2-Plus return generated code
        // via a 'submit_code' tool call instead of message content. Extract directly.
        if (tc.name === 'submit_code') {
          try {
            const args = JSON.parse(tc.arguments);
            if (typeof args.code === 'string' && args.code.length > 0) {
              await emit('tool_result', {
                toolName,
                toolStatus: 'success',
                payloadByteLength: Buffer.byteLength(args.code, 'utf8'),
                payloadDigest: payloadDigest(args.code),
              });
              await emit('extracted_artifact', { extractionOutcome: 'pass', toolName });
              return {
                content: args.code,
                iterations,
                toolCallsMade,
                success: true,
                provenance: result.provenance,
                executorAttestations,
              };
            }
          } catch {
            await emit('failure_class', { failureReason: 'malformed_assistant_payload', toolName });
            /* fall through to normal tool execution */
          }
        }

        try {
          const args = this.parseToolArguments(tc.arguments, tc.name);
          const toolResult = await options.toolExecutor(tc.name, args);
          await emit('tool_result', {
            toolName,
            toolStatus: 'success',
            payloadByteLength: Buffer.byteLength(toolResult, 'utf8'),
            payloadDigest: payloadDigest(toolResult),
          });
          lastArtifactCandidate = this.extractToolCodeCandidate(args, toolResult) ?? lastArtifactCandidate;
          toolResults.push({ toolCallId: tc.id, result: toolResult, toolCall: tc });
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          await emit('tool_result', { toolName, toolStatus: 'error' });
          await emit('failure_class', { failureReason: 'malformed_tool_result', toolName });
          toolResults.push({ toolCallId: tc.id, result: errMsg, isError: true, toolCall: tc });
        }
      }
    }

    const lastResult = await this.generateWithTools({
      systemPrompt: options.systemPrompt,
      userPrompt: `Tool calls completed. Now output the final artifact for: ${options.userPrompt}`,
      tools: [],
      toolResults,
      maxTokens: options.maxTokens,
      temperature: options.temperature,
      signal: options.signal,
    });
    const finalRefs = lastResult.executorAttestations ?? [];
    if (finalRefs.length > 0) executorAttestations.push(...finalRefs);
    const failedFinalRefs = finalRefs.filter((ref) => ref.outcome === 'failure');
    const payloadFinalRefs = finalRefs.filter((ref) => ref.outcome === 'success');
    for (const ref of failedFinalRefs) {
      await emit('failure_class', { failureReason: 'unknown' }, signedCounterDelta([ref]), [ref]);
    }
    await emit('assistant_payload', {
      payloadByteLength: Buffer.byteLength(lastResult.content ?? '', 'utf8'),
      payloadDigest: lastResult.content ? payloadDigest(lastResult.content) : undefined,
      durationMs: signedDurationMs(finalRefs),
      resolvedExecutor: lastResult.provenance?.model,
      providerFamily: lastResult.provenance?.provider,
    }, signedCounterDelta(payloadFinalRefs), payloadFinalRefs);
    if (lastResult.content?.trim()) {
      lastArtifactProvenance = lastResult.provenance;
    }
    await emit('extracted_artifact', {
      extractionOutcome: this.contentOrToolCodeCandidate(lastResult.content || '', lastArtifactCandidate).trim() ? 'pass' : 'fail',
    }, undefined, finalRefs);
    return {
      content: this.contentOrToolCodeCandidate(lastResult.content || '', lastArtifactCandidate),
      iterations,
      toolCallsMade,
      success: lastResult.success || !!lastArtifactCandidate,
      error: lastArtifactCandidate ? undefined : 'Max iterations reached',
      provenance: lastResult.content?.trim()
        ? lastResult.provenance
        : lastArtifactProvenance,
      executorAttestations,
    };
  }

  /**
   * Stream tokens in real-time for chat interfaces
   * Yields partial content as it arrives from the LLM
   */
  private async *streamTransportEvents(
    provider: BaseProvider,
    req: ProviderRequest,
    telemetry?: GenerationAttemptTelemetryContext,
  ): AsyncGenerator<StreamEvent> {
    const accounted = new Set<string>();
    let activeRefs: ExecutorAttestationRef[] = [];
    let completed = false;
    let yieldingToConsumer = false;
    const countersFor = (refs: readonly ExecutorAttestationRef[]): GenerationAttemptCounterDelta =>
      refs.reduce((sum, ref) => ({
        providerCalls: sum.providerCalls + ref.quotaCounterDelta.calls,
        inputTokens: sum.inputTokens + ref.quotaCounterDelta.inputTokens,
        outputTokens: sum.outputTokens + ref.quotaCounterDelta.outputTokens,
        activeTimeMs: sum.activeTimeMs + Math.round(ref.quotaCounterDelta.activeSeconds * 1_000),
        quotaUnits: sum.quotaUnits + ref.quotaCounterDelta.calls,
      }), { providerCalls: 0, inputTokens: 0, outputTokens: 0, activeTimeMs: 0, quotaUnits: 0 });
    const emit = async (
      stage: GenerationAttemptStage,
      refs: readonly ExecutorAttestationRef[] = [],
      partial: Partial<GenerationAttemptEventV1> = {},
      charge = false,
    ): Promise<void> => {
      if (!telemetry) return;
      const unaccounted = charge ? refs.filter((ref) => !accounted.has(ref.attestationDigest)) : [];
      for (const ref of unaccounted) accounted.add(ref.attestationDigest);
      await telemetry.emit(buildGenerationAttemptEventV1({
        runId: telemetry.runId,
        candidateId: telemetry.candidateId,
        attemptId: telemetry.attemptId,
        attemptOrdinal: telemetry.attemptOrdinal,
        domain: telemetry.domain,
        recoveryOfAttemptId: telemetry.recoveryOfAttemptId,
        executorReservationDigest: telemetry.executorReservationDigest,
        campaignFundingReservationDigest: telemetry.campaignFundingReservationDigest,
        requestedExecutor: this.config.model,
        stage,
        ...partial,
      }), unaccounted.length > 0 ? countersFor(unaccounted) : undefined, refs);
    };
    const failureReason = (error: unknown): GenerationAttemptFailureReason => {
      const message = error instanceof Error ? error.message : String(error);
      if (/tim(?:e|ed)\s*out|abort/i.test(message)) return 'timeout';
      if (/denied|forbidden|unauthori[sz]ed|payment|quota/i.test(message)) return 'provider_denied';
      return 'unknown';
    };
    const consume = async function* (
      self: LLMClient,
      transport: BaseProvider,
      phase: 'pre-primary-transport' | 'pre-fallback-transport',
      fallbackOrdinal: number,
      refs: ExecutorAttestationRef[],
    ): AsyncGenerator<StreamEvent> {
      const gen = self.executeProviderStreamAttempt(transport, req, phase, fallbackOrdinal, 0, refs);
      for await (const event of gen) {
        if (event.type === 'error') throw new LLMError(event.error, transport.name, undefined, false);
        yield event;
      }
    };

    await emit('request');
    try {
      try {
        activeRefs = [];
        let payloadByteLength = 0;
        for await (const event of consume(this, provider, 'pre-primary-transport', 0, activeRefs)) {
          if (event.type === 'content' || event.type === 'thinking') {
            payloadByteLength += Buffer.byteLength(event.content, 'utf8');
          }
          yieldingToConsumer = true;
          yield event;
          yieldingToConsumer = false;
        }
        await emit('assistant_payload', activeRefs, { payloadByteLength }, true);
        await emit('terminal', activeRefs, { recoveryDecision: 'no_recovery' });
        completed = true;
        return;
      } catch (primaryError) {
        await emit('failure_class', activeRefs, { failureReason: failureReason(primaryError) }, true);
        if (!this.isFallbackableError(primaryError)) throw primaryError;
        const fallbacks = this.getFallbackProviders();
        if (fallbacks.length === 0) throw primaryError;
        const failures: string[] = [];
        for (const [index, fallback] of fallbacks.entries()) {
          activeRefs = [];
          try {
            let payloadByteLength = 0;
            for await (const event of consume(this, fallback, 'pre-fallback-transport', index + 1, activeRefs)) {
              if (event.type === 'content' || event.type === 'thinking') {
                payloadByteLength += Buffer.byteLength(event.content, 'utf8');
              }
              yieldingToConsumer = true;
              yield event;
              yieldingToConsumer = false;
            }
            await emit('assistant_payload', activeRefs, { payloadByteLength }, true);
            await emit('terminal', activeRefs, { recoveryDecision: 'no_recovery' });
            completed = true;
            return;
          } catch (error) {
            await emit('failure_class', activeRefs, { failureReason: failureReason(error) }, true);
            failures.push(this.formatFallbackFailure(fallback.getModel(), error));
          }
        }
        throw this.withFallbackDiagnostics(primaryError, failures);
      }
    } finally {
      if (!completed && yieldingToConsumer && activeRefs.length > 0) {
        await emit('failure_class', activeRefs, { failureReason: 'consumer_abort' }, true);
      }
    }
  }

  async *stream(
    systemPrompt: string,
    userPrompt: string,
    signal?: AbortSignal,
    attemptTelemetry?: GenerationAttemptTelemetryContext,
  ): AsyncGenerator<string> {
    await this.resolveRoleConfigForRequest();
    this.startExecutorAttemptSequence();
    this.assertHarnessAuthorityBeforeResolution();
    // Auto-detect model on first use
    const resolvedModel = await this.resolveModel();
    this.syncResolvedModel(resolvedModel);

    const provider = await this.getProvider();
    const req: ProviderRequest = {
      systemPrompt,
      userPrompt,
      temperature: this.config.temperature,
      maxTokens: this.config.maxTokens,
      thinking: this.config.thinking,
      signal,
    };

    for await (const event of this.streamTransportEvents(provider, req, attemptTelemetry)) {
      if (event.type === 'content') yield event.content;
      // Error events are thrown inside consume() before reaching this loop;
      // a truncated stream therefore rejects rather than yielding text.
    }
  }

  /**
   * Stream tokens with thinking events included
   * Yields tagged events so callers can distinguish thinking from content
   */
  async *streamWithThinking(
    systemPrompt: string,
    userPrompt: string,
    signal?: AbortSignal,
    maxTokens?: number,
    attemptTelemetry?: GenerationAttemptTelemetryContext,
  ): AsyncGenerator<{ type: 'thinking' | 'content'; content: string }> {
    await this.resolveRoleConfigForRequest();
    this.startExecutorAttemptSequence();
    this.assertHarnessAuthorityBeforeResolution();
    // Auto-detect model on first use
    const resolvedModel = await this.resolveModel();
    this.syncResolvedModel(resolvedModel);

    const startTime = Date.now();

    eventBus.emit(EventTypes.LLM_REQUEST, 'LLMClient', {
      provider: this.detectProvider(),
      model: this.config.model,
      method: 'streamWithThinking',
      promptPreview: userPrompt.slice(0, 100),
    });

    const provider = await this.getProvider();
    const req: ProviderRequest = {
      systemPrompt,
      userPrompt,
      temperature: this.config.temperature,
      maxTokens: maxTokens ?? this.config.maxTokens,
      thinking: this.config.thinking,
      signal,
    };

    try {
      for await (const event of this.streamTransportEvents(provider, req, attemptTelemetry)) {
        if (event.type === 'thinking') {
          yield { type: 'thinking' as const, content: event.content };
        } else if (event.type === 'content') {
          yield { type: 'content' as const, content: event.content };
        }
        // 'done' events are silently consumed
      }

      eventBus.emit(EventTypes.LLM_RESPONSE, 'LLMClient', {
        provider: this.detectProvider(),
        model: this.config.model,
        role: this.role ?? null,
        endpointHost: this.endpointHostForTelemetry(),
        baseUrl: this.config.baseUrl ?? null,
        method: 'streamWithThinking',
        success: true,
        duration: Date.now() - startTime,
      });
    } catch (primaryError: unknown) {
      eventBus.emit(EventTypes.LLM_RESPONSE, 'LLMClient', {
        provider: this.detectProvider(),
        model: this.config.model,
        role: this.role ?? null,
        endpointHost: this.endpointHostForTelemetry(),
        baseUrl: this.config.baseUrl ?? null,
        method: 'streamWithThinking',
        success: false,
        duration: Date.now() - startTime,
        error: primaryError instanceof Error ? primaryError.message : 'Unknown error',
      });
      throw primaryError;
    }
  }

  // ── Response mapping ──

  /** Map a ProviderResponse to an LLMResponse with sanitization */
  private mapProviderResponse(response: ProviderResponse): LLMResponse {
    if (!response.success) {
      return {
        code: '',
        success: false,
        error: response.error || 'Provider returned unsuccessful response',
        usage: response.usage,
        finishReason: response.finishReason,
      };
    }

    // Sanitize the content (strip markdown fences, narrative text, think tags)
    const { sanitized, extractedReasoning } = sanitizeOutputWithReasoning(response.content);

    // Prefer explicit thinking field (Ollama, Anthropic), fall back to extracted narrative
    const thinking = response.thinking?.text || extractedReasoning || undefined;
    const thinkingSource = response.thinking?.source
      || (extractedReasoning ? 'think_tags' : 'none');

    const code = sanitized.code;

    const mapped: LLMResponse = {
      code,
      explanation: response.content,
      reasoning: thinking,
      thinking,
      thinkingSource,
      recoveredFromThinking: false,
      success: code.length > 0 && response.finishReason !== 'length',
      // A reply cut at the token cap is never complete, whatever the
      // sanitizer infers from its last line (#1423 bug 7).
      isComplete: response.finishReason === 'length' ? false : sanitized.isComplete,
      finishReason: response.finishReason,
      ...(response.finishReason === 'length'
        ? { error: `Provider stopped at the token cap (finish_reason=length, maxTokens reached)` }
        : {}),
      usage: response.usage,
    };

    this.maybeWriteThinkingTrace(mapped, response);
    return mapped;
  }

  /**
   * When SINTER_THINKING_OUT_DIR (or LIMINAL_*) is set, dump full reasoning
   * + usage for audition / telemetry consumers. Fire-and-forget; never throws.
   */
  private maybeWriteThinkingTrace(mapped: LLMResponse, response: ProviderResponse): void {
    const dir =
      process.env.SINTER_THINKING_OUT_DIR?.trim()
      || process.env.LIMINAL_THINKING_OUT_DIR?.trim();
    if (!dir) return;
    try {
      mkdirSync(dir, { recursive: true });
      const role = process.env.SINTER_THINKING_ROLE?.trim()
        || process.env.LIMINAL_THINKING_ROLE?.trim()
        || this.role
        || 'llm';
      const attempt = process.env.SINTER_THINKING_ATTEMPT?.trim()
        || process.env.LIMINAL_THINKING_ATTEMPT?.trim()
        || '1';
      const base = `${role}-attempt-${attempt}`;
      const thinkingText = mapped.thinking || mapped.reasoning || '';
      const md = [
        `# ${role} reasoning trace`,
        '',
        `- model: ${this.config.model}`,
        `- requested thinking: ${JSON.stringify(this.config.thinking || null)}`,
        `- thinkingSource: ${mapped.thinkingSource || 'none'}`,
        `- usage: ${JSON.stringify(mapped.usage || response.usage || null)}`,
        `- capturedAt: ${new Date().toISOString()}`,
        '',
        '## Trace',
        '',
        thinkingText.trim()
          ? thinkingText
          : '_(no reasoning/thinking content returned by route)_',
        '',
      ].join('\n');
      writeFileSync(pathJoin(dir, `${base}.md`), md, 'utf8');
      writeFileSync(
        pathJoin(dir, `${base}.json`),
        JSON.stringify({
          role,
          attempt,
          model: this.config.model,
          thinkingRequested: this.config.thinking || null,
          thinkingSource: mapped.thinkingSource || 'none',
          thinking: thinkingText,
          usage: mapped.usage || response.usage || null,
          capturedAt: new Date().toISOString(),
        }, null, 2),
        'utf8',
      );
      appendFileSync(
        pathJoin(dir, 'index.jsonl'),
        `${JSON.stringify({ role, attempt, model: this.config.model, hasTrace: Boolean(thinkingText.trim()), usage: mapped.usage || null, ts: new Date().toISOString() })}\n`,
        'utf8',
      );
    } catch (err) {
      Logger.debug('LLMClient', 'thinking trace write skipped:', err);
    }
  }
}

// ── Shared sanitization utility ──

/**
 * sanitizeOutputWithReasoning — like sanitizeOutput but also extracts
 * the narrative/reasoning text that gets stripped before code.
 * For providers (LM Studio, etc.) that don't expose reasoning_content
 * separately but mix reasoning into the content body.
 */
export function sanitizeOutputWithReasoning(content: string): {
  sanitized: { code: string; success: boolean; isComplete: boolean };
  extractedReasoning: string;
} {
  const reply = splitThinking(content);
  const tagReasoning = reply.thinking;
  let cleanCode = reply.answer;

  const block = pickCodeBlock(cleanCode);
  if (block) {
    const narrativeReasoning = proseOutsideFences(cleanCode)
      .split('\n')
      .filter(line => line.trim().length > 0)
      .join('\n');
    cleanCode = block.body.trim();
    const extractedReasoning = [tagReasoning, narrativeReasoning]
      .filter(Boolean)
      .join('\n\n');

    return {
      sanitized: { code: cleanCode, success: cleanCode.length > 0, isComplete: isCodeComplete(cleanCode) },
      extractedReasoning,
    };
  }

  // No markdown fences — extract leading narrative before code starts
  const lines = cleanCode.split('\n');
  const codeStartPatterns = [
    /^(let|const|var|function|class|if|for|while|import|export|return|precision|void|vec|uniform)\b/,
    /^<!DOCTYPE/i,
    /^<html/i,
    /^<script/i,
    /^\$/,
    /^osc\(|^src\(|^render\(/,
  ];

  // Lines after the last explicit narration marker count as narrative only
  // when they are a short prose preamble (≤2 sentence-like lines). A poem or
  // ASCII header is the artwork itself: Luna's 26-line textgen poem lost its
  // first two-thirds to `for one brief second` reading as a `for` loop
  // (live matrix 2026-11-10).
  let markedEnd = 0;
  let codeStartIndex = -1;
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (!trimmed) continue;

    if (codeStartPatterns.some(p => p.test(trimmed))) {
      codeStartIndex = i;
      break;
    }

    if (/^(Here|I'll|Let me|This (is|will|code|sketch|program|implementation)\b|The user)/i.test(trimmed)) {
      markedEnd = i + 1;
      continue;
    }

    // A code-shaped line we have no keyword for — `(() => {`, `#ifdef GL_ES`,
    // `s0.initCam()` — starts the code. Dropping it as narrative left Sol's
    // valid IIFE without its opener (live matrix 2026-11-10, Unexpected token).
    if (/[(){}[\];=<>#]|^\/[/*]|^['"]use strict/.test(trimmed)) {
      codeStartIndex = i;
      break;
    }
  }
  if (codeStartIndex === -1) {
    codeStartIndex = markedEnd;
  } else {
    const unmarked = lines.slice(markedEnd, codeStartIndex).map(l => l.trim()).filter(Boolean);
    const shortProsePreamble = unmarked.length <= 2
      && unmarked.every(l => /^[A-Za-z][\w'’,-]*(\s+\S+){1,}/.test(l));
    if (!shortProsePreamble) codeStartIndex = markedEnd;
  }

  const narrativeLines = lines.slice(0, codeStartIndex).filter(l => l.trim().length > 0);
  const narrativeReasoning = narrativeLines.join('\n');
  cleanCode = lines.slice(codeStartIndex).join('\n').trim();

  const extractedReasoning = [tagReasoning, narrativeReasoning]
    .filter(Boolean)
    .join('\n\n');

  return {
    sanitized: { code: cleanCode, success: cleanCode.length > 0, isComplete: isCodeComplete(cleanCode) },
    extractedReasoning,
  };
}

/**
 * Universal output sanitizer
 * Handles contamination from ANY model: <think/> tags, markdown fences, reasoning text
 * Exported as a standalone function for reuse across the codebase.
 */
export function sanitizeOutput(content: string): { code: string; success: boolean; isComplete: boolean } {
  return sanitizeOutputWithReasoning(content).sanitized;
}

/**
 * Check if code is structurally complete.
 *
 * Delegates to the shared domain-aware helper. Output sanitization runs on raw
 * model text before a domain is resolved, so no domain is passed here and the
 * helper applies its universal structural (brace/paren/bracket balance) check.
 */
export function isCodeComplete(code: string): boolean {
  return isCodeCompleteShared(code);
}
