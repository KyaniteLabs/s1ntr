/**
 * FailureLogger - Captures all failures for Meta-Harness learning
 * 
 * Every failure is logged with rich context for pattern detection
 */

import { writeFileSync, existsSync, readdirSync, readFileSync, unlinkSync, copyFileSync, constants } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { ensureDir } from '../utils/fs.js';
import { Logger } from '../utils/Logger.js';

export const MAX_FAILURE_RECORDS = 500;
/** Bound on records kept in memory after their disk write failed. */
export const MAX_UNWRITTEN_FAILURES = 100;

/**
 * Outcome of {@link FailureLogger.log}. A failed write is reported to the
 * caller (and retained in memory) instead of disappearing behind a warning.
 */
export type FailureLogWriteResult =
  | { written: true; path: string; id: string }
  | { written: false; id: string; error: string };

export function archiveFailureRecord(logDir: string, filename: string): void {
  if (!/^\d+-[a-z0-9]{9}\.json$/.test(filename)) throw new Error('not an owned failure record');
  const source = join(logDir, filename);
  const archive = join(logDir, 'archive');
  ensureDir(archive);
  const target = join(archive, filename);
  try {
    copyFileSync(source, target, constants.COPYFILE_EXCL);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  // Never discard the active record unless the retained bytes agree.
  if (!readFileSync(source).equals(readFileSync(target))) {
    throw new Error('archive differs; active failure record retained');
  }
  unlinkSync(source);
}

export interface FailureRecord {
  id?: string;
  timestamp: string;
  sessionId: string;
  model: string;
  domain: string;
  prompt: string;
  code?: string;
  error: string;
  errorType: 'timeout' | 'validation' | 'generation' | 'runtime' | 'degraded' | 'other';
  provider?: string;
  validationErrors?: string[];
  thinking?: string;
  reasoning?: string;
  duration: number;
  iteration?: number;
  codeLength?: number;
}

export class FailureLogger {
  private logDir: string;
  private sessionId: string;
  private unwritten: FailureRecord[] = [];

  constructor() {
    this.logDir = join(homedir(), '.sinter', 'failures');
    this.sessionId = `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    this.ensureDir();
    this.prune();
  }

  private ensureDir(): void {
    ensureDir(this.logDir);
  }

  private prune(files?: string[]): void {
    let currentFiles: string[];
    try {
      currentFiles = files ?? readdirSync(this.logDir);
    } catch (error) {
      Logger.warn('Meta-Harness', `Failed to scan failure records for pruning: ${String(error)}`);
      return;
    }

    const ownedRecords = currentFiles
      .filter(filename => /^\d+-[a-z0-9]{9}\.json$/.test(filename))
      .sort((a, b) => {
        const timeDifference = Number(a.split('-', 1)[0]) - Number(b.split('-', 1)[0]);
        return timeDifference || a.localeCompare(b);
      });

    for (const filename of ownedRecords.slice(0, -MAX_FAILURE_RECORDS)) {
      try {
        archiveFailureRecord(this.logDir, filename);
      } catch (error) {
        Logger.warn('Meta-Harness', `Failed to prune failure record ${filename}: ${String(error)}`);
      }
    }
  }

  /**
   * Persist a failure record. Never throws (callers are usually already in an
   * error path), but returns whether the record reached disk. When the write
   * fails the record is kept in a bounded in-memory buffer
   * ({@link getUnwrittenFailures}) so the evidence is not silently lost.
   */
  log(failure: Omit<FailureRecord, 'timestamp' | 'sessionId' | 'id'>): FailureLogWriteResult {
    const record: FailureRecord = {
      ...failure,
      id: `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      timestamp: new Date().toISOString(),
      sessionId: this.sessionId,
    };

    const filename = `${record.id}.json`;
    const filepath = join(this.logDir, filename);

    try {
      writeFileSync(filepath, JSON.stringify(record, null, 2));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.unwritten.push(record);
      if (this.unwritten.length > MAX_UNWRITTEN_FAILURES) this.unwritten.shift();
      Logger.warn('Meta-Harness', `Failed to write failure record ${record.id} (retained in memory): ${message}`);
      return { written: false, id: record.id!, error: message };
    }
    this.prune();
    Logger.info('Meta-Harness', `Failure logged: ${filepath}`);
    return { written: true, path: filepath, id: record.id! };
  }

  /** Records whose disk write failed this process, oldest first (bounded). */
  getUnwrittenFailures(): readonly FailureRecord[] {
    return [...this.unwritten];
  }

  getRecentFailures(count: number = 100): FailureRecord[] {
    if (!existsSync(this.logDir)) return [];
    
    const files = readdirSync(this.logDir)
      .filter(f => f.endsWith('.json'))
      .sort()
      .reverse()
      .slice(0, count);
    
    return files.map(f => {
      const content = readFileSync(join(this.logDir, f), 'utf-8');
      return JSON.parse(content) as FailureRecord;
    });
  }

  getSessionId(): string {
    return this.sessionId;
  }
}

// Singleton instance
export const failureLogger = new FailureLogger();
