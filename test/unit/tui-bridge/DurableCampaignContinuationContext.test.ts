import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import {
  bootstrapCampaignTransferEvaluator,
  CampaignContinuation,
  exportCampaignTransferTargetSeal,
  restoreCampaignTransferTarget,
} from '../../../src/creative-run/CampaignContinuation.js';
import { FileCampaignLedgerPersistence } from '../../../src/creative-run/CampaignPersistence.js';
import {
  computeRouteFreezeDigest,
  createCampaignManifest,
  type CampaignExecutionPlan,
} from '../../../src/creative-run/CampaignManifest.js';
import type { CampaignEvidenceCheckpoint } from '../../../src/creative-run/CreativeRunCoordinatorBase.js';
import { DurableCampaignContinuationContextRegistry } from
  '../../../src/tui-bridge/DurableCampaignContinuationContext.js';

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map(key =>
      `${JSON.stringify(key)}:${stable(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

const digest = (value: unknown) => createHash('sha256').update(
  typeof value === 'string' ? value : stable(value),
).digest('hex');
const D = (char: string) => char.repeat(64);

function fixture() {
  const campaignRunId = 'campaign-context-1';
  const targetContent = 'An unseen kinetic study of blue shadows';
  const evidenceBody = { campaignRunId, briefId: 'brief-1', candidateId: 'candidate-1',
    nodeId: 'node-1', audioRequirement: 'not-applicable' as const,
    requiredEvidenceClasses: ['source', 'visual', 'temporal', 'interaction', 'runtime',
      'clock', 'accessibility'] as const, evidenceScheduleDigest: D('1') };
  const manifest = createCampaignManifest({ campaignRunId,
    owner: { authorityId: 'owner-1', selectionMethod: 'sealed-owner-selection' },
    briefs: [{ id: 'brief-1', sealedBriefDigest: D('2'),
      unseenAt: '2026-08-01T00:00:00.000Z', exampleFree: true,
      candidateSlots: [{ id: 'candidate-1', graphNodeIds: ['node-1'],
        ownerEvidence: { ...evidenceBody, slotDigest: digest(evidenceBody) } }] }],
    transfer: { mode: 'sealed-brief', sealedBriefDigest: digest(targetContent),
      unseenAt: '2026-08-01T00:00:00.000Z', treatmentControlAllocation: 'treatment-first',
      routeDigest: D('3'), randomSourceDigest: D('4'), evidenceScheduleDigest: D('5'),
      nonOverlapDigest: D('6') },
    rolesDigest: D('7'), executorRequirementsDigest: D('8'), evidenceModalitiesDigest: D('9'),
    ownerCheckpointsDigest: D('a'), qualityRubricVersion: 'rubric-v1', randomSourceDigest: D('b'),
    evidenceScheduleDigest: D('c'), requiredReviewStageIds: ['specialist-review-brief-1-candidate-1'],
    stopStates: ['complete'], ceilings: { providerCalls: 8, inputTokens: 10_000,
      outputTokens: 5_000, activeMinutes: 60 } });
  const routeFreeze = { routes: [], transportBudgets: {},
    transferTargetDigest: digest(targetContent), diversityDimensions: [], candidateDiversity: [] };
  const planBody = { schema: 'sinter.campaign-execution-plan' as const, schemaVersion: 1 as const,
    manifestDigest: manifest.manifestDigest, campaignRunId, routeFreeze,
    routeFreezeDigest: computeRouteFreezeDigest(routeFreeze), slotGraphDigests: [], stages: [] };
  const plan = { ...planBody, planDigest: digest(planBody) } as CampaignExecutionPlan;
  const checkpointBody = { schema: 'sinter.campaign-evidence-checkpoint' as const,
    schemaVersion: 1 as const, originPending: true as const, campaignRunId,
    rootRunId: 'root-1', manifestDigest: manifest.manifestDigest,
    campaignFundingReservationDigest: D('d'), campaignPlanDigest: plan.planDigest,
    campaignRouteFreezeDigest: plan.routeFreezeDigest, receipts: [] };
  const checkpoint = { ...checkpointBody,
    checkpointDigest: digest(checkpointBody) } as CampaignEvidenceCheckpoint;
  const continuation = new CampaignContinuation({ evaluator: bootstrapCampaignTransferEvaluator(
    async () => ({ outcome: 'inconclusive', rationaleDigest: D('e') }),
  ) } as never);
  const target = continuation.sealTarget(manifest, { mode: 'sealed-brief', brief: targetContent });
  return { manifest, plan, checkpoint, targetContent,
    targetSeal: exportCampaignTransferTargetSeal(target) };
}

describe('DurableCampaignContinuationContextRegistry', () => {
  it('rehydrates the exact host context and a fresh opaque target through shared persistence', async () => {
    const root = await mkdtemp(`${tmpdir()}/continuation-context-`);
    try {
      const input = fixture();
      const first = new DurableCampaignContinuationContextRegistry(
        new FileCampaignLedgerPersistence(root),
      );
      await first.register({ ...input, ownerPrincipalId: 'owner-1',
        learningEvidenceId: 'learning-1' });

      const restarted = new DurableCampaignContinuationContextRegistry(
        new FileCampaignLedgerPersistence(root),
      );
      const recovered = await restarted.resolve(input.manifest.campaignRunId);
      const opaque = restoreCampaignTransferTarget(recovered.manifest, recovered.targetSeal);
      expect(opaque).toEqual({ campaignRunId: input.manifest.campaignRunId,
        manifestDigest: input.manifest.manifestDigest, targetDigest: digest(input.targetContent) });
      expect(opaque).not.toHaveProperty('target');
      expect(recovered.checkpoint.checkpointDigest).toBe(input.checkpoint.checkpointDigest);
      expect(recovered.plan.planDigest).toBe(input.plan.planDigest);
      expect(recovered.ownerPrincipalId).toBe('owner-1');
      expect(recovered.ownerAuthorityId).toBe(input.manifest.owner.authorityId);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects immutable registration drift and tampered checkpoint or target material', async () => {
    const root = await mkdtemp(`${tmpdir()}/continuation-context-drift-`);
    try {
      const input = fixture();
      const registry = new DurableCampaignContinuationContextRegistry(
        new FileCampaignLedgerPersistence(root),
      );
      await registry.register({ ...input, ownerPrincipalId: 'owner-1',
        learningEvidenceId: 'learning-1' });
      await expect(registry.register({ ...input, ownerPrincipalId: 'owner-1',
        learningEvidenceId: 'learning-2' }))
        .rejects.toThrow(/immutable/i);
      await expect(registry.register({ ...input, ownerPrincipalId: 'owner-2',
        learningEvidenceId: 'learning-1' })).rejects.toThrow(/CONTEXT_INVALID/);
      await expect(registry.register({ ...input, ownerPrincipalId: 'owner-1',
        learningEvidenceId: 'learning-1',
        checkpoint: { ...input.checkpoint, rootRunId: 'forged-root' } }))
        .rejects.toThrow(/CONTEXT_INVALID/);
      await expect(registry.register({ ...input, ownerPrincipalId: 'owner-1',
        learningEvidenceId: 'learning-1',
        targetSeal: { ...input.targetSeal, target: 'forged private target' } }))
        .rejects.toThrow(/TARGET_SEAL_INVALID/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
