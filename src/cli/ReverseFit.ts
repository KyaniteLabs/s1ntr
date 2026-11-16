/**
 * CLI glue for the exact-duration fit (#711): render the accepted tone/strudel source,
 * measure it against the brief, revise exactly once with the measured critique, and attach
 * the measured fit to the provenance record. Rendering needs a browser, so it is injectable
 * and the default renderer loads the headless renderer on demand.
 */
import { readFile } from 'node:fs/promises';
import { fitWithOneRevision, type FitRecord, type RenderedAudio } from '../reverse/RenderFit.js';
import type { ReverseBrief, ReverseProvenance } from '../reverse/ReverseBrief.js';

export const FIT_DOMAINS: readonly string[] = ['tone', 'strudel'];

/** The fit runs for audio-code domains when a target duration was given. */
export function shouldFit(domain: string | undefined, brief: ReverseBrief | null): boolean {
  return !!brief && brief.provenance.durationSec !== null && !!domain && FIT_DOMAINS.includes(domain);
}

export type AudioRenderer = (code: string, domain: string, durationSec: number) => Promise<RenderedAudio>;

/** Real-time capture of the piece in a headless browser (run on a machine that may run browsers). */
export const renderAudioWithBrowser: AudioRenderer = async (code, domain, durationSec) => {
  const { HeadlessRenderer } = await import('../render/HeadlessRenderer.js');
  const renderer = new HeadlessRenderer();
  try {
    await renderer.initialize();
    const stabilizationTime = Math.ceil(durationSec * 1000) + 1500;
    const result = await renderer.render(code, { domain: domain as 'tone' | 'strudel',
      stabilizationTime, timeout: stabilizationTime + 30000,
      // Capture and audio readback can take several times the requested duration.
      maximumDurationMs: Math.max(60000, stabilizationTime * 4) });
    if (!result.audio?.success) {
      throw new Error(`REVERSE_RENDER_FAILED: ${domain}: ${result.audio?.error ?? result.error ?? 'no audio was captured'}`);
    }
    return { samples: result.audio.samples, sampleRate: result.audio.sampleRate };
  } finally {
    await renderer.close();
  }
};

export interface ReverseFitInput {
  readonly domain: string;
  readonly brief: ReverseBrief;
  readonly sourcePath: string;
  /** Generates again with the critique appended; returns the new accepted source path. */
  readonly regenerate: (critique: string) => Promise<{ sourcePath: string }>;
  readonly render?: AudioRenderer;
}

export interface ReverseFitResult {
  readonly fit: FitRecord;
  /** The source that the fit passed on, or the last one tried. */
  readonly sourcePath: string;
  readonly provenance: ReverseProvenance;
}

export async function runReverseFit(input: ReverseFitInput): Promise<ReverseFitResult> {
  const { brief, domain } = input;
  const durationSec = brief.provenance.durationSec;
  if (durationSec === null) throw new Error('REVERSE_FIT_NEEDS_DURATION: pass --duration to fit the render to a length');
  const render = input.render ?? renderAudioWithBrowser;
  const arc = brief.provenance.arc;
  let sourcePath = input.sourcePath;
  const fit = await fitWithOneRevision({
    arc, durationSec, ending: arc?.ending ?? 'hit',
    render: async () => render(await readFile(sourcePath, 'utf8'), domain, durationSec),
    revise: async (critique) => {
      // The critique says "your previous attempt"; the regenerate call starts fresh, so show it.
      const previous = await readFile(input.sourcePath, 'utf8');
      const withSource = `${critique}\n\nThe previous attempt, to revise:\n\`\`\`\n${previous}\n\`\`\``;
      sourcePath = (await input.regenerate(withSource)).sourcePath;
    },
  });
  return { fit, sourcePath, provenance: { ...brief.provenance, fit } };
}

/** One-line summary of the last measurement for the terminal. */
export function describeFit(fit: FitRecord): string {
  const m = fit.attempts[fit.attempts.length - 1];
  const r = m.correlation === null ? 'n/a' : m.correlation;
  return `${fit.passed ? 'fits' : 'does not fit'}: length ${m.lengthSec} s (target ${fit.targetSec} s), `
    + `envelope r = ${r}, ending ${m.ending.ok ? 'ok' : 'weak'}${fit.revised ? ', revised once' : ''}`;
}
