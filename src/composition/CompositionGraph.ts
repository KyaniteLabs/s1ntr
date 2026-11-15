import type {
  CompositionLayerSpec,
  CompositionSpec,
} from './CompositionOrchestrator.js';

export const COMPOSITION_GRAPH_SCHEMA = 'sinter.composition-graph' as const;
export const COMPOSITION_GRAPH_VERSION = '2.0' as const;

export interface CompositionGraphNode {
  id: string;
  type: 'layer';
  layer: CompositionLayerSpec;
  /** Optional temporal phase; omitted nodes belong to the implicit phase. */
  phaseId?: string;
}

export interface CompositionGraphEdge {
  id: string;
  type: 'before';
  from: string;
  to: string;
}

export interface CompositionGraphBudget {
  maxNodes: number;
  maxEdges: number;
  maxProviderCalls: number;
}

export type CompositionGraphClock = 'manual' | 'interval' | 'animation-frame' | 'audio';

export interface CompositionGraphGroup {
  id: string;
  children: string[];
  parentId?: string;
}

export interface CompositionGraphScene {
  id: string;
  children: string[];
  parentId?: string;
  background?: string;
}

export interface CompositionGraphPhase {
  id: string;
  order: number;
  nodeIds: string[];
  startsAfter?: string[];
  durationMs?: number;
  clock?: CompositionGraphClock;
}

export interface CompositionGraphControl {
  id: string;
  from: { nodeId: string; port: string; type: 'number' | 'string' | 'boolean' };
  to: { nodeId: string; port: string; type: 'number' | 'string' | 'boolean' };
  scale?: number;
  offset?: number;
}

export interface CompositionGraphResource {
  id: string;
  kind: 'canvas' | 'audio-context' | 'timer' | 'subscription' | 'shared' | 'other';
  ownerNodeId: string;
  shared?: boolean;
}

export interface CompositionTimingIsland {
  id: string;
  clock: CompositionGraphClock;
  nodeIds: string[];
  cadenceMs?: number;
}

export interface CompositionClockBridge {
  id: string;
  fromIslandId: string;
  toIslandId: string;
  mode: 'sample' | 'hold' | 'interpolate';
}

export interface CompositionGraphRetryPolicy {
  maxAttempts: number;
  retryable?: Array<'transient' | 'timeout' | 'resource' | 'unknown'>;
  backoffMs?: number;
}

export interface CompositionGraphLifecycle {
  teardownOrder?: string[];
  cancelBehavior?: 'teardown' | 'retain-evidence';
}

export interface CompositionGraphExecutionNode {
  id: string;
  sourceIndex: number;
  layer: CompositionLayerSpec;
  phaseId: string;
}

export interface CompositionGraphExecutionPlan {
  graphId: string;
  nodes: CompositionGraphExecutionNode[];
  schedule: string[];
  groups: CompositionGraphGroup[];
  scenes: CompositionGraphScene[];
  phases: CompositionGraphPhase[];
  controls: CompositionGraphControl[];
  resources: CompositionGraphResource[];
  timingIslands: CompositionTimingIsland[];
  bridges: CompositionClockBridge[];
  retry: CompositionGraphRetryPolicy;
  lifecycle: {
    teardownOrder: string[];
    cancelBehavior: 'teardown' | 'retain-evidence';
    teardownRequired: boolean;
  };
}

export interface GraphExecutionReceipt {
  graphId: string;
  status: 'completed' | 'failed' | 'cancelled';
  started: string[];
  completed: string[];
  failed: string[];
  attempts: Record<string, number>;
  acquiredResources: string[];
  teardown: string[];
  releasedResources: string[];
  bridges: string[];
  controls: string[];
}

export class CompositionGraphAbortError extends Error {
  constructor() {
    super('Composition graph execution cancelled');
    this.name = 'AbortError';
  }
}

export class CompositionGraphLossyError extends Error {
  readonly code = 'LOSSY_V1_CONTRACT';

  constructor(reason: string) {
    super(`Composition graph cannot contract to V1 without loss: ${reason}`);
    this.name = 'CompositionGraphLossyError';
  }
}

export interface GraphNodeExecutionContext {
  phaseId: string;
  attempt: number;
  signal?: AbortSignal;
  resourceIds: string[];
}

export interface GraphExecutionOptions {
  signal?: AbortSignal;
  continueOnError?: boolean;
  onNodeError?: (nodeId: string, error: Error) => void;
  scheduler?: { wait: (milliseconds: number, signal?: AbortSignal) => Promise<void> };
  clock?: { tick: (clock: CompositionGraphClock, id: string, signal?: AbortSignal) => Promise<void> };
  onAcquireResource?: (resource: CompositionGraphResource) => void | Promise<void>;
  onTeardown?: (nodeId: string) => void | Promise<void>;
  onReleaseResource?: (resource: CompositionGraphResource) => void | Promise<void>;
  onBridge?: (bridge: CompositionClockBridge) => void | Promise<void>;
  onControl?: (control: CompositionGraphControl) => void | Promise<void>;
  /** Shared candidate recovery authority; false prevents every later node retry. */
  reserveRetry?: (nodeId: string, failedAttempt: number, nextAttempt: number) => boolean | Promise<boolean>;
}

export interface CompositionGraph {
  schema: typeof COMPOSITION_GRAPH_SCHEMA;
  schemaVersion: typeof COMPOSITION_GRAPH_VERSION;
  status: 'draft' | 'ready';
  id: string;
  title?: string;
  background?: string;
  creativeThesis?: CompositionSpec['creativeThesis'];
  budgets: CompositionGraphBudget;
  nodes: CompositionGraphNode[];
  edges: CompositionGraphEdge[];
  groups?: CompositionGraphGroup[];
  scenes?: CompositionGraphScene[];
  phases?: CompositionGraphPhase[];
  controls?: CompositionGraphControl[];
  resources?: CompositionGraphResource[];
  timingIslands?: CompositionTimingIsland[];
  bridges?: CompositionClockBridge[];
  retry?: CompositionGraphRetryPolicy;
  lifecycle?: CompositionGraphLifecycle;
}

export interface PlannedCompositionGraph {
  graph: CompositionGraph;
  schedule: string[];
  usage: { nodes: number; edges: number; providerCalls: number };
  execution: CompositionGraphExecutionPlan;
}

export interface LegacyCompositionGraphV1 {
  schema: typeof COMPOSITION_GRAPH_SCHEMA;
  schemaVersion: '1.0';
  id?: string;
  title?: string;
  background?: string;
  maxProviderCalls?: number;
  layers: CompositionLayerSpec[];
}

export type CompositionRequest = CompositionSpec | CompositionGraph | LegacyCompositionGraphV1;

const ID = /^[a-z][a-z0-9-]*$/;
const DOMAINS = new Set([
  'p5', 'three', 'shader', 'tone', 'music', 'strudel', 'hydra', 'ascii',
  'video', 'html', 'textgen', 'group',
]);
const BLEND_MODES = new Set(['normal', 'multiply', 'screen', 'overlay', 'darken', 'lighten', 'difference', 'exclusion']);

function requireUniqueIds(items: Array<{ id: string }>, label: string): void {
  const ids = new Set<string>();
  for (const item of items) {
    if (!ID.test(item.id) || ids.has(item.id)) {
      throw new Error(`Composition graph has invalid or duplicate ${label} id: ${item.id}`);
    }
    ids.add(item.id);
  }
}

function requireBudget(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Composition graph budget ${label} must be a non-negative integer`);
  }
}

function requireAdvancedReferences(graph: CompositionGraph): void {
  const nodeIds = new Set(graph.nodes.map(node => node.id));
  const groups = graph.groups ?? [];
  const scenes = graph.scenes ?? [];
  const containerIds = new Set([...groups, ...scenes].map(container => container.id));
  if (containerIds.size !== groups.length + scenes.length) {
    throw new Error('Composition graph groups and scenes must have unique ids');
  }
  if ([...containerIds].some(id => nodeIds.has(id))) {
    throw new Error('Composition graph containers cannot reuse node ids');
  }
  for (const container of [...groups, ...scenes]) {
    if (!ID.test(container.id) || container.children.length === 0) {
      throw new Error(`Composition graph container ${container.id} is invalid`);
    }
    for (const child of container.children) {
      if (!nodeIds.has(child) && !containerIds.has(child)) {
        throw new Error(`Composition graph container ${container.id} references ${child}`);
      }
    }
    if (container.parentId && !containerIds.has(container.parentId)) {
      throw new Error(`Composition graph container ${container.id} has an invalid parent`);
    }
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const memberships = new Map<string, string>();
  const children = new Map([...groups, ...scenes].map(container => [container.id, container.children]));
  for (const container of [...groups, ...scenes]) for (const child of container.children) {
    const parent = memberships.get(child);
    if (parent && parent !== container.id) throw new Error(`Composition graph child ${child} has multiple parents`);
    memberships.set(child, container.id);
  }
  for (const container of [...groups, ...scenes]) if (container.parentId
    && memberships.get(container.id) !== container.parentId) {
    throw new Error(`Composition graph container ${container.id} has a mismatched parent`);
  }
  const visit = (id: string): void => {
    if (visiting.has(id)) throw new Error('Composition graph containers contain a cycle');
    if (visited.has(id)) return;
    visiting.add(id);
    for (const child of children.get(id) ?? []) if (children.has(child)) visit(child);
    visiting.delete(id);
    visited.add(id);
  };
  for (const id of children.keys()) visit(id);
}

function validateAdvancedSemantics(graph: CompositionGraph): void {
  requireAdvancedReferences(graph);
  const nodeIds = new Set(graph.nodes.map(node => node.id));
  const phases = graph.phases ?? [];
  requireUniqueIds(phases, 'phase');
  const phaseIds = new Set(phases.map(phase => phase.id));
  if (new Set(phases.map(phase => phase.order)).size !== phases.length) {
    throw new Error('Composition graph phases must have unique order values');
  }
  const phaseNodes = new Set<string>();
  for (const phase of phases) {
    if (!Number.isSafeInteger(phase.order) || phase.order < 0 || phase.nodeIds.length === 0) {
      throw new Error(`Composition graph phase ${phase.id} is invalid`);
    }
    if (phase.clock && !['manual', 'interval', 'animation-frame', 'audio'].includes(phase.clock)) {
      throw new Error(`Composition graph phase ${phase.id} has an invalid clock`);
    }
    if (phase.durationMs !== undefined && (!Number.isFinite(phase.durationMs) || phase.durationMs < 0)) {
      throw new Error(`Composition graph phase ${phase.id} has an invalid duration`);
    }
    for (const nodeId of phase.nodeIds) {
      if (!nodeIds.has(nodeId) || phaseNodes.has(nodeId)) throw new Error(`Composition graph phase ${phase.id} has an invalid node membership`);
      phaseNodes.add(nodeId);
    }
    for (const dependency of phase.startsAfter ?? []) if (!phaseIds.has(dependency)) {
      throw new Error(`Composition graph phase ${phase.id} references ${dependency}`);
    }
  }
  for (const node of graph.nodes) if (node.phaseId && !phaseIds.has(node.phaseId)) {
    throw new Error(`Composition graph node ${node.id} references ${node.phaseId}`);
  }
  for (const node of graph.nodes) {
    const phase = phases.find(candidate => candidate.nodeIds.includes(node.id));
    if (phase && node.phaseId && phase.id !== node.phaseId) {
      throw new Error(`Composition graph node ${node.id} has conflicting phase membership`);
    }
  }
}

function validateRuntimeContracts(graph: CompositionGraph): void {
  const nodeIds = new Set(graph.nodes.map(node => node.id));
  const controls = graph.controls ?? [];
  requireUniqueIds(controls, 'control');
  for (const control of controls) {
    if (!nodeIds.has(control.from.nodeId) || !nodeIds.has(control.to.nodeId)
      || control.from.nodeId === control.to.nodeId || control.from.type !== control.to.type) {
      throw new Error(`Composition graph control ${control.id} has incompatible endpoints`);
    }
    if ((control.scale !== undefined && !Number.isFinite(control.scale))
      || (control.offset !== undefined && !Number.isFinite(control.offset))) {
      throw new Error(`Composition graph control ${control.id} has an invalid transform`);
    }
  }
  const resources = graph.resources ?? [];
  requireUniqueIds(resources, 'resource');
  for (const resource of resources) if (!nodeIds.has(resource.ownerNodeId)) {
    throw new Error(`Composition graph resource ${resource.id} has no valid owner`);
  }
  const islands = graph.timingIslands ?? [];
  requireUniqueIds(islands, 'timing island');
  const islandIds = new Set(islands.map(island => island.id));
  for (const island of islands) {
    if (!['manual', 'interval', 'animation-frame', 'audio'].includes(island.clock)
      || island.nodeIds.some(nodeId => !nodeIds.has(nodeId))) throw new Error(`Composition graph timing island ${island.id} is invalid`);
    if (island.cadenceMs !== undefined && (!Number.isFinite(island.cadenceMs) || island.cadenceMs <= 0)) {
      throw new Error(`Composition graph timing island ${island.id} has an invalid cadence`);
    }
  }
  const bridges = graph.bridges ?? [];
  requireUniqueIds(bridges, 'bridge');
  for (const bridge of bridges) if (!islandIds.has(bridge.fromIslandId) || !islandIds.has(bridge.toIslandId)
    || bridge.fromIslandId === bridge.toIslandId) {
    throw new Error(`Composition graph bridge ${bridge.id} references an invalid timing island`);
  }
  const retry = graph.retry ?? { maxAttempts: 1 };
  if (!Number.isSafeInteger(retry.maxAttempts) || retry.maxAttempts < 1
    || (retry.backoffMs !== undefined && (!Number.isFinite(retry.backoffMs) || retry.backoffMs < 0))) {
    throw new Error('Composition graph retry policy is invalid');
  }
  const teardown = graph.lifecycle?.teardownOrder;
  if (teardown && (teardown.length !== nodeIds.size || new Set(teardown).size !== teardown.length
    || teardown.some(id => !nodeIds.has(id)))) {
    throw new Error('Composition graph teardown order references invalid nodes');
  }
}

function executionPhases(graph: CompositionGraph, schedule: string[]): CompositionGraphPhase[] {
  const phases = (graph.phases ?? []).map(phase => ({ ...phase, nodeIds: [...phase.nodeIds] }));
  for (const node of graph.nodes) {
    if (!node.phaseId) continue;
    const phase = phases.find(candidate => candidate.id === node.phaseId);
    if (phase && !phase.nodeIds.includes(node.id)) phase.nodeIds.push(node.id);
  }
  const explicit = new Set(phases.flatMap(phase => phase.nodeIds));
  const implicitNodes = schedule.filter(nodeId => !explicit.has(nodeId)
    && !graph.nodes.find(node => node.id === nodeId)?.phaseId);
  if (implicitNodes.length > 0) phases.push({ id: 'phase-implicit', order: -1, nodeIds: implicitNodes });
  const byId = new Map(phases.map(phase => [phase.id, phase]));
  const pending = new Set(phases.map(phase => phase.id));
  const ordered: CompositionGraphPhase[] = [];
  while (pending.size > 0) {
    const ready = [...pending].filter(id => (byId.get(id)?.startsAfter ?? []).every(dep => !pending.has(dep)));
    if (ready.length === 0) throw new Error('Composition graph phases contain a cycle');
    ready.sort((a, b) => (byId.get(a)!.order - byId.get(b)!.order) || a.localeCompare(b));
    for (const id of ready) {
      pending.delete(id);
      ordered.push(byId.get(id)!);
    }
  }
  return ordered;
}

function buildExecutionPlan(
  graph: CompositionGraph,
  schedule: string[],
): CompositionGraphExecutionPlan {
  const phases = executionPhases(graph, schedule);
  const phaseByNode = new Map(phases.flatMap(phase => phase.nodeIds.map(nodeId => [nodeId, phase.id] as const)));
  return {
    graphId: graph.id,
    nodes: schedule.map(id => ({
      id,
      sourceIndex: schedule.indexOf(id),
      layer: graph.nodes.find(node => node.id === id)!.layer,
      phaseId: phaseByNode.get(id) ?? 'phase-implicit',
    })),
    schedule,
    groups: [...(graph.groups ?? [])],
    scenes: [...(graph.scenes ?? [])],
    phases,
    controls: [...(graph.controls ?? [])],
    resources: [...(graph.resources ?? [])],
    timingIslands: [...(graph.timingIslands ?? [])],
    bridges: [...(graph.bridges ?? [])],
    retry: { maxAttempts: 1, ...(graph.retry ?? {}) },
    lifecycle: {
      teardownOrder: graph.lifecycle?.teardownOrder ?? [...schedule].reverse(),
      cancelBehavior: graph.lifecycle?.cancelBehavior ?? 'teardown',
      teardownRequired: graph.lifecycle !== undefined,
    },
  };
}

function retryableGraphError(error: unknown, policy: CompositionGraphRetryPolicy): boolean {
  if (!policy.retryable || policy.retryable.length === 0) return true;
  const message = error instanceof Error ? `${error.name} ${error.message}`.toLowerCase() : String(error).toLowerCase();
  const kind = message.includes('timeout') ? 'timeout' : message.includes('resource') ? 'resource' : 'transient';
  return policy.retryable.includes(kind) || policy.retryable.includes('unknown');
}

function graphAbort(signal?: AbortSignal): void {
  if (signal?.aborted) throw new CompositionGraphAbortError();
}

async function graphDelay(delayMs: number, signal?: AbortSignal): Promise<void> {
  if (delayMs <= 0) return graphAbort(signal);
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve(); }, delayMs);
    const abort = () => { clearTimeout(timer); reject(new CompositionGraphAbortError()); };
    signal?.addEventListener('abort', abort, { once: true });
  });
}

export async function executeCompositionGraph(
  plan: CompositionGraphExecutionPlan,
  executeNode: (node: CompositionGraphExecutionNode, context: GraphNodeExecutionContext) => Promise<void>,
  options: GraphExecutionOptions = {},
): Promise<GraphExecutionReceipt> {
  const receipt: GraphExecutionReceipt = {
    graphId: plan.graphId, status: 'completed', started: [], completed: [], failed: [],
    attempts: {}, acquiredResources: [], teardown: [], releasedResources: [], bridges: [], controls: [],
  };
  const started = new Set<string>();
  const resources = new Map(plan.resources.map(resource => [resource.id, resource]));
  const acquired = new Set<string>();
  const nodeById = new Map(plan.nodes.map(node => [node.id, node]));
  const islandByNode = new Map(plan.timingIslands.flatMap(island => island.nodeIds.map(id => [id, island.id] as const)));
  let terminalStatus: GraphExecutionReceipt['status'] = 'completed';
  const advanced = plan.phases.some(phase => phase.durationMs !== undefined || phase.clock !== undefined)
    || plan.timingIslands.length > 0 || plan.resources.length > 0 || plan.controls.length > 0
    || plan.bridges.length > 0;
  if (advanced) {
    if ((plan.phases.some(phase => phase.durationMs !== undefined) || plan.timingIslands.some(island => island.cadenceMs !== undefined)) && !options.scheduler) {
      throw new Error('Composition graph execution requires a deterministic scheduler');
    }
    if ((plan.phases.some(phase => phase.clock !== undefined) || plan.timingIslands.length > 0) && !options.clock) {
      throw new Error('Composition graph execution requires a deterministic clock');
    }
    if (plan.resources.length > 0 && (!options.onAcquireResource || !options.onReleaseResource)) {
      throw new Error('Composition graph execution requires resource acquire and release handlers');
    }
    if (plan.controls.length > 0 && !options.onControl) throw new Error('Composition graph execution requires a control handler');
    if (plan.bridges.length > 0 && !options.onBridge) throw new Error('Composition graph execution requires a clock bridge handler');
  }
  if (plan.lifecycle.teardownRequired && !options.onTeardown) {
    throw new Error('Composition graph execution requires the declared teardown handler');
  }
  const activateBridges = async (nodeId: string): Promise<void> => {
    const destinationIsland = islandByNode.get(nodeId);
    for (const bridge of plan.bridges) {
      if (receipt.bridges.includes(bridge.id)) continue;
      if (destinationIsland === bridge.toIslandId) {
        await options.onBridge!(bridge);
        receipt.bridges.push(bridge.id);
      }
    }
  };
  const applyControls = async (nodeId: string): Promise<void> => {
    for (const control of plan.controls) {
      if (receipt.controls.includes(control.id) || control.to.nodeId !== nodeId) continue;
      await options.onControl!(control);
      receipt.controls.push(control.id);
    }
  };
  try {
    let activePhase: string | undefined;
    for (const id of plan.schedule) {
      graphAbort(options.signal);
      const node = nodeById.get(id)!;
      if (node.phaseId !== activePhase) {
        const previous = plan.phases.find(phase => phase.id === activePhase);
        activePhase = node.phaseId;
        if (previous?.durationMs !== undefined) await options.scheduler!.wait(previous.durationMs, options.signal);
        const phase = plan.phases.find(candidate => candidate.id === activePhase);
        if (phase?.clock) await options.clock!.tick(phase.clock, phase.id, options.signal);
      }
      await activateBridges(id);
      const island = plan.timingIslands.find(candidate => candidate.nodeIds.includes(id));
      if (island) {
        if (island.cadenceMs !== undefined) await options.scheduler!.wait(island.cadenceMs, options.signal);
        await options.clock!.tick(island.clock, island.id, options.signal);
      }
      const owned = plan.resources
        .filter(resource => resource.ownerNodeId === id || resource.shared)
        .map(resource => resource.id);
      for (const resourceId of owned) if (!acquired.has(resourceId)) {
        const resource = resources.get(resourceId)!;
        await options.onAcquireResource!(resource);
        acquired.add(resourceId);
        receipt.acquiredResources.push(resourceId);
      }
      await applyControls(id);
      started.add(id);
      receipt.started.push(id);
      let success = false;
      for (let attempt = 1; attempt <= plan.retry.maxAttempts; attempt++) {
        receipt.attempts[id] = attempt;
        try {
          await executeNode(node, { phaseId: node.phaseId, attempt, signal: options.signal, resourceIds: owned });
          receipt.completed.push(id);
          success = true;
          break;
        } catch (error) {
          if (error instanceof CompositionGraphAbortError || options.signal?.aborted) throw new CompositionGraphAbortError();
          if (attempt >= plan.retry.maxAttempts || !retryableGraphError(error, plan.retry)) {
            const normalized = error instanceof Error ? error : new Error(String(error));
            receipt.failed.push(id);
            options.onNodeError?.(id, normalized);
            break;
          } else {
            const granted = await options.reserveRetry?.(id, attempt, attempt + 1) ?? false;
            if (!granted) {
              const normalized = error instanceof Error ? error : new Error(String(error));
              receipt.failed.push(id);
              options.onNodeError?.(id, normalized);
              break;
            }
            await graphDelay(plan.retry.backoffMs ?? 0, options.signal);
          }
        }
      }
      if (!success && options.continueOnError !== true) break;
    }
    const finalPhase = plan.phases.find(phase => phase.id === activePhase);
    if (finalPhase?.durationMs !== undefined) await options.scheduler!.wait(finalPhase.durationMs, options.signal);
  } catch (error) {
    terminalStatus = error instanceof CompositionGraphAbortError ? 'cancelled' : 'failed';
  }
  if (receipt.failed.length > 0 && terminalStatus === 'completed') terminalStatus = 'failed';
  const shouldTeardown = terminalStatus !== 'cancelled' || plan.lifecycle.cancelBehavior === 'teardown';
  const teardownOrder = shouldTeardown ? plan.lifecycle.teardownOrder.filter(id => started.has(id)) : [];
  for (const id of teardownOrder) {
    try {
      if (options.onTeardown) {
        await options.onTeardown(id);
        receipt.teardown.push(id);
      }
    } catch { terminalStatus = 'failed'; }
  }
  for (const resource of [...resources.values()].reverse()) {
    if (!acquired.has(resource.id)) continue;
    try {
      await options.onReleaseResource!(resource);
      receipt.releasedResources.push(resource.id);
    } catch { terminalStatus = 'failed'; }
  }
  return { ...receipt, status: terminalStatus };
}

function validateShape(graph: CompositionGraph): void {
  if (graph.schema !== COMPOSITION_GRAPH_SCHEMA || graph.schemaVersion !== COMPOSITION_GRAPH_VERSION) {
    throw new Error('Unsupported composition graph version');
  }
  if (graph.status !== 'ready') throw new Error('Draft composition graphs cannot execute');
  if (!ID.test(graph.id) || !Array.isArray(graph.nodes) || graph.nodes.length === 0) {
    throw new Error('Composition graph needs a valid id and at least one node');
  }
  if (!Array.isArray(graph.edges) || !graph.budgets) {
    throw new Error('Composition graph requires edges and explicit budgets');
  }
  requireUniqueIds(graph.nodes, 'node');
  requireUniqueIds(graph.edges, 'edge');
  requireBudget(graph.budgets.maxNodes, 'maxNodes');
  requireBudget(graph.budgets.maxEdges, 'maxEdges');
  requireBudget(graph.budgets.maxProviderCalls, 'maxProviderCalls');
  for (const node of graph.nodes) {
    const layer = node.layer;
    if (node.type !== 'layer' || !layer || !DOMAINS.has(layer.domain)) {
      throw new Error(`Composition graph node ${node.id} has an invalid layer type or domain`);
    }
    if (!layer.prompt?.trim() && !layer.code?.trim()) {
      throw new Error(`Composition graph node ${node.id} needs a prompt or code`);
    }
    if (layer.blendMode !== undefined && !BLEND_MODES.has(layer.blendMode)) {
      throw new Error(`Composition graph node ${node.id} has an invalid blend mode`);
    }
    if (layer.opacity !== undefined
      && (!Number.isFinite(layer.opacity) || layer.opacity < 0 || layer.opacity > 1)) {
      throw new Error(`Composition graph node ${node.id} has invalid opacity`);
    }
  }
  validateAdvancedSemantics(graph);
  validateRuntimeContracts(graph);
}

export function planCompositionGraph(graph: CompositionGraph): PlannedCompositionGraph {
  validateShape(graph);
  const nodeIds = new Set(graph.nodes.map(node => node.id));
  const relations = new Set<string>();
  const outgoing = new Map(graph.nodes.map(node => [node.id, [] as string[]]));
  const indegree = new Map(graph.nodes.map(node => [node.id, 0]));
  for (const edge of graph.edges) {
    if (edge.type !== 'before' || !nodeIds.has(edge.from) || !nodeIds.has(edge.to)) {
      throw new Error(`Composition graph edge ${edge.id} has an invalid reference or type`);
    }
    const relation = `${edge.from}\0${edge.to}`;
    if (relations.has(relation)) throw new Error(`Duplicate scheduling relation: ${edge.from} -> ${edge.to}`);
    relations.add(relation);
    outgoing.get(edge.from)?.push(edge.to);
    indegree.set(edge.to, (indegree.get(edge.to) ?? 0) + 1);
  }
  const addCausalRelation = (from: string, to: string, label: string): void => {
    const relation = `${from}\0${to}`;
    if (relations.has(relation)) return;
    if (from === to) throw new Error(`Composition graph ${label} creates a self dependency`);
    relations.add(relation);
    outgoing.get(from)!.push(to);
    indegree.set(to, (indegree.get(to) ?? 0) + 1);
  };
  for (const control of graph.controls ?? []) {
    addCausalRelation(control.from.nodeId, control.to.nodeId, `control ${control.id}`);
  }
  const islands = new Map((graph.timingIslands ?? []).map(island => [island.id, island]));
  for (const bridge of graph.bridges ?? []) {
    for (const from of islands.get(bridge.fromIslandId)!.nodeIds) {
      for (const to of islands.get(bridge.toIslandId)!.nodeIds) {
        addCausalRelation(from, to, `bridge ${bridge.id}`);
      }
    }
  }
  const usage = {
    nodes: graph.nodes.length,
    edges: graph.edges.length,
    providerCalls: graph.nodes.filter(node => !node.layer.code?.trim()).length,
  };
  if (usage.nodes > graph.budgets.maxNodes
    || usage.edges > graph.budgets.maxEdges
    || usage.providerCalls > graph.budgets.maxProviderCalls) {
    throw new Error('Composition graph exceeds its explicit execution budget');
  }
  const ready = [...nodeIds].filter(id => indegree.get(id) === 0).sort();
  const schedule: string[] = [];
  while (ready.length > 0) {
    const id = ready.shift();
    if (!id) break;
    schedule.push(id);
    for (const target of [...(outgoing.get(id) ?? [])].sort()) {
      const remaining = (indegree.get(target) ?? 0) - 1;
      indegree.set(target, remaining);
      if (remaining === 0) {
        ready.push(target);
        ready.sort();
      }
    }
  }
  if (schedule.length !== graph.nodes.length) throw new Error('Composition graph contains an unbounded cycle');
  const phases = executionPhases(graph, schedule);
  const phaseRank = new Map(phases.flatMap((phase, index) => phase.nodeIds.map(id => [id, index] as const)));
  for (const relation of relations) {
    const [from, to] = relation.split('\0');
    const fromRank = phaseRank.get(from);
    const toRank = phaseRank.get(to);
    if (fromRank !== undefined && toRank !== undefined && fromRank > toRank) {
      throw new Error(`Composition graph dependency crosses phases backwards: ${from} -> ${to}`);
    }
  }
  const baseRank = new Map(schedule.map((id, index) => [id, index] as const));
  schedule.sort((a, b) => (phaseRank.get(a) ?? 0) - (phaseRank.get(b) ?? 0)
    || baseRank.get(a)! - baseRank.get(b)!);
  return { graph, schedule, usage, execution: buildExecutionPlan(graph, schedule) };
}

function assertFlatRepresentable(plan: PlannedCompositionGraph): void {
  const graph = plan.graph;
  if ((graph.groups?.length ?? 0) || (graph.scenes?.length ?? 0) || (graph.phases?.length ?? 0)
    || (graph.controls?.length ?? 0) || (graph.resources?.length ?? 0)
    || (graph.timingIslands?.length ?? 0) || (graph.bridges?.length ?? 0)) {
    throw new CompositionGraphLossyError('nested, temporal, control, resource, or clock semantics are present');
  }
  if (graph.retry && (graph.retry.maxAttempts !== 1 || graph.retry.backoffMs !== undefined)) {
    throw new CompositionGraphLossyError('retry behavior is not representable by a flat plan');
  }
  if (graph.lifecycle?.teardownOrder || graph.lifecycle?.cancelBehavior) {
    throw new CompositionGraphLossyError('custom lifecycle semantics are present');
  }
  if (graph.nodes.some(node => node.phaseId)) throw new CompositionGraphLossyError('node phases are present');
  const expected = plan.schedule.slice(1).map((to, index) => `${plan.schedule[index]}\0${to}`);
  const actual = graph.edges.map(edge => `${edge.from}\0${edge.to}`);
  if (actual.length !== expected.length || actual.some(relation => !expected.includes(relation))) {
    throw new CompositionGraphLossyError('dependencies are not a single flat order');
  }
}

export function lowerCompositionGraphForExecution(plan: PlannedCompositionGraph): CompositionSpec {
  const byId = new Map(plan.graph.nodes.map(node => [node.id, node]));
  return {
    title: plan.graph.title,
    background: plan.graph.background,
    creativeThesis: plan.graph.creativeThesis,
    maxProviderCalls: plan.graph.budgets.maxProviderCalls,
    executionPlan: plan.execution,
    layers: plan.schedule.map(id => {
      const node = byId.get(id);
      if (!node) throw new Error(`Scheduled composition node is missing: ${id}`);
      return { ...node.layer };
    }),
  };
}

export function lowerCompositionGraph(plan: PlannedCompositionGraph): CompositionSpec {
  assertFlatRepresentable(plan);
  return lowerCompositionGraphForExecution(plan);
}

export function contractCompositionGraphToV1(plan: PlannedCompositionGraph): LegacyCompositionGraphV1 {
  assertFlatRepresentable(plan);
  return {
    schema: COMPOSITION_GRAPH_SCHEMA,
    schemaVersion: '1.0',
    id: plan.graph.id,
    title: plan.graph.title,
    background: plan.graph.background,
    maxProviderCalls: plan.graph.budgets.maxProviderCalls,
    layers: plan.schedule.map(id => ({ ...plan.graph.nodes.find(node => node.id === id)!.layer })),
  };
}

export function graphFromCompositionSpec(spec: CompositionSpec): CompositionGraph {
  assertV2CreationEnabled();
  if (!Array.isArray(spec.layers) || spec.layers.length === 0) {
    throw new Error('Composition spec must contain at least one layer');
  }
  const nodes = spec.layers.map((layer, index) => ({
    id: `layer-${index}`,
    type: 'layer' as const,
    layer: { ...layer },
  }));
  const edges = nodes.slice(1).map((node, index) => ({
    id: `order-${index}`,
    type: 'before' as const,
    from: nodes[index].id,
    to: node.id,
  }));
  return {
    schema: COMPOSITION_GRAPH_SCHEMA,
    schemaVersion: COMPOSITION_GRAPH_VERSION,
    status: 'ready',
    id: 'legacy-composition',
    title: spec.title,
    background: spec.background,
    creativeThesis: spec.creativeThesis,
    budgets: {
      maxNodes: nodes.length,
      maxEdges: edges.length,
      maxProviderCalls: spec.maxProviderCalls
        ?? nodes.filter(node => !node.layer.code?.trim()).length,
    },
    nodes,
    edges,
  };
}

export function migrateCompositionGraph(input: LegacyCompositionGraphV1 | CompositionSpec): CompositionGraph {
  assertV2CreationEnabled();
  if ('schema' in input) {
    if (input.schema !== COMPOSITION_GRAPH_SCHEMA || input.schemaVersion !== '1.0') {
      throw new Error('Unsupported legacy composition graph version');
    }
    const graph = graphFromCompositionSpec(input);
    return { ...graph, id: input.id ?? graph.id, title: input.title, background: input.background };
  }
  return graphFromCompositionSpec(input);
}

export interface CompositionGraphRollbackState {
  v2CreationEnabled: boolean;
  v2ReadOnly: boolean;
}

let v2CreationEnabled = true;

export class CompositionGraphRollbackController {
  rollback(): CompositionGraphRollbackState {
    v2CreationEnabled = false;
    return this.state();
  }

  state(): CompositionGraphRollbackState {
    return { v2CreationEnabled, v2ReadOnly: true };
  }

  createV2FromLegacy(spec: CompositionSpec | LegacyCompositionGraphV1): CompositionGraph {
    return migrateCompositionGraph(spec);
  }

  readV2(graph: CompositionGraph): CompositionGraph {
    planCompositionGraph(graph);
    return structuredClone(graph);
  }

  renderV2(graph: CompositionGraph): CompositionSpec {
    return lowerCompositionGraphForExecution(planCompositionGraph(this.readV2(graph)));
  }

  exportV2(graph: CompositionGraph): CompositionGraph {
    return this.readV2(graph);
  }
}

function assertV2CreationEnabled(): void {
  if (!v2CreationEnabled) {
    throw new Error('Composition graph V2 creation is disabled after rollback');
  }
}

export function prepareComposition(request: CompositionRequest): CompositionSpec {
  const policy = new CompositionGraphRollbackController();
  const graph = 'schema' in request && request.schemaVersion === COMPOSITION_GRAPH_VERSION
    ? policy.readV2(request)
    : policy.createV2FromLegacy(request);
  return lowerCompositionGraphForExecution(planCompositionGraph(graph));
}
