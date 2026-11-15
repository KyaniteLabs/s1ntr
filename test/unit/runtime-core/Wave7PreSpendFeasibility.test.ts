import { describe, expect, it } from 'vitest';
import {
  createDefaultWave7DeclaredRuns,
  createFrozenDomainManifest,
  createPreExistingQueueManifest,
  createWave7ReleaseEvidenceManifest,
} from '../../../src/runtime-core/Wave7ReleaseContract.js';
import {
  buildWave7PreSpendFeasibility,
  type Wave7PriceReceipt,
} from '../../../src/runtime-core/Wave7PreSpendFeasibility.js';

const HEAD = 'a'.repeat(40);
const HASH = 'b'.repeat(64);

function manifest() {
  const domains = createFrozenDomainManifest(['p5', 'tone']);
  return createWave7ReleaseEvidenceManifest({
    generatedAt: '2026-07-31T00:00:00.000Z', baselineHead: HEAD,
    releaseHead: HEAD, sourceFingerprint: HASH, tourId: 'tour',
    tourWaveId: `wave-7@${HEAD.slice(0, 8)}`, domainManifest: domains,
    queueManifest: createPreExistingQueueManifest([]),
    declaredRuns: createDefaultWave7DeclaredRuns(domains.entries, HEAD),
    ownerApprovedUsdCeiling: 100,
  });
}

function prices(): Wave7PriceReceipt {
  const routes = [
    ['harness', 'openai', 'gpt-5.6-sol', 'high'],
    ['creative', 'openai', 'gpt-5.6-luna', 'max'],
    ['creativeEvaluator', 'xai', 'grok', 'high'],
    ['productReviewer', 'openai', 'gpt-5.6-terra', 'high'],
  ].map(([role, provider, model, effort]) => ({
    role, provider, model, effort, pipe: `verified-${role}-pipe`, identityVerified: true,
  })) as Wave7PriceReceipt['routes'];
  return {
    schemaVersion: 1, generatedAt: '2026-07-31T00:00:00.000Z', routes,
    prices: routes.map(route => ({
      provider: route.provider, model: route.model,
      inputUsdPerMillion: 1, outputUsdPerMillion: 2,
      sourceUrl: 'https://provider.example/pricing',
      verifiedAt: '2026-07-31T00:00:00.000Z',
    })),
  };
}

function requestDigests() {
  return { 'sol-bootstrap': 'c'.repeat(64), 'sol-confirm': 'd'.repeat(64) };
}

describe('Wave7PreSpendFeasibility', () => {
  it('maps every frozen release run to priced paid-call slots', () => {
    const frozen = manifest();
    const result = buildWave7PreSpendFeasibility({
      manifest: frozen, planHash: 'e'.repeat(64), priceReceipt: prices(),
      bootstrapRequestDigests: requestDigests(),
    });
    expect(result.proof.passed).toBe(true);
    expect(result.proof.totals.calls).toBeLessThanOrEqual(120);
    for (const run of frozen.declaredRuns) {
      expect(result.declaredSlots.some(slot => slot.releaseRunSlotId === run.id)).toBe(true);
    }
  });

  it.each([
    ['unknown price', (value: Wave7PriceReceipt) => { value.prices.pop(); }],
    ['unverified route', (value: Wave7PriceReceipt) => { value.routes[0].identityVerified = false; }],
    ['missing route pipe', (value: Wave7PriceReceipt) => { value.routes[0].pipe = ''; }],
    ['wrong frozen model', (value: Wave7PriceReceipt) => { value.routes[1].model = 'cheap-substitute'; }],
  ])('fails closed on %s', (_label, mutate) => {
    const receipt = prices();
    mutate(receipt);
    const result = buildWave7PreSpendFeasibility({
      manifest: manifest(), planHash: 'e'.repeat(64), priceReceipt: receipt,
      bootstrapRequestDigests: requestDigests(),
    });
    expect(result.proof.passed).toBe(false);
  });

  it('requires exact request digests for both Sol bootstrap calls', () => {
    const result = buildWave7PreSpendFeasibility({
      manifest: manifest(), planHash: 'e'.repeat(64), priceReceipt: prices(),
      bootstrapRequestDigests: { 'sol-bootstrap': 'c'.repeat(64) },
    });
    expect(result.proof.passed).toBe(false);
    expect(result.failures.join(' ')).toContain('sol-confirm');
  });
});
