import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { bootstrapCampaignClosureEvidenceAuthority } from '../../../src/creative-run/CampaignClosure.js';
import { bootstrapCampaignTransferEvaluator,
  campaignTransferNonOverlapDigest, campaignTransferRouteDigest } from
  '../../../src/creative-run/CampaignContinuation.js';
import { FileCampaignLedgerPersistence } from '../../../src/creative-run/CampaignPersistence.js';
import { CampaignService } from '../../../src/creative-run/CampaignService.js';
import { unitTestCampaignAuthorityBoundary } from '../../fixtures/campaignAuthorityBoundary.js';
import { computeRouteFreezeDigest, createCampaignManifest,
  type CampaignExecutionPlan } from '../../../src/creative-run/CampaignManifest.js';
import type { CampaignRunAdmission, CampaignEvidenceCheckpoint } from
  '../../../src/creative-run/CreativeRunCoordinatorBase.js';
import type { CreativeRunCoordinator } from '../../../src/creative-run/CreativeRunCoordinator.js';
import { TuiBridgeServer } from '../../../src/tui-bridge/TuiBridgeServer.js';
import { TuiBridgeService } from '../../../src/tui-bridge/TuiBridgeService.js';

const execFileAsync = promisify(execFile);
const D = (char: string) => char.repeat(64);

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

function campaignFixture() {
  const campaignRunId = 'campaign-1';
  const targetContent = 'An unseen kinetic study of blue shadows';
  const sourceIntent = 'source intent for a previous creative artifact';
  const sourceIntentDigest = digest(sourceIntent);
  const route = { provider: 'openai', model: 'generator-test' };
  const evidenceBody = { campaignRunId, briefId: 'brief-1', candidateId: 'candidate-1',
    nodeId: 'node-1', audioRequirement: 'not-applicable' as const,
    requiredEvidenceClasses: ['source', 'visual', 'temporal', 'interaction', 'runtime',
      'clock', 'accessibility'] as const, evidenceScheduleDigest: D('1') };
  const sourceBriefDigest = D('2');
  const targetDigest = digest(targetContent);
  const manifest = createCampaignManifest({ campaignRunId,
    owner: { authorityId: 'owner-1', selectionMethod: 'sealed-owner-selection' },
    briefs: [{ id: 'brief-1', sealedBriefDigest: sourceBriefDigest,
      unseenAt: '2026-08-01T00:00:00.000Z', exampleFree: true,
      candidateSlots: [{ id: 'candidate-1', graphNodeIds: ['node-1'],
        ownerEvidence: { ...evidenceBody, slotDigest: digest(evidenceBody) } }] }],
    transfer: { mode: 'sealed-brief', sealedBriefDigest: targetDigest,
      unseenAt: '2026-08-01T00:00:00.000Z', treatmentControlAllocation: 'treatment-first',
      routeDigest: campaignTransferRouteDigest(route), randomSourceDigest: D('4'),
      evidenceScheduleDigest: D('5'),
      nonOverlapDigest: campaignTransferNonOverlapDigest(targetDigest,
        [sourceBriefDigest, sourceIntentDigest]) },
    rolesDigest: D('7'), executorRequirementsDigest: D('8'), evidenceModalitiesDigest: D('9'),
    ownerCheckpointsDigest: D('a'), qualityRubricVersion: 'rubric-v1', randomSourceDigest: D('4'),
    evidenceScheduleDigest: D('5'), requiredReviewStageIds: ['specialist-review-brief-1-candidate-1'],
    stopStates: ['complete'], ceilings: { providerCalls: 8, inputTokens: 10_000,
      outputTokens: 5_000, activeMinutes: 60 } });
  const routeFreeze = { routes: [], transportBudgets: {}, transferTargetDigest: targetDigest,
    diversityDimensions: [], candidateDiversity: [] };
  const planBody = { schema: 'sinter.campaign-execution-plan' as const, schemaVersion: 1 as const,
    manifestDigest: manifest.manifestDigest, campaignRunId, routeFreeze,
    routeFreezeDigest: computeRouteFreezeDigest(routeFreeze), slotGraphDigests: [], stages: [] };
  const plan = { ...planBody, planDigest: digest(planBody) } as CampaignExecutionPlan;
  const fundingReservationDigest = D('d');
  const checkpointBody = { schema: 'sinter.campaign-evidence-checkpoint' as const,
    schemaVersion: 1 as const, originPending: true as const, campaignRunId,
    rootRunId: 'root-1', manifestDigest: manifest.manifestDigest,
    campaignFundingReservationDigest: fundingReservationDigest,
    campaignPlanDigest: plan.planDigest, campaignRouteFreezeDigest: plan.routeFreezeDigest,
    receipts: [] };
  const checkpoint = { ...checkpointBody,
    checkpointDigest: digest(checkpointBody) } as CampaignEvidenceCheckpoint;
  const admission = { creativeRun: { rootRunId: 'root-1', requestKey: campaignRunId,
    record: { campaignOrigin: { manifestDigest: manifest.manifestDigest,
      planDigest: plan.planDigest, campaignFundingReservationDigest: fundingReservationDigest,
      feasibilityDigest: D('e'), routeFreezeDigest: plan.routeFreezeDigest } } },
  manifestDigest: manifest.manifestDigest, planDigest: plan.planDigest, plan,
  feasibility: { requiredStageCount: 3 }, fundingReservation: {
    reservationDigest: fundingReservationDigest,
    subject: { routeFreezeDigest: plan.routeFreezeDigest },
  } } as CampaignRunAdmission;
  return { campaignRunId, targetContent, sourceIntent, sourceIntentDigest, route,
    manifest, plan, checkpoint, admission, fundingReservationDigest };
}

async function productHarness(root: string) {
  const fixture = campaignFixture();
  const progress = new FileCampaignLedgerPersistence(path.join(root, 'progress'));
  const closureAuthority = bootstrapCampaignClosureEvidenceAuthority({
    persistence: new FileCampaignLedgerPersistence(path.join(root, 'closure')),
    envelopeAuthority: { signReview: () => 'host-signature', verifyReview: () => true } as never,
    captureAuthority: {} as never,
  });
  const execution = { authorizationEvidenceId: 'learning-1', authorizationEvidenceDigest: D('1'),
    executionId: 'execution-1', binding: { campaignRunId: fixture.campaignRunId,
      manifestDigest: fixture.manifest.manifestDigest }, briefId: 'brief-1',
    beganAt: '2026-08-02T00:00:00.000Z', executionDigest: D('2') };
  const learning = { id: 'learning-1', binding: execution.binding, briefId: 'brief-1',
    manifestIntentDigest: fixture.sourceIntentDigest,
    manifest: { intent: fixture.sourceIntent }, planDigest: D('3'), route: fixture.route,
    revisionReceiptDigest: D('4'), authorization: {}, stage: {},
    provisional: { ruleId: 'contrast', ruleValue: 'strong' },
    signatureBase64: 'signed', evidenceDigest: D('5') };
  vi.spyOn(closureAuthority, 'resolveLearningAuthorization').mockResolvedValue(learning as never);
  vi.spyOn(closureAuthority, 'resolveActiveLearningAuthorization').mockResolvedValue(learning as never);
  vi.spyOn(closureAuthority, 'resolveLearningAuthorizationState').mockResolvedValue({
    authorizationEvidenceId: 'learning-1', state: 'active', stateDigest: D('6'),
  });
  vi.spyOn(closureAuthority, 'beginLearningAuthorizationExecution').mockResolvedValue(execution);
  vi.spyOn(closureAuthority, 'resolveLearningAuthorizationExecution').mockResolvedValue(learning as never);
  vi.spyOn(closureAuthority, 'commitLearningAuthorizationExecution').mockResolvedValue({
    authorizationEvidenceId: 'learning-1', state: 'consumed', execution, stateDigest: D('7'),
  });
  vi.spyOn(closureAuthority, 'abortLearningAuthorizationExecution').mockResolvedValue({
    authorizationEvidenceId: 'learning-1', state: 'active', stateDigest: D('8'),
  });

  const composeCampaignStage = vi.fn(async (_request, options: { requestKey: string }) => ({
    html: options.requestKey.endsWith('treatment') ? '<main>new blue movement</main>'
      : '<main>baseline gray movement</main>',
  }));
  const finalizeCampaignOrigin = vi.fn(async (_admission, receipts: readonly {
    resultDigest: string }[]) => ({ schema: 'sinter.campaign-origin-receipt', schemaVersion: 1,
    receiptId: `campaign-origin:${fixture.campaignRunId}`, kind: 'campaign-origin',
    campaignRunId: fixture.campaignRunId, rootRunId: 'root-1',
    manifestDigest: fixture.manifest.manifestDigest, releaseHead: 'a'.repeat(40),
    sourceFingerprint: D('b'), schemaDigest: D('c'), implementationDigest: D('d'),
    wave8ReleaseRootDigest: D('e'),
    campaignFundingReservationDigest: fixture.fundingReservationDigest,
    campaignPlanDigest: fixture.plan.planDigest,
    campaignRouteFreezeDigest: fixture.plan.routeFreezeDigest,
    keyId: 'host-1', orderedReceiptDigests: receipts.map(item => item.resultDigest),
    signatureBase64: 'signed', resultDigest: D('f'),
  }));
  const ownerCapability = Object.freeze({ owner: 'owner-1' });
  const otherOwnerCapability = Object.freeze({ owner: 'owner-2' });
  const coordinator = { composeCampaignStage, finalizeCampaignOrigin,
    verifyOwnerAuthorityCapability: (capability: unknown, role: string) => {
      if (capability === ownerCapability) return { id: 'owner-1', role };
      if (capability === otherOwnerCapability) return { id: 'owner-2', role };
      throw new Error('OWNER_AUTHORITY_INVALID');
    },
  } as unknown as CreativeRunCoordinator;
  const campaignService = new CampaignService(coordinator, {
    authorityBoundary: unitTestCampaignAuthorityBoundary,
    closureEvidenceAuthority: closureAuthority, progressPersistence: progress,
    originVerifier: () => undefined,
    transferEvaluator: bootstrapCampaignTransferEvaluator(async () => ({
      outcome: 'inconclusive', rationaleDigest: D('9'),
    })),
    now: () => new Date('2026-08-02T00:00:00.000Z'),
  });
  vi.spyOn(campaignService as never, 'assertAdmission').mockImplementation(() => undefined);
  const startCampaign = vi.spyOn(campaignService, 'startCampaign')
    .mockResolvedValue(fixture.admission);
  vi.spyOn(campaignService, 'closeCampaignClosure').mockResolvedValue({ closureDigest: D('a') } as never);
  vi.spyOn(campaignService as never, 'runFundedCampaignDream').mockResolvedValue({ generation: {
    recommendation: { recommendationDigest: D('b') },
  } });
  const target = campaignService.sealCampaignTransferTarget(fixture.manifest,
    { mode: 'sealed-brief', brief: fixture.targetContent });
  const bridge = () => new TuiBridgeService({ creativeRunCoordinator: coordinator, campaignService,
    progressPersistence: new FileCampaignLedgerPersistence(path.join(root, 'progress')),
    dreamAssimilation: {} as never, dreamQueuePath: path.join(root, 'dreams.json'),
    cognitiveWriter: { beginGenerationLineage: vi.fn(), writeBackGeneration: vi.fn() } as never,
    ownerReactions: { openSession: () => ({}) } as never,
    hostAuthorityRegistry: { resolveActor: ({ credential }) => {
      if (credential === 'owner-auth') {
        return { principalId: 'owner-1', role: 'owner', capability: ownerCapability as never };
      }
      if (credential === 'other-owner-auth') {
        return { principalId: 'owner-2', role: 'owner', capability: otherOwnerCapability as never };
      }
      return undefined;
    } },
  });
  return { ...fixture, target, bridge, composeCampaignStage, finalizeCampaignOrigin,
    startCampaign };
}

describe('compiled campaign continuation CLI transport', () => {
  const services: TuiBridgeService[] = [];
  const servers: TuiBridgeServer[] = [];
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => server.stop()));
    services.splice(0).forEach((service) => service.destroy());
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it('runs the real service continuation and replays it through a fresh service instance', async () => {
    const root = await mkdtemp(`${tmpdir()}/campaign-continuation-endpoint-`);
    roots.push(root);
    const harness = await productHarness(root);
    const firstService = harness.bridge();
    services.push(firstService);
    const registrationSession = firstService.createSession();
    await expect(firstService.registerGovernedCampaignContinuationForHost({
      sessionId: registrationSession.sessionId, ownerCredential: 'other-owner-auth',
      manifest: harness.manifest, plan: harness.plan, checkpoint: harness.checkpoint,
      learningEvidenceId: 'learning-1', target: harness.target,
    })).rejects.toThrow(/OWNER_MISMATCH/);
    await firstService.registerGovernedCampaignContinuationForHost({
      sessionId: registrationSession.sessionId, ownerCredential: 'owner-auth',
      manifest: harness.manifest,
      plan: harness.plan, checkpoint: harness.checkpoint, learningEvidenceId: 'learning-1',
      target: harness.target });

    const invoke = async (service: TuiBridgeService) => {
      const session = service.createSession();
      const server = new TuiBridgeServer(service, { host: '127.0.0.1', port: 0 });
      await server.start();
      servers.push(server);
      const result = await execFileAsync(process.execPath, ['bin/sinter', 'campaign-continue',
        '--bridge-url', server.address, '--session', session.sessionId,
        '--campaign-run-id', harness.campaignRunId], {
        cwd: path.resolve(import.meta.dirname, '../../..'),
        env: { ...process.env, SINTER_OWNER_AUTHORIZATION: 'owner-auth' },
      });
      await server.stop();
      servers.splice(servers.indexOf(server), 1);
      return JSON.parse(result.stdout) as { readonly transferOutcome: string;
        readonly campaignOriginDigest: string };
    };

    const first = await invoke(firstService);
    firstService.destroy();
    services.splice(services.indexOf(firstService), 1);
    const restartedService = harness.bridge();
    services.push(restartedService);
    const replay = await invoke(restartedService);
    expect(first).toMatchObject({ transferOutcome: 'inconclusive', campaignOriginDigest: D('f') });
    expect(replay).toEqual(first);
    expect(harness.composeCampaignStage).toHaveBeenCalledTimes(2);
    expect(harness.finalizeCampaignOrigin).toHaveBeenCalledTimes(1);
  });

  it('rejects another valid owner after a fresh service restart before campaign admission', async () => {
    const root = await mkdtemp(`${tmpdir()}/campaign-continuation-owner-`);
    roots.push(root);
    const harness = await productHarness(root);
    const firstService = harness.bridge();
    services.push(firstService);
    const registrationSession = firstService.createSession();
    await firstService.registerGovernedCampaignContinuationForHost({
      sessionId: registrationSession.sessionId, ownerCredential: 'owner-auth',
      manifest: harness.manifest, plan: harness.plan, checkpoint: harness.checkpoint,
      learningEvidenceId: 'learning-1', target: harness.target,
    });
    firstService.destroy();
    services.splice(services.indexOf(firstService), 1);

    const restartedService = harness.bridge();
    services.push(restartedService);
    const session = restartedService.createSession();
    const server = new TuiBridgeServer(restartedService, { host: '127.0.0.1', port: 0 });
    await server.start();
    servers.push(server);
    const response = await fetch(`${server.address}/api/tui/session/${session.sessionId}`
      + `/governed-campaign/${harness.campaignRunId}/continuation`, {
      method: 'POST', headers: { Authorization: 'Bearer other-owner-auth' }, body: '{}',
    });
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: 'GOVERNED_CAMPAIGN_CONTINUATION_OWNER_MISMATCH',
    });
    expect(harness.startCampaign).not.toHaveBeenCalled();
    expect(harness.composeCampaignStage).not.toHaveBeenCalled();
  });

  it('rejects caller evidence and missing authentication before service dispatch', async () => {
    const root = await mkdtemp(`${tmpdir()}/campaign-continuation-negative-`);
    roots.push(root);
    const harness = await productHarness(root);
    const service = harness.bridge();
    services.push(service);
    const session = service.createSession();
    const server = new TuiBridgeServer(service, { host: '127.0.0.1', port: 0 });
    await server.start();
    servers.push(server);
    const endpoint = `${server.address}/api/tui/session/${session.sessionId}`
      + `/governed-campaign/${harness.campaignRunId}/continuation`;
    expect((await fetch(endpoint, { method: 'POST', body: '{}' })).status).toBe(401);
    const forged = await fetch(endpoint, { method: 'POST', headers: {
      Authorization: 'Bearer owner-auth', 'Content-Type': 'application/json',
    }, body: JSON.stringify({ target: 'shop-this-target' }) });
    expect(forged.status).toBe(400);
  });
});
