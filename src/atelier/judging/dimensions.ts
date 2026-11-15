/**
 * Canonical judgeable-dimension ownership table (wayfinder #1113, story J2).
 *
 * This is THE single source of truth for which judging phase owns which
 * dimension of a generative-art verdict. The map is MECE: every dimension
 * has EXACTLY one owner, and every dimension the panel may ever report
 * appears here. Anything not in this table is not a judgeable dimension.
 *
 * The three owning phases (frozen consensus, 2026-09-02):
 * - R1_PERCEPTUAL: what the piece looks/sounds/feels like (vision + audio
 *   judges on the rendered surface).
 * - R2_STRUCTURAL: how well the piece and its code answer the ask (concept,
 *   craft of the system, code health, structure).
 * - R3_INSTRUMENTATION: deterministic probes only — no LLM judging. Every
 *   R3 verdict must come from a measured, reproducible probe.
 *
 * not_applicable semantics: a judged piece reports EVERY dimension of every
 * phase — either a score or an explicit `not_applicable` with a reason.
 * Example: audio musicality on a silent visual piece is an explicit
 * not_applicable, never a silently missing row and never a 0, and it is
 * never averaged over (degraded panels fail loud; a missing judge is never
 * substituted silently).
 *
 * SINTER_DOMAIN_RUBRIC interaction: domain rubrics are WEIGHT OVERLAYS on
 * these canonical dimensions. A domain rubric may re-weight dimensions and
 * re-anchor scoring wording for its domain, but it must NEVER create a new
 * dimension, remove one, or rescore outside the canonical scale. A new or
 * removed dimension means editing this table AND the drift guard
 * (test/unit/atelier/judging/dimension-contract.test.ts) in the same,
 * consciously reviewed change.
 */

/** The judging phases of the panel; each owns a disjoint dimension set. */
export const JUDGING_PHASES = ['R1_PERCEPTUAL', 'R2_STRUCTURAL', 'R3_INSTRUMENTATION'] as const;
export type JudgingPhase = (typeof JUDGING_PHASES)[number];

/**
 * The sensory surface a dimension is judged through. Drives judge routing
 * and the not_applicable rule (auditory dimensions are NA on silent work).
 */
export const DIMENSION_SENSES = ['visual', 'auditory', 'code', 'behavioral', 'conceptual'] as const;
export type DimensionSense = (typeof DIMENSION_SENSES)[number];

/** One row of the ownership table: a dimension and its single owner. */
export interface DimensionOwnership {
  /** Stable snake_case id used in verdicts, trend rows, and overlays. */
  readonly id: string;
  /** The ONLY phase allowed to produce a verdict for this dimension. */
  readonly phase: JudgingPhase;
  /** Sensory surface the dimension is judged through. */
  readonly sense: DimensionSense;
  /** What is judged; carries scope and any not_applicable conditions. */
  readonly description: string;
}

const DIMENSION_ROWS: readonly DimensionOwnership[] = [
  // ── R1 PERCEPTUAL (9): the rendered surface ─────────────────────────────
  {
    id: 'finish-detail',
    phase: 'R1_PERCEPTUAL',
    sense: 'visual',
    description:
      'Finish and detail: polish of the rendered frame at viewing resolution — deliberate marks, resolved edges, absence of unfinished patches. High = every region reads as intended; low = sketchy, smeared, or abandoned areas.',
  },
  {
    id: 'composition',
    phase: 'R1_PERCEPTUAL',
    sense: 'visual',
    description:
      'Composition: hierarchy, balance, and negative space across the frame. High = a clear focal order with purposeful emptiness; low = cluttered, centerless, or dead-space frames.',
  },
  {
    id: 'color-light',
    phase: 'R1_PERCEPTUAL',
    sense: 'visual',
    description:
      'Color, contrast, and lighting: palette coherence, value structure, and light logic. High = intentional palette with legible value separation; low = muddy, clashing, or flat-unintended lighting.',
  },
  {
    id: 'typography-readability',
    phase: 'R1_PERCEPTUAL',
    sense: 'visual',
    description:
      'Typography and readability of any text the piece renders: size, spacing, contrast against background. High = text is comfortably legible at intended view size; low = unreadable, clipped, or jarring type. Pieces with no rendered text are not_applicable, stated explicitly.',
  },
  {
    id: 'spatial-depth-materials',
    phase: 'R1_PERCEPTUAL',
    sense: 'visual',
    description:
      'Spatial depth, camera, and materials: believable (or intentionally stylized) space, camera framing, and surface response. High = coherent depth cues and material reads; low = broken perspective, floaty geometry, plastic-unintended surfaces.',
  },
  {
    id: 'motion-choreography',
    phase: 'R1_PERCEPTUAL',
    sense: 'visual',
    description:
      'Motion choreography as PERCEIVED: timing, easing, rhythm, and staging of movement. High = motion feels composed and motivated; low = erratic, laggy-feeling, or lifeless motion. Static pieces are not_applicable, stated explicitly.',
  },
  {
    id: 'visual-coherence',
    phase: 'R1_PERCEPTUAL',
    sense: 'visual',
    description:
      'Visual coherence: whether all rendered elements read as one piece with one visual language. High = unified style; low = elements that look bolted together or fight for a different style.',
  },
  {
    id: 'aesthetic-impact',
    phase: 'R1_PERCEPTUAL',
    sense: 'conceptual',
    description:
      'Emotional and aesthetic impact: the felt strength of the piece as an experience — mood, memorability, presence. High = the piece lands and lingers; low = indifferent wallpaper. Cross-sensory: judged from everything perceived.',
  },
  {
    id: 'audio-musicality',
    phase: 'R1_PERCEPTUAL',
    sense: 'auditory',
    description:
      'Audio musicality when the piece produces sound: harmony, rhythm, timbre, and audio-visual fit as heard. High = the sound is worth listening to and matches the visuals; low = grating or disconnected audio. Silent visual work: explicit not_applicable with reason — never silently missing, never scored 0.',
  },

  // ── R2 STRUCTURAL (13): the ask and the artifact ────────────────────────
  {
    id: 'brief-fidelity',
    phase: 'R2_STRUCTURAL',
    sense: 'conceptual',
    description:
      'Brief fidelity: does the finished piece match the creative ask — subject, mood, and intent of the brief? High = a viewer familiar with the brief recognizes it immediately; low = the piece answers a different brief.',
  },
  {
    id: 'constraint-adherence',
    phase: 'R2_STRUCTURAL',
    sense: 'conceptual',
    description:
      'Prompt and constraint adherence: explicit constraints honored (theme words, size/budget limits, forbidden moves, required elements). High = every stated constraint verifiably met; low = one or more constraints ignored. Distinct from brief-fidelity: that judges spirit, this judges letter.',
  },
  {
    id: 'conceptual-intent',
    phase: 'R2_STRUCTURAL',
    sense: 'conceptual',
    description:
      'Conceptual intent: is there a legible idea, and does the system carry it? High = the concept is nameable and executed; low = arbitrary decoration with no governing idea.',
  },
  {
    id: 'domain-idiom',
    phase: 'R2_STRUCTURAL',
    sense: 'conceptual',
    description:
      'Domain-idiom mastery: does the piece use the idioms its domain is known for (shader techniques for GLSL, scene-graph practice for Three.js, pattern idioms for p5)? High = fluent native idiom; low = outsider or cargo-cult use of the domain.',
  },
  {
    id: 'generative-sophistication',
    phase: 'R2_STRUCTURAL',
    sense: 'code',
    description:
      'Generative-system sophistication: quality of the generative machinery — parameter space, controlled variation, seeding, emergent behavior. High = a system that could explore a space, not one hardcoded frame; low = static or trivially random output.',
  },
  {
    id: 'code-correctness',
    phase: 'R2_STRUCTURAL',
    sense: 'code',
    description:
      'Code correctness and clarity: the code does what it claims, handles its own failure modes, and reads clearly. High = clean, working logic with no dead paths; low = broken, confused, or dead code.',
  },
  {
    id: 'maintainability',
    phase: 'R2_STRUCTURAL',
    sense: 'code',
    description:
      'Maintainability: can another engineer (or agent) modify this confidently — structure, naming, separation, absence of magic numbers where they hurt. High = changeable without fear; low = tangled one-shot script.',
  },
  {
    id: 'portability-security',
    phase: 'R2_STRUCTURAL',
    sense: 'code',
    description:
      'Portability and security: runs across environments without environment-specific breakage, and takes no unsafe liberties (no eval, no unsafe fetches, no credential exposure). High = drop-in safe; low = fragile or unsafe.',
  },
  {
    id: 'interaction-design',
    phase: 'R2_STRUCTURAL',
    sense: 'behavioral',
    description:
      'Interaction design: quality of the designed interaction affordances — controls, responsiveness to input, feedback. High = interactions discoverable, meaningful, and rewarding; low = dead or hostile interaction. Non-interactive pieces are not_applicable, stated explicitly.',
  },
  {
    id: 'semantic-accessibility',
    phase: 'R2_STRUCTURAL',
    sense: 'code',
    description:
      'Semantic accessibility: semantic structure and assistive affordances in the artifact — titles, roles, labels, alt/aria where media is presented. High = a screen reader gets a meaningful account; low = a mute div. Pure-canvas art with no DOM surface may be not_applicable, stated explicitly.',
  },
  {
    id: 'corpus-novelty',
    phase: 'R2_STRUCTURAL',
    sense: 'conceptual',
    description:
      'Corpus-grounded novelty: distance from the existing corpus in a direction that matters — not novelty for its own sake. High = recognizably not a rerun of the archive; low = a near-duplicate of known pieces.',
  },
  {
    id: 'cross-domain-integration',
    phase: 'R2_STRUCTURAL',
    sense: 'conceptual',
    description:
      'Cross-domain integration: when multiple domains are in play, how well they compose into one work (audio driving visuals, physics feeding color) rather than co-existing. Single-domain pieces are not_applicable, stated explicitly.',
  },
  {
    id: 'remix-fertility',
    phase: 'R2_STRUCTURAL',
    sense: 'conceptual',
    description:
      'Remix fertility: how generatively useful the piece is as a base — parameterizable, decomposable, inviting variation. High = a fertile parent for descendants; low = a dead end.',
  },

  // ── R3 INSTRUMENTATION (8): deterministic probes only ───────────────────
  {
    id: 'render-validity',
    phase: 'R3_INSTRUMENTATION',
    sense: 'visual',
    description:
      'Render/audio validity (probe): the piece produces a real rendered frame (non-blank, non-error canvas) and, if it declares audio, an actual audio graph. Probed deterministically; a probe failure is a verdict, not a skipped check.',
  },
  {
    id: 'replay-determinism',
    phase: 'R3_INSTRUMENTATION',
    sense: 'behavioral',
    description:
      'Replay determinism (probe): same seed, same output — re-run comparison of frames/state. Probed deterministically; drift above tolerance fails.',
  },
  {
    id: 'temporal-stability',
    phase: 'R3_INSTRUMENTATION',
    sense: 'visual',
    description:
      'Temporal quality (probe): fps approximation, jank percentage, flicker/strobe energy, and loop pacing from the multi-frame capture. Probed deterministically from the frame series.',
  },
  {
    id: 'performance-efficiency',
    phase: 'R3_INSTRUMENTATION',
    sense: 'behavioral',
    description:
      'Performance (probe): CPU/GPU/memory footprint while running, measured against the domain budget. Probed deterministically; no LLM opinion involved.',
  },
  {
    id: 'audio-signals',
    phase: 'R3_INSTRUMENTATION',
    sense: 'auditory',
    description:
      'Audio signals (probe): measured audio events, clipping, and silence from the waveform — did audio fire, did it clip, is a declared-audio piece actually silent. Silent visual work: explicit not_applicable with reason — never silently missing.',
  },
  {
    id: 'responsive-behavior',
    phase: 'R3_INSTRUMENTATION',
    sense: 'behavioral',
    description:
      'Responsive behavior (probe): resize/viewport sweep with measured adaptation (canvas tracks container, no letterboxing or overflow). Probed deterministically.',
  },
  {
    id: 'accessibility-checks',
    phase: 'R3_INSTRUMENTATION',
    sense: 'behavioral',
    description:
      'Accessibility checks (probe): deterministic keyboard reachability, focus visibility, contrast measurement, and reduced-motion honoring. These are the measured counterparts of R2 semantic-accessibility; this row reports only probe results.',
  },
  {
    id: 'asset-network-health',
    phase: 'R3_INSTRUMENTATION',
    sense: 'behavioral',
    description:
      'Asset/network failures (probe): failed requests, missing assets, and console errors observed while the piece runs. Probed deterministically; zero failures is the healthy verdict.',
  },
];

/**
 * THE frozen canonical table. One row per judgeable dimension; exactly one
 * owner per dimension. Do not mutate at runtime — drift is caught by the
 * contract test, and changes must go through review.
 */
export const DIMENSION_OWNERSHIP: readonly DimensionOwnership[] = Object.freeze(
  DIMENSION_ROWS.map((row) => Object.freeze({ ...row })),
);

/** All canonical dimension ids, in table order. */
export function dimensionIds(): string[] {
  return DIMENSION_OWNERSHIP.map((d) => d.id);
}

/** The canonical dimensions owned by one phase, in table order. */
export function dimensionsForPhase(phase: JudgingPhase): readonly DimensionOwnership[] {
  return DIMENSION_OWNERSHIP.filter((d) => d.phase === phase);
}

/** Look up one canonical dimension by id; undefined for non-canonical ids. */
export function dimensionById(id: string): DimensionOwnership | undefined {
  return DIMENSION_OWNERSHIP.find((d) => d.id === id);
}

/** Count of canonical dimensions owned by a phase. */
export function dimensionCount(phase: JudgingPhase): number {
  return dimensionsForPhase(phase).length;
}
