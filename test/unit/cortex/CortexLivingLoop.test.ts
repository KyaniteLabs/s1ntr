import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CortexLivingLoopConductor,
  FileCortexCycleStore,
  type LivingLoopEffect,
  type LivingLoopExecutionContext,
  type LivingLoopExecutionResult,
  type LivingLoopRequest,
  type LivingLoopStepExecutor,
} from '../../../src/cortex/CortexLivingLoop.js';

const EFFECTS: Record<string, LivingLoopEffect[]> = {
  'create-evidence': ['evidence-admission'],
  dream: ['dream-admission'],
  consolidate: ['consolidation-admission'],
  autoresearch: ['mutation'],
  review: ['review', 'veto'],
  assimilate: ['assimilation-recommendation'],
  'candidate-request': ['candidate', 'promotion-request'],
  'follow-up-create': ['follow-up-artifact'],
};

function request(cycleId = 'cycle-one'): LivingLoopRequest {
  return {
    cycleId,
    lineageId: `${cycleId}-lineage`,
    sourceFingerprint: 'e'.repeat(64),
    autonomyLevel: 'autopilot',
    prerequisites: {
      dreamReceiptDigest: 'a'.repeat(64),
      causalReceiptDigest: 'b'.repeat(64),
      domainReceiptDigest: 'c'.repeat(64),
      assimilationReceiptDigest: 'd'.repeat(64),
    },
    budgets: {
      maxActions: 8,
      maxTokens: 700,
      maxCostUsd: 1,
      maxWallClockMs: 1_000,
    },
    concurrencyLimit: 1,
    leaseTtlMs: 10,
  };
}

function result(context: LivingLoopExecutionContext): LivingLoopExecutionResult {
  return {
    idempotencyKey: context.idempotencyKey,
    effects: EFFECTS[context.step].map(type => ({
      type,
      id: `${context.idempotencyKey}:${type}`,
    })),
    receiptRefs: [`receipt:${context.step}`],
    usage: { actions: 1, tokens: 10, costUsd: 0.01, wallClockMs: 1 },
  };
}

class IdempotentExecutor implements LivingLoopStepExecutor {
  readonly recorded = new Map<string, LivingLoopExecutionResult>();
  executeCalls = 0;
  recoverCalls = 0;
  hook?: (context: LivingLoopExecutionContext) => Promise<void>;

  async execute(context: LivingLoopExecutionContext): Promise<LivingLoopExecutionResult> {
    this.executeCalls += 1;
    const value = this.recorded.get(context.idempotencyKey) ?? result(context);
    this.recorded.set(context.idempotencyKey, value);
    await this.hook?.(context);
    return value;
  }

  async recover(
    context: LivingLoopExecutionContext,
  ): Promise<LivingLoopExecutionResult | null> {
    this.recoverCalls += 1;
    return this.recorded.get(context.idempotencyKey) ?? null;
  }
}

const temporaryRoots: string[] = [];

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cortex-loop-'));
  temporaryRoots.push(root);
  const store = new FileCortexCycleStore(root);
  return { root, store };
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(root =>
    rm(root, { recursive: true, force: true })));
});

describe('CortexLivingLoopConductor', () => {
  it('rejects invalid cycle inputs before any write', async () => {
    const { store } = await fixture();
    const conductor = new CortexLivingLoopConductor(store);
    const cases: LivingLoopRequest[] = [
      { ...request(), cycleId: '../escape' },
      {
        ...request(),
        prerequisites: { ...request().prerequisites, dreamReceiptDigest: 'bad' },
      },
      { ...request(), budgets: { ...request().budgets, maxTokens: 0 } },
      { ...request(), concurrencyLimit: 0 },
      { ...request(), leaseTtlMs: 0 },
    ];
    for (const invalid of cases) {
      expect(() => conductor.dryRun(invalid)).toThrow();
    }
  });

  it('refuses to claim parallel support for concurrencyLimit > 1 (#1307)', async () => {
    const { store } = await fixture();
    const conductor = new CortexLivingLoopConductor(store);
    expect(() => conductor.dryRun({ ...request(), concurrencyLimit: 2 }))
      .toThrow('PARALLEL_EXECUTION_UNSUPPORTED');
  });

  it('stops a hung executor on an independent timer with outcome unknown (#1307)', async () => {
    const { store } = await fixture();
    const frozen = 5_000;
    const conductor = new CortexLivingLoopConductor(store, () => frozen);
    let seen: AbortSignal | undefined;
    const hung: LivingLoopStepExecutor = {
      execute: (context) => { seen = context.signal; return new Promise(() => {}); },
      recover: () => Promise.resolve(null),
    };
    const started = Date.now();
    const stopped = await conductor.run(
      { ...request('cycle-hung'), budgets: { ...request().budgets, maxWallClockMs: 40 } },
      'actor-a', hung);
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(stopped.state).toBe('stopped');
    expect(stopped.stopReason).toBe('executor-deadline-exceeded:outcome-unknown');
    expect(stopped.steps[0]?.status).toBe('running');
    expect(seen?.aborted).toBe(true);
    const persisted = await store.read('cycle-hung');
    expect(persisted?.stopReason).toBe('executor-deadline-exceeded:outcome-unknown');
  });

  it('leaves no temp files after durable checkpoint writes', async () => {
    const { root, store } = await fixture();
    const conductor = new CortexLivingLoopConductor(store);
    await conductor.run(request('cycle-durable'), 'actor-a', new IdempotentExecutor());
    const files = await readdir(path.join(root, 'cycle-durable'));
    expect(files.filter(f => f.endsWith('.tmp'))).toEqual([]);
    expect(files).toContain('checkpoint.json');
  });

  it('explains every transition without writing or weakening authority', async () => {
    const { root, store } = await fixture();
    const conductor = new CortexLivingLoopConductor(store);

    for (const autonomyLevel of ['assist', 'co-create', 'autopilot'] as const) {
      const dryRun = conductor.dryRun({ ...request(), autonomyLevel });
      expect(dryRun.writes).toBe(false);
      expect(dryRun.steps).toHaveLength(8);
      expect(dryRun.steps.every(step =>
        step.transition && step.prerequisite && step.idempotencyKey)).toBe(true);
      expect(dryRun.authority).toEqual({
        independentReviewRequired: true,
        sealedControlsRequired: true,
        stageOneNoMerge: true,
      });
    }
    expect(await readdir(root)).toEqual([]);
  });

  it('completes once and replay duplicates no effect', async () => {
    const { store } = await fixture();
    let now = 100;
    const conductor = new CortexLivingLoopConductor(store, () => now);
    const executor = new IdempotentExecutor();

    const completed = await conductor.run(request(), 'actor-a', executor);
    expect(completed.state).toBe('completed');
    expect(completed.usage.actions).toBe(8);
    expect(completed.maxObservedConcurrency).toBe(1);
    expect(completed.steps.flatMap(step => step.effects)).toHaveLength(10);

    now += 100;
    const replayed = await conductor.run(request(), 'actor-b', executor);
    expect(replayed.state).toBe('completed');
    expect(executor.executeCalls).toBe(8);
    expect(executor.recoverCalls).toBe(0);
    expect(replayed.steps).toEqual(completed.steps);
  });

  it('recovers an interrupted external effect instead of executing it twice', async () => {
    const { store } = await fixture();
    let now = 200;
    const conductor = new CortexLivingLoopConductor(store, () => now);
    const executor = new IdempotentExecutor();
    let interrupted = false;
    executor.hook = async context => {
      if (context.step === 'autoresearch' && !interrupted) {
        interrupted = true;
        throw new Error('simulated-process-exit');
      }
    };

    await expect(conductor.run(request('cycle-restart'), 'actor-a', executor))
      .rejects.toThrow('simulated-process-exit');
    const interruptedState = await store.read('cycle-restart');
    expect(interruptedState?.steps.find(step => step.step === 'autoresearch')?.status)
      .toBe('running');

    now += 11;
    executor.hook = undefined;
    const recovered = await conductor.run(
      request('cycle-restart'),
      'actor-b',
      executor,
    );
    expect(recovered.state).toBe('completed');
    expect(executor.executeCalls).toBe(8);
    expect(executor.recoverCalls).toBe(1);
    expect(new Set(recovered.steps.flatMap(step =>
      step.effects.map(effect => effect.id))).size).toBe(10);
  });

  it('stops when an interrupted effect cannot be recovered', async () => {
    const { store } = await fixture();
    let now = 250;
    const conductor = new CortexLivingLoopConductor(store, () => now);
    const executor = new IdempotentExecutor();
    executor.hook = async () => {
      throw new Error('interrupted');
    };
    await expect(conductor.run(
      request('cycle-no-recovery'),
      'actor-a',
      executor,
    )).rejects.toThrow('interrupted');
    executor.hook = undefined;
    executor.recorded.clear();
    now += 11;
    const stopped = await conductor.run(
      request('cycle-no-recovery'),
      'actor-b',
      executor,
    );
    expect(stopped.state).toBe('stopped');
    expect(stopped.stopReason).toBe('recovery-required');
  });

  it('stops before another step when the action budget is exhausted', async () => {
    const { store } = await fixture();
    const limited = request('cycle-action-budget');
    limited.budgets.maxActions = 1;
    const stopped = await new CortexLivingLoopConductor(store, () => 275)
      .run(limited, 'actor-a', new IdempotentExecutor());
    expect(stopped.state).toBe('stopped');
    expect(stopped.stopReason).toBe('budget-exhausted');
    expect(stopped.usage.actions).toBe(1);
  });

  it('fences both actors after split-brain lease loss', async () => {
    const { store } = await fixture();
    let now = 300;
    const cycleRequest = request('cycle-split-brain');
    const conductor = new CortexLivingLoopConductor(store, () => now);
    const executor = new IdempotentExecutor();
    let stolen = false;
    executor.hook = async () => {
      if (stolen) return;
      stolen = true;
      now += 11;
      await store.acquire(cycleRequest, 'actor-b', now);
    };

    const actorA = await conductor.run(cycleRequest, 'actor-a', executor);
    expect(actorA.state).toBe('stopped');
    expect(actorA.fenced).toBe(true);
    expect(actorA.stopReason).toBe('split-brain');

    const actorB = await conductor.run(cycleRequest, 'actor-b', executor);
    expect(actorB.state).toBe('stopped');
    expect(actorB.fenced).toBe(true);
    expect(actorB.stopReason).toBe('split-brain');
    expect(executor.executeCalls).toBe(1);
  });

  it('fences split brain even when the stale executor also throws', async () => {
    const { store } = await fixture();
    let now = 350;
    const cycleRequest = request('cycle-split-error');
    const conductor = new CortexLivingLoopConductor(store, () => now);
    const executor = new IdempotentExecutor();
    executor.hook = async () => {
      now += 11;
      await store.acquire(cycleRequest, 'actor-b', now);
      throw new Error('stale-executor-failed');
    };

    const stopped = await conductor.run(cycleRequest, 'actor-a', executor);
    expect(stopped.state).toBe('stopped');
    expect(stopped.stopReason).toBe('split-brain');
    expect(stopped.fenced).toBe(true);
  });

  it('fails closed when an executor reports a budget overrun', async () => {
    const { store } = await fixture();
    const conductor = new CortexLivingLoopConductor(store, () => 400);
    const executor = new IdempotentExecutor();
    executor.hook = async context => {
      const value = executor.recorded.get(context.idempotencyKey);
      if (value) value.usage.tokens = context.remaining.maxTokens + 1;
    };

    const stopped = await conductor.run(request('cycle-budget'), 'actor-a', executor);
    expect(stopped.state).toBe('stopped');
    expect(stopped.stopReason).toBe('LIVING_LOOP_BUDGET_EXCEEDED');
    expect(stopped.steps[0].status).toBe('running');
    expect(stopped.usage.actions).toBe(0);
  });

  it('does not admit a result returned after the wall-clock deadline', async () => {
    const { store } = await fixture();
    let now = 425;
    const conductor = new CortexLivingLoopConductor(store, () => now);
    const executor = new IdempotentExecutor();
    const deadlineRequest = request('cycle-deadline');
    deadlineRequest.leaseTtlMs = 2_000;
    executor.hook = async () => {
      now += 1_001;
    };
    const stopped = await conductor.run(
      deadlineRequest,
      'actor-a',
      executor,
    );
    expect(stopped.state).toBe('stopped');
    expect(stopped.stopReason).toBe('LIVING_LOOP_BUDGET_EXCEEDED');
    expect(stopped.steps[0].status).toBe('running');
  });

  it.each([
    ['idempotency key', (value: LivingLoopExecutionResult) => {
      value.idempotencyKey = 'wrong';
    }, 'IDEMPOTENCY_KEY_MISMATCH'],
    ['effect shape', (value: LivingLoopExecutionResult) => {
      value.effects = [];
    }, 'LIVING_LOOP_EFFECT_MISMATCH'],
    ['effect id', (value: LivingLoopExecutionResult) => {
      value.effects[0].id = '';
    }, 'INVALID_LIVING_LOOP_EFFECT_IDS'],
    ['receipt', (value: LivingLoopExecutionResult) => {
      value.receiptRefs = [];
    }, 'MISSING_LIVING_LOOP_RECEIPT'],
    ['usage', (value: LivingLoopExecutionResult) => {
      value.usage.actions = -1;
    }, 'INVALID_EXECUTOR_USAGE'],
  ])('fails closed on invalid executor %s', async (name, mutate, reason) => {
    const { store } = await fixture();
    const conductor = new CortexLivingLoopConductor(store, () => 450);
    const executor = new IdempotentExecutor();
    executor.hook = async context => {
      mutate(executor.recorded.get(context.idempotencyKey)!);
    };
    const cycleId = `invalid-${name.replace(' ', '-')}`;
    const stopped = await conductor.run(request(cycleId), 'actor-a', executor);
    expect(stopped.state).toBe('stopped');
    expect(stopped.stopReason).toBe(reason);
  });

  it('reclaims a checkpoint lock left by a dead process', async () => {
    const { root, store } = await fixture();
    const lock = path.join(root, 'cycle-dead-lock', '.lock');
    await mkdir(lock, { recursive: true });
    await writeFile(path.join(lock, 'owner.json'), JSON.stringify({
      pid: Number.MAX_SAFE_INTEGER,
      token: 'dead-owner',
    }));

    const acquired = await store.acquire(
      request('cycle-dead-lock'),
      'actor-a',
      500,
    );
    expect(acquired.state).toBe('running');
    expect(acquired.lease?.ownerId).toBe('actor-a');
  });

  it('does not steal a checkpoint lock from a live process', async () => {
    const { root, store } = await fixture();
    const lock = path.join(root, 'cycle-live-lock', '.lock');
    await mkdir(lock, { recursive: true });
    await writeFile(path.join(lock, 'owner.json'), JSON.stringify({
      pid: process.pid,
      token: 'live-owner',
    }));
    await expect(store.acquire(
      request('cycle-live-lock'),
      'actor-a',
      650,
    )).rejects.toThrow('CHECKPOINT_BUSY');
  });

  it('fails closed on invalid store ownership and lease operations', async () => {
    expect(() => new FileCortexCycleStore('relative'))
      .toThrow('CORTEX_CYCLE_ROOT_MUST_BE_ABSOLUTE');
    const { store } = await fixture();
    await expect(store.acquire(request('cycle-owner'), '', 700))
      .rejects.toThrow('OWNER_ID_REQUIRED');
    const held = await store.acquire(request('cycle-held'), 'actor-a', 700);
    await expect(store.acquire(request('cycle-held'), 'actor-b', 705))
      .rejects.toThrow('LEASE_HELD');
    await expect(store.update('cycle-missing', 'token', 700, () => {}))
      .rejects.toThrow('CYCLE_NOT_FOUND');
    await expect(store.fence('cycle-missing', 'reason', 700))
      .rejects.toThrow('CYCLE_NOT_FOUND');
    await expect(store.update(
      'cycle-held',
      `${held.lease?.token}-wrong`,
      700,
      () => {},
    )).rejects.toThrow('LEASE_LOST');
  });

  it('rejects a checkpoint that weakens the authority envelope', async () => {
    const { root, store } = await fixture();
    const acquired = await store.acquire(
      request('cycle-tampered'),
      'actor-a',
      600,
    );
    acquired.authority.stageOneNoMerge = false;
    await writeFile(
      path.join(root, 'cycle-tampered', 'checkpoint.json'),
      JSON.stringify(acquired),
    );

    await expect(store.read('cycle-tampered'))
      .rejects.toThrow('INVALID_CORTEX_CHECKPOINT');
  });

  it.each(['null', 'incomplete', 'duplicate-effect'])(
    'rejects an invalid %s checkpoint',
    async variant => {
      const { root, store } = await fixture();
      const cycleId = `cycle-${variant}`;
      const acquired = await store.acquire(request(cycleId), 'actor-a', 800);
      let serialized = 'null';
      if (variant === 'incomplete') {
        acquired.state = 'completed';
        serialized = JSON.stringify(acquired);
      } else if (variant === 'duplicate-effect') {
        acquired.steps[0].effects = [{ type: 'evidence-admission', id: 'same' }];
        acquired.steps[1].effects = [{ type: 'dream-admission', id: 'same' }];
        serialized = JSON.stringify(acquired);
      }
      await writeFile(
        path.join(root, cycleId, 'checkpoint.json'),
        serialized,
      );
      await expect(store.read(cycleId))
        .rejects.toThrow('INVALID_CORTEX_CHECKPOINT');
    },
  );
});
