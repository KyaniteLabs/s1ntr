import { describe, it, expect, vi } from 'vitest';
import { MetabolicEntropyEngine } from '../../../src/entropy/MetabolicEntropyEngine.js';

describe('MetabolicEntropyEngine', () => {
  function makeEngine(opts?: { getRecentReturn?: unknown[] }) {
    return new MetabolicEntropyEngine({
      eventStore: { getRecent: vi.fn().mockReturnValue(opts?.getRecentReturn ?? []) },
      heap: { listFiles: vi.fn().mockResolvedValue([]) },
      telemetry: { getSummary: vi.fn().mockReturnValue({ successRate: 1, avgDurationMs: 10, totalTasks: 1, totalViolations: 0 }) },
      compressor: {
        compress: vi.fn().mockReturnValue({ seed: 12345, phrase: 'spark seed root branch', hashChain: ['a', 'b', 'c', 'd'] }),
      },
    });
  }

  it('harvest returns harvested quality when metabolic data is available', async () => {
    const engine = makeEngine({ getRecentReturn: [{ type: 'digest_end' }] });
    const result = await engine.harvest();
    expect(result.quality).toBe('harvested');
    expect(result.source).toBe('metabolic');
    expect(result.seed).toBe(12345);
  });

  it('labels a harvest from all-empty sources as degraded, not harvested (#1289)', async () => {
    const engine = new MetabolicEntropyEngine({
      eventStore: { getRecent: vi.fn().mockReturnValue([]) },
      heap: { listFiles: vi.fn().mockResolvedValue([]) },
      telemetry: { getSummary: vi.fn().mockReturnValue({ successRate: 0, avgDurationMs: 0, totalTasks: 0, totalViolations: 0 }) },
      compressor: { compress: vi.fn().mockReturnValue({ seed: 7, phrase: 'p', hashChain: [] }) },
    });
    const result = await engine.harvest();
    expect(result.quality).toBe('degraded');
    expect(result.source).toBe('metabolic');
    expect(result.sources).toEqual({ events: 0, heapFiles: 0, seeds: 0, telemetry: 0 });
  });

  it('attaches source counts to a harvested result (#1289)', async () => {
    const engine = makeEngine({ getRecentReturn: [{ type: 'digest_end' }] });
    const result = await engine.harvest();
    expect(result.sources).toEqual({ events: 1, heapFiles: 0, seeds: 0, telemetry: 1 });
  });

  it('nextFloat returns a number between 0 and 1', async () => {
    const engine = makeEngine();
    await engine.harvest();
    const v = engine.nextFloat();
    expect(v).toBeGreaterThanOrEqual(0);
    expect(v).toBeLessThan(1);
  });

  it('nextInt returns an integer in range', async () => {
    const engine = makeEngine();
    await engine.harvest();
    const v = engine.nextInt(100);
    expect(Number.isInteger(v)).toBe(true);
    expect(v).toBeGreaterThanOrEqual(0);
    expect(v).toBeLessThan(100);
  });

  it('returns emergency fallback after 3 harvest crashes', async () => {
    const engine = new MetabolicEntropyEngine({
      eventStore: { getRecent: vi.fn().mockReturnValue([]) },
      heap: { listFiles: vi.fn().mockRejectedValue(new Error('boom')) },
      telemetry: { getSummary: vi.fn().mockReturnValue({ successRate: 1, avgDurationMs: 10, totalTasks: 1, totalViolations: 0 }) },
      compressor: { compress: vi.fn().mockImplementation(() => { throw new Error('compressor fail'); }) },
    });

    const r1 = await engine.harvest();
    const r2 = await engine.harvest();
    const r3 = await engine.harvest();
    const r4 = await engine.harvest();
    const r5 = await engine.harvest();

    expect(r3.quality).toBe('emergency');
    expect(r3.source).toBe('fallback');
  });

  it('nextFloat returns a fallback value before harvest is called', () => {
    const engine = makeEngine();
    const v = engine.nextFloat();
    expect(v).toBeGreaterThanOrEqual(0);
    expect(v).toBeLessThan(1);
  });

  describe('source state and draw counter (#1288)', () => {
    const deps = (compress: ReturnType<typeof vi.fn>) => ({
      eventStore: { getRecent: vi.fn().mockReturnValue([]) },
      heap: { listFiles: vi.fn().mockResolvedValue([]) },
      telemetry: { getSummary: vi.fn().mockReturnValue({ successRate: 1, avgDurationMs: 10, totalTasks: 1, totalViolations: 0 }) },
      compressor: { compress },
    });
    const out = (seed: number) => ({ seed, phrase: 'p', hashChain: ['h'] });

    it('advances on every draw and is deterministic for a seed', async () => {
      const a = new MetabolicEntropyEngine(deps(vi.fn().mockReturnValue(out(12345))));
      const b = new MetabolicEntropyEngine(deps(vi.fn().mockReturnValue(out(12345))));
      await a.harvest();
      await b.harvest();
      const seqA = Array.from({ length: 5 }, () => a.nextFloat());
      const seqB = Array.from({ length: 5 }, () => b.nextFloat());
      expect(new Set(seqA).size).toBe(5);
      expect(seqA).toEqual(seqB);
    });

    it('draws from the genesis seed after a harvest crash, not the stale harvested one', async () => {
      const crashed = vi.fn()
        .mockReturnValueOnce(out(12345))
        .mockImplementationOnce(() => { throw new Error('harvest compress fail'); })
        .mockReturnValueOnce(out(777));
      const engine = new MetabolicEntropyEngine(deps(crashed));
      await engine.harvest();
      const genesis = await engine.harvest();
      expect(genesis).toMatchObject({ seed: 777, source: 'genesis', quality: 'degraded' });

      const reference = new MetabolicEntropyEngine(deps(vi.fn().mockReturnValue(out(777))));
      await reference.harvest();
      expect([engine.nextFloat(), engine.nextFloat()]).toEqual([reference.nextFloat(), reference.nextFloat()]);
    });

    it('does not repeat values before any harvest', () => {
      const engine = new MetabolicEntropyEngine(deps(vi.fn()));
      const draws = Array.from({ length: 4 }, () => engine.nextFloat());
      expect(new Set(draws).size).toBe(4);
    });
  });

  describe('draws advance within a second (#1236)', () => {
    it('successive draws at a frozen clock are all distinct', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-11-09T12:00:00.000Z'));
      try {
        const engine = makeEngine();
        await engine.harvest();
        const draws = Array.from({ length: 100 }, () => engine.nextFloat());
        expect(new Set(draws).size).toBe(100);
        for (const d of draws) {
          expect(d).toBeGreaterThanOrEqual(0);
          expect(d).toBeLessThan(1);
        }
      } finally {
        vi.useRealTimers();
      }
    });

    it('same seed replays the same sequence regardless of wall clock', async () => {
      vi.useFakeTimers();
      try {
        vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
        const a = makeEngine();
        await a.harvest();
        const seqA = [a.nextFloat(), a.nextFloat(), a.nextFloat()];

        vi.setSystemTime(new Date('2027-06-15T08:30:00Z'));
        const b = makeEngine();
        await b.harvest();
        const seqB = [b.nextFloat(), b.nextFloat(), b.nextFloat()];

        expect(seqB).toEqual(seqA);
      } finally {
        vi.useRealTimers();
      }
    });

    it('a new harvest restarts the sequence for its seed', async () => {
      const engine = makeEngine();
      await engine.harvest();
      const first = [engine.nextFloat(), engine.nextFloat()];
      await engine.harvest();
      expect([engine.nextFloat(), engine.nextFloat()]).toEqual(first);
    });

    it('pre-harvest draws also advance at a frozen clock', () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-11-09T12:00:00.000Z'));
      try {
        const engine = makeEngine();
        const draws = Array.from({ length: 20 }, () => engine.nextFloat());
        expect(new Set(draws).size).toBe(20);
      } finally {
        vi.useRealTimers();
      }
    });

    it('nextInt draws are roughly uniform over 10 buckets', async () => {
      const engine = makeEngine();
      await engine.harvest();
      const counts = new Array(10).fill(0);
      const n = 20000;
      for (let i = 0; i < n; i++) counts[engine.nextInt(10)]++;
      for (const c of counts) expect(Math.abs(c / n - 0.1)).toBeLessThan(0.015);
    });
  });
});
