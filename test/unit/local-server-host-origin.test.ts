import http from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { PreviewServer } from '../../src/render/PreviewServer.js';
import { TuiBridgeServer } from '../../src/tui-bridge/TuiBridgeServer.js';

// `sinter serve` (PreviewServer) and the TUI bridge listen on loopback. A page
// on another site can still reach them: DNS rebinding sends a foreign Host,
// and a simple cross-site POST needs no preflight. Both must refuse those, and
// the generated-code page must run sandboxed so it cannot call the API origin.

interface Reply { status: number; headers: http.IncomingHttpHeaders; body: string }

function send(port: number, opts: { method?: string; path?: string; headers?: Record<string, string> }): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, method: opts.method ?? 'GET', path: opts.path ?? '/', headers: opts.headers },
      (res) => {
        let body = '';
        res.on('data', (c) => { body += c; });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
      },
    );
    req.on('error', reject);
    req.end();
  });
}

const stops: Array<() => Promise<unknown>> = [];
afterEach(async () => { while (stops.length) await stops.pop()!(); });

async function startPreview(): Promise<number> {
  const server = new PreviewServer();
  await server.start(0);
  stops.push(() => server.stop());
  return server.getPort()!;
}

async function startBridge(): Promise<number> {
  const server = new TuiBridgeServer({ destroy: () => undefined } as never, { port: 0, host: '127.0.0.1' });
  await server.start();
  stops.push(() => server.stop());
  return Number(new URL(server.address).port);
}

describe.each([
  ['preview server', startPreview],
  ['TUI bridge', startBridge],
])('%s host and origin guard', (_name, start) => {
  it('refuses a foreign Host header (DNS rebinding)', async () => {
    const port = await start();
    const reply = await send(port, { path: '/api/status', headers: { Host: `evil.example:${port}` } });
    expect(reply.status).toBe(403);
    expect(reply.body).toContain('Forbidden host');
  });

  it('accepts loopback Host names', async () => {
    const port = await start();
    for (const host of [`localhost:${port}`, `127.0.0.1:${port}`, `[::1]:${port}`]) {
      const reply = await send(port, { path: '/api/status', headers: { Host: host } });
      expect(reply.status, host).not.toBe(403);
    }
  });

  it('refuses cross-site writes', async () => {
    const port = await start();
    for (const headers of [
      { Origin: 'https://evil.example' },
      { Origin: 'null' },
      { 'Sec-Fetch-Site': 'cross-site' },
    ]) {
      const reply = await send(port, { method: 'POST', path: '/api/tui/session', headers });
      expect(reply.status, JSON.stringify(headers)).toBe(403);
      expect(reply.body).toContain('Forbidden origin');
    }
  });
});

describe.each([
  ['preview server', startPreview],
  ['TUI bridge', startBridge],
])('%s preview page sandbox', (_name, start) => {
  it.each(['/', '/preview'])('serves %s generated code under a sandboxed CSP', async (path) => {
    const port = await start();
    const reply = await send(port, { path });
    expect(reply.status).toBe(200);
    const csp = String(reply.headers['content-security-policy']);
    expect(csp).toMatch(/(^|;\s*)sandbox allow-scripts(;|$)/);
    expect(csp).not.toMatch(/allow-same-origin/);
  });
});
