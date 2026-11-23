/**
 * ReviewLifecycle — the review candidate state machine, kept separate from
 * ReviewManager so callers can depend on it without pulling in the manager.
 */

/**
 * Candidate lifecycle (enforced by ReviewManager.decide):
 *
 *   addCandidate ─► pending ──accept──► accepted
 *                      └─────reject───► rejected
 *
 * A decision is final: accepted/rejected are terminal, so the same verdict
 * cannot be recorded twice and a verdict cannot be silently flipped.
 */
export const CANDIDATE_STATUSES = ['pending', 'accepted', 'rejected'] as const;
export type CandidateStatus = (typeof CANDIDATE_STATUSES)[number];
export const CANDIDATE_TRANSITIONS: Readonly<Record<CandidateStatus, readonly CandidateStatus[]>> = {
  pending: ['accepted', 'rejected'],
  accepted: [],
  rejected: [],
};

export function canTransitionCandidate(from: CandidateStatus, to: CandidateStatus): boolean {
  return CANDIDATE_TRANSITIONS[from].includes(to);
}

export class IllegalReviewTransitionError extends Error {
  constructor(readonly candidateId: string, readonly from: CandidateStatus, readonly to: CandidateStatus) {
    super(`Candidate ${candidateId} is already ${from}; cannot mark it ${to}.`);
    this.name = 'IllegalReviewTransitionError';
  }
}
