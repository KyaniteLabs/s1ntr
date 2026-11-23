/** Sol F07 e2e: `sinter provider status` names the pinned seat's real route (nondefault local port), not the catalog default. */
import { execFile } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

let server: Server; let port = 0; let dir = '';
beforeAll(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'sinter-status-'));
  server = createServer((_q, r) => r.end('{}'));
  await new Promise<void>((res) => server.listen(0, '127.0.0.1', res));
  port = (server.address() as { port: number }).port;
});
afterAll(() => { server.close(); rmSync(dir, { recursive: true, force: true }); });

const run = (env: NodeJS.ProcessEnv) => new Promise<string>((resolve) => {
  execFile(process.execPath, [path.resolve('bin/sinter'), 'provider', 'status'], { env, timeout: 60_000 },
    (_e, stdout, stderr) => resolve(stdout + stderr));
});

describe('provider status route (F07)', () => {
  it('reports the pinned generator seat on its own port and warns that the saved default does not move it', async () => {
    const cfg = path.join(dir, 'c.json');
    writeFileSync(cfg, JSON.stringify({ defaultProvider: 'ollama',
      roles: { generator: { provider: 'openai', model: 'qwen-local', baseUrl: `http://127.0.0.1:${port}/v1` } } }));
    const out = await run({ PATH: process.env.PATH, HOME: dir, SINTER_CONFIG_PATH: cfg });
    expect(out).toContain(`Generator seat: qwen-local at http://127.0.0.1:${port}/v1 (reachable)`);
    expect(out).toMatch(/saved default provider is ollama, but Generate uses the pinned generator seat/);
    expect(out).not.toMatch(/ollama\s+.*\(active\)/);
  });
  it('help no longer advertises a per-run --provider for generate', async () => {
    const out = await new Promise<string>((resolve) => execFile(process.execPath, [path.resolve('bin/sinter'), '--help'],
      { env: { PATH: process.env.PATH, HOME: dir }, timeout: 60_000 }, (_e, so, se) => resolve(so + se)));
    expect(out).not.toContain('sinter --provider glm "make a p5 sketch"');
    expect(out).not.toContain('--prompt "red circles" --provider lmstudio\n');
  });
});
