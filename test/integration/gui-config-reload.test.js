/** F08: a rejected runtime init is not cached, and a saved GUI config reaches the next Create. */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import http from 'http';

const boot = vi.hoisted(() => ({ calls: 0, failFirst: true }));
vi.mock('../../dist/runtime-core/ProductionLiminalRuntime.js', () => ({
  bootstrapProductionLiminalRuntime: async () => {
    boot.calls += 1;
    if (boot.failFirst && boot.calls === 1) throw new Error('INIT_REJECTED_BAD_CONFIG');
    return {
      createCommand: () => ({ idempotencyKey: `k${boot.calls}` }),
      port: {
        submitCreate: async () => ({ result: { evaluation: { score: 0.9 } } }),
        verifiedArtifact: async () => ({ source: `// runtime #${boot.calls}` }),
      },
    };
  },
  bootstrapProductionDreamRuntime: async () => ({}),
}));

const TEST_DIR = path.join(os.tmpdir(), `sinter-gui-reload-${Date.now()}`);
const TEST_CONFIG_PATH = path.join(TEST_DIR, 'config.json');

describe('GUI config reload (F08)', () => {
  let server; let port;
  beforeAll(async () => {
    await fs.mkdir(TEST_DIR, { recursive: true });
    process.env.LIMINAL_CONFIG_PATH = TEST_CONFIG_PATH;
    const { createApp } = await import('../../gui/server.js');
    server = http.createServer(createApp(TEST_CONFIG_PATH));
    await new Promise((r) => server.listen(0, () => r()));
    port = server.address().port;
  }, 30000);
  afterAll(async () => {
    if (server) await new Promise((r) => server.close(r));
    delete process.env.LIMINAL_CONFIG_PATH;
    await fs.rm(TEST_DIR, { recursive: true, force: true }).catch(() => {});
  });
  const post = (p, data) => fetch(`http://127.0.0.1:${port}${p}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data),
  });

  it('retries a rejected init and re-reads config after a save', async () => {
    // Startup (bridge proposal) may consume the one failing init; force it if not.
    if (boot.calls === 0) {
      const first = await post('/api/run', { prompt: 'a' });
      expect(first.status).toBeGreaterThanOrEqual(400);
    }
    expect(boot.calls).toBeGreaterThanOrEqual(1);
    const callsAfterFail = boot.calls;

    // The rejected init is not cached forever: the next Create boots again.
    const second = await post('/api/run', { prompt: 'a' });
    expect(second.status).toBe(200);
    expect(boot.calls).toBe(callsAfterFail + 1);
    const before = boot.calls;

    // Same runtime is reused until the config changes.
    await post('/api/run', { prompt: 'a' });
    expect(boot.calls).toBe(before);

    // Saving config drops the runtime, so the next Create boots from the saved file.
    const save = await post('/api/config', { defaultProvider: 'ollama', providers: { ollama: { baseUrl: 'http://127.0.0.1:1/v1', model: 'm' } } });
    expect(save.status).toBe(200);
    const third = await post('/api/run', { prompt: 'a' });
    expect(third.status).toBe(200);
    expect(boot.calls).toBe(before + 1);
    expect((await third.json()).result.code).toBe(`// runtime #${boot.calls}`);
  });
});
