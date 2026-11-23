import { afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FootageLibrary, FootageError, checkLicence, creditLines, parseManifest } from '../../../src/footage/FootageLibrary.js';

const dirs: string[] = [];
function tmp(): string { const d = mkdtempSync(path.join(os.tmpdir(), 'footage-')); dirs.push(d); return d; }
afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }); });

const base = {
  id: 'waves', file: 'waves.webm', kind: 'outside', source: 'wikimedia-commons', sourceUrl: 'https://commons.wikimedia.org/wiki/File:Waves.webm',
  downloadUrl: 'https://upload.wikimedia.org/x.webm', title: 'Waves', author: 'A. Author', licence: 'CC-BY-4.0',
  licenceUrl: 'https://creativecommons.org/licenses/by/4.0/', creditLine: 'Waves by A. Author, CC BY 4.0, via Wikimedia Commons',
  sha256: '', bytes: 4, retrievedAt: '2026-11-19',
};
function put(root: string, over: Record<string, unknown> = {}, content = 'data'): void {
  const m = { ...base, sha256: createHash('sha256').update(content).digest('hex'), bytes: content.length, ...over };
  writeFileSync(path.join(root, String(m.file)), content);
  writeFileSync(path.join(root, `${String(m.id)}.json`), JSON.stringify(m));
}

describe('licence whitelist', () => {
  it.each(['CC0-1.0', 'PD', 'CC-BY-3.0', 'CC-BY-4.0', 'CC-BY-SA-3.0', 'CC-BY-SA-4.0', 'S1NTR-OWN', 'USER-SUPPLIED'])('accepts %s', (id) => {
    expect(checkLicence(id)).toEqual({ ok: true });
  });
  it.each(['CC-BY-ND-4.0', 'CC-BY-NC-4.0', 'CC-BY-NC-SA-4.0', 'CC-BY-NC-ND-4.0', 'all-rights-reserved', ''])('rejects %s', (id) => {
    expect(checkLicence(id).ok).toBe(false);
  });
  it('explains an ND rejection as a derivative-work problem and NC as commercial', () => {
    expect(checkLicence('CC-BY-ND-4.0')).toMatchObject({ ok: false, reason: expect.stringContaining('derivative') });
    expect(checkLicence('CC-BY-NC-4.0')).toMatchObject({ ok: false, reason: expect.stringContaining('commercial') });
  });
});

describe('manifest parsing', () => {
  it('rejects a manifest missing any provenance field', () => {
    for (const key of ['source', 'sourceUrl', 'author', 'licence', 'creditLine', 'sha256']) {
      const bad: Record<string, unknown> = { ...base, sha256: 'a'.repeat(64) };
      delete bad[key];
      expect(() => parseManifest(bad)).toThrow(FootageError);
    }
  });
  it('rejects a non-whitelisted licence and a malformed sha256', () => {
    expect(() => parseManifest({ ...base, sha256: 'a'.repeat(64), licence: 'CC-BY-NC-4.0' })).toThrow(/commercial/);
    expect(() => parseManifest({ ...base, sha256: 'xyz' })).toThrow(/sha256/);
  });
  it('rejects ids and files that could escape the library root', () => {
    expect(() => parseManifest({ ...base, sha256: 'a'.repeat(64), file: '../x.webm' })).toThrow(FootageError);
    expect(() => parseManifest({ ...base, sha256: 'a'.repeat(64), id: 'a/b' })).toThrow(FootageError);
  });
});

describe('FootageLibrary', () => {
  it('lists valid clips and reports bad manifests instead of hiding them', () => {
    const root = tmp();
    put(root);
    writeFileSync(path.join(root, 'broken.json'), '{"id":"broken"}');
    const lib = new FootageLibrary(root);
    expect(lib.list().map((m) => m.id)).toEqual(['waves']);
    expect(lib.problems().map((p) => p.file)).toEqual(['broken.json']);
  });

  it('get() verifies the sha256 of the file and refuses a tampered clip', () => {
    const root = tmp();
    put(root);
    const lib = new FootageLibrary(root);
    expect(lib.get('waves').path).toBe(path.join(root, 'waves.webm'));
    writeFileSync(path.join(root, 'waves.webm'), 'tampered');
    expect(() => lib.get('waves')).toThrow(/sha256/);
  });

  it('get() fails for an unknown id', () => {
    expect(() => new FootageLibrary(tmp()).get('nope')).toThrow(/nope/);
  });

  it('addUserClip copies the file, records USER-SUPPLIED and demands a credit line', () => {
    const root = tmp(); const src = path.join(tmp(), 'mine.mp4'); writeFileSync(src, 'mine');
    const lib = new FootageLibrary(root);
    expect(() => lib.addUserClip(src, { author: 'Me', creditLine: '' })).toThrow(/credit/i);
    const m = lib.addUserClip(src, { author: 'Me', creditLine: 'Footage by Me' });
    expect(m).toMatchObject({ kind: 'user', licence: 'USER-SUPPLIED', creditLine: 'Footage by Me', bytes: 4 });
    expect(readFileSync(lib.get(m.id).path, 'utf8')).toBe('mine');
  });

  it('addOwnClip records S1NTR-OWN with the piece id in the credit line', () => {
    const root = tmp(); const src = path.join(tmp(), 'piece.mp4'); writeFileSync(src, 'piece');
    const m = new FootageLibrary(root).addOwnClip(src, { pieceId: 'draft10e3', title: 'Reel draft 10e3' });
    expect(m).toMatchObject({ kind: 'own', licence: 'S1NTR-OWN', source: 's1ntr' });
    expect(m.creditLine).toContain('S1NTR');
  });
});

describe('creditLines', () => {
  it('returns each credit once, in order, so cards and reels never repeat or drop a credit', () => {
    const a = parseManifest({ ...base, sha256: 'a'.repeat(64) });
    const b = parseManifest({ ...base, id: 'b', file: 'b.webm', sha256: 'b'.repeat(64), creditLine: 'B credit' });
    expect(creditLines([a, b, a])).toEqual([a.creditLine, 'B credit']);
  });
});
