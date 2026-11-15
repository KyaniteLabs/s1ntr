/**
 * Unit tests for StagnationDetector — Phase 15
 *
 * Tests stagnation detection from garden health metric history.
 */

import { describe, it, expect } from 'vitest';
import { StagnationDetector } from '../../../src/autonomy/StagnationDetector.js';
import type { GardenHealthMetrics } from '../../../src/autonomy/GardenHealthMonitor.js';

function makeMetrics(overrides: Partial<GardenHealthMetrics> = {}): GardenHealthMetrics {
  return {
    archiveSize: 5,
    nicheOccupancy: 0.5,
    avgLineageDepth: 1,
    fertilityYield: 0.4,
    tasteAlignment: 0.5,
    healthScore: 0.5,
    healthLevel: 'healthy',
    measuredAt: new Date().toISOString(),
    ...overrides,
  };
}

describe('StagnationDetector', () => {
  it('returns not stagnant for insufficient history', () => {
    const detector = new StagnationDetector();
    const result = detector.detect([]);
    expect(result.isStagnant).toBe(false);
    expect(result.severity).toBe(0);
  });

  it('returns not stagnant for single measurement', () => {
    const detector = new StagnationDetector();
    const result = detector.detect([makeMetrics()]);
    expect(result.isStagnant).toBe(false);
  });

  it('detects quality plateau (falls back to fertility when qualityHealth absent)', () => {
    const detector = new StagnationDetector({ stagnationWindow: 3 });
    const history = [
      makeMetrics({ fertilityYield: 0.4 }),
      makeMetrics({ fertilityYield: 0.4 }),
      makeMetrics({ fertilityYield: 0.4 }),
    ];
    const result = detector.detect(history);
    expect(result.signals.find(s => s.metric === 'qualityHealth')).toMatchObject({ value: 0, threshold: 0.01 });
  });

  it('detects niche occupancy plateau', () => {
    const detector = new StagnationDetector({ stagnationWindow: 2 });
    const history = [
      makeMetrics({ nicheOccupancy: 0.3 }),
      makeMetrics({ nicheOccupancy: 0.3 }),
    ];
    const result = detector.detect(history);
    const nicheSignal = result.signals.find(s => s.metric === 'nicheOccupancy');
    expect(nicheSignal).toMatchObject({ metric: 'nicheOccupancy' });
  });

  it('detects declining health', () => {
    const detector = new StagnationDetector({ stagnationWindow: 3 });
    const history = [
      makeMetrics({ healthScore: 0.7 }),
      makeMetrics({ healthScore: 0.5 }),
      makeMetrics({ healthScore: 0.3 }),
    ];
    const result = detector.detect(history);
    const healthSignal = result.signals.find(s => s.metric === 'healthScore');
    expect(healthSignal).toMatchObject({ metric: 'healthScore' });
  });

  it('detects taste alignment drop', () => {
    const detector = new StagnationDetector({ stagnationWindow: 2 });
    const history = [
      makeMetrics({ tasteAlignment: 0.7 }),
      makeMetrics({ tasteAlignment: 0.2 }),
    ];
    const result = detector.detect(history);
    const tasteSignal = result.signals.find(s => s.metric === 'tasteAlignment');
    expect(tasteSignal).toMatchObject({ metric: 'tasteAlignment' });
  });

  it('detects archive size stagnation', () => {
    const detector = new StagnationDetector({ stagnationWindow: 2 });
    const history = [
      makeMetrics({ archiveSize: 5 }),
      makeMetrics({ archiveSize: 5 }),
    ];
    const result = detector.detect(history);
    const archiveSignal = result.signals.find(s => s.metric === 'archiveSize');
    expect(archiveSignal).toMatchObject({ metric: 'archiveSize' });
  });

  it('declares stagnant when 2+ signals fire', () => {
    const detector = new StagnationDetector({ stagnationWindow: 3 });
    const history = [
      makeMetrics({ fertilityYield: 0.4, nicheOccupancy: 0.3, archiveSize: 5 }),
      makeMetrics({ fertilityYield: 0.4, nicheOccupancy: 0.3, archiveSize: 5 }),
      makeMetrics({ fertilityYield: 0.4, nicheOccupancy: 0.3, archiveSize: 5 }),
    ];
    const result = detector.detect(history);
    expect(result.isStagnant).toBe(true);
    expect(result.severity).toBeGreaterThan(0);
    expect(result.recommendations.length).toBeGreaterThanOrEqual(2);
  });

  it('returns not stagnant for improving metrics', () => {
    const detector = new StagnationDetector({ stagnationWindow: 3 });
    const history = [
      makeMetrics({ fertilityYield: 0.3, nicheOccupancy: 0.2, archiveSize: 3 }),
      makeMetrics({ fertilityYield: 0.5, nicheOccupancy: 0.4, archiveSize: 5 }),
      makeMetrics({ fertilityYield: 0.7, nicheOccupancy: 0.6, archiveSize: 8 }),
    ];
    const result = detector.detect(history);
    expect(result.isStagnant).toBe(false);
  });

  it('includes recommendations for detected signals', () => {
    const detector = new StagnationDetector({ stagnationWindow: 2 });
    const history = [
      makeMetrics({ fertilityYield: 0.4, nicheOccupancy: 0.3, archiveSize: 5 }),
      makeMetrics({ fertilityYield: 0.4, nicheOccupancy: 0.3, archiveSize: 5 }),
    ];
    const result = detector.detect(history);
    for (const rec of result.recommendations) {
      expect(typeof rec).toBe('string');
      expect(rec.length).toBeGreaterThan(10);
    }
  });

  describe('full archive (saturation) — no false stagnation', () => {
    it('does NOT flag stagnation when the archive is full but quality is improving', () => {
      const detector = new StagnationDetector({ stagnationWindow: 2 });
      // Full archive: occupancy 1, size pinned at 200 (admissions replace, not grow),
      // fertility flat — the OLD detector fired both signal 1 (fertility flat) and
      // signal 5 (size unchanged) → 2 signals → false stagnation. With qualityHealth
      // rising, signal 1 doesn't fire and signal 5 is gated on room-to-grow.
      const history = [
        makeMetrics({ nicheOccupancy: 1, archiveSize: 200, fertilityYield: 0.8, qualityHealth: 0.70 }),
        makeMetrics({ nicheOccupancy: 1, archiveSize: 200, fertilityYield: 0.8, qualityHealth: 0.80 }),
      ];
      const result = detector.detect(history);
      expect(result.isStagnant).toBe(false);
      expect(result.signals.find(s => s.metric === 'qualityHealth')).toBeUndefined();
      expect(result.signals.find(s => s.metric === 'archiveSize')).toBeUndefined();
    });

    it('DOES surface a quality-plateau signal when a full archive stops improving', () => {
      const detector = new StagnationDetector({ stagnationWindow: 2 });
      const history = [
        makeMetrics({ nicheOccupancy: 1, archiveSize: 200, fertilityYield: 0.8, qualityHealth: 0.80 }),
        makeMetrics({ nicheOccupancy: 1, archiveSize: 200, fertilityYield: 0.8, qualityHealth: 0.80 }),
      ];
      const result = detector.detect(history);
      const qualitySignal = result.signals.find(s => s.metric === 'qualityHealth');
      expect(qualitySignal).toMatchObject({ metric: 'qualityHealth' });
      expect(qualitySignal?.value).toBeCloseTo(0, 5);
    });
  });

  describe('window is enforced (#1283)', () => {
    const flat = () => makeMetrics({ fertilityYield: 0.4, nicheOccupancy: 0.3, archiveSize: 5 });

    it('two flat samples do not trigger with the default window of five', () => {
      const result = new StagnationDetector().detect([flat(), flat()]);
      expect(result).toEqual({ isStagnant: false, severity: 0, signals: [], recommendations: [] });
    });

    it('four flat samples still do not trigger with the default window', () => {
      const result = new StagnationDetector().detect([flat(), flat(), flat(), flat()]);
      expect(result.isStagnant).toBe(false);
      expect(result.signals).toEqual([]);
    });

    it('a full window of five flat samples triggers', () => {
      const result = new StagnationDetector().detect([flat(), flat(), flat(), flat(), flat()]);
      expect(result.isStagnant).toBe(true);
      expect(result.signals.map(s => s.metric).sort()).toEqual(['archiveSize', 'nicheOccupancy', 'qualityHealth']);
    });

    it('only the last window samples are compared', () => {
      const early = makeMetrics({ fertilityYield: 0.1, nicheOccupancy: 0.1, archiveSize: 1 });
      const result = new StagnationDetector({ stagnationWindow: 3 }).detect([early, flat(), flat(), flat()]);
      expect(result.isStagnant).toBe(true);
      expect(result.signals.find(s => s.metric === 'qualityHealth')?.value).toBeCloseTo(0, 5);
    });
  });
});
