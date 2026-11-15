import { describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import {
  CampaignCandidateLedger,
  createCampaignManifest,
  manifestIsCurrent,
  preflightCampaignBudget,
  type CampaignExecutionStage,
} from '../../../src/creative-run/CampaignManifest.js';
import { CreativeRunCoordinator, MemoryCreativeRunPersistence } from '../../../src/creative-run/CreativeRunCoordinator.js';

const DIGEST = (seed: string) => seed.repeat(64).slice(0, 64);
const stable = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') { const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${stable(record[key])}`).join(',')}}`; }
  return JSON.stringify(value);
};
const evidenceSlot = (briefId: string, candidateId: string, nodeId: string) => {
  const body = { campaignRunId: 'campaign-1', briefId, candidateId, nodeId,
    audioRequirement: 'required' as const,
    requiredEvidenceClasses: ['source', 'visual', 'temporal', 'audio', 'interaction', 'runtime', 'clock', 'accessibility'] as const,
    evidenceScheduleDigest: DIGEST('7') };
  return { ...body, slotDigest: createHash('sha256').update(stable(body)).digest('hex') };
};

function manifestInput() {
  return {
    campaignRunId: 'campaign-1',
    owner: { authorityId: 'owner-1', selectionMethod: 'sealed-owner-selection' },
    briefs: ['temporal', 'narrative', 'information'].map((id, briefIndex) => ({
      id,
      sealedBriefDigest: DIGEST(String(briefIndex + 1)),
      unseenAt: '2026-08-01T00:00:00.000Z',
      exampleFree: true,
      candidateSlots: [0, 1, 2].map((candidateIndex) => {
        const candidateId = `${id}-candidate-${candidateIndex + 1}`;
        const graphNodeIds = Array.from({ length: briefIndex === 0 ? 5 : candidateIndex + 1 }, (_, node) => `${id}-${candidateIndex}-${node}`);
        return { id: candidateId, graphNodeIds,
          ownerEvidence: evidenceSlot(id, candidateId, graphNodeIds[0]!) };
      }),
    })),
    transfer: {
      mode: 'sealed-brief' as const,
      sealedBriefDigest: DIGEST('4'),
      unseenAt: '2026-08-01T00:00:00.000Z',
      treatmentControlAllocation: 'treatment-first',
      routeDigest: DIGEST('5'),
      randomSourceDigest: DIGEST('6'),
      evidenceScheduleDigest: DIGEST('7'),
      nonOverlapDigest: DIGEST('b'),
    },
    rolesDigest: DIGEST('8'),
    executorRequirementsDigest: DIGEST('c'),
    evidenceModalitiesDigest: DIGEST('d'),
    ownerCheckpointsDigest: DIGEST('e'),
    qualityRubricVersion: 'creative-quality-rubric-v1',
    randomSourceDigest: DIGEST('9'),
    evidenceScheduleDigest: DIGEST('a'),
    requiredReviewStageIds: ['temporal', 'narrative', 'information'].flatMap((brief) =>
      [1, 2, 3].flatMap((candidate) => [
        `specialist-review-${brief}-${brief}-candidate-${candidate}`,
        `holistic-review-${brief}-${brief}-candidate-${candidate}`,
      ])),
    stopStates: ['no-eligible-candidate', 'budget-exhausted'],
    ceilings: { providerCalls: 128, inputTokens: 3_000_000, outputTokens: 750_000, activeMinutes: 360 },
  };
}

function stages(manifest: ReturnType<typeof createCampaignManifest>): CampaignExecutionStage[] {
  const generation = manifest.briefs.flatMap((brief) => brief.candidateSlots.flatMap((candidate) =>
    candidate.graphNodeIds.map((nodeId) => ({
      id: `generate-${nodeId}`, kind: 'generation' as const, briefId: brief.id,
      candidateSlotId: candidate.id, nodeId, seatId: 'seat-1', providerCalls: 1,
      inputTokens: 100, outputTokens: 50, activeMinutes: 1,
    }))));
  const recovery = manifest.briefs.flatMap((brief) => brief.candidateSlots.flatMap((candidate) =>
    candidate.graphNodeIds.map((nodeId) => ({
      id: `recover-${candidate.id}-${nodeId}`, kind: 'recovery' as const, briefId: brief.id,
      candidateSlotId: candidate.id, nodeId, seatId: 'seat-1', providerCalls: 1,
      inputTokens: 100, outputTokens: 50, activeMinutes: 1,
    }))));
  const revision = manifest.briefs.map((brief) => ({
    id: `revision-${brief.id}`, kind: 'revision' as const, briefId: brief.id,
    seatId: 'seat-1', providerCalls: 1, inputTokens: 100, outputTokens: 50, activeMinutes: 1,
  }));
  return ([...generation, ...recovery, ...revision,
    { id: 'transfer-treatment', kind: 'transfer-treatment', seatId: 'seat-1', providerCalls: 1, inputTokens: 100, outputTokens: 50, activeMinutes: 1 },
    { id: 'transfer-control', kind: 'transfer-control', seatId: 'seat-1', providerCalls: 1, inputTokens: 100, outputTokens: 50, activeMinutes: 1 },
    ...manifest.requiredReviewStageIds.map((id) => ({ id, kind: 'review' as const,
      seatId: 'seat-1', providerCalls: 1, inputTokens: 100, outputTokens: 50, activeMinutes: 1 })),
    { id: 'dream', kind: 'dream', seatId: 'seat-1', providerCalls: 1, inputTokens: 100, outputTokens: 50, activeMinutes: 1 },
  ] as Array<Omit<CampaignExecutionStage, 'transports'>>).map(stage => ({ ...stage,
    transports: [{ ordinal: 0, purpose: 'primary', phase: 'pre-primary-transport', mode: 'generate' }],
  }));
}

const capacity = {
  providerCalls: 128, inputTokens: 3_000_000, outputTokens: 750_000, activeMinutes: 360,
  seats: { 'seat-1': { providerCalls: 128, inputTokens: 3_000_000, outputTokens: 750_000, activeMinutes: 360 } },
};

describe('W8C-05 finite campaign manifest', () => {
  it('freezes three example-free briefs, nine slots, and the transfer commitment', () => {
    const manifest = createCampaignManifest(manifestInput());

    expect(manifest.briefs).toHaveLength(3);
    expect(manifest.briefs.flatMap((brief) => brief.candidateSlots)).toHaveLength(9);
    expect(manifest.briefs[0]?.candidateSlots[0]?.graphNodeIds).toHaveLength(5);
    expect(manifest.transfer.mode).toBe('sealed-brief');
    expect(manifest.manifestDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(Object.isFrozen(manifest)).toBe(true);
  });

  it('supports arbitrary candidate counts and rejects a non-example-free brief', () => {
    const fourth = manifestInput();
    fourth.briefs[0]!.candidateSlots.push({ id: 'fourth', graphNodeIds: ['fourth-node'],
      ownerEvidence: evidenceSlot('temporal', 'fourth', 'fourth-node') });
    expect(createCampaignManifest(fourth).briefs[0]!.candidateSlots).toHaveLength(4);

    const copied = manifestInput();
    copied.briefs[1]!.exampleFree = false;
    expect(() => createCampaignManifest(copied)).toThrow(/example-free/i);
  });

  it('rejects a caller-rewritten owner evidence slot and legacy publication schema', () => {
    const input = manifestInput();
    input.briefs[0]!.candidateSlots[0]!.ownerEvidence.evidenceScheduleDigest = DIGEST('0');
    expect(() => createCampaignManifest(input)).toThrow(/owner evidence slot/i);
    const current = createCampaignManifest(manifestInput());
    expect(manifestIsCurrent({ ...current, schemaVersion: 1 } as never)).toBe(false);
  });

  it('expands every node and bounded recovery before reservation', () => {
    const manifest = createCampaignManifest(manifestInput());
    const report = preflightCampaignBudget(manifest, stages(manifest), capacity);

    expect(report.passed).toBe(true);
    expect(report.requiredStageCount).toBe(stages(manifest).length);
    expect(report.feasibilityDigest).toMatch(/^[a-f0-9]{64}$/);
  });

  it('blocks missing node cost, duplicate recovery, topology drift, and unknown seat capacity', () => {
    const manifest = createCampaignManifest(manifestInput());
    const plan = stages(manifest);
    expect(preflightCampaignBudget(manifest, plan.slice(1), capacity).failures)
      .toContain('campaign-budget-feasible: missing generation stage for temporal-candidate-1/temporal-0-0');
    expect(preflightCampaignBudget(manifest, [...plan, { ...plan.find(stage => stage.kind === 'recovery')!, id: 'second-recovery' }], capacity).failures)
      .toContain('campaign-budget-feasible: candidate temporal-candidate-1 node has more than one recovery stage');
    expect(preflightCampaignBudget(manifest, [...plan, { ...plan[0]!, id: 'fourth-candidate-node', candidateSlotId: 'fourth' }], capacity).failures)
      .toContain('campaign-budget-feasible: generation stage fourth-candidate-node is outside the frozen topology');
    expect(preflightCampaignBudget(manifest, plan, { ...capacity, seats: {} }).failures)
      .toContain('campaign-budget-feasible: seat capacity is unknown for seat-1');
    expect(preflightCampaignBudget({ ...manifest, manifestDigest: DIGEST('f') }, plan, capacity).failures)
      .toContain('campaign-budget-feasible: manifest digest is invalid');
  });

  it('returns fail-closed reports instead of throwing for malformed caller shapes', () => {
    const manifest = createCampaignManifest(manifestInput());
    const plan = stages(manifest);
    const malformed = [
      () => preflightCampaignBudget(manifest, [{ ...plan[0]!, transports: undefined } as never], capacity),
      () => preflightCampaignBudget(manifest, [null] as never, capacity),
      () => preflightCampaignBudget(manifest, null as never, capacity),
      () => preflightCampaignBudget(manifest, plan, null as never),
      () => preflightCampaignBudget(null as never, plan, capacity),
    ];
    for (const preflight of malformed) {
      expect(preflight).not.toThrow();
      expect(preflight().passed).toBe(false);
    }
  });

  it('inserts exactly one result for every frozen candidate slot and retains failed candidates', () => {
    const manifest = createCampaignManifest(manifestInput());
    const ledger = new CampaignCandidateLedger(manifest);
    const slot = manifest.briefs[0]!.candidateSlots[0]!;
    const failed = ledger.insert({ briefId: 'temporal', candidateSlotId: slot.id,
      artifactDigest: DIGEST('b'), status: 'failed' });

    expect(failed.status).toBe('failed');
    expect(ledger.insert({ briefId: 'temporal', candidateSlotId: slot.id,
      artifactDigest: DIGEST('b'), status: 'failed' })).toEqual(failed);
    expect(() => ledger.insert({ briefId: 'temporal', candidateSlotId: 'fourth', artifactDigest: DIGEST('c'), status: 'completed' }))
      .toThrow(/not frozen/i);
  });

  it('blocks caller-declared campaign admission even when its arithmetic appears feasible', async () => {
    const reserve = vi.fn(async () => ({ id: 'campaign-reservation', status: 'reserved' as const }));
    const coordinator = new CreativeRunCoordinator({ persistence: new MemoryCreativeRunPersistence(), reserveProvider: reserve });
    const manifest = coordinator.createCampaignManifest(manifestInput());
    const plan = stages(manifest);

    await expect(coordinator.startCampaign({ entryPoint: 'cli-compose', requestKey: 'blocked-campaign' }, manifest,
      plan.slice(1), capacity)).rejects.toThrow(/provider reservation was not attempted/i);
    expect(reserve).not.toHaveBeenCalled();

    await expect(coordinator.startCampaign({ entryPoint: 'cli-compose', requestKey: 'admitted-campaign' }, manifest,
      plan, capacity)).rejects.toThrow(/caller-declared campaign admission is disabled/i);
    expect(reserve).not.toHaveBeenCalled();
  });
});
