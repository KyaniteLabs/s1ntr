import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const MIN_VARIANCE = 8;
const MIN_LUMINANCE = 3;

function frameStats(buffer) {
  const values = [...buffer];
  if (!values.length) return { luminance: 0, variance: 0, samples: 0 };
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length;
  return { luminance: mean, variance, samples: values.length };
}

export async function measureFrame(file) {
  try {
    const sharp = (await import('sharp')).default;
    const { data } = await sharp(file).removeAlpha().greyscale().raw().toBuffer({ resolveWithObject: true });
    return frameStats(data);
  } catch {
    try {
      return frameStats(fs.readFileSync(file));
    } catch {
      // Missing or unreadable capture: let the caller report
      // RENDER_FRAMES_MISSING instead of dying on ENOENT.
      return null;
    }
  }
}

export function artifactIdentity(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

export async function preJudgeArtifact({
  artifactPath,
  validatorResult,
  browserBootEvidence,
  framePaths = [],
  frameStats: suppliedStats = [],
  audioEvidence,
  timedOut = false,
}) {
  const reasons = [];
  const frames = (suppliedStats.length ? suppliedStats : await Promise.all(framePaths.map(measureFrame)))
    .filter(Boolean);
  if (validatorResult === false || validatorResult?.valid === false) reasons.push('VALIDATOR_FAILED');
  if (!browserBootEvidence) reasons.push('BROWSER_BOOT_MISSING');
  if (!frames.length) reasons.push('RENDER_FRAMES_MISSING');
  if (frames.some(frame => !Number.isFinite(frame.luminance) || frame.luminance < MIN_LUMINANCE)) reasons.push('LUMINANCE_TOO_LOW');
  if (frames.some(frame => !Number.isFinite(frame.variance) || frame.variance < MIN_VARIANCE)) reasons.push('PIXEL_VARIANCE_TOO_LOW');
  if (audioEvidence?.required && !audioEvidence.present) reasons.push('AUDIO_SIGNAL_MISSING');
  if (timedOut) reasons.push('RENDER_TIMEOUT');
  return {
    pass: reasons.length === 0,
    reasons,
    artifactIdentity: artifactIdentity(artifactPath),
    frames,
  };
}

export function appendJudgeEvent(trendPath, event) {
  fs.mkdirSync(path.dirname(trendPath), { recursive: true });
  fs.appendFileSync(trendPath, `${JSON.stringify({
    event_type: `judge_call_${event.phase}`,
    schema_version: 'sinter.trend/1.2',
    ts: new Date().toISOString(),
    ...event,
  })}\n`);
}
