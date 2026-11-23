/**
 * CLI glue for reverse mode (#711): `--ref`, `--arc`, `--duration`, `--cues` on
 * `generate` and `compose`. Parses and validates the flags, ingests the references
 * into deterministic feature cards, resolves the arc, and returns the brief that
 * is appended to the prompt plus the provenance record saved with the artifact.
 */
import { createHash } from 'node:crypto';
import path from 'node:path';
import { ArcValidationError, parseArcJson, parseCuesJson, validateArc, type Arc, type ArcCue }
  from '../reverse/Arc.js';
import { MAX_ARC_IMAGE_BYTES, deriveArcFromImage, deriveArcFromImageBytes, type VisionClient } from '../reverse/ArcVision.js';
import { analyzeSvg, curveToArcSections } from '../reverse/DocumentFeatures.js';
import { LocalFileError, ingestReferences, readLocalFile } from '../reverse/ReferenceIngest.js';
import { buildReverseBrief, deriveArcFromCards, scaleArc, type ReverseBrief, type ReverseProvenance }
  from '../reverse/ReverseBrief.js';
import { writeFileAtomic } from '../utils/atomicWrite.js';

export interface ReverseFlags {
  readonly refs: readonly string[];
  readonly arcPath?: string;
  readonly duration?: number;
  readonly cuesPath?: string;
}

/** The fit renders in real time, so --duration is bounded: 10 minutes at most. */
export const MIN_DURATION_SEC = 1;
export const MAX_DURATION_SEC = 600;
/** --arc/--cues JSON or SVG files are small. */
const MAX_ARC_TEXT_BYTES = 4 * 1024 * 1024;

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.tiff', '.tif', '.avif']);

export const isImagePath = (p: string) => IMAGE_EXTENSIONS.has(path.extname(p).toLowerCase());

function pathFlag(name: string, value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.startsWith('--')) {
    throw new Error(`${name} needs a file path`);
  }
  return value;
}

/** Raw bin/sinter flags -> validated reverse flags, or null when none were given. */
export function parseReverseFlags(flags: { ref?: unknown; arc?: unknown; duration?: unknown; cues?: unknown }): ReverseFlags | null {
  const given = (v: unknown) => v !== undefined;
  if (!given(flags.ref) && !given(flags.arc) && !given(flags.duration) && !given(flags.cues)) return null;
  const refList = !given(flags.ref) ? [] : Array.isArray(flags.ref) ? flags.ref : [flags.ref];
  const refs = refList.map((r) => pathFlag('--ref', r));
  let duration: number | undefined;
  if (given(flags.duration)) {
    const n = typeof flags.duration === 'string' && flags.duration.trim() ? Number(flags.duration) : NaN;
    if (!Number.isFinite(n) || n <= 0) throw new Error('--duration must be a positive number of seconds');
    if (n < MIN_DURATION_SEC || n > MAX_DURATION_SEC) {
      throw new Error(`--duration must be between ${MIN_DURATION_SEC} and ${MAX_DURATION_SEC} seconds (got ${String(flags.duration).trim()})`);
    }
    duration = n;
  }
  return {
    refs,
    ...(given(flags.arc) ? { arcPath: pathFlag('--arc', flags.arc) } : {}),
    ...(duration !== undefined ? { duration } : {}),
    ...(given(flags.cues) ? { cuesPath: pathFlag('--cues', flags.cues) } : {}),
  };
}

export interface PrepareReverseInput extends ReverseFlags {
  readonly visionClient?: VisionClient;
  readonly ffmpeg?: string | null;
}

export interface PreparedReverse {
  readonly brief: ReverseBrief;
  /** Lines to print before generation (arc, vision downscale note, reference hashes). */
  readonly notices: readonly string[];
}

async function readText(file: string, what: string): Promise<string> {
  try { return (await readLocalFile(file, MAX_ARC_TEXT_BYTES)).toString('utf8'); } catch (e) {
    const detail = e instanceof LocalFileError ? e.message : (e as Error).message;
    throw new Error(`REVERSE_${what}_UNREADABLE: ${path.basename(file)}: ${detail}`);
  }
}

const secs = (t: number) => String(Number(t.toFixed(2)));

/** The arc as a short table the user can check before generation spends anything. */
export function formatArc(title: string, arc: Arc): string {
  const end = arc.sections[arc.sections.length - 1].t_end;
  const rows = arc.sections.map((s) => {
    const range = `${s.t_start.toFixed(1)}-${s.t_end.toFixed(1)}`;
    const bar = '#'.repeat(Math.round(s.energy * 10)).padEnd(10);
    return `  ${range.padStart(11)} s  energy ${s.energy.toFixed(2)} ${bar}  ${s.label}`;
  });
  const cues = [...arc.cues].sort((a, b) => a.t - b.t).map((c) => `${c.kind} ${secs(c.t)} s`);
  return [`Arc (${title}), ${secs(end)} s:`, ...rows, `  cues: ${cues.length ? cues.join(', ') : 'none'}`,
    ...(arc.ending ? [`  ending: ${arc.ending}`] : [])].join('\n');
}

type ReadImageArc = (file: string, duration: number) => Promise<
  Awaited<ReturnType<typeof deriveArcFromImageBytes>> & { imageSha256?: string }
>;

export function prepareReverse(input: PrepareReverseInput): Promise<PreparedReverse> {
  return prepareReverseWithArc(input, (file, duration) => {
    if (!input.visionClient) throw new Error(`REVERSE_VISION_CLIENT_MISSING: ${path.basename(file)}: no vision model is available to read the image`);
    return deriveArcFromImage(file, duration, input.visionClient);
  });
}

async function prepareReverseWithArc(input: PrepareReverseInput, readImageArc: ReadImageArc): Promise<PreparedReverse> {
  const { duration } = input;
  const cards = await ingestReferences(input.refs, { ffmpeg: input.ffmpeg });
  const notices: string[] = cards.map((c) => `Reference ${c.file} (${c.kind}) sha256 ${c.sha256.slice(0, 12)}`);
  let arc: Arc | null = null;
  let arcSource = 'none';
  let arcImageSha256: string | undefined;
  let arcTitle = '';
  const cuesName = input.cuesPath ? path.basename(input.cuesPath) : '';
  const cues = input.cuesPath ? parseCuesJson(await readText(input.cuesPath, 'CUES'), cuesName) : undefined;

  if (input.arcPath) {
    const name = path.basename(input.arcPath);
    const ext = path.extname(name).toLowerCase();
    if (ext === '.json') {
      arc = parseArcJson(await readText(input.arcPath, 'ARC'), name);
      const end = arc.sections[arc.sections.length - 1].t_end;
      if (duration !== undefined && Math.abs(end - duration) > duration * 0.01) {
        throw new Error(`REVERSE_ARC_DURATION_MISMATCH: ${name} ends at ${end}s but --duration is ${duration}s; make them match or drop --duration`);
      }
      arcSource = `file:${name}`;
      arcTitle = `from ${name}`;
    } else if (ext === '.svg') {
      if (duration === undefined) throw new Error(`REVERSE_DURATION_REQUIRED: ${name}: --duration is needed to place an svg arc in time`);
      let f;
      try { f = analyzeSvg(await readText(input.arcPath, 'ARC')); } catch (e) {
        if ((e as Error).message.startsWith('REVERSE_')) throw e;
        throw new ArcValidationError([(e as Error).message], name);
      }
      if (!f.curve) throw new ArcValidationError(['the svg has no polyline or path to read as an energy curve'], name);
      arc = validateArc({ sections: curveToArcSections(f.curve, f.labels, duration), cues: [] }, name);
      arcSource = `svg:${name}`;
      arcTitle = `from diagram ${name}`;
    } else if (isImagePath(input.arcPath)) {
      if (duration === undefined) throw new Error(`REVERSE_DURATION_REQUIRED: ${name}: --duration is needed to read an image arc`);
      checkCueRange(cues, cuesName, duration);
      const read = await readImageArc(input.arcPath, duration);
      arcImageSha256 = read.imageSha256;
      const s = read.sent;
      notices.push(`Arc image ${name} downscaled ${s.originalWidth}x${s.originalHeight} to ${s.width}x${s.height} `
        + `(${Math.ceil(s.bytes / 1024)} KB) before sending to the vision model. `
        + 'It is the only image sent; --ref media never leaves this machine.');
      arc = read.arc;
      if (Math.abs(arc.sections[arc.sections.length - 1].t_end - duration) > 1e-6) arc = scaleArc(arc, duration);
      arcSource = `vision:${name}`;
      arcTitle = `read by vision from ${name}`;
    } else {
      throw new Error(`REVERSE_ARC_UNSUPPORTED: ${name}: --arc takes .json, .svg or an image (${[...IMAGE_EXTENSIONS].join(' ')})`);
    }
  } else {
    const derived = deriveArcFromCards(cards);
    if (derived) {
      arc = duration !== undefined ? scaleArc(derived.arc, duration) : derived.arc;
      arcSource = derived.source;
      arcTitle = `derived from ${derived.source.slice('derived:'.length)}`;
    }
  }

  if (cues) {
    if (!arc) throw new Error('REVERSE_CUES_NEED_ARC: --cues needs an arc (pass --arc, or an audio/video --ref to derive one)');
    checkCueRange(cues, cuesName, arc.sections[arc.sections.length - 1].t_end);
    arc = { sections: arc.sections, cues: [...arc.cues, ...cues], ...(arc.ending ? { ending: arc.ending } : {}) };
    arcTitle += ` + cues from ${cuesName}`;
  }
  if (arc) notices.push(formatArc(arcTitle, arc));

  const brief = buildReverseBrief({ cards, arc, arcSource, arcImageSha256, durationSec: duration ?? null });
  return { brief, notices };
}

function checkCueRange(cues: readonly ArcCue[] | undefined, name: string, end: number): void {
  const late = cues?.find(cue => cue.t > end + 1e-6);
  if (late) throw new Error(`REVERSE_CUES_OUT_OF_RANGE: ${name}: cue ${late.kind} at ${secs(late.t)}s is after the arc ends at ${secs(end)}s`);
}

/**
 * Like prepareReverse, but an image --arc is read under a journal-reserved,
 * generator-role provider grant (same authority path compose uses). Everything
 * else needs no provider and runs directly.
 */
export async function prepareReverseGoverned(
  input: ReverseFlags,
  outputRoot: string,
  { replayImageArcOnly = false } = {},
): Promise<PreparedReverse> {
  return prepareReverseWithArc(input, async (arcPath, duration) => {
    const file = path.basename(arcPath);
    const image = await readLocalFile(arcPath, MAX_ARC_IMAGE_BYTES).catch((e: Error) => {
      throw new Error(`REVERSE_ARC_UNREADABLE: ${file}: ${e.message}`);
    });
    const imageSha256 = createHash('sha256').update(image).digest('hex');
    // Replay just the vision reading. References and cues are validated on every invocation.
    const { runProductionCliProviderEffect } = await import('./LiminalProductionProviderEffect.js');
    const { LLMClient } = await import('../llm/LLMClient.js');
    const read = await runProductionCliProviderEffect({
      idempotencyKey: `reverse-arc-read:${imageSha256}:${duration}`,
      binding: { surface: 'cli-reverse-arc', imageSha256, duration },
      outputRoot,
      maxGeneratorAttempts: 1,
      effect: () => {
        if (replayImageArcOnly) throw new Error('LOOPS_RESUME_IMAGE_ARC_MISMATCH: use the saved image and duration or choose a fresh output folder');
        return deriveArcFromImageBytes(image, file, duration, new LLMClient({ role: 'generator' }));
      },
    });
    return { ...read, imageSha256 };
  });
}

export async function writeReverseProvenance(dir: string, provenance: ReverseProvenance): Promise<string> {
  const file = path.join(dir, 'reverse-provenance.json');
  await writeFileAtomic(file, JSON.stringify(provenance, null, 2) + '\n');
  return file;
}
