import type { DreamExperimentPlan } from '../../../src/dreaming/research/DreamResearchTypes.js';

export function frozenExperiment(): DreamExperimentPlan {
  const digest = (char: string) => char.repeat(64);
  return { aggregateId: 'dream-1', schemaVersion: 1, campaignId: 'campaign-1',
    hypothesis: { id: 'depth', statement: 'Layer ablation will show depth is necessary',
      principle: 'spatial-depth', expectedEffect: 'stronger hierarchy' },
    context: { sourceDigests: [digest('1')], knowledgeProfileDigest: digest('2'),
      parentSetDigest: digest('3'), operatorDigest: digest('4'), policyDigest: digest('5'),
      rendererEnvironmentDigest: digest('6'), evaluatorManifestDigests: [digest('7'), digest('8')],
      transferCommitmentDigest: digest('9') },
    budget: { maximumAttempts: 3 }, requiredModalities: ['visual'],
    lease: { token: 'lease-1', fencingSequence: 1 } };
}
