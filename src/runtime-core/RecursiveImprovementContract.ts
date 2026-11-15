export const RECURSIVE_CONTRACT_VERSION = 1 as const;

export const RECURSIVE_LOOPS = [
  'create',
  'dream',
  'consolidate',
  'autoresearch',
  'assimilate',
] as const;

export type RecursiveLoop = typeof RECURSIVE_LOOPS[number];

export const EXPERIMENT_STATES = [
  'observe',
  'hypothesize',
  'baseline',
  'reproduce',
  'mutate',
  'verify',
  'artifact-evaluate',
  'review',
  'candidate',
  'restore',
  'learn',
] as const;

export type ExperimentState = typeof EXPERIMENT_STATES[number];

export const MUTATION_PATH_CLASSES = [
  'candidate-source',
  'generated-owned',
  'evidence-state',
  'protected-evaluator',
  'sealed-evaluator-dependency',
  'secret-config-git',
] as const;

export type MutationPathClass = typeof MUTATION_PATH_CLASSES[number];

export const EVIDENCE_TRUST_CLASSES = [
  'owner',
  'verified-system',
  'model-inference',
  'untrusted-external',
] as const;

export type EvidenceTrustClass = typeof EVIDENCE_TRUST_CLASSES[number];
export type EvidenceTaint = 'clean' | 'tainted';

export interface RecursiveContractReceipt {
  receiptId: string;
  experimentId: string;
  lineageId: string;
  loop: RecursiveLoop;
  state: ExperimentState;
  trust: EvidenceTrustClass;
  taint: EvidenceTaint;
  evidenceRefs: string[];
  timestamp: string;
}

export interface ExperimentBudgets {
  tokens: number;
  calls: number;
  timeMs: number;
  retries: number;
  artifacts: number;
  diskBytes: number;
  worktrees: number;
  reviewRounds: number;
}

export interface RecursiveExperimentContract {
  version: typeof RECURSIVE_CONTRACT_VERSION;
  loop: RecursiveLoop;
  experimentId: string;
  lineageId: string;
  state: ExperimentState;
  stage: 'shadow';
  sourceMutationRequested: boolean;
  budgets: ExperimentBudgets;
}

export interface ReviewerIdentity {
  provider: string;
  model: string;
  verified: boolean;
}

export class RecursiveContractError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(`${code}: ${message}`);
    this.name = 'RecursiveContractError';
  }
}

function requireRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new RecursiveContractError('INVALID_CONTRACT', 'contract must be an object');
  }
  return value as Record<string, unknown>;
}

function requireId(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new RecursiveContractError('MISSING_LINEAGE', `${field} is required`);
  }
  return value;
}

function requireMember<T extends readonly string[]>(
  value: unknown,
  allowed: T,
  code: string,
  field: string,
): T[number] {
  if (typeof value !== 'string' || !allowed.includes(value)) {
    throw new RecursiveContractError(code, `unknown ${field}: ${String(value)}`);
  }
  return value as T[number];
}

function requireBudgets(value: unknown): ExperimentBudgets {
  const record = requireRecord(value);
  const fields: Array<keyof ExperimentBudgets> = [
    'tokens', 'calls', 'timeMs', 'retries', 'artifacts',
    'diskBytes', 'worktrees', 'reviewRounds',
  ];
  for (const field of fields) {
    const amount = record[field];
    if (typeof amount !== 'number' || !Number.isFinite(amount) || amount <= 0) {
      throw new RecursiveContractError('INVALID_BUDGET', `${field} must be finite and positive`);
    }
  }
  return record as unknown as ExperimentBudgets;
}

export function parseRecursiveExperimentContract(
  value: unknown,
): RecursiveExperimentContract {
  const record = requireRecord(value);
  if (record.version !== RECURSIVE_CONTRACT_VERSION) {
    throw new RecursiveContractError(
      'UNKNOWN_CONTRACT_VERSION',
      `expected version ${RECURSIVE_CONTRACT_VERSION}`,
    );
  }
  const loop = requireMember(record.loop, RECURSIVE_LOOPS, 'UNKNOWN_LOOP', 'loop');
  const state = requireMember(
    record.state,
    EXPERIMENT_STATES,
    'UNKNOWN_STATE',
    'state',
  );
  const contract: RecursiveExperimentContract = {
    version: RECURSIVE_CONTRACT_VERSION,
    loop,
    experimentId: requireId(record.experimentId, 'experimentId'),
    lineageId: requireId(record.lineageId, 'lineageId'),
    state,
    stage: 'shadow',
    sourceMutationRequested: record.sourceMutationRequested === true,
    budgets: requireBudgets(record.budgets),
  };
  if (record.stage !== 'shadow') {
    throw new RecursiveContractError('INVALID_STAGE', 'Wave 5 permits shadow stage only');
  }
  if (contract.sourceMutationRequested && contract.loop !== 'autoresearch') {
    throw new RecursiveContractError(
      'MUTATION_AUTHORITY_DENIED',
      'only Autoresearch may request source mutation',
    );
  }
  return contract;
}

export function parseRecursiveContractReceipt(
  value: unknown,
): RecursiveContractReceipt {
  const record = requireRecord(value);
  const trust = requireMember(
    record.trust,
    EVIDENCE_TRUST_CLASSES,
    'UNKNOWN_TRUST_CLASS',
    'trust class',
  );
  const taint = requireMember(
    record.taint,
    ['clean', 'tainted'] as const,
    'UNKNOWN_TAINT',
    'taint',
  );
  if (
    !Array.isArray(record.evidenceRefs)
    || record.evidenceRefs.some((ref) => typeof ref !== 'string' || !ref.trim())
  ) {
    throw new RecursiveContractError(
      'INVALID_EVIDENCE_REFS',
      'evidenceRefs must contain non-empty immutable references',
    );
  }
  return {
    receiptId: requireId(record.receiptId, 'receiptId'),
    experimentId: requireId(record.experimentId, 'experimentId'),
    lineageId: requireId(record.lineageId, 'lineageId'),
    loop: requireMember(record.loop, RECURSIVE_LOOPS, 'UNKNOWN_LOOP', 'loop'),
    state: requireMember(record.state, EXPERIMENT_STATES, 'UNKNOWN_STATE', 'state'),
    trust,
    taint,
    evidenceRefs: [...record.evidenceRefs] as string[],
    timestamp: requireId(record.timestamp, 'timestamp'),
  };
}

const ALLOWED_TRANSITIONS: Record<ExperimentState, readonly ExperimentState[]> = {
  observe: ['hypothesize'],
  hypothesize: ['baseline'],
  baseline: ['reproduce'],
  reproduce: ['mutate'],
  mutate: ['verify'],
  verify: ['artifact-evaluate'],
  'artifact-evaluate': ['review'],
  review: ['candidate', 'restore'],
  candidate: ['learn'],
  restore: ['learn'],
  learn: [],
};

export function assertExperimentTransition(
  contractValue: unknown,
  nextStateValue: unknown,
): ExperimentState {
  const contract = parseRecursiveExperimentContract(contractValue);
  const nextState = requireMember(
    nextStateValue,
    EXPERIMENT_STATES,
    'UNKNOWN_STATE',
    'state',
  );
  if (!ALLOWED_TRANSITIONS[contract.state].includes(nextState)) {
    throw new RecursiveContractError(
      'INVALID_TRANSITION',
      `${contract.state} cannot transition to ${nextState}`,
    );
  }
  return nextState;
}

export function assertMutationAuthority(input: {
  contract: unknown;
  pathClass: unknown;
  activeExperiment: boolean;
  declaredGeneratedOwner?: boolean;
}): MutationPathClass {
  const contract = parseRecursiveExperimentContract(input.contract);
  const pathClass = requireMember(
    input.pathClass,
    MUTATION_PATH_CLASSES,
    'UNKNOWN_PATH_CLASS',
    'path class',
  );
  if (
    !input.activeExperiment
    || contract.loop !== 'autoresearch'
    || !contract.sourceMutationRequested
  ) {
    throw new RecursiveContractError(
      'MUTATION_AUTHORITY_DENIED',
      'an active Autoresearch experiment is required',
    );
  }
  if (pathClass === 'candidate-source') return pathClass;
  if (pathClass === 'generated-owned' && input.declaredGeneratedOwner === true) {
    return pathClass;
  }
  if (
    pathClass === 'protected-evaluator'
    || pathClass === 'sealed-evaluator-dependency'
  ) {
    throw new RecursiveContractError(
      'JUDGE_MUTATION_DENIED',
      'direct and indirect evaluator mutation is forbidden',
    );
  }
  throw new RecursiveContractError(
    'MUTATION_PATH_DENIED',
    `${pathClass} is not candidate source`,
  );
}

function identityKey(identity: ReviewerIdentity): string {
  return `${identity.provider.trim().toLowerCase()}/${identity.model.trim().toLowerCase()}`;
}

export function assertIndependentReview(input: {
  author: ReviewerIdentity;
  reviewer: ReviewerIdentity;
  reviewerTools: readonly string[];
}): void {
  const identities = [input.author, input.reviewer];
  if (identities.some((identity) => (
    !identity.verified || !identity.provider.trim() || !identity.model.trim()
  ))) {
    throw new RecursiveContractError(
      'UNVERIFIED_IDENTITY',
      'author and reviewer identities must be provider-proven',
    );
  }
  if (identityKey(input.author) === identityKey(input.reviewer)) {
    throw new RecursiveContractError(
      'SELF_REVIEW_DENIED',
      'author and reviewer must be different provider-proven models',
    );
  }
  const writeTools = new Set(['writeFile', 'applyEdit', 'npm', 'runBuild']);
  if (input.reviewerTools.some((tool) => writeTools.has(tool))) {
    throw new RecursiveContractError(
      'REVIEWER_WRITE_DENIED',
      'independent reviewer tools must be read-only',
    );
  }
}

export function assertSealedEvaluator(input: {
  manifestHash?: string;
  beforeHash?: string;
  afterHash?: string;
  identityVerified: boolean;
  evidenceComplete: boolean;
}): void {
  if (
    !input.manifestHash
    || !input.beforeHash
    || !input.afterHash
    || !input.identityVerified
    || !input.evidenceComplete
  ) {
    throw new RecursiveContractError(
      'MISSING_EVALUATOR_EVIDENCE',
      'sealed evaluator identity and evidence must be complete',
    );
  }
  if (
    input.manifestHash !== input.beforeHash
    || input.beforeHash !== input.afterHash
  ) {
    throw new RecursiveContractError(
      'EVALUATOR_SEAL_DRIFT',
      'sealed evaluator closure changed during the experiment',
    );
  }
}

export type ReviewerVerdict = 'approve' | 'veto';
export type PromotionAction = 'emit-candidate' | 'merge';

export function assertStageOnePromotion(input: {
  contract: unknown;
  action: PromotionAction;
  reviewerVerdict: ReviewerVerdict;
  verified: boolean;
}): void {
  const contract = parseRecursiveExperimentContract(input.contract);
  if (input.action === 'merge') {
    throw new RecursiveContractError(
      'STAGE_ONE_MERGE_DENIED',
      'shadow-stage experiments may emit candidates but never merge',
    );
  }
  if (contract.state !== 'review') {
    throw new RecursiveContractError(
      'UNVERIFIED_PROMOTION',
      'promotion candidate requires the review state',
    );
  }
  if (!input.verified) {
    throw new RecursiveContractError(
      'UNVERIFIED_PROMOTION',
      'promotion candidate requires verified evidence',
    );
  }
  if (input.reviewerVerdict !== 'approve') {
    throw new RecursiveContractError(
      'VETO_BLOCKS_PROMOTION',
      'reviewer veto cannot be bypassed',
    );
  }
}

export const DEFAULT_SHADOW_BUDGETS: ExperimentBudgets = Object.freeze({
  tokens: 100_000,
  calls: 20,
  timeMs: 30 * 60 * 1000,
  retries: 2,
  artifacts: 50,
  diskBytes: 512 * 1024 * 1024,
  worktrees: 1,
  reviewRounds: 1,
});
