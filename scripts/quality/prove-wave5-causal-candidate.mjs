import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  createCausalCandidateGateReceipt,
  fingerprintTrialConfiguration,
  packageOwnerControlledCandidate,
  parseCausalCandidateGateReceipt,
  parseCompositionEvaluationGateReceipt,
  parseOwnerControlledCandidate,
  parseSealedReviewGateReceipt,
} from '../../dist/index.js';

const outputIndex = process.argv.indexOf('--output');
const outputPath = outputIndex >= 0
  ? path.resolve(process.argv[outputIndex + 1])
  : path.resolve('docs/agents/waves/receipts/wave-5-W5-11-causal-candidate.json');
const readReceipt = async name => JSON.parse(await fs.readFile(path.resolve(
  `docs/agents/waves/receipts/${name}`,
), 'utf8'));
const composition = parseCompositionEvaluationGateReceipt(await readReceipt(
  'wave-5-W5-06-composition-evaluation.json',
));
const sealedReview = parseSealedReviewGateReceipt(await readReceipt(
  'wave-5-W5-10-sealed-review.json',
));
const digest = value => createHash('sha256')
  .update(typeof value === 'string' ? value : JSON.stringify(value))
  .digest('hex');
const stable = value => {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key =>
      `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
};
const sealedDigest = value => createHash('sha256').update(stable(value)).digest('hex');

const configuration = {
  intentDigest: digest('calming layered p5+tone intent'),
  provider: 'fixture-generator',
  model: 'generator-a',
  promptDigest: digest('frozen prompt'),
  parametersDigest: digest({ temperature: 1, maxTokens: 4096 }),
  capabilitiesDigest: digest(['p5', 'tone', 'composition']),
  evaluatorDigest: sealedReview.manifestDigest,
  environmentDigest: digest({ runtime: 'fixture', version: 1 }),
  seedSupported: true,
};
const configurationDigest = fingerprintTrialConfiguration(configuration);
const decisionRule = {
  objective: 'quality',
  direction: 'higher-better',
  minimumEffect: 0.05,
  minimumTrials: 5,
  hardFloors: {
    technical: { minimum: 0.8 },
    coherence: { minimum: 0.75 },
  },
};
const controlQuality = [0.61, 0.64, 0.6, 0.66, 0.63];
const treatmentQuality = [0.72, 0.73, 0.69, 0.78, 0.71];
const trials = controlQuality.map((quality, index) => ({
  trialId: `matched-${index + 1}`,
  seed: `seed-${index + 1}`,
  controlConfigurationDigest: configurationDigest,
  treatmentConfigurationDigest: configurationDigest,
  controlArtifactDigest: digest(`control-${index}`),
  treatmentArtifactDigest: digest(`treatment-${index}`),
  controlMetrics: {
    quality,
    technical: 0.85 + index * 0.01,
    coherence: 0.78 + index * 0.01,
  },
  treatmentMetrics: {
    quality: treatmentQuality[index],
    technical: 0.86 + index * 0.01,
    coherence: 0.8 + index * 0.01,
  },
}));
const baseInput = {
  contract: {
    version: 1,
    loop: 'autoresearch',
    experimentId: sealedReview.approved.experiment.experimentId,
    lineageId: sealedReview.approved.experiment.lineageId,
    state: 'observe',
    stage: 'shadow',
    sourceMutationRequested: true,
    budgets: sealedReview.prerequisite.budgets,
  },
  candidate: sealedReview.approved,
  restoredFailure: sealedReview.vetoed,
  configuration,
  decisionRule,
  trials,
  diff: {
    paths: sealedReview.approved.experiment.changedPaths,
    digest: digest(sealedReview.approved.experiment.changedPaths),
  },
  verificationRefs: ['test:build', 'test:focused', 'test:artifact-evaluator'],
  artifactComparisonRefs: ['artifact:control-set', 'artifact:treatment-set'],
};
const candidate = packageOwnerControlledCandidate(baseInput);
parseOwnerControlledCandidate(candidate);
assert.equal(candidate.status, 'awaiting-owner');
assert.equal(candidate.analysis.improved, true);
assert.equal(candidate.analysis.hardFloorsPass, true);
assert.equal(candidate.analysis.trialEffects.length, 5);
assert.ok(Number.isFinite(candidate.analysis.sampleVariance));

const failClosedCases = [];
const expectFail = (name, mutate) => {
  const input = structuredClone(baseInput);
  mutate(input);
  assert.throws(() => packageOwnerControlledCandidate(input));
  failClosedCases.push(name);
};
expectFail('insufficient-effect', input => {
  for (const trial of input.trials) {
    trial.treatmentMetrics.quality = trial.controlMetrics.quality;
  }
});
expectFail('hard-floor', input => {
  input.trials[0].treatmentMetrics.technical = 0.1;
});
expectFail('insufficient-trials', input => {
  input.trials.splice(2);
});
expectFail('missing-seed', input => {
  delete input.trials[0].seed;
});
expectFail('unknown-identity', input => {
  input.configuration.model = '';
});
expectFail('missing-restore', input => {
  input.restoredFailure.experiment.terminal = 'candidate';
});
expectFail('configuration-mismatch', input => {
  input.trials[0].treatmentConfigurationDigest = digest('different-configuration');
});

const gateFailures = [];
const expectGateFail = (name, mutate) => {
  const input = structuredClone(baseInput);
  mutate(input);
  const forgedCandidate = packageOwnerControlledCandidate(input);
  const gate = createCausalCandidateGateReceipt({
    generatedAt: '2026-07-30T00:00:00.000Z',
    prerequisites: { composition, sealedReview },
    candidate: forgedCandidate,
    failClosedCases: [...failClosedCases, name],
    evidenceRefs: ['fixture:adversarial-binding'],
  });
  assert.equal(gate.outcome, 'FAIL');
  gateFailures.push(name);
};
expectGateFail('authority-decoupling', input => {
  input.candidate.review.author.provider = 'forged-provider';
  const { receiptDigest: _discard, ...unsigned } = input.candidate.review;
  input.candidate.review.receiptDigest = sealedDigest(unsigned);
});
expectGateFail('diff-decoupling', input => {
  input.candidate.experiment.changedPaths = ['src/forged.ts'];
  input.diff.paths = ['src/forged.ts'];
  input.diff.digest = digest(input.diff.paths);
});
failClosedCases.push(...gateFailures);

const receipt = createCausalCandidateGateReceipt({
  generatedAt: '2026-07-30T00:00:00.000Z',
  prerequisites: { composition, sealedReview },
  candidate,
  failClosedCases,
  evidenceRefs: [
    'receipt:wave-5-W5-06-composition-evaluation',
    'receipt:wave-5-W5-10-sealed-review',
    'fixture:matched-repeated-trials',
    'fixture:owner-controlled-candidate',
  ],
});
assert.equal(receipt.outcome, 'PASS');
assert.equal(Object.values(receipt.checks).every(Boolean), true);
parseCausalCandidateGateReceipt(receipt);
const tampered = structuredClone(receipt);
tampered.candidate.analysis.meanEffect = 999;
assert.throws(() => parseCausalCandidateGateReceipt(tampered));
await fs.mkdir(path.dirname(outputPath), { recursive: true });
await fs.writeFile(outputPath, `${JSON.stringify(receipt, null, 2)}\n`);
process.stdout.write(`${JSON.stringify({
  ok: true,
  gate: receipt.gate,
  outcome: receipt.outcome,
  checkCount: Object.keys(receipt.checks).length,
  meanEffect: candidate.analysis.meanEffect,
  sampleVariance: candidate.analysis.sampleVariance,
  receiptDigest: receipt.receiptDigest,
  outputPath,
}, null, 2)}\n`);
