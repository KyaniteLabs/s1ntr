import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  authorizeCandidateDiff,
  authorizeExperimentRequest,
  createExperimentAuthorityPolicy,
  type ExperimentAuthorityReceipt,
} from '../harness/authority/ExperimentAuthority.js';
import type { ConsolidatedHypothesis } from '../intuition/EvidenceConsolidationCoordinator.js';
import {
  assertExperimentTransition,
  parseRecursiveExperimentContract,
  type ExperimentBudgets,
  type ExperimentState,
  type RecursiveExperimentContract,
  type ReviewerIdentity,
} from './RecursiveImprovementContract.js';

const EXECUTION_STATES = [
  'observe', 'hypothesize', 'baseline', 'reproduce', 'mutate', 'verify',
  'artifact-evaluate', 'review',
] as const;

export interface ExperimentUsage {
  tokens: number;
  calls: number;
  timeMs: number;
  retries: number;
  artifacts: number;
  diskBytes: number;
  worktrees: number;
  reviewRounds: number;
}

export interface AutoresearchStageResult {
  passed: boolean;
  evidenceRefs: string[];
  usage: Pick<ExperimentUsage, 'tokens' | 'retries' | 'artifacts'>;
  verdict?: 'approve' | 'veto';
}

export interface AutoresearchStageContext {
  state: typeof EXECUTION_STATES[number] | 'learn';
  signal: AbortSignal;
  hypothesis: ConsolidatedHypothesis;
  control: { id: string; digest: string };
  author: ReviewerIdentity;
  writeCandidate(path: string, content: string): Promise<ExperimentAuthorityReceipt>;
}

export interface AutoresearchExperimentInput {
  contract: RecursiveExperimentContract;
  hypothesis: ConsolidatedHypothesis;
  control: { id: string; digest: string };
  author: ReviewerIdentity;
  workspaceRoot: string;
  parentRoot: string;
  candidateFiles: string[];
  sealedEvaluatorFiles?: string[];
  parentStateDigest(): Promise<string>;
  executeStage(
    context: AutoresearchStageContext,
  ): Promise<AutoresearchStageResult>;
}

export interface AutoresearchStageRecord {
  state: ExperimentState;
  passed: boolean;
  evidenceRefs: string[];
  verdict?: 'approve' | 'veto';
}

export interface AutoresearchFailureRecord {
  state: ExperimentState;
  reason: string;
  evidenceRefs: string[];
  quarantined: true;
}

export interface AutoresearchExperimentResult {
  experimentId: string;
  lineageId: string;
  terminal: 'candidate' | 'restored';
  stages: AutoresearchStageRecord[];
  usage: ExperimentUsage;
  changedPaths: string[];
  authorityReceipts: ExperimentAuthorityReceipt[];
  failure?: AutoresearchFailureRecord;
  parentUnchanged: boolean;
}

const zeroUsage = (): ExperimentUsage => ({
  tokens: 0,
  calls: 0,
  timeMs: 0,
  retries: 0,
  artifacts: 0,
  diskBytes: 0,
  worktrees: 1,
  reviewRounds: 0,
});

function digest(value: Buffer | string): string {
  return createHash('sha256').update(value).digest('hex');
}

function assertBudget(usage: ExperimentUsage, budget: ExperimentBudgets): void {
  for (const key of Object.keys(usage) as Array<keyof ExperimentUsage>) {
    if (usage[key] > budget[key]) {
      throw new Error(`EXPERIMENT_BUDGET_EXCEEDED:${key}`);
    }
  }
}

async function snapshotFiles(
  root: string,
  files: readonly string[],
): Promise<Map<string, Buffer | null>> {
  const snapshots = new Map<string, Buffer | null>();
  for (const file of files) {
    try {
      snapshots.set(file, await fs.readFile(path.join(root, file)));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      snapshots.set(file, null);
    }
  }
  return snapshots;
}

async function restoreFiles(
  root: string,
  snapshots: Map<string, Buffer | null>,
): Promise<void> {
  for (const [file, content] of snapshots) {
    const target = path.join(root, file);
    if (content === null) await fs.rm(target, { force: true });
    else await fs.writeFile(target, content);
  }
}

async function changedFiles(
  root: string,
  snapshots: Map<string, Buffer | null>,
): Promise<string[]> {
  const changed: string[] = [];
  for (const [file, before] of snapshots) {
    try {
      const after = await fs.readFile(path.join(root, file));
      if (before === null || digest(before) !== digest(after)) changed.push(file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || before !== null) {
        changed.push(file);
      }
    }
  }
  return changed;
}

function validateInput(input: AutoresearchExperimentInput): void {
  if (
    input.hypothesis.status !== 'ready'
    || !input.hypothesis.falsifier
    || !Number.isFinite(input.hypothesis.confidence)
    || input.hypothesis.confidence < 0
    || input.hypothesis.confidence > 1
  ) {
    throw new Error('EXPERIMENT_HYPOTHESIS_NOT_READY');
  }
  if (
    input.hypothesis.citations.length < 2
    || input.hypothesis.corroboratingSources.length < 2
    || new Set(input.hypothesis.citations
      .filter(item => item.stance === 'support' && item.taint === 'clean'
        && item.trust !== 'untrusted-external')
      .map(item => item.lineageId)).size < 2
    || input.hypothesis.citations.some(item => !item.sourceRef || !item.lineageId)
  ) {
    throw new Error('EXPERIMENT_HYPOTHESIS_EVIDENCE_MISSING');
  }
  if (!input.control.id || !/^[a-f0-9]{64}$/.test(input.control.digest)) {
    throw new Error('EXPERIMENT_CONTROL_MISSING');
  }
  if (
    !input.author.verified
    || !input.author.provider.trim()
    || !input.author.model.trim()
  ) {
    throw new Error('EXPERIMENT_AUTHOR_IDENTITY_UNVERIFIED');
  }
  if (input.candidateFiles.length === 0) {
    throw new Error('EXPERIMENT_CANDIDATE_FILES_MISSING');
  }
}

export class AutoresearchExperimentRunner {
  async run(input: AutoresearchExperimentInput): Promise<AutoresearchExperimentResult> {
    validateInput(input);
    const contract = parseRecursiveExperimentContract(input.contract);
    if (contract.loop !== 'autoresearch' || !contract.sourceMutationRequested) {
      throw new Error('EXPERIMENT_MUTATION_AUTHORITY_MISSING');
    }
    if (contract.state !== 'observe') {
      throw new Error('EXPERIMENT_MUST_START_AT_OBSERVE');
    }
    const workspaceRoot = await fs.realpath(input.workspaceRoot);
    const parentRoot = await fs.realpath(input.parentRoot);
    if (workspaceRoot === parentRoot) {
      throw new Error('EXPERIMENT_ISOLATED_WORKTREE_REQUIRED');
    }
    const policy = createExperimentAuthorityPolicy({
      contract,
      projectRoot: workspaceRoot,
      candidateFiles: input.candidateFiles,
      sealedEvaluatorFiles: input.sealedEvaluatorFiles,
    });
    const preflight = await authorizeCandidateDiff(policy, policy.candidateFiles);
    if (!preflight.allowed) {
      throw new Error('EXPERIMENT_CANDIDATE_BOUNDARY_DENIED');
    }
    const snapshots = await snapshotFiles(workspaceRoot, policy.candidateFiles);
    const parentBefore = await input.parentStateDigest();
    if (!parentBefore) throw new Error('EXPERIMENT_PARENT_EVIDENCE_MISSING');
    const startedAt = Date.now();
    const usage = zeroUsage();
    const stages: AutoresearchStageRecord[] = [];
    const authorityReceipts = [...preflight.receipts];
    let currentContract = contract;
    let failure: AutoresearchFailureRecord | undefined;
    let activeState: ExperimentState = 'observe';
    let activeSignal: AbortSignal | undefined;

    const updateUsage = (result: AutoresearchStageResult): void => {
      for (const amount of Object.values(result.usage)) {
        if (!Number.isFinite(amount) || amount < 0) {
          throw new Error('EXPERIMENT_STAGE_USAGE_INVALID');
        }
      }
      usage.calls += 1;
      usage.tokens += result.usage.tokens;
      usage.retries += result.usage.retries;
      usage.artifacts += result.usage.artifacts;
      usage.timeMs = Date.now() - startedAt;
      assertBudget(usage, contract.budgets);
    };

    const writeCandidate = async (
      requestedPath: string,
      content: string,
    ): Promise<ExperimentAuthorityReceipt> => {
      if (activeState !== 'mutate') {
        throw new Error(`EXPERIMENT_WRITE_OUTSIDE_MUTATE:${activeState}`);
      }
      if (activeSignal?.aborted) {
        throw new Error('EXPERIMENT_STAGE_ABORTED');
      }
      const receipt = await authorizeExperimentRequest(policy, {
        kind: 'tool',
        name: 'writeFile',
        path: requestedPath,
        content,
      });
      authorityReceipts.push(receipt);
      usage.calls += 1;
      usage.diskBytes += Buffer.byteLength(content);
      usage.timeMs = Date.now() - startedAt;
      assertBudget(usage, contract.budgets);
      if (receipt.decision !== 'allow' || !receipt.resolved.canonicalPath) {
        throw new Error(`EXPERIMENT_WRITE_DENIED:${receipt.reason}`);
      }
      await fs.writeFile(
        path.join(workspaceRoot, receipt.resolved.canonicalPath),
        content,
        'utf8',
      );
      return receipt;
    };

    const invokeStage = async (
      state: AutoresearchStageContext['state'],
    ): Promise<AutoresearchStageResult> => {
      const remaining = contract.budgets.timeMs - (Date.now() - startedAt);
      if (remaining <= 0) throw new Error('EXPERIMENT_BUDGET_EXCEEDED:timeMs');
      const controller = new AbortController();
      activeSignal = controller.signal;
      let timeout: NodeJS.Timeout | undefined;
      const expired = new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => {
          controller.abort();
          reject(new Error('EXPERIMENT_BUDGET_EXCEEDED:timeMs'));
        }, remaining);
      });
      try {
        return await Promise.race([
          input.executeStage({
            state,
            signal: controller.signal,
            hypothesis: structuredClone(input.hypothesis),
            control: { ...input.control },
            author: { ...input.author },
            writeCandidate,
          }),
          expired,
        ]);
      } finally {
        if (timeout) clearTimeout(timeout);
      }
    };

    const execute = async (
      state: typeof EXECUTION_STATES[number],
    ): Promise<AutoresearchStageResult> => {
      if (state !== currentContract.state) {
        const next = assertExperimentTransition(currentContract, state);
        currentContract = { ...currentContract, state: next };
      }
      activeState = state;
      const result = await invokeStage(state);
      if (!result.evidenceRefs.length || result.evidenceRefs.some(ref => !ref)) {
        throw new Error(`EXPERIMENT_EVIDENCE_MISSING:${state}`);
      }
      updateUsage(result);
      if (state === 'review') usage.reviewRounds += 1;
      assertBudget(usage, contract.budgets);
      return result;
    };

    let changedPaths: string[] = [];
    try {
      let reviewVerdict: 'approve' | 'veto' | undefined;
      for (const state of EXECUTION_STATES) {
        const result = await execute(state);
        let passed = result.passed;
        if (state === 'mutate') {
          changedPaths = await changedFiles(workspaceRoot, snapshots);
          passed = passed && changedPaths.length > 0;
        }
        if (state === 'review') {
          if (!result.verdict) throw new Error('EXPERIMENT_REVIEW_VERDICT_MISSING');
          reviewVerdict = result.verdict;
          passed = passed && result.verdict === 'approve';
        }
        stages.push({
          state,
          passed,
          evidenceRefs: [...result.evidenceRefs],
          ...(result.verdict ? { verdict: result.verdict } : {}),
        });
        if (!passed && !failure) {
          failure = {
            state,
            reason: state === 'mutate'
              ? 'EXPERIMENT_MUTATION_NOT_OBSERVED'
              : `EXPERIMENT_STAGE_FAILED:${state}`,
            evidenceRefs: [...result.evidenceRefs],
            quarantined: true,
          };
        }
      }
      if (reviewVerdict !== 'approve' && !failure) {
        throw new Error('EXPERIMENT_REVIEW_NOT_APPROVED');
      }
      const terminal: 'candidate' | 'restored' = failure ? 'restored' : 'candidate';
      const terminalState = assertExperimentTransition(currentContract, (
        terminal === 'candidate' ? 'candidate' : 'restore'
      ));
      currentContract = { ...currentContract, state: terminalState };
      activeState = terminalState;
      if (terminal === 'restored') await restoreFiles(workspaceRoot, snapshots);
      stages.push({
        state: terminalState,
        passed: true,
        evidenceRefs: [`runtime:${terminal}`],
      });

      const learnState = assertExperimentTransition(currentContract, 'learn');
      currentContract = { ...currentContract, state: learnState };
      activeState = learnState;
      const learned = await invokeStage('learn');
      if (!learned.evidenceRefs.length || learned.evidenceRefs.some(ref => !ref)) {
        throw new Error('EXPERIMENT_EVIDENCE_MISSING:learn');
      }
      updateUsage(learned);
      stages.push({
        state: 'learn',
        passed: learned.passed,
        evidenceRefs: [...learned.evidenceRefs],
      });
      if (!learned.passed) {
        failure = {
          state: 'learn',
          reason: 'EXPERIMENT_STAGE_FAILED:learn',
          evidenceRefs: [...learned.evidenceRefs],
          quarantined: true,
        };
        await restoreFiles(workspaceRoot, snapshots);
      }
      const parentUnchanged = await input.parentStateDigest() === parentBefore;
      if (!parentUnchanged) {
        failure = {
          state: 'learn',
          reason: 'EXPERIMENT_PARENT_STATE_CHANGED',
          evidenceRefs: ['parent-state:changed'],
          quarantined: true,
        };
        await restoreFiles(workspaceRoot, snapshots);
      }
      usage.timeMs = Date.now() - startedAt;
      assertBudget(usage, contract.budgets);
      return {
        experimentId: contract.experimentId,
        lineageId: contract.lineageId,
        terminal: failure ? 'restored' : terminal,
        stages,
        usage,
        changedPaths,
        authorityReceipts,
        ...(failure ? { failure } : {}),
        parentUnchanged,
      };
    } catch (error) {
      await restoreFiles(workspaceRoot, snapshots);
      usage.timeMs = Date.now() - startedAt;
      const reason = error instanceof Error ? error.message : 'EXPERIMENT_FAILED';
      const evidenceRefs = stages.flatMap(stage => stage.evidenceRefs);
      return {
        experimentId: contract.experimentId,
        lineageId: contract.lineageId,
        terminal: 'restored',
        stages,
        usage,
        changedPaths,
        authorityReceipts,
        failure: {
          state: activeState,
          reason,
          evidenceRefs: evidenceRefs.length ? evidenceRefs : ['runtime:failure'],
          quarantined: true,
        },
        parentUnchanged: await input.parentStateDigest() === parentBefore,
      };
    }
  }
}
