import { analyzeScreenshotBuffer } from '../render/DecodedImageVisibility.js';
import { verdictFromMeasure } from '../render/LuminanceVerdict.js';

/** Fail closed on absent/invalid image data; PNG encoding is not visual evidence. */
export async function scoreScreenshotGate(png: Buffer): Promise<'ok' | 'blank' | 'dark'> {
  const pixels = await analyzeScreenshotBuffer(png);
  if (!pixels.hasVisibleContent) return 'blank';
  return verdictFromMeasure(pixels) === 'too-dark' ? 'dark' : 'ok';
}
