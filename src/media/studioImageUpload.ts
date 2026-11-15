/**
 * Studio/chat image upload helper (UMD-V2 I3) — shared envelope with CLI/harness.
 */
import { loadImageAttachment, attachmentReceipt, type ImageAttachment } from './ImageAttachment.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export function acceptStudioImageUpload(
  input: { filePath?: string; buffer?: Buffer; filename?: string },
  opts: { cwd?: string } = {},
): { attachment: ImageAttachment; receipt: ReturnType<typeof attachmentReceipt> } {
  const cwd = opts.cwd ?? process.cwd();
  let filePath = input.filePath;
  if (!filePath && input.buffer) {
    const stage = path.join(os.tmpdir(), 'sinter-image-stage');
    fs.mkdirSync(stage, { recursive: true });
    // basename only — never join raw filenames (path traversal before realpath guard)
    const safeName = path.basename((input.filename || 'upload.bin').replace(/\\/g, '/'));
    if (!safeName || safeName === '.' || safeName === '..' || safeName.includes('\0')) {
      throw Object.assign(new Error(`unsafe upload filename: ${input.filename}`), { code: 'IMAGE_PATH_DENIED' });
    }
    filePath = path.join(stage, safeName);
    fs.writeFileSync(filePath, input.buffer);
  }
  if (!filePath) {
    throw new Error('studio upload requires filePath or buffer');
  }
  const attachment = loadImageAttachment(filePath, {
    source: 'studio',
    role: 'reference',
    allowRoots: [cwd, os.tmpdir(), path.join(os.homedir(), '.sinter')],
  });
  return { attachment, receipt: attachmentReceipt(attachment, { surface: 'studio' }) };
}
