import { describe, expect, it } from 'vitest';
import {
  createDefaultWave7DeclaredRuns,
  createFrozenDomainManifest,
  createPreExistingQueueManifest,
  createWave7ReleaseEvidenceManifest,
  type Wave7ReleaseEvidenceManifest,
} from '../../../src/runtime-core/Wave7ReleaseContract.js';
import { WAVE7_CREATIVE_LANES, type Wave7CreativeLadderEvidence } from '../../../src/runtime-core/Wave7CreativeLadder.js';
import {
  validateWave7ReleaseReadiness,
  WAVE7_AUXILIARY_ARTIFACTS,
  WAVE7_QUALITY_GATES,
  type Wave7ExecutionEvidence,
  type Wave7ReleaseEvidenceIndex,
  type Wave7RunEvidenceReceipt,
} from '../../../src/runtime-core/Wave7ReleaseReadinessValidator.js';

const HEAD = 'a'.repeat(40);
const SOURCE = 'b'.repeat(64);
const GENERATED = '2026-07-31T00:00:00.000Z';
const EVIDENCE_TIME = '2026-07-31T00:01:00.000Z';
const digest = (char = 'c') => char.repeat(64);
const floors = { layersPresent: true, coordinated: true, renderPassed: true, playableAudio: true, nonSilent: true, realClock: true, nonDegraded: true, liveEvidence: true };
const scores = { conceptSpecificity: 4, compositionCoherence: 4, temporalBehavior: 4, crossDomainIntegration: 4, desireToKeep: 4 };

function manifest(): Wave7ReleaseEvidenceManifest {
  const domains = createFrozenDomainManifest(['p5', 'tone']);
  const queue = createPreExistingQueueManifest([{
    id: 'queued-before-freeze', kind: 'artifact', strategy: 'cross-modal',
    sources: [{ id: 'source', descriptor: [0.2], quality: 0.8 }], priority: 1,
    status: 'queued', enqueuedAt: GENERATED,
  }]);
  return createWave7ReleaseEvidenceManifest({
    generatedAt: GENERATED, baselineHead: '9'.repeat(40), releaseHead: HEAD,
    sourceFingerprint: SOURCE, tourId: 'tour-7', tourWaveId: 'wave-7@aaaaaaaa',
    domainManifest: domains, queueManifest: queue,
    declaredRuns: createDefaultWave7DeclaredRuns(domains.entries, HEAD), ownerApprovedUsdCeiling: 20,
  });
}

const claimsByKind = {
  circulation: ['full-lifecycle', 'owner-causal-next-create', 'queue-persistence', 'cortex-sole-consumer', 'no-dual-claim', 'no-autonomous-promotion'],
  recovery: ['two-consecutive-cycles', 'restart-recovered', 'no-duplicate-effects', 'no-duplicate-ledger', 'no-autonomous-promotion'],
  'creative-lane': [],
  assimilate: ['model-role-recommendation', 'domain-combination-recommendation'],
  'domain-smoke': ['domain-live-smoke'],
  'studio-journey': ['canonical-organism-journey', 'shared-persistence'],
  'cli-journey': ['canonical-organism-journey', 'shared-persistence'],
  'product-delta': ['tour-disposition', 'prior-fix-reverified', 'scheduled-frontier-identity', 'user-visible-non-instrumentation-delta', 'independently-reviewed', 'owner-approved', 'merged', 'next-create-inherited'],
  'sol-review-bootstrap': ['pre-spend-feasibility', 'bootstrap-cap-respected'],
  'sol-review-confirmation': ['sol-high-approved', 'seat-identity-verified'],
} as const;

function creative(): Wave7CreativeLadderEvidence {
  return {
    releaseHead: HEAD, sourceFingerprint: SOURCE, productDeltaDigest: digest('c'), interventionHypothesisDigest: digest('d'),
    lanes: WAVE7_CREATIVE_LANES.map(lane => ({
      lane: lane.id, retryCount: 0, inheritedHypothesisDigest: lane.id === 'p5-tone' ? undefined : digest('d'), ownerReleaseWorthy: true,
      trials: lane.seedIds.map((seedId, index) => ({
        seedId, control: { artifactDigest: digest(String(index + 1)), floors }, treatment: { artifactDigest: digest(String(index + 4)), floors },
        owner: { choice: index < 2 ? 'treatment' : 'control', reactionDigest: digest('e'), ownerSessionReceiptDigest: digest('f') },
        reviewer: { choice: index < 2 ? 'treatment' : 'control', scores, receiptDigest: digest('8'), identityVerified: true, sealed: true },
      })),
    })),
    productDelta: {
      diagnosedBy: { model: 'gpt-5.6-sol', effort: 'high', identityVerified: true }, changedPaths: ['src/core/PromptEnhancer.ts'],
      authorIndependentReview: true, ownerApproved: true, mergedHead: HEAD, nextCreateInheritedDeltaDigest: digest('c'),
    },
  };
}

function execution(manifestValue: Wave7ReleaseEvidenceManifest): Wave7ExecutionEvidence {
  return { generatedAt: EVIDENCE_TIME, releaseRootDigest: manifestValue.releaseRootDigest, releaseHead: HEAD, sourceFingerprint: SOURCE, evidenceClass: 'execution', passed: true, artifactDigests: [digest()] };
}

function validIndex(manifestValue: Wave7ReleaseEvidenceManifest): Wave7ReleaseEvidenceIndex {
  const roleIdentities = Object.entries(manifestValue.seatFreeze).map(([role, seat]) => ({
    role: role as keyof typeof manifestValue.seatFreeze, provider: `provider-${role}`,
    model: seat.model, effort: seat.effort, pipe: `resolved-${role}-pipe`, identityVerified: true,
  }));
  const roleFor = (kind: Wave7RunEvidenceReceipt['runSlotId'] extends never ? never : string) =>
    kind === 'product-delta' ? 'productReviewer'
      : ['creative-lane', 'domain-smoke', 'studio-journey', 'cli-journey'].includes(kind) ? 'creative' : 'harness';
  const runReceipts: Wave7RunEvidenceReceipt[] = manifestValue.declaredRuns.map((slot, index) => ({
    releaseRootDigest: manifestValue.releaseRootDigest, runSlotId: slot.id, releaseHead: HEAD,
    sourceFingerprint: SOURCE, lineageId: slot.lineageId, generatedAt: EVIDENCE_TIME,
    evidenceClass: 'live', livePass: true, providerLedgerCallIds: [(index + 1).toString(16).padStart(64, '0')],
    resolvedIdentity: (() => { const identity = roleIdentities.find(item => item.role === roleFor(slot.kind))!; return { provider: identity.provider, model: identity.model, effort: identity.effort, pipe: identity.pipe }; })(),
    executedEffectIds: [`effect-${index}`], artifactDigests: [digest()],
    claims: [...claimsByKind[slot.kind]], spendUsd: 0.5, elapsedMinutes: 2, retryCount: 0,
    usage: { inputTokens: 80, outputTokens: 20 },
    facts: slot.kind === 'domain-smoke' ? {
      domain: slot.domain, domainManifestDigest: manifestValue.domainManifest.digest,
      renderPassed: true, artifactDigest: digest(),
    } : slot.kind === 'assimilate' ? {
      modelRoleRecommendation: 'Keep the verified harness seat for diagnosis.',
      domainCombinationRecommendation: 'Test a cited p5 plus Tone composition.',
      recommendationEvidenceDigests: [digest('d')], routeBeforeDigest: digest('e'),
      routeAfterDigest: digest('e'), domainRegistryBeforeDigest: digest('f'),
      domainRegistryAfterDigest: digest('f'), ownerControlled: true, currentSource: true,
    } : undefined,
  }));
  return {
    schemaVersion: 1, releaseRootDigest: manifestValue.releaseRootDigest, runReceipts, creativeLadder: creative(),
    queueDispositions: [{ taskId: 'queued-before-freeze', disposition: 'completed' }],
    qualityGates: Object.fromEntries(WAVE7_QUALITY_GATES.map(id => [id, execution(manifestValue)])) as Wave7ReleaseEvidenceIndex['qualityGates'],
    auxiliaryArtifacts: Object.fromEntries(WAVE7_AUXILIARY_ARTIFACTS.map(id => [id, execution(manifestValue)])) as Wave7ReleaseEvidenceIndex['auxiliaryArtifacts'],
    preSpendProofs: {
      noSpend: { ...execution(manifestValue), gate: 'noSpendCirculationProof', evidenceClass: 'deterministic-proof', planHash: digest('1'), providerLedgerCallIds: [] },
      feasibility: (() => {
        const declaredSlots = [{ id: 'fixture-slot', purpose: 'product' as const, provider: 'provider-harness', model: 'gpt-5.6-sol', role: 'harness' as const, minCalls: 1, maxCalls: 1, maxInputTokens: 100, maxOutputTokens: 100, minActiveMinutes: 1 }];
        const budgetRows = [{ slotId: 'fixture-slot', maxCalls: 1, maxInputTokens: 100, maxOutputTokens: 100, minActiveMinutes: 1, inputUsdPerMillion: 1, outputUsdPerMillion: 1 }];
        return { ...execution(manifestValue), gate: 'preSpendFeasibilityProof' as const, planHash: digest('1'), providerLedgerCallIds: [], priceReceiptDigest: digest('2'), declaredSlots, budgetRows, approvedUsdCeiling: 20, totals: { calls: 1, tokens: 200, activeMinutes: 1, usdUpperBound: 0.0002 } };
      })(),
      solApproval: { ...execution(manifestValue), gate: 'solHighPreSpendApproval', evidenceClass: 'live', planHash: digest('1'), providerLedgerCallIds: [runReceipts.find(item => item.runSlotId === 'sol-bootstrap')!.providerLedgerCallIds[0]], executor: { model: 'gpt-5.6-sol', effort: 'high', identityVerified: true } },
    },
    roleIdentities,
    openProductBlockers: [], totalSpendUsd: runReceipts.length * 0.5, totalProviderCalls: runReceipts.length,
    totalBillableTokens: runReceipts.length * 100, activeHours: runReceipts.length * 2 / 60,
  };
}

describe('Wave7ReleaseReadinessValidator', () => {
  it('passes only the exhaustive exact-root conjunction', () => {
    const frozen = manifest();
    const report = validateWave7ReleaseReadiness(frozen, validIndex(frozen));
    expect(report.ownerReleaseReady).toBe(true);
    expect(report.conjuncts).toHaveLength(13);
    expect(report.conjuncts.every(item => item.passed)).toBe(true);
    expect(report.blockers).toEqual([]);
  });

  it.each([
    ['missing slot', (value: Wave7ReleaseEvidenceIndex) => { value.runReceipts.pop(); }],
    ['deterministic-as-live', (value: Wave7ReleaseEvidenceIndex) => { value.runReceipts[0].evidenceClass = 'deterministic-proof'; }],
    ['cross-source receipt', (value: Wave7ReleaseEvidenceIndex) => { value.runReceipts[0].sourceFingerprint = digest('7'); }],
    ['stale receipt', (value: Wave7ReleaseEvidenceIndex) => { value.runReceipts[0].generatedAt = '2026-07-30T23:59:59.000Z'; }],
    ['missing execution artifact', (value: Wave7ReleaseEvidenceIndex) => { delete (value.qualityGates as Partial<typeof value.qualityGates>).build; }],
    ['open P1', (value: Wave7ReleaseEvidenceIndex) => { value.openProductBlockers.push({ id: 'P1-1', severity: 'P1', summary: 'broken Studio path' }); }],
    ['over spend', (value: Wave7ReleaseEvidenceIndex) => { value.totalSpendUsd = 21; }],
    ['seat drift', (value: Wave7ReleaseEvidenceIndex) => { value.roleIdentities[0].model = 'wrong-model'; }],
    ['cross-slot provider call reuse', (value: Wave7ReleaseEvidenceIndex) => { value.runReceipts[1].providerLedgerCallIds = [...value.runReceipts[0].providerLedgerCallIds]; }],
    ['missing no-spend proof', (value: Wave7ReleaseEvidenceIndex) => { delete (value.preSpendProofs as Partial<typeof value.preSpendProofs>).noSpend; }],
    ['no-spend proof with paid call', (value: Wave7ReleaseEvidenceIndex) => { value.preSpendProofs.noSpend.providerLedgerCallIds = [digest('7')]; }],
    ['tampered feasibility total', (value: Wave7ReleaseEvidenceIndex) => { value.preSpendProofs.feasibility.totals!.calls = 0; }],
    ['run pipe drift', (value: Wave7ReleaseEvidenceIndex) => { value.runReceipts[0].resolvedIdentity.pipe = 'wrong-pipe'; }],
    ['underreported active time', (value: Wave7ReleaseEvidenceIndex) => { value.activeHours = 0; }],
    ['domain manifest drift', (value: Wave7ReleaseEvidenceIndex) => { value.runReceipts.find(item => item.runSlotId === 'domain-p5')!.facts!.domainManifestDigest = digest('9'); }],
    ['assimilation route mutation', (value: Wave7ReleaseEvidenceIndex) => { value.runReceipts.find(item => item.runSlotId === 'assimilate')!.facts!.routeAfterDigest = digest('9'); }],
    ['owner not release-worthy', (value: Wave7ReleaseEvidenceIndex) => { value.creativeLadder.lanes[0].ownerReleaseWorthy = false; }],
  ])('fails closed on %s', (_label, mutate) => {
    const frozen = manifest();
    const evidence = validIndex(frozen);
    mutate(evidence);
    expect(validateWave7ReleaseReadiness(frozen, evidence).ownerReleaseReady).toBe(false);
  });

  it.each([
    ['declared-run-closure', (v: Wave7ReleaseEvidenceIndex) => { v.runReceipts.pop(); }],
    ['circulation-ready', (v: Wave7ReleaseEvidenceIndex) => { v.runReceipts.find(r => r.runSlotId === 'circulation')!.livePass = false; }],
    ['recovery-ready', (v: Wave7ReleaseEvidenceIndex) => { v.runReceipts.find(r => r.runSlotId === 'recovery')!.livePass = false; }],
    ['creative-ladder-ready', (v: Wave7ReleaseEvidenceIndex) => { v.creativeLadder.lanes[0].ownerReleaseWorthy = false; }],
    ['domain-smokes', (v: Wave7ReleaseEvidenceIndex) => { v.runReceipts.find(r => r.runSlotId === 'domain-p5')!.facts!.renderPassed = false; }],
    ['live-assimilation', (v: Wave7ReleaseEvidenceIndex) => { v.runReceipts.find(r => r.runSlotId === 'assimilate')!.facts!.routeAfterDigest = digest('0'); }],
    ['compound-ready', (v: Wave7ReleaseEvidenceIndex) => { v.runReceipts.find(r => r.runSlotId === 'product-delta')!.claims = []; }],
    ['seat-and-pre-spend-proof', (v: Wave7ReleaseEvidenceIndex) => { v.roleIdentities[0].identityVerified = false; }],
    ['queue-disposition', (v: Wave7ReleaseEvidenceIndex) => { v.queueDispositions.push({ taskId: 'undeclared', disposition: 'completed' }); }],
    ['studio-cli-shared-organism', (v: Wave7ReleaseEvidenceIndex) => { v.runReceipts.find(r => r.runSlotId === 'studio')!.livePass = false; }],
    ['release-artifacts', (v: Wave7ReleaseEvidenceIndex) => { delete (v.auxiliaryArtifacts as Partial<typeof v.auxiliaryArtifacts>).harvest; }],
    ['quality-gates', (v: Wave7ReleaseEvidenceIndex) => { delete (v.qualityGates as Partial<typeof v.qualityGates>).build; }],
    ['budgets-and-product-blockers', (v: Wave7ReleaseEvidenceIndex) => { v.openProductBlockers.push({ id: 'P0', severity: 'P0', summary: 'planted' }); }],
  ])('has an explicit planted negative for %s', (id, mutate) => {
    const frozen = manifest(); const evidence = validIndex(frozen); mutate(evidence);
    expect(validateWave7ReleaseReadiness(frozen, evidence).conjuncts.find(item => item.id === id)?.passed).toBe(false);
  });
});
