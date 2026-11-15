import { describe, expect, it } from 'vitest';
import {
  evaluateWave7CreativeLadder,
  WAVE7_CREATIVE_LANES,
  type Wave7CreativeLadderEvidence,
} from '../../../src/runtime-core/Wave7CreativeLadder.js';

const sha = (char: string) => char.repeat(64);
const floors = { layersPresent: true, coordinated: true, renderPassed: true, playableAudio: true, nonSilent: true, realClock: true, nonDegraded: true, liveEvidence: true };
const scores = { conceptSpecificity: 4, compositionCoherence: 4, temporalBehavior: 4, crossDomainIntegration: 4, desireToKeep: 4 };

function validEvidence(): Wave7CreativeLadderEvidence {
  return {
    releaseHead: 'a'.repeat(40), sourceFingerprint: sha('b'), productDeltaDigest: sha('c'),
    interventionHypothesisDigest: sha('d'),
    lanes: WAVE7_CREATIVE_LANES.map((lane) => ({
      lane: lane.id, retryCount: 0,
      inheritedHypothesisDigest: lane.id === 'p5-tone' ? undefined : sha('d'),
      ownerReleaseWorthy: true,
      trials: lane.seedIds.map((seedId, index) => ({
        seedId,
        control: { artifactDigest: sha(String(index + 1)), floors },
        treatment: { artifactDigest: sha(String(index + 4)), floors },
        owner: { choice: index < 2 ? 'treatment' : 'control', reactionDigest: sha('e'), ownerSessionReceiptDigest: sha('f') },
        reviewer: { choice: index < 2 ? 'treatment' : 'control', scores, receiptDigest: sha('8'), identityVerified: true, sealed: true },
      })),
    })),
    productDelta: {
      diagnosedBy: { model: 'gpt-5.6-sol', effort: 'high', identityVerified: true },
      changedPaths: ['src/core/PromptEnhancer.ts'],
      authorIndependentReview: true, ownerApproved: true, mergedHead: 'a'.repeat(40),
      nextCreateInheritedDeltaDigest: sha('c'),
    },
  };
}

describe('Wave7CreativeLadder', () => {
  it('passes only the complete three-lane matched ladder and inherited product delta', () => {
    const result = evaluateWave7CreativeLadder(validEvidence());
    expect(result.passed).toBe(true);
    expect(result.lanes.every((lane) => lane.passed)).toBe(true);
  });

  it.each([
    ['seed shopping', (value: Wave7CreativeLadderEvidence) => { value.lanes[0].trials[0].seedId = 'lucky-seed'; }],
    ['technical floor miss', (value: Wave7CreativeLadderEvidence) => { value.lanes[0].trials[0].treatment.floors.renderPassed = false; }],
    ['owner shortfall', (value: Wave7CreativeLadderEvidence) => { value.lanes[0].trials[1].owner.choice = 'control'; }],
    ['review absolute floor', (value: Wave7CreativeLadderEvidence) => { value.lanes[0].trials[0].reviewer.scores.desireToKeep = 2; }],
    ['instrumentation-only delta', (value: Wave7CreativeLadderEvidence) => { value.productDelta.changedPaths = ['test/foo.test.ts', 'docs/receipt.md']; }],
    ['unmerged delta', (value: Wave7CreativeLadderEvidence) => { value.productDelta.mergedHead = '9'.repeat(40); }],
    ['missing inheritance', (value: Wave7CreativeLadderEvidence) => { value.productDelta.nextCreateInheritedDeltaDigest = sha('9'); }],
  ])('fails closed on %s', (_label, mutate) => {
    const evidence = validEvidence();
    mutate(evidence);
    expect(evaluateWave7CreativeLadder(evidence).passed).toBe(false);
  });
});
