export interface OwnerLike {
  readonly seat: string;
  readonly id: string;
  readonly at: string;
  readonly uid?: string;
  readonly artifactDigest?: string;
  readonly createKey?: string;
  readonly ownerReviewKey?: string;
}

export const ownerLikeKey = (like: OwnerLike, artifactDigest: string, ownerDecisionDigest: string): string =>
  `like:${like.uid ?? `${like.seat}/${like.id}`}|${ownerDecisionDigest}|${artifactDigest}`;
