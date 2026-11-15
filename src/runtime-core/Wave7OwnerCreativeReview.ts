import { WAVE7_CREATIVE_LANES, type Wave7CreativeLaneId } from './Wave7CreativeLadder.js';

export interface OwnerReviewArtifact {
  screenshotRef: string;
  artifactRef: string;
  mediaRef?: string;
  mediaDurationSeconds?: number;
  digest: string;
}

export interface Wave7OwnerReviewPair {
  lane: Wave7CreativeLaneId;
  seedId: string;
  artifactA: OwnerReviewArtifact;
  artifactB: OwnerReviewArtifact;
}

export interface Wave7OwnerReviewInput {
  releaseHead: string;
  sourceFingerprint: string;
  pairs: Wave7OwnerReviewPair[];
}

export interface Wave7OwnerDecision {
  lane: Wave7CreativeLaneId;
  seedId: string;
  choice: 'A' | 'B' | 'tie' | null;
  releaseWorthy: boolean | null;
  reactionEventId: string | null;
  note: string | null;
}

function escape(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;').replaceAll('"', '&quot;');
}

function artifactHtml(label: 'A' | 'B', artifact: OwnerReviewArtifact): string {
  const media = artifact.mediaRef
    ? ` · <a href="${escape(artifact.mediaRef)}">play recorded proof</a>`
    : '';
  return `<figure><a href="${escape(artifact.artifactRef)}"><img src="${escape(artifact.screenshotRef)}" alt="Artifact ${label}"></a><figcaption>Artifact ${label} · <a href="${escape(artifact.artifactRef)}">open interactive artifact</a>${media}</figcaption></figure>`;
}

export function buildWave7OwnerReviewPacket(input: Wave7OwnerReviewInput): {
  html: string;
  decisions: Wave7OwnerDecision[];
} {
  const expected = WAVE7_CREATIVE_LANES.flatMap(lane => lane.seedIds.map(seedId => `${lane.id}:${seedId}`));
  const actual = input.pairs.map(pair => `${pair.lane}:${pair.seedId}`);
  if (actual.join('|') !== expected.join('|')) throw new Error('WAVE7_OWNER_REVIEW_PAIR_CLOSURE_MISMATCH');
  for (const pair of input.pairs) {
    const lane = WAVE7_CREATIVE_LANES.find(item => item.id === pair.lane);
    for (const artifact of [pair.artifactA, pair.artifactB]) {
      if (!artifact.screenshotRef || !artifact.artifactRef || !artifact.digest) throw new Error('WAVE7_OWNER_REVIEW_ARTIFACT_INCOMPLETE');
      if (lane?.audioRequired && (!artifact.mediaRef || !Number.isFinite(artifact.mediaDurationSeconds) || (artifact.mediaDurationSeconds ?? 0) <= 0)) {
        throw new Error('WAVE7_OWNER_REVIEW_PLAYABLE_AUDIO_REQUIRED');
      }
    }
  }
  const sections = WAVE7_CREATIVE_LANES.map(lane => {
    const pairs = input.pairs.filter(pair => pair.lane === lane.id).map(pair => (
      `<article><h3>${escape(pair.seedId)}</h3><div class="grid">${artifactHtml('A', pair.artifactA)}${artifactHtml('B', pair.artifactB)}</div></article>`
    )).join('');
    return `<section><h2>${escape(lane.id)}</h2>${pairs}</section>`;
  }).join('');
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>Wave 7 owner creative review</title><style>body{background:#081018;color:#eaf4ff;font:16px system-ui;margin:0;padding:32px}.grid{display:grid;grid-template-columns:1fr 1fr;gap:16px}figure{margin:0;background:#101c29;padding:10px;border-radius:12px}img{width:100%;aspect-ratio:16/9;object-fit:cover;background:#000}a{color:#8bd3ff}section{margin-bottom:56px}@media(max-width:800px){.grid{grid-template-columns:1fr}}</style></head><body><h1>Wave 7 owner creative review</h1><p>Choose A, B, or tie for each matched pair. Arm identity is sealed until decisions are recorded.</p>${sections}</body></html>`;
  const decisions = input.pairs.map(pair => ({ lane: pair.lane, seedId: pair.seedId, choice: null, releaseWorthy: null, reactionEventId: null, note: null }));
  return { html, decisions };
}
