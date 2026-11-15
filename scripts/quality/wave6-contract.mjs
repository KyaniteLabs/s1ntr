import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  FORMAL_RUN_ORDER,
  WAVE6_LANE_DEFINITIONS,
  evaluateWave6Experiment,
} from '../../dist/quality/Wave6CreativeFlywheel.js';

const outputIndex = process.argv.indexOf('--output');
const outputPath = path.resolve(outputIndex >= 0
  ? process.argv[outputIndex + 1]
  : 'docs/agents/waves/receipts/wave-6-contract.json');
const digest = character => character.repeat(64);
const definition = WAVE6_LANE_DEFINITIONS['p5-tone'];
const fixture = {
  lane: 'p5-tone',
  lineageId: 'contract-lineage',
  recipeDigest: digest('a'),
  artifactRecipeDigest: digest('a'),
  lineageRecipeDigest: digest('a'),
  evaluationRecipeDigest: digest('a'),
  causalRecipeDigest: digest('a'),
  configurationDigest: digest('b'),
  mutationPath: definition.allowlist[0],
  identities: {
    author: 'verified/author',
    generator: 'verified/generator',
    mutationReviewer: 'verified/mutation-reviewer',
    creativeReviewer: 'verified/blind-reviewer',
  },
  runOrder: [...FORMAL_RUN_ORDER],
  pairs: [1, 2, 3].map(trial => ({
    trialId: String(trial),
    controlConfigurationDigest: digest('b'),
    treatmentConfigurationDigest: digest('b'),
    controlScore: 0.6,
    treatmentScore: 0.68,
    coordinationPass: trial < 3,
    technicalPass: true,
    blindPreference: trial < 3 ? 'treatment' : 'control',
  })),
  restoredFailure: {
    restored: true,
    quarantined: true,
    lane: 'p5-tone',
    lineageId: 'contract-lineage',
    allowlistDigest: definition.allowlistDigest,
    oracleDigest: digest('c'),
  },
  expectedOracleDigest: digest('c'),
  interventions: 1,
  creativeProofPass: true,
  cortexPass: true,
  lineageIntegrityPass: true,
  parentIntegrityPass: true,
  ownerDecision: 'treatment',
};

const pass = evaluateWave6Experiment(fixture);
assert.equal(pass.status, 'PASS');
const failClosedCases = [];
for (const [name, mutate] of [
  ['recipe-substitution', value => { value.causalRecipeDigest = digest('f'); }],
  ['configuration-substitution', value => { value.pairs[0].treatmentConfigurationDigest = digest('f'); }],
  ['run-reordering', value => { value.runOrder.reverse(); }],
  ['role-overlap', value => { value.identities.creativeReviewer = value.identities.author; }],
  ['case-role-overlap', value => {
    value.identities.creativeReviewer = value.identities.generator.toUpperCase();
  }],
  ['sealed-path-mutation', value => { value.mutationPath = 'src/evaluation/CompositionEvaluator.ts'; }],
  ['foreign-restore', value => { value.restoredFailure.lineageId = 'foreign'; }],
  ['tie-counted-as-win', value => {
    value.pairs[0].blindPreference = 'tie';
    value.pairs[1].blindPreference = 'tie';
  }],
]) {
  const adversarial = structuredClone(fixture);
  mutate(adversarial);
  assert.equal(evaluateWave6Experiment(adversarial).status, 'FAIL', name);
  failClosedCases.push(name);
}
const pendingOwner = structuredClone(fixture);
delete pendingOwner.ownerDecision;
assert.equal(evaluateWave6Experiment(pendingOwner).status, 'PENDING_OWNER');

const receipt = {
  schemaVersion: 1,
  gate: 'W6-CONTRACT',
  generatedAt: new Date().toISOString(),
  outcome: 'PASS',
  lanes: WAVE6_LANE_DEFINITIONS,
  formalRunOrder: FORMAL_RUN_ORDER,
  minimumMeanEffect: 0.05,
  minimumBlindWins: 2,
  minimumCoordinationPasses: 2,
  maximumInterventions: 2,
  maximumRereviewsPerIntervention: 1,
  failClosedCases,
  ownerUnavailableStatus: 'PENDING_OWNER',
};
await fs.mkdir(path.dirname(outputPath), { recursive: true });
await fs.writeFile(outputPath, `${JSON.stringify(receipt, null, 2)}\n`);
process.stdout.write(`${JSON.stringify({
  ok: true,
  outcome: receipt.outcome,
  laneCount: Object.keys(receipt.lanes).length,
  failClosedCases: failClosedCases.length,
  outputPath,
}, null, 2)}\n`);
