/**
 * W9C-03: Multi-node campaign brief freeze for the Wave 9 creative beauty campaign.
 *
 * Three briefs with multi-node composition graphs using the real CompositionGraph
 * type (schema 'sinter.composition-graph' v2.0):
 * 1. Temporal audiovisual instrument (5 nodes, shared controls + timing islands)
 * 2. Narrative kinetic environment (4 nodes, phased scenes + shared control)
 * 3. Emergent information artwork (3 nodes, data-driven generative motion)
 *
 * Briefs 1 and 2 exceed 4 nodes; Brief 3 is deliberately simpler.
 */
import type { CompositionGraph, CompositionGraphNode, CompositionGraphEdge } from '../composition/CompositionGraph.js';

export interface W9BriefSpec {
  id: string;
  title: string;
  description: string;
  medium: string;
  thesis: string;
  graph: CompositionGraph;
  audioRequired: boolean;
  interactionRequired: boolean;
}

const SCHEMA = 'sinter.composition-graph' as const;
const VERSION = '2.0' as const;

function node(id: string, domain: string, prompt: string): CompositionGraphNode {
  return { id, type: 'layer' as const, layer: { domain: domain as never, prompt } };
}

function edge(id: string, from: string, to: string): CompositionGraphEdge {
  return { id, type: 'before' as const, from, to };
}

// ─── Brief 1: Temporal Audiovisual Instrument (5 nodes) ───────────────────
const temporalGraph: CompositionGraph = {
  schema: SCHEMA, schemaVersion: VERSION, status: 'ready', id: 'w9-temporal',
  title: 'Temporal Audiovisual Instrument',
  budgets: { maxNodes: 5, maxEdges: 4, maxProviderCalls: 5 },
  nodes: [
    node('temporal-clock', 'tone', 'Master clock emitting BPM-synced triggers'),
    node('temporal-visual', 'p5', 'Animated visual field responding to clock triggers with particle systems'),
    node('temporal-audio', 'tone', 'Audio engine generating harmonic tones synced to master clock'),
    node('temporal-interact', 'p5', 'Mouse/touch interaction modulating visual and audio parameters'),
    node('temporal-feedback', 'p5', 'Visual feedback overlay showing parameter state and clock position'),
  ],
  edges: [
    edge('e1', 'temporal-clock', 'temporal-visual'),
    edge('e2', 'temporal-clock', 'temporal-audio'),
    edge('e3', 'temporal-interact', 'temporal-feedback'),
    edge('e4', 'temporal-visual', 'temporal-feedback'),
  ],
  controls: [
    { id: 'ctrl-spatial', from: { nodeId: 'temporal-interact', port: 'position', type: 'number' },
      to: { nodeId: 'temporal-visual', port: 'spatial', type: 'number' } },
    { id: 'ctrl-intensity', from: { nodeId: 'temporal-clock', port: 'intensity', type: 'number' },
      to: { nodeId: 'temporal-feedback', port: 'brightness', type: 'number' } },
  ],
  timingIslands: [
    { id: 'island-main', clock: 'audio', nodeIds: ['temporal-clock', 'temporal-visual', 'temporal-audio'] },
    { id: 'island-interact', clock: 'animation-frame', nodeIds: ['temporal-interact', 'temporal-feedback'] },
  ],
  bridges: [{ id: 'bridge-1', fromIslandId: 'island-main', toIslandId: 'island-interact', mode: 'sample' as const }],
  lifecycle: { teardownOrder: ['temporal-feedback', 'temporal-interact', 'temporal-audio', 'temporal-visual', 'temporal-clock'] },
};

// ─── Brief 2: Narrative Kinetic Environment (4 nodes) ─────────────────────
const narrativeGraph: CompositionGraph = {
  schema: SCHEMA, schemaVersion: VERSION, status: 'ready', id: 'w9-narrative',
  title: 'Narrative Kinetic Environment',
  budgets: { maxNodes: 4, maxEdges: 3, maxProviderCalls: 4 },
  nodes: [
    node('narrative-controller', 'html', 'Scene controller managing phase transitions: intro, development, resolution'),
    node('narrative-typography', 'html', 'Kinetic typography layer with text that animates across scenes'),
    node('narrative-motion', 'p5', 'Spatial motion layer with particles following the narrative arc'),
    node('narrative-sound', 'tone', 'Sound design layer with ambient textures shifting per scene'),
  ],
  edges: [
    edge('e1', 'narrative-controller', 'narrative-typography'),
    edge('e2', 'narrative-controller', 'narrative-motion'),
    edge('e3', 'narrative-controller', 'narrative-sound'),
  ],
  controls: [
    { id: 'ctrl-scene', from: { nodeId: 'narrative-controller', port: 'phase', type: 'string' },
      to: { nodeId: 'narrative-motion', port: 'scenePhase', type: 'string' } },
  ],
  lifecycle: { teardownOrder: ['narrative-sound', 'narrative-motion', 'narrative-typography', 'narrative-controller'] },
};

// ─── Brief 3: Emergent Information Artwork (3 nodes) ──────────────────────
const informationGraph: CompositionGraph = {
  schema: SCHEMA, schemaVersion: VERSION, status: 'ready', id: 'w9-information',
  title: 'Emergent Information Artwork',
  budgets: { maxNodes: 3, maxEdges: 2, maxProviderCalls: 3 },
  nodes: [
    node('info-data', 'p5', 'Data source layer generating procedural data patterns'),
    node('info-viz', 'p5', 'Visualization layer rendering data as emergent visual patterns'),
    node('info-interact', 'p5', 'Interaction layer allowing user to perturb data parameters'),
  ],
  edges: [
    edge('e1', 'info-data', 'info-viz'),
    edge('e2', 'info-interact', 'info-data'),
  ],
  controls: [
    { id: 'ctrl-perturb', from: { nodeId: 'info-interact', port: 'perturbation', type: 'number' },
      to: { nodeId: 'info-viz', port: 'distortion', type: 'number' } },
  ],
  lifecycle: { teardownOrder: ['info-interact', 'info-viz', 'info-data'] },
};

export const W9_BRIEFS: readonly W9BriefSpec[] = Object.freeze([
  {
    id: 'temporal', title: 'Temporal Audiovisual Instrument',
    description: 'A temporal audiovisual instrument with shared clock, synchronized visual+audio, and live interaction.',
    medium: 'p5',
    thesis: 'A unified instrument where a master clock drives synchronized particles and harmonic audio, with real-time spatial interaction.',
    graph: temporalGraph, audioRequired: true, interactionRequired: true,
  },
  {
    id: 'narrative', title: 'Narrative Kinetic Environment',
    description: 'A narrative kinetic environment with phased scenes, kinetic typography, spatial motion, and adaptive sound.',
    medium: 'html',
    thesis: 'A three-act narrative where typography, motion, and sound evolve through scene transitions.',
    graph: narrativeGraph, audioRequired: true, interactionRequired: false,
  },
  {
    id: 'information', title: 'Emergent Information Artwork',
    description: 'An emergent information artwork where procedural data generates visual patterns perturbed by viewer interaction.',
    medium: 'p5',
    thesis: 'A living data artwork where algorithmically generated patterns shift in response to viewer interaction.',
    graph: informationGraph, audioRequired: false, interactionRequired: true,
  },
]);

export function w9BriefNodeCounts(): Record<string, number> {
  return Object.fromEntries(W9_BRIEFS.map((b) => [b.id, b.graph.nodes.length]));
}

export function w9HasMultiNodeGraph(): boolean {
  return W9_BRIEFS.some((b) => b.graph.nodes.length >= 4);
}

export function w9AllGraphsHaveTeardown(): boolean {
  return W9_BRIEFS.every((b) => {
    const order = b.graph.lifecycle?.teardownOrder;
    return !!order && order.length === b.graph.nodes.length && new Set(order).size === order.length;
  });
}
