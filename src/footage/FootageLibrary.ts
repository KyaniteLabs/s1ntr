/**
 * FootageLibrary - licence-checked clips with one provenance manifest each.
 *
 * Sources: (a) S1NTR's own renders (kind "own"), (b) outside footage under CC0, public domain,
 * CC-BY or CC-BY-SA (kind "outside"), (c) user-supplied footage (kind "user", a personal-taste hook).
 * ND is rejected because a glitch is a derivative work; NC is rejected because the launch is commercial.
 * The credit line travels with the clip: wall cards and reels read it from here, never retype it.
 */
import { createHash } from 'node:crypto';
import { closeSync, constants, copyFileSync, existsSync, fstatSync, mkdirSync, openSync, readFileSync, readdirSync, readSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const FOOTAGE_ROOT_ENV = 'SINTER_FOOTAGE_ROOT';
export const ALLOWED_LICENCES: readonly string[] = [
  'CC0-1.0', 'PD', 'CC-BY-1.0', 'CC-BY-2.0', 'CC-BY-2.5', 'CC-BY-3.0', 'CC-BY-4.0',
  'CC-BY-SA-1.0', 'CC-BY-SA-2.0', 'CC-BY-SA-2.5', 'CC-BY-SA-3.0', 'CC-BY-SA-4.0',
  'S1NTR-OWN', 'USER-SUPPLIED',
];

export class FootageError extends Error {}

export type FootageKind = 'own' | 'outside' | 'user';
export interface FootageManifest {
  id: string;
  file: string;
  kind: FootageKind;
  source: string;
  sourceUrl: string;
  downloadUrl?: string;
  title: string;
  author: string;
  licence: string;
  licenceUrl?: string;
  creditLine: string;
  sha256: string;
  bytes: number;
  retrievedAt: string;
  durationSec?: number;
  width?: number;
  height?: number;
}

export function checkLicence(id: string): { ok: true } | { ok: false; reason: string } {
  if (ALLOWED_LICENCES.includes(id)) return { ok: true };
  if (/(^|-)ND(-|$)/.test(id)) return { ok: false, reason: `licence "${id}" forbids derivatives and a glitch is a derivative work` };
  if (/(^|-)NC(-|$)/.test(id)) return { ok: false, reason: `licence "${id}" forbids commercial use and the launch is commercial` };
  return { ok: false, reason: `licence "${id}" is not on the whitelist (${ALLOWED_LICENCES.join(', ')})` };
}

const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const REQUIRED_TEXT = ['id', 'file', 'kind', 'source', 'sourceUrl', 'title', 'author', 'licence', 'creditLine', 'sha256', 'retrievedAt'] as const;

export function parseManifest(raw: unknown): FootageManifest {
  if (!raw || typeof raw !== 'object') throw new FootageError('manifest is not an object');
  const m = raw as Record<string, unknown>;
  for (const key of REQUIRED_TEXT) {
    if (typeof m[key] !== 'string' || !(m[key] as string).trim()) throw new FootageError(`manifest field "${key}" is missing`);
  }
  if (!SAFE_NAME.test(m.id as string) || !SAFE_NAME.test(m.file as string)) throw new FootageError('manifest id and file must be plain file names');
  if (!['own', 'outside', 'user'].includes(m.kind as string)) throw new FootageError(`manifest kind "${String(m.kind)}" is not own, outside or user`);
  if (!/^[0-9a-f]{64}$/.test(m.sha256 as string)) throw new FootageError('manifest sha256 must be 64 hex characters');
  const licence = checkLicence(m.licence as string);
  if (!licence.ok) throw new FootageError(licence.reason);
  if (typeof m.bytes !== 'number' || !(m.bytes >= 0)) throw new FootageError('manifest bytes must be a number');
  return m as unknown as FootageManifest;
}

export function creditLines(manifests: readonly FootageManifest[]): string[] {
  return [...new Set(manifests.map((m) => m.creditLine))];
}

export function defaultFootageRoot(env: Readonly<Record<string, string | undefined>> = process.env): string {
  return env[FOOTAGE_ROOT_ENV] || path.join(os.homedir(), '.sinter', 'footage');
}

function sha256File(file: string, checkBudget?: () => void): string {
  const fd = openSync(file, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    if (!fstatSync(fd).isFile()) throw new FootageError('footage must be a regular file');
    const hash = createHash('sha256');
    const buffer = Buffer.alloc(64 * 1024);
    for (;;) {
      checkBudget?.();
      const bytes = readSync(fd, buffer, 0, buffer.length, null);
      if (bytes === 0) return hash.digest('hex');
      hash.update(buffer.subarray(0, bytes));
    }
  } finally {
    closeSync(fd);
  }
}

function slug(name: string): string {
  return name.replace(/\.[^.]+$/, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'clip';
}

export class FootageLibrary {
  constructor(readonly root: string = defaultFootageRoot()) {}

  private scan(): { clips: FootageManifest[]; problems: Array<{ file: string; error: string }> } {
    const clips: FootageManifest[] = [];
    const problems: Array<{ file: string; error: string }> = [];
    if (!existsSync(this.root)) return { clips, problems };
    for (const name of readdirSync(this.root).filter((n) => n.endsWith('.json')).sort()) {
      try {
        clips.push(parseManifest(JSON.parse(readFileSync(path.join(this.root, name), 'utf8'))));
      } catch (error) {
        problems.push({ file: name, error: error instanceof Error ? error.message : String(error) });
      }
    }
    return { clips, problems };
  }

  list(): FootageManifest[] { return this.scan().clips; }
  problems(): Array<{ file: string; error: string }> { return this.scan().problems; }

  /** The manifest and absolute path of a clip, after checking the file bytes against the manifest sha256. */
  get(id: string, checkBudget?: () => void): { manifest: FootageManifest; path: string } {
    const manifest = this.list().find((m) => m.id === id);
    if (!manifest) throw new FootageError(`footage clip "${id}" is not in the library at ${this.root}`);
    const file = path.join(this.root, manifest.file);
    if (!existsSync(file)) throw new FootageError(`footage clip "${id}": file ${manifest.file} is missing`);
    if (sha256File(file, checkBudget) !== manifest.sha256) throw new FootageError(`footage clip "${id}": sha256 does not match its manifest (file changed or corrupt)`);
    return { manifest, path: file };
  }

  private add(src: string, build: (id: string, file: string, sha: string, bytes: number) => FootageManifest): FootageManifest {
    if (!existsSync(src) || !statSync(src).isFile()) throw new FootageError(`footage file not found: ${src}`);
    mkdirSync(this.root, { recursive: true });
    const ext = path.extname(src).toLowerCase();
    let id = slug(path.basename(src));
    for (let n = 2; existsSync(path.join(this.root, `${id}.json`)); n += 1) id = `${slug(path.basename(src))}-${n}`;
    const file = `${id}${ext}`;
    copyFileSync(src, path.join(this.root, file));
    const manifest = parseManifest(build(id, file, sha256File(path.join(this.root, file)), statSync(src).size));
    writeFileSync(path.join(this.root, `${id}.json`), `${JSON.stringify(manifest, null, 2)}\n`);
    return manifest;
  }

  /** (c) User-supplied footage. The user must say how to credit it. */
  addUserClip(src: string, info: { author: string; creditLine: string; title?: string }): FootageManifest {
    if (!info.creditLine?.trim()) throw new FootageError('user footage needs a credit line');
    return this.add(src, (id, file, sha256, bytes) => ({
      id, file, kind: 'user', source: 'user', sourceUrl: `file:${path.basename(src)}`, title: info.title ?? path.basename(src),
      author: info.author || 'user', licence: 'USER-SUPPLIED', creditLine: info.creditLine, sha256, bytes,
      retrievedAt: new Date().toISOString().slice(0, 10),
    }));
  }

  /** (a) S1NTR's own render or recorded wall piece. */
  addOwnClip(src: string, info: { pieceId: string; title?: string; creditLine?: string }): FootageManifest {
    return this.add(src, (id, file, sha256, bytes) => ({
      id, file, kind: 'own', source: 's1ntr', sourceUrl: `s1ntr:piece/${info.pieceId}`, title: info.title ?? info.pieceId,
      author: 'S1NTR', licence: 'S1NTR-OWN', creditLine: info.creditLine ?? `${info.title ?? info.pieceId}, made with S1NTR`,
      sha256, bytes, retrievedAt: new Date().toISOString().slice(0, 10),
    }));
  }

  /** One line per clip for a generator prompt: id, title, duration. */
  promptContext(): string {
    return this.list().map((m) => `${m.id}: ${m.title.slice(0, 60)}${m.durationSec ? `, ${m.durationSec} s` : ''}`).join('\n');
  }
}
