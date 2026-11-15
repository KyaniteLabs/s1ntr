import { DreamHoldoutVault } from '../../dist/dreaming/research/DreamHoldoutVault.js';
import { sealCreativeKnowledgePolicy }
  from '../../dist/dreaming/research/DreamKnowledgeActivation.js';
import { sealCompoundCreatePolicy } from '../../dist/runtime-core/CompoundCreateProofPort.js';
import { sealDreamActivationPolicy }
  from '../../dist/runtime-core/DreamTransferActivationPort.js';
import { sealProductionDreamRuntimeOptions }
  from '../../dist/runtime-core/ProductionLiminalRuntime.js';

const hex = character => character.repeat(64);
const protocol = Object.freeze({
  originContextDigest: hex('1'), controlContextDigest: hex('2'),
  treatmentContextDigest: hex('2'), findingDigest: hex('3'),
  controlFindingDigest: null, treatmentFindingDigest: hex('3'),
});
const holdout = Object.freeze({ custodyId: 'preview-server-test', bytes: 'sealed-fixture',
  selectorDigest: hex('4'), custodianDigest: hex('5'), protocol });
const transferCommitmentDigest = new DreamHoldoutVault().seal(holdout.bytes, holdout)
  .commitment.commitmentDigest;
const activationPolicy = sealDreamActivationPolicy({
  knowledge: sealCreativeKnowledgePolicy({ minimumRepetitions: 2,
    minimumIndependentStudies: 2, allowedScopes: ['visual'] }),
  compilerRuleVersion: 1, compilerRulePrefix: 'Validated: ', contraindications: [],
});
const compoundPolicy = sealCompoundCreatePolicy({ tasks: [
  { taskId: 'unseen-a', prompt: 'fixture a', domain: 'html', layers: ['depth'],
    targetScope: 'visual', maxTransportAttempts: 1 },
  { taskId: 'unseen-b', prompt: 'fixture b', domain: 'html', layers: ['motion'],
    targetScope: 'visual', maxTransportAttempts: 1 },
], assignments: [
  { taskId: 'unseen-a', firstArmId: 'a-1', secondArmId: 'a-2', treatmentPosition: 0 },
  { taskId: 'unseen-b', firstArmId: 'b-1', secondArmId: 'b-2', treatmentPosition: 1 },
], judgeIdentityDigests: [hex('5'), hex('6')], criterionDigest: hex('7'),
executionContextDigest: hex('8'), minimumEffectSize: 0.1, maximumJudgeDisagreement: 0.1,
regressionVetoThreshold: 0.1, aggregation: 'mean-delta', sampleCount: 2,
minimumTaskWins: 2 });

export const dreamRuntimeOptions = sealProductionDreamRuntimeOptions({
  budget: { maxCandidates: 1, maxProviderAttempts: 1 },
  template: { campaignId: 'preview-server-test', requiredModalities: ['visual'],
    lease: { token: 'preview-server-test', fencingSequence: 1 },
    context: { knowledgeProfileDigest: hex('6'), operatorDigest: hex('7'),
      policyDigest: hex('8'), rendererEnvironmentDigest: hex('9'),
      evaluatorManifestDigests: [hex('a'), hex('b')], transferCommitmentDigest } },
  leaseAuthority: { assertActive() {} }, leaseAuthorityIdentityDigest: hex('c'),
  executorIdentityDigest: hex('d'), executor: () => ({}),
  transfer: { producerIdentityDigest: hex('e'), observerIdentityDigest: hex('f'),
    rendererIdentityDigest: hex('0'), holdout, producer: {}, observer: {},
    evaluators: [
      { identity: { identityDigest: hex('a'), hostDigest: hex('1') } },
      { identity: { identityDigest: hex('b'), hostDigest: hex('2') } },
    ],
    activationPolicy,
    compound: { policy: compoundPolicy, judges: [
      { identityDigest: hex('5') }, { identityDigest: hex('6') },
    ] } },
});
