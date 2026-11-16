/**
 * Vision lane: read a storyboard / energy-arc image into the arc schema.
 *
 * This is the one place an image the user passed explicitly as --arc leaves the
 * machine. It is downscaled and re-encoded first, and only this one image is sent.
 */
import path from 'node:path';
import { CapabilityRegistry } from '../llm/CapabilityRegistry.js';
import { ArcValidationError, validateArc, type Arc } from './Arc.js';
import { readLocalFile } from './ReferenceIngest.js';
import { loadSharp } from './VisualFeatures.js';
import { answerJson } from '../llm/ModelOutput.js';

export const VISION_MAX_EDGE = 768;
/** An image --arc may be a large photo; it is downscaled before it is sent. */
export const MAX_ARC_IMAGE_BYTES = 64 * 1024 * 1024;

interface VisionImage { mimeType: string; dataBase64: string; width?: number; height?: number; label?: string }

/** The slice of LLMClient this lane needs (injectable so unit tests never call a provider). */
export interface VisionClient {
  generateWithImages(system: string, user: string, images: VisionImage[],
    signal?: AbortSignal, bypassCache?: boolean, opts?: { jsonMode?: boolean; maxTokens?: number })
    : Promise<{ code: string; success?: boolean; error?: string }>;
  /** When present, the model is checked first: a text-only model would drop the image and guess. */
  resolveEffectiveModel?(): Promise<string>;
}

export interface VisionSendReceipt {
  originalWidth: number;
  originalHeight: number;
  width: number;
  height: number;
  bytes: number;
}

const SYSTEM = [
  'You read a storyboard, mood board or energy-arc diagram and describe the energy a piece of music should follow.',
  'Reply with JSON only, no prose, in exactly this shape:',
  '{"sections":[{"t_start":0,"t_end":20,"energy":0.2,"label":"intro"}],"cues":[{"t":20,"kind":"drop"}]}',
  'Rules: times are seconds; sections are contiguous and in order; energy is 0 (silence) to 1 (peak);',
  'cue kind is one of hit, drop, cut; cues may be empty. Do not describe the image, only the arc.',
].join('\n');

function extractJson(text: string): unknown {
  const body = answerJson(text);
  const from = body.indexOf('{');
  const to = body.lastIndexOf('}');
  return JSON.parse(from >= 0 && to > from ? body.slice(from, to + 1) : body);
}

export async function deriveArcFromImage(filePath: string, durationSec: number, client: VisionClient)
  : Promise<{ arc: Arc; source: string; sent: VisionSendReceipt }> {
  const file = path.basename(filePath);
  const source = `vision:${file}`;
  const original = await readLocalFile(filePath, MAX_ARC_IMAGE_BYTES).catch((e: Error) => {
    throw new Error(`REVERSE_ARC_UNREADABLE: ${file}: ${e.message}`);
  });
  let meta: { width?: number; height?: number };
  let scaled: { data: Buffer; info: { width: number; height: number } };
  try {
    const sharp = await loadSharp();
    meta = await sharp(original).metadata();
    scaled = await sharp(original).rotate()
      .resize(VISION_MAX_EDGE, VISION_MAX_EDGE, { fit: 'inside', withoutEnlargement: true })
      .flatten({ background: '#ffffff' }).jpeg({ quality: 80 }).toBuffer({ resolveWithObject: true });
  } catch (e) {
    throw new Error(`REVERSE_REF_UNDECODABLE: ${file}: image could not be decoded (${(e as Error).message.split('\n')[0]})`);
  }
  if (client.resolveEffectiveModel) {
    const model = await client.resolveEffectiveModel();
    if (!CapabilityRegistry.supportsVision(model)) {
      throw new Error(`REVERSE_VISION_NOT_CAPABLE: ${file}: ${model} cannot see images, so it would guess the arc `
        + 'without them; set the generator role to a vision model, or pass --arc as .json or .svg');
    }
  }
  const sent: VisionSendReceipt = { originalWidth: meta.width ?? 0, originalHeight: meta.height ?? 0,
    width: scaled.info.width, height: scaled.info.height, bytes: scaled.data.length };
  const user = `Target piece length: ${durationSec} seconds. The last section must end at ${durationSec}. `
    + 'Read the attached image as the energy arc of that piece.';
  const response = await client.generateWithImages(SYSTEM, user,
    [{ mimeType: 'image/jpeg', dataBase64: scaled.data.toString('base64'),
      width: sent.width, height: sent.height, label: 'arc' }], undefined, true, { jsonMode: true });
  if (response.success === false) {
    throw new Error(`REVERSE_VISION_FAILED: ${file}: ${response.error ?? 'the vision model returned no answer'}`);
  }
  let parsed: unknown;
  try { parsed = extractJson(response.code ?? ''); } catch {
    throw new ArcValidationError(['not valid JSON (the model may not be vision-capable)'], source);
  }
  return { arc: validateArc(parsed, source), source, sent };
}
