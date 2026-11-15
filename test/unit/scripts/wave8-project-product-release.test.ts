import { describe, expect, it } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import {
  createWave8EvidenceReceipt,
  createWave8ReleaseRoot,
  validateWave8ReleaseRoot,
} from '../../../src/runtime-core/Wave8ReleaseRoot.js';
import {
  createCampaignAuthority,
  createCampaignReleaseRoot,
  InMemoryCampaignAdmissionStore,
} from '../../../src/runtime-core/CampaignOrigin.js';

const SOURCE = 'a'.repeat(64);
const SCHEMA = 'c'.repeat(64);
const IMPL = 'd'.repeat(64);

describe('wave8 product projection contract (anti-theater)', () => {
  it('ownerVerified without decision digests keeps authority-complete red', async () => {
    const quality = createWave8ReleaseRoot({
      generatedAt: '2026-08-01T00:00:00.000Z',
      releaseHead: 'b'.repeat(40),
      sourceFingerprint: SOURCE,
      activeDigests: { schema: SCHEMA, implementation: IMPL },
      receipts: [
        createWave8EvidenceReceipt({
          receiptId: 'q-build', kind: 'build', generatedAt: '2026-08-01T00:00:00.000Z',
          sourceFingerprint: SOURCE, purpose: 'diagnostic', evidenceClass: 'deterministic-proof',
          passed: true, deterministic: true, spendUsd: 0, providerCalls: 0,
          artifactDigests: ['e'.repeat(64)], schemaDigest: SCHEMA, implementationDigest: IMPL,
          payload: {},
        }),
      ],
    });
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const authority = createCampaignAuthority({
      keyId: 'host',
      privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
      admissionStore: new InMemoryCampaignAdmissionStore(),
    });
    const binding = {
      campaignRunId: 'c1', rootRunId: 'r1', manifestDigest: '8'.repeat(64),
      releaseHead: quality.releaseHead, sourceFingerprint: quality.sourceFingerprint,
      schemaDigest: quality.activeDigests.schema,
      implementationDigest: quality.activeDigests.implementation,
      wave8ReleaseRootDigest: quality.releaseRootDigest,
    };
    const evidence = [{ receiptId: 'e1', kind: 'composition', resultDigest: '9'.repeat(64) }];
    const cap = await authority.admit(binding);
    const origin = await authority.finalize(cap, evidence);
    const campaignRoot = createCampaignReleaseRoot(binding, evidence, origin);
    // Theater: purpose governed-product but zero calls and no coordinatorEmitted
    const product = createWave8EvidenceReceipt({
      receiptId: 'product:c1', kind: 'product', generatedAt: '2026-08-01T00:00:00.000Z',
      sourceFingerprint: SOURCE, purpose: 'governed-product', evidenceClass: 'execution',
      passed: true, deterministic: false, spendUsd: 0, providerCalls: 0,
      artifactDigests: [campaignRoot.campaignRootDigest], schemaDigest: SCHEMA,
      implementationDigest: IMPL,
      payload: {
        productDelta: {}, inheritedFrom: 'campaign-origin:c1', priorReceiptId: 'campaign-origin:c1',
        userVisible: true, campaignRootDigest: campaignRoot.campaignRootDigest,
        campaignBootstrapRootDigest: quality.releaseRootDigest,
      },
    });
    const authorityR = createWave8EvidenceReceipt({
      receiptId: 'authority:c1', kind: 'authority', generatedAt: '2026-08-01T00:00:00.000Z',
      sourceFingerprint: SOURCE, purpose: 'governed-product', evidenceClass: 'execution',
      passed: true, deterministic: false, spendUsd: 0, providerCalls: 0,
      artifactDigests: [campaignRoot.campaignRootDigest], schemaDigest: SCHEMA,
      implementationDigest: IMPL,
      // Lying green pattern: ownerVerified true without decision digests
      payload: { ownerVerified: true, transferBound: true, revocationChecked: true },
    });
    const finalRoot = createWave8ReleaseRoot({
      generatedAt: quality.generatedAt, releaseHead: quality.releaseHead,
      sourceFingerprint: quality.sourceFingerprint, activeDigests: quality.activeDigests,
      receipts: [...quality.receipts, product, authorityR],
    });
    const report = validateWave8ReleaseRoot(finalRoot, {
      requireCampaignOrigin: true,
      campaign: {
        releaseRoot: campaignRoot,
        trustedKeys: new Map([['host', publicKey.export({ type: 'spki', format: 'pem' }).toString()]]),
      },
    });
    expect(report.ownerReleaseReady).toBe(false);
    expect(report.conjuncts.find(c => c.id === 'authority-complete')?.failures)
      .toContain('authority-owner-packets-incomplete');
  });
});
