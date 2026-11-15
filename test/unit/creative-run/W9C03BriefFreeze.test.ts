import { describe, expect, it } from 'vitest';
import { W9_BRIEFS, w9BriefNodeCounts, w9HasMultiNodeGraph, w9AllGraphsHaveTeardown } from '../../../src/creative-run/w9Briefs.js';

describe('W9C-03: Multi-node campaign brief freeze', () => {
  it('defines exactly three briefs', () => {
    expect(W9_BRIEFS.length).toBe(3);
  });

  it('has briefs with ids temporal, narrative, information', () => {
    expect(W9_BRIEFS.map((b) => b.id)).toEqual(['temporal', 'narrative', 'information']);
  });

  it('temporal brief has 5 nodes (≥4 required)', () => {
    expect(w9BriefNodeCounts().temporal).toBe(5);
  });

  it('narrative brief has 4 nodes (≥4 required)', () => {
    expect(w9BriefNodeCounts().narrative).toBe(4);
  });

  it('information brief has 3 nodes (deliberately simpler)', () => {
    expect(w9BriefNodeCounts().information).toBe(3);
  });

  it('at least one brief has ≥4 nodes', () => {
    expect(w9HasMultiNodeGraph()).toBe(true);
  });

  it('all graphs have complete teardown orders', () => {
    expect(w9AllGraphsHaveTeardown()).toBe(true);
  });

  it('all graphs use composition-graph schema v2.0', () => {
    for (const brief of W9_BRIEFS) {
      expect(brief.graph.schema).toBe('sinter.composition-graph');
      expect(brief.graph.schemaVersion).toBe('2.0');
      expect(brief.graph.status).toBe('ready');
    }
  });

  it('all nodes have type layer with domain and prompt', () => {
    for (const brief of W9_BRIEFS) {
      for (const node of brief.graph.nodes) {
        expect(node.type).toBe('layer');
        expect(typeof node.layer.domain).toBe('string');
        expect(node.layer.domain.length).toBeGreaterThan(0);
        expect(typeof node.layer.prompt).toBe('string');
        expect(node.layer.prompt.length).toBeGreaterThan(0);
      }
    }
  });

  it('temporal brief has timing islands with clocks', () => {
    const temporal = W9_BRIEFS.find((b) => b.id === 'temporal')!;
    expect(Array.isArray(temporal.graph.timingIslands)).toBe(true);
    expect(temporal.graph.timingIslands!.length).toBeGreaterThan(0);
    for (const island of temporal.graph.timingIslands!) {
      expect(typeof island.clock).toBe('string');
      expect(island.clock.length).toBeGreaterThan(0);
      expect(island.nodeIds.length).toBeGreaterThan(0);
    }
  });

  it('temporal brief has bridges between islands', () => {
    const temporal = W9_BRIEFS.find((b) => b.id === 'temporal')!;
    expect(temporal.graph.bridges!.length).toBeGreaterThan(0);
  });

  it('temporal and narrative briefs require audio', () => {
    expect(W9_BRIEFS.find((b) => b.id === 'temporal')!.audioRequired).toBe(true);
    expect(W9_BRIEFS.find((b) => b.id === 'narrative')!.audioRequired).toBe(true);
  });

  it('information brief does not require audio', () => {
    expect(W9_BRIEFS.find((b) => b.id === 'information')!.audioRequired).toBe(false);
  });

  it('all briefs have a thesis statement', () => {
    for (const brief of W9_BRIEFS) {
      expect(brief.thesis.length).toBeGreaterThan(20);
    }
  });

  it('all briefs have controls connecting nodes', () => {
    for (const brief of W9_BRIEFS) {
      expect(brief.graph.controls!.length).toBeGreaterThan(0);
      for (const ctrl of brief.graph.controls!) {
        expect(typeof ctrl.from.nodeId).toBe('string');
        expect(typeof ctrl.to.nodeId).toBe('string');
      }
    }
  });

  it('all graphs have valid budgets', () => {
    for (const brief of W9_BRIEFS) {
      expect(brief.graph.budgets.maxNodes).toBe(brief.graph.nodes.length);
      expect(brief.graph.budgets.maxProviderCalls).toBeGreaterThanOrEqual(brief.graph.nodes.length);
    }
  });
});
