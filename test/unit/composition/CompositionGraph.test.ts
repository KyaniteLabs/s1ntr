import { describe, expect, it, vi } from 'vitest';
import {
  planCompositionGraph,
  lowerCompositionGraph,
  contractCompositionGraphToV1,
  CompositionGraphLossyError,
  CompositionGraphRollbackController,
  executeCompositionGraph,
  graphFromCompositionSpec,
  migrateCompositionGraph,
  prepareComposition,
  type CompositionGraph,
} from '../../../src/composition/CompositionGraph.js';
import { compileCreativeThesis } from '../../../src/creative-intelligence/CreativeIntelligence.js';
import { CompositionOrchestrator } from '../../../src/composition/CompositionOrchestrator.js';
import { generatorRegistry } from '../../../src/generators/GeneratorRegistry.js';
import { registerAllGenerators } from '../../../src/generators/registerGenerators.js';
import type { DomainType } from '../../../src/composition/types.js';

function graph(size: number, maxProviderCalls = size): CompositionGraph {
  return {
    schema: 'sinter.composition-graph',
    schemaVersion: '2.0',
    status: 'ready',
    id: `work-${size}`,
    title: `Work ${size}`,
    budgets: { maxNodes: size, maxEdges: Math.max(0, size - 1), maxProviderCalls },
    nodes: Array.from({ length: size }, (_, index) => ({
      id: `layer-${index}`,
      type: 'layer',
      layer: { domain: 'p5', prompt: `layer ${index}` },
    })),
    edges: Array.from({ length: Math.max(0, size - 1) }, (_, index) => ({
      id: `edge-${index}`,
      type: 'before',
      from: `layer-${index}`,
      to: `layer-${index + 1}`,
    })),
  };
}

describe('CompositionGraph v2', () => {
  it.each([1, 3, 8, 12])('schedules and lowers %i nodes deterministically', (size) => {
    const input = graph(size);
    const first = planCompositionGraph(input);
    const second = planCompositionGraph(structuredClone(input));
    expect(first.schedule).toEqual(input.nodes.map(node => node.id));
    expect(second).toEqual(first);
    expect(lowerCompositionGraph(first).layers.map(layer => layer.prompt))
      .toEqual(input.nodes.map(node => node.layer.prompt));
  });

  it('uses stable ids to break ties in a dependency graph', () => {
    const input = graph(3);
    input.nodes.reverse();
    input.edges = [];
    input.budgets.maxEdges = 0;
    expect(planCompositionGraph(input).schedule).toEqual(['layer-0', 'layer-1', 'layer-2']);
  });

  it.each([
    ['draft execution', (input: CompositionGraph) => { input.status = 'draft'; }],
    ['invalid reference', (input: CompositionGraph) => { input.edges[0].to = 'missing'; }],
    ['unbounded cycle', (input: CompositionGraph) => {
      input.edges.push({ id: 'cycle', type: 'before', from: 'layer-2', to: 'layer-0' });
      input.budgets.maxEdges += 1;
    }],
    ['duplicate scheduling', (input: CompositionGraph) => input.nodes.push({ ...input.nodes[0] })],
    ['budget overflow', (input: CompositionGraph) => { input.budgets.maxProviderCalls = 2; }],
  ])('rejects %s before lowering', (_label, mutate) => {
    const input = graph(3);
    mutate(input);
    expect(() => planCompositionGraph(input)).toThrow();
  });

  it('does not charge pre-existing code against provider-call budget', () => {
    const input = graph(8, 3);
    input.nodes.slice(0, 5).forEach(node => { node.layer.code = 'function draw(){}'; });
    expect(planCompositionGraph(input).usage.providerCalls).toBe(3);
  });

  it('carries the declared provider-call cap into the lowered execution spec', () => {
    const input = graph(2, 5);
    const lowered = lowerCompositionGraph(planCompositionGraph(input));
    expect(lowered.maxProviderCalls).toBe(5);
  });

  it('accepts every domain already supported by composition layers', () => {
    const domains: DomainType[] = [
      'p5', 'three', 'shader', 'tone', 'music', 'strudel', 'hydra', 'ascii',
      'video', 'html', 'textgen', 'group',
    ];
    const input = graph(domains.length);
    input.nodes.forEach((node, index) => { node.layer.domain = domains[index]; });
    expect(planCompositionGraph(input).usage.nodes).toBe(domains.length);
  });

  it('preserves the canonical Creative Thesis identity through lowering', () => {
    const input = graph(1);
    input.creativeThesis = compileCreativeThesis('A quiet field gathers into a luminous release.');
    const lowered = lowerCompositionGraph(planCompositionGraph(input));
    expect(lowered.creativeThesis).toEqual(input.creativeThesis);
    expect(lowered.creativeThesis?.thesisId).toBe(input.creativeThesis.thesisId);
  });

  it('plans nested scenes, groups, temporal phases, controls, resources, and clock bridges', () => {
    const input = graph(3);
    input.groups = [{ id: 'inner-group', children: ['layer-0'] }, { id: 'outer-group', children: ['inner-group'] }];
    input.scenes = [{ id: 'scene-main', children: ['layer-1', 'layer-2'] }];
    input.phases = [
      { id: 'setup', order: 0, nodeIds: ['layer-0'], clock: 'manual' },
      { id: 'release', order: 1, nodeIds: ['layer-1', 'layer-2'], startsAfter: ['setup'], clock: 'audio' },
    ];
    input.resources = [{ id: 'shared-canvas', kind: 'shared', ownerNodeId: 'layer-0', shared: true }];
    input.timingIslands = [
      { id: 'manual-clock', clock: 'manual', nodeIds: ['layer-0'] },
      { id: 'audio-clock', clock: 'audio', nodeIds: ['layer-1', 'layer-2'] },
    ];
    input.bridges = [{ id: 'manual-to-audio', fromIslandId: 'manual-clock', toIslandId: 'audio-clock', mode: 'sample' }];
    input.controls = [{
      id: 'energy-control', from: { nodeId: 'layer-0', port: 'energy', type: 'number' },
      to: { nodeId: 'layer-1', port: 'frequency', type: 'number' }, scale: 400,
    }];
    const planned = planCompositionGraph(input);
    expect(planned.schedule).toEqual(['layer-0', 'layer-1', 'layer-2']);
    expect(planned.execution.phases.map(phase => phase.id)).toEqual(['setup', 'release']);
    expect(planned.execution.resources[0].shared).toBe(true);
    expect(planned.execution.bridges[0].mode).toBe('sample');
  });

  it('retries deterministically, bridges clocks, and tears down shared resources', async () => {
    const input = graph(2);
    input.retry = { maxAttempts: 2, backoffMs: 0 };
    input.resources = [{ id: 'shared', kind: 'shared', ownerNodeId: 'layer-0', shared: true }];
    input.timingIslands = [
      { id: 'a', clock: 'manual', nodeIds: ['layer-0'] },
      { id: 'b', clock: 'audio', nodeIds: ['layer-1'] },
    ];
    input.bridges = [{ id: 'a-to-b', fromIslandId: 'a', toIslandId: 'b', mode: 'hold' }];
    input.controls = [{
      id: 'control', from: { nodeId: 'layer-0', port: 'out', type: 'number' },
      to: { nodeId: 'layer-1', port: 'in', type: 'number' },
    }];
    const plan = planCompositionGraph(input).execution;
    const attempts: string[] = [];
    const operations: string[] = [];
    let failures = 0;
    const receipt = await executeCompositionGraph(plan, async (node, context) => {
      attempts.push(`${node.id}:${node.sourceIndex}`);
      if (node.id === 'layer-1') expect(context.resourceIds).toEqual(['shared']);
      if (node.id === 'layer-1' && failures++ === 0) throw new Error('transient');
    }, {
      clock: { tick: async (clock, id) => { operations.push(`tick:${clock}:${id}`); } },
      onAcquireResource: async resource => { operations.push(`acquire:${resource.id}`); },
      onReleaseResource: async resource => { operations.push(`release:${resource.id}`); },
      onBridge: async bridge => { operations.push(`bridge:${bridge.id}`); },
      onControl: async control => { operations.push(`control:${control.id}`); },
      onTeardown: async id => { operations.push(`teardown:${id}`); },
      reserveRetry: async () => true,
    });
    expect(receipt.status).toBe('completed');
    expect(receipt.attempts['layer-1']).toBe(2);
    expect(receipt.bridges).toEqual(['a-to-b']);
    expect(receipt.controls).toEqual(['control']);
    expect(receipt.teardown).toEqual(['layer-1', 'layer-0']);
    expect(receipt.releasedResources).toEqual(['shared']);
    expect(receipt.acquiredResources).toEqual(['shared']);
    expect(attempts).toEqual(['layer-0:0', 'layer-1:1', 'layer-1:1']);
    expect(operations).toEqual([
      'tick:manual:a', 'acquire:shared', 'bridge:a-to-b', 'tick:audio:b',
      'control:control', 'teardown:layer-1', 'teardown:layer-0', 'release:shared',
    ]);
  });

  it('shares one recovery grant across every node in the candidate graph', async () => {
    const input = graph(2);
    input.retry = { maxAttempts: 2, backoffMs: 0 };
    const attempts = new Map<string, number>();
    let recoveryAvailable = true;
    const receipt = await executeCompositionGraph(
      planCompositionGraph(input).execution,
      async (node) => {
        attempts.set(node.id, (attempts.get(node.id) ?? 0) + 1);
        throw new Error('transient');
      },
      {
        continueOnError: true,
        reserveRetry: async () => {
          if (!recoveryAvailable) return false;
          recoveryAvailable = false;
          return true;
        },
      },
    );

    expect(receipt.status).toBe('failed');
    expect(attempts).toEqual(new Map([['layer-0', 2], ['layer-1', 1]]));
  });

  it('compiles controls and clock bridges into causal destination scheduling', () => {
    const controlled = graph(2);
    controlled.edges = [];
    controlled.budgets.maxEdges = 0;
    controlled.controls = [{
      id: 'control', from: { nodeId: 'layer-1', port: 'out', type: 'number' },
      to: { nodeId: 'layer-0', port: 'in', type: 'number' },
    }];
    expect(planCompositionGraph(controlled).schedule).toEqual(['layer-1', 'layer-0']);

    const bridged = graph(2);
    bridged.edges = [];
    bridged.budgets.maxEdges = 0;
    bridged.timingIslands = [
      { id: 'destination', clock: 'audio', nodeIds: ['layer-0'] },
      { id: 'source', clock: 'manual', nodeIds: ['layer-1'] },
    ];
    bridged.bridges = [{ id: 'bridge', fromIslandId: 'source', toIslandId: 'destination', mode: 'hold' }];
    expect(planCompositionGraph(bridged).schedule).toEqual(['layer-1', 'layer-0']);
  });

  it('applies controls and activates bridges before destination execution', async () => {
    const input = graph(2);
    input.controls = [{
      id: 'control', from: { nodeId: 'layer-0', port: 'out', type: 'number' },
      to: { nodeId: 'layer-1', port: 'in', type: 'number' },
    }];
    input.timingIslands = [
      { id: 'source', clock: 'manual', nodeIds: ['layer-0'] },
      { id: 'destination', clock: 'audio', nodeIds: ['layer-1'] },
    ];
    input.bridges = [{ id: 'bridge', fromIslandId: 'source', toIslandId: 'destination', mode: 'hold' }];
    const operations: string[] = [];
    await executeCompositionGraph(planCompositionGraph(input).execution, async node => {
      operations.push(`node:${node.id}`);
    }, {
      clock: { tick: async (_clock, id) => { operations.push(`tick:${id}`); } },
      onBridge: async bridge => { operations.push(`bridge:${bridge.id}`); },
      onControl: async control => { operations.push(`control:${control.id}`); },
    });
    expect(operations).toEqual([
      'tick:source', 'node:layer-0', 'bridge:bridge', 'tick:destination',
      'control:control', 'node:layer-1',
    ]);
  });

  it('cancels with teardown policy and preserves abort ordering', async () => {
    const input = graph(2);
    const plan = planCompositionGraph(input).execution;
    const controller = new AbortController();
    const operations: string[] = [];
    const receipt = await executeCompositionGraph(plan, async (node) => {
      if (node.id === 'layer-0') controller.abort();
    }, { signal: controller.signal, onTeardown: async id => { operations.push(`teardown:${id}`); } });
    expect(receipt.status).toBe('cancelled');
    expect(receipt.completed).toEqual(['layer-0']);
    expect(receipt.teardown).toEqual(['layer-0']);
    expect(operations).toEqual(['teardown:layer-0']);
  });

  it('retains cancellation evidence without teardown but always releases acquired resources', async () => {
    const input = graph(2);
    input.lifecycle = { cancelBehavior: 'retain-evidence' };
    input.resources = [{ id: 'shared', kind: 'shared', ownerNodeId: 'layer-0', shared: true }];
    const controller = new AbortController();
    const operations: string[] = [];
    const receipt = await executeCompositionGraph(planCompositionGraph(input).execution, async () => {
      controller.abort();
    }, {
      signal: controller.signal,
      onAcquireResource: async resource => { operations.push(`acquire:${resource.id}`); },
      onReleaseResource: async resource => { operations.push(`release:${resource.id}`); },
      onTeardown: async id => { operations.push(`teardown:${id}`); },
    });
    expect(receipt.status).toBe('cancelled');
    expect(receipt.teardown).toEqual([]);
    expect(operations).toEqual(['acquire:shared', 'release:shared']);
  });

  it('executes phase duration and timing cadence through deterministic seams', async () => {
    const input = graph(2);
    input.phases = [
      { id: 'first', order: 0, nodeIds: ['layer-0'], durationMs: 12, clock: 'manual' },
      { id: 'second', order: 1, nodeIds: ['layer-1'], startsAfter: ['first'], durationMs: 20 },
    ];
    input.timingIslands = [{ id: 'pulse', clock: 'interval', cadenceMs: 5, nodeIds: ['layer-1'] }];
    const operations: string[] = [];
    await executeCompositionGraph(planCompositionGraph(input).execution, async node => { operations.push(`node:${node.id}`); }, {
      scheduler: { wait: async ms => { operations.push(`wait:${ms}`); } },
      clock: { tick: async (clock, id) => { operations.push(`tick:${clock}:${id}`); } },
    });
    expect(operations).toEqual([
      'tick:manual:first', 'node:layer-0', 'wait:12', 'wait:5',
      'tick:interval:pulse', 'node:layer-1', 'wait:20',
    ]);
  });

  it('fails closed before execution when advanced handlers are missing', async () => {
    const input = graph(1);
    input.controls = [{ id: 'self-invalid', from: { nodeId: 'layer-0', port: 'a', type: 'number' }, to: { nodeId: 'layer-0', port: 'b', type: 'number' } }];
    expect(() => planCompositionGraph(input)).toThrow(/incompatible/);
    const resourceGraph = graph(1);
    resourceGraph.resources = [{ id: 'canvas', kind: 'canvas', ownerNodeId: 'layer-0' }];
    const executeNode = vi.fn(async () => undefined);
    await expect(executeCompositionGraph(planCompositionGraph(resourceGraph).execution, executeNode))
      .rejects.toThrow(/acquire and release/);
    expect(executeNode).not.toHaveBeenCalled();

    const lifecycleGraph = graph(1);
    lifecycleGraph.lifecycle = { teardownOrder: ['layer-0'] };
    await expect(executeCompositionGraph(planCompositionGraph(lifecycleGraph).execution, executeNode))
      .rejects.toThrow(/declared teardown handler/);
    expect(executeNode).not.toHaveBeenCalled();
  });

  it('propagates graph cancellation into an in-flight generator call', async () => {
    await registerAllGenerators();
    const entry = generatorRegistry.getAll().find(candidate => candidate.name === 'p5')!;
    const controller = new AbortController();
    let receivedSignal: AbortSignal | undefined;
    const generate = vi.spyOn(entry, 'generate').mockImplementation(async (_prompt, params) => {
      receivedSignal = params?.signal as AbortSignal;
      return await new Promise<string>((_resolve, reject) => {
        receivedSignal.addEventListener('abort', () => reject(new Error('provider aborted')), { once: true });
      });
    });
    try {
      const input = graph(1);
      const prepared = prepareComposition(input);
      prepared.signal = controller.signal;
      const pending = CompositionOrchestrator.compose(prepared);
      await vi.waitFor(() => expect(receivedSignal).toBe(controller.signal));
      controller.abort();
      const result = await pending;
      expect(result.graphExecution?.status).toBe('cancelled');
      expect(receivedSignal?.aborted).toBe(true);
    } finally {
      generate.mockRestore();
    }
  });

  it('never records advanced evidence when the corresponding operation fails', async () => {
    const input = graph(2);
    input.timingIslands = [
      { id: 'a', clock: 'manual', nodeIds: ['layer-0'] },
      { id: 'b', clock: 'audio', nodeIds: ['layer-1'] },
    ];
    input.bridges = [{ id: 'bridge', fromIslandId: 'a', toIslandId: 'b', mode: 'sample' }];
    const receipt = await executeCompositionGraph(planCompositionGraph(input).execution, async () => undefined, {
      clock: { tick: async () => undefined },
      onBridge: async () => { throw new Error('bridge failed'); },
    });
    expect(receipt.status).toBe('failed');
    expect(receipt.bridges).toEqual([]);
    expect(receipt.teardown).toEqual([]);
  });

  it('contracts only a true flat chain and rejects lossy V2 semantics explicitly', () => {
    const flat = planCompositionGraph(graph(3));
    const contracted = contractCompositionGraphToV1(flat);
    expect(contracted.layers.map(layer => layer.prompt))
      .toEqual(['layer 0', 'layer 1', 'layer 2']);
    expect(contracted).toMatchObject({ schemaVersion: '1.0', id: 'work-3' });
    expect(contracted).not.toHaveProperty('executionPlan');
    const advanced = graph(2);
    advanced.groups = [{ id: 'group', children: ['layer-0', 'layer-1'] }];
    const error = (() => contractCompositionGraphToV1(planCompositionGraph(advanced))) as () => unknown;
    expect(error).toThrow(CompositionGraphLossyError);
    expect(error).toThrow(/without loss/);
  });

  it('expands a legacy flat plan losslessly through the core preparation seam', () => {
    const prepared = prepareComposition({ title: 'legacy', layers: [
      { domain: 'html', prompt: 'existing', code: '<p>one</p>' },
      { domain: 'p5', prompt: 'existing', code: 'function draw(){}' },
    ] });
    expect(prepared.layers).toEqual([
      { domain: 'html', prompt: 'existing', code: '<p>one</p>' },
      { domain: 'p5', prompt: 'existing', code: 'function draw(){}' },
    ]);
    expect(prepared.executionPlan?.schedule).toEqual(['layer-0', 'layer-1']);
    const migrated = migrateCompositionGraph({
      schema: 'sinter.composition-graph', schemaVersion: '1.0', id: 'legacy-v1', layers: prepared.layers,
    });
    expect(migrated.id).toBe('legacy-v1');
    expect(migrated.nodes.map(node => node.layer)).toEqual(prepared.layers);
  });

  it('renders a deterministic no-spend multi-domain graph with execution evidence', async () => {
    const advanced = graphForArtifact();
    advanced.groups = [{ id: 'nested', children: ['layer-0', 'layer-1'] }];
    advanced.phases = [{ id: 'release', order: 0, nodeIds: ['layer-0', 'layer-1'], clock: 'manual' }];
    const previousGate = process.env.SINTER_COMPOSITE_GATE;
    process.env.SINTER_COMPOSITE_GATE = '0';
    await registerAllGenerators();
    const providerPaths = generatorRegistry.getAll()
      .filter(entry => entry.name === 'html' || entry.name === 'p5')
      .map(entry => vi.spyOn(entry, 'generate'));
    try {
      const prepared = prepareComposition(advanced);
      prepared.executionContext = { clock: { tick: async () => undefined } };
      const result = await CompositionOrchestrator.compose(prepared);
      expect(result.successCount).toBe(2);
      expect(result.graphExecution?.completed).toEqual(['layer-0', 'layer-1']);
      expect(result.html).toContain('sinter-graph-evidence');
      expect(result.html).toContain('nested');
      expect(providerPaths.every(providerPath => providerPath.mock.calls.length === 0)).toBe(true);
    } finally {
      providerPaths.forEach(providerPath => providerPath.mockRestore());
      if (previousGate === undefined) delete process.env.SINTER_COMPOSITE_GATE;
      else process.env.SINTER_COMPOSITE_GATE = previousGate;
    }
  });

  it('globally blocks every legacy creation seam after rollback while existing V2 stays readable', () => {
    const controller = new CompositionGraphRollbackController();
    const advanced = graph(1);
    advanced.phases = [{ id: 'phase', order: 0, nodeIds: ['layer-0'] }];
    controller.rollback();
    expect(() => controller.createV2FromLegacy({ layers: [advanced.nodes[0].layer] })).toThrow(/disabled/);
    expect(() => graphFromCompositionSpec({ layers: [advanced.nodes[0].layer] })).toThrow(/disabled/);
    expect(() => migrateCompositionGraph({ layers: [advanced.nodes[0].layer] })).toThrow(/disabled/);
    expect(() => prepareComposition({ layers: [advanced.nodes[0].layer] })).toThrow(/disabled/);
    expect(() => prepareComposition({ schema: 'sinter.composition-graph', schemaVersion: '1.0', layers: [advanced.nodes[0].layer] })).toThrow(/disabled/);
    expect(controller.exportV2(advanced).phases).toEqual(advanced.phases);
    expect(prepareComposition(advanced).executionPlan?.graphId).toBe(advanced.id);
  });
});

function graphForArtifact(): CompositionGraph {
  return {
    schema: 'sinter.composition-graph', schemaVersion: '2.0', status: 'ready', id: 'artifact',
    budgets: { maxNodes: 2, maxEdges: 1, maxProviderCalls: 0 },
    nodes: [
      { id: 'layer-0', type: 'layer', layer: { domain: 'html', prompt: 'base', code: '<div>base</div>' } },
      { id: 'layer-1', type: 'layer', layer: { domain: 'p5', prompt: 'detail', code: 'function draw(){}' } },
    ], edges: [{ id: 'order', type: 'before', from: 'layer-0', to: 'layer-1' }],
  };
}
