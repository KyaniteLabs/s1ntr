import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// `sinter "<prompt>"` saves each artwork as ~/.sinter/output/artifacts/<id>/
// (source.txt, playable.html, provenance.txt). `sinter list` must show them.

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
let home: string;

beforeEach(() => { home = mkdtempSync(path.join(tmpdir(), 'sinter-list-home-')); });
afterEach(() => { rmSync(home, { recursive: true, force: true }); });

function saveArtwork(id: string, domain: string, mtime: Date): string {
  const dir = path.join(home, '.sinter', 'output', 'artifacts', id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'source.txt'), '// art');
  writeFileSync(path.join(dir, 'playable.html'), '<html></html>');
  writeFileSync(path.join(dir, 'provenance.txt'), JSON.stringify({ schema: 'sinter.liminal-generation-provenance', domain }));
  for (const f of ['source.txt', 'playable.html', 'provenance.txt']) utimesSync(path.join(dir, f), mtime, mtime);
  utimesSync(dir, mtime, mtime);
  return path.join(dir, 'playable.html');
}

function list(): { status: number | null; out: string } {
  const r = spawnSync(process.execPath, [path.join(repoRoot, 'bin/sinter'), 'list'], {
    cwd: home, env: { ...process.env, HOME: home }, encoding: 'utf8', timeout: 30_000,
  });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
}

describe('sinter list', () => {
  it('shows saved artworks newest first, with domain and playable path', () => {
    const older = saveArtwork('a'.repeat(64), 'p5', new Date('2026-11-01T10:00:00Z'));
    const newer = saveArtwork('b'.repeat(64), 'strudel', new Date('2026-11-02T10:00:00Z'));
    // A folder with no playable page is not an artwork.
    mkdirSync(path.join(home, '.sinter', 'output', 'artifacts', 'c'.repeat(64)), { recursive: true });

    const { status, out } = list();
    expect(status, out).toBe(0);
    expect(out).toContain(newer);
    expect(out).toContain(older);
    expect(out.indexOf(newer)).toBeLessThan(out.indexOf(older));
    expect(out).toMatch(/strudel/);
    expect(out).toMatch(/p5/);
    expect(out).not.toContain('c'.repeat(12));
    expect(out).not.toContain('(none yet)');
  });

  it('says there is nothing yet on a fresh machine', () => {
    const { status, out } = list();
    expect(status, out).toBe(0);
    expect(out).toContain('(none yet)');
  });
});
