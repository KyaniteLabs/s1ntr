import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  AutoresearchExperimentRunner,
  type AutoresearchExperimentInput,
  type AutoresearchStageContext,
} from '../../../src/runtime-core/AutoresearchExperimentRunner.js';
import {
  DEFAULT_SHADOW_BUDGETS,
  RECURSIVE_CONTRACT_VERSION,
} from '../../../src/runtime-core/RecursiveImprovementContract.js';

describe('AutoresearchExperimentRunner', () => {
  let root: string;
  let parentRoot: string;
  let workspaceRoot: string;
  const candidatePath = 'src/candidate.ts';
  const stageUsage = { tokens: 0, retries: 0, artifacts: 0 };

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'w5-09-runner-'));
    parentRoot = path.join(root, 'parent');
    workspaceRoot = path.join(root, 'worktree');
    await fs.mkdir(path.join(parentRoot, 'src'), { recursive: true });
    await fs.mkdir(path.join(workspaceRoot, 'src'), { recursive: true });
    await fs.writeFile(path.join(parentRoot, candidatePath), 'export const value = 1;\n');
    await fs.writeFile(path.join(workspaceRoot, candidatePath), 'export const value = 1;\n');
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  const parentDigest = async (): Promise<string> => createHash('sha256')
    .update(await fs.readFile(path.join(parentRoot, candidatePath)))
    .digest('hex');

  const makeInput = (
    executeStage: AutoresearchExperimentInput['executeStage'],
    overrides: Partial<AutoresearchExperimentInput> = {},
  ): AutoresearchExperimentInput => ({
    contract: {
      version: RECURSIVE_CONTRACT_VERSION,
      loop: 'autoresearch',
      experimentId: 'w5-09-fixture',
      lineageId: 'w5-08-hypothesis',
      state: 'observe',
      stage: 'shadow',
      sourceMutationRequested: true,
      budgets: { ...DEFAULT_SHADOW_BUDGETS },
    },
    hypothesis: {
      key: 'fixture',
      claim: 'Changing one bounded constant improves the fixture',
      falsifier: 'Reject when verification returns false',
      status: 'ready',
      confidence: 0.8,
      citations: [
        {
          id: 'memory-1',
          hypothesisKey: 'fixture',
          claim: 'Changing one bounded constant improves the fixture',
          falsifier: 'Reject when verification returns false',
          source: 'memory',
          sourceRef: 'memory:1',
          lineageId: 'lineage:memory-1',
          stance: 'support',
          confidence: 0.8,
          observedAt: '2026-07-30T00:00:00.000Z',
          trust: 'verified-system',
          taint: 'clean',
        },
        {
          id: 'ops-1',
          hypothesisKey: 'fixture',
          claim: 'Changing one bounded constant improves the fixture',
          falsifier: 'Reject when verification returns false',
          source: 'operational',
          sourceRef: 'operational:1',
          lineageId: 'lineage:ops-1',
          stance: 'support',
          confidence: 0.8,
          observedAt: '2026-07-30T00:00:00.000Z',
          trust: 'owner',
          taint: 'clean',
        },
      ],
      supportingSources: ['memory', 'operational'],
      corroboratingSources: ['memory', 'operational'],
      corroboratingRoots: ['lineage:memory-1', 'lineage:ops-1'],
      disagreements: [],
      trust: 'verified-system',
      taint: 'clean',
      expiresAt: '2026-08-29T00:00:00.000Z',
    },
    control: { id: 'control-1', digest: 'a'.repeat(64) },
    author: { provider: 'openai', model: 'codex-sol', verified: true },
    workspaceRoot,
    parentRoot,
    candidateFiles: [candidatePath],
    parentStateDigest: parentDigest,
    executeStage,
    ...overrides,
  });

  const passingStage = async (context: AutoresearchStageContext) => {
    if (context.state === 'mutate') {
      await context.writeCandidate(candidatePath, 'export const value = 2;\n');
    }
    return {
      passed: true,
      evidenceRefs: [`fixture:${context.state}`],
      usage: stageUsage,
      ...(context.state === 'review' ? { verdict: 'approve' as const } : {}),
    };
  };

  it('runs every state and leaves a reviewed candidate only in the worktree', async () => {
    const result = await new AutoresearchExperimentRunner()
      .run(makeInput(passingStage));

    expect(result.terminal).toBe('candidate');
    expect(result.parentUnchanged).toBe(true);
    expect(result.changedPaths).toEqual([candidatePath]);
    expect(result.stages.map(stage => stage.state)).toEqual([
      'observe', 'hypothesize', 'baseline', 'reproduce', 'mutate', 'verify',
      'artifact-evaluate', 'review', 'candidate', 'learn',
    ]);
    expect(await fs.readFile(
      path.join(workspaceRoot, candidatePath), 'utf8',
    )).toContain('value = 2');
    expect(await fs.readFile(
      path.join(parentRoot, candidatePath), 'utf8',
    )).toContain('value = 1');
  });

  it('restores and quarantines a deliberately failing candidate', async () => {
    const result = await new AutoresearchExperimentRunner().run(makeInput(
      async context => {
        const base = await passingStage(context);
        if (context.state === 'verify') return { ...base, passed: false };
        if (context.state === 'review') return { ...base, verdict: 'veto' as const };
        return base;
      },
    ));

    expect(result).toMatchObject({
      terminal: 'restored',
      failure: { state: 'verify', quarantined: true },
      parentUnchanged: true,
    });
    expect(result.stages.map(stage => stage.state)).toContain('restore');
    expect(await fs.readFile(
      path.join(workspaceRoot, candidatePath), 'utf8',
    )).toContain('value = 1');
  });

  it('denies a write-boundary escape and restores prior mutations', async () => {
    const result = await new AutoresearchExperimentRunner().run(makeInput(
      async context => {
        if (context.state === 'mutate') {
          await context.writeCandidate(candidatePath, 'export const value = 2;\n');
          await context.writeCandidate('../parent/src/candidate.ts', 'escaped\n');
        }
        return {
          passed: true,
          evidenceRefs: [`fixture:${context.state}`],
          usage: stageUsage,
          ...(context.state === 'review' ? { verdict: 'approve' as const } : {}),
        };
      },
    ));

    expect(result).toMatchObject({
      terminal: 'restored',
      parentUnchanged: true,
    });
    expect(result.failure?.reason).toContain('EXPERIMENT_WRITE_DENIED');
    expect(result.authorityReceipts.some(receipt =>
      receipt.decision === 'deny')).toBe(true);
    expect(await fs.readFile(
      path.join(workspaceRoot, candidatePath), 'utf8',
    )).toContain('value = 1');
  });

  it('cannot skip or write outside the mutate and review states', async () => {
    const writeEarly = await new AutoresearchExperimentRunner().run(makeInput(
      async context => {
        if (context.state === 'baseline') {
          await context.writeCandidate(candidatePath, 'early\n');
        }
        return {
          passed: true,
          evidenceRefs: [`fixture:${context.state}`],
          usage: stageUsage,
        };
      },
    ));
    expect(writeEarly.failure?.reason).toContain('EXPERIMENT_WRITE_OUTSIDE_MUTATE');

    const missingReview = await new AutoresearchExperimentRunner()
      .run(makeInput(passingStage, {
        executeStage: async context => {
          const result = await passingStage(context);
          return context.state === 'review'
            ? { passed: true, evidenceRefs: result.evidenceRefs, usage: stageUsage }
            : result;
        },
      }));
    expect(missingReview.failure?.reason).toBe('EXPERIMENT_REVIEW_VERDICT_MISSING');
  });

  it('fails closed on missing identity, evidence, control, or budget', async () => {
    const runner = new AutoresearchExperimentRunner();
    await expect(runner.run(makeInput(passingStage, {
      author: { provider: '', model: '', verified: false },
    }))).rejects.toThrow('EXPERIMENT_AUTHOR_IDENTITY_UNVERIFIED');
    await expect(runner.run(makeInput(passingStage, {
      hypothesis: {
        ...makeInput(passingStage).hypothesis,
        citations: [],
      },
    }))).rejects.toThrow('EXPERIMENT_HYPOTHESIS_EVIDENCE_MISSING');
    await expect(runner.run(makeInput(passingStage, {
      hypothesis: {
        ...makeInput(passingStage).hypothesis,
        // Two source categories derived from one root lineage count as one root.
        citations: makeInput(passingStage).hypothesis.citations
          .map(item => ({ ...item, lineageId: 'lineage:memory-1' })),
      },
    }))).rejects.toThrow('EXPERIMENT_HYPOTHESIS_EVIDENCE_MISSING');
    await expect(runner.run(makeInput(passingStage, {
      control: { id: '', digest: '' },
    }))).rejects.toThrow('EXPERIMENT_CONTROL_MISSING');
    await expect(runner.run(makeInput(passingStage, {
      contract: {
        ...makeInput(passingStage).contract,
        budgets: { ...DEFAULT_SHADOW_BUDGETS, calls: 0 },
      },
    }))).rejects.toThrow('INVALID_BUDGET');
  });

  it('restores automatically when a hard budget is exhausted', async () => {
    const input = makeInput(passingStage);
    input.contract.budgets = { ...DEFAULT_SHADOW_BUDGETS, calls: 2 };
    const result = await new AutoresearchExperimentRunner().run(input);

    expect(result).toMatchObject({
      terminal: 'restored',
      failure: { reason: 'EXPERIMENT_BUDGET_EXCEEDED:calls' },
    });
    expect(await fs.readFile(
      path.join(workspaceRoot, candidatePath), 'utf8',
    )).toContain('value = 1');
  });

  it('enforces the wall-clock stop condition', async () => {
    const input = makeInput(async () => new Promise(() => {}));
    input.contract.budgets = { ...DEFAULT_SHADOW_BUDGETS, timeMs: 5 };
    const result = await new AutoresearchExperimentRunner().run(input);

    expect(result).toMatchObject({
      terminal: 'restored',
      failure: { reason: 'EXPERIMENT_BUDGET_EXCEEDED:timeMs' },
    });
  });
});
