/**
 * Studio embed-origins posture (SINTER_EMBED_ORIGINS) — the security-relevant
 * half of the S1NTR Hermes Desktop plugin.
 *
 * Default posture is unchanged: X-Frame-Options SAMEORIGIN, no CSP on common
 * routes, SSE admits only localhost browsers. With valid embed origins the
 * common headers switch to CSP frame-ancestors ('self' + origins, XFO
 * dropped) and the SSE origin gate admits the listed origins. Malformed env
 * entries are ignored, never fatal.
 *
 * Uses the same real-server pattern as gui-config-api.test.js (random port,
 * plain fetch). Header assertions ride a 404 route so no config is needed:
 * the common-headers middleware runs for every request.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'http';
import os from 'os';
import path from 'path';
import fs from 'fs/promises';
import { createApp } from '../../gui/server.js';

const TEST_DIR = path.join(os.tmpdir(), `s1ntr-embed-origins-${Date.now()}`);

function startApp() {
  const app = createApp(path.join(TEST_DIR, 'config.json'), 0);
  const server = app.listen(0, '127.0.0.1');
  return new Promise((resolve, reject) => {
    server.once('listening', () => resolve(server));
    server.once('error', reject);
  });
}

function request(server, requestPath, { origin, method = 'GET' } = {}) {
  const { port } = server.address();
  const controller = new AbortController();
  const headers = {};
  if (origin) headers.origin = origin;
  return fetch(`http://127.0.0.1:${port}${requestPath}`, {
    method,
    headers,
    signal: controller.signal,
  }).then((res) => {
    controller.abort(); // SSE streams forever; headers are all we need
    return {
      status: res.status,
      xfo: res.headers.get('x-frame-options'),
      csp: res.headers.get('content-security-policy'),
    };
  });
}

async function withServer(fn) {
  const server = await startApp();
  try {
    await fn(server);
  } finally {
    server.close();
  }
}

describe('studio SINTER_EMBED_ORIGINS posture', () => {
  beforeAll(async () => {
    await fs.mkdir(TEST_DIR, { recursive: true });
    delete process.env.SINTER_EMBED_ORIGINS;
  });

  afterAll(async () => {
    delete process.env.SINTER_EMBED_ORIGINS;
    await fs.rm(TEST_DIR, { recursive: true, force: true });
  });

  it('default: X-Frame-Options SAMEORIGIN, no frame-ancestors CSP on common routes', async () => {
    await withServer(async (server) => {
      const res = await request(server, '/api/config');
      expect(res.status).toBe(200);
      expect(res.xfo).toBe('SAMEORIGIN');
      expect(res.csp).toBeNull();
    });
  });

  it('embed origins set: CSP frame-ancestors replaces X-Frame-Options', async () => {
    process.env.SINTER_EMBED_ORIGINS = 'http://127.0.0.1:9121,https://desktop.example';
    await withServer(async (server) => {
      const res = await request(server, '/api/config');
      expect(res.status).toBe(200);
      expect(res.xfo).toBeNull();
      expect(res.csp).toBe("frame-ancestors 'self' http://127.0.0.1:9121 https://desktop.example");
    });
  });

  it('malformed entries are ignored; valid ones still apply', async () => {
    process.env.SINTER_EMBED_ORIGINS = 'not-an-origin, ,http://127.0.0.1:9121,javascript:bad,http://x/pa/th';
    await withServer(async (server) => {
      const res = await request(server, '/api/config');
      expect(res.xfo).toBeNull();
      expect(res.csp).toBe("frame-ancestors 'self' http://127.0.0.1:9121");
    });
  });

  it('SSE gate admits embed origins and still denies others', async () => {
    process.env.SINTER_EMBED_ORIGINS = 'http://127.0.0.1:9121';
    await withServer(async (server) => {
      const allowed = await request(server, '/api/events', { origin: 'http://127.0.0.1:9121' });
      expect(allowed.status).not.toBe(403);
      const denied = await request(server, '/api/events', { origin: 'http://evil.example' });
      expect(denied.status).toBe(403);
    });
  });

  it('entries are normalized to the origin a browser sends', async () => {
    process.env.SINTER_EMBED_ORIGINS = 'https://Desktop.Example:443/, http://127.0.0.1:9121/,http://127.0.0.1:9121';
    await withServer(async (server) => {
      const res = await request(server, '/api/config');
      expect(res.csp).toBe("frame-ancestors 'self' https://desktop.example http://127.0.0.1:9121");
      const allowed = await request(server, '/api/events', { origin: 'https://desktop.example' });
      expect(allowed.status).not.toBe(403);
    });
  });

  it('SSE gate keeps its default posture when no embed origins are set', async () => {
    delete process.env.SINTER_EMBED_ORIGINS;
    await withServer(async (server) => {
      // localhost/127.0.0.1 hostnames were always admitted (the gate checks
      // hostname, not port); anything else — embed-port or not — is denied.
      const local = await request(server, '/api/events', { origin: 'http://localhost:5173' });
      expect(local.status).not.toBe(403);
      const denied = await request(server, '/api/events', { origin: 'http://evil.example' });
      expect(denied.status).toBe(403);
    });
  });
});
