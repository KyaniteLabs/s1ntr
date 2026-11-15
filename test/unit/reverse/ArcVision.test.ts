import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ArcValidationError } from '../../../src/reverse/Arc.js';
import { deriveArcFromImage, VISION_MAX_EDGE, type VisionClient } from '../../../src/reverse/ArcVision.js';

const ARC_JSON = JSON.stringify({
  sections: [{ t_start: 0, t_end: 10, energy: 0.2, label: ' intro ' }, { t_start: 10, t_end: 30, energy: 0.9, label: 'peak' }],
  cues: [{ t: 10, kind: 'drop' }],
});

let dir: string;
let imagePath: string;

function client(overrides: Partial<VisionClient> & { code?: string; success?: boolean; error?: string } = {}) {
  const generateWithImages = vi.fn().mockResolvedValue({
    code: overrides.code ?? ARC_JSON, success: overrides.success, error: overrides.error,
  });
  return { generateWithImages, resolveEffectiveModel: overrides.resolveEffectiveModel } as VisionClient & {
    generateWithImages: ReturnType<typeof vi.fn>;
  };
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'arc-vision-'));
  imagePath = join(dir, 'board.png');
  const big = await sharp({ create: { width: 1600, height: 800, channels: 3, background: '#336699' } }).png().toBuffer();
  writeFileSync(imagePath, big);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('deriveArcFromImage', () => {
  it('downscales the image, sends only that one jpeg, and returns the validated arc with a receipt', async () => {
    const c = client();
    const out = await deriveArcFromImage(imagePath, 30, c);
    expect(out.source).toBe('vision:board.png');
    expect(out.arc.sections.map(s => s.label)).toEqual(['intro', 'peak']);
    expect(out.arc.cues).toEqual([{ t: 10, kind: 'drop' }]);
    expect(out.sent).toMatchObject({ originalWidth: 1600, originalHeight: 800, width: VISION_MAX_EDGE, height: 384 });
    const [, user, images, signal, bypass, opts] = c.generateWithImages.mock.calls[0];
    expect(user).toContain('Target piece length: 30 seconds');
    expect(images).toHaveLength(1);
    expect(images[0]).toMatchObject({ mimeType: 'image/jpeg', width: 768, height: 384, label: 'arc' });
    expect(Buffer.from(images[0].dataBase64, 'base64')).toHaveLength(out.sent.bytes);
    expect(signal).toBeUndefined();
    expect(bypass).toBe(true);
    expect(opts).toEqual({ jsonMode: true });
  });

  it('accepts JSON wrapped in a code fence with prose around it', async () => {
    const out = await deriveArcFromImage(imagePath, 30, client({ code: `Here you go:\n\`\`\`json\n${ARC_JSON}\n\`\`\`\nDone.` }));
    expect(out.arc.sections).toHaveLength(2);
  });

  it('refuses a text-only model before sending anything', async () => {
    const c = client({ resolveEffectiveModel: () => Promise.resolve('glm-5.3') });
    await expect(deriveArcFromImage(imagePath, 30, c)).rejects.toThrow('REVERSE_VISION_NOT_CAPABLE: board.png: glm-5.3 cannot see images');
    expect(c.generateWithImages).not.toHaveBeenCalled();
  });

  it('lets a vision model through', async () => {
    const c = client({ resolveEffectiveModel: () => Promise.resolve('glm-5.3-flash') });
    await expect(deriveArcFromImage(imagePath, 30, c)).resolves.toMatchObject({ source: 'vision:board.png' });
  });

  it('reports a missing file as unreadable', async () => {
    await expect(deriveArcFromImage(join(dir, 'gone.png'), 30, client())).rejects.toThrow(/^REVERSE_ARC_UNREADABLE: gone\.png:/);
  });

  it('reports undecodable bytes as REVERSE_REF_UNDECODABLE', async () => {
    const bad = join(dir, 'bad.png');
    writeFileSync(bad, 'definitely not an image');
    await expect(deriveArcFromImage(bad, 30, client())).rejects.toThrow(/^REVERSE_REF_UNDECODABLE: bad\.png: image could not be decoded/);
  });

  it('turns a provider failure into REVERSE_VISION_FAILED with its message', async () => {
    await expect(deriveArcFromImage(imagePath, 30, client({ success: false, error: 'rate limited' })))
      .rejects.toThrow('REVERSE_VISION_FAILED: board.png: rate limited');
  });

  it('uses a default message when the failed response carries none', async () => {
    await expect(deriveArcFromImage(imagePath, 30, client({ success: false })))
      .rejects.toThrow('the vision model returned no answer');
  });

  it('rejects a non-JSON answer as an arc validation error', async () => {
    const err = await deriveArcFromImage(imagePath, 30, client({ code: 'I see a nice picture' })).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ArcValidationError);
    expect((err as ArcValidationError).problems).toEqual(['not valid JSON (the model may not be vision-capable)']);
  });

  it('rejects JSON that is not a valid arc and names the problem', async () => {
    const err = await deriveArcFromImage(imagePath, 30, client({ code: '{"sections":[]}' })).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ArcValidationError);
    expect((err as ArcValidationError).problems).toContain('sections must be a non-empty array');
  });
});
