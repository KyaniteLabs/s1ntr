/** Legacy Studio remix is retired; Dream is available only through the governed product path. */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import path from 'path';
import os from 'os';
import fs from 'fs/promises';
import http from 'http';

const { loadHistoryFromDir, generateMock, wrapMock } = vi.hoisted(() => ({
  loadHistoryFromDir: vi.fn(),
  generateMock: vi.fn(),
  wrapMock: vi.fn((code) => `<html><body>${code}</body></html>`),
}));

vi.mock('../../dist/gallery/Gallery.js', () => ({
  Gallery: class { loadHistoryFromDir = loadHistoryFromDir; },
}));
vi.mock('../../dist/core/GenerationOrchestrator.js', () => ({
  GenerationOrchestrator: class { generate = generateMock; },
}));
vi.mock('../../dist/utils/htmlWrapper.js', () => ({
  HTMLWrapper: { wrap: wrapMock },
}));
vi.mock('../../dist/tui-bridge/CreativeDomainRouting.js', () => ({
  detectPreviewDomainForCode: () => 'p5',
}));
vi.mock('../../dist/tui-bridge/BridgeLauncherConfig.js', () => ({
  resolveBridgeProviderConfig: () => ({ provider: 'test', model: 'test-model' }),
  applyBridgeProviderEnv: () => {},
  summarizeBridgeRuntime: () => ({}),
}));

const TEST_DIR = path.join(os.tmpdir(), `sinter-dream-api-${Date.now()}`);
const TEST_CONFIG_PATH = path.join(TEST_DIR, 'config.json');

describe('GUI dream API', () => {
  let server;
  let port;

  beforeAll(async () => {
    await fs.mkdir(TEST_DIR, { recursive: true });
    process.env.LIMINAL_CONFIG_PATH = TEST_CONFIG_PATH;
    const { createApp } = await import('../../gui/server.js');
    const app = createApp(TEST_CONFIG_PATH);
    server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, () => resolve()));
    port = server.address().port;
    expect(port).toBeGreaterThan(0);
  }, 30000);

  afterAll(async () => {
    if (server) await new Promise((resolve) => server.close(resolve));
    delete process.env.LIMINAL_CONFIG_PATH;
    await fs.rm(TEST_DIR, { recursive: true, force: true }).catch(() => {});
  });

  async function postDream(body) {
    const res = await fetch(`http://127.0.0.1:${port}/api/dream`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  }

  describe('retired legacy remix', () => {
    it('returns a governed migration endpoint without loading or generating', async () => {
      const { status, body } = await postDream({ sources: ['legacy-a', 'legacy-b'] });
      expect(status).toBe(410);
      expect(body).toEqual({ error: 'legacy dream remix retired',
        governedEndpoint: '/api/liminal/dream' });
      expect(loadHistoryFromDir).not.toHaveBeenCalled();
      expect(generateMock).not.toHaveBeenCalled();
    });
  });
});
