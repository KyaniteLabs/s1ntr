/**
 * #1711: `sinter serve` listed only ./gallery, so a normal user's `generate` output under
 * ~/.sinter/output/artifacts/<sha>/playable.html never showed up in /api/gallery.
 */
import { createServer, type Server } from 'node:http';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PreviewEndpoints, resolveServeGalleryDirs } from '../../../src/tui-bridge/TuiBridgeServer.js';

const SHA = 'a'.repeat(64);
let home: string;
let server: Server | undefined;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'serve-gallery-'));
  const dir = join(home, '.sinter', 'output', 'artifacts', SHA);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'playable.html'), '<html></html>');
  writeFileSync(join(dir, 'provenance.txt'), JSON.stringify({ domain: 'p5' }));
  // A folder with no playable.html is not an artwork.
  mkdirSync(join(home, '.sinter', 'output', 'artifacts', 'b'.repeat(64)));
});

afterEach(async () => {
  await new Promise<void>((done) => (server ? server.close(() => done()) : done()));
  server = undefined;
  rmSync(home, { recursive: true, force: true });
});

async function getGallery(endpoints: PreviewEndpoints): Promise<{ projects: string[]; artifacts: Array<{ id: string; domain: string; playable: string }> }> {
  server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    void endpoints.handle(req, res, url.pathname, url);
  });
  await new Promise<void>((done) => server!.listen(0, '127.0.0.1', done));
  const res = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/gallery`);
  expect(res.status).toBe(200);
  return res.json() as never;
}

describe('sinter serve gallery (#1711)', () => {
  it('with no --gallery flag, lists generate output from ~/.sinter/output/artifacts', async () => {
    const dirs = resolveServeGalleryDirs(undefined, home);
    const endpoints = new PreviewEndpoints({ galleryDir: join(home, 'no-such-gallery') });
    endpoints.setGalleryDir(dirs.galleryDir);
    endpoints.setArtifactsDir(dirs.artifactsDir);
    const body = await getGallery(endpoints);
    expect(body.artifacts).toHaveLength(1);
    expect(body.artifacts[0]).toMatchObject({ id: SHA, domain: 'p5', playable: join(dirs.artifactsDir!, SHA, 'playable.html') });
  });

  it('--gallery <dir> overrides: that dir only, no home artifacts', async () => {
    const dirs = resolveServeGalleryDirs(join(home, 'custom'), home);
    expect(dirs).toEqual({ galleryDir: join(home, 'custom'), artifactsDir: null });
    const endpoints = new PreviewEndpoints();
    endpoints.setGalleryDir(dirs.galleryDir);
    endpoints.setArtifactsDir(dirs.artifactsDir);
    expect((await getGallery(endpoints)).artifacts).toEqual([]);
  });

  it('a missing artifacts dir is an empty list, not an error', async () => {
    const endpoints = new PreviewEndpoints({ artifactsDir: join(home, 'nope') });
    expect(await getGallery(endpoints)).toEqual({ projects: [], artifacts: [] });
  });

  // Sol F14: the page `/` serves must resolve from the same roots the gallery lists.
  async function getRoot(endpoints: PreviewEndpoints): Promise<string> {
    server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      void endpoints.handle(req, res, url.pathname, url);
    });
    await new Promise<void>((done) => server!.listen(0, '127.0.0.1', done));
    const res = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/`);
    expect(res.status).toBe(200);
    return res.text();
  }

  it('/ serves the newest saved artifact playable when no sketch was loaded', async () => {
    writeFileSync(join(home, '.sinter', 'output', 'artifacts', SHA, 'playable.html'), '<html><body>GOVERNED-ART</body></html>');
    const dirs = resolveServeGalleryDirs(undefined, home);
    const endpoints = new PreviewEndpoints();
    endpoints.setGalleryDir(dirs.galleryDir);
    endpoints.setArtifactsDir(dirs.artifactsDir);
    endpoints.serveSketch('', 0);
    expect(await getRoot(endpoints)).toContain('GOVERNED-ART');
  });

  it('a stale legacy sketch does not outrank a newer saved artifact, and --gallery ignores home artifacts', async () => {
    writeFileSync(join(home, '.sinter', 'output', 'artifacts', SHA, 'playable.html'), '<html><body>GOVERNED-ART</body></html>');
    const dirs = resolveServeGalleryDirs(undefined, home);
    const endpoints = new PreviewEndpoints();
    endpoints.setGalleryDir(dirs.galleryDir);
    endpoints.setArtifactsDir(dirs.artifactsDir);
    endpoints.serveSketch('function setup(){} /* STALE-LEGACY */', 1);
    const html = await getRoot(endpoints);
    expect(html).toContain('GOVERNED-ART');
    expect(html).not.toContain('STALE-LEGACY');
    await new Promise<void>((done) => server!.close(() => done())); server = undefined;
    const scoped = resolveServeGalleryDirs(join(home, 'custom'), home);
    const other = new PreviewEndpoints();
    other.setGalleryDir(scoped.galleryDir);
    other.setArtifactsDir(scoped.artifactsDir);
    other.serveSketch('', 0);
    expect(await getRoot(other)).not.toContain('GOVERNED-ART');
  });

  it('with nothing to show, / says so explicitly', async () => {
    const endpoints = new PreviewEndpoints({ artifactsDir: join(home, 'nope') });
    expect(await getRoot(endpoints)).toContain('Nothing to preview yet');
  });
});
