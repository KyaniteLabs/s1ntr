import { describe, expect, it } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import {
  createWave8EvidenceReceipt,
  createWave8ReleaseRoot,
  validateWave8ReleaseRoot,
  type Wave8EvidenceReceipt,
  type Wave8ReleaseRoot,
} from '../../../src/runtime-core/Wave8ReleaseRoot.js';
import {
  createCampaignAuthority,
  createCampaignReleaseRoot,
  InMemoryCampaignAdmissionStore,
} from '../../../src/runtime-core/CampaignOrigin.js';

const SOURCE = 'a'.repeat(64);
const SCHEMA = 'c'.repeat(64);
const IMPL = 'd'.repeat(64);

const PRD = new Set([
  'campaign-origin', 'actual-executor', 'creative-quality',
  'causal-revision', 'sealed-transfer', 'dream-recommendation',
]);

function receipt(kind: Wave8EvidenceReceipt['kind'], payload: Record<string, unknown> = {}): Wave8EvidenceReceipt {
  const isPrd = PRD.has(kind);
  return createWave8EvidenceReceipt({
    receiptId: `r-${kind}`, kind, generatedAt: '2026-08-01T00:00:00.000Z',
    sourceFingerprint: SOURCE, purpose: 'governed-product',
    evidenceClass: kind === 'deterministic-no-spend' ? 'deterministic-proof' : 'execution',
    passed: true, deterministic: kind === 'deterministic-no-spend',
    spendUsd: isPrd ? 0.01 : 0, providerCalls: isPrd ? 1 : 0,
    artifactDigests: ['e'.repeat(64)], schemaDigest: SCHEMA, implementationDigest: IMPL,
    payload: kind === 'deterministic-no-spend' ? { noSpend: true, ...payload } : payload,
  });
}

function productCompleteRoot(): Wave8ReleaseRoot {
  const receipts = [
    receipt('corpus', { complete: true, entries: ['a', 'b'], sourceDigests: ['f'.repeat(64)] }),
    receipt('product', { productDelta: {}, inheritedFrom: 'prior', priorReceiptId: 'prior', userVisible: true }),
    receipt('authority', {
      ownerVerified: true, transferBound: true, revocationChecked: true,
      ownerDecisionKinds: [
        'preference', 'release-worthiness', 'learning-authorization',
        'promotion', 'merge', 'release',
      ],
      ownerDecisionDigests: [
        'a'.repeat(64), 'b'.repeat(64), 'c'.repeat(64),
        'd'.repeat(64), 'e'.repeat(64), 'f'.repeat(64),
      ],
    }),
    receipt('exact-evidence'), receipt('graph-migration', {
      cycleDetected: false, migrationRoundTrip: true, graphDigest: '1'.repeat(64),
    }),
    receipt('idempotency', { duplicateEffectsAbsent: true }), receipt('schema-invalidation'),
    receipt('packed-install'), receipt('startup'), receipt('focused-checks'), receipt('build'),
    receipt('typecheck'), receipt('lint'), receipt('full-suite'), receipt('coverage'),
    receipt('deterministic-no-spend'), receipt('restart'),
    receipt('wave7-reproof', { reproved: true, sourceFingerprint: SOURCE }),
    receipt('campaign-origin', {
      coordinatorEmitted: true, campaignRootDigest: '2'.repeat(64),
      campaignRunId: 'campaign', originResultDigest: '3'.repeat(64),
    }),
    receipt('actual-executor', {
      coordinatorEmitted: true, resolvedProvider: 'openai', resolvedModel: 'kimi-k3',
      executorAttestationDigest: '4'.repeat(64),
    }),
    receipt('creative-quality', {
      coordinatorEmitted: true, qualityPassed: true, qualityEvidenceDigest: '5'.repeat(64),
    }),
    receipt('causal-revision', {
      coordinatorEmitted: true, revisionCount: 1, revisionEvidenceDigest: '6'.repeat(64),
    }),
    receipt('sealed-transfer', {
      coordinatorEmitted: true, transferSealed: true, transferSealDigest: '7'.repeat(64),
    }),
    receipt('dream-recommendation', {
      coordinatorEmitted: true, promote: false, autoPromote: false, path: 'B',
      recommendationDigest: '8'.repeat(64),
    }),
  ];
  return createWave8ReleaseRoot({
    generatedAt: '2026-08-01T00:00:00.000Z', releaseHead: 'b'.repeat(40),
    sourceFingerprint: SOURCE, activeDigests: { schema: SCHEMA, implementation: IMPL }, receipts,
  });
}

describe('wave8 product close gate (real validators)', () => {
  it('keeps admission red when campaign origin is required but missing', () => {
    const report = validateWave8ReleaseRoot(productCompleteRoot(), { requireCampaignOrigin: true });
    expect(report.ownerReleaseReady).toBe(false);
    expect(report.blockers.some(b => b.includes('product-campaign-origin-invalid'))).toBe(true);
  });

  it('admits only with trusted campaign root bound into product payload', async () => {
    const bootstrap = productCompleteRoot();
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const authority = createCampaignAuthority({
      keyId: 'host',
      privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
      admissionStore: new InMemoryCampaignAdmissionStore(),
    });
    const binding = {
      campaignRunId: 'campaign', rootRunId: 'run', manifestDigest: '8'.repeat(64),
      releaseHead: bootstrap.releaseHead, sourceFingerprint: bootstrap.sourceFingerprint,
      schemaDigest: bootstrap.activeDigests.schema,
      implementationDigest: bootstrap.activeDigests.implementation,
      wave8ReleaseRootDigest: bootstrap.releaseRootDigest,
    };
    const evidence = [{ receiptId: 'a1', kind: 'composition', resultDigest: '9'.repeat(64) }];
    const capability = await authority.admit(binding);
    const campaignRoot = createCampaignReleaseRoot(
      binding, evidence, await authority.finalize(capability, evidence),
    );
    const productIndex = bootstrap.receipts.findIndex(r => r.kind === 'product');
    const { schema: _s, schemaVersion: _v, resultDigest: _d, ...product } = bootstrap.receipts[productIndex]!;
    const receipts = [...bootstrap.receipts];
    receipts[productIndex] = createWave8EvidenceReceipt({
      ...product,
      payload: {
        ...product.payload,
        campaignRootDigest: campaignRoot.campaignRootDigest,
        campaignBootstrapRootDigest: bootstrap.releaseRootDigest,
      },
    });
    const finalRoot = createWave8ReleaseRoot({
      generatedAt: bootstrap.generatedAt, releaseHead: bootstrap.releaseHead,
      sourceFingerprint: bootstrap.sourceFingerprint, activeDigests: bootstrap.activeDigests,
      receipts,
    });
    const report = validateWave8ReleaseRoot(finalRoot, {
      requireCampaignOrigin: true,
      campaign: {
        releaseRoot: campaignRoot,
        trustedKeys: new Map([['host', publicKey.export({ type: 'spki', format: 'pem' }).toString()]]),
      },
    });
    expect(report.ownerReleaseReady).toBe(true);
    expect(report.blockers).toEqual([]);
  });
});
