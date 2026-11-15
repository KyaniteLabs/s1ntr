import { describe, expect, it } from 'vitest';
import { assignCluster } from '../../../scripts/mece/clusters.mjs';
import { buildManifest, validateManifest } from '../../../scripts/mece/manifest.mjs';
import { checkBudget, loadBudget } from '../../../scripts/mece/budget.mjs';
import { diagnoseCluster } from '../../../scripts/mece/diagnose-cluster.mjs';

describe('mece assignCluster', () => {
  it('owns src/generators under C-gen', () => {
    expect(assignCluster('src/generators/hydra/HydraGenerator.ts')).toEqual({
      kind: 'cluster',
      clusterId: 'C-gen',
    });
  });

  it('owns the creative-run directory and its files under C-surface', () => {
    expect(assignCluster('src/creative-run')).toEqual({ kind: 'cluster', clusterId: 'C-surface' });
    expect(assignCluster('src/creative-run/CreativeRunCoordinator.ts')).toEqual({
      kind: 'cluster',
      clusterId: 'C-surface',
    });
  });

  it('owns creative intelligence under artistic media knowledge', () => {
    expect(assignCluster('src/creative-intelligence')).toEqual({ kind: 'cluster', clusterId: 'C-media' });
    expect(assignCluster('src/creative-intelligence/CreativeIntelligence.ts')).toEqual({
      kind: 'cluster',
      clusterId: 'C-media',
    });
  });

  it('excludes node_modules', () => {
    expect(assignCluster('node_modules/x/y').kind).toBe('exclude');
  });

  it('does not double-assign exclusive prefixes', () => {
    const a = assignCluster('src/harness/agent/HarnessAgent.ts');
    const b = assignCluster('src/llm/LLMClient.ts');
    expect(a).toEqual({ kind: 'cluster', clusterId: 'C-harness' });
    expect(b).toEqual({ kind: 'cluster', clusterId: 'C-llm' });
  });
});

describe('mece manifest', () => {
  it('builds a valid exact-one-owner manifest on current repo', () => {
    const m = buildManifest();
    const v = validateManifest(m);
    expect(v.ok).toBe(true);
    expect(m.unowned).toEqual([]);
    expect(m.counts.tracked).toBeGreaterThan(100);
  });
});

describe('wave budget', () => {
  it('fails closed when calls exceed max', () => {
    const r = checkBudget({ calls: 999 }, loadBudget({ maxCalls: 10 }));
    expect(r.ok).toBe(false);
    expect(r.breaches[0]).toContain('calls');
  });

  it('passes under budget', () => {
    expect(checkBudget({ calls: 1, tokens: 1, usd: 0, ms: 1 }, loadBudget()).ok).toBe(true);
  });
});

describe('diagnoseCluster', () => {
  it('writes diagnose-only plan with planBytes>=200 for C-gen', () => {
    const plan = diagnoseCluster('C-gen');
    expect(plan.productMutate).toBe(false);
    expect(plan.planBytes).toBeGreaterThanOrEqual(200);
    expect(plan.clusterId).toBe('C-gen');
  });
});
