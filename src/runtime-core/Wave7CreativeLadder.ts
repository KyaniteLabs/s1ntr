export const WAVE7_CREATIVE_LANES = Object.freeze([
  { id: 'p5-tone', seedIds: ['p5-tone-seed-1', 'p5-tone-seed-2', 'p5-tone-seed-3'], audioRequired: true },
  { id: 'three-shader', seedIds: ['three-shader-seed-1', 'three-shader-seed-2', 'three-shader-seed-3'], audioRequired: false },
  { id: 'strudel-p5', seedIds: ['strudel-p5-seed-1', 'strudel-p5-seed-2', 'strudel-p5-seed-3'], audioRequired: true },
] as const);

export const WAVE7_CREATIVE_DECISION_RULE = Object.freeze({
  trialsPerArm: 3,
  technicalFloors: ['layersPresent', 'coordinated', 'renderPassed', 'playableAudio', 'nonSilent', 'realClock', 'nonDegraded', 'liveEvidence'],
  minimumOwnerTreatmentWins: 2,
  minimumReviewerTreatmentWins: 2,
  minimumReviewerMean: 4,
  minimumReviewerDimension: 3,
  ownerReleaseWorthyRequired: true,
  retriesPerLane: 1,
});

export type Wave7CreativeLaneId = typeof WAVE7_CREATIVE_LANES[number]['id'];
export type CreativeChoice = 'control' | 'treatment' | 'tie';

export interface CreativeTechnicalFloors {
  layersPresent: boolean;
  coordinated: boolean;
  renderPassed: boolean;
  playableAudio: boolean;
  nonSilent: boolean;
  realClock: boolean;
  nonDegraded: boolean;
  liveEvidence: boolean;
}

export interface CreativeReviewScores {
  conceptSpecificity: number;
  compositionCoherence: number;
  temporalBehavior: number;
  crossDomainIntegration: number;
  desireToKeep: number;
}

interface ArmEvidence {
  artifactDigest: string;
  floors: CreativeTechnicalFloors;
}

export interface Wave7CreativeTrial {
  seedId: string;
  control: ArmEvidence;
  treatment: ArmEvidence;
  owner: { choice: CreativeChoice; reactionDigest: string; ownerSessionReceiptDigest: string };
  reviewer: { choice: CreativeChoice; scores: CreativeReviewScores; receiptDigest: string; identityVerified: boolean; sealed: boolean };
}

export interface Wave7CreativeLaneEvidence {
  lane: Wave7CreativeLaneId;
  retryCount: number;
  inheritedHypothesisDigest?: string;
  ownerReleaseWorthy: boolean;
  trials: Wave7CreativeTrial[];
}

export interface Wave7CreativeLadderEvidence {
  releaseHead: string;
  sourceFingerprint: string;
  productDeltaDigest: string;
  interventionHypothesisDigest: string;
  lanes: Wave7CreativeLaneEvidence[];
  productDelta: {
    diagnosedBy: { model: string; effort: string; identityVerified: boolean };
    changedPaths: string[];
    authorIndependentReview: boolean;
    ownerApproved: boolean;
    mergedHead: string;
    nextCreateInheritedDeltaDigest: string;
  };
}

export interface Wave7CreativeLaneResult {
  lane: Wave7CreativeLaneId;
  passed: boolean;
  failures: string[];
  ownerTreatmentWins: number;
  reviewerTreatmentWins: number;
  reviewerMean: number;
}

const SHA1 = /^[a-f0-9]{40}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const INSTRUMENTATION_ONLY = /^(?:test|tests|docs|scripts\/proof|\.quality)(?:\/|$)/;

function allDigests(values: string[]): boolean {
  return values.every(value => SHA256.test(value));
}

function floorsPass(floors: CreativeTechnicalFloors, audioRequired: boolean): boolean {
  return floors.layersPresent && floors.coordinated && floors.renderPassed
    && (!audioRequired || floors.playableAudio) && floors.nonSilent && floors.realClock
    && floors.nonDegraded && floors.liveEvidence;
}

function laneResult(
  evidence: Wave7CreativeLaneEvidence,
  contract: typeof WAVE7_CREATIVE_LANES[number],
  hypothesisDigest: string,
): Wave7CreativeLaneResult {
  const failures: string[] = [];
  const seeds = evidence.trials.map(trial => trial.seedId);
  if (seeds.join('|') !== contract.seedIds.join('|')) failures.push('frozen matched seeds drifted');
  if (evidence.retryCount < 0 || evidence.retryCount > 1) failures.push('lane retry cap exceeded');
  if (contract.id !== 'p5-tone' && evidence.inheritedHypothesisDigest !== hypothesisDigest) {
    failures.push('transfer lane did not inherit the frozen intervention hypothesis');
  }
  let ownerTreatmentWins = 0;
  let reviewerTreatmentWins = 0;
  const scoreValues: number[] = [];
  for (const trial of evidence.trials) {
    if (!allDigests([trial.control.artifactDigest, trial.treatment.artifactDigest, trial.owner.reactionDigest, trial.owner.ownerSessionReceiptDigest, trial.reviewer.receiptDigest])) failures.push(`${trial.seedId}: invalid evidence digest`);
    if (!floorsPass(trial.control.floors, contract.audioRequired) || !floorsPass(trial.treatment.floors, contract.audioRequired)) failures.push(`${trial.seedId}: technical floor failed`);
    if (trial.owner.choice === 'treatment') ownerTreatmentWins += 1;
    if (trial.reviewer.choice === 'treatment') reviewerTreatmentWins += 1;
    if (!trial.reviewer.identityVerified || !trial.reviewer.sealed) failures.push(`${trial.seedId}: reviewer identity or seal missing`);
    const scores = Object.values(trial.reviewer.scores);
    if (scores.length !== 5 || scores.some(score => !Number.isFinite(score) || score < 3 || score > 5)) failures.push(`${trial.seedId}: reviewer absolute floor failed`);
    scoreValues.push(...scores);
  }
  const reviewerMean = scoreValues.length ? scoreValues.reduce((sum, score) => sum + score, 0) / scoreValues.length : 0;
  if (ownerTreatmentWins < 2) failures.push('owner treatment preference below two of three');
  if (reviewerTreatmentWins < 2) failures.push('reviewer treatment preference below two of three');
  if (reviewerMean < 4) failures.push('reviewer mean below 4.0');
  if (!evidence.ownerReleaseWorthy) failures.push('owner release-worthy flag missing');
  return { lane: evidence.lane, passed: failures.length === 0, failures, ownerTreatmentWins, reviewerTreatmentWins, reviewerMean };
}

export function evaluateWave7CreativeLadder(evidence: Wave7CreativeLadderEvidence): {
  passed: boolean;
  failures: string[];
  lanes: Wave7CreativeLaneResult[];
} {
  const failures: string[] = [];
  if (!SHA1.test(evidence.releaseHead) || !allDigests([
    evidence.sourceFingerprint,
    evidence.productDeltaDigest,
    evidence.interventionHypothesisDigest,
  ])) failures.push('release source binding is invalid');
  const laneIds = evidence.lanes.map(lane => lane.lane);
  if (laneIds.join('|') !== WAVE7_CREATIVE_LANES.map(lane => lane.id).join('|')) {
    failures.push('creative ladder lane order or closure drifted');
  }
  const lanes = WAVE7_CREATIVE_LANES.map(contract => {
    const lane = evidence.lanes.find(candidate => candidate.lane === contract.id);
    if (!lane) {
      return { lane: contract.id, passed: false, failures: ['lane missing'], ownerTreatmentWins: 0, reviewerTreatmentWins: 0, reviewerMean: 0 };
    }
    return laneResult(lane, contract, evidence.interventionHypothesisDigest);
  });
  const delta = evidence.productDelta;
  if (delta.diagnosedBy.model !== 'gpt-5.6-sol' || delta.diagnosedBy.effort !== 'high' || !delta.diagnosedBy.identityVerified) {
    failures.push('product delta lacks verified Sol-high diagnosis');
  }
  if (delta.changedPaths.length === 0 || delta.changedPaths.every(path => INSTRUMENTATION_ONLY.test(path))) {
    failures.push('product delta is instrumentation-only');
  }
  if (!delta.authorIndependentReview || !delta.ownerApproved) failures.push('product delta review or owner approval missing');
  if (delta.mergedHead !== evidence.releaseHead) failures.push('product delta is not merged on release HEAD');
  if (delta.nextCreateInheritedDeltaDigest !== evidence.productDeltaDigest) failures.push('next Create did not inherit product delta');
  if (lanes.some(lane => !lane.passed)) failures.push('one or more creative lanes failed');
  return { passed: failures.length === 0, failures, lanes };
}
