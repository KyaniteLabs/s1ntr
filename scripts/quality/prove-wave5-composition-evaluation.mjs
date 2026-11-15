import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import {
  COMPOSITION_EVIDENCE_DIMENSIONS,
  CompositionEvaluator,
} from '../../dist/evaluation/index.js';
import {
  CONTROL_RECIPE_SCHEMA,
  CONTROL_RECIPE_VERSION,
} from '../../dist/composition/index.js';
import {
  createCompositionEvaluationGateReceipt,
  parseMemoryFeedForwardGateReceipt,
} from '../../dist/runtime-core/Wave5GateReceipt.js';

const prerequisite = parseMemoryFeedForwardGateReceipt(JSON.parse(await readFile(
  new URL('../../docs/agents/waves/receipts/wave-5-W5-03-memory-feed-forward.json', import.meta.url),
  'utf8',
)));
const recipe = {
  schema: CONTROL_RECIPE_SCHEMA,
  schemaVersion: CONTROL_RECIPE_VERSION,
  id: 'tone-p5-coupling-proof',
  layers: [
    { id: 'sound', domain: 'tone', code: '', order: 0 },
    { id: 'visual', domain: 'p5', code: '', order: 1 },
  ],
  transport: {
    clock: 'interval',
    cadenceMs: 20,
    bufferSize: 2,
    staleAfterMs: 40,
    staleBehavior: 'error',
  },
  signals: [{ id: 'tone-amplitude', layerId: 'sound', type: 'number' }],
  targets: [{ id: 'p5-radius', layerId: 'visual', type: 'number' }],
  mappings: [{
    id: 'amplitude-to-radius',
    signalId: 'tone-amplitude',
    targetId: 'p5-radius',
    scale: 100,
    offset: 10,
    clamp: [10, 110],
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
  lineage: {
    parentRecipeIds: ['w5-05-recipe'],
    createdAt: '2026-07-30T00:00:00.000Z',
  },
};
const units = {
  technical: 'ratio',
  creative: 'ratio',
  taste: 'ratio',
  cost: 'attempts',
  latency: 'ms',
  reliability: 'ratio',
  security: 'ratio',
  complexity: 'evaluator-modules',
};
const measurements = {
  technical: [0.9, 0.5],
  creative: [0.8, 0.3],
  taste: [0.8, 0.25],
  cost: [1, 2],
  latency: [0, 100],
  reliability: [1, 0.9],
  security: [1, 1],
  complexity: [1, 1],
};
const sources = {
  technical: 'evaluation:layers.technicalValidity',
  creative: 'evaluation:whole.baseline.creativeQuality',
  taste: 'evaluation:whole.baseline.tasteQuality',
  cost: 'evaluation:attempts.length',
  latency: 'measurement:performance.now',
  reliability: 'evaluation:checks',
  security: 'test:invalid-recipe-matrix',
  complexity: 'module:CompositionEvaluator',
};
const evidence = COMPOSITION_EVIDENCE_DIMENSIONS.map(dimension => ({
  dimension,
  status: 'observed',
  value: measurements[dimension][0],
  unit: units[dimension],
  direction: ['cost', 'latency', 'complexity'].includes(dimension)
    ? 'lower-better'
    : 'higher-better',
  baseline: measurements[dimension][1],
  sourceRef: sources[dimension],
}));
const whole = (coherence, technicalValidity, creativeQuality, tasteQuality) => ({
  coherence,
  technicalValidity,
  creativeQuality,
  tasteQuality,
});
const attempt = {
  id: 'artifact-render-ablation',
  method: 'artifact-render-and-ablation',
  status: 'complete',
  mappingId: 'amplitude-to-radius',
  layers: [
    {
      layerId: 'sound',
      technicalValidity: 0.9,
      contribution: 0.8,
      compatibility: 0.9,
      necessity: 0.8,
    },
    {
      layerId: 'visual',
      technicalValidity: 0.9,
      contribution: 0.85,
      compatibility: 0.9,
      necessity: 0.8,
    },
  ],
  trials: [
    {
      condition: 'baseline',
      signalValue: 0.8,
      targetValue: 90,
      signalUnit: 'normalized-amplitude',
      targetUnit: 'px',
      whole: whole(0.85, 0.9, 0.8, 0.8),
    },
    {
      condition: 'signal-mutation',
      signalValue: 0.1,
      targetValue: 20,
      signalUnit: 'normalized-amplitude',
      targetUnit: 'px',
      whole: whole(0.3, 0.8, 0.3, 0.3),
    },
    {
      condition: 'coupling-ablation',
      signalValue: 0.8,
      targetValue: 10,
      signalUnit: 'normalized-amplitude',
      targetUnit: 'px',
      whole: whole(0.25, 0.8, 0.25, 0.25),
    },
  ],
  evidence,
};
const evaluator = new CompositionEvaluator();
const startedAt = performance.now();
evaluator.evaluate(recipe, [attempt]);
evidence.find(measure => measure.dimension === 'latency').value =
  performance.now() - startedAt;
const evaluation = evaluator.evaluate(recipe, [attempt]);
assert.equal(prerequisite.outcome, 'PASS');
assert.equal(evaluation.outcome, 'PASS');
assert.deepEqual(evaluation.layers.map(layer => layer.verdict), ['PASS', 'PASS']);
assert.deepEqual(evaluation.whole.map(item => item.verdict), ['PASS', 'FAIL', 'FAIL']);
assert.ok(Object.values(evaluation.checks).every(Boolean));

const missing = structuredClone(attempt);
missing.id = 'missing-latency';
missing.evidence[4].status = 'missing';
delete missing.evidence[4].value;
missing.evidence[4].missingReason = 'proof clock unavailable';
const missingResult = evaluator.evaluate(recipe, [missing]);
assert.equal(missingResult.outcome, 'FAIL');
assert.equal(missingResult.evidence[4].unit, 'ms');
assert.equal(missingResult.evidence[4].baseline, 100);

const unavailable = (id, method) => ({
  id,
  method,
  status: 'unavailable',
  reason: `${method} unavailable`,
  evidence: COMPOSITION_EVIDENCE_DIMENSIONS.map(dimension => ({
    dimension,
    status: 'unavailable',
    unit: units[dimension],
    direction: ['cost', 'latency', 'complexity'].includes(dimension)
      ? 'lower-better'
      : 'higher-better',
    baseline: measurements[dimension][1],
    sourceRef: `proof:${method}:${dimension}`,
    missingReason: `${method} unavailable`,
  })),
});
assert.equal(evaluator.evaluate(recipe, [
  unavailable('browser-attempt', 'browser-render'),
]).outcome, 'RETRY_ALLOWED');
assert.equal(evaluator.evaluate(recipe, [
  unavailable('browser-attempt', 'browser-render'),
  unavailable('replay-attempt', 'trace-replay'),
]).outcome, 'RESIDUAL');
for (const mutate of [
  item => { item.transport.staleAfterMs = 20; },
  item => { item.mappings[0].scale = Number.NaN; },
  item => { item.mappings[0].signalId = 'p5-radius'; },
  item => { item.mappings = []; },
  item => { item.targets[0].type = 'string'; },
]) {
  const invalid = structuredClone(recipe);
  mutate(invalid);
  assert.throws(() => evaluator.evaluate(invalid, [attempt]));
}

const receipt = createCompositionEvaluationGateReceipt({
  generatedAt: '2026-07-30T16:00:00.000Z',
  prerequisite,
  evaluation,
  evidenceRefs: [
    'recipe:tone-p5-coupling-proof',
    'attempt:artifact-render-ablation',
    'gate:W5-03',
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
