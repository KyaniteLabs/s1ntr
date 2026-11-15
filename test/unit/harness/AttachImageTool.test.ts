import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { attachImageTool } from '../../../src/harness/tools/AttachImageTool.js';

const PNG_1x1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

describe('AttachImageTool', () => {
  it('requires path', async () => {
    const r = await attachImageTool.execute({});
    expect(r.success).toBe(false);
  });

  it('attaches png from allowlisted path', async () => {
    const dir = path.join(process.cwd(), 'test/fixtures/images');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'attach-test.png');
    fs.writeFileSync(file, PNG_1x1);
    const r = await attachImageTool.execute({ path: file, role: 'reference' });
    expect(r.success).toBe(true);
    expect(r.data?.attachment.mimeType).toBe('image/png');
    expect(JSON.stringify(r.data?.receipt)).not.toMatch(/iVBOR/);
  });
});
