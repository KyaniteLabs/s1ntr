import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { computeProofSourceFingerprint, readCurrentGitCommit } from './ProofReceiptValidator.js';
import { validateCampaignReleaseRoot, type CampaignReleaseRoot } from './CampaignOrigin.js';

const SHA1 = /^[a-f0-9]{40}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const SCHEMA = 'sinter.wave8-release-root' as const;
const RECEIPT_SCHEMA = 'sinter.wave8-evidence-receipt' as const;

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${stable(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function digest(value: unknown): string {
  return createHash('sha256').update(stable(value)).digest('hex');
}

export type Wave8EvidenceClass = 'live' | 'execution' | 'deterministic-proof' | 'planned' | 'synthetic' | 'deferred';
export type Wave8EvidencePurpose = 'governed-product' | 'diagnostic';
export type Wave8ReceiptKind =
  | 'corpus' | 'product' | 'authority' | 'exact-evidence' | 'graph-migration'
  | 'idempotency' | 'schema-invalidation' | 'packed-install' | 'startup'
  | 'focused-checks' | 'build' | 'typecheck' | 'lint' | 'full-suite'
  | 'coverage' | 'deterministic-no-spend' | 'restart' | 'wave7-reproof'
  | 'frozen-install' | 'orphan-scan' | 'script-targets' | 'compound-health'
  | 'audio-build' | 'test-quality' | 'pack' | 'installed-startup'
  | 'deterministic-e2e' | 'safe-suite' | 'leak-audit' | 'semantic-audit'
  /** PRD six product-path kinds (W8C-02); generic product/exact-evidence cannot substitute. */
  | 'campaign-origin' | 'actual-executor' | 'creative-quality'
  | 'causal-revision' | 'sealed-transfer' | 'dream-recommendation';

const EVIDENCE_CLASSES: readonly Wave8EvidenceClass[] = [
  'live', 'execution', 'deterministic-proof', 'planned', 'synthetic', 'deferred',
];
const EVIDENCE_PURPOSES: readonly Wave8EvidencePurpose[] = ['governed-product', 'diagnostic'];
/** PRD W8C-02 six product-path kinds required for campaign close. */
export const WAVE8_PRD_PRODUCT_KINDS = Object.freeze([
  'campaign-origin', 'actual-executor', 'creative-quality',
  'causal-revision', 'sealed-transfer', 'dream-recommendation',
] as const satisfies readonly Wave8ReceiptKind[]);
const RECEIPT_KINDS: readonly Wave8ReceiptKind[] = [
  'corpus', 'product', 'authority', 'exact-evidence', 'graph-migration', 'idempotency',
  'schema-invalidation', 'packed-install', 'startup', 'focused-checks', 'build',
  'typecheck', 'lint', 'full-suite', 'coverage', 'deterministic-no-spend', 'restart',
  'wave7-reproof', 'frozen-install', 'orphan-scan', 'script-targets', 'compound-health',
  'audio-build', 'test-quality', 'pack', 'installed-startup', 'deterministic-e2e', 'safe-suite',
  'leak-audit', 'semantic-audit',
  ...WAVE8_PRD_PRODUCT_KINDS,
];

export interface Wave8EvidenceReceipt {
  schema: typeof RECEIPT_SCHEMA;
  schemaVersion: 1;
  receiptId: string;
  kind: Wave8ReceiptKind;
  generatedAt: string;
  sourceFingerprint: string;
  purpose?: Wave8EvidencePurpose;
  evidenceClass: Wave8EvidenceClass;
  passed: boolean;
  deterministic: boolean;
  spendUsd: number;
  providerCalls: number;
  artifactDigests: string[];
  resultDigest: string;
  schemaDigest: string;
  implementationDigest: string;
  payload: Record<string, unknown>;
}

export interface Wave8ReleaseRoot {
  schema: typeof SCHEMA;
  schemaVersion: 1;
  wave: 8;
  generatedAt: string;
  releaseHead: string;
  sourceFingerprint: string;
  activeDigests: { schema: string; implementation: string };
  receipts: Wave8EvidenceReceipt[];
  releaseRootDigest: string;
}

export interface Wave8ReadinessConjunct {
  id: string;
  passed: boolean;
  failures: string[];
}

export interface Wave8ReleaseReadinessReport {
  schemaVersion: 1;
  wave: 8;
  releaseRootDigest: string;
  releaseHead: string | null;
  sourceFingerprint: string | null;
  ownerReleaseReady: boolean;
  conjuncts: Wave8ReadinessConjunct[];
  blockers: string[];
  receiptCount: number;
}

export interface Wave8ReleaseRootPaths {
  rootPath: string;
}

export const WAVE8_RELEASE_CONJUNCT_IDS = Object.freeze([
  'corpus-complete', 'product-complete', 'authority-complete', 'exact-evidence',
  'graph-migration', 'idempotency', 'schema-implementation-invalidation',
  'source-fingerprint', 'quality-and-install', 'wave7-reproof',
  'campaign-origin', 'actual-executor', 'creative-quality',
  'causal-revision', 'sealed-transfer', 'dream-recommendation',
] as const);

export type Wave8NegativeConjunct = typeof WAVE8_RELEASE_CONJUNCT_IDS[number];
export interface Wave8PlantedNegative {
  id: string;
  owningConjunct: Wave8NegativeConjunct;
}

const WAVE8_PLANTED_NEGATIVE_PAIRS = [
  ['missing-corpus-receipt', 'corpus-complete'], ['corpus-not-passed', 'corpus-complete'],
  ['corpus-incomplete', 'corpus-complete'], ['corpus-source-digest-missing', 'corpus-complete'],
  ['corpus-duplicate-entry', 'corpus-complete'],
  ['missing-product-receipt', 'product-complete'], ['product-not-passed', 'product-complete'],
  ['product-delta-missing', 'product-complete'], ['product-lineage-mismatch', 'product-complete'],
  ['product-user-visible-missing', 'product-complete'], ['product-evidence-purpose-invalid', 'product-complete'],
  ['missing-authority-receipt', 'authority-complete'], ['authority-not-passed', 'authority-complete'],
  ['authority-owner-unverified', 'authority-complete'], ['authority-transfer-unbound', 'authority-complete'],
  ['authority-revocation-unchecked', 'authority-complete'], ['authority-evidence-purpose-invalid', 'authority-complete'],
  ['authority-owner-packets-incomplete', 'authority-complete'],
  ['missing-exact-evidence', 'exact-evidence'], ['exact-evidence-not-passed', 'exact-evidence'],
  ['exact-receipt-digest-missing', 'exact-evidence'], ['exact-evidence-duplicate', 'exact-evidence'],
  ['exact-evidence-class-invalid', 'exact-evidence'], ['exact-evidence-purpose-invalid', 'exact-evidence'],
  ['missing-graph-migration', 'graph-migration'], ['graph-not-passed', 'graph-migration'],
  ['graph-cycle-detected', 'graph-migration'], ['migration-not-roundtrip', 'graph-migration'],
  ['migration-receipt-unbound', 'graph-migration'],
  ['missing-idempotency', 'idempotency'], ['idempotency-not-passed', 'idempotency'],
  ['duplicate-effect-not-proved', 'idempotency'], ['duplicate-receipt-id', 'idempotency'],
  ['missing-schema-invalidation', 'schema-implementation-invalidation'],
  ['schema-invalidation-not-passed', 'schema-implementation-invalidation'],
  ['schema-digest-drift', 'schema-implementation-invalidation'],
  ['implementation-digest-drift', 'schema-implementation-invalidation'],
  ['source-fingerprint-missing', 'source-fingerprint'], ['source-fingerprint-drift', 'source-fingerprint'],
  ['quality-receipt-unbound', 'source-fingerprint'], ['deterministic-no-spend-labeled-live', 'source-fingerprint'],
  ['missing-packed-install', 'quality-and-install'], ['missing-startup', 'quality-and-install'],
  ['missing-focused-checks', 'quality-and-install'], ['missing-build-or-typecheck-lint', 'quality-and-install'],
  ['missing-wave7-reproof', 'wave7-reproof'], ['wave7-reproof-not-passed', 'wave7-reproof'],
  ['wave7-reproof-source-drift', 'wave7-reproof'],
  // PRD six product-path kinds (W8C-02) + execution-backed anti-theater
  ['missing-campaign-origin-receipt', 'campaign-origin'], ['campaign-origin-not-passed', 'campaign-origin'],
  ['campaign-origin-purpose-invalid', 'campaign-origin'], ['campaign-origin-not-execution-backed', 'campaign-origin'],
  ['campaign-origin-binding-missing', 'campaign-origin'],
  ['missing-actual-executor-receipt', 'actual-executor'], ['actual-executor-not-passed', 'actual-executor'],
  ['actual-executor-purpose-invalid', 'actual-executor'], ['actual-executor-not-execution-backed', 'actual-executor'],
  ['actual-executor-identity-missing', 'actual-executor'],
  ['missing-creative-quality-receipt', 'creative-quality'], ['creative-quality-not-passed', 'creative-quality'],
  ['creative-quality-purpose-invalid', 'creative-quality'], ['creative-quality-not-execution-backed', 'creative-quality'],
  ['creative-quality-judgment-missing', 'creative-quality'],
  ['missing-causal-revision-receipt', 'causal-revision'], ['causal-revision-not-passed', 'causal-revision'],
  ['causal-revision-purpose-invalid', 'causal-revision'], ['causal-revision-not-execution-backed', 'causal-revision'],
  ['causal-revision-signal-missing', 'causal-revision'],
  ['missing-sealed-transfer-receipt', 'sealed-transfer'], ['sealed-transfer-not-passed', 'sealed-transfer'],
  ['sealed-transfer-purpose-invalid', 'sealed-transfer'], ['sealed-transfer-not-execution-backed', 'sealed-transfer'],
  ['sealed-transfer-unsealed', 'sealed-transfer'],
  ['missing-dream-recommendation-receipt', 'dream-recommendation'],
  ['dream-recommendation-not-passed', 'dream-recommendation'],
  ['dream-recommendation-purpose-invalid', 'dream-recommendation'],
  ['dream-recommendation-not-execution-backed', 'dream-recommendation'],
  ['dream-recommendation-path-b-violated', 'dream-recommendation'],
] as const satisfies readonly (readonly [string, Wave8NegativeConjunct])[];

export const WAVE8_PLANTED_NEGATIVES = Object.freeze(
  WAVE8_PLANTED_NEGATIVE_PAIRS.map(([id, owningConjunct]) => ({ id, owningConjunct })),
);

export const WAVE8_PLANTED_NEGATIVE_IDS = Object.freeze(
  WAVE8_PLANTED_NEGATIVES.map(item => item.id),
);

// 47 baseline + 1 owner-packets + 24 PRD base (was) + 6 execution-backed = recalculate:
// authority +1; PRD six kinds: 5 each for origin/executor/quality/revision/transfer + 5 for dream = 30; total 47+1+30=78
if (WAVE8_PLANTED_NEGATIVES.length !== 78) {
  throw new Error(`Wave 8 release root requires exactly 78 planted negatives, got ${WAVE8_PLANTED_NEGATIVES.length}`);
}

function receiptBody(receipt: Wave8EvidenceReceipt): Omit<Wave8EvidenceReceipt, 'resultDigest'> {
  const { resultDigest: _resultDigest, ...body } = receipt;
  return body;
}

function validDigest(value: unknown): value is string {
  return typeof value === 'string' && SHA256.test(value);
}

function receiptDigest(receipt: Wave8EvidenceReceipt): string {
  return digest(receiptBody(receipt));
}

function rootBody(root: Wave8ReleaseRoot): Omit<Wave8ReleaseRoot, 'releaseRootDigest'> {
  const { releaseRootDigest: _releaseRootDigest, ...body } = root;
  return body;
}

export function wave8ReleaseRootPaths(repoRoot: string): Wave8ReleaseRootPaths {
  return {
    rootPath: process.env.SINTER_WAVE8_RELEASE_ROOT
      ? path.resolve(process.env.SINTER_WAVE8_RELEASE_ROOT)
      : path.join(repoRoot, '.quality', 'wave-8', 'release', 'release-root.json'),
  };
}

export function createWave8ReleaseRoot(
  input: Omit<Wave8ReleaseRoot, 'schema' | 'schemaVersion' | 'wave' | 'releaseRootDigest'>,
): Wave8ReleaseRoot {
  const root: Omit<Wave8ReleaseRoot, 'releaseRootDigest'> = {
    schema: SCHEMA, schemaVersion: 1, wave: 8, ...input,
  };
  return { ...root, releaseRootDigest: digest(root) };
}

export function createWave8EvidenceReceipt(
  input: Omit<Wave8EvidenceReceipt, 'schema' | 'schemaVersion' | 'resultDigest'>,
): Wave8EvidenceReceipt {
  const { purpose, ...required } = input;
  const body: Omit<Wave8EvidenceReceipt, 'resultDigest'> = {
    schema: RECEIPT_SCHEMA, schemaVersion: 1, ...required,
    ...(purpose === undefined ? {} : { purpose }),
  };
  return { ...body, resultDigest: digest(body) };
}

export function parseWave8EvidenceReceipt(value: unknown): Wave8EvidenceReceipt {
  if (!value || typeof value !== 'object') throw new Error('Wave 8 evidence receipt must be an object');
  const receipt = value as Wave8EvidenceReceipt;
  if (receipt.schema !== RECEIPT_SCHEMA || receipt.schemaVersion !== 1
    || typeof receipt.receiptId !== 'string' || !receipt.receiptId.trim()
    || !RECEIPT_KINDS.includes(receipt.kind)
    || !EVIDENCE_CLASSES.includes(receipt.evidenceClass)
    || (receipt.purpose !== undefined && !EVIDENCE_PURPOSES.includes(receipt.purpose))
    || typeof receipt.passed !== 'boolean' || typeof receipt.deterministic !== 'boolean'
    || !validDigest(receipt.sourceFingerprint) || !validDigest(receipt.resultDigest)
    || receipt.resultDigest !== receiptDigest(receipt)
    || !Array.isArray(receipt.artifactDigests)
    || receipt.artifactDigests.length === 0
    || receipt.artifactDigests.some(item => !validDigest(item))
    || !validDigest(receipt.schemaDigest) || !validDigest(receipt.implementationDigest)
    || !receipt.payload || typeof receipt.payload !== 'object' || Array.isArray(receipt.payload)) {
    throw new Error(`Wave 8 receipt ${String(receipt.receiptId)} is invalid`);
  }
  if (!Number.isFinite(Date.parse(receipt.generatedAt)) || !Number.isFinite(receipt.spendUsd)
    || receipt.spendUsd < 0
    || !Number.isInteger(receipt.providerCalls) || receipt.providerCalls < 0) {
    throw new Error(`Wave 8 receipt ${receipt.receiptId} has invalid execution metadata`);
  }
  return receipt;
}

export function parseWave8ReleaseRoot(value: unknown): Wave8ReleaseRoot {
  if (!value || typeof value !== 'object') throw new Error('Wave 8 release root must be an object');
  const root = value as Wave8ReleaseRoot;
  if (root.schema !== SCHEMA || root.schemaVersion !== 1 || root.wave !== 8) {
    throw new Error('Wave 8 release root schema mismatch');
  }
  if (!SHA1.test(root.releaseHead) || !validDigest(root.sourceFingerprint)) {
    throw new Error('Wave 8 release root identity is invalid');
  }
  if (!Number.isFinite(Date.parse(root.generatedAt))) throw new Error('Wave 8 root timestamp is invalid');
  if (!Array.isArray(root.receipts) || root.receipts.length === 0) {
    throw new Error('Wave 8 release root has no evidence receipts');
  }
  for (const receipt of root.receipts) {
    parseWave8EvidenceReceipt(receipt);
  }
  if (!validDigest(root.activeDigests?.schema) || !validDigest(root.activeDigests?.implementation)) {
    throw new Error('Wave 8 active schema/implementation digests are invalid');
  }
  if (root.releaseRootDigest !== digest(rootBody(root))) throw new Error('Wave 8 release root digest mismatch');
  return root;
}

export function requireCurrentWave8ReceiptSource(
  receipts: readonly Wave8EvidenceReceipt[],
  currentSourceFingerprint: string,
): string {
  const sources = new Set(receipts.map(receipt => receipt.sourceFingerprint));
  if (sources.size !== 1) throw new Error('Receipts do not share one source fingerprint');
  const receiptSource = [...sources][0];
  if (!validDigest(currentSourceFingerprint) || receiptSource !== currentSourceFingerprint) {
    throw new Error('Receipt source fingerprint does not match the current repository source');
  }
  return receiptSource;
}

function receiptByKind(receipts: readonly Wave8EvidenceReceipt[], kind: Wave8ReceiptKind): Wave8EvidenceReceipt[] {
  return receipts.filter(receipt => receipt.kind === kind);
}

function oneReceipt(receipts: readonly Wave8EvidenceReceipt[], kind: Wave8ReceiptKind): Wave8EvidenceReceipt | undefined {
  const matches = receiptByKind(receipts, kind);
  return matches.length === 1 ? matches[0] : undefined;
}

function payloadBoolean(receipt: Wave8EvidenceReceipt | undefined, key: string): boolean {
  return receipt?.payload[key] === true;
}

function payloadString(receipt: Wave8EvidenceReceipt | undefined, key: string): string | undefined {
  const value = receipt?.payload[key];
  return typeof value === 'string' ? value : undefined;
}

function payloadStrings(receipt: Wave8EvidenceReceipt | undefined, key: string): string[] {
  return Array.isArray(receipt?.payload[key])
    ? (receipt?.payload[key] as unknown[]).filter((value): value is string => typeof value === 'string')
    : [];
}

function isDeterministicNoSpend(receipt: Wave8EvidenceReceipt | undefined): boolean {
  return receipt?.kind === 'deterministic-no-spend'
    && receipt.passed === true
    && receipt.deterministic === true
    && receipt.evidenceClass === 'deterministic-proof'
    && receipt.spendUsd === 0
    && receipt.providerCalls === 0
    && receipt.payload.noSpend === true;
}

function fail(id: string, condition: boolean, failures: string[]): void {
  if (!condition) failures.push(id);
}

function evaluateCorpus(receipts: readonly Wave8EvidenceReceipt[]): string[] {
  const failures: string[] = [];
  const receipt = oneReceipt(receipts, 'corpus');
  if (!receipt) return ['missing-corpus-receipt'];
  fail('corpus-not-passed', receipt.passed, failures);
  fail('corpus-incomplete', payloadBoolean(receipt, 'complete'), failures);
  fail('corpus-source-digest-missing', payloadStrings(receipt, 'sourceDigests').length > 0, failures);
  const entries = payloadStrings(receipt, 'entries');
  fail('corpus-duplicate-entry', entries.length > 0 && new Set(entries).size === entries.length, failures);
  return failures;
}

function evaluateProduct(root: Wave8ReleaseRoot, campaign?: {
  readonly releaseRoot: CampaignReleaseRoot;
  readonly trustedKeys: ReadonlyMap<string, string>;
}, requireCampaignOrigin = false): string[] {
  const failures: string[] = [];
  const receipt = oneReceipt(root.receipts, 'product');
  if (!receipt) return ['missing-product-receipt'];
  fail('product-not-passed', receipt.passed, failures);
  const delta = receipt.payload.productDelta;
  fail('product-delta-missing', Boolean(delta && typeof delta === 'object'), failures);
  fail('product-lineage-mismatch', payloadString(receipt, 'inheritedFrom') === payloadString(receipt, 'priorReceiptId'), failures);
  fail('product-user-visible-missing', payloadBoolean(receipt, 'userVisible'), failures);
  fail('product-evidence-purpose-invalid', receipt.purpose === 'governed-product', failures);
  if (requireCampaignOrigin) {
    try {
      if (!campaign) throw new Error('campaign root or trust is missing');
      const verified = validateCampaignReleaseRoot(campaign.releaseRoot, { trustedKeys: campaign.trustedKeys });
      fail('product-campaign-origin-invalid', payloadString(receipt, 'campaignRootDigest') === verified.campaignRootDigest
        && payloadString(receipt, 'campaignBootstrapRootDigest') === verified.wave8ReleaseRootDigest
        && verified.releaseHead === root.releaseHead && verified.sourceFingerprint === root.sourceFingerprint
        && verified.schemaDigest === root.activeDigests.schema
        && verified.implementationDigest === root.activeDigests.implementation, failures);
    } catch { failures.push('product-campaign-origin-invalid'); }
  }
  return failures;
}

/** Discrete owner decisions required for authority-complete (PRD criterion 3). */
export const WAVE8_REQUIRED_OWNER_DECISIONS = Object.freeze([
  'preference',
  'release-worthiness',
  'learning-authorization',
  'promotion',
  'merge',
  'release',
] as const);

function evaluateAuthority(receipts: readonly Wave8EvidenceReceipt[]): string[] {
  const failures: string[] = [];
  const receipt = oneReceipt(receipts, 'authority');
  if (!receipt) return ['missing-authority-receipt'];
  fail('authority-not-passed', receipt.passed, failures);
  fail('authority-owner-unverified', payloadBoolean(receipt, 'ownerVerified'), failures);
  fail('authority-transfer-unbound', payloadBoolean(receipt, 'transferBound'), failures);
  fail('authority-revocation-unchecked', payloadBoolean(receipt, 'revocationChecked'), failures);
  fail('authority-evidence-purpose-invalid', receipt.purpose === 'governed-product', failures);
  // ownerVerified alone is not enough — require six decision kinds + digests (no CLI flag theater).
  const decisionKinds = Array.isArray(receipt.payload.ownerDecisionKinds)
    ? (receipt.payload.ownerDecisionKinds as unknown[]).filter((v): v is string => typeof v === 'string')
    : [];
  const decisionDigests = payloadStrings(receipt, 'ownerDecisionDigests');
  fail(
    'authority-owner-packets-incomplete',
    payloadBoolean(receipt, 'ownerVerified')
      && WAVE8_REQUIRED_OWNER_DECISIONS.every(kind => decisionKinds.includes(kind))
      && decisionDigests.length >= WAVE8_REQUIRED_OWNER_DECISIONS.length
      && decisionDigests.every(validDigest)
      && new Set(decisionDigests).size === decisionDigests.length,
    failures,
  );
  return failures;
}

function evaluateExactEvidence(receipts: readonly Wave8EvidenceReceipt[]): string[] {
  const failures: string[] = [];
  const matches = receiptByKind(receipts, 'exact-evidence');
  if (matches.length === 0) return ['missing-exact-evidence'];
  fail('exact-evidence-not-passed', matches.every(receipt => receipt.passed), failures);
  fail('exact-receipt-digest-missing', matches.every(receipt => validDigest(receipt.resultDigest)), failures);
  fail('exact-evidence-duplicate', new Set(matches.map(receipt => receipt.receiptId)).size === matches.length, failures);
  fail('exact-evidence-class-invalid', matches.every(receipt => receipt.evidenceClass === 'execution' || receipt.evidenceClass === 'live'), failures);
  fail('exact-evidence-purpose-invalid', matches.every(receipt => receipt.purpose === 'governed-product'), failures);
  return failures;
}

function evaluateGraphMigration(receipts: readonly Wave8EvidenceReceipt[]): string[] {
  const failures: string[] = [];
  const receipt = oneReceipt(receipts, 'graph-migration');
  if (!receipt) return ['missing-graph-migration'];
  fail('graph-not-passed', receipt.passed, failures);
  fail('graph-cycle-detected', receipt.payload.cycleDetected === false, failures);
  fail('migration-not-roundtrip', payloadBoolean(receipt, 'migrationRoundTrip'), failures);
  fail('migration-receipt-unbound', validDigest(payloadString(receipt, 'graphDigest')), failures);
  return failures;
}

function evaluateIdempotency(receipts: readonly Wave8EvidenceReceipt[]): string[] {
  const failures: string[] = [];
  const receipt = oneReceipt(receipts, 'idempotency');
  if (!receipt) return ['missing-idempotency'];
  fail('idempotency-not-passed', receipt.passed, failures);
  fail('duplicate-effect-not-proved', payloadBoolean(receipt, 'duplicateEffectsAbsent'), failures);
  const ids = receipts.map(item => item.receiptId);
  fail('duplicate-receipt-id', new Set(ids).size === ids.length, failures);
  return failures;
}

function evaluateSchemaInvalidation(root: Wave8ReleaseRoot): string[] {
  const failures: string[] = [];
  const receipt = oneReceipt(root.receipts, 'schema-invalidation');
  if (!receipt) return ['missing-schema-invalidation'];
  fail('schema-invalidation-not-passed', receipt.passed, failures);
  const productFamily = [
    'product', 'authority', 'exact-evidence',
    ...WAVE8_PRD_PRODUCT_KINDS,
  ];
  const relevant = [receipt, ...root.receipts.filter(item => productFamily.includes(item.kind))];
  fail('schema-digest-drift', relevant.every(item => item.schemaDigest === root.activeDigests.schema), failures);
  fail('implementation-digest-drift', relevant.every(item => item.implementationDigest === root.activeDigests.implementation), failures);
  return failures;
}

/**
 * PRD W8C-02 product-path kinds — generic product/exact-evidence cannot substitute.
 * Proof-script mint theater is fail-closed: kinds must be coordinator-emitted with
 * real provider execution (providerCalls > 0), not hardcoded payload booleans.
 */
function evaluatePrdProductKind(
  receipts: readonly Wave8EvidenceReceipt[],
  kind: typeof WAVE8_PRD_PRODUCT_KINDS[number],
): string[] {
  const failures: string[] = [];
  const receipt = oneReceipt(receipts, kind);
  if (!receipt) return [`missing-${kind}-receipt`];
  fail(`${kind}-not-passed`, receipt.passed, failures);
  fail(`${kind}-purpose-invalid`, receipt.purpose === 'governed-product', failures);
  // Reject mint-script theater: zero-spend zero-call "governed-product" payloads.
  fail(
    `${kind}-not-execution-backed`,
    receipt.deterministic === false
      && (receipt.evidenceClass === 'live' || receipt.evidenceClass === 'execution')
      && receipt.providerCalls > 0
      && payloadBoolean(receipt, 'coordinatorEmitted'),
    failures,
  );
  switch (kind) {
    case 'campaign-origin':
      fail('campaign-origin-binding-missing',
        validDigest(payloadString(receipt, 'campaignRootDigest'))
          && typeof receipt.payload.campaignRunId === 'string'
          && (receipt.payload.campaignRunId as string).length > 0
          && validDigest(payloadString(receipt, 'originResultDigest')),
        failures);
      break;
    case 'actual-executor':
      fail('actual-executor-identity-missing',
        typeof receipt.payload.resolvedModel === 'string'
          && (receipt.payload.resolvedModel as string).length > 0
          && typeof receipt.payload.resolvedProvider === 'string'
          && (receipt.payload.resolvedProvider as string).length > 0
          && validDigest(payloadString(receipt, 'executorAttestationDigest')),
        failures);
      break;
    case 'creative-quality':
      fail('creative-quality-judgment-missing',
        (payloadBoolean(receipt, 'qualityPassed') || typeof receipt.payload.qualityScore === 'number')
          && validDigest(payloadString(receipt, 'qualityEvidenceDigest')),
        failures);
      break;
    case 'causal-revision':
      fail('causal-revision-signal-missing',
        (typeof receipt.payload.revisionCount === 'number'
          || payloadBoolean(receipt, 'causalSignalPresent'))
          && validDigest(payloadString(receipt, 'revisionEvidenceDigest')),
        failures);
      break;
    case 'sealed-transfer':
      fail('sealed-transfer-unsealed',
        payloadBoolean(receipt, 'transferSealed')
          && validDigest(payloadString(receipt, 'transferSealDigest')),
        failures);
      break;
    case 'dream-recommendation':
      // Path B only for campaign close: non-promoting recommendation.
      fail('dream-recommendation-path-b-violated',
        receipt.payload.promote === false
          && receipt.payload.autoPromote === false
          && receipt.payload.path !== 'C'
          && validDigest(payloadString(receipt, 'recommendationDigest')),
        failures);
      break;
    default:
      break;
  }
  return failures;
}

function evaluateSource(root: Wave8ReleaseRoot, currentSourceFingerprint?: string): string[] {
  const failures: string[] = [];
  fail('source-fingerprint-missing', validDigest(root.sourceFingerprint), failures);
  fail('source-fingerprint-drift', root.receipts.every(item => item.sourceFingerprint === root.sourceFingerprint)
    && (currentSourceFingerprint === undefined
      || (validDigest(currentSourceFingerprint) && root.sourceFingerprint === currentSourceFingerprint)), failures);
  const qualityKinds = ['packed-install', 'startup', 'focused-checks', 'build', 'typecheck', 'lint', 'full-suite', 'coverage', 'deterministic-no-spend', 'restart', 'wave7-reproof', 'frozen-install', 'orphan-scan', 'script-targets', 'compound-health', 'audio-build', 'test-quality', 'pack', 'installed-startup', 'deterministic-e2e', 'safe-suite', 'leak-audit', 'semantic-audit'];
  fail('quality-receipt-unbound', root.receipts.filter(item => qualityKinds.includes(item.kind)).every(item => item.sourceFingerprint === root.sourceFingerprint), failures);
  fail('deterministic-no-spend-invalid', isDeterministicNoSpend(oneReceipt(root.receipts, 'deterministic-no-spend')), failures);
  const invalidLive = root.receipts.some(item => (item.deterministic || item.kind === 'deterministic-no-spend' || item.payload.noSpend === true)
    && item.evidenceClass === 'live');
  fail('deterministic-no-spend-labeled-live', !invalidLive, failures);
  return failures;
}

function evaluateQuality(root: Wave8ReleaseRoot): string[] {
  const failures: string[] = [];
  const requireOne = (kind: Wave8ReceiptKind): Wave8EvidenceReceipt | undefined => oneReceipt(root.receipts, kind);
  const packed = requireOne('packed-install');
  const startup = requireOne('startup');
  const focused = requireOne('focused-checks');
  fail('missing-packed-install', Boolean(packed?.passed), failures);
  fail('missing-startup', Boolean(startup?.passed), failures);
  fail('missing-focused-checks', Boolean(focused?.passed), failures);
  // Closed UltraQA path mints browser/provider-free `safe-suite` (and blocks unsafe
  // global coverage). Accept either full-suite+coverage or safe-suite+deterministic-e2e.
  const coreOk = ['build', 'typecheck', 'lint', 'deterministic-no-spend', 'restart']
    .map(kind => requireOne(kind as Wave8ReceiptKind))
    .every(receipt => Boolean(receipt?.passed));
  const fullSuiteOk = Boolean(requireOne('full-suite')?.passed)
    && Boolean(requireOne('coverage')?.passed);
  const closedSuiteOk = Boolean(requireOne('safe-suite')?.passed)
    && Boolean(requireOne('deterministic-e2e')?.passed);
  fail('missing-build-or-typecheck-lint', coreOk && (fullSuiteOk || closedSuiteOk), failures);
  fail('deterministic-no-spend-invalid', isDeterministicNoSpend(requireOne('deterministic-no-spend')), failures);
  return failures;
}

function evaluateWave7(root: Wave8ReleaseRoot): string[] {
  const failures: string[] = [];
  const receipt = oneReceipt(root.receipts, 'wave7-reproof');
  if (!receipt) return ['missing-wave7-reproof'];
  fail('wave7-reproof-not-passed', receipt.passed && payloadBoolean(receipt, 'reproved'), failures);
  fail('wave7-reproof-source-drift', payloadString(receipt, 'sourceFingerprint') === root.sourceFingerprint, failures);
  return failures;
}

export function validateWave8ReleaseRoot(
  root: Wave8ReleaseRoot,
  options: { currentSourceFingerprint?: string; requireCampaignOrigin?: boolean;
    campaign?: { releaseRoot: CampaignReleaseRoot; trustedKeys: ReadonlyMap<string, string> } } = {},
): Wave8ReleaseReadinessReport {
  const dimensions: Array<[Wave8NegativeConjunct, string[]]> = [
    ['corpus-complete', evaluateCorpus(root.receipts)],
    ['product-complete', evaluateProduct(root, options.campaign, options.requireCampaignOrigin)],
    ['authority-complete', evaluateAuthority(root.receipts)],
    ['exact-evidence', evaluateExactEvidence(root.receipts)],
    ['graph-migration', evaluateGraphMigration(root.receipts)],
    ['idempotency', evaluateIdempotency(root.receipts)],
    ['schema-implementation-invalidation', evaluateSchemaInvalidation(root)],
    ['source-fingerprint', evaluateSource(root, options.currentSourceFingerprint)],
    ['quality-and-install', evaluateQuality(root)],
    ['wave7-reproof', evaluateWave7(root)],
    ['campaign-origin', evaluatePrdProductKind(root.receipts, 'campaign-origin')],
    ['actual-executor', evaluatePrdProductKind(root.receipts, 'actual-executor')],
    ['creative-quality', evaluatePrdProductKind(root.receipts, 'creative-quality')],
    ['causal-revision', evaluatePrdProductKind(root.receipts, 'causal-revision')],
    ['sealed-transfer', evaluatePrdProductKind(root.receipts, 'sealed-transfer')],
    ['dream-recommendation', evaluatePrdProductKind(root.receipts, 'dream-recommendation')],
  ];
  const conjuncts = dimensions.map(([id, failures]) => ({ id, passed: failures.length === 0, failures }));
  return {
    schemaVersion: 1, wave: 8, releaseRootDigest: root.releaseRootDigest,
    releaseHead: root.releaseHead, sourceFingerprint: root.sourceFingerprint,
    ownerReleaseReady: conjuncts.every(item => item.passed), conjuncts,
    blockers: conjuncts.flatMap(item => item.passed ? [] : item.failures.map(failure => `${item.id}: ${failure}`)),
    receiptCount: root.receipts.length,
  };
}

export function assertWave8PreSpendReleaseRoot(
  root: Wave8ReleaseRoot,
  currentSourceFingerprint: string,
): Wave8ReleaseReadinessReport {
  const report = validateWave8ReleaseRoot(root, { currentSourceFingerprint });
  const required = report.conjuncts.filter(item =>
    item.id === 'schema-implementation-invalidation' || item.id === 'source-fingerprint');
  const provenance = report.conjuncts
    .filter(item => item.id === 'product-complete'
      || item.id === 'authority-complete' || item.id === 'exact-evidence')
    .flatMap(item => item.failures.filter(failure => failure.endsWith('purpose-invalid')));
  const failures = [
    ...required.flatMap(item => item.failures.filter(failure => failure !== 'deterministic-no-spend-invalid')),
    ...provenance,
  ];
  if (failures.length > 0) {
    throw new Error(`Pre-spend blocked: Wave 8 bootstrap release root is invalid: ${failures.join(', ')}`);
  }
  return report;
}

function unavailable(reason: string, repoRoot: string): Wave8ReleaseReadinessReport {
  const conjuncts = WAVE8_RELEASE_CONJUNCT_IDS.map(id => ({ id, passed: false, failures: [reason] }));
  return {
    schemaVersion: 1, wave: 8, releaseRootDigest: 'unfrozen', releaseHead: readCurrentGitCommit(repoRoot),
    sourceFingerprint: null, ownerReleaseReady: false, conjuncts,
    blockers: conjuncts.map(item => `${item.id}: ${reason}`), receiptCount: 0,
  };
}

export function collectWave8ReleaseRootTruth(repoRoot = process.cwd()): Wave8ReleaseReadinessReport {
  const rootPath = wave8ReleaseRootPaths(repoRoot).rootPath;
  if (!fs.existsSync(rootPath)) return unavailable('Wave 8 release root is missing', repoRoot);
  try {
    const root = parseWave8ReleaseRoot(JSON.parse(fs.readFileSync(rootPath, 'utf8')) as unknown);
    const current = computeProofSourceFingerprint(repoRoot)?.replace(/^sha256:/, '');
    let campaign: { releaseRoot: CampaignReleaseRoot; trustedKeys: ReadonlyMap<string, string> } | undefined;
    const campaignPath = process.env.SINTER_WAVE8_CAMPAIGN_ROOT;
    const trustPath = process.env.SINTER_CAMPAIGN_TRUST_STORE;
    if (campaignPath?.trim() && trustPath?.trim()) {
      const trust = JSON.parse(fs.readFileSync(path.resolve(trustPath), 'utf8')) as {
        keys?: { keyId: string; publicKeyPem: string }[];
      };
      campaign = { releaseRoot: JSON.parse(fs.readFileSync(path.resolve(campaignPath), 'utf8')) as CampaignReleaseRoot,
        trustedKeys: new Map((trust.keys ?? []).map(key => [key.keyId, key.publicKeyPem])) };
    }
    return validateWave8ReleaseRoot(root, { currentSourceFingerprint: current ?? '',
      requireCampaignOrigin: true, campaign });
  } catch (error) {
    return unavailable(`Wave 8 release root is invalid: ${error instanceof Error ? error.message : String(error)}`, repoRoot);
  }
}

export function formatWave8ReleaseRootTruth(report: Wave8ReleaseReadinessReport): string {
  return JSON.stringify(report, null, 2);
}

export function compareWave8ReleaseRootTruth(
  reports: Wave8ReleaseReadinessReport[],
): { passed: boolean; failures: string[] } {
  if (reports.length !== 3) return { passed: false, failures: ['exactly market, release, and terminal reports are required'] };
  const invalid = reports.flatMap((report, index) => {
    try { parseWave8ReleaseReadinessReport(report); return []; }
    catch (error) { return [`report ${index + 1} is invalid: ${error instanceof Error ? error.message : String(error)}`]; }
  });
  if (invalid.length > 0) return { passed: false, failures: invalid };
  const projection = (report: Wave8ReleaseReadinessReport) => JSON.stringify({
    wave: report.wave, releaseRootDigest: report.releaseRootDigest,
    releaseHead: report.releaseHead, sourceFingerprint: report.sourceFingerprint,
    ownerReleaseReady: report.ownerReleaseReady, conjuncts: report.conjuncts,
    blockers: report.blockers, receiptCount: report.receiptCount,
  });
  const expected = projection(reports[0]);
  const failures = reports.flatMap((report, index) => projection(report) === expected ? [] : [`report ${index + 1} disagrees with report 1`]);
  return { passed: failures.length === 0, failures };
}

export function parseWave8ReleaseReadinessReport(value: unknown): Wave8ReleaseReadinessReport {
  if (!value || typeof value !== 'object') throw new Error('Wave 8 readiness report must be an object');
  const report = value as Wave8ReleaseReadinessReport;
  if (report.schemaVersion !== 1 || report.wave !== 8) throw new Error('Wave 8 readiness report schema mismatch');
  if (report.releaseRootDigest !== 'unfrozen' && !validDigest(report.releaseRootDigest)) {
    throw new Error('Wave 8 readiness report release root digest is invalid');
  }
  if (report.releaseHead !== null && !SHA1.test(report.releaseHead)) throw new Error('Wave 8 readiness report HEAD is invalid');
  if (report.sourceFingerprint !== null && !validDigest(report.sourceFingerprint)) {
    throw new Error('Wave 8 readiness report source fingerprint is invalid');
  }
  if (!Number.isInteger(report.receiptCount) || report.receiptCount < 0
    || typeof report.ownerReleaseReady !== 'boolean' || !Array.isArray(report.conjuncts)
    || !Array.isArray(report.blockers)) throw new Error('Wave 8 readiness report fields are invalid');
  if (report.conjuncts.map(item => item.id).join('\0') !== WAVE8_RELEASE_CONJUNCT_IDS.join('\0')) {
    throw new Error('Wave 8 readiness report conjunct set is incomplete');
  }
  for (const conjunct of report.conjuncts) {
    if (typeof conjunct.passed !== 'boolean' || !Array.isArray(conjunct.failures)
      || conjunct.failures.some(failure => typeof failure !== 'string' || !failure)
      || conjunct.passed !== (conjunct.failures.length === 0)) {
      throw new Error(`Wave 8 readiness conjunct ${conjunct.id} is invalid`);
    }
  }
  const expectedBlockers = report.conjuncts.flatMap(item => item.failures.map(failure => `${item.id}: ${failure}`));
  if (report.blockers.some(blocker => typeof blocker !== 'string')
    || JSON.stringify(report.blockers) !== JSON.stringify(expectedBlockers)
    || report.ownerReleaseReady !== report.conjuncts.every(item => item.passed)) {
    throw new Error('Wave 8 readiness report summary is inconsistent');
  }
  return report;
}

export function auditWave8CurrentAuthority(markdown: string): { passed: boolean; failures: string[] } {
  const failures: string[] = [];
  fail('CURRENT.md does not point to the Wave 8 release root',
    markdown.includes('.quality/wave-8/release/release-root.json'), failures);
  fail('CURRENT.md does not point to the approved Wave 8 closure plan',
    markdown.includes('.omx/plans/prd-wave8-closure-wave9-admission.md'), failures);
  fail('CURRENT.md does not name the W8C-01 through W8C-09 implementation range',
    /#714\s+through\s+#722/i.test(markdown), failures);
  fail('CURRENT.md still presents Wave 8 as an unstarted planning task',
    !/^## Wave 8 planning start$/m.test(markdown), failures);
  fail('CURRENT.md does not mark issue #462 as historical',
    /issue #462.{0,80}historical|historical.{0,80}issue #462/is.test(markdown), failures);
  return { passed: failures.length === 0, failures };
}
