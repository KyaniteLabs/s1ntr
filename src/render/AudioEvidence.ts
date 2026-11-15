import type { RenderEvidence } from '../core/types/GenerationEvaluation.js';
import type { AudioCaptureResult } from './HeadlessRenderer.js';

/** Summarize measured samples without retaining the raw capture in evidence. */
export function summarizeAudioCapture(audio?: AudioCaptureResult): RenderEvidence['audio'] {
  if (!audio) return undefined;
  let peakAmplitude = 0;
  let sumSquares = 0;
  for (const sample of audio.samples) {
    const abs = Math.abs(sample);
    if (abs > peakAmplitude) peakAmplitude = abs;
    sumSquares += sample * sample;
  }
  const rmsAmplitude = audio.samples.length > 0 ? Math.sqrt(sumSquares / audio.samples.length) : 0;
  return {
    // Captured-but-all-zero is silence: 'audible' with peak 0 contradicted itself.
    success: audio.success && peakAmplitude > 0,
    sampleRate: audio.sampleRate,
    durationSeconds: audio.duration,
    peakAmplitude: Math.round(peakAmplitude * 1_000_000) / 1_000_000,
    rmsAmplitude: Math.round(rmsAmplitude * 1_000_000) / 1_000_000,
    error: audio.error,
    warningCount: audio.warnings?.length ?? 0,
  };
}
