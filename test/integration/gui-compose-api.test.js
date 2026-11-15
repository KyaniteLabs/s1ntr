/**
 * Integration tests for the Studio layer-composition API.
 * POST /api/compose validates a layer spec and submits one governed product
 * Create for the complete composition. The command bridge is mocked here so
 * the HTTP contract is exercised without an LLM, browser, or network call.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import path from 'path';
import os from 'os';
import fs from 'fs/promises';
import http from 'http';

const { composeMock, createMock, dreamMock, transferMock, activationMock,
  compoundMock } = vi.hoisted(() => ({
  composeMock: vi.fn(), createMock: vi.fn(), dreamMock: vi.fn(),
  transferMock: vi.fn(), activationMock: vi.fn(), compoundMock: vi.fn(),
}));

// Keep the legacy module inert; the Studio route must not call it.
vi.mock('../../dist/composition/CompositionOrchestrator.js', () => ({
  CompositionOrchestrator: { compose: composeMock },
}));
// Neutralise provider/env resolution so the endpoint is isolated from machine config.
vi.mock('../../dist/tui-bridge/BridgeLauncherConfig.js', () => ({
  resolveBridgeProviderConfig: () => ({ provider: 'test', model: 'test-model' }),
  applyBridgeProviderEnv: () => {},
  summarizeBridgeRuntime: () => ({}),
}));

const TEST_DIR = path.join(os.tmpdir(), `sinter-compose-api-${Date.now()}`);
const TEST_CONFIG_PATH = path.join(TEST_DIR, 'config.json');

describe('GUI compose API', () => {
  let server;
  let port;

  beforeAll(async () => {
    await fs.mkdir(TEST_DIR, { recursive: true });
    process.env.LIMINAL_CONFIG_PATH = TEST_CONFIG_PATH;
    const { createApp } = await import('../../gui/server.js');
    const app = createApp(TEST_CONFIG_PATH, 5174, {
      commandBridge: { submitStudioCreate: createMock, submitDreamResearch: dreamMock,
        submitDreamTransfer: transferMock, submitDreamActivation: activationMock,
        submitCompoundCreate: compoundMock, composeStudioLayersGoverned: composeMock },
    });
    server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, () => resolve()));
    const a = server.address();
    port = typeof a === 'object' && a && 'port' in a ? a.port : 0;
    expect(port).toBeGreaterThan(0);
  }, 30000);

  afterAll(async () => {
    if (server) await new Promise((resolve) => server.close(resolve));
    delete process.env.LIMINAL_CONFIG_PATH;
    await fs.rm(TEST_DIR, { recursive: true, force: true }).catch(() => {});
  });

  async function postCompose(body) {
    const res = await fetch(`http://127.0.0.1:${port}/api/compose`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const json = await res.json().catch(() => ({}));
    return { status: res.status, body: json };
  }

  it('accepts only creative intent and never caller-supplied Create authority', async () => {
    const missing = await fetch(`http://127.0.0.1:${port}/api/liminal/create`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
    });
    expect(missing.status).toBe(400);
    const rejected = await fetch(`http://127.0.0.1:${port}/api/liminal/create`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ command: { schema: 'sinter.liminal-command' } }),
    });
    expect(rejected.status).toBe(400);
    const input = { prompt: 'layer light', domain: 'html', layers: ['light'] };
    createMock.mockResolvedValueOnce({ kind: 'create', status: 'completed' });
    const response = await fetch(`http://127.0.0.1:${port}/api/liminal/create`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ input }),
    });
    expect(response.status).toBe(200);
    expect(createMock).toHaveBeenCalledWith(input);
  });

  it('forwards only a caller-supplied governed Dream command', async () => {
    const command = { schema: 'sinter.dream-product-command', idempotencyKey: 'dream-1' };
    dreamMock.mockResolvedValueOnce({ kind: 'dream-research', status: 'completed' });
    const response = await fetch(`http://127.0.0.1:${port}/api/liminal/dream`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ command }),
    });
    expect(response.status).toBe(200);
    expect(dreamMock).toHaveBeenCalledWith(command);
  });

  it.each([['transfer', transferMock], ['activate', activationMock]])(
    'forwards only a caller-supplied governed Dream %s command', async (route, handler) => {
      const command = { schema: `sinter.dream-${route}-command`, idempotencyKey: route };
      handler.mockResolvedValueOnce({ kind: `dream-${route}`, status: 'completed' });
      const response = await fetch(`http://127.0.0.1:${port}/api/liminal/dream/${route}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ command }),
      });
      expect(response.status).toBe(200);
      expect(handler).toHaveBeenCalledWith(command);
    });

  it('forwards only a caller-supplied compound Create command', async () => {
    const command = { schema: 'sinter.compound-create-command', idempotencyKey: 'compound-1' };
    compoundMock.mockResolvedValueOnce({ kind: 'compound-create', outcome: 'compound-proven' });
    const response = await fetch(`http://127.0.0.1:${port}/api/liminal/compound-create`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ command }),
    });
    expect(response.status).toBe(200);
    expect(compoundMock).toHaveBeenCalledWith(command);
  });

  describe('validation (no LLM)', () => {
    it('rejects an empty layer list', async () => {
      const { status, body } = await postCompose({ layers: [] });
      expect(status).toBe(400);
      expect(body.error).toBe('at least one layer is required');
    });

    it('accepts eight layers without a semantic maximum', async () => {
      composeMock.mockResolvedValueOnce({ html: '<html></html>', title: 'x', successCount: 8, layers: [] });
      const eight = Array.from({ length: 8 }, (_, index) => ({ domain: 'p5', prompt: `layer ${index}` }));
      const { status } = await postCompose({ layers: eight });
      expect(status).toBe(200);
      expect(composeMock.mock.calls.at(-1)[0].layers).toHaveLength(8);
    });

    it('rejects an unsupported medium', async () => {
      const { status, body } = await postCompose({ layers: [{ domain: 'banana', prompt: 'x' }] });
      expect(status).toBe(400);
      expect(body.error).toBe('layer 1: unsupported medium "banana"');
    });

    it('rejects a layer with no description', async () => {
      const { status, body } = await postCompose({ layers: [{ domain: 'p5', prompt: '   ' }] });
      expect(status).toBe(400);
      expect(body.error).toBe('layer 1: a description is required');
    });

    it('rejects an unsupported blend mode', async () => {
      const { status, body } = await postCompose({
        layers: [{ domain: 'p5', prompt: 'a' }, { domain: 'shader', prompt: 'b', blendMode: 'plasma' }],
      });
      expect(status).toBe(400);
      expect(body.error).toBe('layer 2: unsupported blend mode "plasma"');
    });

    it('rejects an out-of-range opacity', async () => {
      const { status, body } = await postCompose({ layers: [{ domain: 'p5', prompt: 'a', opacity: 1.5 }] });
      expect(status).toBe(400);
      expect(body.error).toBe('layer 1: opacity must be between 0 and 1');
    });

    it('does not call the orchestrator when validation fails', async () => {
      composeMock.mockClear();
      await postCompose({ layers: [] });
      expect(composeMock).not.toHaveBeenCalled();
    });
  });

  describe('happy path (orchestrator mocked)', () => {
    it('passes a normalized spec to the orchestrator and returns html + a layer summary', async () => {
      composeMock.mockResolvedValueOnce({
        html: '<html><body>composite</body></html>',
        title: 'Moonlit stack',
        successCount: 2,
        coupled: true,
        lane: 'three-shader',
        lineageId: 'studio-compose-test',
        recipeDigest: 'a'.repeat(64),
        layers: [
          { domain: 'three', prompt: 'base', blendMode: 'normal', opacity: 1, generated: true },
          { domain: 'shader', prompt: 'top', blendMode: 'screen', opacity: 0.6, generated: true, seamGuarded: true },
        ],
        renderGate: { verdict: 'ok', measure: { luminance: 0.4 } },
      });

      const { status, body } = await postCompose({
        title: 'Moonlit stack',
        layers: [
          { domain: 'three', prompt: 'a calm 3D moonlit bay' },
          { domain: 'shader', prompt: 'drifting fog overlay', blendMode: 'SCREEN', opacity: 0.6 },
        ],
      });

      expect(status).toBe(200);
      expect(body.html).toBe('<html><body>composite</body></html>');
      expect(body.successCount).toBe(2);
      expect(body.coupled).toBe(true);
      expect(body.lane).toBe('three-shader');
      expect(body.lineageId).toBe('studio-compose-test');
      expect(body.recipeDigest).toBe('a'.repeat(64));
      expect(body.renderGate).toEqual({ verdict: 'ok' });
      expect(body.layers).toEqual([
        { domain: 'three', blendMode: 'normal', opacity: 1, generated: true, error: undefined, seamGuarded: undefined },
        { domain: 'shader', blendMode: 'screen', opacity: 0.6, generated: true, error: undefined, seamGuarded: true },
      ]);

      // The spec handed to the product command bridge is normalized.
      const spec = composeMock.mock.calls.at(-1)[0];
      expect(spec.title).toBe('Moonlit stack');
      expect(spec.layers).toEqual([
        { domain: 'three', prompt: 'a calm 3D moonlit bay' },
        { domain: 'shader', prompt: 'drifting fog overlay', blendMode: 'screen', opacity: 0.6 },
      ]);
    });

    it('accepts a base layer carrying code (kept as-is) with prompt-based overlays', async () => {
      composeMock.mockResolvedValueOnce({ html: '<html></html>', title: 'x', successCount: 2, layers: [], renderGate: undefined });
      const { status } = await postCompose({
        layers: [
          { domain: 'p5', code: 'function setup(){ createCanvas(400,400); }' },
          { domain: 'shader', prompt: 'drifting fog', blendMode: 'screen' },
        ],
      });
      expect(status).toBe(200);
      // The base layer reaches the product command bridge with its exact code.
      const spec = composeMock.mock.calls.at(-1)[0];
      expect(spec.layers[0]).toMatchObject({ domain: 'p5', code: 'function setup(){ createCanvas(400,400); }' });
      expect(spec.layers[1]).toMatchObject({ domain: 'shader', prompt: 'drifting fog', blendMode: 'screen' });
    });

    it('lowers graph v2 with the same deterministic semantics as the packed CLI coordinator', async () => {
      composeMock.mockResolvedValueOnce({ html: '<html></html>', title: 'graph', successCount: 3, layers: [] });
      const { status } = await postCompose({
        schema: 'sinter.composition-graph', schemaVersion: '2.0', status: 'ready', id: 'graph-work',
        title: 'graph', budgets: { maxNodes: 3, maxEdges: 2, maxProviderCalls: 3 },
        nodes: [2, 0, 1].map(index => ({
          id: `layer-${index}`, type: 'layer', layer: { domain: 'p5', prompt: `layer ${index}` },
        })),
        edges: [
          { id: 'edge-0', type: 'before', from: 'layer-0', to: 'layer-1' },
          { id: 'edge-1', type: 'before', from: 'layer-1', to: 'layer-2' },
        ],
      });
      expect(status).toBe(200);
      expect(composeMock.mock.calls.at(-1)[0].layers.map(layer => layer.prompt))
        .toEqual(['layer 0', 'layer 1', 'layer 2']);
    });

    it('returns 500 with the error message when the orchestrator throws', async () => {
      composeMock.mockRejectedValueOnce(new Error('all layers failed to generate'));
      const { status, body } = await postCompose({ layers: [{ domain: 'p5', prompt: 'a lonely dot' }] });
      expect(status).toBe(500);
      expect(body.error).toBe('all layers failed to generate');
    });
  });
});
