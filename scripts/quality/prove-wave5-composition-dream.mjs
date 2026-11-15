import assert from 'node:assert/strict';
import { readFile, writeFile, rm } from 'node:fs/promises';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  CONTROL_RECIPE_SCHEMA,
  CONTROL_RECIPE_VERSION,
  COMPOSITION_EVIDENCE_DIMENSIONS,
  CompositionDreamCognitiveAdapter,
  DreamQueue,
  createCompositionDreamGateReceipt,
  parseCompositionEvaluationGateReceipt,
  runNextCompositionDream,
} from '../../dist/index.js';
import { PostGenerationCognitiveWriter } from '../../dist/tui-bridge/PostGenerationCognitiveWriter.js';
import { StudioLineageLedger } from '../../dist/tui-bridge/StudioLineage.js';

const prerequisite = parseCompositionEvaluationGateReceipt(JSON.parse(await readFile(
  new URL('../../docs/agents/waves/receipts/wave-5-W5-06-composition-evaluation.json', import.meta.url),
  'utf8',
)));
const root = await mkdtemp(path.join(os.tmpdir(), 'w5-07-proof-'));
const queue = new DreamQueue({ persistPath: path.join(root, 'queue.json') });
const lineage = new StudioLineageLedger({ ledgerPath: path.join(root, 'lineage.jsonl') });
const cognitiveCalls = { memory: 0, compost: 0, dreaming: 0 };
const memory = {
  async initialize() {},
  async getRelevantEpisodesByDomain() { return []; },
  recordEpisode() {
    cognitiveCalls.memory += 1;
    return `episode-${cognitiveCalls.memory}`;
  },
  async save() { return { isErr: () => false }; },
};
const writer = new PostGenerationCognitiveWriter({
  memory,
  compost: {
    async add() { cognitiveCalls.compost += 1; },
  },
  dreamQueue: {
    enqueue() {
      cognitiveCalls.dreaming += 1;
      return `next-dream-${cognitiveCalls.dreaming}`;
    },
  },
  artifactRoot: path.join(root, 'artifacts'),
  lineageLedger: lineage,
});
const cognitive = new CompositionDreamCognitiveAdapter(writer, lineage);
const recipe = {
  schema: CONTROL_RECIPE_SCHEMA,
  schemaVersion: CONTROL_RECIPE_VERSION,
  id: 'tone-p5-dream-parent',
  layers: [
    {
      id: 'sound',
      domain: 'tone',
      code: 'api.register("sound", { start() {}, readSignal() { return 0.8; }, releaseResource() {} });',
      order: 0,
    },
    {
      id: 'visual',
      domain: 'p5',
      code: 'api.register("visual", { start() {}, writeTarget() {}, releaseResource() {} });',
      order: 1,
    },
  ],
  transport: {
    clock: 'interval',
    cadenceMs: 20,
    bufferSize: 2,
    staleAfterMs: 40,
    staleBehavior: 'error',
  },
  signals: [{ id: 'amplitude', layerId: 'sound', type: 'number' }],
  targets: [{ id: 'radius', layerId: 'visual', type: 'number' }],
  mappings: [{
    id: 'amplitude-radius',
    signalId: 'amplitude',
    targetId: 'radius',
    scale: 100,
    offset: 10,
  }],
  resources: [
    { id: 'tone-context', kind: 'audio-context', ownerLayerId: 'sound' },
    { id: 'p5-canvas', kind: 'canvas', ownerLayerId: 'visual' },
  ],
  lifecycle: {
    startOrder: ['sound', 'visual'],
    teardownOrder: ['visual', 'sound'],
  },
  audio: { unlock: 'user-gesture', ownerLayerId: 'sound' },
  lineage: { parentRecipeIds: ['w5-05'], createdAt: '2026-07-30T00:00:00.000Z' },
};
const provenance = {
  lineageId: 'w5-07-composition-dream',
  sourceDigest: prerequisite.receiptDigest,
  origin: 'wave5-proof-dream',
  trust: 'model-inference',
  taint: 'tainted',
  taintSources: ['generated-parent-recipe'],
  corroboration: ['W5-06'],
};
const evidenceValues = {
  technical: [0.9, 0.5, 'ratio'],
  creative: [0.8, 0.6, 'ratio'],
  taste: [0.8, 0.6, 'ratio'],
  cost: [1, 2, 'attempts'],
  latency: [1, 100, 'ms'],
  reliability: [1, 0.9, 'ratio'],
  security: [1, 1, 'guarded-mutations'],
  complexity: [3, 4, 'mutation-kinds'],
};
function attempt(candidate) {
  const mapping = candidate.mappings[0];
  const whole = good => ({
    coherence: good ? 0.9 : 0.2,
    technicalValidity: 0.9,
    creativeQuality: good ? 0.8 : 0.2,
    tasteQuality: good ? 0.8 : 0.2,
  });
  return {
    id: 'render-mutate-ablate',
    method: 'standalone-artifact-render',
    status: 'complete',
    mappingId: mapping.id,
    layers: candidate.layers.map(layer => ({
      layerId: layer.id,
      technicalValidity: 0.9,
      contribution: 0.8,
      compatibility: 0.9,
      necessity: 0.8,
    })),
    trials: [
      {
        condition: 'baseline',
        signalValue: 0.8,
        targetValue: 0.8 * mapping.scale + mapping.offset,
        signalUnit: 'normalized-amplitude',
        targetUnit: 'px',
        whole: whole(true),
      },
      {
        condition: 'signal-mutation',
        signalValue: 0.1,
        targetValue: 0.1 * mapping.scale + mapping.offset,
        signalUnit: 'normalized-amplitude',
        targetUnit: 'px',
        whole: whole(false),
      },
      {
        condition: 'coupling-ablation',
        signalValue: 0.8,
        targetValue: mapping.offset,
        signalUnit: 'normalized-amplitude',
        targetUnit: 'px',
        whole: whole(false),
      },
    ],
    evidence: COMPOSITION_EVIDENCE_DIMENSIONS.map(dimension => ({
      dimension,
      status: 'observed',
      value: evidenceValues[dimension][0],
      unit: evidenceValues[dimension][2],
      direction: ['cost', 'latency', 'complexity'].includes(dimension)
        ? 'lower-better'
        : 'higher-better',
      baseline: evidenceValues[dimension][1],
      sourceRef: `w5-07-proof:${dimension}`,
    })),
  };
}

await lineage.start({
  lineageId: provenance.lineageId,
  sessionId: 'w5-07-proof-session',
  origin: 'wave5-proof-owner',
});
queue.enqueueComposition(
  {
    parentRecipe: recipe,
    mutation: { kind: 'mapping', mappingId: 'amplitude-radius', scale: 120 },
    provenance,
  },
  [{ id: recipe.id, descriptor: [0.8, 0.7], quality: 0.9 }],
  0.9,
);
const admittedRun = await runNextCompositionDream(
  queue,
  async candidate => [attempt(candidate)],
  cognitive,
);
assert.equal(admittedRun.record.verdict, 'admitted');
queue.enqueueComposition(
  {
    parentRecipe: recipe,
    mutation: { kind: 'mapping', mappingId: 'missing-mapping', scale: 120 },
    provenance,
  },
  [{ id: recipe.id, descriptor: [0.8, 0.7], quality: 0.9 }],
  0.8,
);
await assert.rejects(
  runNextCompositionDream(queue, async candidate => [attempt(candidate)], cognitive),
  /Unknown mapping/,
);
const failed = queue.getTasks('failed')[0].result.failure;
assert.equal(failed.reason, 'Unknown mapping missing-mapping');
assert.deepEqual(cognitiveCalls, { memory: 2, compost: 2, dreaming: 2 });

const sanitizeReceipts = receipts => receipts.map(receipt => ({
  ...receipt,
  detail: receipt.detail.replaceAll(root, '$PROOF_ROOT'),
}));
const admitted = {
  ...admittedRun.record,
  cognitiveReceipts: sanitizeReceipts(admittedRun.record.cognitiveReceipts),
};
const sanitizedFailure = {
  ...failed,
  cognitiveReceipts: sanitizeReceipts(failed.cognitiveReceipts),
};
const receipt = createCompositionDreamGateReceipt({
  generatedAt: new Date().toISOString(),
  prerequisite,
  admitted,
  failed: sanitizedFailure,
  evidenceRefs: [
    'queue:w5-07-composition-dream',
    'lineage:w5-07-composition-dream',
    'test:CompositionDreamRunner',
    'test:CompositionDreamCognitiveAdapter',
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
