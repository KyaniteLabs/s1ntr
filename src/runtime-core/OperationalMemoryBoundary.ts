import { createHash } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { writeFileAtomic } from '../utils/atomicWrite.js';

export type HistoricalMemoryClassification =
  | 'operational-read-only' | 'quarantined';

export interface HistoricalMemoryRecord {
  readonly digest: string;
  readonly sourceSchema: string;
  readonly classification: HistoricalMemoryClassification;
  readonly bytesBase64: string;
}

interface BoundaryState {
  readonly schema: 'sinter.operational-memory-boundary';
  readonly schemaVersion: 1;
  readonly activeWriter: 'operational-memory-v1';
  readonly records: readonly HistoricalMemoryRecord[];
}

const emptyState = (): BoundaryState => ({
  schema: 'sinter.operational-memory-boundary', schemaVersion: 1,
  activeWriter: 'operational-memory-v1', records: [],
});

const digest = (bytes: Uint8Array): string =>
  createHash('sha256').update(bytes).digest('hex');

const classify = (sourceSchema: string): HistoricalMemoryClassification =>
  sourceSchema === 'harness-memory-v2' ? 'operational-read-only' : 'quarantined';

/** Historical harness memory is diagnostics only and never a creative-teaching reader. */
export class FileOperationalMemoryBoundary {
  readonly creativeTeachingAuthority = false as const;
  private queue = Promise.resolve();

  constructor(private readonly file: string) {
    if (!path.isAbsolute(file)) throw new Error('OPERATIONAL_MEMORY_PATH_NOT_ABSOLUTE');
  }

  preserve(bytes: Uint8Array, sourceSchema: string): Promise<HistoricalMemoryRecord> {
    return this.serialize(async () => {
      const state = await this.load();
      const record = Object.freeze({ digest: digest(bytes), sourceSchema,
        classification: classify(sourceSchema),
        bytesBase64: Buffer.from(bytes).toString('base64') });
      const existing = state.records.find(item => item.digest === record.digest);
      if (existing) {
        if (existing.bytesBase64 !== record.bytesBase64) {
          throw new Error('OPERATIONAL_MEMORY_DIGEST_COLLISION');
        }
        return existing;
      }
      await this.save({ ...state, records: [...state.records, record] });
      return record;
    });
  }

  async readBytes(recordDigest: string): Promise<Buffer | null> {
    await this.queue;
    const record = (await this.load()).records.find(item => item.digest === recordDigest);
    return record ? Buffer.from(record.bytesBase64, 'base64') : null;
  }

  async queryDiagnostics(term: string): Promise<readonly HistoricalMemoryRecord[]> {
    await this.queue;
    const needle = term.toLowerCase();
    return Object.freeze((await this.load()).records.filter(record =>
      record.classification === 'operational-read-only'
      && Buffer.from(record.bytesBase64, 'base64').toString('utf8')
        .toLowerCase().includes(needle)));
  }

  async rollbackProjection(reason: string): Promise<Readonly<{
    activeWriter: 'operational-memory-v1'; legacyWriterRestored: false;
    readOnlyProjectionCount: number;
  }>> {
    if (!reason.trim()) throw new Error('OPERATIONAL_MEMORY_ROLLBACK_REASON_REQUIRED');
    await this.queue;
    const state = await this.load();
    return Object.freeze({ activeWriter: state.activeWriter,
      legacyWriterRestored: false as const,
      readOnlyProjectionCount: state.records.length });
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const pending = this.queue.then(operation);
    this.queue = pending.then(() => undefined, () => undefined);
    return pending;
  }

  private async load(): Promise<BoundaryState> {
    try {
      const parsed = JSON.parse(await readFile(this.file, 'utf8')) as BoundaryState;
      if (parsed.schema !== 'sinter.operational-memory-boundary'
        || parsed.schemaVersion !== 1 || parsed.activeWriter !== 'operational-memory-v1'
        || !Array.isArray(parsed.records)) {
        throw new Error('OPERATIONAL_MEMORY_SCHEMA_UNKNOWN');
      }
      return parsed;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptyState();
      throw error;
    }
  }

  private async save(state: BoundaryState): Promise<void> {
    await mkdir(path.dirname(this.file), { recursive: true });
    await writeFileAtomic(this.file, `${JSON.stringify(state, null, 2)}\n`);
  }
}
