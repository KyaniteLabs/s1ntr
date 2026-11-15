import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  ReviewedAutoresearchExperimentRunner,
  assertReviewedCandidate,
  createSealedReviewGateReceipt,
  parseAutoresearchExperimentGateReceipt,
  parseSealedReviewGateReceipt,
} from '../../dist/index.js';

const DEFAULT_SHADOW_BUDGETS = {
  tokens: 100_000,
  calls: 100,
  timeMs: 300_000,
  retries: 3,
  artifacts: 100,
  diskBytes: 10_000_000,
  worktrees: 1,
  reviewRounds: 1,
};

const outputIndex = process.argv.indexOf('--output');
const outputPath = outputIndex >= 0
  ? path.resolve(process.argv[outputIndex + 1])
  : path.resolve('docs/agents/waves/receipts/wave-5-W5-10-sealed-review.json');
const prerequisitePath = path.resolve(
  'docs/agents/waves/receipts/wave-5-W5-09-autoresearch-experiment.json',
);
const digest = value => createHash('sha256').update(value).digest('hex');
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'w5-10-proof-'));
const parentRoot = path.join(root, 'parent');
const sealedRoot = path.join(root, 'sealed');
await Promise.all([
  fs.mkdir(parentRoot),
  fs.mkdir(sealedRoot),
]);

const sealedFiles = {
  'evaluator.js': "import { threshold } from './dependency.js';\nexport const evaluate = value => value >= threshold;\n",
  'dependency.js': 'export const threshold = 0.5;\n',
  'fixture.json': '{"control":0.5,"treatment":0.7}\n',
};
for (const [name, content] of Object.entries(sealedFiles)) {
  await fs.writeFile(path.join(sealedRoot, name), content);
}
const manifest = {
  schemaVersion: 1,
  evaluatorCode: [{ path: 'evaluator.js', sha256: digest(sealedFiles['evaluator.js']) }],
  dependencies: [{ path: 'dependency.js', sha256: digest(sealedFiles['dependency.js']) }],
  prompt: { id: 'w5-10-review-v1', sha256: digest('sealed review prompt') },
  reviewer: { provider: 'fixture-review', model: 'reviewer-b', verified: true },
  fixtures: [{ path: 'fixture.json', sha256: digest(sealedFiles['fixture.json']) }],
  thresholds: { minimumScore: 0.5, maximumRegression: 0 },
  controls: [{ id: 'control-a', sha256: digest('control-a') }],
  environment: { runtime: 'node', platform: 'proof-fixture' },
  tools: ['readFile', 'searchCode'],
  artifactSelection: {
    strategy: 'declared-control-treatment',
    refs: ['artifact:control', 'artifact:treatment'],
  },
};
const manifestPath = path.join(sealedRoot, 'manifest.json');
await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2));

const hypothesis = {
  key: 'fixture',
  claim: 'bounded treatment improves the fixture',
  falsifier: 'review or verification vetoes',
  status: 'ready',
  confidence: 0.8,
  citations: ['memory', 'operational'].map((source, index) => ({
    id: `${source}-${index}`,
    hypothesisKey: 'fixture',
    claim: 'bounded treatment improves the fixture',
    falsifier: 'review or verification vetoes',
    source,
    sourceRef: `${source}:${index}`,
    lineageId: `lineage:${source}`,
    stance: 'support',
    confidence: 0.8,
    observedAt: '2026-07-30T00:00:00.000Z',
    trust: index ? 'owner' : 'verified-system',
    taint: 'clean',
  })),
  supportingSources: ['memory', 'operational'],
  corroboratingSources: ['memory', 'operational'],
  disagreements: [],
  trust: 'verified-system',
  taint: 'clean',
  expiresAt: '2026-08-29T00:00:00.000Z',
};

async function makeInput(name, verdict = 'approve') {
  const workspaceRoot = path.join(root, name);
  await fs.mkdir(path.join(workspaceRoot, 'src'), { recursive: true });
  await fs.writeFile(path.join(workspaceRoot, 'src/candidate.ts'), 'before\n');
  return {
    manifestPath,
    experiment: {
      contract: {
        version: 1,
        loop: 'autoresearch',
        experimentId: `w5-10-${name}`,
        lineageId: 'w5-09-fixture',
        state: 'observe',
        stage: 'shadow',
        sourceMutationRequested: true,
        budgets: { ...DEFAULT_SHADOW_BUDGETS },
      },
      hypothesis,
      control: { id: 'control-a', digest: digest('control-a') },
      author: { provider: 'fixture-author', model: 'author-a', verified: true },
      workspaceRoot,
      parentRoot,
      candidateFiles: ['src/candidate.ts'],
      parentStateDigest: async () => digest('parent-clean'),
      executeStage: async context => {
        if (context.state === 'mutate') {
          await context.writeCandidate('src/candidate.ts', 'after\n');
        }
        return {
          passed: true,
          evidenceRefs: [`stage:${context.state}`],
          usage: { tokens: 0, retries: 0, artifacts: 0 },
          ...(context.state === 'review' ? { verdict: 'approve' } : {}),
        };
      },
    },
    executeReview: async context => ({
      verdict,
      identity: {
        ...context.manifest.reviewer,
        requestId: `fixture-${verdict}`,
        observedAt: '2026-07-30T00:00:00.000Z',
      },
      evidenceRefs: [`review:${verdict}`],
      disagreement: [verdict === 'approve' ? 'minor naming concern' : 'quality floor regression'],
      requestedFollowUp: [`new-experiment:${name}-follow-up`],
      usage: { tokens: 10, retries: 0, artifacts: 1 },
    }),
  };
}

const runner = new ReviewedAutoresearchExperimentRunner();
const approvedInput = await makeInput('approved');
const approved = await runner.run(approvedInput);
const vetoInput = await makeInput('vetoed', 'veto');
const vetoed = await runner.run(vetoInput);
assert.equal(approved.experiment.terminal, 'candidate');
assert.equal(vetoed.experiment.terminal, 'restored');
assert.equal(
  await fs.readFile(path.join(vetoInput.experiment.workspaceRoot, 'src/candidate.ts'), 'utf8'),
  'before\n',
);

const failClosedCases = [];
async function expectFail(name, mutateManifest, mutateInput) {
  const current = structuredClone(manifest);
  await mutateManifest?.(current);
  await fs.writeFile(manifestPath, JSON.stringify(current, null, 2));
  const input = await makeInput(`fail-${name}`);
  mutateInput?.(input);
  await assert.rejects(() => runner.run(input));
  assert.equal(
    await fs.readFile(path.join(input.experiment.workspaceRoot, 'src/candidate.ts'), 'utf8'),
    'before\n',
  );
  failClosedCases.push(name);
  await fs.writeFile(path.join(sealedRoot, 'evaluator.js'), sealedFiles['evaluator.js']);
  await fs.writeFile(path.join(sealedRoot, 'dependency.js'), sealedFiles['dependency.js']);
  await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2));
}

await expectFail('self-review', value => {
  value.reviewer = { provider: 'fixture-author', model: 'author-a', verified: true };
});
await expectFail('unknown-identity', value => {
  value.reviewer.verified = false;
});
await expectFail('reviewer-write', value => {
  value.tools.push('applyEdit');
});
await expectFail('closure-omission', async value => {
  const content = "import './missing.js'; export const evaluate = () => true;\n";
  await fs.writeFile(path.join(sealedRoot, 'evaluator.js'), content);
  value.evaluatorCode[0].sha256 = digest(content);
});
await expectFail('identity-mismatch', undefined, input => {
  const execute = input.executeReview;
  input.executeReview = async context => {
    const result = await execute(context);
    return { ...result, identity: { ...result.identity, model: 'other' } };
  };
});
await expectFail('manifest-drift', undefined, input => {
  const execute = input.executeReview;
  input.executeReview = async context => {
    const result = await execute(context);
    await fs.writeFile(path.join(sealedRoot, 'dependency.js'), 'tampered\n');
    return result;
  };
});

let vetoPromotionDenied = false;
try {
  assertReviewedCandidate(
    vetoInput.experiment.contract,
    vetoed.experiment,
    vetoed.review,
  );
} catch {
  vetoPromotionDenied = true;
}
assert.equal(vetoPromotionDenied, true);

const prerequisite = parseAutoresearchExperimentGateReceipt(
  JSON.parse(await fs.readFile(prerequisitePath, 'utf8')),
);
const manifestDigest = digest(await fs.readFile(manifestPath));
const receipt = createSealedReviewGateReceipt({
  generatedAt: '2026-07-30T00:00:00.000Z',
  prerequisite,
  approved,
  vetoed,
  manifestDigest,
  manifestOutsideCandidate: !manifestPath.startsWith(
    `${approvedInput.experiment.workspaceRoot}${path.sep}`,
  ),
  manifestPinsRequiredClosure: [
    manifest.evaluatorCode,
    manifest.dependencies,
    manifest.fixtures,
    manifest.controls,
    manifest.tools,
    manifest.artifactSelection.refs,
  ].every(value => value.length > 0),
  vetoPromotionDenied,
  failClosedCases,
  evidenceRefs: [
    'receipt:wave-5-W5-09-autoresearch-experiment',
    'fixture:sealed-evaluator-manifest',
    'fixture:independent-approve',
    'fixture:independent-veto',
  ],
});
assert.equal(receipt.outcome, 'PASS');
assert.equal(Object.values(receipt.checks).every(Boolean), true);
parseSealedReviewGateReceipt(receipt);
await fs.mkdir(path.dirname(outputPath), { recursive: true });
await fs.writeFile(outputPath, `${JSON.stringify(receipt, null, 2)}\n`);
await fs.rm(root, { recursive: true, force: true });
process.stdout.write(`${JSON.stringify({
  ok: true,
  gate: receipt.gate,
  outcome: receipt.outcome,
  checkCount: Object.keys(receipt.checks).length,
  receiptDigest: receipt.receiptDigest,
  outputPath,
}, null, 2)}\n`);
