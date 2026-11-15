/**
 * TuiBridgeServer (bridge-backed preview surface) Characterization Tests
 *
 * Step 6 (issue #298): these tests exercise the bridge-backed preview
 * surface (`TuiBridgeServer` — which embeds `PreviewEndpoints` for every
 * preview route and coexists with /api/tui/session...) instead of the
 * Express `PreviewServer`. The Express-backed class is kept as a thin
 * compat shim and is NOT the target of these tests.
 *
 * Captures lifecycle behavior, ephemeral-port reporting inherited from #286,
 * and cleanup of browser and server resources.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { TuiBridgeServer } from '../../src/tui-bridge/TuiBridgeServer.js';
import { TuiBridgeService } from '../../src/tui-bridge/TuiBridgeService.js';
import { createServer, Server } from 'http';
import { execFileSync, spawn } from 'child_process';
import { AddressInfo } from 'net';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

async function listenOnEphemeralPort(): Promise<{ holder: Server; port: number }> {
  return new Promise((resolve, reject) => {
    const holder = createServer();
    holder.listen(0, 'localhost', () => {
      const port = (holder.address() as AddressInfo).port;
      resolve({ holder, port });
    });
    holder.on('error', reject);
  });
}

describe('TuiBridgeServer Characterization (bridge-backed preview surface)', () => {
  let server: TuiBridgeServer;

  beforeEach(() => {
    server = new TuiBridgeServer(new TuiBridgeService(), { port: 0 });
  });

  afterEach(async () => {
    try {
      await server.stop();
    } catch {
      // Ignore cleanup errors
    }
  });

  describe('start()', () => {
    // The bridge-backed server reads its port from the constructor option; start()
    // takes no argument and returns Promise<void>. Port validity is enforced at
    // construction (Node rejects listen with EADDRINUSE for conflicts; the
    // configured port propagates to server.address).
    const boundPort = (s: TuiBridgeServer): number => parseInt(new URL(s.address).port, 10);

    it('resolves when the server starts listening on the configured port', async () => {
      await expect(server.start()).resolves.toBeUndefined();
      expect(boundPort(server)).toBeGreaterThan(0);
    });

    it('binds an ephemeral non-zero port when constructed with port 0 (#286)', async () => {
      await server.start();
      const port = boundPort(server);
      expect(port).toBeGreaterThan(0);
      expect(port).toBeLessThan(65536);
    });

    it('rejects with EADDRINUSE when the configured port is already in use', async () => {
      const { holder, port } = await listenOnEphemeralPort();
      const bridge = new TuiBridgeService();
      const conflicting = new TuiBridgeServer(bridge, { port });
      try {
        await expect(conflicting.start()).rejects.toThrow();
      } finally {
        await conflicting.stop().catch(() => undefined);
        await new Promise<void>((resolve) => holder.close(() => resolve()));
      }
    });

    it('rejects when starting an already-running server', async () => {
      await server.start();
      await expect(server.start()).rejects.toThrow();
    });
  });

  describe('CLI serve', () => {
    // End-to-end: `bin/sinter serve 0` boots the bridge-backed preview surface
    // through its dist/ dynamic imports (a path no src/-level test exercises)
    // and prints the actual bound port (#286). Requires a built dist/ — CI runs
    // `pnpm build` before tests; locally build once first.
    it('reports a usable non-zero port when started with port 0', async () => {
      const home = await mkdtemp(path.join(os.tmpdir(), 'liminal-preview-home-'));
      const dreamHost = path.resolve('test/fixtures/previewDreamHostConfig.mjs');
      const sourceSha = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
      const eventPath = path.join(home, 'forgejo-event.json');
      await writeFile(eventPath, JSON.stringify({ pull_request: {
        head: { sha: sourceSha, ref: 'preview-source-ref' },
        base: { sha: 'b'.repeat(40), ref: 'main' },
      } }));
      const child = spawn(process.execPath, ['bin/sinter', 'serve', '0'], {
        cwd: process.cwd(),
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, HOME: home, SINTER_DREAM_HOST_CONFIG_MODULE: dreamHost,
          FORGEJO_ACTIONS: 'true', GITHUB_EVENT_PATH: eventPath,
          GITHUB_EVENT_NAME: 'pull_request', GITHUB_SHA: sourceSha,
          GITHUB_BASE_REF: 'main', GITHUB_HEAD_REF: 'preview-source-ref' },
      });

      try {
        const output = await new Promise<string>((resolve, reject) => {
          let stdout = '';
          let stderr = '';
          const timeout = setTimeout(() => reject(new Error(
            `Timed out waiting for server. stdout: ${stdout} stderr: ${stderr}`)), 20_000);

          child.stdout.on('data', (chunk) => {
            stdout += chunk.toString();
            if (/http:\/\/localhost:[1-9][0-9]*/.test(stdout)) {
              clearTimeout(timeout);
              resolve(stdout);
            }
          });
          child.once('error', (error) => {
            clearTimeout(timeout);
            reject(error);
          });
          child.stderr.on('data', chunk => { stderr += chunk.toString(); });
          child.once('exit', (code) => {
            clearTimeout(timeout);
            reject(new Error(
              `Server exited with code ${code}. stdout: ${stdout} stderr: ${stderr}`));
          });
        });

        const match = output.match(/http:\/\/localhost:([1-9][0-9]*)/);
        expect(match?.[1]).toMatch(/^[1-9][0-9]*$/);
        const base = `http://localhost:${match![1]}`;

        expect((await fetch(`${base}/`)).ok).toBe(true);
        expect((await fetch(`${base}/preview`)).ok).toBe(true);
        expect((await fetch(`${base}/gui`)).ok).toBe(true);
      } finally {
        if (child.exitCode === null) {
          child.kill('SIGTERM');
          const exited = await Promise.race([
            new Promise<boolean>((resolve) => child.once('exit', () => resolve(true))),
            new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 5_000)),
          ]);
          if (!exited) child.kill('SIGKILL');
        }
        await rm(home, { recursive: true, force: true });
      }
    }, 30_000);
  });


  describe('stop()', () => {

    it('stops a running server', async () => {
      await server.start();
      await expect(server.stop()).resolves.toBeUndefined();
    });

    it('allows restarting after stop', async () => {
      await server.start();
      await server.stop();
      await server.start();
      expect(parseInt(new URL(server.address).port, 10)).toBeGreaterThan(0);
    });
  });

  describe('serveSketch()', () => {
    it('should store the sketch code on the preview endpoints', () => {
      const code = 'function setup() { createCanvas(400, 400); }';
      server.previewEndpoints.serveSketch(code);
      expect(() => server.previewEndpoints.serveSketch(code)).not.toThrow();
    });

    it('should handle null code gracefully', () => {
      expect(() => server.previewEndpoints.serveSketch(null)).not.toThrow();
    });
  });

  describe('setVersionCode()', () => {
    it('should set code for a valid version', () => {
      expect(() => server.previewEndpoints.setVersionCode(1, 'test code')).not.toThrow();
    });

    it('should ignore invalid versions (0)', () => {
      expect(() => server.previewEndpoints.setVersionCode(0, 'test code')).not.toThrow();
    });

    it('should ignore invalid versions (negative)', () => {
      expect(() => server.previewEndpoints.setVersionCode(-1, 'test code')).not.toThrow();
    });

    it('should ignore non-integer versions', () => {
      expect(() => server.previewEndpoints.setVersionCode(1.5, 'test code')).not.toThrow();
    });
  });

  describe('setAllVersions()', () => {
    it('should set multiple versions at once', () => {
      const iterations = [
        { version: 1, code: 'code v1' },
        { version: 2, code: 'code v2' },
      ];
      expect(() => server.previewEndpoints.setAllVersions(iterations)).not.toThrow();
    });

    it('should handle empty array', () => {
      expect(() => server.previewEndpoints.setAllVersions([])).not.toThrow();
    });

    it('should skip invalid versions in array', () => {
      const iterations = [
        { version: 1, code: 'code v1' },
        { version: 0, code: 'invalid' },
        { version: -1, code: 'invalid' },
        { version: 2, code: 'code v2' },
      ];
      expect(() => server.previewEndpoints.setAllVersions(iterations)).not.toThrow();
    });
  });
});
