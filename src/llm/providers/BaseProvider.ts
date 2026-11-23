/**
 * BaseProvider - Abstract base class for all LLM provider implementations
 *
 * Every provider (OpenAI, Anthropic, Ollama, etc.) extends this class
 * and implements generate() and stream(). The base class provides
 * common configuration and capability checking.
 */

import { Result, err, ok } from 'neverthrow';
import { createHash } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import type {
  ProviderConfig,
  ProviderRequest,
  ProviderResponse,
  ProviderCapabilities,
  StreamEvent,
} from '../ProviderTypes.js';
import { LLMError } from '../errors.js';
import {
  configuredTimeoutError,
  describeUndiciTimeout,
  dispatcherFor,
  resolveProviderTimeoutMs,
} from '../providerFetch.js';
import { authorizeProviderInvocation, completeProviderInvocation } from '../PreSpendInterlock.js';
import { assertWithinBudget } from '../ProviderBudgetLedger.js';

declare const PROVIDER_TRANSPORT_RESERVATION: unique symbol;
export interface ProviderTransportReservation {
  readonly [PROVIDER_TRANSPORT_RESERVATION]: true;
}
export interface ReservedProviderTransport {
  readonly capability: ProviderTransportReservation;
  readonly provider: string;
  readonly model: string;
  readonly baseUrl: string;
  readonly credentialDigest: string;
}

type Effort = NonNullable<NonNullable<ProviderRequest['thinking']>['effort']>;
const EFFORT_STEP_DOWN: Record<Effort, Effort | undefined> = {
  max: 'high', xhigh: 'high', high: 'medium', medium: 'low', low: undefined,
};

/** finish_reason=length with no visible content and no tool call: the budget went to reasoning. */
function isReasoningExhausted(response: ProviderResponse): boolean {
  return response.failureClass === 'reasoning-exhausted'
    || (!response.success && response.finishReason === 'length'
      && response.content.length === 0 && !(response.toolCalls && response.toolCalls.length > 0));
}

/** One level down, or undefined when thinking is off or already at low. */
function stepDownEffort(req: ProviderRequest): Effort | undefined {
  if (!req.thinking?.enabled) return undefined;
  return EFFORT_STEP_DOWN[req.thinking.effort ?? 'high'];
}

function withReasoningRecovery(req: ProviderRequest, effort: Effort): ProviderRequest {
  const budget = req.maxTokens !== undefined
    ? `Your total output budget is ${req.maxTokens} tokens, reasoning included. A previous attempt spent all of it on reasoning and produced no answer. Keep reasoning brief and always finish with the complete answer.`
    : 'A previous attempt spent its whole output budget on reasoning and produced no answer. Keep reasoning brief and always finish with the complete answer.';
  return {
    ...req,
    systemPrompt: `${req.systemPrompt}\n\n${budget}`.trim(),
    thinking: { ...req.thinking, enabled: true, effort },
  };
}

function describeAttempt(response: ProviderResponse, req: ProviderRequest): string {
  const effort = req.thinking?.enabled ? (req.thinking.effort ?? 'high') : 'off';
  const out = response.usage ? `output_tokens=${response.usage.outputTokens}, input_tokens=${response.usage.inputTokens}` : 'tokens=unreported';
  const provider = response.error ? `; provider said: ${response.error}` : '';
  return `effort=${effort}, finish_reason=${response.finishReason ?? 'unknown'}, ${out}${provider}`;
}

function markReasoningExhausted(response: ProviderResponse, detail: string): ProviderResponse {
  return {
    ...response,
    success: false,
    failureClass: 'reasoning-exhausted',
    error: `reasoning-exhausted: the model spent its whole output budget on reasoning and returned no visible content (${detail})`,
  };
}

const signalTimeouts = new WeakMap<AbortSignal, { provider: string; timeoutMs: number }>();

export abstract class BaseProvider {
  abstract readonly name: string;

  readonly #transportContext = new AsyncLocalStorage<Readonly<ProviderConfig>>();
  #config: Readonly<ProviderConfig>;
  readonly #reservations = new WeakMap<object, Readonly<ProviderConfig>>();
  /** Requests that are themselves the one reasoning-exhausted recovery attempt. */
  readonly #recoveryRequests = new WeakSet<object>();
  #reservedCount = 0;
  #inFlightCount = 0;

  constructor(config: ProviderConfig) {
    this.#config = Object.freeze({ ...config,
      ...(config.headers ? { headers: Object.freeze({ ...config.headers }) } : {}) });
    Object.defineProperty(this, 'config', {
      configurable: false,
      enumerable: false,
      get: () => this.#transportContext.getStore() ?? this.#config,
    });
  }

  /** Concrete adapters always resolve config from the sealed invocation context. */
  protected get config(): Readonly<ProviderConfig> {
    return this.#transportContext.getStore() ?? this.#config;
  }

  /** Seal the exact immutable transport config before any durable campaign debit. */
  reserveTransport(): ReservedProviderTransport {
    const capability = Object.freeze({}) as ProviderTransportReservation;
    this.#reservations.set(capability, this.config);
    this.#reservedCount += 1;
    return Object.freeze({ capability, provider: this.config.logicalProvider ?? this.name,
      model: this.config.model, baseUrl: this.config.baseUrl,
      credentialDigest: createHash('sha256').update(this.config.apiKey ?? '').digest('hex') });
  }

  cancelReservedTransport(reservation: ReservedProviderTransport): void {
    if (!this.#reservations.delete(reservation.capability)) return;
    this.#reservedCount -= 1;
  }

  private claimReservedTransport(reservation?: ReservedProviderTransport): Readonly<ProviderConfig> {
    const owned = reservation ? this.#reservations.get(reservation.capability) : undefined;
    if (reservation && !owned) throw new Error('Provider transport reservation is invalid or consumed');
    const config = owned ?? this.config;
    if (reservation) {
      this.#reservations.delete(reservation.capability);
      this.#reservedCount -= 1;
    }
    this.#inFlightCount += 1;
    return config;
  }

  /**
   * Generate a completion (non-streaming).
   */
  async generate(req: ProviderRequest,
    reservation?: ReservedProviderTransport): Promise<Result<ProviderResponse, LLMError>> {
    const config = this.claimReservedTransport(reservation);
    let callId: string | undefined;
    try {
      callId = authorizeProviderInvocation({ provider: config.logicalProvider ?? this.name,
        model: config.model, request: req, mode: 'generate', transport: {
          baseUrl: config.baseUrl,
          credentialDigest: createHash('sha256').update(config.apiKey ?? '').digest('hex'),
        } });
      // Hard USD caps apply to every adapter: fail closed before the request
      // leaves the machine (FABLE-R3.8).
      try {
        assertWithinBudget(config.baseUrl, config.model);
      } catch (error) {
        completeProviderInvocation(callId, 'error');
        return err(new LLMError(error instanceof Error ? error.message : String(error), this.name, undefined, false, {
          model: config.model, endpoint: config.baseUrl,
        }));
      }
      let result = await this.#transportContext.run(config, () => this.generateImpl(req));
      let response = result.isOk() ? result.value : undefined;
      completeProviderInvocation(callId, result.isOk() && response?.success ? 'success' : 'error', response?.usage);
      if (response && isReasoningExhausted(response)) {
        const isRecovery = this.#recoveryRequests.has(req);
        const lower = isRecovery ? undefined : stepDownEffort(req);
        if (lower) {
          // One recovery attempt: a full provider call through generate(), so the
          // pre-spend interlock, budget ledger and call accounting all apply.
          const retryReq = withReasoningRecovery(req, lower);
          this.#recoveryRequests.add(retryReq);
          const retry = await this.generate(retryReq);
          const retried = retry.isOk() ? retry.value : undefined;
          if (retried?.success) return retry;
          if (retried && isReasoningExhausted(retried)) {
            return ok(markReasoningExhausted(retried, `${describeAttempt(response, req)}; retry at effort=${lower}: ${describeAttempt(retried, retryReq)}`));
          }
          if (retry.isErr()) return retry;
          return ok(markReasoningExhausted(response, describeAttempt(response, req)));
        }
        // No recovery was possible: keep the adapter's own, more specific
        // diagnostic when it wrote one, and only add the failure class.
        response = response.error
          ? { ...response, success: false, failureClass: 'reasoning-exhausted' }
          : markReasoningExhausted(response, describeAttempt(response, req));
        result = ok(response);
      }
      return result;
    } catch (error) {
      completeProviderInvocation(callId, 'error');
      throw error;
    } finally {
      this.#inFlightCount -= 1;
    }
  }

  protected abstract generateImpl(req: ProviderRequest): Promise<Result<ProviderResponse, LLMError>>;

  /**
   * Stream tokens as they arrive.
   */
  async *stream(req: ProviderRequest,
    reservation?: ReservedProviderTransport): AsyncGenerator<StreamEvent> {
    const config = this.claimReservedTransport(reservation);
    let callId: string | undefined;
    let status: 'success' | 'error' = 'success';
    let usage: { inputTokens: number; outputTokens: number } | undefined;
    try {
      callId = authorizeProviderInvocation({ provider: config.logicalProvider ?? this.name,
        model: config.model, request: req, mode: 'stream', transport: {
          baseUrl: config.baseUrl,
          credentialDigest: createHash('sha256').update(config.apiKey ?? '').digest('hex'),
        } });
      assertWithinBudget(config.baseUrl, config.model);
      const iterator = this.streamImpl(req);
      while (true) {
        const next = await this.#transportContext.run(config, () => iterator.next());
        if (next.done) break;
        const event = next.value;
        if (event.type === 'error') status = 'error';
        if (event.type === 'done' && event.usage) usage = event.usage;
        yield event;
      }
    } catch (error) {
      status = 'error';
      throw error;
    } finally {
      completeProviderInvocation(callId, status, usage);
      this.#inFlightCount -= 1;
    }
  }

  protected abstract streamImpl(req: ProviderRequest): AsyncGenerator<StreamEvent>;

  /**
   * Capabilities for the currently configured model.
   * Implementations should use CapabilityRegistry for lookups.
   */
  abstract get capabilities(): ProviderCapabilities;

  // ── Convenience methods ──

  /**
   * Combine a caller-supplied abort signal with the provider's own timeout so the
   * timeout ALWAYS bounds the request. The previous `req.signal || AbortSignal.timeout(...)`
   * silently dropped the timeout whenever a caller passed any signal — removing the only
   * time bound on long generations (the structural cause of the multi-minute provider stalls).
   *
   * `AbortSignal.any` is Node 20.3+; a manual combiner covers the `engines` floor (Node 18).
   */
  protected withTimeout(reqSignal: AbortSignal | undefined, requestedMs: number): AbortSignal {
    const provider = this.config.logicalProvider ?? this.name;
    const timeoutMs = resolveProviderTimeoutMs(provider, requestedMs);
    const controller = new AbortController();
    // A plain timer (not AbortSignal.timeout) so the abort reason can name the
    // limit and so fake timers can drive it in tests.
    const timer = setTimeout(() => controller.abort(configuredTimeoutError(provider, timeoutMs)), timeoutMs);
    timer.unref?.();
    controller.signal.addEventListener('abort', () => clearTimeout(timer), { once: true });
    if (reqSignal) {
      if (reqSignal.aborted) controller.abort(reqSignal.reason);
      else reqSignal.addEventListener('abort', () => controller.abort(reqSignal.reason), { once: true });
    }
    signalTimeouts.set(controller.signal, { provider, timeoutMs });
    return controller.signal;
  }

  /**
   * fetch() for a signal made by withTimeout: raises undici's 300 s
   * headers/body limits to sit just above that signal's timeout and names the
   * limit when one fires, instead of a bare "fetch failed".
   */
  protected async limitedFetch(url: string | URL, init: RequestInit & { signal: AbortSignal }): Promise<Response> {
    const limits = signalTimeouts.get(init.signal);
    if (!limits) return fetch(url, init);
    try {
      return await fetch(url, { ...init, dispatcher: dispatcherFor(limits.timeoutMs) } as RequestInit);
    } catch (error) {
      throw describeUndiciTimeout(error, limits.provider, limits.timeoutMs) ?? error;
    }
  }

  supportsThinking(): boolean {
    return this.capabilities.thinking;
  }

  supportsStreaming(): boolean {
    return this.capabilities.streaming;
  }

  supportsJsonMode(): boolean {
    return this.capabilities.jsonMode;
  }

  supportsToolUse(): boolean {
    return this.capabilities.toolUse;
  }

  /**
   * Update the model in the config (e.g., after auto-detection).
   */
  setModel(model: string): void {
    if (this.#reservedCount > 0 || this.#inFlightCount > 0) {
      throw new Error('Provider transport configuration is reserved or in-flight');
    }
    this.#config = Object.freeze({ ...this.#config, model });
  }

  /**
   * Get the current model name.
   */
  getModel(): string {
    return this.#config.model;
  }

  /**
   * Get the provider config (safe copy).
   */
  getConfig(): ProviderConfig {
    return { ...this.#config };
  }
}

/**
 * Detect whether a model requires `max_completion_tokens` instead of `max_tokens`.
 * OpenAI reasoning models (o1, o3, o4) and the GPT-5-and-later families reject `max_tokens`
 * (api.openai.com answers gpt-6.2-sol with 400 unsupported_parameter).
 */
export function usesMaxCompletionTokens(model: string): boolean {
  return /^(gpt-(?:[5-9]|\d{2,})(?:[.-]|$)|o[1-9](?:-|$))/.test(model);
}

/**
 * Map a provider's native finish/stop reason onto ProviderResponse.finishReason.
 * An output-cap stop becomes 'length' so callers can tell a reply that was cut
 * off from one that ended (#1643: Kilo/OpenRouter/Google used to report 'stop').
 */
export function mapNativeFinishReason(native: unknown, hasToolCalls: boolean): 'stop' | 'tool_calls' | 'length' {
  if (hasToolCalls) return 'tool_calls';
  const reason = typeof native === 'string' ? native.toLowerCase() : '';
  return reason === 'length' || reason === 'max_tokens' || reason === 'max_output_tokens' ? 'length' : 'stop';
}
