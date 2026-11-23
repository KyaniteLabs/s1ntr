/**
 * NODEPROMPT module — Spatial Prompt Engineering through Interactive Concept Graphs
 * Barrel file re-exporting all public API.
 *
 * C9 (2026-06-15): removed layout coordinates, fibonacciSphere, SphereLayout,
 * extraction schemas, GraphStore, HistoryStore, gesture types, GestureEngine.
 * Only the synthesis renderer (`synthesizePrompt`) remains live.
 */

// ── Types ──
import { readFileSync } from 'node:fs';
import { createNodeData } from './types/index.js';
import type { EdgeData, NodeData } from './types/index.js';
import { synthesizePrompt as synthesize } from './synthesis/PromptSynthesizer.js';

export type {
  NodeType,
  AbstractionLevel,
  EpistemologicalFacet,
  RhetoricalFacet,
  Vec3,
  SphericalCoord,
  RadialCoord,
  FacetSet,
  NodeData,
  EdgeRelation,
  EdgeData,
  ExtractionConfig,
} from './types/index.js';

export {
  NODE_COLORS,
  DEPTH_COLORS,
  EDGE_COLORS,
  createNodeData,
  computeBranchingFactor,
  allocateBudget,
  allocateLevelBudget,
} from './types/index.js';

// ── Synthesis (the only live path) ──
export {
  synthesizePrompt,
  renderTree,
} from './synthesis/PromptSynthesizer.js';

// ── Operator entry: a concept-graph file turns a plain request into a structured brief ──

/**
 * Read a concept-graph JSON file ({ originalPrompt?, nodes: [{id,label,type,...}], edges: [{sourceId,targetId,relation,...}] })
 * and return the request rewritten as a structured prompt. Node and edge fields the file omits get defaults, so a
 * hand-written graph only needs ids, labels, types and links. `sinter generate --concept-graph <file>` calls this.
 */
export function enrichPromptFromGraphFile(prompt: string, graphPath: string): string {
  const graph = JSON.parse(readFileSync(graphPath, 'utf-8')) as { originalPrompt?: string; nodes?: Partial<NodeData>[]; edges?: Partial<EdgeData>[] };
  if (!Array.isArray(graph.nodes) || !Array.isArray(graph.edges)) throw new Error('Graph JSON must contain { nodes: [...], edges: [...] }');
  const nodes = graph.nodes.map((n) => {
    if (typeof n.id !== 'string' || typeof n.label !== 'string' || typeof n.type !== 'string') throw new Error('Every graph node needs string id, label and type');
    return createNodeData({ ...n, id: n.id, label: n.label, type: n.type });
  });
  const edges: EdgeData[] = graph.edges.map((e, i) => {
    if (typeof e.sourceId !== 'string' || typeof e.targetId !== 'string') throw new Error('Every graph edge needs string sourceId and targetId');
    return { id: `e${i}`, relation: 'cross-link', strength: 0.5, isUserCreated: true, isDeleted: false, isHierarchical: false, extractionPass: 0, ...e } as EdgeData;
  });
  return synthesize(prompt || graph.originalPrompt || '', nodes, edges);
}
