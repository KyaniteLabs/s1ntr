import type {
  ArtistReviewActionResult, ArtistReviewState,
} from '../creative-run/ArtistReviewExperience.js';

export interface ArtistReviewSurface {
  state(): ArtistReviewState;
  executeAction(token: string): ArtistReviewActionResult;
}

function lines(values: readonly string[], empty: string): string {
  return values.length > 0 ? values.map((value) => `- ${value}`).join('\n') : `- ${empty}`;
}

export function formatArtistReviewState(state: ArtistReviewState): string {
  const candidateLines = state.candidates.flatMap((candidate) => [
    `${candidate.label} (${candidate.blindId}) — ${candidate.hypothesis}`,
    `  Difference: ${candidate.materialDifference}`,
    `  Layers: ${candidate.layerRelationships.join(' | ')}`,
    `  Media: ${candidate.media.map((media) => `${media.modality} ${media.digest}`).join(', ') || 'missing'}`,
    `  Review: ${candidate.review}; ${candidate.reviewNotes.join(' ') || 'no supported note'}`,
    ...(candidate.failure ? [`  Failure: ${candidate.failure}`] : []),
  ]);
  const criticLines = state.critics.map((critic) =>
    `${critic.role}: ${critic.finding} Intervention: ${critic.intervention}`);
  const learning = state.decisions.learning;
  return [
    'ARTIST REVIEW',
    `Creative direction: ${state.thesis.intendedExperienceMeaning}`,
    `Emotional arc: ${state.thesis.perceptualEmotionalArc.join(' → ') || 'not specified'}`,
    'Principles:',
    lines(state.thesis.principles.map((item) => `${item.id}: ${item.rationale}`), 'none'),
    '',
    'CANDIDATES AND EXACT MEDIA',
    lines(candidateLines, 'none'),
    `Contact sheet: included from the exact reviewed bytes (${state.details.packet})`,
    '',
    'CRITIC FINDINGS',
    lines(criticLines, 'none'),
    `Chosen intervention: ${state.intervention}`,
    '',
    'THREE SEPARATE OWNER DECISIONS',
    `Preference: ${state.decisions.preference}`,
    `Release: ${state.decisions.release}`,
    `Learning: ${learning.status}`,
    `Learning scope: ${learning.scope}`,
    `Learning expiry: ${learning.expiresAt ?? 'not authorized'}`,
    `Can revoke now: ${learning.revocable ? 'yes' : 'no'}`,
    `Storage boundary: artist-review transaction memory only`,
    `Later effect: ${learning.laterEffect}`,
    '',
    'READINESS',
    lines(state.blockers, 'No current blockers'),
    `Review complete: ${state.readiness.reviewComplete ? 'yes' : 'no'}`,
    `Release ready: ${state.readiness.releaseReady ? 'yes' : 'no'}`,
    `Ordinary Create learning ready: ${state.readiness.learningReady ? 'yes' : 'no'}`,
    '',
    'AUDIT DETAILS',
    ...Object.entries(state.details).map(([key, value]) => `${key}: ${value}`),
    `State: v${state.decisionVersion} ${state.stateDigest}`,
  ].join('\n');
}

export function runArtistReviewCli(surface: ArtistReviewSurface, token?: string): string {
  if (!token) return formatArtistReviewState(surface.state());
  const result = surface.executeAction(token);
  return `${result.feedback}\n\n${formatArtistReviewState(result.state)}`;
}
