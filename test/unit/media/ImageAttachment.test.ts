import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  loadImageAttachment,
  sniffMime,
  attachmentReceipt,
  DEFAULT_MAX_BYTES,
} from '../../../src/media/ImageAttachment.js';

const PNG_1x1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

describe('ImageAttachment', () => {
  it('sniffs png magic', () => {
    expect(sniffMime(PNG_1x1)).toBe('image/png');
  });

  it('loads and stages a png under allowlisted cwd', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'img-att-'));
    const file = path.join(dir, 't.png');
    fs.writeFileSync(file, PNG_1x1);
    // allow tmp by default via homedir/.sinter and tmp stage — pass allowRoots
    const att = loadImageAttachment(file, {
      source: 'fixture',
      role: 'reference',
      allowRoots: [dir, os.tmpdir()],
      stageDir: path.join(dir, 'stage'),
    });
    expect(att.schema).toBe('sinter-image-attachment-v1');
    expect(att.mimeType).toBe('image/png');
    expect(att.sha256).toHaveLength(64);
    expect(fs.existsSync(att.stagedPath)).toBe(true);
    const rec = attachmentReceipt(att);
    expect(rec.imageSha256).toBe(att.sha256);
    expect(JSON.stringify(rec)).not.toMatch(/iVBOR/); // no base64 png in receipt
  });

  it('rejects non-image bytes', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'img-bad-'));
    const file = path.join(dir, 't.bin');
    fs.writeFileSync(file, Buffer.from('not-an-image'));
    expect(() =>
      loadImageAttachment(file, { allowRoots: [dir], stageDir: path.join(dir, 'stage') }),
    ).toThrow(/magic|unsupported/i);
  });

  it('rejects oversized files', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'img-big-'));
    const file = path.join(dir, 't.png');
    // fake large with png header then pad
    const big = Buffer.concat([PNG_1x1, Buffer.alloc(DEFAULT_MAX_BYTES)]);
    fs.writeFileSync(file, big);
    expect(() =>
      loadImageAttachment(file, {
        allowRoots: [dir],
        stageDir: path.join(dir, 'stage'),
        maxBytes: 100,
      }),
    ).toThrow(/maxBytes/i);
  });
});
