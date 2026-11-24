import { describe, expect, it, vi } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promises as fs } from 'node:fs';
import { HeadlessRenderer } from '../../../src/render/HeadlessRenderer.js';
import { QualityArchive } from '../../../src/learning/QualityArchive.js';

describe('Track 3 performance and cleanup regressions', () => {
  it('HeadlessRenderer.startBusyMeter reads TaskDuration and detaches CDP session idempotently', async () => {
    const detach = vi.fn().mockResolvedValue(undefined);
    const send = vi.fn(async (method: string) => {
      if (method === 'Performance.getMetrics') {
        return { metrics: [{ name: 'TaskDuration', value: 0.25 }] };
      }
      return {};
    });
    const fakePage = {
      context: () => ({
        newCDPSession: vi.fn().mockResolvedValue({ send, detach }),
      }),
    };

    const startBusyMeter = (HeadlessRenderer as unknown as {
      startBusyMeter: (page: unknown) => Promise<{ read: () => Promise<number | null>; detach: () => Promise<void> }>;
    }).startBusyMeter;

    const meter = await startBusyMeter(fakePage);
    expect(await meter.read()).toBe(250);
    await meter.detach();
    await meter.detach();
    expect(detach).toHaveBeenCalledTimes(1);
    expect(await meter.read()).toBeNull();
  });

  it('QualityArchive.query filters and slices before cloning while keeping internal cache immutable', async () => {
    const archivePath = join(tmpdir(), `qa-perf-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
    try {
      const archive = new QualityArchive({ path: archivePath, maxExamplesPerDomain: 20 });
      await archive.load();
      await archive.add({
        id: 'p5_low', domain: 'p5', prompt: 'low', output: 'low', qualityScore: 0.70,
        metadata: { tag: 'a' }, createdAt: '2026-11-20T00:00:00.000Z',
      });
      await archive.add({
        id: 'p5_mid', domain: 'p5', prompt: 'mid', output: 'mid', qualityScore: 0.85,
        metadata: { tag: 'b' }, createdAt: '2026-11-21T00:00:00.000Z',
      });
      await archive.add({
        id: 'p5_top', domain: 'p5', prompt: 'top', output: 'top', qualityScore: 0.95,
        metadata: { tag: 'c' }, createdAt: '2026-11-22T00:00:00.000Z',
      });

      const top = archive.query('p5', { minQuality: 0.8, limit: 1 });
      expect(top).toHaveLength(1);
      expect(top[0].id).toBe('p5_top');
      top[0].metadata.tag = 'mutated';

      const reread = archive.query('p5', { minQuality: 0.8, limit: 1 });
      expect(reread[0].metadata.tag).toBe('c');
    } finally {
      await fs.unlink(archivePath).catch(() => {});
    }
  });
});
