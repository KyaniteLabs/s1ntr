/**
 * Frame descriptor text contract (M-20261008-14, glm vision diagnosis).
 *
 * Probe evidence 2026-10-08: glm-5.3 (flagship) cannot see images on
 * api.z.ai — paas/v4 rejects image content blocks outright (error 1210,
 * "allowed values: ['text']") and the anthropic-compat wire accepts the
 * request but the model cannot access the image (hedged or empty text).
 * Text-only judges therefore score blind unless the frame's measured
 * structure is handed to them explicitly.
 *
 * This module turns a rendered PNG into a DETERMINISTIC text descriptor:
 * dimensions, coverage, palette, luminance distribution, a 3x3 region
 * grid, and the dominant quantized colors. It is evidence, not opinion —
 * every number is computed from pixels, never from the artifact source —
 * so a text-only judge's input is at least explicit about what it sees.
 */
import { decodeImagePixels } from './DecodedImageVisibility.js';

function hueName(r: number, g: number, b: number): string {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const sat = max === 0 ? 0 : (max - min) / max;
  const light = max / 255;
  if (sat < 0.15) {
    if (light < 0.12) return 'near-black';
    if (light < 0.35) return 'dark gray';
    if (light < 0.7) return 'gray';
    return 'near-white';
  }
  if (max === r && g >= b) return 'red/orange';
  if (max === r) return 'red/magenta';
  if (max === g) return 'green';
  if (max === b && r > g) return 'violet';
  return 'blue/cyan';
}

function regionLuminance(
  data: Uint8Array, width: number,
  x0: number, x1: number, y0: number, y1: number,
): number {
  let sum = 0;
  let n = 0;
  const step = Math.max(1, Math.floor(((x1 - x0) * (y1 - y0)) / 1200));
  for (let y = y0; y < y1; y += 1) {
    for (let x = x0; x < x1; x += step) {
      const idx = (y * width + x) * 4;
      const r = data[idx] ?? 0;
      const g = data[idx + 1] ?? 0;
      const b = data[idx + 2] ?? 0;
      sum += (0.299 * r + 0.587 * g + 0.114 * b) / 255;
      n += 1;
    }
  }
  return n > 0 ? sum / n : 0;
}

/**
 * Deterministic text descriptor of a rendered frame, for text-only judges.
 * Bounded (~30 lines), pure function of the PNG bytes.
 */
export async function frameDescriptorText(png: Buffer): Promise<string> {
  let decoded;
  try {
    decoded = await decodeImagePixels(png);
  } catch (error) {
    return `frame descriptor unavailable: ${error instanceof Error ? error.message : 'decode failed'}`;
  }
  const { width, height, data } = decoded;
  const pixelCount = width * height;
  if (pixelCount <= 0 || data.length < pixelCount * 4) {
    return 'frame descriptor unavailable: decoded image data unavailable';
  }

  const maxSamples = 40_000;
  const step = Math.max(1, Math.floor(pixelCount / maxSamples));
  const palette = new Map<number, number>();
  let sampled = 0;
  let luminanceSum = 0;
  let luminanceSqSum = 0;
  let dark = 0;
  let bright = 0;
  let edges = 0;
  const lumHistogram = new Array<number>(101).fill(0);
  const lumAt = (i: number): number =>
    (0.299 * (data[i] ?? 0) + 0.587 * (data[i + 1] ?? 0) + 0.114 * (data[i + 2] ?? 0)) / 255;
  for (let pixel = 0; pixel < pixelCount; pixel += step) {
    const idx = pixel * 4;
    const alpha = data[idx + 3] ?? 255;
    if (alpha <= 8) continue;
    sampled += 1;
    const r = data[idx] ?? 0;
    const g = data[idx + 1] ?? 0;
    const b = data[idx + 2] ?? 0;
    const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
    luminanceSum += lum;
    luminanceSqSum += lum * lum;
    if (lum < 0.12) dark += 1;
    if (lum > 0.82) bright += 1;
    lumHistogram[Math.round(lum * 100)] += 1;
    // Local contrast: sparse highlights (moonlight on water, glyphs on a dark
    // page) vanish in means and the >8.2 bright count, so a text-only judge
    // read a lit nocturne as 'no form' (live matrix 2026-11-10).
    const x = pixel % width;
    const y = Math.floor(pixel / width);
    if ((x + 1 < width && Math.abs(lumAt(idx + 4) - lum) > 0.08)
      || (y + 1 < height && Math.abs(lumAt(idx + width * 4) - lum) > 0.08)) edges += 1;
    // 4-bit-per-channel quantization for the palette census
    const key = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
    palette.set(key, (palette.get(key) ?? 0) + 1);
  }
  if (sampled === 0) return `frame descriptor: ${width}x${height}, fully transparent`;

  const lumPercentile = (q: number): number => {
    let seen = 0;
    for (let bin = 0; bin <= 100; bin += 1) {
      seen += lumHistogram[bin];
      if (seen >= q * sampled) return bin / 10;
    }
    return 10;
  };
  let maxBin = 100;
  while (maxBin > 0 && lumHistogram[maxBin] === 0) maxBin -= 1;
  const meanLum = luminanceSum / sampled;
  const stdLum = Math.sqrt(Math.max(0, luminanceSqSum / sampled - meanLum * meanLum));
  const topColors = [...palette.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([key, count]) => {
      const r = ((key >> 8) & 0xf) * 17;
      const g = ((key >> 4) & 0xf) * 17;
      const b = (key & 0xf) * 17;
      return `${hueName(r, g, b)} rgb(${r},${g},${b}) ${(100 * count / sampled).toFixed(1)}%`;
    });

  const gw = Math.floor(width / 3);
  const gh = Math.floor(height / 3);
  const grid: string[] = [];
  for (let gy = 0; gy < 3; gy += 1) {
    const row: string[] = [];
    for (let gx = 0; gx < 3; gx += 1) {
      const x0 = gx * gw;
      const x1 = gx === 2 ? width : (gx + 1) * gw;
      const y0 = gy * gh;
      const y1 = gy === 2 ? height : (gy + 1) * gh;
      const lum = regionLuminance(data, width, x0, x1, y0, y1);
      row.push((lum * 10).toFixed(1));
    }
    grid.push(row.join(' '));
  }

  return [
    `frame descriptor (deterministic, computed from the rendered PNG):`,
    `- dimensions: ${width}x${height} (${sampled} opaque samples of ${pixelCount} pixels)`,
    `- mean luminance: ${(meanLum * 10).toFixed(2)}/10, luminance stddev ${(stdLum * 10).toFixed(2)}`,
    `- dark pixels (<1.2/10): ${(100 * dark / sampled).toFixed(1)}%, bright pixels (>8.2/10): ${(100 * bright / sampled).toFixed(1)}%`,
    `- peak luminance: p99 ${lumPercentile(0.99).toFixed(1)}/10, max ${(maxBin / 10).toFixed(1)}/10`,
    `- edge density (local contrast >0.8/10 to a neighbour): ${(100 * edges / sampled).toFixed(1)}% of samples`,
    `- distinct quantized colors: ${palette.size}`,
    `- dominant colors: ${topColors.join('; ')}`,
    `- 3x3 mean-luminance grid (0-10, rows top→bottom): ${grid.join(' | ')}`,
  ].join('\n');
}
