/**
 * Every playable loads its libraries from root-absolute /vendor/... URLs.
 * `sinter serve` (TuiBridgeServer) and Studio (gui/server.js) must answer
 * those with the real vendored file, and refuse anything not registered.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { TuiBridgeServer } from '../../src/tui-bridge/TuiBridgeServer.js';
import { TuiBridgeService } from '../../src/tui-bridge/TuiBridgeService.js';
import { VENDOR_ASSETS, vendorRoot } from '../../src/utils/vendorAssets.js';

const realFetch: typeof fetch =
  (globalThis as { __liminalNativeFetch?: typeof fetch }).__liminalNativeFetch ?? globalThis.fetch.bind(globalThis);

const HYDRA = VENDOR_ASSETS.hydra;
const BLOCKED = ['/vendor/hydra-synth/1.3.10/missing.js', '/vendor/../package.json', '/vendor/%2e%2e/package.json'];

async function expectedHydra(): Promise<string> {
  return readFile(`${vendorRoot()}${HYDRA.slice('/vendor/'.length)}`, 'utf8');
}

describe('/vendor route on sinter serve', () => {
  let server: TuiBridgeServer;
  let base: string;

  beforeAll(async () => {
    server = new TuiBridgeServer(new TuiBridgeService(), { port: 0 });
    await server.start();
    base = server.address.replace(/\/$/, '');
  });

  afterAll(async () => {
    await server.stop();
  });

  it('serves a registered vendored file byte-for-byte as JavaScript', async () => {
    const res = await realFetch(`${base}${HYDRA}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/javascript; charset=utf-8');
    expect(await res.text()).toBe(await expectedHydra());
  });

  it.each(BLOCKED)('refuses %s with 404', async (p) => {
    const res = await realFetch(`${base}${p}`);
    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain('"name"');
  });
});

describe('/vendor route on Studio', () => {
  let server: http.Server;
  let base: string;
  let dir: string;

  beforeAll(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'vendor-route-'));
    process.env.LIMINAL_CONFIG_PATH = path.join(dir, 'config.json');
    // A token is set so the route must work for an unauthenticated <script src>.
    process.env.SINTER_GUI_TOKEN = 'vendor-route-token';
    // @ts-expect-error -- plain JS module
    const { createApp } = await import('../../gui/server.js');
    server = http.createServer(createApp(path.join(dir, 'config.json')));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  }, 60000);

  afterAll(async () => {
    await new Promise((r) => server.close(r));
    delete process.env.LIMINAL_CONFIG_PATH;
    delete process.env.SINTER_GUI_TOKEN;
    await rm(dir, { recursive: true, force: true });
  }, 60000);

  it('serves a registered vendored file without a token', async () => {
    const res = await realFetch(`${base}${HYDRA}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/javascript; charset=utf-8');
    expect(await res.text()).toBe(await expectedHydra());
  });

  it.each(BLOCKED)('refuses %s with 404', async (p) => {
    const res = await realFetch(`${base}${p}`);
    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain('"name"');
  });
});
