import { describe, expect, it } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import {
  WAVE8_PLANTED_NEGATIVE_IDS,
  WAVE8_PLANTED_NEGATIVES,
  WAVE8_RELEASE_CONJUNCT_IDS,
  auditWave8CurrentAuthority,
  compareWave8ReleaseRootTruth,
  createWave8EvidenceReceipt,
  createWave8ReleaseRoot,
  parseWave8ReleaseRoot,
  requireCurrentWave8ReceiptSource,
  validateWave8ReleaseRoot,
  type Wave8EvidenceReceipt,
  type Wave8ReleaseRoot,
} from '../../../src/runtime-core/Wave8ReleaseRoot.js';
import { createCampaignAuthority, createCampaignReleaseRoot, InMemoryCampaignAdmissionStore } from '../../../src/runtime-core/CampaignOrigin.js';

const SOURCE = 'a'.repeat(64);
const SCHEMA_DIGEST = 'c'.repeat(64);
const IMPLEMENTATION_DIGEST = 'd'.repeat(64);

const PRD = new Set([
  'campaign-origin', 'actual-executor', 'creative-quality',
  'causal-revision', 'sealed-transfer', 'dream-recommendation',
]);

function receipt(kind: Wave8EvidenceReceipt['kind'], payload: Record<string, unknown> = {}): Wave8EvidenceReceipt {
  const isPrd = PRD.has(kind);
  return createWave8EvidenceReceipt({
    receiptId: `receipt-${kind}`, kind, generatedAt: '2026-08-01T00:00:00.000Z', sourceFingerprint: SOURCE,
    purpose: 'governed-product',
    evidenceClass: kind === 'deterministic-no-spend' ? 'deterministic-proof' : 'execution',
    passed: true,
    deterministic: kind === 'deterministic-no-spend',
    // PRD kinds require real provider execution; zero-call theater is fail-closed.
    spendUsd: isPrd ? 0.01 : 0,
    providerCalls: isPrd ? 1 : 0,
    artifactDigests: ['e'.repeat(64)], schemaDigest: SCHEMA_DIGEST,
    implementationDigest: IMPLEMENTATION_DIGEST,
    payload: kind === 'deterministic-no-spend' ? { noSpend: true, ...payload } : payload,
  });
}

function validRoot(): Wave8ReleaseRoot {
  const receipts = [
    receipt('corpus', { complete: true, entries: ['alpha', 'beta'], sourceDigests: ['f'.repeat(64)] }),
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
    receipt('exact-evidence', { exact: true }), receipt('graph-migration', {
      cycleDetected: false, migrationRoundTrip: true, graphDigest: '1'.repeat(64),
    }),
    receipt('idempotency', { duplicateEffectsAbsent: true }), receipt('schema-invalidation'),
    receipt('packed-install'), receipt('startup'), receipt('focused-checks'), receipt('build'),
    receipt('typecheck'), receipt('lint'), receipt('full-suite'), receipt('coverage'),
    receipt('deterministic-no-spend'), receipt('restart'),
    receipt('wave7-reproof', { reproved: true, sourceFingerprint: SOURCE }),
    // PRD six product-path kinds (W8C-02) — coordinator-emitted + execution-backed
    receipt('campaign-origin', {
      coordinatorEmitted: true,
      campaignRootDigest: '2'.repeat(64), campaignRunId: 'campaign-test',
      originResultDigest: '3'.repeat(64),
    }),
    receipt('actual-executor', {
      coordinatorEmitted: true,
      resolvedProvider: 'openai', resolvedModel: 'kimi-k3',
      executorAttestationDigest: '4'.repeat(64),
    }),
    receipt('creative-quality', {
      coordinatorEmitted: true,
      qualityPassed: true, qualityScore: 0.8,
      qualityEvidenceDigest: '5'.repeat(64),
    }),
    receipt('causal-revision', {
      coordinatorEmitted: true,
      revisionCount: 1, causalSignalPresent: true,
      revisionEvidenceDigest: '6'.repeat(64),
    }),
    receipt('sealed-transfer', {
      coordinatorEmitted: true,
      transferSealed: true,
      transferSealDigest: '7'.repeat(64),
    }),
    receipt('dream-recommendation', {
      coordinatorEmitted: true,
      promote: false, autoPromote: false, path: 'B',
      recommendationDigest: '8'.repeat(64),
    }),
  ];
  return createWave8ReleaseRoot({ generatedAt: '2026-08-01T00:00:00.000Z', releaseHead: 'b'.repeat(40),
    sourceFingerprint: SOURCE, activeDigests: { schema: SCHEMA_DIGEST, implementation: IMPLEMENTATION_DIGEST }, receipts });
}

function receiptFor(root: Wave8ReleaseRoot, kind: Wave8EvidenceReceipt['kind']): Wave8EvidenceReceipt {
  return root.receipts.find(item => item.kind === kind)!;
}

function rehashedRootWithNoSpendMutation(
  mutate: (body: Record<string, unknown>) => void,
): Wave8ReleaseRoot {
  const root = validRoot();
  const index = root.receipts.findIndex(item => item.kind === 'deterministic-no-spend');
  const { schema: _schema, schemaVersion: _schemaVersion, resultDigest: _digest, ...input } = root.receipts[index];
  const body = structuredClone(input) as unknown as Record<string, unknown>;
  mutate(body);
  root.receipts[index] = createWave8EvidenceReceipt(
    body as Parameters<typeof createWave8EvidenceReceipt>[0],
  );
  const { schema: _rootSchema, schemaVersion: _rootVersion, wave: _wave,
    releaseRootDigest: _rootDigest, ...rootInput } = root;
  return createWave8ReleaseRoot(rootInput);
}

describe('Wave8ReleaseRoot', () => {
  it('passes the exhaustive receipt-derived root and exposes exactly 78 named negatives', () => {
    const root = validRoot();
    const report = validateWave8ReleaseRoot(root);
    expect(report.ownerReleaseReady).toBe(true);
    expect(report.conjuncts.map(item => item.id)).toEqual(WAVE8_RELEASE_CONJUNCT_IDS);
    expect(report.blockers).toEqual([]);
    expect(WAVE8_PLANTED_NEGATIVES).toHaveLength(78);
    expect(WAVE8_PLANTED_NEGATIVE_IDS).toHaveLength(78);
    expect(new Set(WAVE8_PLANTED_NEGATIVE_IDS).size).toBe(78);
  });

  it('fails PRD kinds that are purpose=governed-product but not coordinator execution-backed', () => {
    const root = validRoot();
    const idx = root.receipts.findIndex(item => item.kind === 'creative-quality');
    const { schema: _s, schemaVersion: _v, resultDigest: _d, ...body } = root.receipts[idx]!;
    const receipts = [...root.receipts];
    receipts[idx] = createWave8EvidenceReceipt({
      ...body,
      providerCalls: 0,
      spendUsd: 0,
      payload: { qualityPassed: true, qualityScore: 1, coordinatorEmitted: false },
    });
    const report = validateWave8ReleaseRoot(createWave8ReleaseRoot({
      generatedAt: root.generatedAt,
      releaseHead: root.releaseHead,
      sourceFingerprint: root.sourceFingerprint,
      activeDigests: root.activeDigests,
      receipts,
    }));
    expect(report.conjuncts.find(c => c.id === 'creative-quality')?.passed).toBe(false);
    expect(report.conjuncts.find(c => c.id === 'creative-quality')?.failures)
      .toEqual(expect.arrayContaining(['creative-quality-not-execution-backed']));
  });

  it('fails authority when ownerVerified lacks discrete owner decision digests', () => {
    const root = validRoot();
    const idx = root.receipts.findIndex(item => item.kind === 'authority');
    root.receipts[idx]!.payload = {
      ownerVerified: true, transferBound: true, revocationChecked: true,
    };
    const report = validateWave8ReleaseRoot(root);
    expect(report.conjuncts.find(c => c.id === 'authority-complete')?.failures)
      .toContain('authority-owner-packets-incomplete');
  });

  it('keeps dream-recommendation red when path-B promote flags are not both false', () => {
    const root = validRoot();
    const idx = root.receipts.findIndex(item => item.kind === 'dream-recommendation');
    const { schema: _s, schemaVersion: _v, resultDigest: _d, ...body } = root.receipts[idx]!;
    const receipts = [...root.receipts];
    receipts[idx] = createWave8EvidenceReceipt({
      ...body,
      payload: { promote: true, autoPromote: false, path: 'B' },
    });
    const report = validateWave8ReleaseRoot(createWave8ReleaseRoot({
      generatedAt: root.generatedAt,
      releaseHead: root.releaseHead,
      sourceFingerprint: root.sourceFingerprint,
      activeDigests: root.activeDigests,
      receipts,
    }));
    expect(report.conjuncts.find(c => c.id === 'dream-recommendation')?.passed).toBe(false);
    expect(report.conjuncts.find(c => c.id === 'dream-recommendation')?.failures)
      .toContain('dream-recommendation-path-b-violated');
  });

  it('keeps canonical release readiness red without a trusted signed campaign origin', () => {
    const report = validateWave8ReleaseRoot(validRoot(), { requireCampaignOrigin: true });
    expect(report.ownerReleaseReady).toBe(false);
    expect(report.blockers).toContain('product-complete: product-campaign-origin-invalid');
  });

  it('promotes the final root only when it anchors a trusted campaign bound to the bootstrap root', async () => {
    const bootstrap = validRoot();
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const authority = createCampaignAuthority({ keyId: 'host',
      privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
      admissionStore: new InMemoryCampaignAdmissionStore() });
    const binding = { campaignRunId: 'campaign', rootRunId: 'run', manifestDigest: '8'.repeat(64),
      releaseHead: bootstrap.releaseHead, sourceFingerprint: bootstrap.sourceFingerprint,
      schemaDigest: bootstrap.activeDigests.schema, implementationDigest: bootstrap.activeDigests.implementation,
      wave8ReleaseRootDigest: bootstrap.releaseRootDigest };
    const evidence = [{ receiptId: 'campaign-artifact', kind: 'composition', resultDigest: '9'.repeat(64) }];
    const capability = await authority.admit(binding);
    const campaignRoot = createCampaignReleaseRoot(binding, evidence, await authority.finalize(capability, evidence));
    const productIndex = bootstrap.receipts.findIndex(item => item.kind === 'product');
    const { schema: _schema, schemaVersion: _version, resultDigest: _digest, ...product } = bootstrap.receipts[productIndex];
    const receipts = [...bootstrap.receipts];
    receipts[productIndex] = createWave8EvidenceReceipt({ ...product, payload: { ...product.payload,
      campaignRootDigest: campaignRoot.campaignRootDigest,
      campaignBootstrapRootDigest: bootstrap.releaseRootDigest } });
    const finalRoot = createWave8ReleaseRoot({ generatedAt: bootstrap.generatedAt,
      releaseHead: bootstrap.releaseHead, sourceFingerprint: bootstrap.sourceFingerprint,
      activeDigests: bootstrap.activeDigests, receipts });
    expect(validateWave8ReleaseRoot(finalRoot, { requireCampaignOrigin: true,
      campaign: { releaseRoot: campaignRoot, trustedKeys: new Map([['host', publicKey.export({ type: 'spki', format: 'pem' }).toString()]]) } }).ownerReleaseReady).toBe(true);
  });

  it('keeps diagnostic and legacy receipts readable without promoting them as product evidence', () => {
    for (const purpose of ['diagnostic', undefined] as const) {
      const root = validRoot();
      for (const kind of ['product', 'authority', 'exact-evidence'] as const) {
        const index = root.receipts.findIndex(item => item.kind === kind);
        const { schema: _schema, schemaVersion: _version, resultDigest: _digest, ...input } = root.receipts[index];
        root.receipts[index] = createWave8EvidenceReceipt({ ...input, purpose });
      }
      const { schema: _schema, schemaVersion: _version, wave: _wave,
        releaseRootDigest: _digest, ...input } = root;
      const serialized = JSON.parse(JSON.stringify(createWave8ReleaseRoot(input))) as unknown;
      const readable = parseWave8ReleaseRoot(serialized);
      const report = validateWave8ReleaseRoot(readable);
      expect(report.ownerReleaseReady).toBe(false);
      expect(report.blockers).toEqual(expect.arrayContaining([
        'product-complete: product-evidence-purpose-invalid',
        'authority-complete: authority-evidence-purpose-invalid',
        'exact-evidence: exact-evidence-purpose-invalid',
      ]));
    }
  });

  it('rejects a stale current-wave pointer with actionable failures', () => {
    expect(auditWave8CurrentAuthority('## Wave 8 planning start\nRead issue #462 next.')).toEqual({
      passed: false,
      failures: [
        'CURRENT.md does not point to the Wave 8 release root',
        'CURRENT.md does not point to the approved Wave 8 closure plan',
        'CURRENT.md does not name the W8C-01 through W8C-09 implementation range',
        'CURRENT.md still presents Wave 8 as an unstarted planning task',
        'CURRENT.md does not mark issue #462 as historical',
      ],
    });
    expect(auditWave8CurrentAuthority([
      '.quality/wave-8/release/release-root.json',
      '.omx/plans/prd-wave8-closure-wave9-admission.md',
      '#714 through #722',
      'Issue #462 is historical narrow subsystem work.',
    ].join('\n'))).toEqual({ passed: true, failures: [] });
  });

  it('rejects forged or incomplete readiness projections before comparing surfaces', () => {
    const forged = { schemaVersion: 1, wave: 8, releaseRootDigest: 'forged',
      releaseHead: null, sourceFingerprint: null, ownerReleaseReady: true,
      conjuncts: [], blockers: [], receiptCount: 0 };
    const report = forged as unknown as ReturnType<typeof validateWave8ReleaseRoot>;
    expect(compareWave8ReleaseRootTruth([report, report, report])).toEqual({ passed: false, failures: [
      'report 1 is invalid: Wave 8 readiness report release root digest is invalid',
      'report 2 is invalid: Wave 8 readiness report release root digest is invalid',
      'report 3 is invalid: Wave 8 readiness report release root digest is invalid',
    ] });
  });

  it.each([
    ['releaseHead', 'f'.repeat(40)],
    ['sourceFingerprint', 'f'.repeat(64)],
    ['receiptCount', 999],
  ] as const)('rejects %s drift between current-source surfaces', (field, value) => {
    const report = validateWave8ReleaseRoot(validRoot());
    const drifted = { ...structuredClone(report), [field]: value };
    expect(compareWave8ReleaseRootTruth([report, drifted, report])).toEqual({
      passed: false, failures: ['report 2 disagrees with report 1'],
    });
  });

  it('binds every receipt to the same source and rejects deterministic live evidence', () => {
    const root = validRoot();
    const receipt = receiptFor(root, 'deterministic-no-spend');
    receipt.evidenceClass = 'live';
    const report = validateWave8ReleaseRoot(root, { currentSourceFingerprint: 'f'.repeat(64) });
    expect(report.ownerReleaseReady).toBe(false);
    expect(report.conjuncts.find(item => item.id === 'source-fingerprint')?.failures).toEqual(
      expect.arrayContaining(['source-fingerprint-drift', 'deterministic-no-spend-labeled-live']),
    );
  });

  it('rejects schema and implementation drift in affected receipts', () => {
    const root = validRoot();
    receiptFor(root, 'authority').schemaDigest = 'f'.repeat(64);
    receiptFor(root, 'product').implementationDigest = 'f'.repeat(64);
    const report = validateWave8ReleaseRoot(root);
    const failures = report.conjuncts.find(item => item.id === 'schema-implementation-invalidation')!.failures;
    expect(failures).toEqual(expect.arrayContaining(['schema-digest-drift', 'implementation-digest-drift']));
  });

  it('rejects tampered receipt bytes before readiness can be claimed', () => {
    const tampered = structuredClone(validRoot());
    tampered.receipts[0].passed = false;
    expect(() => parseWave8ReleaseRoot(tampered)).toThrow('receipt');
  });

  it.each([
    ['deterministic=false', (body: Record<string, unknown>) => { body.deterministic = false; }],
    ['nonzero spend', (body: Record<string, unknown>) => { body.spendUsd = 19.99; }],
    ['provider call', (body: Record<string, unknown>) => { body.providerCalls = 1; }],
    ['wrong evidence class', (body: Record<string, unknown>) => { body.evidenceClass = 'execution'; }],
    ['missing noSpend proof', (body: Record<string, unknown>) => { body.payload = { noSpend: false }; }],
  ])('rejects rehashed deterministic proof with %s in source and quality gates', (_label, mutate) => {
    const root = parseWave8ReleaseRoot(rehashedRootWithNoSpendMutation(mutate));
    const report = validateWave8ReleaseRoot(root);
    expect(report.conjuncts.find(item => item.id === 'source-fingerprint')?.failures)
      .toContain('deterministic-no-spend-invalid');
    expect(report.conjuncts.find(item => item.id === 'quality-and-install')?.failures)
      .toContain('deterministic-no-spend-invalid');
  });

  it.each([
    ['kind', 'not-a-kind'], ['evidenceClass', 'not-evidence'],
    ['passed', 'true'], ['deterministic', 1], ['purpose', 'generic'],
  ])('rejects a rehashed receipt with invalid runtime %s', (field, value) => {
    const root = rehashedRootWithNoSpendMutation(body => { body[field] = value; });
    expect(() => parseWave8ReleaseRoot(root)).toThrow('receipt');
  });

  it('refuses stale or mixed receipt sources before a release root can be built', () => {
    const root = validRoot();
    expect(requireCurrentWave8ReceiptSource(root.receipts, SOURCE)).toBe(SOURCE);
    expect(() => requireCurrentWave8ReceiptSource(root.receipts, 'f'.repeat(64)))
      .toThrow('current repository source');

    const mixed = rehashedRootWithNoSpendMutation(body => { body.sourceFingerprint = 'f'.repeat(64); });
    expect(() => requireCurrentWave8ReceiptSource(mixed.receipts, SOURCE))
      .toThrow('one source fingerprint');
  });

  it.each(WAVE8_PLANTED_NEGATIVE_IDS)('makes the owning conjunct red for planted negative %s', (negativeId) => {
    const root = validRoot();
    plantNegative(root, negativeId);
    const report = validateWave8ReleaseRoot(root);
    const owner = WAVE8_PLANTED_NEGATIVES.find(item => item.id === negativeId)!.owningConjunct;
    expect(report.conjuncts.find(item => item.id === owner)?.passed).toBe(false);
  });
});

function removeReceipt(root: Wave8ReleaseRoot, kind: Wave8EvidenceReceipt['kind']): void {
  root.receipts = root.receipts.filter(item => item.kind !== kind);
}

function plantNegative(root: Wave8ReleaseRoot, id: string): void {
  const setPassed = (kind: Wave8EvidenceReceipt['kind']) => { receiptFor(root, kind).passed = false; };
  const payload = (kind: Wave8EvidenceReceipt['kind'], key: string, value: unknown) => { receiptFor(root, kind).payload[key] = value; };
  switch (id) {
    case 'missing-corpus-receipt': return removeReceipt(root, 'corpus');
    case 'corpus-not-passed': return setPassed('corpus');
    case 'corpus-incomplete': return payload('corpus', 'complete', false);
    case 'corpus-source-digest-missing': return payload('corpus', 'sourceDigests', []);
    case 'corpus-duplicate-entry': return payload('corpus', 'entries', ['alpha', 'alpha']);
    case 'missing-product-receipt': return removeReceipt(root, 'product');
    case 'product-not-passed': return setPassed('product');
    case 'product-delta-missing': return payload('product', 'productDelta', null);
    case 'product-lineage-mismatch': return payload('product', 'priorReceiptId', 'other');
    case 'product-user-visible-missing': return payload('product', 'userVisible', false);
    case 'product-evidence-purpose-invalid': receiptFor(root, 'product').purpose = 'diagnostic'; return;
    case 'missing-authority-receipt': return removeReceipt(root, 'authority');
    case 'authority-not-passed': return setPassed('authority');
    case 'authority-owner-unverified': return payload('authority', 'ownerVerified', false);
    case 'authority-transfer-unbound': return payload('authority', 'transferBound', false);
    case 'authority-revocation-unchecked': return payload('authority', 'revocationChecked', false);
    case 'authority-evidence-purpose-invalid': receiptFor(root, 'authority').purpose = 'diagnostic'; return;
    case 'authority-owner-packets-incomplete':
      return payload('authority', 'ownerDecisionDigests', []);
    case 'missing-exact-evidence': return removeReceipt(root, 'exact-evidence');
    case 'exact-evidence-not-passed': return setPassed('exact-evidence');
    case 'exact-receipt-digest-missing': receiptFor(root, 'exact-evidence').resultDigest = ''; return;
    case 'exact-evidence-duplicate': root.receipts.push({ ...receiptFor(root, 'exact-evidence') }); return;
    case 'exact-evidence-class-invalid': receiptFor(root, 'exact-evidence').evidenceClass = 'planned'; return;
    case 'exact-evidence-purpose-invalid': receiptFor(root, 'exact-evidence').purpose = 'diagnostic'; return;
    default: return plantNegativeLater(root, id);
  }
}

function plantNegativeLater(root: Wave8ReleaseRoot, id: string): void {
  const setPassed = (kind: Wave8EvidenceReceipt['kind']) => { receiptFor(root, kind).passed = false; };
  const payload = (kind: Wave8EvidenceReceipt['kind'], key: string, value: unknown) => { receiptFor(root, kind).payload[key] = value; };
  switch (id) {
    case 'missing-graph-migration': return removeReceipt(root, 'graph-migration');
    case 'graph-not-passed': return setPassed('graph-migration');
    case 'graph-cycle-detected': return payload('graph-migration', 'cycleDetected', true);
    case 'migration-not-roundtrip': return payload('graph-migration', 'migrationRoundTrip', false);
    case 'migration-receipt-unbound': return payload('graph-migration', 'graphDigest', 'bad');
    case 'missing-idempotency': return removeReceipt(root, 'idempotency');
    case 'idempotency-not-passed': return setPassed('idempotency');
    case 'duplicate-effect-not-proved': return payload('idempotency', 'duplicateEffectsAbsent', false);
    case 'duplicate-receipt-id': root.receipts[1].receiptId = root.receipts[0].receiptId; return;
    case 'missing-schema-invalidation': return removeReceipt(root, 'schema-invalidation');
    case 'schema-invalidation-not-passed': return setPassed('schema-invalidation');
    case 'schema-digest-drift': receiptFor(root, 'authority').schemaDigest = 'f'.repeat(64); return;
    case 'implementation-digest-drift': receiptFor(root, 'product').implementationDigest = 'f'.repeat(64); return;
    case 'source-fingerprint-missing': root.sourceFingerprint = ''; return;
    case 'source-fingerprint-drift': receiptFor(root, 'build').sourceFingerprint = 'f'.repeat(64); return;
    case 'quality-receipt-unbound': receiptFor(root, 'startup').sourceFingerprint = 'f'.repeat(64); return;
    case 'deterministic-no-spend-labeled-live': receiptFor(root, 'deterministic-no-spend').evidenceClass = 'live'; return;
    case 'missing-packed-install': return setPassed('packed-install');
    case 'missing-startup': return setPassed('startup');
    case 'missing-focused-checks': return setPassed('focused-checks');
    case 'missing-build-or-typecheck-lint': return setPassed('build');
    case 'missing-wave7-reproof': return removeReceipt(root, 'wave7-reproof');
    case 'wave7-reproof-not-passed': return setPassed('wave7-reproof');
    case 'wave7-reproof-source-drift': return payload('wave7-reproof', 'sourceFingerprint', 'f'.repeat(64));
    // PRD six product-path kinds
    case 'missing-campaign-origin-receipt': return removeReceipt(root, 'campaign-origin');
    case 'campaign-origin-not-passed': return setPassed('campaign-origin');
    case 'campaign-origin-purpose-invalid': receiptFor(root, 'campaign-origin').purpose = 'diagnostic'; return;
    case 'campaign-origin-not-execution-backed': receiptFor(root, 'campaign-origin').providerCalls = 0; return;
    case 'campaign-origin-binding-missing': return payload('campaign-origin', 'campaignRootDigest', null);
    case 'missing-actual-executor-receipt': return removeReceipt(root, 'actual-executor');
    case 'actual-executor-not-passed': return setPassed('actual-executor');
    case 'actual-executor-purpose-invalid': receiptFor(root, 'actual-executor').purpose = 'diagnostic'; return;
    case 'actual-executor-not-execution-backed': receiptFor(root, 'actual-executor').providerCalls = 0; return;
    case 'actual-executor-identity-missing': return payload('actual-executor', 'resolvedModel', '');
    case 'missing-creative-quality-receipt': return removeReceipt(root, 'creative-quality');
    case 'creative-quality-not-passed': return setPassed('creative-quality');
    case 'creative-quality-purpose-invalid': receiptFor(root, 'creative-quality').purpose = 'diagnostic'; return;
    case 'creative-quality-not-execution-backed': receiptFor(root, 'creative-quality').providerCalls = 0; return;
    case 'creative-quality-judgment-missing':
      payload('creative-quality', 'qualityPassed', false);
      payload('creative-quality', 'qualityScore', null);
      return payload('creative-quality', 'qualityEvidenceDigest', null);
    case 'missing-causal-revision-receipt': return removeReceipt(root, 'causal-revision');
    case 'causal-revision-not-passed': return setPassed('causal-revision');
    case 'causal-revision-purpose-invalid': receiptFor(root, 'causal-revision').purpose = 'diagnostic'; return;
    case 'causal-revision-not-execution-backed': receiptFor(root, 'causal-revision').providerCalls = 0; return;
    case 'causal-revision-signal-missing':
      payload('causal-revision', 'revisionCount', null);
      payload('causal-revision', 'causalSignalPresent', false);
      return payload('causal-revision', 'revisionEvidenceDigest', null);
    case 'missing-sealed-transfer-receipt': return removeReceipt(root, 'sealed-transfer');
    case 'sealed-transfer-not-passed': return setPassed('sealed-transfer');
    case 'sealed-transfer-purpose-invalid': receiptFor(root, 'sealed-transfer').purpose = 'diagnostic'; return;
    case 'sealed-transfer-not-execution-backed': receiptFor(root, 'sealed-transfer').providerCalls = 0; return;
    case 'sealed-transfer-unsealed':
      payload('sealed-transfer', 'transferSealed', false);
      return payload('sealed-transfer', 'transferSealDigest', null);
    case 'missing-dream-recommendation-receipt': return removeReceipt(root, 'dream-recommendation');
    case 'dream-recommendation-not-passed': return setPassed('dream-recommendation');
    case 'dream-recommendation-purpose-invalid': receiptFor(root, 'dream-recommendation').purpose = 'diagnostic'; return;
    case 'dream-recommendation-not-execution-backed': receiptFor(root, 'dream-recommendation').providerCalls = 0; return;
    case 'dream-recommendation-path-b-violated': return payload('dream-recommendation', 'promote', true);
    default: throw new Error(`unmapped planted negative ${id}`);
  }
}
