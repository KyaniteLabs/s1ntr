import { describe, it, expect, vi } from 'vitest';
import { EntropyHarvester } from '../../../src/entropy/EntropyHarvester.js';

describe('EntropyHarvester', () => {
  it('gathers metabolic input from all sources', async () => {
    const eventStore = { getRecent: vi.fn().mockReturnValue([{ type: 'digest_end', id: 1 }]) };
    const heap = { listFiles: vi.fn().mockResolvedValue(['a.js', 'b.js']) };
    const telemetry = { getSummary: vi.fn().mockReturnValue({ successRate: 0.8, avgDurationMs: 100, totalTasks: 5, totalViolations: 0 }) };
    const getTopSeeds = vi.fn().mockResolvedValue([{ id: 's1', content: 'seed one', score: 9.5 }]);

    const harvester = new EntropyHarvester({ eventStore, heap, telemetry, getTopSeeds });
    const result = await harvester.gather();

    expect(result).toContain('[EVENTS]');
    expect(result).toContain('[FRAGMENTS]');
    expect(result).toContain('[TELEMETRY]');
    expect(result).toContain('a.js');
    expect(result).toContain('s1');
    expect(result).toContain('0.8');
  });

  it('survives when getTopSeeds is omitted', async () => {
    const eventStore = { getRecent: vi.fn().mockReturnValue([]) };
    const heap = { listFiles: vi.fn().mockResolvedValue([]) };
    const telemetry = { getSummary: vi.fn().mockReturnValue({ successRate: 0, avgDurationMs: 0, totalTasks: 0, totalViolations: 0 }) };

    const harvester = new EntropyHarvester({ eventStore, heap, telemetry });
    const result = await harvester.gather();

    expect(result).toContain('[EVENTS]');
    expect(result).toContain('[FRAGMENTS]');
    expect(result).toContain('[TELEMETRY]');
  });

  describe('source counts (#1289)', () => {
    it('reports how many items each source contributed', async () => {
      const harvester = new EntropyHarvester({
        eventStore: { getRecent: vi.fn().mockReturnValue([{ id: 1 }, { id: 2 }]) },
        heap: { listFiles: vi.fn().mockResolvedValue(Array.from({ length: 12 }, (_, i) => `f${i}.js`)) },
        telemetry: { getSummary: vi.fn().mockReturnValue({ successRate: 1, avgDurationMs: 5, totalTasks: 3, totalViolations: 0 }) },
        getTopSeeds: vi.fn().mockResolvedValue([{ id: 's1', content: 'x', score: 1 }]),
      });
      const { input, sources } = await harvester.gatherWithSources();
      expect(sources).toEqual({ events: 2, heapFiles: 10, seeds: 1, telemetry: 1 });
      expect(input).toBe(await harvester.gather());
    });

    it('reports all zeros for empty sources and counts failed sources as zero', async () => {
      const harvester = new EntropyHarvester({
        eventStore: { getRecent: vi.fn().mockReturnValue([]) },
        heap: { listFiles: vi.fn().mockRejectedValue(new Error('heap down')) },
        telemetry: { getSummary: vi.fn().mockReturnValue({ successRate: 0, avgDurationMs: 0, totalTasks: 0, totalViolations: 0 }) },
        getTopSeeds: vi.fn().mockRejectedValue(new Error('seeds down')),
      });
      const { sources } = await harvester.gatherWithSources();
      expect(sources).toEqual({ events: 0, heapFiles: 0, seeds: 0, telemetry: 0 });
    });
  });
});
