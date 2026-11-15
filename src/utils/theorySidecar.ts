/**
 * Per-artifact theory sidecar: persists the music-theory assessment next to the
 * saved source so every strudel-producing organ surfaces theory output.
 *
 * A failed write must never block saving the artifact, but it is reported so a
 * missing sidecar is explainable.
 */
import { writeFileSync } from 'node:fs';
import { Logger } from './Logger.js';

export function writeTheorySidecar(
  sourcePath: string,
  domain: string | undefined,
  theoryAssessment: readonly string[],
): boolean {
  const sidecarPath = `${sourcePath}.theory.json`;
  try {
    writeFileSync(
      sidecarPath,
      JSON.stringify({ domain, theoryAssessment, ts: new Date().toISOString() }, null, 1),
    );
    return true;
  } catch (err) {
    Logger.warn('theorySidecar', `theory sidecar not written (${sidecarPath}); artifact still saves:`, err);
    return false;
  }
}
