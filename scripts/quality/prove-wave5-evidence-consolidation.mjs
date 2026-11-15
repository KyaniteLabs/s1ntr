import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import {
  EvidenceConsolidationCoordinator,
  createEvidenceConsolidationGateReceipt,
  parseMemoryFeedForwardGateReceipt,
} from '../../dist/index.js';

const prerequisite = parseMemoryFeedForwardGateReceipt(JSON.parse(await readFile(
  new URL('../../docs/agents/waves/receipts/wave-5-W5-03-memory-feed-forward.json', import.meta.url),
  'utf8',
)));
const now = new Date('2026-07-30T12:00:00.000Z');
const claim = 'Explicit slow-motion cadence improves calming p5 outputs';
const falsifier = 'Reject if blinded quality fails to improve by 0.05 over baseline';
const evidence = (id, source, overrides = {}) => ({
  id,
  hypothesisKey: 'p5:calming:slow-cadence',
  claim,
  falsifier,
  source,
  sourceRef: `${source}:${id}`,
  lineageId: `lineage:${id}`,
  stance: 'support',
  confidence: 0.85,
  observedAt: '2026-07-30T11:00:00.000Z',
  trust: 'verified-system',
  taint: 'clean',
  ...overrides,
});

const coordinator = new EvidenceConsolidationCoordinator({
  retryDelayMs: 1_000,
});
const sources = [
  'memory', 'archive', 'taste', 'compost', 'pattern', 'dream', 'operational',
];
const readyInput = sources.map((source, index) =>
  evidence(`${source}-${index}`, source));
readyInput.push(evidence('quoted-disagreement', 'compost', {
  stance: 'contradict',
  confidence: 0.05,
  trust: 'untrusted-external',
  taint: 'tainted',
}));
const inputSnapshot = structuredClone(readyInput);
const readyResult = coordinator.consolidate([
  ...readyInput,
  structuredClone(readyInput[0]),
], now);
assert.equal(readyResult.hypotheses[0].status, 'ready');
assert.equal(readyResult.duplicateEvidence, 1);
assert.deepEqual(readyInput, inputSnapshot);

const taintedSupport = coordinator.consolidate([
  evidence('clean-memory', 'memory'),
  evidence('tainted-archive', 'archive', { taint: 'tainted' }),
], now).hypotheses[0];
assert.equal(taintedSupport.status, 'insufficient');
assert.deepEqual(taintedSupport.corroboratingSources, ['memory']);

const externalSupport = coordinator.consolidate([
  evidence('clean-owner', 'memory', { trust: 'owner', confidence: 1 }),
  evidence('external-quote', 'compost', {
    trust: 'untrusted-external',
    confidence: 1,
  }),
], now).hypotheses[0];
assert.equal(externalSupport.status, 'insufficient');
assert.deepEqual(externalSupport.corroboratingSources, ['memory']);

const contradicted = coordinator.consolidate([
  evidence('support-memory', 'memory', { confidence: 0.5 }),
  evidence('support-taste', 'taste', { confidence: 0.5 }),
  evidence('contradict-owner', 'operational', {
    stance: 'contradict',
    confidence: 1,
    trust: 'owner',
  }),
  evidence('contradict-system', 'archive', {
    stance: 'contradict',
    confidence: 1,
  }),
], now).hypotheses[0];
assert.equal(contradicted.status, 'contradicted');

const aged = coordinator.consolidate([
  evidence('aged-memory', 'memory', { observedAt: '2026-05-01T00:00:00.000Z' }),
  evidence('aged-taste', 'taste', { observedAt: '2026-05-01T00:00:00.000Z' }),
], now).hypotheses[0];
assert.equal(aged.status, 'insufficient');

const retry = coordinator.consolidate([
  evidence('retry-operational', 'operational', {
    retryOwner: 'consolidate-loop',
    retryAttempt: 0,
  }),
], now).hypotheses[0];
assert.equal(retry.status, 'retry');
assert.equal(retry.retry.attempt, 1);

const emptyHypothesisCount = coordinator.consolidate([], now).hypotheses.length;
assert.equal(emptyHypothesisCount, 0);
assert.equal(readyResult.hypotheses[0].citations.some(
  item => item.source === 'composition',
), false);

const receipt = createEvidenceConsolidationGateReceipt({
  generatedAt: new Date().toISOString(),
  prerequisite,
  ready: readyResult.hypotheses[0],
  contradicted,
  retry,
  aged,
  emptyHypothesisCount,
  evidenceRefs: [
    'test:EvidenceConsolidationCoordinator',
    'integration:MemoryConsolidator.consolidateEvidence',
    'receipt:wave-5-W5-03-memory-feed-forward',
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
