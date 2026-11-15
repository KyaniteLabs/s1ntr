import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  CortexLivingLoopConductor,
  FileCortexCycleStore,
} from '../../dist/cortex/index.js';
import {
  createCortexCycleGateReceipt,
  parseCausalCandidateGateReceipt,
  parseCompositionDreamGateReceipt,
  parseCortexCycleGateReceipt,
  parseDomainIncubationGateReceipt,
  parseModelAssimilationGateReceipt,
} from '../../dist/index.js';

const outputIndex = process.argv.indexOf('--output');
const outputPath = outputIndex >= 0
  ? path.resolve(process.argv[outputIndex + 1])
  : path.resolve('docs/agents/waves/receipts/wave-5-W5-14-cortex-cycle.json');
const receiptDir = path.resolve('docs/agents/waves/receipts');
const readReceipt = async name => JSON.parse(await fs.readFile(
  path.join(receiptDir, name),
  'utf8',
));

const sourceReceipts = {
  dream: parseCompositionDreamGateReceipt(await readReceipt(
    'wave-5-W5-07-composition-dream.json',
  )),
  causal: parseCausalCandidateGateReceipt(await readReceipt(
    'wave-5-W5-11-causal-candidate.json',
  )),
  domain: parseDomainIncubationGateReceipt(await readReceipt(
    'wave-5-W5-12-domain-incubator.json',
  )),
  assimilation: parseModelAssimilationGateReceipt(await readReceipt(
    'wave-5-W5-13-model-assimilation.json',
  )),
};

const prerequisites = {
  dream: {
    gate: 'W5-07',
    outcome: sourceReceipts.dream.outcome,
    receiptDigest: sourceReceipts.dream.receiptDigest,
  },
  causal: {
    gate: 'W5-11',
    outcome: sourceReceipts.causal.outcome,
    receiptDigest: sourceReceipts.causal.receiptDigest,
  },
  domain: {
    gate: 'W5-12',
    outcome: sourceReceipts.domain.outcome,
    receiptDigest: sourceReceipts.domain.receiptDigest,
  },
  assimilation: {
    gate: 'W5-13',
    outcome: sourceReceipts.assimilation.outcome,
    receiptDigest: sourceReceipts.assimilation.receiptDigest,
  },
};

const makeRequest = (cycleId, autonomyLevel = 'autopilot') => ({
  cycleId,
  autonomyLevel,
  prerequisites: {
    dreamReceiptDigest: prerequisites.dream.receiptDigest,
    causalReceiptDigest: prerequisites.causal.receiptDigest,
    domainReceiptDigest: prerequisites.domain.receiptDigest,
    assimilationReceiptDigest: prerequisites.assimilation.receiptDigest,
  },
  budgets: {
    maxActions: 7,
    maxTokens: 7_000,
    maxCostUsd: 2,
    maxWallClockMs: 60_000,
  },
  concurrencyLimit: 1,
  leaseTtlMs: 10,
});

const effects = {
  'create-evidence': ['evidence-admission'],
  dream: ['dream-admission'],
  consolidate: ['consolidation-admission'],
  autoresearch: ['mutation'],
  review: ['review', 'veto'],
  assimilate: ['assimilation-recommendation'],
  'candidate-request': ['candidate', 'promotion-request'],
};

const makeResult = context => ({
  idempotencyKey: context.idempotencyKey,
  effects: effects[context.step].map(type => ({
    type,
    id: `${context.idempotencyKey}:${type}`,
  })),
  receiptRefs: [`proof:${context.step}`],
  usage: { actions: 1, tokens: 100, costUsd: 0.01, wallClockMs: 10 },
});

class ProofExecutor {
  recorded = new Map();
  executeCalls = 0;
  recoverCalls = 0;
  crashStep = null;
  crashed = false;
  hook = null;
  overrun = false;

  async execute(context) {
    this.executeCalls += 1;
    const value = this.recorded.get(context.idempotencyKey) ?? makeResult(context);
    this.recorded.set(context.idempotencyKey, value);
    await this.hook?.(context);
    if (this.overrun) value.usage.tokens = context.remaining.maxTokens + 1;
    if (context.step === this.crashStep && !this.crashed) {
      this.crashed = true;
      throw new Error('simulated-process-exit-after-effect');
    }
    return value;
  }

  async recover(context) {
    this.recoverCalls += 1;
    return this.recorded.get(context.idempotencyKey) ?? null;
  }
}

const temporaryRoots = [];
const makeStore = async name => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), `${name}-`));
  temporaryRoots.push(root);
  return new FileCortexCycleStore(root);
};

let now = 1_000;
const store = await makeStore('w5-cortex-restart');
const conductor = new CortexLivingLoopConductor(store, () => now);
const dryRuns = ['assist', 'co-create', 'autopilot'].map(autonomyLevel =>
  conductor.dryRun(makeRequest('wave5-cortex-proof', autonomyLevel)));
const executor = new ProofExecutor();
executor.crashStep = 'autoresearch';

await assert.rejects(
  conductor.run(makeRequest('wave5-cortex-proof'), 'actor-a', executor),
  /simulated-process-exit-after-effect/,
);
const interrupted = await store.read('wave5-cortex-proof');
assert(interrupted);
assert.equal(
  interrupted.steps.find(step => step.step === 'autoresearch').status,
  'running',
);

now += 11;
const completed = await conductor.run(
  makeRequest('wave5-cortex-proof'),
  'actor-b',
  executor,
);
assert.equal(completed.state, 'completed');
assert.equal(executor.executeCalls, 7);
assert.equal(executor.recoverCalls, 1);

now += 11;
const replayed = await conductor.run(
  makeRequest('wave5-cortex-proof'),
  'actor-c',
  executor,
);
assert.deepEqual(replayed.steps, completed.steps);
assert.equal(executor.executeCalls, 7);

now = 2_000;
const splitStore = await makeStore('w5-cortex-split');
const splitConductor = new CortexLivingLoopConductor(splitStore, () => now);
const splitRequest = makeRequest('wave5-split-proof');
const splitExecutor = new ProofExecutor();
let stolen = false;
splitExecutor.hook = async () => {
  if (stolen) return;
  stolen = true;
  now += 11;
  await splitStore.acquire(splitRequest, 'actor-b', now);
};
const actorA = await splitConductor.run(
  splitRequest,
  'actor-a',
  splitExecutor,
);
const actorB = await splitConductor.run(
  splitRequest,
  'actor-b',
  splitExecutor,
);
for (const actor of [actorA, actorB]) {
  assert.equal(actor.state, 'stopped');
  assert.equal(actor.fenced, true);
  assert.equal(actor.stopReason, 'split-brain');
}
assert.equal(splitExecutor.executeCalls, 1);

now = 3_000;
const budgetStore = await makeStore('w5-cortex-budget');
const budgetConductor = new CortexLivingLoopConductor(budgetStore, () => now);
const budgetExecutor = new ProofExecutor();
budgetExecutor.overrun = true;
const budgetStopped = await budgetConductor.run(
  makeRequest('wave5-budget-proof'),
  'actor-a',
  budgetExecutor,
);
assert.equal(budgetStopped.state, 'stopped');
assert.equal(budgetStopped.stopReason, 'LIVING_LOOP_BUDGET_EXCEEDED');
assert.equal(budgetStopped.usage.actions, 0);

let requestMismatchRejected = false;
const changedRequest = makeRequest('wave5-cortex-proof');
changedRequest.budgets.maxTokens += 1;
try {
  await conductor.run(changedRequest, 'actor-z', executor);
} catch (error) {
  requestMismatchRejected = error.message === 'CYCLE_REQUEST_MISMATCH';
}
assert.equal(requestMismatchRejected, true);

const receiptCheckpoint = checkpoint => ({
  ...checkpoint,
  lease: checkpoint.lease
    ? { ...checkpoint.lease, token: '<redacted-fencing-token>' }
    : null,
});

const receipt = createCortexCycleGateReceipt({
  generatedAt: '2026-07-30T00:00:00.000Z',
  prerequisites,
  dryRuns,
  interrupted: receiptCheckpoint(interrupted),
  completed: receiptCheckpoint(completed),
  replayed: receiptCheckpoint(replayed),
  budgetStopped: receiptCheckpoint(budgetStopped),
  requestMismatchRejected,
  splitBrain: {
    actorA: receiptCheckpoint(actorA),
    actorB: receiptCheckpoint(actorB),
  },
  failClosedCases: [
    'interrupted-replay',
    'split-brain',
    'budget-overrun',
    'authority-bypass',
    'request-mismatch',
  ],
  evidenceRefs: [
    `receipt:W5-07:${prerequisites.dream.receiptDigest}`,
    `receipt:W5-11:${prerequisites.causal.receiptDigest}`,
    `receipt:W5-12:${prerequisites.domain.receiptDigest}`,
    `receipt:W5-13:${prerequisites.assimilation.receiptDigest}`,
    'proof:cortex-atomic-restart-replay',
  ],
});
assert.equal(receipt.outcome, 'PASS');
assert.equal(Object.values(receipt.checks).every(Boolean), true);
parseCortexCycleGateReceipt(receipt);

const tampered = structuredClone(receipt);
tampered.completed.authority.stageOneNoMerge = false;
assert.throws(() => parseCortexCycleGateReceipt(tampered));

await fs.mkdir(path.dirname(outputPath), { recursive: true });
await fs.writeFile(outputPath, `${JSON.stringify(receipt, null, 2)}\n`);
await Promise.all(temporaryRoots.map(root =>
  fs.rm(root, { recursive: true, force: true })));

process.stdout.write(`${JSON.stringify({
  ok: true,
  gate: receipt.gate,
  outcome: receipt.outcome,
  checkCount: Object.keys(receipt.checks).length,
  dryRunTransitions: dryRuns[0].steps.length,
  recoveredEffects: completed.steps.flatMap(step => step.effects).length,
  splitBrainFenced: receipt.checks.splitBrainFenced,
  authorityInvariant: receipt.checks.authorityInvariant,
  receiptDigest: receipt.receiptDigest,
  outputPath,
}, null, 2)}\n`);
