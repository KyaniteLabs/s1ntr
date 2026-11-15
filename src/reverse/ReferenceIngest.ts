/**
 * Reverse-mode ingest: turn each reference file into a deterministic feature card.
 * No model call happens here. Anything unsupported or undecodable fails loudly,
 * naming the file and the missing decoder; nothing is skipped silently.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdtemp, open, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { analyzeAudio, decodeWav, type AudioFeatures, type DecodedAudio } from './AudioFeatures.js';
import { analyzeSvg, analyzeText, type DiagramFeatures, type TextFeatures } from './DocumentFeatures.js';
import { FFMPEG_TIMEOUT_MS, analyzeImage, analyzeVideo, runFfmpeg, type ImageFeatures, type VideoFeatures }
  from './VisualFeatures.js';

export type ReferenceKind = 'audio' | 'image' | 'video' | 'diagram' | 'text';
export type ReferenceFeatures = AudioFeatures | ImageFeatures | VideoFeatures | DiagramFeatures | TextFeatures;

export interface ReferenceCard {
  readonly kind: ReferenceKind;
  readonly file: string; // basename only; absolute paths stay local
  readonly sha256: string;
  readonly bytes: number;
  readonly features: ReferenceFeatures;
}

export type ReferenceErrorCode = 'UNSUPPORTED' | 'MISSING' | 'NOT_A_FILE' | 'TOO_LARGE' | 'UNDECODABLE' | 'DECODER_MISSING';

export class ReferenceIngestError extends Error {
  constructor(readonly code: ReferenceErrorCode, file: string, detail: string) {
    super(`REVERSE_REF_${code}: ${file}: ${detail}`);
    this.name = 'ReferenceIngestError';
  }
}

/** Largest reference read into memory (hashing and decoding need the whole file). */
export const MAX_REFERENCE_BYTES = 512 * 1024 * 1024;

export type LocalFileErrorCode = 'MISSING' | 'NOT_A_FILE' | 'TOO_LARGE';

export class LocalFileError extends Error {
  constructor(readonly code: LocalFileErrorCode, detail: string) {
    super(detail);
    this.name = 'LocalFileError';
  }
}

const megabytes = (n: number) => `${Math.round(n / (1024 * 1024))} MB`;

/**
 * Read a user-named file only if it is a regular file, not a symlink, and under
 * maxBytes. Symlinks are refused so a reference name can never pull in a private
 * file it points at; fifos and devices are refused so a read can never block or
 * run forever. O_NOFOLLOW + fstat close the gap between the check and the read.
 */
export async function readLocalFile(filePath: string, maxBytes: number): Promise<Buffer> {
  const errno = (e: unknown) => (e as NodeJS.ErrnoException).code ?? (e as Error).message;
  let link;
  try { link = await lstat(filePath); } catch (e) { throw new LocalFileError('MISSING', `cannot read file (${errno(e)})`); }
  if (link.isSymbolicLink()) throw new LocalFileError('NOT_A_FILE', 'is a symlink; pass the real file it points to');
  if (!link.isFile()) throw new LocalFileError('NOT_A_FILE', 'is not a regular file');
  let handle;
  try {
    handle = await open(filePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  } catch (e) {
    if (errno(e) === 'ELOOP') throw new LocalFileError('NOT_A_FILE', 'is a symlink; pass the real file it points to');
    throw new LocalFileError('MISSING', `cannot read file (${errno(e)})`);
  }
  try {
    const st = await handle.stat();
    if (!st.isFile()) throw new LocalFileError('NOT_A_FILE', 'is not a regular file');
    if (st.size > maxBytes) {
      throw new LocalFileError('TOO_LARGE', `${megabytes(st.size)} is over the ${megabytes(maxBytes)} limit`);
    }
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

const NATIVE_AUDIO = new Set(['.wav', '.wave']);
const FFMPEG_AUDIO = new Set(['.mp3', '.flac', '.ogg', '.oga', '.opus', '.m4a', '.aac']);
const IMAGES = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.tiff', '.tif', '.avif']);
const VIDEO = new Set(['.mp4', '.mov', '.mkv', '.webm', '.avi', '.m4v']);
const TEXT = new Set(['.txt', '.md', '.markdown']);

export const SUPPORTED_REFERENCE_EXTENSIONS = [
  ...NATIVE_AUDIO, ...FFMPEG_AUDIO, ...IMAGES, ...VIDEO, '.svg', ...TEXT,
].sort();

export interface IngestOptions {
  /** ffmpeg binary: undefined = look it up on PATH, null = treat as not installed. */
  ffmpeg?: string | null;
  /** Hard limit for each ffmpeg run (default 120 s). */
  timeoutMs?: number;
}

function resolveFfmpeg(opt: IngestOptions['ffmpeg']): string | null {
  if (opt === null) return null;
  const bin = opt ?? 'ffmpeg';
  return spawnSync(bin, ['-version'], { stdio: 'ignore' }).status === 0 ? bin : null;
}

/**
 * ffmpeg reopens files by name and treats prefixes like `concat:` as protocols, so it never gets the
 * caller's path: it gets a private copy of the bytes already checked and hashed, deleted afterwards.
 */
async function withPrivateCopy<T>(buf: Buffer, ext: string, use: (copy: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(tmpdir(), 'sinter-ref-'));
  try {
    const copy = path.join(dir, `ref${ext}`);
    await writeFile(copy, buf, { mode: 0o600, flag: 'wx' });
    return await use(copy);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function decodeWithFfmpeg(ffmpeg: string, input: string, timeoutMs: number, seconds?: number): Promise<DecodedAudio> {
  const rate = 22050;
  const stdout = await runFfmpeg(ffmpeg, [...(seconds ? ['-t', String(seconds)] : []), '-i', input,
    '-map', '0:a:0', '-vn', '-ac', '1', '-ar', String(rate), '-f', 'f32le', '-'], timeoutMs, 1024 * 1024 * 1024);
  const n = Math.floor(stdout.length / 4);
  if (n === 0) throw new Error('ffmpeg produced no audio');
  const samples = new Float32Array(n);
  for (let i = 0; i < n; i++) samples[i] = stdout.readFloatLE(i * 4);
  return { samples, sampleRate: rate };
}

export async function ingestReference(filePath: string, options: IngestOptions = {}): Promise<ReferenceCard> {
  const file = path.basename(filePath);
  const ext = path.extname(filePath).toLowerCase();
  const known = SUPPORTED_REFERENCE_EXTENSIONS.includes(ext);
  if (!known) {
    throw new ReferenceIngestError('UNSUPPORTED', file,
      `no decoder for ${ext || '(no extension)'} references; supported: ${SUPPORTED_REFERENCE_EXTENSIONS.join(' ')}`);
  }
  let buf: Buffer;
  try { buf = await readLocalFile(filePath, MAX_REFERENCE_BYTES); } catch (e) {
    if (e instanceof LocalFileError) throw new ReferenceIngestError(e.code, file, e.message);
    throw e;
  }
  if (buf.length === 0) throw new ReferenceIngestError('UNDECODABLE', file, 'file is empty (0 bytes)');
  const needsFfmpeg = FFMPEG_AUDIO.has(ext) || VIDEO.has(ext);
  const ffmpeg = needsFfmpeg ? resolveFfmpeg(options.ffmpeg) : null;
  if (needsFfmpeg && !ffmpeg) {
    throw new ReferenceIngestError('DECODER_MISSING', file,
      `${ext} needs ffmpeg on PATH to decode; install ffmpeg or convert it to ${VIDEO.has(ext) ? 'an image sequence' : '.wav'}`);
  }
  const timeoutMs = options.timeoutMs ?? FFMPEG_TIMEOUT_MS;
  const base = { file, sha256: createHash('sha256').update(buf).digest('hex'), bytes: buf.length };
  try {
    if (NATIVE_AUDIO.has(ext) || FFMPEG_AUDIO.has(ext)) {
      const audio = NATIVE_AUDIO.has(ext) ? decodeWav(buf)
        : await withPrivateCopy(buf, ext, (copy) => decodeWithFfmpeg(ffmpeg!, copy, timeoutMs));
      return { kind: 'audio', ...base, features: analyzeAudio(audio) };
    }
    if (IMAGES.has(ext)) return { kind: 'image', ...base, features: await analyzeImage(buf) };
    if (VIDEO.has(ext)) {
      const features = await withPrivateCopy(buf, ext, (copy) => analyzeVideo(copy, ffmpeg!, {
        timeoutMs,
        analyzeSoundtrack: async (input, seconds) => analyzeAudio(await decodeWithFfmpeg(ffmpeg!, input, timeoutMs, seconds)),
      }));
      return { kind: 'video', ...base, features };
    }
    if (ext === '.svg') return { kind: 'diagram', ...base, features: analyzeSvg(buf.toString('utf8')) };
    return { kind: 'text', ...base, features: analyzeText(buf.toString('utf8')) };
  } catch (e) {
    if (e instanceof ReferenceIngestError) throw e;
    const msg = (e as Error).message.split('\n')[0];
    throw new ReferenceIngestError('UNDECODABLE', file, `${ext} could not be decoded (${msg})`);
  }
}

/** Ingest in the given order; the first failure aborts the whole run. */
export async function ingestReferences(paths: readonly string[], options: IngestOptions = {}): Promise<ReferenceCard[]> {
  const cards: ReferenceCard[] = [];
  for (const p of paths) cards.push(await ingestReference(p, options));
  return cards;
}
