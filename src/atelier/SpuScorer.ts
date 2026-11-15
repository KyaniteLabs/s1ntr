/**
 * SPU-2.0 scorer — universal domain-quality evaluation (sovereign evaluator v2).
 * Levels are COMPUTED from gate arithmetic, never asked of judges.
 *
 * CEO corrections 2026-08-30:
 * 1. 10-point scale with 2 decimal places (not 5-point with 1 decimal)
 * 2. Standards raised: S means EXCEPTIONAL (8.0+), not "best we've seen"
 *    The old S-threshold (3.5/5 = 7.0/10) let B+ work masquerade as S-tier.
 *
 * Ensemble axes: D craft, A artistic, R reliability, N novelty (0.00-10.00).
 */
export interface SpuAxes { readonly D: number; readonly A: number; readonly R: number; readonly N: number; }
/**
 * CEO calibration 2026-09-02: S = 9.0 — "consistent 9/10 quality" is the S
 * bar. The ladder is graded in BOTH directions: named bands above S, honest
 * sub-S bands below (no undifferentiated floor).
 */
export type SpuLevel = 'F' | 'D' | 'C' | 'B' | 'A' | 'S' | 'SS' | 'SSS' | 'SSS+' | 'PU';

/**
 * SPU-2.0 conjunctive gates on the 10-point scale.
 * Judge self-levels are ignored; these are the HONEST thresholds.
 *
 * The ladder (CEO standard: S = exceptional, not merely good):
 * Calibrated from S = 9.0 (CEO 2026-09-02):
 *   PU    — epochal: 9.9+ everywhere (once-in-a-generation)
 *   SSS+  — masterpiece: 9.65+ craft (museum wall)
 *   SSS   — world-class: 9.4+ craft (you remember this piece)
 *   SS    — exceptional: 9.2+ craft, 9.0+ mean (clearly above the field)
 *   S     — the bar: 9.0+ craft, 8.8+ mean (consistent 9/10 quality)
 *   A     — excellent, not yet S: 8.0+ craft
 *   B     — good: 7.0+ craft
 *   C     — fair: 5.0+ craft
 *   D     — poor: 3.0+ craft
 *   F     — broken/barely-there: below 3
 */
export function computeLevel(axes: SpuAxes): SpuLevel {
  const { D, A, R, N } = axes;
  const mean = (D + A + R + N) / 4;
  if (D >= 9.9 && A >= 9.8 && R >= 9.9 && N >= 9.8) return 'PU';
  if (D >= 9.65 && A >= 9.4 && R >= 9.6 && N >= 9.2) return 'SSS+';
  if (D >= 9.4 && A >= 9.0 && R >= 9.3 && N >= 8.8 && mean >= 9.2) return 'SSS';
  if (D >= 9.2 && A >= 8.8 && R >= 9.0 && N >= 8.5 && mean >= 9.0) return 'SS';
  if (D >= 9.0 && A >= 8.5 && R >= 9.0 && N >= 8.0 && mean >= 8.8) return 'S';
  if (D >= 8.0) return 'A'; // sub-S bands grade by craft: conjunctive strictness starts at S
  if (D >= 7.0) return 'B';
  if (D >= 5.0) return 'C';
  if (D >= 3.0) return 'D';
  return 'F';
}

/** Format a score for display: always 2 decimal places on the 10-point scale. */
export function fmt(v: number): string {
  return v.toFixed(2);
}

/** Parse the first JSON object from judge text (tolerates fences/prose). */
export function parseAxes(text: string): { axes: SpuAxes; judgeLevel: string; defects: unknown[] } | null {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[0]);
    const num = (v: unknown) => typeof v === 'number' && Number.isFinite(v) ? v : null;
    const D = num(parsed.D), A = num(parsed.A), R = num(parsed.R), N = num(parsed.N);
    if (D === null || A === null || R === null || N === null) return null;
    // Judge prompts specify ten points. Low scores do not imply a different scale.
    if ([D, A, R, N].some(value => value < 0 || value > 10)) return null;
    return {
      axes: { D, A, R, N },
      judgeLevel: String(parsed.level ?? 'unrated'),
      defects: Array.isArray(parsed.defects) ? parsed.defects : [],
    };
  } catch { return null; }
}

/** Identify a judge by configured model; provider is required but aliases do not add independence. */
export function canonicalJudgeIdentity(value: unknown): string {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(text)) return '';
  return text.slice(text.lastIndexOf('/') + 1).toLowerCase();
}

export function configuredJudgeIdentity(role: {
  readonly provider?: unknown;
  readonly model?: unknown;
}): string {
  const provider = canonicalJudgeIdentity(role.provider);
  const model = canonicalJudgeIdentity(role.model);
  return provider && model ? model : '';
}

/** Require independent parsed judges before a scorecard can be persisted. */
export function requireIndependentJudges(
  judges: ReadonlyArray<{ readonly vendor?: unknown }>,
): readonly string[] {
  const vendors = [...new Set(judges
    .map(judge => canonicalJudgeIdentity(judge?.vendor))
    .filter(Boolean))];
  if (vendors.length < 2) {
    throw new Error(`SSS_SCORE_INSUFFICIENT_JUDGES:${vendors.length}/2`);
  }
  if (vendors.length !== judges.length) throw new Error('SSS_SCORE_DUPLICATE_OR_INVALID_JUDGE');
  return vendors;
}

// -----------------------------------------------------------------------------
// Judge eye plan (M-20261008-14, producer-requires-verifier repair)
// -----------------------------------------------------------------------------
// Wave-1 evidence: every art host generates on minimax-m3 while the sss-score
// ensemble's hardcoded minimax eye judged that same output — "2 distinct
// judges but family self-overlap". A producer may not verify its own family
// when alternates exist. This pure planner decides which eyes run so the
// caller (bin/sinter) stays wiring-only and the policy stays testable.

/** Coarse judge family from a `provider/model` identity or bare vendor id. */
export function judgeFamily(identity: unknown): string {
  const text = String(identity ?? '').trim().toLowerCase();
  if (!text) return '';
  const model = text.includes('/') ? text.slice(text.lastIndexOf('/') + 1) : text;
  if (model.startsWith('minimax')) return 'minimax';
  if (model.startsWith('glm')) return 'glm';
  if (model.startsWith('gemini')) return 'google';
  if (model.startsWith('grok')) return 'xai';
  if (model.startsWith('gpt') || model.startsWith('o3') || model.startsWith('o4')) return 'openai';
  if (model.startsWith('claude')) return 'anthropic';
  if (model.startsWith('kimi') || model.startsWith('moonshot')) return 'moonshot';
  if (model.startsWith('qwen')) return 'qwen';
  if (model.startsWith('deepseek')) return 'deepseek';
  return text.includes('/') ? text.slice(0, text.indexOf('/')) : model;
}

export interface PlannedJudgeEye {
  /** Judge vendor id (canonical, e.g. 'glm-5.3-flash'). */
  readonly vendor: string;
  /** Which lane the eye rides: the configured evaluator role or a fixed lane. */
  readonly lane: 'evaluator' | 'fixed' | 'fixed-text';
  /** Why the eye is withheld this turn; null = the eye runs. */
  readonly skipReason: null | 'generator-family-exclusion' | 'duplicate-vendor';
  /** True when the judge cannot see images and must receive the
   *  frame-descriptor text contract instead (glm-5.3 flagship class). */
  readonly textMode: boolean;
}

export interface JudgeEyePlan {
  readonly generatorFamily: string;
  readonly eyes: readonly PlannedJudgeEye[];
  /** True when at least one eye was withheld for sharing the generator family. */
  readonly familyExclusionApplied: boolean;
}

/**
 * Decide which judge eyes run for one scoring turn.
 *
 * Rules:
 * 1. The configured evaluator eye runs only when its vendor differs from both
 *    fixed lanes (aliasing adds no independence — canonicalJudgeIdentity law).
 * 2. A fixed eye whose family equals the generator's family is SKIPPED when
 *    the remaining eyes still carry >= 2 distinct vendors (alternates exist).
 *    With fewer than 2 alternates the same-family eye runs anyway — a degraded
 *    self-family ensemble beats no ensemble, and the skip reason is recorded
 *    so the ledger stays honest about it.
 * 3. When the minimax eye was family-skipped and fewer than 2 non-generator
 *    vendors remain, a glm-5.3 TEXT eye is added (glm-5.3 flagship is
 *    text-only by probe evidence; it judges from the frame-descriptor text
 *    contract, never from an image). Grok is key-dead fleet-wide and is
 *    deliberately not a third family lane.
 */
export function judgeEyePlan(input: {
  /** `provider/model` of the artifact's actual generator (provenance first). */
  readonly generatorIdentity: string;
  /** Configured evaluator vendor id ('' when unconfigured). */
  readonly evaluatorVendor: string;
  /** Fixed minimax eye vendor (e.g. 'minimax-m3'). */
  readonly minimaxVendor: string;
  /** Fixed glm flash eye vendor (e.g. 'glm-5.3-flash'). */
  readonly glmFlashVendor: string;
  /** Optional text-contract glm eye vendor (default 'glm-5.3'). */
  readonly glmTextVendor?: string;
  /** Whether the evaluator eye's model accepts images (registry/probe). */
  readonly evaluatorVisionCapable?: boolean;
}): JudgeEyePlan {
  const generatorFamily = judgeFamily(input.generatorIdentity);
  const glmTextVendor = input.glmTextVendor ?? 'glm-5.3';
  const eyes: PlannedJudgeEye[] = [];

  const evaluatorVendor = canonicalJudgeIdentity(input.evaluatorVendor);
  const distinctFromFixed = evaluatorVendor
    && evaluatorVendor !== canonicalJudgeIdentity(input.minimaxVendor)
    && evaluatorVendor !== canonicalJudgeIdentity(input.glmFlashVendor);
  if (distinctFromFixed) {
    eyes.push({
      vendor: evaluatorVendor,
      lane: 'evaluator',
      skipReason: null,
      textMode: input.evaluatorVisionCapable === false,
    });
  }

  const fixedFamilies = new Map<string, string>([
    [canonicalJudgeIdentity(input.minimaxVendor), judgeFamily(input.minimaxVendor)],
    [canonicalJudgeIdentity(input.glmFlashVendor), judgeFamily(input.glmFlashVendor)],
  ]);
  for (const vendor of fixedFamilies.keys()) {
    eyes.push({ vendor, lane: 'fixed', skipReason: null, textMode: false });
  }

  // Family exclusion with the >= 2 distinct alternates quorum floor.
  const alternates = eyes.filter(eye => eye.skipReason === null && eye.vendor
    && familyOfEye(eye.vendor, fixedFamilies) !== generatorFamily);
  const distinctAlternates = new Set(alternates.map(eye => eye.vendor)).size;
  let familyExclusionApplied = false;
  if (distinctAlternates >= 2) {
    for (let i = 0; i < eyes.length; i += 1) {
      const eye = eyes[i];
      if (eye.skipReason === null && familyOfEye(eye.vendor, fixedFamilies) === generatorFamily) {
        eyes[i] = { ...eye, skipReason: 'generator-family-exclusion' };
        familyExclusionApplied = true;
      }
    }
  }

  // Reinforce the ensemble: when the minimax eye was family-skipped and fewer
  // than 2 non-generator vendors remain, add the glm-5.3 text eye.
  const running = eyes.filter(eye => eye.skipReason === null);
  const runningNonGenerator = new Set(running
    .filter(eye => familyOfEye(eye.vendor, fixedFamilies) !== generatorFamily)
    .map(eye => eye.vendor));
  const minimaxEye = eyes.find(eye => eye.vendor === canonicalJudgeIdentity(input.minimaxVendor));
  const minimaxSkipped = minimaxEye?.skipReason === 'generator-family-exclusion';
  if (minimaxSkipped && runningNonGenerator.size < 2
    && generatorFamily !== judgeFamily(glmTextVendor)
    && !running.some(eye => eye.vendor === canonicalJudgeIdentity(glmTextVendor))) {
    eyes.push({ vendor: canonicalJudgeIdentity(glmTextVendor), lane: 'fixed-text', skipReason: null, textMode: true });
  }

  return { generatorFamily, eyes, familyExclusionApplied };
}

function familyOfEye(vendor: string, fixedFamilies: Map<string, string>): string {
  return fixedFamilies.get(vendor) ?? judgeFamily(vendor);
}

export interface SpuScorecard {
  readonly scoreScale: 10;
  readonly scoringContract: 'spu-2.0-literal-v1';
  readonly artifact: string;
  readonly domain: string;
  readonly judges: ReadonlyArray<{ readonly vendor: string; readonly axes: SpuAxes }>;
  readonly ensemble: SpuAxes;
  readonly level: SpuLevel;
  readonly defects: readonly unknown[];
  readonly scoredAt: string;
}

/** Ensemble = per-axis mean across judges (consensus; disagreement recorded via spread in defects). */
export function buildScorecard(input: {
  artifact: string; domain: string;
  judges: ReadonlyArray<{ vendor: string; axes: SpuAxes; defects?: readonly unknown[] }>;
}): SpuScorecard {
  requireIndependentJudges(input.judges);
  const mean = (key: keyof SpuAxes) =>
    input.judges.reduce((sum, j) => sum + j.axes[key], 0) / Math.max(1, input.judges.length);
  const r2 = (v: number) => Math.round(v * 100) / 100; // 2 decimal places
  const ensemble: SpuAxes = { D: r2(mean('D')), A: r2(mean('A')), R: r2(mean('R')), N: r2(mean('N')) };
  return {
    scoreScale: 10, scoringContract: 'spu-2.0-literal-v1',
    artifact: input.artifact, domain: input.domain,
    judges: input.judges.map(j => ({ vendor: j.vendor, axes: j.axes })),
    ensemble, level: computeLevel(ensemble),
    defects: input.judges.flatMap(j => j.defects ?? []),
    scoredAt: new Date().toISOString(),
  };
}
