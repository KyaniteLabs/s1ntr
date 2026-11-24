import type { RenderEvidence, RenderMeasure } from '../core/types/GenerationEvaluation.js';
import {
  evaluateAudioPerception,
  evaluateTextPerception,
  evaluateVideoPerception,
  evaluateVisualPerception,
} from './HumanPerceptionGuardrails.js';
import type { PerceptionCheckResult } from './types.js';
import {
  analyzeScreenshotBase64,
  decodeImagePixels,
  type DecodedImagePixels,
  type PixelVisibilityAnalysis,
} from '../render/DecodedImageVisibility.js';
import { measureValueStructure } from '../render/ValueStructure.js';
import { measureGlitchLiveness } from '../render/GlitchLiveness.js';
import { measureFrameCoverage } from '../render/FrameCoverage.js';
import { NEAR_FLAT_MAX_STD, verdictFromMeasure } from '../render/LuminanceVerdict.js';

const screenshotAnalysisCache = new WeakMap<RenderEvidence, {
  dataBase64: string;
  analysis: Promise<PixelVisibilityAnalysis>;
}>();

function analyzeEarlyScreenshot(evidence: RenderEvidence): Promise<PixelVisibilityAnalysis> {
  const dataBase64 = evidence.screenshot?.dataBase64 ?? '';
  const cached = screenshotAnalysisCache.get(evidence);
  if (cached?.dataBase64 === dataBase64) return cached.analysis;
  const analysis = analyzeScreenshotBase64(dataBase64);
  screenshotAnalysisCache.set(evidence, { dataBase64, analysis });
  return analysis;
}

function isAudioDomain(domain: string): boolean {
  return /audio|music|tone|strudel/i.test(domain);
}

function isVideoDomain(domain: string): boolean {
  return /video|revideo|hyperframes|cinematic/i.test(domain);
}

function isTextDomain(domain: string): boolean {
  return /text|ascii|caption|creative-writing/i.test(domain);
}

function cacheRenderMeasure(evidence: RenderEvidence, measure: RenderMeasure): RenderMeasure {
  evidence.renderMeasure = measure;
  return measure;
}

function measureFromVisibility(visibility: PixelVisibilityAnalysis): RenderMeasure | undefined {
  if (visibility.sampledPixels === 0 || visibility.reason?.startsWith('decoded image data unavailable')) return undefined;
  return {
    verdict: verdictFromMeasure(visibility),
    meanLuminance: visibility.meanLuminance,
    brightFraction: visibility.brightFraction,
    darkFraction: visibility.darkFraction,
    clippedHighlightFraction: visibility.clippedHighlightFraction,
    clippedBoundsFill: visibility.clippedBoundsFill,
    // LuminanceMeasure documents brightnessStd on the 0..255 luma scale — the
    // same scale verdictFromMeasure consumes above. Normalizing here (FAB-021)
    // made persisted archive measures contradict the calibrated thresholds.
    brightnessStd: visibility.brightnessStd,
  };
}

export async function measureRenderEvidence(evidence: RenderEvidence): Promise<RenderMeasure | undefined> {
  if (evidence.renderMeasure) return evidence.renderMeasure;
  if (!evidence.screenshot || (evidence.screenshot.width ?? 0) <= 0 || (evidence.screenshot.height ?? 0) <= 0) {
    return undefined;
  }
  const visibility = await analyzeEarlyScreenshot(evidence);
  const measure = measureFromVisibility(visibility);
  if (!measure) return undefined;

  // H13: when a late frame exists it is authoritative — it is the steady state
  // a viewer actually sees (animated shaders decay to black after capture, and
  // slow-starting sketches paint after a blank first frame). temporalDecay
  // marks the ok→non-ok transition for scoring and audits.
  if (evidence.lateScreenshot && (evidence.lateScreenshot.width ?? 0) > 0 && (evidence.lateScreenshot.height ?? 0) > 0) {
    const lateVisibility = await analyzeScreenshotBase64(evidence.lateScreenshot.dataBase64);
    const lateMeasure = measureFromVisibility(lateVisibility);
    if (lateMeasure) {
      if (lateMeasure.verdict !== 'ok' && measure.verdict === 'ok') {
        lateMeasure.temporalDecay = true;
      }
      return cacheRenderMeasure(evidence, await withGlitchLiveness(
        await withFrameDiagnostics(lateMeasure, evidence.lateScreenshot.dataBase64),
        evidence.screenshot.dataBase64,
        evidence.lateScreenshot.dataBase64,
      ));
    }
  }
  return cacheRenderMeasure(evidence, await withFrameDiagnostics(measure, evidence.screenshot.dataBase64));
}

async function withFrameDiagnostics(measure: RenderMeasure, dataBase64: string): Promise<RenderMeasure> {
  try {
    const decoded = await decodeImagePixels(Buffer.from(dataBase64, 'base64'));
    return withFrameCoverage(withValueStructure(measure, decoded), decoded);
  } catch {
    return measure;
  }
}

function withValueStructure(measure: RenderMeasure, decoded: DecodedImagePixels): RenderMeasure {
  const valueStructure = measureValueStructure(decoded);
  return valueStructure ? { ...measure, valueStructure } : measure;
}

function withFrameCoverage(measure: RenderMeasure, decoded: DecodedImagePixels): RenderMeasure {
  const frameCoverage = measureFrameCoverage(decoded);
  return frameCoverage ? { ...measure, frameCoverage } : measure;
}

/** Alive-glitch evidence needs both frames: motion between them is what separates alive from frozen. */
async function withGlitchLiveness(measure: RenderMeasure, earlyBase64: string, lateBase64: string): Promise<RenderMeasure> {
  try {
    const glitchLiveness = measureGlitchLiveness(
      await decodeImagePixels(Buffer.from(earlyBase64, 'base64')),
      await decodeImagePixels(Buffer.from(lateBase64, 'base64')),
    );
    return glitchLiveness ? { ...measure, glitchLiveness } : measure;
  } catch {
    return measure;
  }
}

async function hasVisibleScreenshot(evidence: RenderEvidence): Promise<boolean> {
  if (!evidence.screenshot || (evidence.screenshot.width ?? 0) <= 0 || (evidence.screenshot.height ?? 0) <= 0) {
    return false;
  }
  const visibility = await analyzeEarlyScreenshot(evidence);
  const measure = measureFromVisibility(visibility);
  if (measure && !evidence.renderMeasure) cacheRenderMeasure(evidence, measure);
  // Sol L3-07: the late frame is the steady state a viewer keeps, so it decides visibility when one was captured.
  // A start-up blank is fine if the late frame is healthy; a late blank is not rescued by a healthy first frame;
  // a late frame that cannot be decoded is bad evidence, never a silent fall back to the early frame.
  const late = evidence.lateScreenshot;
  if (late && (late.width ?? 0) > 0 && (late.height ?? 0) > 0) {
    try {
      return (await analyzeScreenshotBase64(late.dataBase64)).hasVisibleContent;
    } catch {
      return false;
    }
  }
  return visibility.hasVisibleContent;
}

export async function evaluateRenderEvidencePerception(
  evidence: RenderEvidence,
  domain: string,
): Promise<PerceptionCheckResult> {
  if (isAudioDomain(domain)) {
    return evaluateAudioPerception({
      kind: 'audio',
      isSilent: evidence.audio ? !evidence.audio.success || (evidence.audio.rmsAmplitude ?? 0) === 0 : true,
      peakAmplitude: evidence.audio?.peakAmplitude,
    });
  }

  if (isVideoDomain(domain)) {
    return evaluateVideoPerception({
      kind: 'video',
      hasVisibleFrames: await hasVisibleScreenshot(evidence),
      fps: evidence.video?.fps,
      durationSeconds: evidence.video?.durationSeconds,
    });
  }

  if (isTextDomain(domain)) {
    // Only frame visibility is observed here. There is no OCR, so no text is
    // fabricated: a visible frame does NOT attest which text is shown, nor its
    // legibility or correctness. A blank/absent frame fails, as for visuals.
    const text = evaluateTextPerception({ kind: 'text' });
    if (await hasVisibleScreenshot(evidence)) return text;
    return {
      ...text,
      passed: false,
      issues: [...text.issues, {
        id: 'text.no-visible-render',
        message: 'Text output should render visible content; the captured frame is blank or missing.',
        severity: 'error',
        domain: 'text',
        metric: 'hasVisibleContent',
        value: false,
      }],
    };
  }

  const measure = await measureRenderEvidence(evidence);
  const visual = evaluateVisualPerception({
    kind: 'visual',
    hasVisibleContent: await hasVisibleScreenshot(evidence),
  });
  const issues = [...visual.issues];
  if (measure?.verdict === 'highlight-clipped') {
    issues.push({
      id: 'visual.highlight-clipped',
      message: 'Concentrated clipped highlights erase visible structure in a darker frame.',
      severity: 'error',
      domain: 'visual',
      metric: 'clippedHighlightFraction',
      value: measure.clippedHighlightFraction ?? 0,
    });
  }
  if (measure?.verdict === 'too-dark' && !issues.some(issue => issue.id === 'visual.no-visible-content')) {
    issues.push({
      id: 'visual.too-dark',
      message: 'Rendered frame is near-black / too dark to perceive visible structure.',
      severity: 'error',
      domain: 'visual',
      metric: 'meanLuminance',
      value: measure.meanLuminance,
    });
  }
  const hasScreenshot = Boolean(evidence.screenshot || evidence.lateScreenshot);
  if (
    hasScreenshot
    && measure?.brightnessStd !== undefined
    && Number.isFinite(measure.brightnessStd)
    && measure.brightnessStd < NEAR_FLAT_MAX_STD
    && !issues.some(issue => issue.id === 'visual.no-visible-content' || issue.id === 'visual.too-dark')
  ) {
    issues.push({
      id: 'visual.near-flat',
      message: `Rendered frame is blank or near-flat (brightnessStd=${measure.brightnessStd.toFixed(2)} < ${NEAR_FLAT_MAX_STD}).`,
      severity: 'error',
      domain: 'visual',
      metric: 'brightnessStd',
      value: measure.brightnessStd,
    });
  }
  if (issues.length === visual.issues.length) return visual;
  return {
    ...visual,
    passed: false,
    issues,
  };
}
