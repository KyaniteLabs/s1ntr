/**
 * CreativeQualityRubric v1 — W9C-04
 *
 * Anchored 1-5 scale rubric for independent creative quality judgment.
 * Seven dimensions, each with descriptive anchors at levels 1, 3, and 5.
 * Machine-review eligibility enforces minimum thresholds and quorum.
 *
 * Seam: consumed by BlindReviewEvidence and ArtistReviewExperience to
 * structure specialist + holistic reviewer scores into a eligibility verdict.
 */

// ─── Rubric dimensions ─────────────────────────────────────────────────────

export const RUBRIC_DIMENSIONS = [
  'coherence',
  'specificity',
  'surprise',
  'emotionalTemporalArc',
  'crossModalCausality',
  'intentionality',
  'desireToRevisit',
] as const;

export type RubricDimension = typeof RUBRIC_DIMENSIONS[number];

export interface RubricAnchor {
  readonly level: 1 | 3 | 5;
  readonly description: string;
}

export interface RubricDimensionSpec {
  readonly id: RubricDimension;
  readonly label: string;
  readonly anchors: readonly RubricAnchor[];
  /** Whether this dimension is applicable to non-audio briefs. */
  readonly requiresAudio?: boolean;
  /** Whether this dimension is a hard-floor (must score ≥3 for eligibility). */
  readonly hardFloor?: boolean;
  /** Whether holistic reviewer must score ≥4 on this dimension. */
  readonly holisticMinimum?: number;
}

export const RUBRIC_V1_DIMENSIONS: readonly RubricDimensionSpec[] = Object.freeze([
  {
    id: 'coherence',
    label: 'Coherence',
    hardFloor: true,
    holisticMinimum: 4,
    anchors: [
      { level: 1, description: 'Disconnected elements with no discernible relationship' },
      { level: 3, description: 'Some connections visible but overall structure feels arbitrary' },
      { level: 5, description: 'Every element serves the central thesis; removal of any weakens the whole' },
    ],
  },
  {
    id: 'specificity',
    label: 'Specificity',
    hardFloor: true,
    holisticMinimum: 4,
    anchors: [
      { level: 1, description: 'Generic output that could belong to any prompt' },
      { level: 3, description: 'Some specific choices but largely conventional' },
      { level: 5, description: 'Distinct, particular decisions that make this work unmistakably itself' },
    ],
  },
  {
    id: 'surprise',
    label: 'Surprise',
    anchors: [
      { level: 1, description: 'Completely predictable from the brief' },
      { level: 3, description: 'One or two unexpected choices' },
      { level: 5, description: 'Multiple genuinely surprising decisions that nonetheless fit' },
    ],
  },
  {
    id: 'emotionalTemporalArc',
    label: 'Emotional / Temporal Arc',
    anchors: [
      { level: 1, description: 'Flat or chaotic with no development over time' },
      { level: 3, description: 'Some sense of progression but uneven or unclear' },
      { level: 5, description: 'Clear, compelling arc that rewards sustained attention' },
    ],
  },
  {
    id: 'crossModalCausality',
    label: 'Cross-Modal Causality',
    requiresAudio: true,
    anchors: [
      { level: 1, description: 'Audio and visual operate independently with no causal link' },
      { level: 3, description: 'Some correlation but no genuine causal influence' },
      { level: 5, description: 'Audio and visual drive each other; changing one visibly affects the other' },
    ],
  },
  {
    id: 'intentionality',
    label: 'Intentionality',
    hardFloor: true,
    holisticMinimum: 4,
    anchors: [
      { level: 1, description: 'Choices appear random or accidental' },
      { level: 3, description: 'Some purpose visible but mixed with arbitrary elements' },
      { level: 5, description: 'Every parameter choice reads as deliberate and purposeful' },
    ],
  },
  {
    id: 'desireToRevisit',
    label: 'Desire to Revisit',
    anchors: [
      { level: 1, description: 'No reason to experience this again' },
      { level: 3, description: 'Might revisit once but unlikely to return regularly' },
      { level: 5, description: 'Want to return repeatedly; reveals more on each visit' },
    ],
  },
]);

// ─── Scoring ───────────────────────────────────────────────────────────────

export interface DimensionScore {
  readonly dimension: RubricDimension;
  readonly score: number; // 1-5
  readonly evidenceDigest: string; // SHA-256 of cited evidence
  readonly note?: string;
}

export interface CriticalFlaw {
  readonly dimension: RubricDimension;
  readonly reason: string;
  readonly evidenceDigest: string;
}

export interface CreativeQualityReview {
  readonly schema: 'sinter.creative-quality-review';
  readonly schemaVersion: 1;
  readonly rubricVersion: 'creative-quality-rubric-v1';
  readonly reviewerRole: 'specialist' | 'holistic';
  readonly reviewerModel: string;
  readonly candidateId: string;
  readonly briefId: string;
  readonly scores: readonly DimensionScore[];
  readonly criticalFlaws: readonly CriticalFlaw[];
  readonly audioPresent: boolean;
  readonly reviewedAt: string;
}

// ─── Eligibility computation ──────────────────────────────────────────────

export interface EligibilityResult {
  readonly eligible: boolean;
  readonly failures: readonly string[];
  readonly dimensionSummary: Record<string, number>;
}

export function computeEligibility(
  specialist: CreativeQualityReview | undefined,
  holistic: CreativeQualityReview | undefined,
  audioRequired: boolean,
): EligibilityResult {
  const failures: string[] = [];
  const dimensionSummary: Record<string, number> = {};

  // Quorum: one specialist + one holistic required
  if (!specialist) failures.push('missing-specialist-review');
  if (!holistic) failures.push('missing-holistic-review');

  const reviews = [specialist, holistic].filter(Boolean) as CreativeQualityReview[];

  if (reviews.length < 2) {
    return { eligible: false, failures, dimensionSummary };
  }

  // Compute per-dimension best score across reviewers
  for (const dim of RUBRIC_DIMENSIONS) {
    const scores = reviews
      .flatMap((r) => r.scores.filter((s) => s.dimension === dim))
      .map((s) => s.score);
    if (scores.length > 0) {
      dimensionSummary[dim] = Math.max(...scores);
    }
  }

  // Hard-floor check: hard-floor dimensions must score ≥3
  for (const spec of RUBRIC_V1_DIMENSIONS) {
    if (spec.hardFloor) {
      const score = dimensionSummary[spec.id];
      if (score === undefined) {
        failures.push(`missing-score:${spec.id}`);
      } else if (score < 3) {
        failures.push(`hard-floor-failed:${spec.id}:${score}`);
      }
    }
  }

  // Holistic minimum: coherence, specificity, intentionality must be ≥4 from holistic
  if (holistic) {
    for (const spec of RUBRIC_V1_DIMENSIONS) {
      if (spec.holisticMinimum) {
        const holisticScore = holistic.scores.find((s) => s.dimension === spec.id)?.score;
        if (holisticScore === undefined) {
          failures.push(`holistic-missing:${spec.id}`);
        } else if (holisticScore < spec.holisticMinimum) {
          failures.push(`holistic-below-minimum:${spec.id}:${holisticScore}`);
        }
      }
    }
  }

  // Critical flaw check: any critical flaw disqualifies
  for (const review of reviews) {
    if (review.criticalFlaws.length > 0) {
      failures.push(`critical-flaw:${review.reviewerRole}:${review.criticalFlaws[0]!.dimension}`);
    }
  }

  // Remaining applicable dimensions must score ≥3
  for (const spec of RUBRIC_V1_DIMENSIONS) {
    if (!spec.hardFloor && !spec.holisticMinimum) {
      // Skip audio-required dimensions when audio is absent
      if (spec.requiresAudio && !audioRequired) continue;
      const score = dimensionSummary[spec.id];
      if (score !== undefined && score < 3) {
        failures.push(`below-floor:${spec.id}:${score}`);
      }
    }
  }

  return {
    eligible: failures.length === 0,
    failures,
    dimensionSummary,
  };
}

// ─── Review factory ────────────────────────────────────────────────────────

export function createQualityReview(input: {
  reviewerRole: 'specialist' | 'holistic';
  reviewerModel: string;
  candidateId: string;
  briefId: string;
  scores: Array<{ dimension: RubricDimension; score: number; evidenceDigest: string; note?: string }>;
  criticalFlaws?: Array<{ dimension: RubricDimension; reason: string; evidenceDigest: string }>;
  audioPresent: boolean;
}): CreativeQualityReview {
  return Object.freeze({
    schema: 'sinter.creative-quality-review',
    schemaVersion: 1 as const,
    rubricVersion: 'creative-quality-rubric-v1' as const,
    reviewerRole: input.reviewerRole,
    reviewerModel: input.reviewerModel,
    candidateId: input.candidateId,
    briefId: input.briefId,
    scores: Object.freeze(input.scores.map((s) => Object.freeze({ ...s }))),
    criticalFlaws: Object.freeze((input.criticalFlaws ?? []).map((f) => Object.freeze({ ...f }))),
    audioPresent: input.audioPresent,
    reviewedAt: new Date().toISOString(),
  });
}
