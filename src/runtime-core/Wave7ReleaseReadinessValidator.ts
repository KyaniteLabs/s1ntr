import {
  assertEvidenceReceiptMatchesReleaseManifest,
  parseWave7ReleaseEvidenceManifest,
  validateQueueDispositions,
  WAVE7_SEAT_FREEZE,
  type QueueDisposition,
  type Wave7ChildEvidenceReceiptBinding,
  type Wave7ReleaseEvidenceManifest,
  type Wave7ReleaseRunKind,
} from './Wave7ReleaseContract.js';
import {
  evaluateWave7CreativeLadder,
  type Wave7CreativeLadderEvidence,
} from './Wave7CreativeLadder.js';
import {
  createPreSpendFeasibilityProof,
  type PaidCallSlot,
  type PreSpendBudgetRow,
} from '../llm/PreSpendInterlock.js';

export type Wave7EvidenceClass = 'live' | 'execution' | 'deterministic-proof' | 'planned' | 'synthetic' | 'deferred';

export interface Wave7RunEvidenceReceipt extends Wave7ChildEvidenceReceiptBinding {
  generatedAt: string;
  evidenceClass: Wave7EvidenceClass;
  livePass: boolean;
  providerLedgerCallIds: string[];
  resolvedIdentity: { provider: string; model: string; effort?: string; pipe?: string };
  executedEffectIds: string[];
  artifactDigests: string[];
  claims: string[];
  spendUsd: number;
  elapsedMinutes: number;
  retryCount: number;
  usage: { inputTokens: number; outputTokens: number };
  facts?: {
    domain?: string;
    domainManifestDigest?: string;
    renderPassed?: boolean;
    artifactDigest?: string;
    modelRoleRecommendation?: string;
    domainCombinationRecommendation?: string;
    recommendationEvidenceDigests?: string[];
    routeBeforeDigest?: string;
    routeAfterDigest?: string;
    domainRegistryBeforeDigest?: string;
    domainRegistryAfterDigest?: string;
    ownerControlled?: boolean;
    currentSource?: boolean;
  };
}

export const WAVE7_QUALITY_GATES = Object.freeze([
  'build', 'typecheck', 'lint', 'focused-tests', 'full-suite', 'coverage-ratchet',
  'packed-install-smoke', 'forgejo-ci', 'leak-audit',
] as const);

export const WAVE7_AUXILIARY_ARTIFACTS = Object.freeze([
  'harvest', 'synthesis-model-fingerprint', 'dreams', 'learnings',
  'product-disposition', 'compound-note', 'release-evidence-manifest',
] as const);

export interface Wave7ExecutionEvidence {
  generatedAt: string;
  releaseRootDigest: string;
  releaseHead: string;
  sourceFingerprint: string;
  evidenceClass: Wave7EvidenceClass;
  passed: boolean;
  artifactDigests: string[];
}

export interface Wave7PreSpendGateEvidence extends Wave7ExecutionEvidence {
  gate: 'noSpendCirculationProof' | 'preSpendFeasibilityProof' | 'solHighPreSpendApproval';
  planHash: string;
  providerLedgerCallIds: string[];
  priceReceiptDigest?: string;
  executor?: { model: string; effort: string; identityVerified: boolean };
  declaredSlots?: PaidCallSlot[];
  budgetRows?: PreSpendBudgetRow[];
  approvedUsdCeiling?: number;
  totals?: { calls: number; tokens: number; activeMinutes: number; usdUpperBound: number };
}

export interface Wave7ReleaseEvidenceIndex {
  schemaVersion: 1;
  releaseRootDigest: string;
  runReceipts: Wave7RunEvidenceReceipt[];
  creativeLadder: Wave7CreativeLadderEvidence;
  queueDispositions: QueueDisposition[];
  qualityGates: Record<typeof WAVE7_QUALITY_GATES[number], Wave7ExecutionEvidence>;
  auxiliaryArtifacts: Record<typeof WAVE7_AUXILIARY_ARTIFACTS[number], Wave7ExecutionEvidence>;
  preSpendProofs: {
    noSpend: Wave7PreSpendGateEvidence;
    feasibility: Wave7PreSpendGateEvidence;
    solApproval: Wave7PreSpendGateEvidence;
  };
  roleIdentities: Array<{
    role: keyof typeof WAVE7_SEAT_FREEZE;
    provider: string;
    model: string;
    effort: string;
    pipe: string;
    identityVerified: boolean;
  }>;
  openProductBlockers: Array<{ id: string; severity: 'P0' | 'P1' | 'P2' | 'P3'; summary: string }>;
  totalSpendUsd: number;
  totalProviderCalls: number;
  totalBillableTokens: number;
  activeHours: number;
}

export interface Wave7ReadinessConjunct {
  id: string;
  passed: boolean;
  failures: string[];
}

export interface Wave7ReleaseReadinessReport {
  schemaVersion: 1;
  wave: 7;
  contractDigest: string;
  releaseRootDigest: string;
  ownerReleaseReady: boolean;
  circulationReady: boolean;
  recoveryReady: boolean;
  creativeLadderReady: boolean;
  compoundReady: boolean;
  conjuncts: Wave7ReadinessConjunct[];
  blockers: string[];
}

export const WAVE7_RELEASE_CONJUNCT_IDS = Object.freeze([
  'declared-run-closure', 'circulation-ready', 'recovery-ready', 'creative-ladder-ready',
  'domain-smokes', 'live-assimilation', 'compound-ready', 'seat-and-pre-spend-proof',
  'queue-disposition', 'studio-cli-shared-organism', 'release-artifacts', 'quality-gates',
  'budgets-and-product-blockers',
] as const);

const SHA256 = /^[a-f0-9]{64}$/;
const FORBIDDEN_LIVE_CLASSES = new Set<Wave7EvidenceClass>(['deterministic-proof', 'planned', 'synthetic', 'deferred']);

const REQUIRED_CLAIMS: Partial<Record<Wave7ReleaseRunKind, readonly string[]>> = {
  circulation: ['full-lifecycle', 'owner-causal-next-create', 'queue-persistence', 'cortex-sole-consumer', 'no-dual-claim', 'no-autonomous-promotion'],
  recovery: ['two-consecutive-cycles', 'restart-recovered', 'no-duplicate-effects', 'no-duplicate-ledger', 'no-autonomous-promotion'],
  'domain-smoke': ['domain-live-smoke'],
  assimilate: ['model-role-recommendation', 'domain-combination-recommendation'],
  'studio-journey': ['canonical-organism-journey', 'shared-persistence'],
  'cli-journey': ['canonical-organism-journey', 'shared-persistence'],
  'product-delta': ['tour-disposition', 'prior-fix-reverified', 'scheduled-frontier-identity', 'user-visible-non-instrumentation-delta', 'independently-reviewed', 'owner-approved', 'merged', 'next-create-inherited'],
  'sol-review-bootstrap': ['pre-spend-feasibility', 'bootstrap-cap-respected'],
  'sol-review-confirmation': ['sol-high-approved', 'seat-identity-verified'],
};

function uniqueNonBlank(values: string[]): boolean {
  return values.length > 0 && values.every(Boolean) && new Set(values).size === values.length;
}

function evidenceBindingFailures(
  manifest: Wave7ReleaseEvidenceManifest,
  evidence: Wave7ExecutionEvidence,
  label: string,
): string[] {
  const failures: string[] = [];
  if (evidence.releaseRootDigest !== manifest.releaseRootDigest) failures.push(`${label}: release root mismatch`);
  if (evidence.releaseHead !== manifest.releaseHead) failures.push(`${label}: release HEAD mismatch`);
  if (evidence.sourceFingerprint !== manifest.sourceFingerprint) failures.push(`${label}: source fingerprint mismatch`);
  if (!Number.isFinite(Date.parse(evidence.generatedAt)) || Date.parse(evidence.generatedAt) < Date.parse(manifest.generatedAt)) failures.push(`${label}: stale or invalid timestamp`);
  if (evidence.evidenceClass !== 'execution') failures.push(`${label}: must be execution evidence`);
  if (!evidence.passed) failures.push(`${label}: did not pass`);
  if (!uniqueNonBlank(evidence.artifactDigests) || evidence.artifactDigests.some(value => !SHA256.test(value))) failures.push(`${label}: artifact digests missing or invalid`);
  return failures;
}

function preSpendProofFailures(
  manifest: Wave7ReleaseEvidenceManifest,
  evidence: Wave7ReleaseEvidenceIndex,
): string[] {
  const failures: string[] = [];
  const expected = [
    ['noSpend', 'noSpendCirculationProof', 'deterministic-proof'],
    ['feasibility', 'preSpendFeasibilityProof', 'execution'],
    ['solApproval', 'solHighPreSpendApproval', 'live'],
  ] as const;
  const allCalls = new Set(evidence.runReceipts.flatMap(receipt => receipt.providerLedgerCallIds));
  for (const [key, gate, evidenceClass] of expected) {
    const proof = evidence.preSpendProofs?.[key];
    if (!proof) { failures.push(`${gate}: evidence missing`); continue; }
    if (proof.gate !== gate || proof.evidenceClass !== evidenceClass || !proof.passed) failures.push(`${gate}: gate class or result is invalid`);
    if (proof.releaseRootDigest !== manifest.releaseRootDigest || proof.releaseHead !== manifest.releaseHead
      || proof.sourceFingerprint !== manifest.sourceFingerprint) failures.push(`${gate}: release binding mismatch`);
    if (!SHA256.test(proof.planHash) || !uniqueNonBlank(proof.artifactDigests)
      || proof.artifactDigests.some(value => !SHA256.test(value))) failures.push(`${gate}: bound digests are invalid`);
  }
  const feasibility = evidence.preSpendProofs?.feasibility;
  if (feasibility) {
    if (!SHA256.test(feasibility.priceReceiptDigest ?? '')) failures.push('preSpendFeasibilityProof: price receipt digest is invalid');
    if (!feasibility.declaredSlots || !feasibility.budgetRows || feasibility.approvedUsdCeiling === undefined) {
      failures.push('preSpendFeasibilityProof: recomputation inputs are missing');
    } else {
      const recomputed = createPreSpendFeasibilityProof({
        planHash: feasibility.planHash, sourceFingerprint: feasibility.sourceFingerprint,
        priceReceiptDigest: feasibility.priceReceiptDigest ?? '', declaredSlots: feasibility.declaredSlots,
        budgetRows: feasibility.budgetRows, approvedUsdCeiling: feasibility.approvedUsdCeiling,
      });
      if (!recomputed.passed || JSON.stringify(recomputed.totals) !== JSON.stringify(feasibility.totals)) failures.push('preSpendFeasibilityProof: recomputation failed');
      if (feasibility.approvedUsdCeiling !== manifest.ownerApprovedUsdCeiling) failures.push('preSpendFeasibilityProof: owner ceiling mismatch');
    }
  }
  if (evidence.preSpendProofs?.noSpend?.providerLedgerCallIds.length) failures.push('noSpendCirculationProof: provider ledger must be empty');
  const approval = evidence.preSpendProofs?.solApproval;
  if (approval) {
    if (approval.executor?.model !== 'gpt-5.6-sol' || approval.executor.effort !== 'high'
      || !approval.executor.identityVerified) failures.push('solHighPreSpendApproval: executor identity is invalid');
    const bootstrapCalls = new Set(evidence.runReceipts
      .filter(receipt => manifest.declaredRuns.find(slot => slot.id === receipt.runSlotId)?.kind === 'sol-review-bootstrap')
      .flatMap(receipt => receipt.providerLedgerCallIds));
    if (!uniqueNonBlank(approval.providerLedgerCallIds)
      || approval.providerLedgerCallIds.some(id => !allCalls.has(id) || !bootstrapCalls.has(id))) failures.push('solHighPreSpendApproval: ledger binding is missing or invalid');
  }
  return failures;
}

function validateRunReceipt(
  manifest: Wave7ReleaseEvidenceManifest,
  receipt: Wave7RunEvidenceReceipt,
  kind: Wave7ReleaseRunKind,
): string[] {
  const failures: string[] = [];
  try { assertEvidenceReceiptMatchesReleaseManifest(manifest, receipt); } catch (error) {
    failures.push(error instanceof Error ? error.message : String(error));
  }
  if (!Number.isFinite(Date.parse(receipt.generatedAt)) || Date.parse(receipt.generatedAt) < Date.parse(manifest.generatedAt)) failures.push('stale or invalid timestamp');
  if (receipt.evidenceClass !== 'live' || FORBIDDEN_LIVE_CLASSES.has(receipt.evidenceClass)) failures.push('live slot requires evidenceClass=live');
  if (!receipt.livePass) failures.push('livePass is not true');
  if (!uniqueNonBlank(receipt.providerLedgerCallIds)) failures.push('provider ledger call IDs missing or duplicated');
  if (!uniqueNonBlank(receipt.executedEffectIds)) failures.push('executed effect IDs missing or duplicated');
  if (!uniqueNonBlank(receipt.artifactDigests) || receipt.artifactDigests.some(value => !SHA256.test(value))) failures.push('artifact digests missing or invalid');
  if (!receipt.resolvedIdentity.provider || !receipt.resolvedIdentity.model
    || !receipt.resolvedIdentity.effort || !receipt.resolvedIdentity.pipe) failures.push('resolved provider/model/effort/pipe identity missing');
  if (!Number.isFinite(receipt.spendUsd) || receipt.spendUsd < 0) failures.push('invalid spend');
  if (!receipt.usage || !Number.isFinite(receipt.usage.inputTokens) || receipt.usage.inputTokens < 0
    || !Number.isFinite(receipt.usage.outputTokens) || receipt.usage.outputTokens < 0) failures.push('invalid token usage');
  if (!Number.isFinite(receipt.elapsedMinutes) || receipt.elapsedMinutes < 0 || receipt.elapsedMinutes > manifest.budgets.perCycle.wallMinutes) failures.push('per-cycle wall budget exceeded');
  if (!Number.isInteger(receipt.retryCount) || receipt.retryCount < 0 || receipt.retryCount > manifest.budgets.perCycle.retriesPerStage) failures.push('retry budget exceeded');
  const required = REQUIRED_CLAIMS[kind] ?? [];
  for (const claim of required) if (!receipt.claims.includes(claim)) failures.push(`missing claim ${claim}`);
  const slot = manifest.declaredRuns.find(candidate => candidate.id === receipt.runSlotId);
  if (kind === 'domain-smoke') {
    if (receipt.facts?.domain !== slot?.domain) failures.push('domain fact does not match declared slot');
    if (receipt.facts?.domainManifestDigest !== manifest.domainManifest.digest) failures.push('domain manifest digest mismatch');
    if (receipt.facts?.renderPassed !== true) failures.push('domain render did not pass');
    if (!receipt.facts?.artifactDigest || !receipt.artifactDigests.includes(receipt.facts.artifactDigest)) failures.push('domain artifact digest is not bound');
  }
  if (kind === 'assimilate') {
    if (!receipt.facts?.modelRoleRecommendation?.trim()) failures.push('model-role recommendation missing');
    if (!receipt.facts?.domainCombinationRecommendation?.trim()) failures.push('domain/combination recommendation missing');
    if (!receipt.facts?.recommendationEvidenceDigests?.length
      || receipt.facts.recommendationEvidenceDigests.some(value => !SHA256.test(value))) failures.push('assimilation citations missing or invalid');
    if (receipt.facts?.routeBeforeDigest !== receipt.facts?.routeAfterDigest) failures.push('assimilation mutated configured routes');
    if (receipt.facts?.domainRegistryBeforeDigest !== receipt.facts?.domainRegistryAfterDigest) failures.push('assimilation registered a domain');
    if (receipt.facts?.ownerControlled !== true || receipt.facts?.currentSource !== true) failures.push('assimilation is not current-source owner-controlled advice');
  }
  return failures;
}

function conjunct(id: string, failures: string[]): Wave7ReadinessConjunct {
  return { id, passed: failures.length === 0, failures };
}

export function validateWave7ReleaseReadiness(
  manifestValue: unknown,
  evidence: Wave7ReleaseEvidenceIndex,
): Wave7ReleaseReadinessReport {
  const manifest = parseWave7ReleaseEvidenceManifest(manifestValue);
  const bySlot = new Map<string, Wave7RunEvidenceReceipt>();
  const receiptFailures: string[] = [];
  if (evidence.schemaVersion !== 1) receiptFailures.push('evidence index schema mismatch');
  for (const receipt of evidence.runReceipts) {
    if (bySlot.has(receipt.runSlotId)) receiptFailures.push(`duplicate run receipt ${receipt.runSlotId}`);
    bySlot.set(receipt.runSlotId, receipt);
  }
  if (evidence.releaseRootDigest !== manifest.releaseRootDigest) receiptFailures.push('evidence index release root mismatch');
  for (const slot of manifest.declaredRuns) {
    const receipt = bySlot.get(slot.id);
    if (!receipt) { receiptFailures.push(`missing run receipt ${slot.id}`); continue; }
    receiptFailures.push(...validateRunReceipt(manifest, receipt, slot.kind).map(failure => `${slot.id}: ${failure}`));
  }
  for (const slotId of bySlot.keys()) {
    if (!manifest.declaredRuns.some(slot => slot.id === slotId)) receiptFailures.push(`undeclared run receipt ${slotId}`);
  }
  const allProviderCalls = evidence.runReceipts.flatMap(receipt => receipt.providerLedgerCallIds);
  const allEffects = evidence.runReceipts.flatMap(receipt => receipt.executedEffectIds);
  if (new Set(allProviderCalls).size !== allProviderCalls.length) receiptFailures.push('provider ledger call IDs are reused across run slots');
  if (new Set(allEffects).size !== allEffects.length) receiptFailures.push('executed effect IDs are reused across run slots');

  const runFailures = (kind: Wave7ReleaseRunKind): string[] => manifest.declaredRuns
    .filter(slot => slot.kind === kind)
    .flatMap(slot => receiptFailures.filter(failure => failure.startsWith(`${slot.id}:`) || failure === `missing run receipt ${slot.id}`));
  const creative = evaluateWave7CreativeLadder(evidence.creativeLadder);
  const creativeRunFailures = runFailures('creative-lane');
  const creativeBinding = evidence.creativeLadder.releaseHead === manifest.releaseHead
    && evidence.creativeLadder.sourceFingerprint === manifest.sourceFingerprint
    ? [] : ['creative ladder release binding mismatch'];
  const queue = validateQueueDispositions(manifest.queueManifest, evidence.queueDispositions);
  const domainFailures = runFailures('domain-smoke');
  const qualityFailures = WAVE7_QUALITY_GATES.flatMap(id => evidence.qualityGates?.[id]
    ? evidenceBindingFailures(manifest, evidence.qualityGates[id], id) : [`${id}: evidence missing`]);
  const artifactFailures = WAVE7_AUXILIARY_ARTIFACTS.flatMap(id => evidence.auxiliaryArtifacts?.[id]
    ? evidenceBindingFailures(manifest, evidence.auxiliaryArtifacts[id], id) : [`${id}: evidence missing`]);
  const budgetFailures: string[] = [];
  const derivedSpend = evidence.runReceipts.reduce((sum, receipt) => sum + receipt.spendUsd, 0);
  const derivedTokens = evidence.runReceipts.reduce((sum, receipt) =>
    sum + (receipt.usage?.inputTokens ?? Number.NaN) + (receipt.usage?.outputTokens ?? Number.NaN), 0);
  const derivedActiveHours = evidence.runReceipts.reduce((sum, receipt) => sum + receipt.elapsedMinutes, 0) / 60;
  if (evidence.totalProviderCalls !== allProviderCalls.length) budgetFailures.push('provider call total does not reconcile to the ledger');
  if (evidence.totalBillableTokens !== derivedTokens) budgetFailures.push('billable token total does not reconcile to receipts');
  if (Math.abs(evidence.totalSpendUsd - derivedSpend) > 1e-9) budgetFailures.push('spend total does not reconcile to receipts');
  if (Math.abs(evidence.activeHours - derivedActiveHours) > 1e-9) budgetFailures.push('active time does not reconcile to receipts');
  if (evidence.totalSpendUsd > manifest.ownerApprovedUsdCeiling) budgetFailures.push('owner-approved USD ceiling exceeded');
  if (evidence.totalProviderCalls > manifest.budgets.wholeWave.providerCalls) budgetFailures.push('whole-wave provider call cap exceeded');
  if (evidence.totalBillableTokens > manifest.budgets.wholeWave.billableTokens) budgetFailures.push('whole-wave billable token cap exceeded');
  if (evidence.activeHours > manifest.budgets.wholeWave.activeHours) budgetFailures.push('whole-wave active-hour cap exceeded');
  if ([evidence.totalSpendUsd, evidence.totalProviderCalls, evidence.totalBillableTokens, evidence.activeHours].some(value => !Number.isFinite(value) || value < 0)) budgetFailures.push('whole-wave usage is invalid');
  const severeBlockers = evidence.openProductBlockers.filter(blocker => blocker.severity === 'P0' || blocker.severity === 'P1');
  const identityFailures: string[] = [];
  for (const [role, frozen] of Object.entries(WAVE7_SEAT_FREEZE) as Array<[keyof typeof WAVE7_SEAT_FREEZE, { model: string; effort: string }]>) {
    const matches = evidence.roleIdentities?.filter(identity => identity.role === role) ?? [];
    if (matches.length !== 1) { identityFailures.push(`${role}: requires exactly one resolved identity`); continue; }
    const identity = matches[0];
    if (!identity.identityVerified || !identity.provider || !identity.pipe) identityFailures.push(`${role}: provider/pipe identity is unverified`);
    if (identity.model !== frozen.model || identity.effort !== frozen.effort) identityFailures.push(`${role}: frozen model or effort mismatch`);
  }
  for (const receipt of evidence.runReceipts) {
    const matches = evidence.roleIdentities.filter(identity => identity.provider === receipt.resolvedIdentity.provider
      && identity.model === receipt.resolvedIdentity.model && identity.effort === receipt.resolvedIdentity.effort
      && identity.pipe === receipt.resolvedIdentity.pipe && identity.identityVerified);
    if (matches.length !== 1) identityFailures.push(`${receipt.runSlotId}: resolved route does not match exactly one frozen role identity`);
  }

  const circulationFailures = runFailures('circulation');
  const recoveryFailures = runFailures('recovery');
  const compoundFailures = runFailures('product-delta');
  const conjuncts = [
    conjunct('declared-run-closure', receiptFailures),
    conjunct('circulation-ready', circulationFailures),
    conjunct('recovery-ready', recoveryFailures),
    conjunct('creative-ladder-ready', [...creativeRunFailures, ...creativeBinding, ...creative.failures]),
    conjunct('domain-smokes', domainFailures),
    conjunct('live-assimilation', runFailures('assimilate')),
    conjunct('compound-ready', compoundFailures),
    conjunct('seat-and-pre-spend-proof', [...identityFailures, ...preSpendProofFailures(manifest, evidence), ...runFailures('sol-review-bootstrap'), ...runFailures('sol-review-confirmation')]),
    conjunct('queue-disposition', queue.failures),
    conjunct('studio-cli-shared-organism', [...runFailures('studio-journey'), ...runFailures('cli-journey')]),
    conjunct('release-artifacts', artifactFailures),
    conjunct('quality-gates', qualityFailures),
    conjunct('budgets-and-product-blockers', [...budgetFailures, ...severeBlockers.map(blocker => `${blocker.severity} ${blocker.id}: ${blocker.summary}`)]),
  ];
  const blockers = conjuncts.flatMap(item => item.failures.map(failure => `${item.id}: ${failure}`));
  return {
    schemaVersion: 1,
    wave: 7,
    contractDigest: manifest.contractDigest,
    releaseRootDigest: manifest.releaseRootDigest,
    ownerReleaseReady: blockers.length === 0,
    circulationReady: circulationFailures.length === 0,
    recoveryReady: recoveryFailures.length === 0,
    creativeLadderReady: creativeRunFailures.length === 0 && creativeBinding.length === 0 && creative.passed,
    compoundReady: compoundFailures.length === 0,
    conjuncts,
    blockers,
  };
}

export function expectedWave7ProductReviewer(): typeof WAVE7_SEAT_FREEZE.productReviewer {
  return WAVE7_SEAT_FREEZE.productReviewer;
}
