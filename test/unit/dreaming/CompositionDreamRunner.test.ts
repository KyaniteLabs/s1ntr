import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  CONTROL_RECIPE_SCHEMA,
  CONTROL_RECIPE_VERSION,
  type ControlRecipe,
} from '../../../src/composition/index.js';
import {
  COMPOSITION_EVIDENCE_DIMENSIONS,
  type CompositionEvaluationAttempt,
} from '../../../src/evaluation/index.js';
import { DreamQueue } from '../../../src/dreaming/DreamQueue.js';
import { runNextDreamTask } from '../../../src/dreaming/DreamTaskRunner.js';
import { mutateCompositionRecipe } from '../../../src/dreaming/CompositionRecipeMutator.js';
import { runNextCompositionDream } from '../../../src/dreaming/CompositionDreamRunner.js';
import type { CompositionDreamPlan } from '../../../src/dreaming/CompositionDreamTypes.js';

const tempRoots: string[] = [];
afterEach(() => tempRoots.splice(0).forEach(root =>
  fs.rmSync(root, { recursive: true, force: true })
));

function recipe(): ControlRecipe {
  return {
    schema: CONTROL_RECIPE_SCHEMA,
    schemaVersion: CONTROL_RECIPE_VERSION,
    id: 'parent-composition',
    layers: [
      { id: 'sound', domain: 'tone', code: 'api.register("sound", {});', order: 0 },
      { id: 'visual', domain: 'p5', code: 'api.register("visual", {});', order: 1 },
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
      { id: 'audio', kind: 'audio-context', ownerLayerId: 'sound' },
      { id: 'canvas', kind: 'canvas', ownerLayerId: 'visual' },
    ],
    lifecycle: {
      startOrder: ['sound', 'visual'],
      teardownOrder: ['visual', 'sound'],
    },
    audio: { unlock: 'user-gesture', ownerLayerId: 'sound' },
    lineage: { parentRecipeIds: [], createdAt: '2026-07-30T00:00:00.000Z' },
  };
}

function plan(mutation: CompositionDreamPlan['mutation']): CompositionDreamPlan {
  return {
    parentRecipe: recipe(),
    mutation,
    provenance: {
      lineageId: 'lineage-one',
      sourceDigest: 'a'.repeat(64),
      origin: 'dream-test',
      trust: 'model-inference',
      taint: 'tainted',
      taintSources: ['parent-model-output'],
      corroboration: ['parent-composition'],
    },
  };
}

function attempt(candidate: ControlRecipe, pass = true): CompositionEvaluationAttempt {
  const mapping = candidate.mappings[0];
  const scores = (good: boolean) => ({
    coherence: good ? 0.9 : 0.2,
    technicalValidity: 0.9,
    creativeQuality: good ? 0.8 : 0.2,
    tasteQuality: good ? 0.8 : 0.2,
  });
  return {
    id: 'rendered-attempt',
    method: 'render-and-ablate',
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
        condition: 'baseline', signalValue: 0.8,
        targetValue: 0.8 * mapping.scale + mapping.offset,
        signalUnit: 'ratio', targetUnit: 'px', whole: scores(true),
      },
      {
        condition: 'signal-mutation', signalValue: 0.1,
        targetValue: pass ? 0.1 * mapping.scale + mapping.offset : 999,
        signalUnit: 'ratio', targetUnit: 'px', whole: scores(false),
      },
      {
        condition: 'coupling-ablation', signalValue: 0.8,
        targetValue: mapping.offset,
        signalUnit: 'ratio', targetUnit: 'px', whole: scores(false),
      },
    ],
    evidence: COMPOSITION_EVIDENCE_DIMENSIONS.map(dimension => ({
      dimension,
      status: 'observed',
      value: 0.8,
      unit: 'ratio',
      direction: 'higher-better',
      baseline: 0.7,
      sourceRef: `test:${dimension}`,
    })),
  };
}

function queueWith(planInput: CompositionDreamPlan) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'composition-dream-'));
  tempRoots.push(root);
  const queuePath = path.join(root, 'queue.json');
  const queue = new DreamQueue({ persistPath: queuePath });
  const id = queue.enqueueComposition(
    planInput,
    [{ id: planInput.parentRecipe.id, descriptor: [0.8], quality: 0.9 }],
    0.9,
  )!;
  return { queue, queuePath, id };
}

describe('composition dreaming', () => {
  it('runs, evaluates, admits, and persists a reconstructable mapping mutation', async () => {
    const input = plan({ kind: 'mapping', mappingId: 'amplitude-radius', scale: 120 });
    const { queue, queuePath, id } = queueWith(input);
    const sink = { record: vi.fn(async () => [{
      organ: 'memory', status: 'observed', detail: 'stored',
    }]) };

    const result = await runNextCompositionDream(
      queue,
      async candidate => [attempt(candidate)],
      sink,
    );

    expect(result?.record.verdict).toBe('admitted');
    expect(result?.record.recipe.lineage.parentRecipeIds).toContain('parent-composition');
    expect(result?.record.artifact).toContain('<!doctype html>');
    expect(result?.record.artifact).toContain('p5.min.js');
    expect(result?.record.artifact).toContain('Tone.js');
    expect(sink.record).toHaveBeenCalledWith(expect.objectContaining({
      verdict: 'admitted',
      plan: expect.objectContaining({ provenance: input.provenance }),
    }));
    const persisted = new DreamQueue({ persistPath: queuePath })
      .getTasks('completed').find(task => task.id === id)!;
    expect(persisted.result?.composition?.recipe.mappings[0].scale).toBe(120);
    expect(persisted.result?.composition?.artifactDigest).toHaveLength(64);
  });

  it('records a terminal rejection instead of treating failed evaluation as admission', async () => {
    const { queue } = queueWith(
      plan({ kind: 'mapping', mappingId: 'amplitude-radius', scale: 120 }),
    );
    const sink = { record: vi.fn(async () => []) };
    const result = await runNextCompositionDream(
      queue,
      async candidate => [attempt(candidate, false)],
      sink,
    );

    expect(result?.record.verdict).toBe('rejected');
    expect(result?.record.evaluation.outcome).toBe('FAIL');
    expect(queue.getStatus()).toEqual({ queued: 0, running: 0, completed: 1, failed: 0 });
    expect(sink.record).toHaveBeenCalledWith(expect.objectContaining({ verdict: 'rejected' }));
  });

  it('keeps artifact and composition consumers from stealing each other tasks', async () => {
    const { queue } = queueWith(
      plan({ kind: 'mapping', mappingId: 'amplitude-radius', scale: 120 }),
    );
    const runDreamAndAssimilate = vi.fn(async () => ({ artifact: 'wrong lane' }) as never);

    await expect(runNextDreamTask(queue, { runDreamAndAssimilate },
      (prompt) => ({ prompt }) as never)).resolves.toBeNull();
    expect(runDreamAndAssimilate).not.toHaveBeenCalled();
    expect(queue.getTasks('queued')[0].kind).toBe('composition');
  });

  it('supports valid timing and Tone-family domain mutations and rejects incompatible domains', () => {
    const timing = mutateCompositionRecipe(
      recipe(),
      { kind: 'timing', cadenceMs: 30, bufferSize: 3, staleAfterMs: 90 },
      'timing',
    );
    expect(timing.transport).toMatchObject({
      cadenceMs: 30,
      bufferSize: 3,
      staleAfterMs: 90,
    });
    const domain = mutateCompositionRecipe(
      recipe(),
      { kind: 'compatible-domain', layerId: 'sound', domain: 'music' },
      'domain',
    );
    expect(domain.layers[0].domain).toBe('music');
    expect(() => mutateCompositionRecipe(
      recipe(),
      { kind: 'compatible-domain', layerId: 'visual', domain: 'three' },
      'invalid-domain',
    )).toThrow('Unsupported domain mutation');
  });

  it('persists failure evidence and feeds the failure to cognition', async () => {
    const { queue, queuePath } = queueWith(
      plan({ kind: 'mapping', mappingId: 'missing', scale: 120 }),
    );
    const sink = { record: vi.fn(async () => [{
      organ: 'memory', status: 'observed', detail: 'failure stored',
    }]) };

    await expect(runNextCompositionDream(queue, async () => [], sink))
      .rejects.toThrow('Unknown mapping');
    expect(sink.record).toHaveBeenCalledWith(expect.objectContaining({ verdict: 'failed' }));
    const failed = new DreamQueue({ persistPath: queuePath }).getTasks('failed')[0];
    expect(failed.result?.failure).toMatchObject({
      parentRecipeId: 'parent-composition',
      reason: 'Unknown mapping missing',
      cognitiveReceipts: [{ organ: 'memory', status: 'observed' }],
    });
  });

  it('does not strand a running task when the cognitive sink is unavailable', async () => {
    const { queue } = queueWith(
      plan({ kind: 'mapping', mappingId: 'amplitude-radius', scale: 120 }),
    );
    const result = await runNextCompositionDream(
      queue,
      async candidate => [attempt(candidate)],
      { record: async () => { throw new Error('memory offline'); } },
    );

    expect(result?.record.cognitiveReceipts).toEqual([{
      organ: 'cognition',
      status: 'unavailable',
      detail: 'memory offline',
    }]);
    expect(queue.getStatus()).toEqual({ queued: 0, running: 0, completed: 1, failed: 0 });
  });
});
