import assert from 'node:assert/strict';
import {
  CONTROL_RECIPE_SCHEMA,
  CONTROL_RECIPE_VERSION,
  CompositionControlRuntime,
  generateControlArtifact,
  migrateControlRecipe,
  validateControlRecipe,
} from '../../dist/composition/index.js';

const checks = [];
const check = (name, fn) => {
  fn();
  checks.push(name);
};

const recipe = {
  schema: CONTROL_RECIPE_SCHEMA,
  schemaVersion: CONTROL_RECIPE_VERSION,
  id: 'p5-tone-proof',
  layers: [
    { id: 'visual', domain: 'p5', code: '', order: 0 },
    { id: 'sound', domain: 'tone', code: '', order: 1 },
  ],
  transport: {
    clock: 'interval',
    cadenceMs: 20,
    bufferSize: 2,
    staleAfterMs: 40,
    staleBehavior: 'hold',
  },
  signals: [{ id: 'energy', layerId: 'visual', type: 'number' }],
  targets: [{ id: 'frequency', layerId: 'sound', type: 'number' }],
  mappings: [{
    id: 'energy-frequency',
    signalId: 'energy',
    targetId: 'frequency',
    scale: 400,
    offset: 100,
    clamp: [100, 500],
  }],
  resources: [
    { id: 'canvas', kind: 'canvas', ownerLayerId: 'visual' },
    { id: 'audio', kind: 'audio-context', ownerLayerId: 'sound' },
  ],
  lifecycle: {
    startOrder: ['visual', 'sound'],
    teardownOrder: ['sound', 'visual'],
  },
  audio: { unlock: 'user-gesture', ownerLayerId: 'sound' },
  lineage: { parentRecipeIds: ['proof-seed'], createdAt: '2026-07-30T00:00:00.000Z' },
};

check('current recipe validates', () => {
  assert.equal(validateControlRecipe(recipe).id, recipe.id);
});
check('legacy recipe migrates deterministically', () => {
  const legacy = {
    schema: CONTROL_RECIPE_SCHEMA,
    schemaVersion: '1.0',
    id: recipe.id,
    layers: recipe.layers,
    cadenceMs: 20,
    links: [{
      id: 'energy-frequency',
      from: recipe.signals[0],
      to: recipe.targets[0],
      scale: 400,
      offset: 100,
    }],
    resources: recipe.resources,
    createdAt: recipe.lineage.createdAt,
  };
  assert.deepEqual(migrateControlRecipe(legacy), migrateControlRecipe(legacy));
});

for (const [name, mutate] of [
  ['disconnected graph rejected', value => value.mappings.splice(0)],
  ['stale contract rejected', value => { value.transport.staleAfterMs = 1; }],
  ['reversed control rejected', value => { value.mappings[0].signalId = 'frequency'; }],
  ['incompatible control rejected', value => { value.targets[0].type = 'boolean'; }],
]) {
  check(name, () => {
    const invalid = structuredClone(recipe);
    mutate(invalid);
    assert.throws(() => validateControlRecipe(invalid));
  });
}

let signal = 0.75;
const output = [];
const events = [];
const scheduler = {
  now: () => 0,
  schedule: (_clock, _cadence, tick) => {
    scheduler.tick = tick;
    return 'proof-schedule';
  },
  cancel: () => events.push('cancel'),
};
const bindings = new Map([
  ['visual', {
    start: () => events.push('start:visual'),
    stop: () => events.push('stop:visual'),
    readSignal: () => signal,
    releaseResource: id => events.push(`release:${id}`),
  }],
  ['sound', {
    start: () => events.push('start:sound'),
    stop: () => events.push('stop:sound'),
    writeTarget: (_id, value) => output.push(value),
    releaseResource: id => events.push(`release:${id}`),
  }],
]);
const runtime = new CompositionControlRuntime(recipe, bindings, scheduler);
check('audio unlock fails closed', () => {
  assert.throws(() => runtime.start(), /user gesture/);
});
runtime.start({ userGesture: true });
scheduler.tick();
signal = 0.25;
scheduler.tick();
const receipt = runtime.stop();

check('p5 signal drives Tone target', () => {
  assert.deepEqual(output, [400, 300]);
});
check('teardown order is deterministic', () => {
  assert.deepEqual(receipt.stoppedLayers, ['sound', 'visual']);
});
check('owned resources are released', () => {
  assert.deepEqual(receipt.releasedResources, ['canvas', 'audio']);
});
check('standalone artifact includes p5 and Tone', () => {
  const html = generateControlArtifact(recipe);
  assert.match(html, /p5\.min\.js/);
  assert.match(html, /Tone\.js/);
  assert.match(html, /window\.SinterControl/);
});

process.stdout.write(`${JSON.stringify({
  ok: true,
  checkCount: checks.length,
  checks,
  receipt,
}, null, 2)}\n`);
