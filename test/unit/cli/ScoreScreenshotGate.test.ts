import { expect, it } from 'vitest';
import sharp from 'sharp';
import { scoreScreenshotGate } from '../../../src/cli/ScoreScreenshotGate.js';
it('rejects black pixels regardless of compression and metadata', async () => {
  const raw = Buffer.alloc(32 * 32 * 3);
  const description = Array.from({length: 6000}, (_, i) => String.fromCharCode(33 + i * 37 % 90)).join('');
  for (const compressionLevel of [0, 9]) {
    const image = await sharp(raw, { raw: { width:32, height:32, channels:3 } })
      .withExif({IFD0:{ImageDescription:description}}).png({compressionLevel}).toBuffer();
    expect(await scoreScreenshotGate(image)).toBe('blank');
  }
});
it('accepts a visible two-tone drawing and refuses corrupt data', async () => {
  const raw = Buffer.alloc(32 * 32 * 3, 30);
  raw.fill(180, 32 * 16 * 3);
  const image = await sharp(raw, { raw: { width:32, height:32, channels:3 } }).png().toBuffer();
  expect(await scoreScreenshotGate(image)).toBe('ok');
  expect(await scoreScreenshotGate(Buffer.from('not an image'))).toBe('blank');
  raw.fill(1); raw.fill(4, 32 * 16 * 3);
  const dark = await sharp(raw, {raw:{width:32,height:32,channels:3}}).png().toBuffer();
  expect(await scoreScreenshotGate(dark)).toBe('dark');
});
