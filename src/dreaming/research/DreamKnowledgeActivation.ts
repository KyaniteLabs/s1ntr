import { createHash, createHmac } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { writeFileAtomicSync } from '../../utils/atomicWrite.js';
import type { DreamFindingAdmission } from './DreamLearningAdmission.js';
import type { DreamLearningCapability,
  DreamLearningGateway } from './DreamLearningGateway.js';

const DIGEST = /^[a-f0-9]{64}$/;
const stable = (value: unknown): string => {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map(key =>
    `${JSON.stringify(key)}:${stable(record[key])}`).join(',')}}`;
};
const sha256 = (value: unknown): string =>
  createHash('sha256').update(stable(value)).digest('hex');
const sha256Bytes = (value: string): string =>
  createHash('sha256').update(value).digest('hex');

export interface CreativeKnowledgePolicy {
  readonly policyDigest: string;
  readonly minimumRepetitions: number;
  readonly minimumIndependentStudies: number;
  readonly allowedScopes: readonly string[];
}

export function sealCreativeKnowledgePolicy(input: Omit<CreativeKnowledgePolicy,
  'policyDigest'>): CreativeKnowledgePolicy {
  const body = { minimumRepetitions: input.minimumRepetitions,
    minimumIndependentStudies: input.minimumIndependentStudies,
    allowedScopes: Object.freeze([...input.allowedScopes]) };
  return Object.freeze({ ...body, policyDigest: sha256(body) });
}

function policyDigest(policy: CreativeKnowledgePolicy): string {
  return sha256({ minimumRepetitions: policy.minimumRepetitions,
    minimumIndependentStudies: policy.minimumIndependentStudies,
    allowedScopes: policy.allowedScopes });
}

export interface CreativeFindingCandidate {
  readonly principleIds: readonly string[];
  readonly compilerRules: readonly string[];
  readonly scope: readonly string[];
  readonly contraindications: readonly string[];
  readonly repetitions: number;
  readonly independentStudyDigests: readonly string[];
  readonly transferEvidenceDigests: readonly string[];
  readonly compilerRuleVersion: number;
}

export interface ActivatedKnowledgeSnapshot {
  readonly schema: 'sinter.activated-creative-knowledge';
  readonly schemaVersion: 1;
  readonly status: 'active';
  readonly admissionDigest: string;
  readonly admissionDigests: readonly string[];
  readonly repetitions: number;
  readonly independentStudyDigests: readonly string[];
  readonly transferEvidenceDigests: readonly string[];
  readonly contraindications: readonly string[];
  readonly compilerRuleVersion: number;
  readonly principleIds: readonly string[];
  readonly compilerRules: readonly string[];
  readonly scope: readonly string[];
  readonly policyDigest: string;
  readonly snapshotDigest: string;
  readonly signature: string;
}

function unsignedSnapshot(snapshot: Omit<ActivatedKnowledgeSnapshot,
  'snapshotDigest' | 'signature'>): unknown {
  return {
    schema: snapshot.schema, schemaVersion: snapshot.schemaVersion,
    status: snapshot.status, admissionDigest: snapshot.admissionDigest,
    admissionDigests: snapshot.admissionDigests, repetitions: snapshot.repetitions,
    independentStudyDigests: snapshot.independentStudyDigests,
    transferEvidenceDigests: snapshot.transferEvidenceDigests,
    contraindications: snapshot.contraindications,
    compilerRuleVersion: snapshot.compilerRuleVersion,
    principleIds: snapshot.principleIds, compilerRules: snapshot.compilerRules,
    scope: snapshot.scope, policyDigest: snapshot.policyDigest,
  };
}

export function verifyActivatedKnowledgeSnapshot(snapshot: ActivatedKnowledgeSnapshot,
  signingKey: string): boolean {
  const { snapshotDigest, signature, ...body } = snapshot;
  const expectedDigest = sha256(unsignedSnapshot(body));
  const expectedSignature = createHmac('sha256', signingKey).update(snapshotDigest).digest('hex');
  return snapshotDigest === expectedDigest && signature === expectedSignature;
}

export interface ActivatedKnowledgeStore {
  save(snapshot: ActivatedKnowledgeSnapshot): void;
  read(snapshotDigest: string): ActivatedKnowledgeSnapshot | undefined;
  isActive(snapshotDigest: string): boolean;
  rollback(snapshotDigest: string, reason: string): void;
}

export class InMemoryActivatedKnowledgeStore implements ActivatedKnowledgeStore {
  readonly #snapshots = new Map<string, ActivatedKnowledgeSnapshot>();
  readonly #rolledBack = new Map<string, string>();

  save(snapshot: ActivatedKnowledgeSnapshot): void {
    if (this.#snapshots.has(snapshot.snapshotDigest)) {
      throw new Error('KNOWLEDGE_SNAPSHOT_ALREADY_EXISTS');
    }
    this.#snapshots.set(snapshot.snapshotDigest, snapshot);
  }

  read(snapshotDigest: string): ActivatedKnowledgeSnapshot | undefined {
    return this.#snapshots.get(snapshotDigest);
  }

  isActive(snapshotDigest: string): boolean {
    return this.#snapshots.has(snapshotDigest) && !this.#rolledBack.has(snapshotDigest);
  }

  rollback(snapshotDigest: string, reason: string): void {
    if (!this.#snapshots.has(snapshotDigest)) throw new Error('KNOWLEDGE_SNAPSHOT_UNKNOWN');
    if (!reason.trim()) throw new Error('KNOWLEDGE_ROLLBACK_REASON_REQUIRED');
    this.#rolledBack.set(snapshotDigest, reason);
  }
}

interface FileKnowledgeState {
  readonly schema: 'sinter.activated-creative-knowledge-store';
  readonly schemaVersion: 1;
  readonly snapshots: Readonly<Record<string, ActivatedKnowledgeSnapshot>>;
  readonly rolledBack: Readonly<Record<string, string>>;
}

const EMPTY_KNOWLEDGE_STATE: FileKnowledgeState = Object.freeze({
  schema: 'sinter.activated-creative-knowledge-store', schemaVersion: 1,
  snapshots: Object.freeze({}), rolledBack: Object.freeze({}),
});

/** Durable product store for activated snapshots and explicit rollback state. */
export class FileActivatedKnowledgeStore implements ActivatedKnowledgeStore {
  constructor(private readonly file: string) {
    if (!path.isAbsolute(file)) throw new Error('KNOWLEDGE_STORE_PATH_NOT_ABSOLUTE');
  }
  save(snapshot: ActivatedKnowledgeSnapshot): void {
    const state = this.readState();
    if (state.snapshots[snapshot.snapshotDigest]) throw new Error('KNOWLEDGE_SNAPSHOT_ALREADY_EXISTS');
    this.writeState({ ...state, snapshots: { ...state.snapshots,
      [snapshot.snapshotDigest]: snapshot } });
  }
  read(snapshotDigest: string): ActivatedKnowledgeSnapshot | undefined {
    return this.readState().snapshots[snapshotDigest];
  }
  isActive(snapshotDigest: string): boolean {
    const state = this.readState();
    return Boolean(state.snapshots[snapshotDigest] && !state.rolledBack[snapshotDigest]);
  }
  rollback(snapshotDigest: string, reason: string): void {
    const state = this.readState();
    if (!state.snapshots[snapshotDigest]) throw new Error('KNOWLEDGE_SNAPSHOT_UNKNOWN');
    if (!reason.trim()) throw new Error('KNOWLEDGE_ROLLBACK_REASON_REQUIRED');
    this.writeState({ ...state, rolledBack: { ...state.rolledBack, [snapshotDigest]: reason } });
  }

  private readState(): FileKnowledgeState {
    try {
      const state = JSON.parse(readFileSync(this.file, 'utf8')) as Partial<FileKnowledgeState>;
      if (state.schema !== EMPTY_KNOWLEDGE_STATE.schema || state.schemaVersion !== 1
        || !state.snapshots || typeof state.snapshots !== 'object'
        || !state.rolledBack || typeof state.rolledBack !== 'object') {
        throw new Error('KNOWLEDGE_STORE_INVALID');
      }
      for (const [key, snapshot] of Object.entries(state.snapshots)) {
        if (key !== snapshot.snapshotDigest || !DIGEST.test(key)) {
          throw new Error('KNOWLEDGE_STORE_INVALID');
        }
      }
      return state as FileKnowledgeState;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return EMPTY_KNOWLEDGE_STATE;
      throw error;
    }
  }

  private writeState(state: FileKnowledgeState): void {
    mkdirSync(path.dirname(this.file), { recursive: true });
    writeFileAtomicSync(this.file, `${JSON.stringify(state, null, 2)}\n`);
  }
}

/**
 * Independence is resolved from the journal-bound admissions, not from the
 * candidate's declared study digest strings (#1260): each study must be a
 * distinct research aggregate (root), and no artifact bytes may be shared
 * between studies — one study rewrapped under several hashes fails here.
 */
function assertIndependentRoots(admissions: readonly DreamFindingAdmission[],
  minimumIndependentStudies: number): void {
  const roots = new Set(admissions.map(item => item.aggregateId));
  const artifactOwner = new Map<string, string>();
  for (const admission of admissions) {
    for (const artifact of admission.artifactDigests) {
      const owner = artifactOwner.get(artifact);
      if (owner !== undefined && owner !== admission.aggregateId) {
        throw new Error('KNOWLEDGE_INDEPENDENCE_POLICY_FAILED');
      }
      artifactOwner.set(artifact, admission.aggregateId);
    }
  }
  if (roots.size !== admissions.length || roots.size < minimumIndependentStudies) {
    throw new Error('KNOWLEDGE_INDEPENDENCE_POLICY_FAILED');
  }
}

export class CreativeKnowledgeConsolidator {
  constructor(private readonly store: ActivatedKnowledgeStore,
    private readonly signingKey: string,
    private readonly gateway: DreamLearningGateway) {
    if (!signingKey) throw new Error('KNOWLEDGE_SIGNING_KEY_REQUIRED');
  }

  async activate(candidate: CreativeFindingCandidate,
    policy: CreativeKnowledgePolicy, capabilities: readonly DreamLearningCapability[]):
    Promise<ActivatedKnowledgeSnapshot> {
    if (!Object.isFrozen(policy) || !Object.isFrozen(policy.allowedScopes)
      || policy.policyDigest !== policyDigest(policy)) {
      throw new Error('KNOWLEDGE_POLICY_NOT_FROZEN');
    }
    if (candidate.repetitions < policy.minimumRepetitions) {
      throw new Error('KNOWLEDGE_REPETITION_POLICY_FAILED');
    }
    const independent = new Set(candidate.independentStudyDigests);
    if (independent.size < policy.minimumIndependentStudies
      || ![...independent].every(value => DIGEST.test(value))) {
      throw new Error('KNOWLEDGE_INDEPENDENCE_POLICY_FAILED');
    }
    if (candidate.scope.length === 0
      || candidate.scope.some(scope => !policy.allowedScopes.includes(scope))) {
      throw new Error('KNOWLEDGE_SCOPE_POLICY_FAILED');
    }
    if (candidate.contraindications.length > 0) {
      throw new Error('KNOWLEDGE_CONTRAINDICATION_POLICY_FAILED');
    }
    if (candidate.principleIds.length === 0 || candidate.compilerRules.length === 0) {
      throw new Error('KNOWLEDGE_CONTENT_REQUIRED');
    }
    if (capabilities.length !== candidate.repetitions
      || candidate.independentStudyDigests.length !== candidate.repetitions
      || candidate.transferEvidenceDigests.length !== candidate.repetitions
      || !Number.isSafeInteger(candidate.compilerRuleVersion)) {
      throw new Error('KNOWLEDGE_STUDY_BINDING_FAILED');
    }
    const admissions: DreamFindingAdmission[] = [];
    for (const capability of capabilities) await this.gateway.write(capability, { writeFinding: admission => {
      const originDigests = new Set([admission.admissionDigest, admission.findingDigest,
        admission.transferEvidenceDigest, ...admission.artifactDigests,
        ...admission.evidenceDigests]);
      if ([...independent].some(value => originDigests.has(value))) {
        throw new Error('KNOWLEDGE_INDEPENDENCE_POLICY_FAILED');
      }
      admissions.push(admission);
    } });
    if (admissions.length !== capabilities.length
      || new Set(admissions.map(item => item.admissionDigest)).size !== admissions.length
      || new Set(candidate.transferEvidenceDigests).size !== candidate.transferEvidenceDigests.length
      || stable(admissions.map(item => item.transferEvidenceDigest))
        !== stable(candidate.transferEvidenceDigests)) {
      throw new Error('KNOWLEDGE_STUDY_BINDING_FAILED');
    }
    assertIndependentRoots(admissions, policy.minimumIndependentStudies);
    return this.createSnapshot(candidate, policy, admissions);
  }

  rollback(snapshotDigest: string, reason: string): void {
    this.store.rollback(snapshotDigest, reason);
  }

  verify(snapshot: ActivatedKnowledgeSnapshot): boolean {
    return verifyActivatedKnowledgeSnapshot(snapshot, this.signingKey);
  }

  private createSnapshot(candidate: CreativeFindingCandidate,
    policy: CreativeKnowledgePolicy,
    admissions: readonly DreamFindingAdmission[]): ActivatedKnowledgeSnapshot {
    const body = Object.freeze({
      schema: 'sinter.activated-creative-knowledge' as const,
      schemaVersion: 1 as const, status: 'active' as const,
      admissionDigest: admissions[0]!.admissionDigest,
      admissionDigests: Object.freeze(admissions.map(item => item.admissionDigest)),
      repetitions: candidate.repetitions,
      independentStudyDigests: Object.freeze([...candidate.independentStudyDigests]),
      transferEvidenceDigests: Object.freeze([...candidate.transferEvidenceDigests]),
      contraindications: Object.freeze([...candidate.contraindications]),
      compilerRuleVersion: candidate.compilerRuleVersion,
      principleIds: Object.freeze([...candidate.principleIds]),
      compilerRules: Object.freeze([...candidate.compilerRules]),
      scope: Object.freeze([...candidate.scope]), policyDigest: policy.policyDigest,
    });
    const snapshotDigest = sha256(unsignedSnapshot(body));
    const snapshot = Object.freeze({ ...body, snapshotDigest,
      signature: this.sign(snapshotDigest) });
    const existing = this.store.read(snapshotDigest);
    if (existing) {
      if (!this.store.isActive(snapshotDigest) || !this.verify(existing)
        || stable(existing) !== stable(snapshot)) {
        throw new Error('KNOWLEDGE_SNAPSHOT_REBOUND');
      }
      return existing;
    }
    this.store.save(snapshot);
    return snapshot;
  }

  private sign(snapshotDigest: string): string {
    return createHmac('sha256', this.signingKey).update(snapshotDigest).digest('hex');
  }
}

export interface KnowledgeApplicationReceipt {
  readonly snapshotDigest: string;
  readonly principleIds: readonly string[];
  readonly compilerPolicyDigest: string;
  readonly prePlanDigest: string;
  readonly postPlanDigest: string;
  readonly transformationDelta: string;
  readonly transformationDeltaDigest: string;
  readonly finalProviderInput: string;
  readonly finalProviderInputDigest: string;
}

export class KnowledgeApplication {
  constructor(private readonly store: ActivatedKnowledgeStore,
    private readonly verifySnapshot: (snapshot: ActivatedKnowledgeSnapshot) => boolean) {}

  apply(input: { snapshotDigest: string; targetScope: string;
    basePlan: Readonly<Record<string, unknown>>; providerInput: string }):
    KnowledgeApplicationReceipt {
    const snapshot = this.store.read(input.snapshotDigest);
    if (!snapshot || !this.store.isActive(input.snapshotDigest)) {
      throw new Error('KNOWLEDGE_SNAPSHOT_INACTIVE');
    }
    if (!this.verifySnapshot(snapshot) || snapshot.snapshotDigest !== input.snapshotDigest) {
      throw new Error('KNOWLEDGE_SNAPSHOT_AUTHORITY_INVALID');
    }
    if (!snapshot.scope.includes(input.targetScope)) {
      throw new Error('KNOWLEDGE_SNAPSHOT_SCOPE_MISMATCH');
    }
    const transformationDelta = snapshot.compilerRules.join('\n');
    const postPlan = { ...input.basePlan, activatedKnowledge: {
      snapshotDigest: snapshot.snapshotDigest,
      principleIds: snapshot.principleIds,
      compilerRules: snapshot.compilerRules,
    } };
    const finalProviderInput = `${input.providerInput}\n\nActivated creative principles:\n${transformationDelta}`;
    const receipt = {
      snapshotDigest: snapshot.snapshotDigest,
      principleIds: snapshot.principleIds,
      compilerPolicyDigest: sha256({ policyDigest: snapshot.policyDigest,
        compilerRules: snapshot.compilerRules }),
      prePlanDigest: sha256(input.basePlan), postPlanDigest: sha256(postPlan),
      transformationDelta, transformationDeltaDigest: sha256(transformationDelta),
      finalProviderInput, finalProviderInputDigest: sha256Bytes(finalProviderInput),
    };
    if (receipt.prePlanDigest === receipt.postPlanDigest
      || receipt.finalProviderInput === input.providerInput) {
      throw new Error('KNOWLEDGE_SNAPSHOT_BOUND_BUT_UNAPPLIED');
    }
    return Object.freeze(receipt);
  }
}

export interface MatchedKnowledgeTrial {
  readonly taskId: string;
  readonly receipt: KnowledgeApplicationReceipt;
  readonly controlScore: number;
  readonly treatmentScore: number;
  readonly vetoedRegression: boolean;
  readonly ambientSnapshotDigests?: readonly string[];
}

export interface MatchedKnowledgeComparison {
  readonly snapshotDigest: string;
  readonly frozenAssignmentDigest: string;
  readonly trials: readonly MatchedKnowledgeTrial[];
}

/** One-sided significance level for the exact sign test. */
export const KNOWLEDGE_SIGN_TEST_ALPHA = 0.05;

/**
 * Result of the matched comparison screen. `valid` means the screen passed
 * (bindings, no leakage, no veto, net wins) — it is NOT statistical
 * confirmation (#1261). `statisticallyConfirmed` is an exact one-sided sign
 * test over non-tied trials; benefit still needs a CS-confirmed matched-cost
 * A/B before it is claimed.
 */
export interface MatchedKnowledgeComparisonResult {
  readonly valid: true;
  readonly wins: number;
  readonly losses: number;
  readonly ties: number;
  readonly signTestPValue: number;
  readonly statisticallyConfirmed: boolean;
}

/** P(X >= wins) for X ~ Binomial(wins + losses, 0.5). */
function oneSidedSignTestPValue(wins: number, losses: number): number {
  const n = wins + losses;
  if (n === 0) return 1;
  let coefficient = 1;
  let tail = 0;
  for (let k = 0; k <= n; k += 1) {
    if (k >= wins) tail += coefficient;
    coefficient = coefficient * (n - k) / (k + 1);
  }
  return tail / 2 ** n;
}

export function validateMatchedKnowledgeComparison(input: MatchedKnowledgeComparison):
  MatchedKnowledgeComparisonResult {
  if (!DIGEST.test(input.frozenAssignmentDigest)) {
    throw new Error('KNOWLEDGE_ASSIGNMENT_NOT_FROZEN');
  }
  if (input.trials.length < 2 || new Set(input.trials.map(trial => trial.taskId)).size < 2) {
    throw new Error('KNOWLEDGE_MATCHED_MULTI_TASK_REQUIRED');
  }
  for (const trial of input.trials) {
    if (trial.receipt.snapshotDigest !== input.snapshotDigest) {
      throw new Error('KNOWLEDGE_SNAPSHOT_BINDING_MISMATCH');
    }
    if (trial.receipt.prePlanDigest === trial.receipt.postPlanDigest
      || !trial.receipt.transformationDelta.trim()) {
      throw new Error('KNOWLEDGE_SNAPSHOT_BOUND_BUT_UNAPPLIED');
    }
    if ((trial.ambientSnapshotDigests ?? []).length > 0) {
      throw new Error('KNOWLEDGE_AMBIENT_LEAKAGE');
    }
    if (trial.vetoedRegression) throw new Error('KNOWLEDGE_REGRESSION_VETOED');
  }
  const wins = input.trials.filter(trial => trial.treatmentScore > trial.controlScore).length;
  const losses = input.trials.filter(trial => trial.treatmentScore < trial.controlScore).length;
  if (wins < 2) throw new Error('KNOWLEDGE_SINGLE_STOCHASTIC_WIN');
  if (wins <= losses) throw new Error('KNOWLEDGE_NO_NET_BENEFIT');
  const signTestPValue = oneSidedSignTestPValue(wins, losses);
  return Object.freeze({ valid: true as const, wins, losses,
    ties: input.trials.length - wins - losses, signTestPValue: Number(signTestPValue.toFixed(6)),
    statisticallyConfirmed: signTestPValue <= KNOWLEDGE_SIGN_TEST_ALPHA });
}
