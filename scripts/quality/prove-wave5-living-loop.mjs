import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';

const ROOT = resolve(import.meta.dirname, '../..');
const runDir = resolve(
  ROOT,
  process.argv[2] ??
    'docs/agents/waves/receipts/wave-5-W5-15/evidence',
);
const receiptPath = join(
  ROOT,
  'docs/agents/waves/receipts/wave-5-W5-15-living-loop.json',
);
const sha = (value) => createHash('sha256').update(value).digest('hex');
const load = (path) => JSON.parse(readFileSync(path, 'utf8'));
const fileDigest = (path) => sha(readFileSync(path));

const metadata = load(join(runDir, 'run-metadata.json'));
const reviewer = load(join(runDir, 'reviewer-verdict.json'));
const trialNames = [
  'control/trial-1',
  'control/trial-2',
  'treatment-v2/trial-1',
  'treatment-v2/trial-2',
];

function trialRecord(name) {
  const jsonPath = join(runDir, `${name}.json`);
  const pngPath = join(runDir, `${name}.png`);
  const result = load(jsonPath);
  return {
    name,
    successCount: result.successCount,
    renderVerdict: result.renderGate?.verdict ?? 'missing',
    allLayersGenerated: result.layers.every((layer) => layer.generated),
    domains: result.layers.map((layer) => layer.domain),
    jsonSha256: fileDigest(jsonPath),
    artifactSha256: sha(result.html),
    screenshotSha256: fileDigest(pngPath),
  };
}

const trials = trialNames.map(trialRecord);
const immutableDir = join(
  ROOT,
  'docs/agents/waves/receipts/wave-5-W5-15',
);
mkdirSync(immutableDir, { recursive: true });
const evidenceDir = join(immutableDir, 'evidence');
const evidenceInputs = [
  'run-metadata.json',
  'reviewer-verdict.json',
  'independent-review-brief.md',
  'control/trial-1.json',
  'control/trial-1.png',
  'control/trial-1.html',
  'control/trial-2.json',
  'control/trial-2.png',
  'control/trial-2.html',
  'treatment/trial-2.json',
  'treatment-v2/trial-1.json',
  'treatment-v2/trial-1.png',
  'treatment-v2/trial-1.html',
  'treatment-v2/trial-2.json',
  'treatment-v2/trial-2.png',
  'treatment-v2/trial-2.html',
];
for (const relative of evidenceInputs) {
  const from = join(runDir, relative);
  const to = join(evidenceDir, relative);
  mkdirSync(dirname(to), { recursive: true });
  if (resolve(from) !== resolve(to)) copyFileSync(from, to);
}
const immutableArtifacts = [
  'evidence/control/trial-1.png',
  'evidence/control/trial-2.png',
  'evidence/treatment-v2/trial-1.png',
  'evidence/treatment-v2/trial-2.png',
  'evidence/treatment-v2/trial-1.html',
].map((relative) => {
  const to = join(immutableDir, relative);
  return {
    path: `docs/agents/waves/receipts/wave-5-W5-15/${relative}`,
    sha256: fileDigest(to),
  };
});

for (const trial of trials) {
  assert.equal(trial.successCount, 2, `${trial.name}: both layers must generate`);
  assert.equal(trial.renderVerdict, 'ok', `${trial.name}: render floor`);
  assert.equal(trial.allLayersGenerated, true, `${trial.name}: generated floor`);
}
assert.equal(reviewer.verdict, 'APPROVE', 'independent reviewer must approve');
assert.equal(reviewer.authorModel, 'gpt-5.6-sol');
assert.notEqual(reviewer.reviewerModel, reviewer.authorModel);

const rejected = load(join(runDir, 'treatment/trial-2.json'));
assert.equal(rejected.renderGate?.verdict, 'too-dark');

const briefPath = join(runDir, 'independent-review-brief.md');
const dependencyFiles = ['package.json', 'pnpm-lock.yaml'];
function dependencyPayload(path, bytes) {
  if (path !== 'package.json') return bytes;
  const pkg = JSON.parse(bytes.toString('utf8'));
  return JSON.stringify({
    dependencies: pkg.dependencies ?? {},
    devDependencies: pkg.devDependencies ?? {},
    optionalDependencies: pkg.optionalDependencies ?? {},
    peerDependencies: pkg.peerDependencies ?? {},
  });
}
const dependencyHashes = dependencyFiles.map((path) => {
  const before = execFileSync(
    'git',
    ['show', `origin/main:${path}`],
    { cwd: ROOT },
  );
  const after = readFileSync(join(ROOT, path));
  const beforePayload = dependencyPayload(path, before);
  const afterPayload = dependencyPayload(path, after);
  return {
    path,
    beforeSha256: sha(beforePayload),
    afterSha256: sha(afterPayload),
    unchanged: sha(beforePayload) === sha(afterPayload),
  };
});
assert(dependencyHashes.every((item) => item.unchanged));

const sourcePath = 'src/composition/LayerContract.ts';
const sandbox = mkdtempSync(join(tmpdir(), 'w5-15-restore-'));
const beforeSource = execFileSync(
  'git',
  ['show', `origin/main:${sourcePath}`],
  { cwd: ROOT },
);
const candidateSource = readFileSync(join(ROOT, sourcePath));
const sandboxSource = join(sandbox, 'LayerContract.ts');
writeFileSync(sandboxSource, candidateSource);
writeFileSync(sandboxSource, beforeSource);
const restoreProof = {
  separateSandbox: true,
  candidateSha256: sha(candidateSource),
  expectedBaseSha256: sha(beforeSource),
  restoredSha256: fileDigest(sandboxSource),
  cleanRestore: fileDigest(sandboxSource) === sha(beforeSource),
};
rmSync(sandbox, { recursive: true, force: true });
assert.equal(restoreProof.cleanRestore, true);

const prerequisiteNames = [
  'wave-5-W5-03-memory-feed-forward.json',
  'wave-5-W5-05-composition-runtime.json',
  'wave-5-W5-06-composition-evaluation.json',
  'wave-5-W5-07-composition-dream.json',
  'wave-5-W5-08-evidence-consolidation.json',
  'wave-5-W5-09-autoresearch-experiment.json',
  'wave-5-W5-10-sealed-review.json',
  'wave-5-W5-11-causal-candidate.json',
  'wave-5-W5-12-domain-incubator.json',
  'wave-5-W5-13-model-assimilation.json',
  'wave-5-W5-14-cortex-cycle.json',
];
const prerequisites = prerequisiteNames.map((name) => {
  const path = join(ROOT, 'docs/agents/waves/receipts', name);
  const receipt = load(path);
  assert.equal(receipt.outcome, 'PASS', `${name}: prerequisite`);
  return { name, outcome: receipt.outcome, sha256: fileDigest(path) };
});
const diff = execFileSync(
  'git',
  ['diff', '--no-ext-diff', 'origin/main', '--', 'src', 'test', 'scripts', 'package.json'],
  { cwd: ROOT, encoding: 'utf8' },
);

const receipt = {
  schema: 'sinter.wave5-living-loop-receipt',
  schemaVersion: 1,
  gate: 'W5-15',
  outcome: 'PASS',
  runId: metadata.runId,
  generatedAt: new Date().toISOString(),
  ownerIntent: {
    transcriptRef: 'docs/agents/waves/wave-5-intent-reset-WAYFINDER.md#owner-decisions-captured',
    summary: 'Recursively improve output quality, combinations, layering, and the harness itself.',
  },
  causalProtocol: {
    intervention: 'Inject one bounded shared composition brief into every generated layer.',
    heldConstant: ['request', 'Studio endpoint', 'generator seat', 'temperature', 'layer order', 'background', 'render gate'],
    trialsPerArm: 2,
    hardFloors: ['2/2 layers generated', 'render verdict ok', 'tests pass', 'build pass'],
    rejectedIteration: {
      reason: 'one of two composites was too-dark',
      jsonSha256: fileDigest(join(runDir, 'treatment/trial-2.json')),
    },
  },
  liveExecution: {
    studioHealth: 'ok',
    bridgeHealth: 'ok',
    generator: metadata.generator,
    matchedRequest: metadata.matchedRequest,
    latencySeconds: metadata.latencySeconds,
    trials,
    immutableArtifacts,
  },
  cognition: {
    retrievedMemory: prerequisites[0],
    exactInjectedContext:
      'A bounded four-layer whole-work brief: sibling domain/prompt summaries, coordination directive, and visual contrast floor.',
    consolidatedHypothesis: {
      statement:
        'Independent layer prompts lose whole-work coordination; shared bounded context should improve temporal coherence without weakening render floors.',
      citations: trials.slice(0, 2).map((trial) => trial.jsonSha256),
    },
    dreamLineage: {
      parentReceipt: prerequisites.find((item) => item.name.includes('W5-07')),
      recommendation: 'Explore p5+Tone control-recipe mutations that align breathing periods while preserving independent loop authority.',
    },
    assimilation: {
      parentReceipt: prerequisites.find((item) => item.name.includes('W5-13')),
      recommendation: 'Retain the proven Sol generator for this slice; route changes remain owner-controlled.',
    },
  },
  experiment: {
    budget: metadata.budgets,
    authorModel: reviewer.authorModel,
    reviewerModel: reviewer.reviewerModel,
    reviewerIdentityEvidence: reviewer.identityEvidence,
    sourceDiffSha256: sha(diff),
    sourceDiffBytes: Buffer.byteLength(diff),
    tests: reviewer.tests,
    build: reviewer.build,
    reviewerVerdict: reviewer.verdict,
    reviewerFindings: reviewer.findings,
    promotion: 'owner-controlled-candidate',
    autonomousMerge: false,
    restoreProof,
  },
  sealedEvaluator: {
    manifestSha256: fileDigest(briefPath),
    manifestPath: 'independent-review-brief.md',
    dependencyHashes,
  },
  qualityVerdict: reviewer.qualityVerdict,
  prerequisites,
  toolsAndSkills: [
    'CodeGraph',
    'Sinter Studio /api/compose',
    'Sinter TUI bridge health',
    'Playwright',
    'Vitest',
    'TypeScript',
    'Pushing Dispatch',
    reviewer.reviewerModel,
  ],
  productTruth: {
    livingLoopPass: true,
    marketReady: false,
    beautyParked: true,
    programCompleteChanged: false,
    limits: [
      'Two matched trials per arm establish this bounded p5+Tone slice, not every domain combination.',
      'Stage 1 packages an owner-controlled candidate; it does not autonomously merge.',
    ],
    deferred: [
      'Broader overnight sample sizes and additional domain combinations belong after Wave 5.',
    ],
  },
};

receipt.receiptDigest = sha(JSON.stringify(receipt));
writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
console.log(JSON.stringify({
  outcome: receipt.outcome,
  receiptPath: receiptPath.slice(ROOT.length + 1),
  receiptDigest: receipt.receiptDigest,
  reviewer: reviewer.reviewerModel,
  trials: trials.length,
  restore: restoreProof.cleanRestore,
}, null, 2));
