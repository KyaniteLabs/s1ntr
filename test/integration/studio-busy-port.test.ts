import { spawn } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

// When the Studio port is already taken, `sinter studio` / `pnpm gui` must say
// so and exit non-zero instead of printing the "backend ready" banner.

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const blockers: net.Server[] = [];
afterEach(async () => {
  await Promise.all(blockers.splice(0).map((s) => new Promise((r) => s.close(r))));
});

function occupyPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      blockers.push(server);
      resolve((server.address() as net.AddressInfo).port);
    });
  });
}

function runStudioBackend(port: number): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['gui/start.js'], {
      cwd: repoRoot,
      env: { ...process.env, PORT: String(port), SINTER_GUI_HOST: '127.0.0.1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (c) => { out += c; });
    child.stderr.on('data', (c) => { out += c; });
    const timer = setTimeout(() => { child.kill('SIGKILL'); resolve({ code: null, out }); }, 20_000);
    child.on('error', reject);
    child.on('exit', (code) => { clearTimeout(timer); resolve({ code, out }); });
  });
}

describe('Studio backend on a busy port', () => {
  it('exits non-zero with a clear message instead of claiming success', async () => {
    const port = await occupyPort();
    const { code, out } = await runStudioBackend(port);
    expect(code, out).toBe(1);
    expect(out).toContain(`Port ${port} is already in use`);
    expect(out).not.toContain('GUI backend: http://');
  }, 30_000);
});
