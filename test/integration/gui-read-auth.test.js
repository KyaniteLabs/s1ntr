/**
 * Studio read auth: with SINTER_GUI_TOKEN set, private reads, live streams and
 * render routes need the token (bearer) or the session cookie it buys.
 * The app shell stays public; writes stay bearer-only.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import http from 'http';

const realFetch = globalThis.__liminalNativeFetch || globalThis.fetch.bind(globalThis);
const TOKEN = 'read-auth-token-xyz789';

function startServer(app) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(app);
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
    server.on('error', reject);
  });
}

describe('Studio read auth with a token set', () => {
  let server, port, dir;
  const url = (p) => `http://127.0.0.1:${port}${p}`;

  beforeAll(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'read-auth-'));
    process.env.LIMINAL_CONFIG_PATH = path.join(dir, 'config.json');
    process.env.SINTER_GUI_TOKEN = TOKEN;
    const { createApp } = await import('../../gui/server.js');
    ({ server, port } = await startServer(createApp(path.join(dir, 'config.json'))));
  }, 60000);

  afterAll(async () => {
    if (server) await new Promise((r) => server.close(r));
    delete process.env.LIMINAL_CONFIG_PATH;
    delete process.env.SINTER_GUI_TOKEN;
    await fs.rm(dir, { recursive: true, force: true });
  }, 60000);

  it('refuses anonymous reads of config, gallery, progress and preview', async () => {
    for (const p of ['/api/config', '/api/gallery', '/progress', '/preview?version=1']) {
      const res = await realFetch(url(p));
      await res.body?.cancel();
      expect([p, res.status]).toEqual([p, 401]);
    }
  });

  it('refuses a token passed in the query string', async () => {
    const res = await realFetch(url(`/api/config?token=${TOKEN}`));
    await res.body?.cancel();
    expect(res.status).toBe(401);
  });

  it('serves reads to the bearer token', async () => {
    const res = await realFetch(url('/api/config'), { headers: { Authorization: `Bearer ${TOKEN}` } });
    await res.body?.cancel();
    expect(res.status).toBe(200);
  });

  it('issues an HttpOnly strict cookie that opens reads but not writes', async () => {
    const anon = await realFetch(url('/api/auth/session'), { method: 'POST' });
    await anon.body?.cancel();
    expect(anon.status).toBe(401);

    const issued = await realFetch(url('/api/auth/session'), {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    expect(await issued.json()).toEqual({ ok: true });
    const setCookie = issued.headers.get('set-cookie');
    expect(setCookie).toMatch(/^sinter_studio_session=[0-9a-f]{64}; HttpOnly; SameSite=Strict; Path=\/$/);
    expect(setCookie).not.toContain(TOKEN);
    const cookie = setCookie.split(';')[0];

    const read = await realFetch(url('/api/config'), { headers: { Cookie: cookie } });
    await read.body?.cancel();
    expect(read.status).toBe(200);

    const write = await realFetch(url('/api/config'), {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: '{}',
    });
    await write.body?.cancel();
    expect(write.status).toBe(401);
  });

  it('refuses a forged cookie', async () => {
    const res = await realFetch(url('/api/config'), {
      headers: { Cookie: `sinter_studio_session=${'0'.repeat(64)}` },
    });
    await res.body?.cancel();
    expect(res.status).toBe(401);
  });

  it('keeps the app shell public', async () => {
    const res = await realFetch(url('/'));
    await res.body?.cancel();
    expect(res.status).not.toBe(401);
  });
});
