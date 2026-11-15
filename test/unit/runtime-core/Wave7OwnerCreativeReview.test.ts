import { describe, expect, it } from 'vitest';
import { buildWave7OwnerReviewPacket, type Wave7OwnerReviewInput } from '../../../src/runtime-core/Wave7OwnerCreativeReview.js';
import { WAVE7_CREATIVE_LANES } from '../../../src/runtime-core/Wave7CreativeLadder.js';

const sha = (value: string) => value.padEnd(64, 'a').slice(0, 64);

function input(): Wave7OwnerReviewInput {
  return {
    releaseHead: 'a'.repeat(40), sourceFingerprint: 'b'.repeat(64),
    pairs: WAVE7_CREATIVE_LANES.flatMap(lane => lane.seedIds.map(seedId => ({
      lane: lane.id, seedId,
      artifactA: { screenshotRef: `${seedId}-A.png`, artifactRef: `${seedId}-A.html`, mediaRef: lane.audioRequired ? `${seedId}-A.webm` : undefined, mediaDurationSeconds: lane.audioRequired ? 4 : undefined, digest: sha(`${seedId}a`) },
      artifactB: { screenshotRef: `${seedId}-B.png`, artifactRef: `${seedId}-B.html`, mediaRef: lane.audioRequired ? `${seedId}-B.webm` : undefined, mediaDurationSeconds: lane.audioRequired ? 4 : undefined, digest: sha(`${seedId}b`) },
    }))),
  };
}

describe('Wave7OwnerCreativeReview', () => {
  it('builds a blind complete contact sheet with playable audio and empty owner decisions', () => {
    const packet = buildWave7OwnerReviewPacket(input());
    expect(packet.html).not.toMatch(/control|treatment/i);
    expect(packet.html.match(/play recorded proof/g)).toHaveLength(12);
    expect(packet.decisions).toHaveLength(9);
    expect(packet.decisions.every(item => item.choice === null && item.releaseWorthy === null)).toBe(true);
  });

  it('rejects missing pairs, duplicate seeds, and silent audiovisual evidence', () => {
    const missing = input(); missing.pairs.pop();
    expect(() => buildWave7OwnerReviewPacket(missing)).toThrow(/CLOSURE/);
    const duplicate = input(); duplicate.pairs[1].seedId = duplicate.pairs[0].seedId;
    expect(() => buildWave7OwnerReviewPacket(duplicate)).toThrow(/CLOSURE/);
    const silent = input(); silent.pairs[0].artifactA.mediaDurationSeconds = 0;
    expect(() => buildWave7OwnerReviewPacket(silent)).toThrow(/PLAYABLE_AUDIO/);
  });
});
