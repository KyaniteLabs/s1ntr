/**
 * Frame precheck for the generate-time smoke render (#1744).
 *
 * A piece can run without a single error and still draw nothing: the evaluator then
 * scores a black frame, which costs a whole take. The smoke render already holds the
 * early and late frames, so a blank one is reported before persist and fed to the
 * repair turn like a runtime error. Domains with no pixel output (audio, blender and
 * revideo, which render outside the page) are never checked. A frame the judge's
 * luminance measure rejects (too dark, washed out, clipped) goes to the same repair turn.
 */
import { analyzeScreenshotBuffer } from '../render/DecodedImageVisibility.js';
import type { RenderResult } from '../render/HeadlessRenderer.js';
import { measureRenderEvidence } from '../perception/RenderEvidencePerception.js';
import type { RenderMeasure } from '../core/types/GenerationEvaluation.js';

const FRAME_DOMAINS: ReadonlySet<string> = new Set([
  'p5', 'three', 'shader', 'glsl', 'hydra', 'svg', 'html', 'dataviz', 'custom', 'meta', 'ascii', 'kinetic', 'hyperframes', 'textgen', 'nbe',
]);

/** Pieces meant to move. Still media (svg, ascii, textgen, dataviz) may legitimately draw one frame. */
const ANIMATED_DOMAINS: ReadonlySet<string> = new Set([
  'p5', 'three', 'shader', 'glsl', 'hydra', 'html', 'custom', 'meta', 'kinetic', 'hyperframes', 'nbe',
]);

/** Only a verdict about the pixels counts: a missing screenshot or a failed decode says nothing. */
const BLANK_REASON = /transparent|blank or solid/;

/** A one-line problem for the repair turn, or null when the frames look fine or cannot be judged. */
export async function smokeFrameProblem(domain: string, smoke: Pick<RenderResult, 'screenshot' | 'lateScreenshot'>): Promise<string | null> {
  if (!FRAME_DOMAINS.has(domain)) return null;
  const late = smoke.lateScreenshot?.success ? smoke.lateScreenshot : smoke.screenshot;
  if (!late?.success || late.buffer.length === 0) return null;
  const analysis = await analyzeScreenshotBuffer(late.buffer);
  if (!analysis.hasVisibleContent && BLANK_REASON.test(analysis.reason ?? '')) {
    return 'your frame is blank: the page ran without errors but drew nothing visible (a single flat colour). Draw visible content from the first frame and keep it drawing.';
  }
  // Early and late frames are 3 s of wall (60 s of piece time) apart: byte-identical PNGs mean nothing moved.
  // Probed on the v16 bench (renderer is fine: shader, p5, html, kinetic differ; the same-frame takes had a
  // dead script or never drew anything animated).
  const early = smoke.screenshot;
  if (ANIMATED_DOMAINS.has(domain) && early?.success && smoke.lateScreenshot?.success
    && early.buffer.length > 0 && early.buffer.equals(smoke.lateScreenshot.buffer)) {
    return 'your frame is static: the first frame and the frame a minute later are identical, so nothing animates. Make the piece change over time (drive it from the clock or the frame count) and keep it moving.';
  }
  return luminanceProblem(await smokeRenderMeasure(smoke));
}

type SmokeFrame = NonNullable<RenderResult['screenshot']>;

const asEvidenceFrame = (frame: SmokeFrame) => ({
  mimeType: 'image/png', dataBase64: frame.buffer.toString('base64'), width: frame.width, height: frame.height,
});

/**
 * The judge's own render measure, taken on the smoke frames. Scoring multiplies the score by 0.6 for
 * any verdict other than ok (ScoringEngine applyRenderMeasurePenalty), so a too-dark frame that the
 * judge rated 0.66 lands at 0.40 and fails admission. The first scored piece on main
 * (first-scored-20261123: mean luminance 0.015, 98% dark) lost exactly this way, with no repair turn.
 */
async function smokeRenderMeasure(smoke: Pick<RenderResult, 'screenshot' | 'lateScreenshot'>): Promise<RenderMeasure | undefined> {
  const early = smoke.screenshot?.success && smoke.screenshot.buffer.length > 0 ? smoke.screenshot : undefined;
  if (!early) return undefined;
  const late = smoke.lateScreenshot?.success && smoke.lateScreenshot.buffer.length > 0 ? smoke.lateScreenshot : undefined;
  try {
    return await measureRenderEvidence({
      timingMs: 0, infraUnavailable: false, candidateFailure: false,
      screenshot: asEvidenceFrame(early),
      ...(late ? { lateScreenshot: asEvidenceFrame(late) } : {}),
    });
  } catch {
    // A failed measure says nothing about the piece.
    return undefined;
  }
}

/** A repair line for a luminance verdict the judge penalizes, in the judge's own repair words. */
export function luminanceProblem(measure: RenderMeasure | undefined): string | null {
  if (!measure || measure.verdict === 'ok') return null;
  const decay = measure.temporalDecay ? ' The first frame was fine; the piece decays into this after it starts, so keep the steady state lit.' : '';
  const stats = `mean luminance ${measure.meanLuminance.toFixed(3)}, ${(measure.darkFraction * 100).toFixed(0)}% dark pixels, ${(measure.brightFraction * 100).toFixed(1)}% bright pixels`;
  switch (measure.verdict) {
    case 'too-dark':
      return `your frame is too dark (${stats}): the judge's measurement cuts the score of a frame like this by 40%. Raise subject luminance, add visible focal highlights and lit areas across the frame, and avoid crushed black backgrounds; keep the composition and the idea.${decay}`;
    case 'washout':
      return `your frame is washed out (${stats}): the judge's measurement cuts the score of a frame like this by 40%. Reduce additive brightness and lightening blends, and restore dark anchors and contrast between subject and background.${decay}`;
    case 'highlight-clipped':
      return `your frame has large clipped highlights (${stats}): the judge's measurement cuts the score of a frame like this by 40%. Reduce concentrated additive highlights while keeping the composition, palette and structure.${decay}`;
    default:
      return `your frame measured ${measure.verdict} (${stats}): the judge's measurement cuts the score of a frame like this by 40%. Increase luminance separation between subject and background.${decay}`;
  }
}

/** Blender failure kinds that mean the host cannot render at all, whatever the script says. */
const BLENDER_ENVIRONMENT_KINDS: ReadonlySet<string> = new Set(['binary-missing', 'sandbox-unavailable']);
/** Blender failure kinds the script caused: the repair turn can fix them. */
const BLENDER_SCRIPT_KINDS: ReadonlySet<string> = new Set(['script', 'no-output']);

type SmokeErrors = Pick<RenderResult, 'success' | 'errors' | 'pageErrors' | 'failureKind' | 'error'>;

/** The reason this host cannot render the domain (Blender missing or unsandboxable), else null. */
export function smokeEnvironmentFailure(smoke: SmokeErrors): string | null {
  if (smoke.success || !smoke.failureKind || !BLENDER_ENVIRONMENT_KINDS.has(smoke.failureKind)) return null;
  return smoke.error ?? smoke.errors[0] ?? `Blender unavailable (${smoke.failureKind})`;
}

/**
 * Browser errors the repair turn should see. An uncaught throw fails the render, and then only the
 * throw used to reach the repair prompt: console errors from the same run (SVG `<path> attribute d:
 * Expected number "M10,NaN"`, #1861) were dropped. A Blender script that raised or drew nothing is
 * the same kind of candidate failure. Any other failure with no uncaught throw is infrastructure
 * (timeout, missing browser) and stays out.
 */
export function smokeRuntimeErrors(smoke: SmokeErrors): string[] {
  if (smoke.success) return [...smoke.errors];
  if (smoke.failureKind && BLENDER_SCRIPT_KINDS.has(smoke.failureKind)) return [...new Set(smoke.errors)];
  const thrown = smoke.pageErrors ?? [];
  if (thrown.length === 0) return [];
  return [...new Set([...thrown, ...smoke.errors])];
}
