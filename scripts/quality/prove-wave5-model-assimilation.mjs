import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  ASSIMILATION_ROLES,
  assimilateModelsByRole,
  createModelAssimilationGateReceipt,
  fingerprintAuditionSlice,
  parseCausalCandidateGateReceipt,
  parseCompositionEvaluationGateReceipt,
  parseModelAssimilationGateReceipt,
  parseRoleModelAssimilationReport,
  parseSealedReviewGateReceipt,
} from '../../dist/index.js';

const outputIndex = process.argv.indexOf('--output');
const outputPath = outputIndex >= 0
  ? path.resolve(process.argv[outputIndex + 1])
  : path.resolve('docs/agents/waves/receipts/wave-5-W5-13-model-assimilation.json');
const readReceipt = async name => JSON.parse(await fs.readFile(path.resolve(
  `docs/agents/waves/receipts/${name}`,
), 'utf8'));
const composition = parseCompositionEvaluationGateReceipt(await readReceipt(
  'wave-5-W5-06-composition-evaluation.json',
));
const sealedReview = parseSealedReviewGateReceipt(await readReceipt(
  'wave-5-W5-10-sealed-review.json',
));
const causal = parseCausalCandidateGateReceipt(await readReceipt(
  'wave-5-W5-11-causal-candidate.json',
));
const sha256 = value => createHash('sha256').update(
  typeof value === 'string' ? value : JSON.stringify(value),
).digest('hex');

const evaluatorIdentity = {
  provider: 'fixture-judge',
  model: 'sealed-evaluator',
  verified: true,
  source: 'api',
};
const decisionRule = {
  objective: 'quality',
  minimumEffect: 0.05,
  minimumTrialsPerRole: 2,
  hardFloors: {
    technical: 0.8,
    roleFit: 0.75,
  },
};
const makeSlice = (role, trial) => ({
  role,
  domain: 'p5',
  composition: 'tone+p5',
  promptDigest: sha256(`equivalent-${role}-prompt-${trial}`),
  budgetDigest: sha256({ maxTokens: 4096, maxCostUsd: 0.2 }),
  capabilitiesDigest: sha256(['tools', 'p5', 'tone', 'composition']),
  evaluatorDigest: sealedReview.manifestDigest,
  environmentDigest: sha256({ runtime: 'fixture', version: 1 }),
  evaluatorIdentity,
});

const makeAudition = (role, trial, identity, quality) => {
  const slice = makeSlice(role, trial);
  const configurationDigest = fingerprintAuditionSlice(slice);
  return {
    trialId: `${role}-${identity.model ?? 'unknown'}-${trial}`,
    slice,
    baseline: {
      configurationDigest,
      identity: {
        provider: 'fixture-baseline',
        model: `baseline-${role}`,
        verified: true,
        source: 'api',
      },
      artifactDigest: sha256(`baseline:${role}:${trial}`),
      receiptRef: `fixture:baseline:${role}:${trial}`,
      metrics: { quality: 0.7, technical: 0.9, roleFit: 0.85 },
    },
    challenger: {
      configurationDigest,
      identity,
      artifactDigest: sha256(`challenger:${role}:${identity.model}:${trial}`),
      receiptRef: `fixture:challenger:${role}:${trial}`,
      metrics: { quality, technical: 0.91, roleFit: 0.88 },
    },
  };
};

const auditions = [];
for (const role of ASSIMILATION_ROLES) {
  const identity = {
    provider: 'fixture-challenger',
    model: `challenger-${role}`,
    verified: true,
    source: 'api',
  };
  auditions.push(makeAudition(role, 1, identity, 0.81));
  auditions.push(makeAudition(role, 2, identity, 0.8));
}
const unknownIdentity = {
  provider: null,
  model: null,
  verified: false,
  source: 'unknown',
};
auditions.push(makeAudition('generator', 1, unknownIdentity, 0.95));
auditions.push(makeAudition('generator', 2, unknownIdentity, 0.96));

const baseInput = { decisionRule, auditions };
const report = assimilateModelsByRole(baseInput);
parseRoleModelAssimilationReport(report);
assert.equal(report.routeMutation, 'forbidden');
assert.equal(
  report.recommendations.filter(item => item.status === 'recommended').length,
  ASSIMILATION_ROLES.length,
);
const unknown = report.recommendations.find(item => item.status === 'unknown-identity');
assert.equal(unknown.challenger.provider, null);
assert.equal(unknown.challenger.model, null);
assert.equal(unknown.allowedAction, 'none');

const failClosedCases = [];
const expectFail = (name, mutate) => {
  const input = structuredClone(baseInput);
  mutate(input);
  assert.throws(() => assimilateModelsByRole(input));
  failClosedCases.push(name);
};
expectFail('configuration-mismatch', input => {
  input.auditions[0].challenger.configurationDigest = sha256('different');
});
expectFail('missing-identity', input => {
  input.auditions[0].challenger.identity.provider = null;
});

const reputationOnly = structuredClone(baseInput);
for (const audition of reputationOnly.auditions) {
  if (audition.challenger.identity.model === 'challenger-companion') {
    audition.challenger.metrics.quality = audition.baseline.metrics.quality;
    audition.challenger.reputationScore = 1;
  }
}
const reputationReport = assimilateModelsByRole(reputationOnly);
assert.equal(
  reputationReport.recommendations.find(item => item.role === 'companion').status,
  'retain-baseline',
);
failClosedCases.push('reputation-only', 'weak-challenger');
const routeMutated = structuredClone(report);
routeMutated.routeMutation = 'allowed';
assert.throws(() => parseRoleModelAssimilationReport(routeMutated));
failClosedCases.push('route-mutation');

const receipt = createModelAssimilationGateReceipt({
  generatedAt: '2026-07-30T00:00:00.000Z',
  prerequisites: { composition, sealedReview, causal },
  report,
  failClosedCases,
  evidenceRefs: [
    `receipt:W5-06:${composition.receiptDigest}`,
    `receipt:W5-10:${sealedReview.receiptDigest}`,
    `receipt:W5-11:${causal.receiptDigest}`,
    'fixture:matched-role-domain-composition-auditions',
  ],
});
assert.equal(receipt.outcome, 'PASS');
assert.equal(Object.values(receipt.checks).every(Boolean), true);
parseModelAssimilationGateReceipt(receipt);
const tampered = structuredClone(receipt);
tampered.report.recommendations[0].meanEffect = 99;
assert.throws(() => parseModelAssimilationGateReceipt(tampered));

await fs.mkdir(path.dirname(outputPath), { recursive: true });
await fs.writeFile(outputPath, `${JSON.stringify(receipt, null, 2)}\n`);
process.stdout.write(`${JSON.stringify({
  ok: true,
  gate: receipt.gate,
  outcome: receipt.outcome,
  checkCount: Object.keys(receipt.checks).length,
  roles: ASSIMILATION_ROLES.length,
  recommendations: report.recommendations.length,
  unknownIdentityStatus: unknown.status,
  routeMutation: report.routeMutation,
  receiptDigest: receipt.receiptDigest,
  outputPath,
}, null, 2)}\n`);
