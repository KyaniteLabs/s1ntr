/** Sol F19: preview versions are scoped per session and the store is bounded. */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import http from 'http';
import { PreviewStore } from '../../gui/previewStore.js';

const realFetch = globalThis.__liminalNativeFetch || globalThis.fetch.bind(globalThis);

describe('PreviewStore bounds', () => {
  it('evicts oldest-first past the entry cap, deterministically', () => {
    const store = new PreviewStore({ maxEntries: 3, maxBytes: 1e6 });
    for (let v = 1; v <= 5; v += 1) store.set('', v, `code-${v}`);
    expect(store.size).toBe(3);
    expect(store.get('', 1)).toBeUndefined();
    expect(store.get('', 2)).toBeUndefined();
    expect(store.get('', 5)).toBe('code-5');
  });
  it('evicts to stay under the byte cap and refuses a single oversize entry', () => {
    const store = new PreviewStore({ maxEntries: 100, maxBytes: 20 });
    store.set('', 1, 'aaaaaaaaaa'); store.set('', 2, 'bbbbbbbbbb'); store.set('', 3, 'cccccccccc');
    expect(store.size).toBe(2);
    expect(store.get('', 1)).toBeUndefined();
    expect(store.set('', 9, 'x'.repeat(21))).toBe(false);
    expect(store.bytes).toBeLessThanOrEqual(20);
  });
});

describe('GUI /preview scoping', () => {
  let server, port, dir;
  const url = (p) => `http://127.0.0.1:${port}${p}`;
  beforeAll(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'preview-scope-'));
    process.env.LIMINAL_CONFIG_PATH = path.join(dir, 'config.json');
    const { createApp } = await import('../../gui/server.js');
    // createApp bakes its own port into the preview URL, so find a free port first.
    port = await new Promise((resolve) => { const probe = http.createServer(); probe.listen(0, '127.0.0.1', () => { const p = probe.address().port; probe.close(() => resolve(p)); }); });
    await new Promise((resolve, reject) => {
      server = http.createServer(createApp(path.join(dir, 'config.json'), port));
      server.listen(port, '127.0.0.1', resolve);
      server.on('error', reject);
    });
  }, 60000);
  afterAll(async () => {
    if (server) await new Promise((r) => server.close(r));
    delete process.env.LIMINAL_CONFIG_PATH;
    await fs.rm(dir, { recursive: true, force: true });
  }, 60000);

  const post = (session, code) => realFetch(url('/api/preview/run'), { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ version: 1, code, session }) }).then((r) => r.json());

  it('two sessions both submitting version 1 keep independent bodies', async () => {
    const a = await post('sess-a', 'function setup(){} /* A-BODY */');
    const b = await post('sess-b', 'function setup(){} /* B-BODY */');
    expect(a.url).not.toBe(b.url);
    const pa = await (await realFetch(a.url)).text();
    const pb = await (await realFetch(b.url)).text();
    expect(pa).toContain('A-BODY');
    expect(pa).not.toContain('B-BODY');
    expect(pb).toContain('B-BODY');
  });
});
