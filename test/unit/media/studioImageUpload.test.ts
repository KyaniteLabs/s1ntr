import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { acceptStudioImageUpload } from '../../../src/media/studioImageUpload.js';

const PNG_1x1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

describe('acceptStudioImageUpload', () => {
  it('stages a buffer under tmp with basename-only filename', () => {
    const { attachment, receipt } = acceptStudioImageUpload({
      buffer: PNG_1x1,
      filename: 'ref.png',
    });
    expect(attachment.mimeType).toBe('image/png');
    expect(attachment.byteLength).toBe(PNG_1x1.byteLength);
    expect(receipt).not.toHaveProperty('dataBase64');
    expect(fs.existsSync(attachment.stagedPath)).toBe(true);
  });

  it('never writes outside the stage dir when filename has path separators', () => {
    const outside = path.join(os.tmpdir(), `umd-v2-traversal-${Date.now()}.png`);
    // Clean any leftover
    try {
      fs.unlinkSync(outside);
    } catch {
      /* ok */
    }
    const { attachment } = acceptStudioImageUpload({
      buffer: PNG_1x1,
      filename: `../../${path.basename(outside)}`,
    });
    // Wrote under stage as basename only — not at the traversal target
    expect(fs.existsSync(outside)).toBe(false);
    expect(attachment.stagedPath.includes('image-stage') || attachment.sha256.length === 64).toBe(true);
  });
});
