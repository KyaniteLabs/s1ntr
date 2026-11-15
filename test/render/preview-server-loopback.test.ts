/**
 * The preview server serves local gallery files, so it must answer only on
 * loopback: a request to this machine's network address is refused.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { networkInterfaces, tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:http';
import { PreviewServer } from '../../src/render/PreviewServer.js';

function lanIPv4(): string | null {
  for (const list of Object.values(networkInterfaces())) {
    for (const a of list ?? []) if (a.family === 'IPv4' && !a.internal) return a.address;
  }
  return null;
}

function probe(host: string, port: number): Promise<string> {
  return new Promise((resolve) => {
    const req = request({ host, port, path: '/', timeout: 2000 }, (res) => { res.resume(); resolve(`status ${res.statusCode}`); });
    req.on('error', (e: NodeJS.ErrnoException) => resolve(e.code ?? 'error'));
    req.on('timeout', () => { req.destroy(); resolve('timeout'); });
    req.end();
  });
}

describe('PreviewServer network exposure', () => {
  const dir = mkdtempSync(join(tmpdir(), 'preview-loopback-'));
  let server: PreviewServer | null = null;
  afterEach(async () => { await server?.stop(); server = null; });

  it('answers on 127.0.0.1', async () => {
    server = new PreviewServer(dir);
    await server.start(0);
    expect(await probe('127.0.0.1', server.getPort()!)).toMatch(/^status \d{3}$/);
  });

  it.skipIf(lanIPv4() === null)('refuses a request to the machine network address', async () => {
    server = new PreviewServer(dir);
    await server.start(0);
    expect(await probe(lanIPv4()!, server.getPort()!)).toBe('ECONNREFUSED');
  });

  it('rejects a second start on the same instance', async () => {
    server = new PreviewServer(dir);
    await server.start(0);
    await expect(server.start(0)).rejects.toThrow('Server is already running');
  });

  afterEach(() => { if (!server) rmSync(dir, { recursive: true, force: true }); });
});
