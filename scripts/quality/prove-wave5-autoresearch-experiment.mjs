import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  AutoresearchExperimentRunner,
  createAutoresearchExperimentGateReceipt,
  parseCompositionEvaluationGateReceipt,
  parseEvidenceConsolidationGateReceipt,
} from '../../dist/index.js';
import {
  DEFAULT_SHADOW_BUDGETS,
  RECURSIVE_CONTRACT_VERSION,
} from '../../dist/runtime-core/RecursiveImprovementContract.js';

const readJson = async relative => JSON.parse(await readFile(
  new URL(relative, import.meta.url),
  'utf8',
));
const authorityRaw = await readJson(
  '../../docs/agents/waves/receipts/wave-5-W5-04-experiment-authority.json',
);
const { receiptDigest: authorityDigest, ...authorityUnsigned } = authorityRaw;
assert.equal(
  createHash('sha256').update(JSON.stringify(authorityUnsigned)).digest('hex'),
  authorityDigest,
);
const composition = parseCompositionEvaluationGateReceipt(await readJson(
  '../../docs/agents/waves/receipts/wave-5-W5-06-composition-evaluation.json',
));
const consolidation = parseEvidenceConsolidationGateReceipt(await readJson(
  '../../docs/agents/waves/receipts/wave-5-W5-08-evidence-consolidation.json',
));

const root = await mkdtemp(path.join(os.tmpdir(), 'w5-09-proof-'));
const parentRoot = path.join(root, 'parent');
const workspaceRoot = path.join(root, 'worktree');
const candidatePath = 'src/candidate.ts';
await mkdir(path.join(parentRoot, 'src'), { recursive: true });
await mkdir(path.join(workspaceRoot, 'src'), { recursive: true });
await writeFile(path.join(parentRoot, candidatePath), 'export const value = 1;\n');
await writeFile(path.join(workspaceRoot, candidatePath), 'export const value = 1;\n');

const parentStateDigest = async () => createHash('sha256')
  .update(await readFile(path.join(parentRoot, candidatePath)))
  .digest('hex');
const contract = () => ({
  version: RECURSIVE_CONTRACT_VERSION,
  loop: 'autoresearch',
  experimentId: 'w5-09-proof',
  lineageId: consolidation.ready.key,
  state: 'observe',
  stage: 'shadow',
  sourceMutationRequested: true,
  budgets: { ...DEFAULT_SHADOW_BUDGETS },
});
const baseInput = executeStage => ({
  contract: contract(),
  hypothesis: consolidation.ready,
  control: {
    id: 'w5-09-fixture-control',
    digest: createHash('sha256').update('export const value = 1;\n').digest('hex'),
  },
  author: { provider: 'fixture', model: 'author-fixture', verified: true },
  workspaceRoot,
  parentRoot,
  candidateFiles: [candidatePath],
  sealedEvaluatorFiles: ['src/sealed-evaluator.ts'],
  parentStateDigest,
  executeStage,
});
const stageUsage = { tokens: 0, retries: 0, artifacts: 0 };
const passingStage = async context => {
  if (context.state === 'mutate') {
    await context.writeCandidate(candidatePath, 'export const value = 2;\n');
  }
  return {
    passed: true,
    evidenceRefs: [`w5-09:${context.state}`],
    usage: stageUsage,
    ...(context.state === 'review' ? { verdict: 'approve' } : {}),
  };
};

const runner = new AutoresearchExperimentRunner();
const passing = await runner.run(baseInput(passingStage));
assert.equal(passing.terminal, 'candidate');
assert.equal(passing.parentUnchanged, true);

await writeFile(path.join(workspaceRoot, candidatePath), 'export const value = 1;\n');
const failing = await runner.run(baseInput(async context => {
  const result = await passingStage(context);
  if (context.state === 'verify') return { ...result, passed: false };
  if (context.state === 'review') return { ...result, verdict: 'veto' };
  return result;
}));
assert.equal(failing.terminal, 'restored');
assert.equal(failing.failure.quarantined, true);
assert.equal(
  await readFile(path.join(workspaceRoot, candidatePath), 'utf8'),
  'export const value = 1;\n',
);

const boundaryEscape = await runner.run(baseInput(async context => {
  if (context.state === 'mutate') {
    await context.writeCandidate(candidatePath, 'export const value = 2;\n');
    await context.writeCandidate('../parent/src/candidate.ts', 'escaped\n');
  }
  return {
    passed: true,
    evidenceRefs: [`w5-09:${context.state}`],
    usage: stageUsage,
    ...(context.state === 'review' ? { verdict: 'approve' } : {}),
  };
}));
assert.equal(boundaryEscape.terminal, 'restored');
assert.equal(boundaryEscape.parentUnchanged, true);

const failClosedCases = [];
const expectRejected = async (name, input) => {
  await assert.rejects(runner.run(input));
  failClosedCases.push(name);
};
await expectRejected('identity', {
  ...baseInput(passingStage),
  author: { provider: '', model: '', verified: false },
});
await expectRejected('evidence', {
  ...baseInput(passingStage),
  hypothesis: { ...consolidation.ready, citations: [] },
});
await expectRejected('control', {
  ...baseInput(passingStage),
  control: { id: '', digest: '' },
});
await expectRejected('budget', {
  ...baseInput(passingStage),
  contract: {
    ...contract(),
    budgets: { ...DEFAULT_SHADOW_BUDGETS, calls: 0 },
  },
});
const missingReview = await runner.run(baseInput(async context => {
  const result = await passingStage(context);
  if (context.state !== 'review') return result;
  const { verdict: _verdict, ...withoutVerdict } = result;
  return withoutVerdict;
}));
assert.equal(missingReview.failure.reason, 'EXPERIMENT_REVIEW_VERDICT_MISSING');
failClosedCases.push('review');

const receipt = createAutoresearchExperimentGateReceipt({
  generatedAt: new Date().toISOString(),
  prerequisites: {
    authority: {
      gate: 'W5-04',
      outcome: authorityRaw.outcome,
      receiptDigest: authorityDigest,
    },
    composition,
    consolidation,
  },
  budgets: DEFAULT_SHADOW_BUDGETS,
  passing,
  failing,
  boundaryEscape,
  failClosedCases,
  evidenceRefs: [
    'receipt:wave-5-W5-04-experiment-authority',
    'receipt:wave-5-W5-06-composition-evaluation',
    'receipt:wave-5-W5-08-evidence-consolidation',
    'test:AutoresearchExperimentRunner',
  ],
});
assert.equal(receipt.outcome, 'PASS');

const outputIndex = process.argv.indexOf('--output');
if (outputIndex >= 0) {
  const outputPath = process.argv[outputIndex + 1];
  if (!outputPath) throw new Error('--output requires a path');
  await writeFile(outputPath, `${JSON.stringify(receipt, null, 2)}\n`, 'utf8');
}
process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
await rm(root, { recursive: true, force: true });
