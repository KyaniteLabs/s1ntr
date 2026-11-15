import type { CampaignAuthorityBoundary } from '../../src/creative-run/CampaignService.js';
import type { CampaignExecutionPlan } from '../../src/creative-run/CampaignManifest.js';

/** Explicit no-live-provider boundary for isolated unit tests only. */
export const unitTestCampaignAuthorityBoundary: CampaignAuthorityBoundary = Object.freeze({
  phaseOne: false,
  admittedStageIds: (plan: CampaignExecutionPlan) => plan.stages.map(stage => stage.id),
  assertReservation: () => undefined,
  assertTransport: () => undefined,
});
