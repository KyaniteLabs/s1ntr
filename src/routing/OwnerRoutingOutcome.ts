/**
 * Production writer for the routing bandit: an owner-ACCEPTED, rendered, non-degraded review becomes a
 * (domain, local|cloud) outcome, persisted to ~/.sinter/routing and fed to the Thompson bandit.
 * Best effort: routing history never blocks or fails the review.
 *
 * @module routing/OwnerRoutingOutcome
 */
import { LLMClient } from '../llm/LLMClient.js';
import { Logger } from '../utils/Logger.js';
import type { CreativeAdmissionSigner } from '../runtime-core/CreativeAdmissionAuthority.js';
import type { LiminalCommandResult } from '../runtime-core/LiminalCommandService.js';
import { domainToRoutingType, recordRoutingOutcome } from './RoutingData.js';
import { createRoutingOutcomeAdmission } from './RoutingOutcomeAdmission.js';

export async function recordOwnerAcceptedRouting(
  input: { create: LiminalCommandResult; decisionDigest: string },
  authority: CreativeAdmissionSigner,
): Promise<void> {
  // Unit tests must not write the real ~/.sinter/routing; they opt in with SINTER_ROUTING_DIR.
  if (process.env.NODE_ENV === 'test' && !process.env.SINTER_ROUTING_DIR) return;
  const { create } = input;
  try {
    const localModel = LLMClient.getRawRoleConfig()?.roles?.generatorLocal?.model;
    const model = localModel && create.roles.generator === localModel ? 'local' : 'cloud';
    const domain = domainToRoutingType(create.domain);
    const admission = createRoutingOutcomeAdmission({
      artifactDigest: create.receipt.artifactDigest, evidenceDigest: create.evidence.evidenceDigest!,
      decisionDigest: input.decisionDigest, rendered: (create.evidence.status === 'rendered') as true,
      identityValid: create.evaluation.identityValid as true,
      digestMatched: (create.evaluation.evidenceDigest === create.evidence.evidenceDigest) as true,
      degraded: create.evaluation.degraded as false, role: 'generator', domain, model,
      ownerDecision: 'accepted', criterionScore: create.evaluation.score }, authority);
    await recordRoutingOutcome({ domain, model, qualityScore: create.evaluation.score,
      timestamp: new Date().toISOString(), admission });
  } catch (error) {
    Logger.warn('OwnerRoutingOutcome', 'routing outcome not recorded:', error instanceof Error ? error.message : error);
  }
}
