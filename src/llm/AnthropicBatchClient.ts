/**
 * Anthropic Message Batches transport: submit / poll / fetch results / cancel.
 * Raw HTTP like AnthropicProvider (the repo has no @anthropic-ai/sdk). The key comes from the caller (env only), goes into
 * the x-api-key header and nowhere else: no error text, log line or journal field ever carries it.
 */
export const ANTHROPIC_VERSION = '2023-06-01';
export const DEFAULT_ANTHROPIC_BASE_URL = 'https://api.anthropic.com';
export const BATCH_MAX_REQUESTS = 100_000;
export const BATCH_MAX_BYTES = 256 * 1024 * 1024;

export class AnthropicBatchValidationError extends Error {}

/** Keys a batch request must never carry on the current models (or at all, for stream/speed/fallbacks). */
const FORBIDDEN_PARAM_KEYS = ['temperature', 'top_p', 'top_k', 'stream', 'speed', 'fallbacks'] as const;

export interface BatchRequestParams { model: string; max_tokens: number; messages: Array<{ role: string; content: unknown }>; system?: unknown; [k: string]: unknown }
export interface BatchRequest { custom_id: string; params: BatchRequestParams }
export interface BatchStatus {
  id: string;
  processing_status: 'in_progress' | 'canceling' | 'ended' | string;
  request_counts: { processing: number; succeeded: number; errored: number; canceled: number; expired: number };
}
type SubmitAttempt = (ordinal: number, post: () => Promise<BatchStatus>) => Promise<BatchStatus>;

export interface BatchMessage {
  id?: string; type?: string; role?: string; model?: string; stop_reason?: string | null;
  content: Array<{ type: string; text?: string; [k: string]: unknown }>;
  usage?: { input_tokens?: number; output_tokens?: number; cache_creation_input_tokens?: number; cache_read_input_tokens?: number };
}
export type BatchResult =
  | { custom_id: string; result: { type: 'succeeded'; message: BatchMessage } }
  | { custom_id: string; result: { type: 'errored'; error: { type?: string; error?: { type?: string; message?: string }; message?: string } } }
  | { custom_id: string; result: { type: 'canceled' | 'expired' } };

export class AnthropicBatchHttpError extends Error {
  constructor(readonly status: number, readonly body: string, readonly retryAfterMs?: number) {
    super(`ANTHROPIC_BATCH_HTTP_${status}: ${body.slice(0, 300)}`);
    this.name = 'AnthropicBatchHttpError';
  }
}

/** Remove everything a batch request must not carry. Mutates nothing; the result is what goes on the wire. */
export function sanitizeBatchParams(params: BatchRequestParams): BatchRequestParams {
  const out: Record<string, unknown> = { ...params };
  for (const k of FORBIDDEN_PARAM_KEYS) delete out[k];
  // Thinking is adaptive on the current models: omit the param entirely (never budget_tokens, never enabled).
  delete out.thinking;
  delete out.tool_choice;
  const messages = (out.messages as BatchRequestParams['messages']).slice();
  while (messages.length > 1 && messages[messages.length - 1].role === 'assistant') messages.pop(); // no assistant prefill
  out.messages = messages;
  if (!Number.isInteger(out.max_tokens) || (out.max_tokens as number) < 1) throw new Error('BATCH_MAX_TOKENS_INVALID: every batch request needs max_tokens >= 1');
  return out as BatchRequestParams;
}

/** Fail closed on a body that carries a forbidden field anywhere a provider could read it. */
export function assertBatchBodyClean(body: unknown): void {
  const text = JSON.stringify(body);
  for (const k of [...FORBIDDEN_PARAM_KEYS, 'budget_tokens']) {
    if (new RegExp(`"${k}"\\s*:`).test(text)) throw new Error(`BATCH_BODY_FORBIDDEN_FIELD: ${k}`);
  }
}

export interface AnthropicBatchClientOptions {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly fetchImpl?: typeof fetch;
  readonly sleep?: (ms: number) => Promise<void>;
  /** Submit retries only after an explicit rate-limit rejection. */
  readonly maxSubmitAttempts?: number;
}

export class AnthropicBatchClient {
  readonly #base: string;
  readonly #key: string;
  readonly #fetch: typeof fetch;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #maxSubmit: number;

  constructor(options: AnthropicBatchClientOptions) {
    if (!options.apiKey) throw new Error('ANTHROPIC_API_KEY is not set');
    this.#base = options.baseUrl.replace(/\/+$/, '').replace(/\/v1$/, '');
    this.#key = options.apiKey;
    this.#fetch = options.fetchImpl ?? fetch;
    this.#sleep = options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.#maxSubmit = options.maxSubmitAttempts ?? 8;
  }

  async #call(method: string, pathname: string, body?: string): Promise<Response> {
    const res = await this.#fetch(`${this.#base}${pathname}`, {
      method,
      redirect: 'error',
      headers: { 'x-api-key': this.#key, 'anthropic-version': ANTHROPIC_VERSION, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body }),
    });
    if (!res.ok) {
      const ra = Number(res.headers.get('retry-after'));
      const detail = (await res.text().catch(() => '')).split(this.#key).join('[redacted]');
      throw new AnthropicBatchHttpError(res.status, detail, Number.isFinite(ra) && ra > 0 ? ra * 1000 : undefined);
    }
    return res;
  }

  async submit(requests: readonly BatchRequest[]): Promise<BatchStatus> {
    return this.prepareSubmission(requests)();
  }

  /** Prepare the exact outgoing bytes before the caller records a possible POST. */
  prepareSubmission(requests: readonly BatchRequest[]): (runAttempt?: SubmitAttempt) => Promise<BatchStatus> {
    let serialized: string;
    try {
      if (requests.length < 1 || requests.length > BATCH_MAX_REQUESTS) throw new Error(`BATCH_SIZE_INVALID: ${requests.length} requests (1..${BATCH_MAX_REQUESTS})`);
      const body = { requests: requests.map((r) => ({ custom_id: r.custom_id, params: sanitizeBatchParams(r.params) })) };
      assertBatchBodyClean(body);
      serialized = JSON.stringify(body);
      if (Buffer.byteLength(serialized) > BATCH_MAX_BYTES) throw new Error('BATCH_TOO_LARGE: over 256 MB');
    } catch (error) {
      throw new AnthropicBatchValidationError(error instanceof Error ? error.message : 'Batch request is invalid', { cause: error });
    }
    return runAttempt => this.#submitPrepared(serialized, runAttempt);
  }

  /** POST retries only a 429. A connection failure or 5xx may follow an accepted submission. */
  async #submitPrepared(body: string, runAttempt: SubmitAttempt = (_, post) => post()): Promise<BatchStatus> {
    let delay = 2000;
    for (let attempt = 1; ; attempt++) {
      try {
        return await runAttempt(attempt, async () => {
          const response = await this.#call('POST', '/v1/messages/batches', body);
          const submitted = await response.json() as BatchStatus;
          if (typeof submitted.id !== 'string' || !submitted.id) throw new Error('BATCH_SUBMIT_ID_MISSING');
          return submitted;
        });
      } catch (error) {
        if (!(error instanceof AnthropicBatchHttpError) || error.status !== 429 || attempt >= this.#maxSubmit) throw error;
        await this.#sleep(error.retryAfterMs ?? delay);
        delay = Math.min(delay * 2, 120_000);
      }
    }
  }

  async get(batchId: string): Promise<BatchStatus> {
    return await (await this.#call('GET', `/v1/messages/batches/${encodeURIComponent(batchId)}`)).json() as BatchStatus;
  }

  /** JSONL, any order: callers key by custom_id. */
  async results(batchId: string): Promise<BatchResult[]> {
    const text = await (await this.#call('GET', `/v1/messages/batches/${encodeURIComponent(batchId)}/results`)).text();
    return text.split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l) as BatchResult);
  }

  async cancel(batchId: string): Promise<BatchStatus> {
    return await (await this.#call('POST', `/v1/messages/batches/${encodeURIComponent(batchId)}/cancel`)).json() as BatchStatus;
  }

  /** Poll until processing_status is "ended". Most batches end within an hour; the API's maximum is 24 h. */
  async waitForEnd(batchId: string, pollMs: number, onPoll?: (s: BatchStatus) => void): Promise<BatchStatus> {
    for (;;) {
      let status: BatchStatus | null = null;
      try { status = await this.get(batchId); } catch (error) {
        const http = error instanceof AnthropicBatchHttpError ? error : null;
        if (http && http.status >= 400 && http.status < 500 && http.status !== 429) throw error; // a 404 means the batch is gone: do not spin
      }
      if (status) { onPoll?.(status); if (status.processing_status === 'ended') return status; }
      await this.#sleep(pollMs);
    }
  }
}
