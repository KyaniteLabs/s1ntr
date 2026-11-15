import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ReviewedAutoresearchExperimentRunner,
  assertReviewedCandidate,
  type ReviewedAutoresearchInput,
} from '../../../src/runtime-core/SealedIndependentReview.js';
import { DEFAULT_SHADOW_BUDGETS } from '../../../src/runtime-core/RecursiveImprovementContract.js';

const roots: string[] = [];
const digest = (value: string): string => (
  createHash('sha256').update(value).digest('hex')
);

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});

async function fixture(): Promise<ReviewedAutoresearchInput> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'w5-sealed-review-'));
  roots.push(root);
  const parent = path.join(root, 'parent');
  const workspace = path.join(root, 'candidate');
  const sealed = path.join(root, 'sealed');
  await Promise.all([
    fs.mkdir(parent),
    fs.mkdir(path.join(workspace, 'src'), { recursive: true }),
    fs.mkdir(sealed),
  ]);
  await fs.writeFile(path.join(workspace, 'src/candidate.ts'), 'before');
  const files = {
    'evaluator.js': "import { threshold } from './dependency.js'; export const evaluate = () => threshold;",
    'dependency.js': 'export const threshold = 0.5;',
    'fixture.json': '{"score":1}',
  };
  await Promise.all(Object.entries(files).map(([name, content]) => (
    fs.writeFile(path.join(sealed, name), content)
  )));
  const manifest = {
    schemaVersion: 1,
    evaluatorCode: [{ path: 'evaluator.js', sha256: digest(files['evaluator.js']) }],
    dependencies: [{ path: 'dependency.js', sha256: digest(files['dependency.js']) }],
    prompt: { id: 'review-v1', sha256: digest('review prompt') },
    reviewer: { provider: 'fixture-review', model: 'reviewer-b', verified: true },
    fixtures: [{ path: 'fixture.json', sha256: digest(files['fixture.json']) }],
    thresholds: { minimumScore: 0.5 },
    controls: [{ id: 'control-a', sha256: digest('control') }],
    environment: { runtime: 'vitest', platform: 'fixture' },
    tools: ['readFile', 'searchCode'],
    artifactSelection: { strategy: 'declared', refs: ['artifact:before', 'artifact:after'] },
  };
  const manifestPath = path.join(sealed, 'manifest.json');
  await fs.writeFile(manifestPath, JSON.stringify(manifest));
  const hypothesis = {
    key: 'fixture',
    claim: 'candidate should improve the bounded fixture',
    falsifier: 'verification fails',
    status: 'ready' as const,
    confidence: 0.8,
    citations: [
      {
        id: 'memory-a',
        hypothesisKey: 'fixture',
        claim: 'candidate should improve the bounded fixture',
        falsifier: 'verification fails',
        source: 'memory' as const,
        sourceRef: 'memory:a',
        lineageId: 'lineage-1',
        stance: 'support' as const,
        confidence: 0.8,
        observedAt: '2026-07-30T00:00:00.000Z',
        trust: 'owner' as const,
        taint: 'clean' as const,
      },
      {
        id: 'operational-b',
        hypothesisKey: 'fixture',
        claim: 'candidate should improve the bounded fixture',
        falsifier: 'verification fails',
        source: 'operational' as const,
        sourceRef: 'operational:b',
        lineageId: 'lineage-2',
        stance: 'support' as const,
        confidence: 0.8,
        observedAt: '2026-07-30T00:00:00.000Z',
        trust: 'verified-system' as const,
        taint: 'clean' as const,
      },
    ],
    supportingSources: ['memory', 'operational'],
    corroboratingSources: ['memory', 'operational'],
    corroboratingRoots: ['lineage-1', 'lineage-2'],
    disagreements: [],
    trust: 'verified-system' as const,
    taint: 'clean' as const,
    expiresAt: '2026-08-29T00:00:00.000Z',
  };
  return {
    manifestPath,
    experiment: {
      contract: {
        version: 1,
        loop: 'autoresearch',
        experimentId: 'experiment-1',
        lineageId: 'lineage-1',
        state: 'observe',
        stage: 'shadow',
        sourceMutationRequested: true,
        budgets: { ...DEFAULT_SHADOW_BUDGETS },
      },
      hypothesis,
      control: { id: 'control-a', digest: digest('control') },
      author: { provider: 'fixture-author', model: 'author-a', verified: true },
      workspaceRoot: workspace,
      parentRoot: parent,
      candidateFiles: ['src/candidate.ts'],
      parentStateDigest: async () => digest('parent-clean'),
      executeStage: async context => {
        if (context.state === 'mutate') {
          await context.writeCandidate('src/candidate.ts', 'after');
        }
        return {
          passed: true,
          evidenceRefs: [`stage:${context.state}`],
          usage: { tokens: 0, retries: 0, artifacts: 0 },
          ...(context.state === 'review' ? { verdict: 'approve' as const } : {}),
        };
      },
    },
    executeReview: async () => ({
      verdict: 'approve',
      identity: {
        provider: 'fixture-review',
        model: 'reviewer-b',
        verified: true,
        requestId: 'fixture-request-1',
        observedAt: '2026-07-30T00:00:00.000Z',
      },
      evidenceRefs: ['review:fixture'],
      disagreement: ['minor naming disagreement'],
      requestedFollowUp: ['test another seed'],
      usage: { tokens: 10, retries: 0, artifacts: 1 },
    }),
  };
}

describe('ReviewedAutoresearchExperimentRunner', () => {
  it('uses a different read-only reviewer and preserves the evaluator seal', async () => {
    const input = await fixture();
    const result = await new ReviewedAutoresearchExperimentRunner().run(input);

    expect(result.experiment.terminal).toBe('candidate');
    expect(result.deliveryAuthority).toBe('candidate-only');
    expect(result.review.verdict).toBe('approve');
    expect(result.review.reviewer.model).toBe('reviewer-b');
    expect(result.review.closureAfterDigest).toBe(result.review.closureBeforeDigest);
    expect(result.review.disagreement).toEqual(['minor naming disagreement']);
    expect(result.review.requestedFollowUp).toEqual(['test another seed']);
    expect(result.review.followUpRequiresNewExperiment).toBe(true);
    expect(() => assertReviewedCandidate(
      input.experiment.contract,
      result.experiment,
      result.review,
    )).not.toThrow();
  });

  it('turns a hard veto into restore and preserves follow-up', async () => {
    const input = await fixture();
    input.executeReview = async context => ({
      verdict: 'veto',
      identity: {
        ...context.manifest.reviewer,
        requestId: 'fixture-veto',
        observedAt: '2026-07-30T00:00:00.000Z',
      },
      evidenceRefs: ['review:veto'],
      disagreement: ['quality floor regressed'],
      requestedFollowUp: ['open experiment-2'],
      usage: { tokens: 10, retries: 0, artifacts: 1 },
    });
    const result = await new ReviewedAutoresearchExperimentRunner().run(input);

    expect(result.experiment.terminal).toBe('restored');
    expect(result.review.verdict).toBe('veto');
    expect(result.review.requestedFollowUp).toEqual(['open experiment-2']);
    expect(await fs.readFile(
      path.join(input.experiment.workspaceRoot, 'src/candidate.ts'),
      'utf8',
    )).toBe('before');
    expect(() => assertReviewedCandidate(
      input.experiment.contract,
      result.experiment,
      result.review,
    )).toThrow(/NOT_AVAILABLE/);
  });

  it('rejects self-review before mutation', async () => {
    const input = await fixture();
    const manifest = JSON.parse(await fs.readFile(input.manifestPath, 'utf8'));
    manifest.reviewer = input.experiment.author;
    await fs.writeFile(input.manifestPath, JSON.stringify(manifest));

    await expect(new ReviewedAutoresearchExperimentRunner().run(input))
      .rejects.toThrow(/SELF_REVIEW_DENIED/);
    expect(await fs.readFile(
      path.join(input.experiment.workspaceRoot, 'src/candidate.ts'),
      'utf8',
    )).toBe('before');
  });

  it('rejects reviewer write authority before mutation', async () => {
    const input = await fixture();
    const manifest = JSON.parse(await fs.readFile(input.manifestPath, 'utf8'));
    manifest.tools.push('applyEdit');
    await fs.writeFile(input.manifestPath, JSON.stringify(manifest));

    await expect(new ReviewedAutoresearchExperimentRunner().run(input))
      .rejects.toThrow(/REVIEWER_WRITE_DENIED/);
  });

  it('restores when the live identity differs from the sealed identity', async () => {
    const input = await fixture();
    const base = input.executeReview;
    input.executeReview = async context => {
      const result = await base(context);
      return {
        ...result,
        identity: { ...result.identity, model: 'unsealed-reviewer' },
      };
    };

    await expect(new ReviewedAutoresearchExperimentRunner().run(input))
      .rejects.toThrow(/REVIEW_FAILED/);
    expect(await fs.readFile(
      path.join(input.experiment.workspaceRoot, 'src/candidate.ts'),
      'utf8',
    )).toBe('before');
  });

  it('detects evaluator drift and restores the candidate', async () => {
    const input = await fixture();
    const base = input.executeReview;
    input.executeReview = async context => {
      const result = await base(context);
      await fs.writeFile(
        path.join(path.dirname(input.manifestPath), 'dependency.js'),
        'tampered',
      );
      return result;
    };

    await expect(new ReviewedAutoresearchExperimentRunner().run(input))
      .rejects.toThrow(/REVIEW_FAILED/);
    expect(await fs.readFile(
      path.join(input.experiment.workspaceRoot, 'src/candidate.ts'),
      'utf8',
    )).toBe('before');
  });

  it('rejects an unknown reviewer identity', async () => {
    const input = await fixture();
    const manifest = JSON.parse(await fs.readFile(input.manifestPath, 'utf8'));
    manifest.reviewer.verified = false;
    await fs.writeFile(input.manifestPath, JSON.stringify(manifest));

    await expect(new ReviewedAutoresearchExperimentRunner().run(input))
      .rejects.toThrow(/REVIEWER_UNVERIFIED/);
  });

  it('rejects an imported dependency omitted from the manifest', async () => {
    const input = await fixture();
    const content = "import './missing.js'; export const evaluate = () => true;";
    await fs.writeFile(path.join(path.dirname(input.manifestPath), 'evaluator.js'), content);
    const manifest = JSON.parse(await fs.readFile(input.manifestPath, 'utf8'));
    manifest.evaluatorCode[0].sha256 = digest(content);
    await fs.writeFile(input.manifestPath, JSON.stringify(manifest));

    await expect(new ReviewedAutoresearchExperimentRunner().run(input))
      .rejects.toThrow(/UNPINNED_IMPORT/);
  });
});
