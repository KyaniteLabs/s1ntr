import { describe, it, expect } from 'vitest';
import {
  computeResourceBudgetDigest,
  isFundingTruthComplete,
  meteredFunding,
  offlineFunding,
  subscriptionFunding,
  terminalReasonForExhaustion,
} from '../../../src/identity/fundingTruth.js';

describe('FundingTruth', () => {
  it('subscription funding binds seat digest + quota counters', () => {
    const funding = subscriptionFunding({
      seatDigest: 'seat-abc',
      quotaCounters: { calls: 1, inputTokens: 10, outputTokens: 5, activeSeconds: 1 },
    });
    expect(funding.mode).toBe('subscription-seat');
    expect(funding.seatDigest).toBe('seat-abc');
    expect(funding.resourceBudgetDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(isFundingTruthComplete(funding)).toBe(true);
  });

  it('metered funding requires a positive USD ceiling (rejects spendUsd:0-only proof)', () => {
    expect(() =>
      meteredFunding({
        meteredReceiptDigest: 'rec-xyz',
        approvedUsdCeiling: 0,
        quotaCounters: { calls: 0, inputTokens: 0, outputTokens: 0, activeSeconds: 0 },
      }),
    ).toThrow(/CEILING_INVALID/);
    const funding = meteredFunding({
      meteredReceiptDigest: 'rec-xyz',
      approvedUsdCeiling: 10,
      quotaCounters: { calls: 0, inputTokens: 0, outputTokens: 0, activeSeconds: 0 },
    });
    expect(funding.mode).toBe('metered-api');
    expect(funding.approvedUsdCeiling).toBe(10);
    expect(isFundingTruthComplete(funding)).toBe(true);
  });

  it('metered funding with NaN ceiling is rejected', () => {
    expect(() =>
      meteredFunding({
        meteredReceiptDigest: 'rec',
        approvedUsdCeiling: Number.NaN,
        quotaCounters: { calls: 0, inputTokens: 0, outputTokens: 0, activeSeconds: 0 },
      }),
    ).toThrow(/CEILING_INVALID/);
  });

  it('offline funding is always complete (no quota surface)', () => {
    const funding = offlineFunding({
      quotaCounters: { calls: 0, inputTokens: 0, outputTokens: 0, activeSeconds: 0 },
    });
    expect(funding.mode).toBe('offline-local');
    expect(isFundingTruthComplete(funding)).toBe(true);
  });

  it('subscription quota exhaustion and metered spend exhaustion are distinct terminal reasons', () => {
    const sub = terminalReasonForExhaustion('subscription-seat', 'subscription-quota-exhausted', {
      quotaSurface: 'subscription-seat',
      resetTime: '2026-09-01T00:00:00Z',
    });
    const met = terminalReasonForExhaustion('metered-api', 'metered-spend-exhausted', {
      approvedUsdCeiling: 10,
    });
    expect(sub.class).toBe('subscription-quota-exhausted');
    expect(met.class).toBe('metered-spend-exhausted');
    expect(sub.class).not.toBe(met.class);
  });

  it('resource budget digest is deterministic', () => {
    const a = computeResourceBudgetDigest({ calls: 1, inputTokens: 10, outputTokens: 5, activeSeconds: 2 });
    const b = computeResourceBudgetDigest({ calls: 1, inputTokens: 10, outputTokens: 5, activeSeconds: 2 });
    const c = computeResourceBudgetDigest({ calls: 2, inputTokens: 10, outputTokens: 5, activeSeconds: 2 });
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });

  it('rate-limited is its own class', () => {
    const reason = terminalReasonForExhaustion('metered-api', 'rate-limited');
    expect(reason.class).toBe('rate-limited');
  });
});
