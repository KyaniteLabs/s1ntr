import { createHash } from 'node:crypto';
import type { CampaignTransferTargetSeal } from '../creative-run/CampaignContinuation.js';
import { validateCampaignTransferTargetSeal } from '../creative-run/CampaignContinuation.js';
import type { CampaignLedgerPersistence } from '../creative-run/CampaignPersistence.js';
import {
  computeRouteFreezeDigest,
  manifestIsCurrent,
  type CampaignExecutionPlan,
  type CampaignManifest,
} from '../creative-run/CampaignManifest.js';
import type { CampaignEvidenceCheckpoint } from '../creative-run/CreativeRunCoordinatorBase.js';

const DIGEST = /^[a-f0-9]{64}$/;
const SCHEMA = 'sinter.governed-continuation-context' as const;

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) =>
      `${JSON.stringify(key)}:${stable(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function digest(value: unknown): string {
  return createHash('sha256').update(stable(value)).digest('hex');
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}

function checkpointBody(
  checkpoint: CampaignEvidenceCheckpoint,
): Omit<CampaignEvidenceCheckpoint, 'checkpointDigest'> {
  const { checkpointDigest: _checkpointDigest, ...body } = checkpoint;
  return body;
}

function planBody(plan: CampaignExecutionPlan): Omit<CampaignExecutionPlan, 'planDigest'> {
  const { planDigest: _planDigest, ...body } = plan;
  return body;
}

export interface DurableCampaignContinuationContext {
  readonly schema: typeof SCHEMA;
  readonly schemaVersion: 1;
  readonly campaignRunId: string;
  readonly manifestDigest: string;
  readonly planDigest: string;
  readonly routeFreezeDigest: string;
  readonly checkpointDigest: string;
  readonly rootRunId: string;
  readonly fundingReservationDigest: string;
  /** Authenticated bridge principal that owns the manifest authority. */
  readonly ownerPrincipalId: string;
  /** Immutable campaign authority identity declared by the manifest. */
  readonly ownerAuthorityId: string;
  readonly learningEvidenceId: string;
  readonly manifest: CampaignManifest;
  readonly plan: CampaignExecutionPlan;
  readonly checkpoint: CampaignEvidenceCheckpoint;
  /** Protected host material. Never include this context in an API response. */
  readonly targetSeal: CampaignTransferTargetSeal;
  readonly contextDigest: string;
}

export type CampaignContinuationContextInput = Pick<DurableCampaignContinuationContext,
  'manifest' | 'plan' | 'checkpoint' | 'ownerPrincipalId' | 'learningEvidenceId' | 'targetSeal'>;

function contextBody(context: DurableCampaignContinuationContext):
Omit<DurableCampaignContinuationContext, 'contextDigest'> {
  const { contextDigest: _contextDigest, ...body } = context;
  return body;
}

function assertContext(context: DurableCampaignContinuationContext): void {
  const { manifest, plan, checkpoint, targetSeal } = context;
  if (context.schema !== SCHEMA || context.schemaVersion !== 1
    || !context.learningEvidenceId.trim() || !manifestIsCurrent(manifest)
    || plan.schema !== 'sinter.campaign-execution-plan' || plan.schemaVersion !== 1
    || plan.planDigest !== digest(planBody(plan))
    || plan.routeFreezeDigest !== computeRouteFreezeDigest(plan.routeFreeze)
    || checkpoint.schema !== 'sinter.campaign-evidence-checkpoint'
    || checkpoint.schemaVersion !== 1 || checkpoint.originPending !== true
    || checkpoint.checkpointDigest !== digest(checkpointBody(checkpoint))
    || context.campaignRunId !== manifest.campaignRunId
    || context.manifestDigest !== manifest.manifestDigest
    || context.planDigest !== plan.planDigest || context.routeFreezeDigest !== plan.routeFreezeDigest
    || plan.campaignRunId !== manifest.campaignRunId || plan.manifestDigest !== manifest.manifestDigest
    || checkpoint.campaignRunId !== manifest.campaignRunId
    || checkpoint.manifestDigest !== manifest.manifestDigest
    || checkpoint.campaignPlanDigest !== plan.planDigest
    || checkpoint.campaignRouteFreezeDigest !== plan.routeFreezeDigest
    || context.checkpointDigest !== checkpoint.checkpointDigest
    || context.rootRunId !== checkpoint.rootRunId
    || context.fundingReservationDigest !== checkpoint.campaignFundingReservationDigest
    || !DIGEST.test(context.fundingReservationDigest)
    || !context.ownerPrincipalId.trim()
    || context.ownerAuthorityId !== manifest.owner.authorityId
    || context.ownerPrincipalId !== context.ownerAuthorityId
    || plan.routeFreeze.transferTargetDigest !== targetSeal.targetDigest
    || context.contextDigest !== digest(contextBody(context))) {
    throw new Error('GOVERNED_CAMPAIGN_CONTINUATION_CONTEXT_INVALID');
  }
  validateCampaignTransferTargetSeal(manifest, targetSeal);
}

function parseContext(raw: string): DurableCampaignContinuationContext {
  try {
    const context = JSON.parse(raw) as DurableCampaignContinuationContext;
    assertContext(context);
    return deepFreeze(structuredClone(context));
  } catch (error) {
    if (error instanceof Error && error.message === 'GOVERNED_CAMPAIGN_CONTINUATION_CONTEXT_INVALID') {
      throw error;
    }
    throw new Error('GOVERNED_CAMPAIGN_CONTINUATION_CONTEXT_INVALID', { cause: error });
  }
}

/** Host-only immutable context registry used to recover continuation after service restart. */
export class DurableCampaignContinuationContextRegistry {
  constructor(private readonly persistence: CampaignLedgerPersistence) {}

  private key(campaignRunId: string): string {
    return `governed-continuation-context:${campaignRunId}`;
  }

  async register(input: CampaignContinuationContextInput): Promise<DurableCampaignContinuationContext> {
    const fundingReservationDigest = input.checkpoint.campaignFundingReservationDigest;
    if (!fundingReservationDigest) {
      throw new Error('GOVERNED_CAMPAIGN_CONTINUATION_CONTEXT_INVALID');
    }
    const body = {
      schema: SCHEMA, schemaVersion: 1 as const,
      campaignRunId: input.manifest.campaignRunId,
      manifestDigest: input.manifest.manifestDigest,
      planDigest: input.plan.planDigest,
      routeFreezeDigest: input.plan.routeFreezeDigest,
      checkpointDigest: input.checkpoint.checkpointDigest,
      rootRunId: input.checkpoint.rootRunId,
      fundingReservationDigest,
      ownerPrincipalId: input.ownerPrincipalId,
      ownerAuthorityId: input.manifest.owner.authorityId,
      learningEvidenceId: input.learningEvidenceId,
      manifest: input.manifest,
      plan: input.plan,
      checkpoint: input.checkpoint,
      targetSeal: input.targetSeal,
    };
    const proposed = deepFreeze({ ...body, contextDigest: digest(body) });
    assertContext(proposed);
    return this.persistence.claim(this.key(proposed.campaignRunId), async () => {
      const existing = await this.persistence.read(this.key(proposed.campaignRunId));
      if (existing) {
        const current = parseContext(existing);
        if (current.contextDigest !== proposed.contextDigest) {
          throw new Error('GOVERNED_CAMPAIGN_CONTINUATION_CONTEXT_IMMUTABLE');
        }
        return current;
      }
      await this.persistence.write(this.key(proposed.campaignRunId), `${JSON.stringify(proposed, null, 2)}\n`);
      return proposed;
    });
  }

  async resolve(campaignRunId: string): Promise<DurableCampaignContinuationContext> {
    if (!campaignRunId.trim()) throw new Error('GOVERNED_CAMPAIGN_CONTINUATION_CONTEXT_MISSING');
    const raw = await this.persistence.read(this.key(campaignRunId));
    if (!raw) throw new Error('GOVERNED_CAMPAIGN_CONTINUATION_CONTEXT_MISSING');
    const context = parseContext(raw);
    if (context.campaignRunId !== campaignRunId) {
      throw new Error('GOVERNED_CAMPAIGN_CONTINUATION_CONTEXT_INVALID');
    }
    return context;
  }
}
