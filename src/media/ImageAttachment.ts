/**
 * ImageAttachment core (UMD-V2 F5) — load, validate, hash, stage.
 * Zero network. Optional sharp for resize/EXIF strip when available.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export type ImageMime = 'image/png' | 'image/jpeg' | 'image/webp';

export interface ImageAttachment {
  schema: 'sinter-image-attachment-v1';
  sha256: string;
  mimeType: ImageMime;
  byteLength: number;
  source: 'cli' | 'studio' | 'harness-tool' | 'beauty-reject' | 'fixture' | 'stage';
  role?: 'reference' | 'fix-target' | 'style' | 'layout' | 'eval-evidence' | 'moodboard' | 'code-source' | 'seed' | 'unspecified';
  stagedPath: string;
  originalName?: string;
  width?: number;
  height?: number;
}

export interface LoadImageOptions {
  source?: ImageAttachment['source'];
  role?: ImageAttachment['role'];
  maxBytes?: number;
  maxEdge?: number;
  stageDir?: string;
  allowRoots?: string[];
}

const MAGIC: Array<{ mime: ImageMime; test: (b: Buffer) => boolean }> = [
  { mime: 'image/png', test: (b) => b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 },
  { mime: 'image/jpeg', test: (b) => b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { mime: 'image/webp', test: (b) => b.length >= 12 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP' },
];

export const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;
export const DEFAULT_MAX_EDGE = 1280;

export function sniffMime(buf: Buffer): ImageMime | null {
  for (const m of MAGIC) {
    if (m.test(buf)) return m.mime;
  }
  return null;
}

export function sha256Buffer(buf: Buffer): string {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function resolveSafe(filePath: string, allowRoots?: string[]): string {
  const resolved = fs.realpathSync(path.resolve(filePath));
  const roots = (allowRoots && allowRoots.length > 0
    ? allowRoots
    : [process.cwd(), path.join(os.homedir(), '.sinter'), path.join(os.tmpdir(), 'sinter-image-stage')]
  ).map((r) => fs.realpathSync(path.resolve(r)));
  const ok = roots.some((root) => resolved === root || resolved.startsWith(root + path.sep));
  if (!ok) {
    throw Object.assign(new Error(`image path outside allowlisted roots: ${filePath}`), { code: 'IMAGE_PATH_DENIED' });
  }
  return resolved;
}

/**
 * Load image from path into a staged attachment.
 */
export function loadImageAttachment(filePath: string, opts: LoadImageOptions = {}): ImageAttachment {
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  const source = opts.source ?? 'stage';
  const resolved = resolveSafe(filePath, opts.allowRoots);
  const buf = fs.readFileSync(resolved);
  if (buf.byteLength === 0) {
    throw Object.assign(new Error('empty image'), { code: 'IMAGE_EMPTY' });
  }
  if (buf.byteLength > maxBytes) {
    throw Object.assign(new Error(`image exceeds maxBytes ${maxBytes}`), { code: 'IMAGE_TOO_LARGE' });
  }
  const mime = sniffMime(buf);
  if (!mime) {
    throw Object.assign(new Error('unsupported or non-image magic bytes'), { code: 'IMAGE_MIME' });
  }
  const sha = sha256Buffer(buf);
  const stageDir =
    opts.stageDir ??
    path.join(os.homedir(), '.sinter', 'image-stage');
  fs.mkdirSync(stageDir, { recursive: true });
  const ext = mime === 'image/png' ? '.png' : mime === 'image/jpeg' ? '.jpg' : '.webp';
  const stagedPath = path.join(stageDir, `${sha}${ext}`);
  if (!fs.existsSync(stagedPath)) {
    fs.writeFileSync(stagedPath, buf);
  }
  return {
    schema: 'sinter-image-attachment-v1',
    sha256: sha,
    mimeType: mime,
    byteLength: buf.byteLength,
    source,
    role: opts.role ?? 'unspecified',
    stagedPath,
    originalName: path.basename(filePath),
  };
}

export function toProviderImageInput(att: ImageAttachment): { mimeType: string; dataBase64: string } {
  const buf = fs.readFileSync(att.stagedPath);
  return { mimeType: att.mimeType, dataBase64: buf.toString('base64') };
}

export function attachmentReceipt(att: ImageAttachment, extra: Record<string, unknown> = {}) {
  return {
    schema: 'sinter-image-input-receipt-v1',
    imageSha256: att.sha256,
    mimeType: att.mimeType,
    byteLength: att.byteLength,
    source: att.source,
    role: att.role,
    stagedPath: '[redacted-stage]',
    ...extra,
  };
}
