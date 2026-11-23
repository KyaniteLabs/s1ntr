/**
 * Anthropic Message Batches price table: the ONE place the batch estimator and the actual-cost accounting read.
 * Batch pricing is 50% of standard on every token. USD per million tokens, prompts up to 100K tokens.
 * Source: platform.claude.com/docs/en/build-with-claude/batch-processing (read by the operator).
 */
export const ANTHROPIC_BATCH_PRICES_VERIFIED = '2026-11-18';
export const LONG_PROMPT_TOKENS = 100_000;

export interface BatchPrice {
  readonly family: string;
  readonly inUsdPerMTok: number;
  readonly outUsdPerMTok: number;
  /** Rates above LONG_PROMPT_TOKENS of prompt. Only listed where the docs gave them. */
  readonly longInUsdPerMTok?: number;
  readonly longOutUsdPerMTok?: number;
}

export const ANTHROPIC_BATCH_PRICES: readonly BatchPrice[] = [
  { family: 'claude-fable-5-2', inUsdPerMTok: 4, outUsdPerMTok: 20 },
  { family: 'claude-opus-5-5', inUsdPerMTok: 2, outUsdPerMTok: 10 },
  { family: 'claude-sonnet-5-5', inUsdPerMTok: 1, outUsdPerMTok: 5 },
  { family: 'claude-haiku-5-5', inUsdPerMTok: 0.05, outUsdPerMTok: 0.25, longInUsdPerMTok: 0.25, longOutUsdPerMTok: 1.25 },
];

/** Cache writes with the 1-hour TTL cost 2x the base input rate; reads cost 0.1x. The estimate assumes ZERO hits, so every cached token is a write. */
export const CACHE_WRITE_1H_MULTIPLIER = 2;
export const CACHE_READ_MULTIPLIER = 0.1;

export function batchPriceFor(model: string): BatchPrice {
  const id = model.toLowerCase();
  const hit = ANTHROPIC_BATCH_PRICES.find((p) => id === p.family || id.startsWith(`${p.family}-`));
  if (!hit) {
    throw new Error(`BATCH_MODEL_UNPRICED: "${model}" has no verified batch price (known: ${ANTHROPIC_BATCH_PRICES.map((p) => p.family).join(', ')}); `
      + `the lane refuses to spend on a model it cannot price`);
  }
  return hit;
}

export interface BatchUsage {
  readonly input_tokens?: number;
  readonly output_tokens?: number;
  readonly cache_creation_input_tokens?: number;
  readonly cache_read_input_tokens?: number;
}

/** Real cost of one request from its reported usage. Unknown long-prompt rates fall back to 2x the short rates (never under-counts). */
export function batchCostUsd(model: string, usage: BatchUsage): number {
  const p = batchPriceFor(model);
  const fresh = usage.input_tokens ?? 0;
  const written = usage.cache_creation_input_tokens ?? 0;
  const read = usage.cache_read_input_tokens ?? 0;
  const out = usage.output_tokens ?? 0;
  const long = fresh + written + read > LONG_PROMPT_TOKENS;
  const inRate = long ? (p.longInUsdPerMTok ?? p.inUsdPerMTok * 2) : p.inUsdPerMTok;
  const outRate = long ? (p.longOutUsdPerMTok ?? p.outUsdPerMTok * 2) : p.outUsdPerMTok;
  return (fresh * inRate + written * inRate * CACHE_WRITE_1H_MULTIPLIER + read * inRate * CACHE_READ_MULTIPLIER + out * outRate) / 1e6;
}

/** Worst-case cost of one request: zero cache hits, the whole cached prefix paid as a write, every output token used. */
export function worstCaseRequestUsd(model: string, input: { readonly inputTokens: number; readonly cachedPrefixTokens: number; readonly maxTokens: number }): number {
  const p = batchPriceFor(model);
  if (input.inputTokens > LONG_PROMPT_TOKENS && p.longInUsdPerMTok === undefined) {
    throw new Error(`BATCH_PROMPT_TOO_LONG: about ${input.inputTokens} input tokens is past ${LONG_PROMPT_TOKENS} and ${model} has no verified long-prompt batch price; shorten the brief or lower --batch-max-tokens`);
  }
  const long = input.inputTokens > LONG_PROMPT_TOKENS;
  const inRate = long ? p.longInUsdPerMTok! : p.inUsdPerMTok;
  const outRate = long ? p.longOutUsdPerMTok! : p.outUsdPerMTok;
  const cached = Math.min(input.cachedPrefixTokens, input.inputTokens);
  return ((input.inputTokens - cached) * inRate + cached * inRate * CACHE_WRITE_1H_MULTIPLIER + input.maxTokens * outRate) / 1e6;
}
