import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createDomainIncubationGateReceipt,
  DomainIncubatorStore,
  evaluateDomainIncubator,
  parseCausalCandidateGateReceipt,
  parseCompositionDreamGateReceipt,
  parseDomainIncubationGateReceipt,
  parseDomainIncubationRecommendation,
  parseEvidenceConsolidationGateReceipt,
  recommendDomainIncubation,
} from '../../dist/index.js';

const outputIndex = process.argv.indexOf('--output');
const outputPath = outputIndex >= 0
  ? path.resolve(process.argv[outputIndex + 1])
  : path.resolve('docs/agents/waves/receipts/wave-5-W5-12-domain-incubator.json');
const readReceipt = async name => JSON.parse(await fs.readFile(path.resolve(
  `docs/agents/waves/receipts/${name}`,
), 'utf8'));
const dream = parseCompositionDreamGateReceipt(await readReceipt(
  'wave-5-W5-07-composition-dream.json',
));
const consolidation = parseEvidenceConsolidationGateReceipt(await readReceipt(
  'wave-5-W5-08-evidence-consolidation.json',
));
const causal = parseCausalCandidateGateReceipt(await readReceipt(
  'wave-5-W5-11-causal-candidate.json',
));
const sha256 = value => createHash('sha256').update(value).digest('hex');

const baseInput = {
  slug: 'adaptive-slow-cadence',
  displayName: 'Adaptive Slow Cadence',
  kind: 'composition-primitive',
  rationale: [
    'The admitted Tone+p5 composition has a fixed 20ms clock, while consolidated',
    'evidence says explicit slow cadence improves calming p5 work. Incubate a',
    'shared intent-aware cadence primitive before adding it to active routing.',
  ].join(' '),
  ownerConfirmed: false,
  signals: [
    {
      id: 'creative-dream',
      kind: 'creative',
      capabilityKey: 'adaptive-slow-cadence',
      claim: 'Tone+p5 layering is admitted but uses a fixed interval cadence.',
      evidenceRef: `receipt:W5-07:${dream.receiptDigest}`,
      lineageId: dream.admitted.recipe.id,
    },
    {
      id: 'evaluation-coupling',
      kind: 'evaluation',
      capabilityKey: 'adaptive-slow-cadence',
      claim: 'Whole-composition quality depends on the cross-layer mapping.',
      evidenceRef: dream.admitted.evaluation.evidence[1].sourceRef,
      lineageId: dream.admitted.recipe.id,
    },
    {
      id: 'consolidated-slow-cadence',
      kind: 'consolidation',
      capabilityKey: 'adaptive-slow-cadence',
      claim: consolidation.ready.claim,
      evidenceRef: `receipt:W5-08:${consolidation.receiptDigest}`,
      lineageId: consolidation.ready.citations[0].lineageId,
    },
    {
      id: 'causal-floor',
      kind: 'causal',
      capabilityKey: 'adaptive-slow-cadence',
      claim: 'Candidate comparisons must beat the declared quality effect and floors.',
      evidenceRef: `receipt:W5-11:${causal.receiptDigest}`,
      lineageId: causal.candidate.lineageId,
    },
  ],
  specification: {
    routing: [
      'Only explicit calming + layered audio/visual requests may select the incubator.',
    ],
    generation: [
      'Emit a versioned transport contract shared by Tone and p5 layers.',
    ],
    evaluation: [
      'Compare fixed and adaptive cadence with coupling mutation and ablation.',
      'Require W5-11 quality effect and technical/coherence hard floors.',
    ],
    persistence: [
      'Persist recommendation and evaluation in an isolated candidate directory.',
    ],
    documentation: [
      'Document routing cues, transport ownership, teardown, and rejection behavior.',
    ],
    rejectionTests: [
      'reject-cadence-that-breaks-audio-visual-coupling',
      'reject-cadence-without-quality-effect',
    ],
  },
};

const recommendation = recommendDomainIncubation(baseInput);
parseDomainIncubationRecommendation(recommendation);
assert.equal(recommendation.promotion, 'forbidden');
const generatedArtifact = [
  'transport: adaptive-slow-cadence@1',
  'layers: tone,p5',
  'cadence: intent-derived',
].join('\n');
const generatedArtifactDigest = sha256(generatedArtifact);

const strongProof = {
  candidateId: recommendation.candidateId,
  routing: {
    capabilityKey: recommendation.slug,
    selectedCandidateId: recommendation.candidateId,
    evidenceRef: 'proof:explicit-layered-calming-route',
  },
  generation: {
    artifactDigest: generatedArtifactDigest,
    runnable: true,
    evidenceRef: 'proof:versioned-transport-artifact',
  },
  evaluation: {
    artifactDigest: generatedArtifactDigest,
    hardFloorsPass: true,
    evidenceRef: 'proof:paired-causal-evaluation',
  },
  persistence: {
    recordDigest: recommendation.receiptDigest,
    roundTrip: true,
    evidenceRef: 'proof:isolated-store-round-trip',
  },
  documentation: {
    candidateId: recommendation.candidateId,
    complete: true,
    evidenceRef: 'docs:adaptive-slow-cadence',
  },
  rejectionTests: baseInput.specification.rejectionTests.map(name => ({
    name,
    passed: true,
  })),
};
const accepted = evaluateDomainIncubator(recommendation, strongProof);
assert.equal(accepted.status, 'ready-for-owner-review');
assert.equal(accepted.promotion, 'forbidden');

const weakProof = structuredClone(strongProof);
weakProof.evaluation.hardFloorsPass = false;
weakProof.evaluation.evidenceRef = 'proof:hard-floor-regression';
const rejected = evaluateDomainIncubator(recommendation, weakProof);
assert.equal(rejected.status, 'rejected');
assert.deepEqual(rejected.rejectionReasons, ['evaluation']);

const storeRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'w5-domain-incubator-'));
let persistedRoundTrip = false;
try {
  const store = new DomainIncubatorStore(storeRoot);
  await store.save(recommendation);
  await store.save(accepted);
  const loadedRecommendation = await store.load(recommendation.candidateId, 'recommended');
  const loadedAccepted = await store.load(recommendation.candidateId, accepted.status);
  persistedRoundTrip = JSON.stringify(loadedRecommendation) === JSON.stringify(recommendation)
    && JSON.stringify(loadedAccepted) === JSON.stringify(accepted);
} finally {
  await fs.rm(storeRoot, { recursive: true, force: true });
}
assert.equal(persistedRoundTrip, true);

const failClosedCases = [];
const expectRecommendationFail = (name, mutate) => {
  const input = structuredClone(baseInput);
  mutate(input);
  assert.throws(() => recommendDomainIncubation(input));
  failClosedCases.push(name);
};
expectRecommendationFail('missing-evidence-organ', input => {
  input.signals = input.signals.filter(signal => signal.kind !== 'causal');
});
expectRecommendationFail('missing-rejection-tests', input => {
  input.specification.rejectionTests = [];
});
const mismatchedProof = structuredClone(strongProof);
mismatchedProof.candidateId = 'incubator:different-candidate:aaaaaaaaaaaa';
assert.equal(
  evaluateDomainIncubator(recommendation, mismatchedProof).status,
  'rejected',
);
failClosedCases.push('candidate-mismatch');
assert.equal(rejected.status, 'rejected');
failClosedCases.push('weak-candidate');
const promoted = structuredClone(recommendation);
promoted.promotion = 'allowed';
assert.throws(() => parseDomainIncubationRecommendation(promoted));
failClosedCases.push('promotion-attempt');

const receipt = createDomainIncubationGateReceipt({
  generatedAt: '2026-07-30T00:00:00.000Z',
  prerequisites: { dream, consolidation, causal },
  recommendation,
  accepted,
  rejected,
  persistedRoundTrip,
  failClosedCases,
  evidenceRefs: recommendation.signals.map(signal => signal.evidenceRef),
});
assert.equal(receipt.outcome, 'PASS');
assert.equal(Object.values(receipt.checks).every(Boolean), true);
parseDomainIncubationGateReceipt(receipt);
const tampered = structuredClone(receipt);
tampered.accepted.promotion = 'allowed';
assert.throws(() => parseDomainIncubationGateReceipt(tampered));

await fs.mkdir(path.dirname(outputPath), { recursive: true });
await fs.writeFile(outputPath, `${JSON.stringify(receipt, null, 2)}\n`);
process.stdout.write(`${JSON.stringify({
  ok: true,
  gate: receipt.gate,
  outcome: receipt.outcome,
  checkCount: Object.keys(receipt.checks).length,
  candidateId: recommendation.candidateId,
  acceptedStatus: accepted.status,
  rejectedStatus: rejected.status,
  promotion: accepted.promotion,
  receiptDigest: receipt.receiptDigest,
  outputPath,
}, null, 2)}\n`);
