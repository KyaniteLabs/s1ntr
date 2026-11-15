/**
 * FABLE-6.3 / ASTRA CODEX-6.2: a stage render opened directly (top-level
 * navigation, no enclosing sandboxed iframe) must still run in an opaque
 * origin. The response header carries the sandbox; meta CSP cannot.
 * Real modules together: gui/server.js routes + Gallery reader + HTMLWrapper.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import http from 'http';

const realFetch = globalThis.__liminalNativeFetch || globalThis.fetch.bind(globalThis);

describe('Stage render responses are sandboxed on direct navigation', () => {
  let server;
  let port;
  let dir;

  beforeAll(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'stage-sandbox-'));
    const galleryPath = path.join(dir, 'gallery');
    const project = path.join(galleryPath, '2026-11-11--rings');
    await fs.mkdir(project, { recursive: true });
    await fs.writeFile(path.join(project, 'v1.js'), 'function setup(){createCanvas(64,64);background(10);}', 'utf-8');
    const configPath = path.join(dir, 'config.json');
    await fs.writeFile(configPath, JSON.stringify({ galleryPath }), 'utf-8');
    process.env.LIMINAL_CONFIG_PATH = configPath;
    delete process.env.SINTER_GUI_TOKEN;
    delete process.env.LIMINAL_GUI_TOKEN;
    const { createApp } = await import('../../gui/server.js');
    server = http.createServer(createApp(configPath));
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = server.address().port;
  }, 120000);

  afterAll(async () => {
    if (server) await new Promise((r) => server.close(r));
    delete process.env.LIMINAL_CONFIG_PATH;
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('gallery render sends a sandbox CSP that keeps scripts but drops same-origin', async () => {
    const res = await realFetch(`http://127.0.0.1:${port}/api/gallery/${encodeURIComponent('2026-11-11--rings')}/render`);
    const html = await res.text();
    const csp = res.headers.get('Content-Security-Policy') || '';
    expect(res.status).toBe(200);
    expect(html).toContain('createCanvas(64,64)');
    const directives = csp.split(';').map((d) => d.trim());
    expect(directives).toContain("frame-ancestors 'self'");
    expect(directives).toContain('sandbox allow-scripts');
    expect(csp).not.toContain('allow-same-origin');
  });

  it('a missing project still fails closed with 404 and no HTML', async () => {
    const res = await realFetch(`http://127.0.0.1:${port}/api/gallery/${encodeURIComponent('no-such-project')}/render`);
    const body = await res.json();
    expect(res.status).toBe(404);
    expect(body.error).toBe('No renderable iteration');
  });
});
