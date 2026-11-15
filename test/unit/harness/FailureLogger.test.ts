import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { FailureRecord } from '../../../src/harness/FailureLogger.js';

// --- Mocks ---

const {
  mockWriteFileSync,
  mockExistsSync,
  mockReadFileSync,
  mockReaddirSync,
  mockUnlinkSync,
  mockCopyFileSync,
  mockHomedir,
  mockEnsureDir,
  mockLoggerInfo,
  mockLoggerWarn,
} = vi.hoisted(() => ({
  mockWriteFileSync: vi.fn(),
  mockExistsSync: vi.fn().mockReturnValue(true),
  mockReadFileSync: vi.fn(),
  mockReaddirSync: vi.fn().mockReturnValue([]),
  mockUnlinkSync: vi.fn(),
  mockCopyFileSync: vi.fn(),
  mockHomedir: vi.fn().mockReturnValue('/home/testuser'),
  mockEnsureDir: vi.fn(),
  mockLoggerInfo: vi.fn(),
  mockLoggerWarn: vi.fn(),
}));

vi.mock('fs', () => ({
  writeFileSync: mockWriteFileSync,
  existsSync: mockExistsSync,
  readFileSync: mockReadFileSync,
  readdirSync: mockReaddirSync,
  unlinkSync: mockUnlinkSync,
  copyFileSync: mockCopyFileSync,
  constants: { COPYFILE_EXCL: 1 },
}));

vi.mock('os', () => ({
  homedir: mockHomedir,
}));

vi.mock('../../../src/utils/fs.js', () => ({
  ensureDir: mockEnsureDir,
}));

vi.mock('../../../src/utils/Logger.js', () => ({
  Logger: { info: mockLoggerInfo, debug: vi.fn(), warn: mockLoggerWarn, error: vi.fn() },
}));

import { FailureLogger, MAX_FAILURE_RECORDS, MAX_UNWRITTEN_FAILURES } from '../../../src/harness/FailureLogger.js';

function makeFailure(overrides: Partial<FailureRecord> = {}): Omit<FailureRecord, 'timestamp' | 'sessionId' | 'id'> {
  return {
    model: 'test-model',
    domain: 'test-domain',
    prompt: 'Write a function',
    error: 'Something went wrong',
    errorType: 'runtime',
    duration: 500,
    ...overrides,
  };
}

describe('FailureLogger', () => {
  let logger: FailureLogger;

  beforeEach(() => {
    vi.clearAllMocks();
    mockExistsSync.mockReturnValue(true);
    mockReaddirSync.mockReturnValue([]);
    mockReadFileSync.mockReturnValue(Buffer.from('original failure'));
    mockCopyFileSync.mockReset();
    mockUnlinkSync.mockReset();
    logger = new FailureLogger();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // --- Constructor ---

  describe('constructor', () => {
    it('creates log directory via ensureDir', () => {
      expect(mockEnsureDir).toHaveBeenCalledWith('/home/testuser/.sinter/failures');
    });

    it('generates a unique sessionId', () => {
      const logger2 = new FailureLogger();
      expect(logger.getSessionId()).not.toBe(logger2.getSessionId());
    });

    it('sessionId matches expected format', () => {
      const sid = logger.getSessionId();
      expect(sid).toMatch(/^\d+-[a-z0-9]+$/);
    });
  });

  describe('retention pruning', () => {
    const recordName = (time: number, suffix: string = 'abcdefghi') => `${time}-${suffix}.json`;

    it('keeps the active record when archive storage fails', () => {
      mockReaddirSync.mockReturnValue(Array.from({ length: MAX_FAILURE_RECORDS + 1 }, (_, i) => recordName(i)));
      mockCopyFileSync.mockImplementation(() => { throw new Error('disk full'); });
      new FailureLogger();
      expect(mockUnlinkSync).not.toHaveBeenCalled();
      expect(mockLoggerWarn).toHaveBeenCalledWith('Meta-Harness', expect.stringContaining('disk full'));
    });

    it('does not overwrite a conflicting archive or remove the active record', () => {
      mockReaddirSync.mockReturnValue(Array.from({ length: MAX_FAILURE_RECORDS + 1 }, (_, i) => recordName(i)));
      mockCopyFileSync.mockImplementation(() => { throw Object.assign(new Error('exists'), { code: 'EEXIST' }); });
      mockReadFileSync.mockImplementation((path: string) => Buffer.from(path.includes('/archive/') ? 'different' : 'original'));
      new FailureLogger();
      expect(mockUnlinkSync).not.toHaveBeenCalled();
      expect(mockLoggerWarn).toHaveBeenCalledWith('Meta-Harness', expect.stringContaining('archive differs'));
    });

    it('keeps exactly the retention limit', () => {
      mockUnlinkSync.mockClear();
      mockReaddirSync.mockReturnValue(
        Array.from({ length: MAX_FAILURE_RECORDS }, (_, index) => recordName(index)),
      );

      new FailureLogger();

      expect(mockUnlinkSync).not.toHaveBeenCalled();
    });

    it('preserves the newest records with a deterministic filename fallback', () => {
      mockUnlinkSync.mockClear();
      mockReaddirSync.mockReturnValue([
        recordName(1, 'zzzzzzzzz'),
        recordName(2),
        recordName(1, 'aaaaaaaaa'),
        ...Array.from({ length: MAX_FAILURE_RECORDS - 1 }, (_, index) => recordName(index + 3)),
      ]);

      new FailureLogger();

      expect(mockUnlinkSync).toHaveBeenCalledTimes(2);
      expect(mockUnlinkSync).toHaveBeenNthCalledWith(
        1,
        '/home/testuser/.sinter/failures/1-aaaaaaaaa.json',
      );
      expect(mockUnlinkSync).toHaveBeenNthCalledWith(
        2,
        '/home/testuser/.sinter/failures/1-zzzzzzzzz.json',
      );
    });

    it('prunes during construction and after a successful write', () => {
      mockUnlinkSync.mockClear();
      const records = Array.from(
        { length: MAX_FAILURE_RECORDS + 1 },
        (_, index) => recordName(index),
      );
      mockReaddirSync.mockReturnValue(records);

      const pruningLogger = new FailureLogger();
      expect(mockUnlinkSync).toHaveBeenCalledWith('/home/testuser/.sinter/failures/0-abcdefghi.json');

      mockUnlinkSync.mockClear();
      pruningLogger.log(makeFailure());

      expect(mockWriteFileSync).toHaveBeenCalledTimes(1);
      expect(mockUnlinkSync).toHaveBeenCalledWith('/home/testuser/.sinter/failures/0-abcdefghi.json');
    });

    it('never deletes unrelated files', () => {
      mockUnlinkSync.mockClear();
      mockReaddirSync.mockReturnValue([
        'notes.json',
        '1-too-short.json',
        ...Array.from({ length: MAX_FAILURE_RECORDS }, (_, index) => recordName(index)),
      ]);

      new FailureLogger();

      expect(mockUnlinkSync).not.toHaveBeenCalled();
    });

    it('warns and keeps logging when deletion fails', () => {
      mockReaddirSync.mockReturnValue(
        Array.from({ length: MAX_FAILURE_RECORDS + 1 }, (_, index) => recordName(index)),
      );
      mockUnlinkSync.mockImplementation(() => {
        throw new Error('permission denied');
      });
      const pruningLogger = new FailureLogger();
      mockLoggerWarn.mockClear();

      expect(() => pruningLogger.log(makeFailure())).not.toThrow();
      expect(mockLoggerWarn).toHaveBeenCalledWith(
        'Meta-Harness',
        expect.stringContaining('permission denied'),
      );
      expect(mockLoggerInfo).toHaveBeenCalledTimes(1);
    });
  });

  // --- log() ---

  describe('log', () => {
    it('writes a JSON file with correct fields', () => {
      logger.log(makeFailure());

      expect(mockWriteFileSync).toHaveBeenCalledTimes(1);
      const [filepath, content] = mockWriteFileSync.mock.calls[0];
      expect(filepath).toContain('/home/testuser/.sinter/failures/');
      expect(filepath).toMatch(/\.json$/);

      const parsed: FailureRecord = JSON.parse(content as string);
      expect(parsed.model).toBe('test-model');
      expect(parsed.domain).toBe('test-domain');
      expect(parsed.prompt).toBe('Write a function');
      expect(parsed.error).toBe('Something went wrong');
      expect(parsed.errorType).toBe('runtime');
      expect(parsed.duration).toBe(500);
    });

    it('generates a unique id for each record', () => {
      logger.log(makeFailure());
      logger.log(makeFailure());

      const call1 = JSON.parse(mockWriteFileSync.mock.calls[0][1] as string);
      const call2 = JSON.parse(mockWriteFileSync.mock.calls[1][1] as string);
      expect(call1.id).not.toBe(call2.id);
    });

    it('adds timestamp and sessionId', () => {
      logger.log(makeFailure());

      const parsed = JSON.parse(mockWriteFileSync.mock.calls[0][1] as string);
      expect(parsed.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(parsed.sessionId).toBe(logger.getSessionId());
    });

    it('preserves optional fields when provided', () => {
      logger.log(makeFailure({
        code: 'const x = 1;',
        validationErrors: ['Missing return type', 'Unused variable'],
        thinking: 'I need to think about this',
        reasoning: 'The code is incomplete',
        iteration: 3,
        codeLength: 14,
      }));

      const parsed = JSON.parse(mockWriteFileSync.mock.calls[0][1] as string);
      expect(parsed.code).toBe('const x = 1;');
      expect(parsed.validationErrors).toEqual(['Missing return type', 'Unused variable']);
      expect(parsed.thinking).toBe('I need to think about this');
      expect(parsed.reasoning).toBe('The code is incomplete');
      expect(parsed.iteration).toBe(3);
      expect(parsed.codeLength).toBe(14);
    });

    it('serializes degraded records with provider context', () => {
      logger.log(makeFailure({
        errorType: 'degraded',
        provider: 'openai',
        error: '[evaluator-degraded] evaluator unavailable',
      }));

      const parsed = JSON.parse(mockWriteFileSync.mock.calls[0][1] as string);
      expect(parsed).toMatchObject({
        errorType: 'degraded',
        provider: 'openai',
        domain: 'test-domain',
        model: 'test-model',
      });
    });

    it('omits optional fields when not provided', () => {
      logger.log(makeFailure());

      const parsed = JSON.parse(mockWriteFileSync.mock.calls[0][1] as string);
      expect(parsed.code).toBeUndefined();
      expect(parsed.validationErrors).toBeUndefined();
      expect(parsed.thinking).toBeUndefined();
    });

    it('logs via Logger.info after writing', () => {
      logger.log(makeFailure());

      expect(mockLoggerInfo).toHaveBeenCalledTimes(1);
      expect(mockLoggerInfo.mock.calls[0][0]).toBe('Meta-Harness');
      expect(mockLoggerInfo.mock.calls[0][1]).toContain('Failure logged:');
    });

    it('warns instead of throwing when the record cannot be written', () => {
      const writeError = new Error('disk full');
      mockWriteFileSync.mockImplementationOnce(() => {
        throw writeError;
      });

      expect(() => logger.log(makeFailure({ errorType: 'degraded' }))).not.toThrow();
      expect(mockLoggerWarn.mock.calls[0][0]).toBe('Meta-Harness');
      expect(mockLoggerWarn.mock.calls[0][1]).toContain('disk full');
    });

    it('reports a failed write and retains the record in memory instead of losing it (#1313)', () => {
      mockWriteFileSync.mockImplementationOnce(() => {
        throw new Error('ENOSPC: no space left on device');
      });

      const result = logger.log(makeFailure({ error: 'evidence that must survive' }));

      expect(result.written).toBe(false);
      expect(result.written === false && result.error).toBe('ENOSPC: no space left on device');
      const kept = logger.getUnwrittenFailures();
      expect(kept).toHaveLength(1);
      expect(kept[0].error).toBe('evidence that must survive');
      expect(kept[0].id).toBe(result.id);
      expect(mockLoggerInfo).not.toHaveBeenCalled();
    });

    it('reports a successful write with its path and keeps nothing in the unwritten buffer', () => {
      const result = logger.log(makeFailure());

      expect(result.written).toBe(true);
      expect(result.written === true && result.path).toBe(mockWriteFileSync.mock.calls[0][0]);
      expect(logger.getUnwrittenFailures()).toEqual([]);
    });

    it('bounds the unwritten buffer, dropping the oldest', () => {
      mockWriteFileSync.mockImplementation(() => {
        throw new Error('EROFS');
      });
      for (let i = 0; i < MAX_UNWRITTEN_FAILURES + 5; i++) {
        logger.log(makeFailure({ error: `e${i}` }));
      }
      const kept = logger.getUnwrittenFailures();
      expect(kept).toHaveLength(MAX_UNWRITTEN_FAILURES);
      expect(kept[0].error).toBe('e5');
      expect(kept[kept.length - 1].error).toBe(`e${MAX_UNWRITTEN_FAILURES + 4}`);
      mockWriteFileSync.mockReset();
    });

    it('handles all errorType values', () => {
      const errorTypes: Array<FailureRecord['errorType']> = ['timeout', 'validation', 'generation', 'runtime', 'degraded', 'other'];

      for (const errorType of errorTypes) {
        logger.log(makeFailure({ errorType }));
      }

      expect(mockWriteFileSync).toHaveBeenCalledTimes(6);
      for (let i = 0; i < 6; i++) {
        const parsed = JSON.parse(mockWriteFileSync.mock.calls[i][1] as string);
        expect(parsed.errorType).toBe(errorTypes[i]);
      }
    });
  });

  // --- getRecentFailures() ---

  describe('getRecentFailures', () => {
    it('returns empty array when log directory does not exist', () => {
      mockExistsSync.mockReturnValue(false);
      expect(logger.getRecentFailures()).toEqual([]);
    });

    it('returns parsed failure records from files', () => {
      const record1: FailureRecord = {
        id: 'r1',
        timestamp: '2026-04-05T00:00:00.000Z',
        sessionId: 'session-1',
        model: 'gpt-4',
        domain: 'music',
        prompt: 'Write a melody',
        error: 'Timeout',
        errorType: 'timeout',
        duration: 30000,
      };
      const record2: FailureRecord = {
        id: 'r2',
        timestamp: '2026-04-05T01:00:00.000Z',
        sessionId: 'session-2',
        model: 'claude',
        domain: 'visual',
        prompt: 'Draw a circle',
        error: 'Validation failed',
        errorType: 'validation',
        duration: 100,
      };

      mockReaddirSync.mockReturnValue(['r2.json', 'r1.json']); // reverse chronological from sort().reverse()
      mockReadFileSync.mockImplementation((filepath: string) => {
        if (filepath.includes('r1.json')) return JSON.stringify(record1);
        if (filepath.includes('r2.json')) return JSON.stringify(record2);
        throw new Error('not found');
      });

      const failures = logger.getRecentFailures(10);

      expect(failures).toHaveLength(2);
      expect(failures[0].id).toBe('r2');
      expect(failures[1].id).toBe('r1');
    });

    it('respects the count limit', () => {
      const files = Array.from({ length: 10 }, (_, i) => `f${i}.json`);
      mockReaddirSync.mockReturnValue(files);
      mockReadFileSync.mockImplementation((filepath: string) => {
        const name = filepath.split('/').pop()!.replace('.json', '');
        return JSON.stringify({ id: name, timestamp: '', sessionId: '', model: '', domain: '', prompt: '', error: '', errorType: 'other', duration: 0 });
      });

      const failures = logger.getRecentFailures(3);

      expect(failures).toHaveLength(3);
    });

    it('defaults to 100 records when no count given', () => {
      const files = Array.from({ length: 150 }, (_, i) => `f${i}.json`);
      mockReaddirSync.mockReturnValue(files);
      mockReadFileSync.mockImplementation((filepath: string) => {
        const name = filepath.split('/').pop()!.replace('.json', '');
        return JSON.stringify({ id: name, timestamp: '', sessionId: '', model: '', domain: '', prompt: '', error: '', errorType: 'other', duration: 0 });
      });

      const failures = logger.getRecentFailures();

      expect(failures).toHaveLength(100);
    });
  });
});
