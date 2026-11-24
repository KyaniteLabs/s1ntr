import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import { writeFileAtomic } from '../../utils/atomicWrite.js';
import { AsyncLock } from '../../utils/AsyncLock.js';

export type DreamResearchOutcome = 'accepted' | 'rejected' | 'inconclusive';

export interface AdmittedCreativeEvidence {
  readonly evidenceDigest: string;
  readonly artifactDigest: string;
  readonly principleIds: readonly string[];
  readonly domain: string;
  readonly quality: number;
  readonly noveltyDescriptor: readonly number[];
  readonly outcome: DreamResearchOutcome;
  readonly rendered: boolean;
  readonly admissionEligible: boolean;
}

export interface DreamResearchPlan {
  readonly schema: 'sinter.dream-research-plan';
  readonly schemaVersion: 1;
  readonly revision: number;
  readonly mode: 'explore' | 'exploit';
  readonly hypothesis: string;
  readonly criterion: string;
  readonly domains: readonly string[];
  readonly parentEvidenceDigests: readonly string[];
  readonly operators: readonly string[];
  readonly budget: { readonly maxCandidates: number; readonly maxProviderAttempts: number };
  readonly stopRules: readonly string[];
  readonly neighborhoodKey: string;
  readonly saturation: { readonly repeatedNeighborhood: boolean;
    readonly previousNegativeOutcomes: number };
  readonly planDigest: string;
}

export interface DreamResearchPolicyState {
  readonly schema: 'sinter.dream-research-policy';
  readonly schemaVersion: 1;
  readonly revision: number;
  readonly negativeNeighborhoods: Readonly<Record<string, number>>;
  readonly outcomes: Readonly<Record<string, Exclude<DreamResearchOutcome, 'accepted'>>>;
  readonly selectedPlan: DreamResearchPlan | null;
  readonly budgetState: {
    readonly planDigest: string;
    readonly candidatesConsumed: number;
    readonly providerAttemptsConsumed: number;
    readonly stopped: boolean;
  } | null;
  readonly reservations: Readonly<Record<string, {
    readonly kind: 'candidate' | 'provider'; readonly ordinal: number }>>;
}

export interface DreamResearchPolicyStore {
  read(): Promise<DreamResearchPolicyState>;
  write(state: DreamResearchPolicyState): Promise<void>;
  /**
   * Run a read-modify-write critical section exclusively. Every state
   * mutation (selection, outcome, budget reservation) goes through this so
   * concurrent reservations cannot both observe the same consumed count and
   * exceed the cap (#1262).
   */
  exclusive<T>(fn: () => Promise<T>): Promise<T>;
}

const LOCK_STALE_MS = 30_000;
const LOCK_TIMEOUT_MS = 10_000;

async function acquireFileLock(lockPath: string): Promise<() => Promise<void>> {
  const startedAt = Date.now();
  const token = `${process.pid}-${randomUUID()}`;
  for (;;) {
    try {
      const handle = await open(lockPath, 'wx');
      try {
        await handle.writeFile(`${token}\n`);
      } catch (writeErr) {
        await handle.close().catch(() => undefined);
        await unlink(lockPath).catch(() => undefined);
        throw writeErr;
      }
      return async () => {
        await handle.close().catch(() => undefined);
        try {
          const current = (await readFile(lockPath, 'utf8')).trim();
          if (current === token) await unlink(lockPath).catch(() => undefined);
        } catch { /* lock already reclaimed */ }
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      if (Date.now() - startedAt >= LOCK_TIMEOUT_MS) {
        throw new Error('DREAM_RESEARCH_POLICY_LOCK_TIMEOUT');
      }
      const lockStat = await stat(lockPath).catch(() => null);
      if (lockStat && Date.now() - lockStat.mtimeMs > LOCK_STALE_MS) {
        const stalePath = `${lockPath}.stale-${randomUUID()}`;
        try {
          await rename(lockPath, stalePath);
          await unlink(stalePath).catch(() => undefined);
        } catch { /* another waiter reclaimed it or permission denied */ }
      }
      await new Promise(resolve => setTimeout(resolve, 5));
    }
  }
}

const EMPTY_STATE: DreamResearchPolicyState = Object.freeze({
  schema: 'sinter.dream-research-policy', schemaVersion: 1, revision: 0,
  negativeNeighborhoods: Object.freeze({}), outcomes: Object.freeze({}),
  selectedPlan: null, budgetState: null, reservations: Object.freeze({}),
});

export class MemoryDreamResearchPolicyStore implements DreamResearchPolicyStore {
  private state = EMPTY_STATE;
  private readonly lock = new AsyncLock();
  exclusive<T>(fn: () => Promise<T>): Promise<T> {
    return this.lock.acquire(fn);
  }
  read(): Promise<DreamResearchPolicyState> {
    return Promise.resolve(structuredClone(this.state));
  }
  write(state: DreamResearchPolicyState): Promise<void> {
    this.state = structuredClone(state);
    return Promise.resolve();
  }
}

export class FileDreamResearchPolicyStore implements DreamResearchPolicyStore {
  private readonly lock = new AsyncLock();
  constructor(private readonly file: string) {
    if (!path.isAbsolute(file)) throw new Error('DREAM_RESEARCH_POLICY_PATH_NOT_ABSOLUTE');
  }
  /** In-process mutex plus an O_EXCL lock file shared by every process/instance. */
  exclusive<T>(fn: () => Promise<T>): Promise<T> {
    return this.lock.acquire(async () => {
      await mkdir(path.dirname(this.file), { recursive: true });
      const release = await acquireFileLock(`${this.file}.lock`);
      try {
        return await fn();
      } finally {
        await release();
      }
    });
  }
  async read(): Promise<DreamResearchPolicyState> {
    try {
      return validateState(JSON.parse(await readFile(this.file, 'utf8')));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return EMPTY_STATE;
      throw error;
    }
  }
  async write(state: DreamResearchPolicyState): Promise<void> {
    await mkdir(path.dirname(this.file), { recursive: true });
    await writeFileAtomic(this.file, `${JSON.stringify(state, null, 2)}\n`);
  }
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort()
    .filter(key => record[key] !== undefined)
    .map(key => `${JSON.stringify(key)}:${canonical(record[key])}`)
    .join(',')}}`;
}

function digest(value: unknown): string {
  return createHash('sha256').update(canonical(value)).digest('hex');
}

function validateState(value: unknown): DreamResearchPolicyState {
  if (!value || typeof value !== 'object') throw new Error('DREAM_RESEARCH_POLICY_INVALID');
  const state = value as Partial<DreamResearchPolicyState>;
  if (state.schema !== 'sinter.dream-research-policy' || state.schemaVersion !== 1
    || !Number.isSafeInteger(state.revision) || state.revision! < 0
    || !state.negativeNeighborhoods || typeof state.negativeNeighborhoods !== 'object'
    || !state.outcomes || typeof state.outcomes !== 'object'
    || !state.reservations || typeof state.reservations !== 'object'
    || (state.selectedPlan && !state.budgetState)) {
    throw new Error('DREAM_RESEARCH_POLICY_INVALID');
  }
  return state as DreamResearchPolicyState;
}

function assertBudget(budget: DreamResearchPlan['budget']): void {
  if (!Number.isSafeInteger(budget.maxCandidates) || budget.maxCandidates < 1
    || !Number.isSafeInteger(budget.maxProviderAttempts) || budget.maxProviderAttempts < 1) {
    throw new Error('DREAM_RESEARCH_BUDGET_INVALID');
  }
}

function assertEvidence(evidence: readonly AdmittedCreativeEvidence[]): void {
  if (evidence.length < 1 || evidence.some(item => !item.rendered || !item.admissionEligible
    || !/^[0-9a-f]{64}$/.test(item.evidenceDigest)
    || !/^[0-9a-f]{64}$/.test(item.artifactDigest))) {
    throw new Error('DREAM_RESEARCH_EVIDENCE_INADMISSIBLE');
  }
}

function selectPrinciple(evidence: readonly AdmittedCreativeEvidence[]): string {
  const counts = new Map<string, number>();
  for (const item of evidence) {
    for (const principle of item.principleIds) {
      counts.set(principle, (counts.get(principle) ?? 0) + 1);
    }
  }
  return [...counts.entries()].sort((left, right) =>
    right[1] - left[1] || left[0].localeCompare(right[0]))[0]?.[0] ?? 'composition';
}

function buildPlan(evidence: readonly AdmittedCreativeEvidence[],
  budget: DreamResearchPlan['budget'], state: DreamResearchPolicyState): DreamResearchPlan {
  assertBudget(budget);
  assertEvidence(evidence);
  const parents = evidence
    .filter(item => item.outcome === 'accepted')
    .sort((a, b) => a.evidenceDigest.localeCompare(b.evidenceDigest));
  if (parents.length < 1) throw new Error('DREAM_RESEARCH_ACCEPTED_PARENT_REQUIRED');
  const principle = selectPrinciple(parents);
  const domains = [...new Set(parents.map(item => item.domain))].sort();
  const neighborhoodKey = digest({ principle, domains,
    descriptors: parents.map(item => item.noveltyDescriptor) }).slice(0, 24);
  const previousNegativeOutcomes = state.negativeNeighborhoods[neighborhoodKey] ?? 0;
  const mode: DreamResearchPlan['mode'] = previousNegativeOutcomes % 2 === 0
    ? 'exploit' : 'explore';
  const body = {
    schema: 'sinter.dream-research-plan' as const, schemaVersion: 1 as const,
    revision: state.revision + 1, mode,
    hypothesis: `Increasing ${principle} while preserving cohesion improves perceived quality.`,
    criterion: `A blind rendered comparison must improve ${principle} without a hard-floor regression.`,
    domains, parentEvidenceDigests: parents.map(item => item.evidenceDigest).sort(),
    operators: mode === 'explore' ? ['cross-domain-recombination'] : ['controlled-variation'],
    budget: { ...budget }, stopRules: [`stop-before-provider-attempt-${budget.maxProviderAttempts + 1}`,
      'stop-on-missing-rendered-evidence', 'stop-on-owner-rejection'], neighborhoodKey,
    saturation: { repeatedNeighborhood: previousNegativeOutcomes >= 2, previousNegativeOutcomes },
  };
  return Object.freeze({ ...body, planDigest: digest(body) });
}

export class DreamResearchController {
  constructor(private readonly store: DreamResearchPolicyStore) {}

  async preview(evidence: readonly AdmittedCreativeEvidence[],
    budget: DreamResearchPlan['budget']): Promise<DreamResearchPlan> {
    return buildPlan(evidence, budget, await this.store.read());
  }

  select(evidence: readonly AdmittedCreativeEvidence[],
    budget: DreamResearchPlan['budget']): Promise<DreamResearchPlan> {
    return this.store.exclusive(() => this.selectLocked(evidence, budget));
  }

  private async selectLocked(evidence: readonly AdmittedCreativeEvidence[],
    budget: DreamResearchPlan['budget']): Promise<DreamResearchPlan> {
    assertBudget(budget);
    assertEvidence(evidence);
    const state = await this.store.read();
    const parentDigests = evidence.filter(item => item.outcome === 'accepted')
      .map(item => item.evidenceDigest).sort();
    if (state.selectedPlan && !state.outcomes[state.selectedPlan.planDigest]
      && state.selectedPlan.budget.maxCandidates === budget.maxCandidates
      && state.selectedPlan.budget.maxProviderAttempts === budget.maxProviderAttempts
      && JSON.stringify(state.selectedPlan.parentEvidenceDigests) === JSON.stringify(parentDigests)) {
      return state.selectedPlan;
    }
    const plan = buildPlan(evidence, budget, state);
    await this.store.write(Object.freeze({ ...state,
      revision: plan.revision, selectedPlan: plan,
      budgetState: Object.freeze({ planDigest: plan.planDigest,
        candidatesConsumed: 0, providerAttemptsConsumed: 0, stopped: false }),
      reservations: Object.freeze({}) }));
    return plan;
  }

  recordOutcome(planDigest: string,
    outcome: Exclude<DreamResearchOutcome, 'accepted'>): Promise<void> {
    return this.store.exclusive(() => this.recordOutcomeLocked(planDigest, outcome));
  }

  private async recordOutcomeLocked(planDigest: string,
    outcome: Exclude<DreamResearchOutcome, 'accepted'>): Promise<void> {
    const state = await this.store.read();
    if (state.outcomes[planDigest]) {
      if (state.outcomes[planDigest] !== outcome) {
        throw new Error('DREAM_RESEARCH_OUTCOME_CONFLICT');
      }
      return;
    }
    const plan = state.selectedPlan;
    if (!plan || plan.planDigest !== planDigest || state.budgetState?.planDigest !== planDigest) {
      throw new Error('DREAM_RESEARCH_PLAN_NOT_CURRENT');
    }
    const count = (state.negativeNeighborhoods[plan.neighborhoodKey] ?? 0) + 1;
    await this.store.write(Object.freeze({ ...state, revision: state.revision + 1,
      negativeNeighborhoods: Object.freeze({ ...state.negativeNeighborhoods,
        [plan.neighborhoodKey]: count }),
      outcomes: Object.freeze({ ...state.outcomes, [planDigest]: outcome }),
      budgetState: Object.freeze({ ...state.budgetState, stopped: true }) }));
  }

  async currentPlan(): Promise<DreamResearchPlan | null> {
    return (await this.store.read()).selectedPlan;
  }

  reserveCandidate(planDigest: string, key = 'default'): Promise<number> {
    return this.reserveBudget(planDigest, 'candidate', key);
  }

  reserveProviderAttempt(planDigest: string, key = 'default'): Promise<number> {
    return this.reserveBudget(planDigest, 'provider', key);
  }

  async currentBudgetState(): Promise<DreamResearchPolicyState['budgetState']> {
    return (await this.store.read()).budgetState;
  }

  private reserveBudget(planDigest: string,
    kind: 'candidate' | 'provider', key: string): Promise<number> {
    return this.store.exclusive(() => this.reserveBudgetLocked(planDigest, kind, key));
  }

  private async reserveBudgetLocked(planDigest: string,
    kind: 'candidate' | 'provider', key: string): Promise<number> {
    const state = await this.store.read();
    const plan = state.selectedPlan;
    const budget = state.budgetState;
    if (!plan || !budget || plan.planDigest !== planDigest
      || budget.planDigest !== planDigest || budget.stopped) {
      throw new Error('DREAM_RESEARCH_BUDGET_NOT_ACTIVE');
    }
    const consumedKey = kind === 'candidate' ? 'candidatesConsumed' : 'providerAttemptsConsumed';
    const reservationKey = `${planDigest}:${kind}:${key}`;
    const prior = state.reservations[reservationKey];
    if (prior) return prior.ordinal;
    const maximum = kind === 'candidate' ? plan.budget.maxCandidates : plan.budget.maxProviderAttempts;
    if (budget[consumedKey] >= maximum) throw new Error('DREAM_RESEARCH_BUDGET_EXHAUSTED');
    const consumed = budget[consumedKey] + 1;
    await this.store.write(Object.freeze({ ...state, revision: state.revision + 1,
      budgetState: Object.freeze({ ...budget, [consumedKey]: consumed }),
      reservations: Object.freeze({ ...state.reservations,
        [reservationKey]: Object.freeze({ kind, ordinal: consumed }) }) }));
    return consumed;
  }
}
