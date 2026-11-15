/**
 * Studio cross-site writes: with no token set (the default `sinter studio`),
 * a page on another site can still send a simple POST to 127.0.0.1 — no body,
 * so no CORS preflight. The browser labels such a request with a foreign
 * Origin (or "null" from a sandboxed frame) and Sec-Fetch-Site: cross-site.
 * Studio must refuse those writes, and keep serving its own page, Electron
 * and non-browser clients.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import http from 'http';

const realFetch = globalThis.__liminalNativeFetch || globalThis.fetch.bind(globalThis);
// An unknown write route: it does nothing, so a pass shows up as a plain 404.
const PROBE = '/api/__cross-site-probe';

function startServer(app) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(app);
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
    server.on('error', reject);
  });
}

describe('Studio refuses cross-site writes when no token is set', () => {
  let server, port, dir, savedToken, savedLegacyToken;
  const url = (p) => `http://127.0.0.1:${port}${p}`;
  const post = async (headers) => {
    const res = await realFetch(url(PROBE), { method: 'POST', headers });
    const body = await res.text();
    return { status: res.status, body };
  };

  beforeAll(async () => {
    savedToken = process.env.SINTER_GUI_TOKEN;
    savedLegacyToken = process.env.LIMINAL_GUI_TOKEN;
    delete process.env.SINTER_GUI_TOKEN;
    delete process.env.LIMINAL_GUI_TOKEN;
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cross-site-write-'));
    process.env.LIMINAL_CONFIG_PATH = path.join(dir, 'config.json');
    const { createApp } = await import('../../gui/server.js');
    ({ server, port } = await startServer(createApp(path.join(dir, 'config.json'))));
  }, 60000);

  afterAll(async () => {
    if (server) await new Promise((r) => server.close(r));
    delete process.env.LIMINAL_CONFIG_PATH;
    if (savedToken !== undefined) process.env.SINTER_GUI_TOKEN = savedToken;
    if (savedLegacyToken !== undefined) process.env.LIMINAL_GUI_TOKEN = savedLegacyToken;
    await fs.rm(dir, { recursive: true, force: true });
  }, 60000);

  it('refuses a write from another site', async () => {
    const res = await post({ Origin: 'https://attacker.example', 'Sec-Fetch-Site': 'cross-site' });
    expect(res).toEqual({ status: 403, body: JSON.stringify({ error: 'Forbidden origin' }) });
  });

  it('refuses a write from a sandboxed frame (Origin: null)', async () => {
    const res = await post({ Origin: 'null' });
    expect(res.status).toBe(403);
  });

  it('refuses a write the browser marks cross-site even without an Origin', async () => {
    const res = await post({ 'Sec-Fetch-Site': 'cross-site' });
    expect(res.status).toBe(403);
  });

  it('refuses a write whose Origin names a foreign host', async () => {
    const res = await post({ Origin: 'http://evil.localhost.example:5174' });
    expect(res.status).toBe(403);
  });

  it('lets the Studio page and Electron write (loopback Origin)', async () => {
    for (const origin of ['http://localhost:5173', `http://127.0.0.1:${port}`, 'http://[::1]:5174']) {
      const res = await post({ Origin: origin, 'Sec-Fetch-Site': 'same-origin' });
      expect([origin, res.status]).toEqual([origin, 404]);
    }
  });

  it('lets non-browser clients write (no Origin, no Sec-Fetch-Site)', async () => {
    const res = await post({});
    expect(res.status).toBe(404);
  });

  it('leaves reads alone (CORS already keeps their answers from other sites)', async () => {
    const res = await realFetch(url('/api/config'), { headers: { Origin: 'https://attacker.example' } });
    await res.body?.cancel();
    expect(res.status).toBe(200);
  });

  it('refuses an Origin that is not a URL', async () => {
    const res = await post({ Origin: 'not a url' });
    expect(res.status).toBe(403);
  });
});
