import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  AutoresearchExperimentRunner,
  type AutoresearchExperimentInput,
  type AutoresearchExperimentResult,
  type AutoresearchStageResult,
} from './AutoresearchExperimentRunner.js';
import {
  assertIndependentReview,
  assertSealedEvaluator,
  assertStageOnePromotion,
  type ReviewerIdentity,
  type ReviewerVerdict,
} from './RecursiveImprovementContract.js';

export const SEALED_EVALUATOR_MANIFEST_VERSION = 1 as const;
export const SEALED_REVIEW_READ_ONLY_TOOLS = Object.freeze([
  'readFile',
  'search',
  'searchCode',
  'searchDocs',
  'listDir',
  'lsp',
  'astValidate',
  'importGuard',
  'searchTools',
  'gitStatus',
]);

export interface SealedFileRef {
  path: string;
  sha256: string;
}

export interface SealedEvaluatorManifest {
  schemaVersion: typeof SEALED_EVALUATOR_MANIFEST_VERSION;
  evaluatorCode: SealedFileRef[];
  dependencies: SealedFileRef[];
  prompt: { id: string; sha256: string };
  reviewer: ReviewerIdentity;
  fixtures: SealedFileRef[];
  thresholds: Record<string, number>;
  controls: Array<{ id: string; sha256: string }>;
  environment: Record<string, string>;
  tools: string[];
  artifactSelection: { strategy: string; refs: string[] };
}

export interface ProviderIdentityReceipt extends ReviewerIdentity {
  requestId: string;
  observedAt: string;
}

export interface IndependentReviewResult {
  verdict: ReviewerVerdict;
  identity: ProviderIdentityReceipt;
  evidenceRefs: string[];
  disagreement: string[];
  requestedFollowUp: string[];
  usage: AutoresearchStageResult['usage'];
}

export interface IndependentReviewContext {
  experimentId: string;
  lineageId: string;
  author: ReviewerIdentity;
  manifest: SealedEvaluatorManifest;
  manifestDigest: string;
  candidateFiles: string[];
  signal: AbortSignal;
}

export interface SealedReviewReceipt {
  schemaVersion: 1;
  experimentId: string;
  lineageId: string;
  author: ReviewerIdentity;
  reviewer: ProviderIdentityReceipt;
  verdict: ReviewerVerdict;
  manifestDigest: string;
  closureBeforeDigest: string;
  closureAfterDigest: string;
  evidenceRefs: string[];
  disagreement: string[];
  requestedFollowUp: string[];
  followUpRequiresNewExperiment: true;
  reviewerTools: string[];
  receiptDigest: string;
}

export interface ReviewedAutoresearchResult {
  experiment: AutoresearchExperimentResult;
  review: SealedReviewReceipt;
  deliveryAuthority: 'candidate-only';
}

export interface ReviewedAutoresearchInput {
  experiment: AutoresearchExperimentInput;
  manifestPath: string;
  executeReview(context: IndependentReviewContext): Promise<IndependentReviewResult>;
}

function sha256(value: Buffer | string): string {
  return createHash('sha256').update(value).digest('hex');
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map(key => (
      `${JSON.stringify(key)}:${stable(record[key])}`
    )).join(',')}}`;
  }
  return JSON.stringify(value);
}

function requireDigest(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) {
    throw new Error(`SEALED_EVALUATOR_INVALID_DIGEST:${field}`);
  }
}

function requireStrings(value: unknown, field: string): asserts value is string[] {
  if (!Array.isArray(value) || value.length === 0 || value.some(item => (
    typeof item !== 'string' || !item.trim()
  ))) {
    throw new Error(`SEALED_EVALUATOR_MISSING:${field}`);
  }
}

function requireRecord(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`SEALED_EVALUATOR_MISSING:${field}`);
  }
  return value as Record<string, unknown>;
}

function parseFileRefs(value: unknown, field: string): SealedFileRef[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`SEALED_EVALUATOR_MISSING:${field}`);
  }
  const refs = value.map((item, index) => {
    const record = requireRecord(item, `${field}[${index}]`);
    if (
      typeof record.path !== 'string'
      || !record.path.trim()
      || path.isAbsolute(record.path)
      || record.path.split(/[\\/]/).includes('..')
    ) {
      throw new Error(`SEALED_EVALUATOR_INVALID_PATH:${field}[${index}]`);
    }
    requireDigest(record.sha256, `${field}[${index}].sha256`);
    return { path: record.path, sha256: record.sha256 };
  });
  if (new Set(refs.map(ref => ref.path)).size !== refs.length) {
    throw new Error(`SEALED_EVALUATOR_DUPLICATE_PATH:${field}`);
  }
  return refs;
}

function parseIdentity(value: unknown): ReviewerIdentity {
  const record = requireRecord(value, 'reviewer');
  if (
    typeof record.provider !== 'string'
    || typeof record.model !== 'string'
    || record.verified !== true
  ) {
    throw new Error('SEALED_EVALUATOR_REVIEWER_UNVERIFIED');
  }
  return { provider: record.provider, model: record.model, verified: true };
}

export function parseSealedEvaluatorManifest(value: unknown): SealedEvaluatorManifest {
  const record = requireRecord(value, 'manifest');
  if (record.schemaVersion !== SEALED_EVALUATOR_MANIFEST_VERSION) {
    throw new Error('SEALED_EVALUATOR_VERSION_UNSUPPORTED');
  }
  const prompt = requireRecord(record.prompt, 'prompt');
  const selection = requireRecord(record.artifactSelection, 'artifactSelection');
  const thresholds = requireRecord(record.thresholds, 'thresholds');
  const environment = requireRecord(record.environment, 'environment');
  if (typeof prompt.id !== 'string' || !prompt.id.trim()) {
    throw new Error('SEALED_EVALUATOR_MISSING:prompt.id');
  }
  requireDigest(prompt.sha256, 'prompt.sha256');
  requireStrings(record.tools, 'tools');
  if (record.tools.some(tool =>
    !(SEALED_REVIEW_READ_ONLY_TOOLS as readonly string[]).includes(tool))) {
    throw new Error('REVIEWER_WRITE_DENIED: reviewer tool is not read-only');
  }
  requireStrings(selection.refs, 'artifactSelection.refs');
  if (typeof selection.strategy !== 'string' || !selection.strategy.trim()) {
    throw new Error('SEALED_EVALUATOR_MISSING:artifactSelection.strategy');
  }
  if (
    Object.keys(thresholds).length === 0
    || Object.values(thresholds).some(value => typeof value !== 'number' || !Number.isFinite(value))
  ) {
    throw new Error('SEALED_EVALUATOR_MISSING:thresholds');
  }
  if (
    Object.keys(environment).length === 0
    || Object.values(environment).some(value => typeof value !== 'string' || !value.trim())
  ) {
    throw new Error('SEALED_EVALUATOR_MISSING:environment');
  }
  if (!Array.isArray(record.controls) || record.controls.length === 0) {
    throw new Error('SEALED_EVALUATOR_MISSING:controls');
  }
  const controls = record.controls.map((item, index) => {
    const control = requireRecord(item, `controls[${index}]`);
    if (typeof control.id !== 'string' || !control.id.trim()) {
      throw new Error(`SEALED_EVALUATOR_MISSING:controls[${index}].id`);
    }
    requireDigest(control.sha256, `controls[${index}].sha256`);
    return { id: control.id, sha256: control.sha256 };
  });
  return {
    schemaVersion: SEALED_EVALUATOR_MANIFEST_VERSION,
    evaluatorCode: parseFileRefs(record.evaluatorCode, 'evaluatorCode'),
    dependencies: parseFileRefs(record.dependencies, 'dependencies'),
    prompt: { id: prompt.id, sha256: prompt.sha256 },
    reviewer: parseIdentity(record.reviewer),
    fixtures: parseFileRefs(record.fixtures, 'fixtures'),
    thresholds: thresholds as Record<string, number>,
    controls,
    environment: environment as Record<string, string>,
    tools: [...record.tools] as string[],
    artifactSelection: {
      strategy: selection.strategy,
      refs: [...selection.refs] as string[],
    },
  };
}

function identityKey(identity: ReviewerIdentity): string {
  return `${identity.provider.trim().toLowerCase()}/${identity.model.trim().toLowerCase()}`;
}

async function loadManifest(input: ReviewedAutoresearchInput): Promise<{
  manifest: SealedEvaluatorManifest;
  manifestPath: string;
  manifestDigest: string;
}> {
  const manifestPath = await fs.realpath(input.manifestPath);
  const workspaceRoot = await fs.realpath(input.experiment.workspaceRoot);
  if (
    manifestPath === workspaceRoot
    || manifestPath.startsWith(`${workspaceRoot}${path.sep}`)
  ) {
    throw new Error('SEALED_EVALUATOR_INSIDE_CANDIDATE_WORKTREE');
  }
  const content = await fs.readFile(manifestPath);
  return {
    manifest: parseSealedEvaluatorManifest(JSON.parse(content.toString('utf8'))),
    manifestPath,
    manifestDigest: sha256(content),
  };
}

function importedSpecifiers(content: string): string[] {
  const specs = new Set<string>();
  const pattern = /(?:from\s+|import\s*\(|require\s*\()\s*['"]([^'"]+)['"]/g;
  for (const match of content.matchAll(pattern)) specs.add(match[1]);
  for (const match of content.matchAll(/\bimport\s*['"]([^'"]+)['"]/g)) {
    specs.add(match[1]);
  }
  return [...specs];
}

function resolvePinnedImport(
  source: string,
  specifier: string,
  pinned: Set<string>,
): string {
  if (!specifier.startsWith('.')) {
    throw new Error(`SEALED_EVALUATOR_UNPINNED_PACKAGE:${specifier}`);
  }
  const base = path.posix.normalize(path.posix.join(path.posix.dirname(source), specifier));
  const candidates = [base, `${base}.js`, `${base}.ts`, `${base}/index.js`, `${base}/index.ts`];
  const resolved = candidates.find(candidate => pinned.has(candidate));
  if (!resolved) throw new Error(`SEALED_EVALUATOR_UNPINNED_IMPORT:${source}:${specifier}`);
  return resolved;
}

function assertCompleteClosure(
  manifest: SealedEvaluatorManifest,
  contents: Map<string, string>,
): void {
  const code = [...manifest.evaluatorCode, ...manifest.dependencies];
  const pinned = new Set(code.map(ref => ref.path));
  const reachable = new Set(manifest.evaluatorCode.map(ref => ref.path));
  const queue = [...reachable];
  while (queue.length > 0) {
    const source = queue.shift()!;
    for (const specifier of importedSpecifiers(contents.get(source) ?? '')) {
      const dependency = resolvePinnedImport(source, specifier, pinned);
      if (!reachable.has(dependency)) {
        reachable.add(dependency);
        queue.push(dependency);
      }
    }
  }
  for (const dependency of manifest.dependencies) {
    if (!reachable.has(dependency.path)) {
      throw new Error(`SEALED_EVALUATOR_UNREACHABLE_DEPENDENCY:${dependency.path}`);
    }
  }
}

async function hashClosure(
  manifestPath: string,
  manifestDigest: string,
  manifest: SealedEvaluatorManifest,
): Promise<string> {
  const root = path.dirname(manifestPath);
  const currentManifestDigest = sha256(await fs.readFile(manifestPath));
  if (currentManifestDigest !== manifestDigest) {
    throw new Error('SEALED_EVALUATOR_MANIFEST_DRIFT');
  }
  const refs = [
    ...manifest.evaluatorCode,
    ...manifest.dependencies,
    ...manifest.fixtures,
  ];
  const observed: Array<{ path: string; sha256: string }> = [];
  const contents = new Map<string, string>();
  for (const ref of refs) {
    const target = await fs.realpath(path.join(root, ref.path));
    if (!target.startsWith(`${root}${path.sep}`)) {
      throw new Error(`SEALED_EVALUATOR_CLOSURE_ESCAPE:${ref.path}`);
    }
    const content = await fs.readFile(target);
    const actual = sha256(content);
    if (actual !== ref.sha256) {
      throw new Error(`SEALED_EVALUATOR_FILE_DRIFT:${ref.path}`);
    }
    contents.set(ref.path, content.toString('utf8'));
    observed.push({ path: ref.path, sha256: actual });
  }
  assertCompleteClosure(manifest, contents);
  return sha256(stable({ manifestDigest, observed }));
}

function validateReview(
  author: ReviewerIdentity,
  manifest: SealedEvaluatorManifest,
  result: IndependentReviewResult,
): void {
  assertIndependentReview({
    author,
    reviewer: result.identity,
    reviewerTools: manifest.tools,
  });
  if (identityKey(result.identity) !== identityKey(manifest.reviewer)) {
    throw new Error('SEALED_EVALUATOR_REVIEWER_IDENTITY_MISMATCH');
  }
  if (!result.identity.requestId.trim() || !result.identity.observedAt.trim()) {
    throw new Error('SEALED_EVALUATOR_PROVIDER_RECEIPT_MISSING');
  }
  if (
    !['approve', 'veto'].includes(result.verdict)
    || result.evidenceRefs.length === 0
    || result.evidenceRefs.some(ref => !ref.trim())
  ) {
    throw new Error('SEALED_EVALUATOR_REVIEW_EVIDENCE_MISSING');
  }
}

function sealReceipt(
  value: Omit<SealedReviewReceipt, 'receiptDigest'>,
): SealedReviewReceipt {
  return { ...value, receiptDigest: sha256(stable(value)) };
}

export class ReviewedAutoresearchExperimentRunner {
  constructor(
    private readonly runner = new AutoresearchExperimentRunner(),
  ) {}

  async run(input: ReviewedAutoresearchInput): Promise<ReviewedAutoresearchResult> {
    const loaded = await loadManifest(input);
    assertIndependentReview({
      author: input.experiment.author,
      reviewer: loaded.manifest.reviewer,
      reviewerTools: loaded.manifest.tools,
    });
    const before = await hashClosure(
      loaded.manifestPath,
      loaded.manifestDigest,
      loaded.manifest,
    );
    let reviewReceipt: SealedReviewReceipt | undefined;
    const executeStage = input.experiment.executeStage;
    const experiment = await this.runner.run({
      ...input.experiment,
      executeStage: async (context) => {
        if (context.state !== 'review') return executeStage(context);
        let result: IndependentReviewResult;
        let after: string;
        try {
          result = await input.executeReview({
            experimentId: input.experiment.contract.experimentId,
            lineageId: input.experiment.contract.lineageId,
            author: { ...input.experiment.author },
            manifest: structuredClone(loaded.manifest),
            manifestDigest: loaded.manifestDigest,
            candidateFiles: [...input.experiment.candidateFiles],
            signal: context.signal,
          });
        } finally {
          after = await hashClosure(
            loaded.manifestPath,
            loaded.manifestDigest,
            loaded.manifest,
          );
        }
        assertSealedEvaluator({
          manifestHash: before,
          beforeHash: before,
          afterHash: after,
          identityVerified: result.identity.verified,
          evidenceComplete: result.evidenceRefs.length > 0,
        });
        validateReview(input.experiment.author, loaded.manifest, result);
        reviewReceipt = sealReceipt({
          schemaVersion: 1,
          experimentId: input.experiment.contract.experimentId,
          lineageId: input.experiment.contract.lineageId,
          author: { ...input.experiment.author },
          reviewer: { ...result.identity },
          verdict: result.verdict,
          manifestDigest: loaded.manifestDigest,
          closureBeforeDigest: before,
          closureAfterDigest: after,
          evidenceRefs: [...result.evidenceRefs],
          disagreement: [...result.disagreement],
          requestedFollowUp: [...result.requestedFollowUp],
          followUpRequiresNewExperiment: true,
          reviewerTools: [...loaded.manifest.tools],
        });
        return {
          passed: result.verdict === 'approve',
          evidenceRefs: [...result.evidenceRefs],
          usage: { ...result.usage },
          verdict: result.verdict,
        };
      },
    });
    if (!reviewReceipt) {
      throw new Error(`SEALED_EVALUATOR_REVIEW_FAILED:${experiment.failure?.reason ?? 'missing'}`);
    }
    if (experiment.terminal === 'candidate') {
      assertReviewedCandidate(input.experiment.contract, experiment, reviewReceipt);
    }
    return { experiment, review: reviewReceipt, deliveryAuthority: 'candidate-only' };
  }
}

export function assertReviewedCandidate(
  contract: AutoresearchExperimentInput['contract'],
  experiment: AutoresearchExperimentResult,
  review: SealedReviewReceipt,
): void {
  if (experiment.terminal !== 'candidate') {
    throw new Error('REVIEWED_CANDIDATE_NOT_AVAILABLE');
  }
  const { receiptDigest, ...unsigned } = review;
  if (sha256(stable(unsigned)) !== receiptDigest) {
    throw new Error('SEALED_REVIEW_RECEIPT_TAMPERED');
  }
  if (
    review.experimentId !== experiment.experimentId
    || review.lineageId !== experiment.lineageId
  ) {
    throw new Error('SEALED_REVIEW_LINEAGE_MISMATCH');
  }
  assertStageOnePromotion({
    contract: { ...contract, state: 'review' },
    action: 'emit-candidate',
    reviewerVerdict: review.verdict,
    verified: true,
  });
}
