/**
 * Funding truth helpers for W8C-03 (#716).
 *
 * Every transport carries {@link FundingTruth}. The terminal reasons for
 * subscription quota exhaustion and metered spend exhaustion are distinct and
 * must not be conflated. Subscription evidence binds the seat/resource-budget
 * digest and quota counters; metered evidence binds its current-price receipt
 * and an approved USD ceiling. `spendUsd: 0` is not accepted as deterministic
 * no-spend proof for either mode.
 */

import { createHash } from 'node:crypto';
import type { ExhaustionClass, FundingMode, FundingTruth, QuotaCounters, QuotaSurface } from './types.js';

/**
 * Build a seat digest from raw credential material without persisting the
 * secret. Callers must never log the input.
 */
export function computeSeatDigest(secret: string): string {
  return createHash('sha256').update(secret).digest('hex');
}

/**
 * Build a resource budget digest from a quota counters snapshot.
 */
export function computeResourceBudgetDigest(counters: QuotaCounters): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        calls: counters.calls,
        inputTokens: counters.inputTokens,
        outputTokens: counters.outputTokens,
        activeSeconds: counters.activeSeconds,
      }),
    )
    .digest('hex');
}

/**
 * Construct a subscription-seat {@link FundingTruth}. Requires the seat digest
 * and the current quota counters.
 */
export function subscriptionFunding(input: {
  seatDigest: string;
  quotaCounters: QuotaCounters;
  quotaSurface?: QuotaSurface;
}): FundingTruth {
  return {
    mode: 'subscription-seat',
    quotaSurface: input.quotaSurface ?? 'subscription-seat',
    seatDigest: input.seatDigest,
    resourceBudgetDigest: computeResourceBudgetDigest(input.quotaCounters),
    quotaCounters: Object.freeze({ ...input.quotaCounters }),
  };
}

/**
 * Construct a metered-api {@link FundingTruth}. Requires the current-price
 * receipt digest and the approved USD ceiling. The ceiling must be a positive
 * finite number; the spec forbids using `spendUsd: 0` as deterministic
 * no-spend proof.
 */
export function meteredFunding(input: {
  meteredReceiptDigest: string;
  approvedUsdCeiling: number;
  quotaCounters: QuotaCounters;
}): FundingTruth {
  if (!Number.isFinite(input.approvedUsdCeiling) || input.approvedUsdCeiling <= 0) {
    throw new Error(`METERED_CEILING_INVALID: approvedUsdCeiling must be positive finite (got ${input.approvedUsdCeiling})`);
  }
  return {
    mode: 'metered-api',
    quotaSurface: 'metered-api',
    meteredReceiptDigest: input.meteredReceiptDigest,
    approvedUsdCeiling: input.approvedUsdCeiling,
    quotaCounters: Object.freeze({ ...input.quotaCounters }),
  };
}

/**
 * Construct an offline-local {@link FundingTruth}. Used for LM Studio / Ollama
 * routes where no quota surface applies.
 */
export function offlineFunding(input: { quotaCounters: QuotaCounters }): FundingTruth {
  return {
    mode: 'offline-local',
    quotaSurface: 'local',
    quotaCounters: Object.freeze({ ...input.quotaCounters }),
  };
}

/**
 * Typed terminal reasons for funding exhaustion. Subscription quota
 * exhaustion and metered spend exhaustion are distinct.
 */
export type FundingTerminalReason =
  | { readonly class: 'subscription-quota-exhausted'; readonly quotaSurface: QuotaSurface; readonly resetTime?: string }
  | { readonly class: 'metered-spend-exhausted'; readonly approvedUsdCeiling: number }
  | { readonly class: 'rate-limited'; readonly quotaSurface: QuotaSurface }
  | { readonly class: 'seat-unavailable'; readonly quotaSurface: QuotaSurface }
  | { readonly class: 'capacity-unknown'; readonly quotaSurface: QuotaSurface };

/**
 * Map a {@link FundingMode} + exhaustion class to a terminal reason. The
 * mapping is total — unknown combinations resolve to `capacity-unknown`.
 */
export function terminalReasonForExhaustion(
  mode: FundingMode,
  exhaustion: ExhaustionClass,
  options?: { quotaSurface?: QuotaSurface; resetTime?: string; approvedUsdCeiling?: number },
): FundingTerminalReason {
  if (exhaustion === 'subscription-quota-exhausted' || (mode === 'subscription-seat' && exhaustion === 'seat-unavailable')) {
    return {
      class: 'subscription-quota-exhausted',
      quotaSurface: options?.quotaSurface ?? 'subscription-seat',
      resetTime: options?.resetTime,
    };
  }
  if (exhaustion === 'metered-spend-exhausted') {
    return {
      class: 'metered-spend-exhausted',
      approvedUsdCeiling: options?.approvedUsdCeiling ?? 0,
    };
  }
  if (exhaustion === 'rate-limited') {
    return { class: 'rate-limited', quotaSurface: options?.quotaSurface ?? 'metered-api' };
  }
  if (exhaustion === 'seat-unavailable') {
    return { class: 'seat-unavailable', quotaSurface: options?.quotaSurface ?? 'cliproxy-seat' };
  }
  return { class: 'capacity-unknown', quotaSurface: options?.quotaSurface ?? 'metered-api' };
}

/**
 * Predicate: does the funding truth satisfy the W8C-03 evidence rule that
 * `spendUsd: 0` is not deterministic no-spend proof? Subscription must bind
 * seat digest + counters; metered must bind receipt + positive ceiling.
 */
export function isFundingTruthComplete(funding: FundingTruth): boolean {
  if (funding.mode === 'subscription-seat') {
    return Boolean(funding.seatDigest) && Boolean(funding.resourceBudgetDigest);
  }
  if (funding.mode === 'metered-api') {
    return (
      Boolean(funding.meteredReceiptDigest) &&
      typeof funding.approvedUsdCeiling === 'number' &&
      Number.isFinite(funding.approvedUsdCeiling) &&
      funding.approvedUsdCeiling > 0
    );
  }
  return true;
}
