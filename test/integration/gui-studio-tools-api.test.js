/**
 * Integration tests for the Studio Tools APIs: taste-train (build the model
 * generation reads), garden health (read-only), and market readiness. The dist
 * engine modules are mocked so no real training/archive/disk is touched.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import path from 'path';
import os from 'os';
import fs from 'fs/promises';
import http from 'http';

const { trainFromProject, getAllCells, measure, getHistory, detect, decide, collectMarket } = vi.hoisted(() => ({
  trainFromProject: vi.fn(),
  getAllCells: vi.fn(() => []),
  measure: vi.fn(() => ({ healthScore: 0.62, healthLevel: 'fair', archiveSize: 41, nicheOccupancy: 0.55 })),
  getHistory: vi.fn(() => []),
  detect: vi.fn(() => ({ isStagnant: false, severity: 0 })),
  decide: vi.fn(() => []),
  collectMarket: vi.fn(() => ({
    ownerReleaseReady: false,
    conjuncts: [{ id: 'quality-gates', passed: false, failures: ['missing CI'] }],
    blockers: ['quality-gates: missing CI'],
  })),
}));

vi.mock('../../dist/learning/index.js', () => ({
  TasteLearningService: class { trainFromProject = trainFromProject; },
}));
vi.mock('../../dist/fs/index.js', () => ({
  SinterFS: { open: () => ({ close: () => {} }) },
}));
vi.mock('../../dist/fs/projectRoot.js', () => ({ resolveSinterProjectRoot: () => '/tmp/sinter-proj' }));
vi.mock('../../dist/autonomy/GardenPolicy.js', () => ({
  GardenPolicy: class { decide = decide; getHealthMonitor() { return { measure, getHistory }; } },
}));
vi.mock('../../dist/autonomy/StagnationDetector.js', () => ({
  StagnationDetector: class { detect = detect; },
}));
vi.mock('../../dist/emergence/index.js', () => ({
  EmergenceHooks: class { getArchive() { return { getAllCells }; } },
}));
vi.mock('../../dist/runtime-core/Wave7RepositoryReleaseTruth.js', () => ({
  collectWave7RepositoryReleaseTruth: collectMarket,
}));

const TEST_DIR = path.join(os.tmpdir(), `sinter-tools-api-${Date.now()}`);
const TEST_CONFIG_PATH = path.join(TEST_DIR, 'config.json');

describe('GUI studio tools API', () => {
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

  const get = async (p) => {
    const res = await fetch(`http://127.0.0.1:${port}${p}`);
    return { status: res.status, body: await res.json().catch(() => ({})) };
  };
  const post = async (p) => {
    const res = await fetch(`http://127.0.0.1:${port}${p}`, { method: 'POST' });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  };

  describe('POST /api/taste/train', () => {
    it('reports a trained model when training persists weights', async () => {
      trainFromProject.mockResolvedValueOnce({
        persisted: true, weights: { pairCount: 12 }, archiveEntryCount: 40, preferenceEventCount: 8, pairCount: 12,
      });
      const { status, body } = await post('/api/taste/train');
      expect(status).toBe(200);
      expect(body).toEqual({ trained: true, archiveEntryCount: 40, preferenceEventCount: 8, pairCount: 12, reason: null });
    });

    it('reports not-trained with the reason when there is no usable preference data', async () => {
      trainFromProject.mockResolvedValueOnce({ persisted: false, weights: null, archiveEntryCount: 3, preferenceEventCount: 0, pairCount: 0, reason: 'no preference events yet' });
      const { status, body } = await post('/api/taste/train');
      expect(status).toBe(200);
      expect(body.trained).toBe(false);
      expect(body.reason).toBe('no preference events yet');
    });

    it('returns 500 when training throws', async () => {
      trainFromProject.mockRejectedValueOnce(new Error('archive unreadable'));
      const { status, body } = await post('/api/taste/train');
      expect(status).toBe(500);
      expect(body.error).toBe('archive unreadable');
    });
  });

  it('lets the background gardener evaluate its policy', async () => {
    await vi.waitFor(() => expect(decide).toHaveBeenCalledWith(expect.any(Array), expect.any(Array)), { timeout: 3_000 });
  });

  describe('GET /api/garden', () => {
    it('returns archive health and stagnation', async () => {
      const { status, body } = await get('/api/garden');
      expect(status).toBe(200);
      expect(body.health).toEqual({ score: 0.62, level: 'fair', archiveSize: 41, occupancy: 0.55 });
      expect(body.stagnation).toEqual({ isStagnant: false, severity: 0 });
    });
  });

  describe('GET /api/market', () => {
    it('returns the honest readiness status', async () => {
      const { status, body } = await get('/api/market');
      expect(status).toBe(200);
      expect(body.status).toEqual({
        ownerReleaseReady: false,
        conjuncts: [{ id: 'quality-gates', passed: false, failures: ['missing CI'] }],
        blockers: ['quality-gates: missing CI'],
      });
    });
  });
});
