import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { frameDescriptorText } from '../../../src/render/FrameDescriptor.js';

async function pngOf(left: [number, number, number], right: [number, number, number]): Promise<Buffer> {
  const width = 48;
  const height = 48;
  const channels = 3;
  const raw = Buffer.alloc(width * height * channels);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const c = x < width / 2 ? left : right;
      const idx = (y * width + x) * channels;
      raw[idx] = c[0];
      raw[idx + 1] = c[1];
      raw[idx + 2] = c[2];
    }
  }
  return sharp(raw, { raw: { width, height, channels } }).png().toBuffer();
}

describe('frameDescriptorText — the text-judge contract (M-20261008-14)', () => {
  it('describes a two-color split deterministically from pixels', async () => {
    const png = await pngOf([0, 200, 0], [255, 140, 0]);
    const text = await frameDescriptorText(png);
    expect(text).toContain('dimensions: 48x48');
    expect(text).toContain('green');
    expect(text).toContain('red/orange');
    expect(text).toContain('3x3 mean-luminance grid');
    // determinism: same bytes → same descriptor
    expect(await frameDescriptorText(png)).toBe(text);
  });

  // Live matrix 2026-11-10: a moonlit-ocean shader (thin ~7/10 highlights on
  // near-black) was described as 'zero bright pixels', and the text-only judge
  // scored it 0.16 as 'no form'. Peak and edge figures must expose it.
  it('exposes sparse highlights on a dark ground that means and bright counts hide', async () => {
    const size = 100;
    const raw = Buffer.alloc(size * size * 3, 8);
    for (let x = 20; x < 80; x += 1) raw.fill(180, (50 * size + x) * 3, (50 * size + x) * 3 + 3);
    const text = await frameDescriptorText(await sharp(raw, { raw: { width: size, height: size, channels: 3 } }).png().toBuffer());
    expect(text).toContain('bright pixels (>8.2/10): 0.0%');
    expect(text).toContain('peak luminance: p99 0.3/10, max 7.1/10');
    expect(text).toMatch(/edge density \(local contrast >0\.8\/10 to a neighbour\): 1\.[0-9]% of samples/);
  });

  it('reports a flat field as having no edges and its own level as peak', async () => {
    const png = await pngOf([40, 40, 40], [40, 40, 40]);
    const text = await frameDescriptorText(png);
    expect(text).toContain('peak luminance: p99 1.6/10, max 1.6/10');
    expect(text).toContain('edge density (local contrast >0.8/10 to a neighbour): 0.0% of samples');
  });

  it('reports unavailability honestly instead of inventing numbers', async () => {
    const text = await frameDescriptorText(Buffer.from('not a png'));
    expect(text).toMatch(/^frame descriptor unavailable:/);
  });
});
