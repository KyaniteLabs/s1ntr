/**
 * Tests for RoutingData async functions — recordRoutingOutcome,
 * getRollingPerformance, getOptimalModelBandit, and getBanditStats.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createRoutingOutcomeAdmission } from '../../src/routing/RoutingOutcomeAdmission.js';

const SHA = 'c'.repeat(64);
const admit = (domain: string, model: string, criterionScore: number) =>
  createRoutingOutcomeAdmission({ role: 'generator', domain, model, criterionScore,
    ownerDecision: 'accepted',
    artifactDigest: SHA, evidenceDigest: SHA, decisionDigest: SHA,
    rendered: true, identityValid: true, digestMatched: true, degraded: false });

const { mockMkdir, mockWriteFile, mockReadFile, mockRecordOutcome, mockIsReady, mockSelectModel, mockGetDomainStats } = vi.hoisted(() => ({
  mockMkdir: vi.fn().mockResolvedValue(undefined),
  mockWriteFile: vi.fn().mockResolvedValue(undefined),
  mockReadFile: vi.fn().mockRejectedValue(new Error('no file')),
  mockRecordOutcome: vi.fn(),
  mockIsReady: vi.fn().mockReturnValue(false),
  mockSelectModel: vi.fn().mockReturnValue(null),
  mockGetDomainStats: vi.fn().mockReturnValue(null),
}));

vi.mock('node:fs/promises', () => ({
  default: {
    mkdir: (...args: unknown[]) => mockMkdir(...args),
    writeFile: (...args: unknown[]) => mockWriteFile(...args),
    readFile: (...args: unknown[]) => mockReadFile(...args),
  },
  mkdir: (...args: unknown[]) => mockMkdir(...args),
  writeFile: (...args: unknown[]) => mockWriteFile(...args),
  readFile: (...args: unknown[]) => mockReadFile(...args),
  // writeFileAtomic (used by recordRoutingOutcome) writes a tmp file then renames it.
  rename: () => Promise.resolve(),
  rm: () => Promise.resolve(),
}));

vi.mock('../../src/routing/GeneratorBanditRouter.js', () => ({
  generatorBanditRouter: {
    recordOutcome: (...args: unknown[]) => mockRecordOutcome(...args),
    isReady: (...args: unknown[]) => mockIsReady(...args),
    selectModel: (...args: unknown[]) => mockSelectModel(...args),
    getDomainStats: (...args: unknown[]) => mockGetDomainStats(...args),
  },
}));

vi.mock('../../src/utils/Logger.js', () => ({
  Logger: { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

import {
  recordRoutingOutcome,
  getRollingPerformance,
  getOptimalModelBandit,
  getBanditStats,
} from '../../src/routing/RoutingData.js';

describe('RoutingData async functions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockMkdir.mockResolvedValue(undefined);
    mockWriteFile.mockResolvedValue(undefined);
    mockReadFile.mockRejectedValue(new Error('no file'));
    mockRecordOutcome.mockReturnValue(undefined);
    mockIsReady.mockReturnValue(false);
    mockSelectModel.mockReturnValue(null);
    mockGetDomainStats.mockReturnValue(null);
  });

  describe('recordRoutingOutcome', () => {
    it('creates directory and writes first record', async () => {
      await recordRoutingOutcome({
        domain: 'music',
        model: 'local',
        qualityScore: 0.8,
        admission: admit('music', 'local', 0.8),
        timestamp: new Date().toISOString(),
      });

      expect(mockMkdir).toHaveBeenCalled();
      expect(mockWriteFile).toHaveBeenCalled();
      const written = JSON.parse((mockWriteFile.mock.calls[0] as unknown[])[1] as string);
      expect(written).toHaveLength(1);
      expect(written[0].domain).toBe('music');
      expect(written[0].model).toBe('local');
      expect(written[0].qualityScore).toBe(0.8);
    });

    it('appends to existing records', async () => {
      const existing = [
        { domain: 'music', model: 'local', qualityScore: 0.7, timestamp: '2026-01-01' },
        { domain: 'music', model: 'cloud', qualityScore: 0.5, timestamp: '2026-01-02' },
      ];
      mockReadFile.mockResolvedValue(JSON.stringify(existing));

      await recordRoutingOutcome({
        domain: 'music',
        model: 'local',
        qualityScore: 0.9,
        admission: admit('music', 'local', 0.9),
        timestamp: new Date().toISOString(),
      });

      const written = JSON.parse((mockWriteFile.mock.calls[0] as unknown[])[1] as string);
      expect(written).toHaveLength(3);
      expect(written[2].qualityScore).toBe(0.9);
    });

    it('trims records to PERFORMANCE_WINDOW (50)', async () => {
      const existing = Array.from({ length: 55 }, (_, i) => ({
        domain: 'code',
        model: 'local',
        qualityScore: 0.5,
        timestamp: `2026-01-${String(i + 1).padStart(2, '0')}`,
      }));
      mockReadFile.mockResolvedValue(JSON.stringify(existing));

      await recordRoutingOutcome({
        domain: 'code',
        model: 'local',
        qualityScore: 0.6,
        admission: admit('code', 'local', 0.6),
        timestamp: new Date().toISOString(),
      });

      const written = JSON.parse((mockWriteFile.mock.calls[0] as unknown[])[1] as string);
      expect(written).toHaveLength(50);
    });

    it('feeds bandit when qualityScore > 0', async () => {
      await recordRoutingOutcome({
        domain: 'music',
        model: 'cloud',
        qualityScore: 0.7,
        admission: admit('music', 'cloud', 0.7),
        timestamp: new Date().toISOString(),
      });

      expect(mockRecordOutcome).toHaveBeenCalledWith(expect.objectContaining({
        domain: 'music', model: 'cloud', criterionScore: 0.7,
      }));
    });

    it('records an admitted failed criterion outcome instead of dropping it', async () => {
      await recordRoutingOutcome({
        domain: 'music',
        model: 'local',
        qualityScore: 0,
        admission: admit('music', 'local', 0),
        timestamp: new Date().toISOString(),
      });

      expect(mockRecordOutcome).toHaveBeenCalledOnce();
    });

    it('rejects score proxies that disagree with admitted evidence', async () => {
      await expect(recordRoutingOutcome({ domain: 'music', model: 'local',
        qualityScore: 0.9, admission: admit('music', 'local', 0.2),
        timestamp: new Date().toISOString() }))
        .rejects.toThrow('ROUTING_RECORD_ADMISSION_MISMATCH');
    });
  });

  describe('getRollingPerformance', () => {
    it('returns null when fewer than 5 records', async () => {
      const records = Array.from({ length: 3 }, (_, i) => ({
        domain: 'music',
        model: 'local',
        qualityScore: 0.5,
        timestamp: `2026-01-${String(i + 1).padStart(2, '0')}`,
      }));
      mockReadFile.mockResolvedValue(JSON.stringify(records));

      const result = await getRollingPerformance('music');
      expect(result).toBeNull();
    });

    it('aggregates local and cloud performance', async () => {
      const records = [
        { domain: 'code', model: 'local', qualityScore: 0.8, timestamp: '2026-01-01' },
        { domain: 'code', model: 'local', qualityScore: 0.6, timestamp: '2026-01-02' },
        { domain: 'code', model: 'cloud', qualityScore: 0.4, timestamp: '2026-01-03' },
        { domain: 'code', model: 'cloud', qualityScore: 0.5, timestamp: '2026-01-04' },
        { domain: 'code', model: 'local', qualityScore: 0.7, timestamp: '2026-01-05' },
      ];
      mockReadFile.mockResolvedValue(JSON.stringify(records));

      const result = await getRollingPerformance('code');
      expect(result).toMatchObject({ local: { count: 3 }, cloud: { count: 2 } });
      expect(result!.local.count).toBe(3);
      expect(result!.local.total).toBeCloseTo(2.1, 5);
      expect(result!.cloud.count).toBe(2);
      expect(result!.cloud.total).toBeCloseTo(0.9, 5);
    });

    it('counts hybrid toward both local and cloud', async () => {
      const records = [
        { domain: 'music', model: 'hybrid', qualityScore: 0.5, timestamp: '2026-01-01' },
        { domain: 'music', model: 'hybrid', qualityScore: 0.6, timestamp: '2026-01-02' },
        { domain: 'music', model: 'hybrid', qualityScore: 0.7, timestamp: '2026-01-03' },
        { domain: 'music', model: 'local', qualityScore: 0.8, timestamp: '2026-01-04' },
        { domain: 'music', model: 'cloud', qualityScore: 0.4, timestamp: '2026-01-05' },
      ];
      mockReadFile.mockResolvedValue(JSON.stringify(records));

      const result = await getRollingPerformance('music');
      expect(result!.local.count).toBe(4); // 3 hybrid + 1 local
      expect(result!.cloud.count).toBe(4); // 3 hybrid + 1 cloud
    });
  });

  describe('getOptimalModelBandit', () => {
    it('returns null when bandit is not ready', () => {
      mockIsReady.mockReturnValue(false);
      expect(getOptimalModelBandit('music')).toBeNull();
    });

    it('returns model selection when bandit is ready', () => {
      mockIsReady.mockReturnValue(true);
      mockSelectModel.mockReturnValue('local');
      expect(getOptimalModelBandit('music')).toBe('local');
    });
  });

  describe('getBanditStats', () => {
    it('delegates to generatorBanditRouter', () => {
      mockGetDomainStats.mockReturnValue({ alpha: 5, beta: 3, pulls: 8 });
      const stats = getBanditStats('code');
      expect(mockGetDomainStats).toHaveBeenCalledWith('code');
      expect(stats).toEqual({ alpha: 5, beta: 3, pulls: 8 });
    });

    it('returns null when no data', () => {
      mockGetDomainStats.mockReturnValue(null);
      expect(getBanditStats('visual')).toBeNull();
    });
  });
});
