import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import {
  createCampaignManifest,
  buildCampaignExecutionPlan,
  type CampaignManifest,
  type CampaignRouteFreeze,
} from '../../../src/creative-run/CampaignManifest.js';

const DIGEST = (seed: string) => seed.repeat(64).slice(0, 64);

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') { const r = value as Record<string, unknown>;
    return `{${Object.keys(r).sort().map(k => `${JSON.stringify(k)}:${stable(r[k])}`).join(',')}}`; }
  return JSON.stringify(value);
}

const evidenceSlot = (briefId: string, candidateId: string, nodeId: string) => {
  const body = { campaignRunId: 'w9-test', briefId, candidateId, nodeId,
    audioRequirement: 'not-applicable' as const,
    requiredEvidenceClasses: ['source', 'visual', 'temporal', 'interaction', 'runtime', 'clock', 'accessibility'] as const,
    evidenceScheduleDigest: DIGEST('7') };
  return { ...body, slotDigest: createHash('sha256').update(stable(body)).digest('hex') };
};

function makeManifest(): CampaignManifest {
  return createCampaignManifest({
    campaignRunId: 'w9-test',
    owner: { authorityId: 'owner-1', selectionMethod: 'sealed-owner-selection' },
    briefs: ['temporal'].map((id) => ({
      id, sealedBriefDigest: DIGEST('1'), unseenAt: '2026-08-01T00:00:00.000Z', exampleFree: true,
      candidateSlots: [0, 1, 2].map((ci) => {
        const candidateId = `${id}-candidate-${ci + 1}`;
        const graphNodeIds = [`${id}-${ci}-0`];
        return { id: candidateId, graphNodeIds, ownerEvidence: evidenceSlot(id, candidateId, graphNodeIds[0]!) };
      }),
    })),
    transfer: { mode: 'sealed-brief' as const, sealedBriefDigest: DIGEST('4'), unseenAt: '2026-08-01T00:00:00.000Z',
      treatmentControlAllocation: 'treatment-first', routeDigest: DIGEST('5'), randomSourceDigest: DIGEST('6'),
      evidenceScheduleDigest: DIGEST('7'), nonOverlapDigest: DIGEST('b') },
    rolesDigest: DIGEST('8'), executorRequirementsDigest: DIGEST('c'), evidenceModalitiesDigest: DIGEST('d'),
    ownerCheckpointsDigest: DIGEST('e'), qualityRubricVersion: 'v1', randomSourceDigest: DIGEST('9'),
    evidenceScheduleDigest: DIGEST('a'),
    requiredReviewStageIds: ['temporal'].flatMap((b) => [1, 2, 3].flatMap((c) => [
      `specialist-review-${b}-${b}-candidate-${c}`, `holistic-review-${b}-${b}-candidate-${c}`])),
    stopStates: ['no-eligible-candidate'], ceilings: { providerCalls: 64, inputTokens: 3_000_000, outputTokens: 750_000, activeMinutes: 360 },
  });
}

function makeRoute(role: string, seatId: string, model = 'deepseek-v4-flash-0731'): CampaignRouteFreeze['routes'][number] {
  return { seatId, role: role as CampaignRouteFreeze['routes'][number]['role'],
    provider: 'test-provider', model, seed: 'test-seed-0123', retryBudget: 1 };
}

function makeFreeze(routes: CampaignRouteFreeze['routes']): CampaignRouteFreeze {
  const candidateDiversity = manifest.briefs.flatMap((b) => b.candidateSlots.map((s, si) => ({
    briefId: b.id, candidateSlotId: s.id, thesisDigest: DIGEST(String(si + 1)),
    dimensions: { conceptual: `c-${si}`, structural: `s-${si}`, temporal: `t-${si}` },
  })));
  return {
    routes,
    diversityDimensions: [
      { id: 'conceptual', description: 'Conceptual diversity' },
      { id: 'structural', description: 'Structural diversity' },
      { id: 'temporal', description: 'Temporal diversity' },
    ],
    transferTargetDigest: DIGEST('e'),
    transportBudgets: {
      generation: { retries: 0, fallbacks: 0, toolTurns: 0, primaryMode: 'generate' as const },
      review: { retries: 0, fallbacks: 0, toolTurns: 0, primaryMode: 'generate' as const },
    },
    candidateDiversity,
  };
}

function makeSlotGraphs(manifest: CampaignManifest) {
  return manifest.briefs.flatMap((brief) =>
    brief.candidateSlots.map((slot) => {
      const nodes = slot.graphNodeIds.map((id) => ({ id, type: 'layer' as const, layer: { domain: 'p5' as never, prompt: 'test' } }));
      const graph = {
        schema: 'sinter.composition-graph' as const, schemaVersion: '2.0' as const,
        status: 'ready' as const, id: `graph-${slot.id}`,
        budgets: { maxNodes: nodes.length, maxEdges: 0, maxProviderCalls: nodes.length },
        nodes, edges: [],
        lifecycle: { teardownOrder: nodes.map((n) => n.id) },
      };
      return { briefId: brief.id, candidateSlotId: slot.id, graph };
    }));
}

const manifest = makeManifest();
const slotGraphs = makeSlotGraphs(manifest);

describe('W9C-02: single-generator route freeze + per-slot orchestration', () => {
  it('accepts a freeze with exactly one generator route', () => {
    const freeze = makeFreeze([
      makeRoute('generator', 'seat-gen'),
      makeRoute('harness', 'seat-harness'),
      makeRoute('evaluator', 'specialist-review', 'minimax-m3'),
      makeRoute('evaluator', 'holistic-review', 'glm-4-flash'),
    ]);
    expect(() => buildCampaignExecutionPlan(manifest, slotGraphs as never, freeze as never)).not.toThrow();
  });

  it('rejects a freeze with zero generator routes', () => {
    const freeze = makeFreeze([
      makeRoute('harness', 'seat-harness'),
      makeRoute('evaluator', 'specialist-review'),
      makeRoute('evaluator', 'holistic-review'),
    ]);
    expect(() => buildCampaignExecutionPlan(manifest, slotGraphs as never, freeze as never))
      .toThrow(/ambiguous or unused role routes/);
  });

  it('rejects a freeze with two generator routes', () => {
    const freeze = makeFreeze([
      makeRoute('generator', 'seat-gen-1', 'deepseek-v4-flash-0731'),
      makeRoute('generator', 'seat-gen-2', 'gemini-3.6-flash-high'),
      makeRoute('harness', 'seat-harness'),
      makeRoute('evaluator', 'specialist-review'),
    ]);
    expect(() => buildCampaignExecutionPlan(manifest, slotGraphs as never, freeze as never))
      .toThrow(/ambiguous or unused role routes/);
  });

  it('rejects a freeze with zero harness routes', () => {
    const freeze = makeFreeze([
      makeRoute('generator', 'seat-gen'),
      makeRoute('evaluator', 'specialist-review'),
      makeRoute('evaluator', 'holistic-review'),
    ]);
    expect(() => buildCampaignExecutionPlan(manifest, slotGraphs as never, freeze as never))
      .toThrow(/ambiguous or unused role routes/);
  });

  it('rejects a freeze with a studio route', () => {
    const freeze = makeFreeze([
      makeRoute('generator', 'seat-gen'),
      makeRoute('harness', 'seat-harness'),
      makeRoute('studio', 'seat-studio'),
    ]);
    expect(() => buildCampaignExecutionPlan(manifest, slotGraphs as never, freeze as never))
      .toThrow(/ambiguous or unused role routes/);
  });

  it('rejects duplicate seat IDs across routes', () => {
    const freeze = makeFreeze([
      makeRoute('generator', 'same-seat'),
      makeRoute('harness', 'same-seat'),
    ]);
    expect(() => buildCampaignExecutionPlan(manifest, slotGraphs as never, freeze as never))
      .toThrow(/ambiguous or unused role routes/);
  });

  it('binds all generation stages to the single generator seat', () => {
    const freeze = makeFreeze([
      makeRoute('generator', 'seat-gen', 'deepseek-v4-flash-0731'),
      makeRoute('harness', 'seat-harness', 'kimi-k3'),
      makeRoute('evaluator', 'specialist-review', 'minimax-m3'),
      makeRoute('evaluator', 'holistic-review', 'glm-4-flash'),
    ]);
    const plan = buildCampaignExecutionPlan(manifest, slotGraphs as never, freeze as never);
    const generationStages = plan.stages.filter((s) => s.kind === 'generation');
    expect(generationStages.length).toBeGreaterThan(0);
    for (const stage of generationStages) {
      expect(stage.seatId).toBe('seat-gen');
    }
  });

  it('binds all revision stages to the single generator seat', () => {
    const freeze = makeFreeze([
      makeRoute('generator', 'seat-gen'),
      makeRoute('harness', 'seat-harness'),
      makeRoute('evaluator', 'specialist-review'),
      makeRoute('evaluator', 'holistic-review'),
    ]);
    const plan = buildCampaignExecutionPlan(manifest, slotGraphs as never, freeze as never);
    const revisionStages = plan.stages.filter((s) => s.kind === 'revision');
    expect(revisionStages.length).toBeGreaterThan(0);
    for (const stage of revisionStages) {
      expect(stage.seatId).toBe('seat-gen');
    }
  });

  it('binds transfer stages to the single generator seat', () => {
    const freeze = makeFreeze([
      makeRoute('generator', 'seat-gen'),
      makeRoute('harness', 'seat-harness'),
      makeRoute('evaluator', 'specialist-review'),
      makeRoute('evaluator', 'holistic-review'),
    ]);
    const plan = buildCampaignExecutionPlan(manifest, slotGraphs as never, freeze as never);
    const transferStages = plan.stages.filter((s) => s.kind === 'transfer-treatment' || s.kind === 'transfer-control');
    expect(transferStages.length).toBe(2);
    for (const stage of transferStages) {
      expect(stage.seatId).toBe('seat-gen');
    }
  });

  it('produces stages for all slot graphs (per-slot orchestration)', () => {
    const freeze = makeFreeze([
      makeRoute('generator', 'seat-gen'),
      makeRoute('harness', 'seat-harness'),
      makeRoute('evaluator', 'specialist-review'),
      makeRoute('evaluator', 'holistic-review'),
    ]);
    const plan = buildCampaignExecutionPlan(manifest, slotGraphs as never, freeze as never);
    // 3 candidates × 1 node each = 3 generation stages
    const generationStages = plan.stages.filter((s) => s.kind === 'generation');
    expect(generationStages.length).toBe(3);
  });
});
