import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdir, readFile, rename, rm, stat, utimes } from 'node:fs/promises';
import path from 'node:path';
import { writeFileAtomic } from '../utils/atomicWrite.js';
import {
  CampaignCandidateLedger,
  type CampaignCandidateInsertion,
  type CampaignCeilings,
  type CampaignManifest,
} from './CampaignManifest.js';

export interface CampaignLedgerPersistence {
  read(key: string): Promise<string | null>;
  write(key: string, data: string): Promise<void>;
  claim<T>(key: string, operation: () => Promise<T>): Promise<T>;
  readSync(key: string): string | null;
}

/** Crash-safe, cross-process claims plus atomic file replacement. */
export class FileCampaignLedgerPersistence implements CampaignLedgerPersistence {
  constructor(readonly directory: string) {}

  private filePath(key: string): string {
    return path.join(this.directory, `${createHash('sha256').update(key).digest('hex')}.json`);
  }

  private async acquireLock(key: string): Promise<() => Promise<void>> {
    await mkdir(this.directory, { recursive: true });
    const lockPath = `${this.filePath(key)}.lock`;
    for (;;) {
      try {
        await mkdir(lockPath);
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        try {
          const lock = await stat(lockPath);
          if (Date.now() - lock.mtimeMs > 60_000) {
            const stalePath = `${lockPath}.stale-${process.pid}-${randomUUID()}`;
            try {
              await rename(lockPath, stalePath);
              await rm(stalePath, { recursive: true, force: true });
            } catch (reclaimError) {
              if ((reclaimError as NodeJS.ErrnoException).code !== 'ENOENT') throw reclaimError;
            }
          }
        } catch (statError) {
          if ((statError as NodeJS.ErrnoException).code !== 'ENOENT') throw statError;
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    }
    const heartbeat = setInterval(() => {
      void utimes(lockPath, new Date(), new Date()).catch(() => undefined);
    }, 20_000);
    heartbeat.unref?.();
    return async () => {
      clearInterval(heartbeat);
      await rm(lockPath, { recursive: true, force: true });
    };
  }

  async claim<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const release = await this.acquireLock(key);
    try {
      return await operation();
    } finally {
      await release();
    }
  }

  async read(key: string): Promise<string | null> {
    try {
      return await readFile(this.filePath(key), 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }

  async write(key: string, data: string): Promise<void> {
    await mkdir(this.directory, { recursive: true });
    await writeFileAtomic(this.filePath(key), data);
  }

  readSync(key: string): string | null {
    try {
      return readFileSync(this.filePath(key), 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }
}

export interface CampaignStageCounterRecord extends CampaignCeilings {
  readonly stageId: string;
  readonly updatedAt: string;
}

function validCounter(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

/** Cross-process durable per-stage budget counter. */
export class CampaignStageCounters {
  private readonly persistence: FileCampaignLedgerPersistence;

  constructor(directory: string) {
    this.persistence = new FileCampaignLedgerPersistence(directory);
  }

  private key(stageId: string): string {
    return `counter:${stageId}`;
  }

  async increment(stageId: string, delta: CampaignCeilings): Promise<CampaignStageCounterRecord> {
    if (!stageId.trim() || Object.values(delta).some((value) => !validCounter(value))) {
      throw new Error('Campaign stage counter increment is invalid');
    }
    return this.persistence.claim(this.key(stageId), async () => {
      const raw = await this.persistence.read(this.key(stageId));
      const current = raw ? JSON.parse(raw) as CampaignStageCounterRecord : null;
      const record = Object.freeze({
        stageId,
        providerCalls: (current?.providerCalls ?? 0) + delta.providerCalls,
        inputTokens: (current?.inputTokens ?? 0) + delta.inputTokens,
        outputTokens: (current?.outputTokens ?? 0) + delta.outputTokens,
        activeMinutes: (current?.activeMinutes ?? 0) + delta.activeMinutes,
        updatedAt: new Date().toISOString(),
      });
      if ([record.providerCalls, record.inputTokens, record.outputTokens, record.activeMinutes]
        .some((value) => !validCounter(value))) throw new Error('Campaign stage counter overflow');
      await this.persistence.write(this.key(stageId), `${JSON.stringify(record, null, 2)}\n`);
      return record;
    });
  }

  read(stageId: string): CampaignStageCounterRecord | null {
    const raw = this.persistence.readSync(this.key(stageId));
    return raw ? JSON.parse(raw) as CampaignStageCounterRecord : null;
  }
}

function insertionMatches(a: CampaignCandidateInsertion, b: CampaignCandidateInsertion): boolean {
  return a.briefId === b.briefId && a.candidateSlotId === b.candidateSlotId
    && a.artifactDigest === b.artifactDigest && a.status === b.status;
}

/** Atomic candidate result ledger keyed to the frozen manifest digest. */
export class DurableCampaignCandidateLedger {
  private readonly ledgerKey: string;

  constructor(
    private readonly manifest: CampaignManifest,
    private readonly persistence: CampaignLedgerPersistence,
  ) {
    this.ledgerKey = `ledger:${manifest.manifestDigest}`;
  }

  async insert(insertion: CampaignCandidateInsertion): Promise<CampaignCandidateInsertion> {
    const validated = new CampaignCandidateLedger(this.manifest).insert(insertion);
    const key = `${insertion.briefId}:${insertion.candidateSlotId}`;
    return this.persistence.claim(this.ledgerKey, async () => {
      const map = await this.readMap();
      const existing = map.get(key);
      if (existing) {
        if (!insertionMatches(existing, insertion)) {
          throw new Error(`Campaign candidate slot ${key} already has an immutable result`);
        }
        return existing;
      }
      map.set(key, validated);
      await this.persistence.write(this.ledgerKey,
        `${JSON.stringify(Object.fromEntries(map.entries()), null, 2)}\n`);
      return validated;
    });
  }

  private async readMap(): Promise<Map<string, CampaignCandidateInsertion>> {
    return this.parseMap(await this.persistence.read(this.ledgerKey));
  }

  private parseMap(raw: string | null): Map<string, CampaignCandidateInsertion> {
    if (!raw) return new Map();
    return new Map(Object.entries(JSON.parse(raw) as Record<string, CampaignCandidateInsertion>));
  }

  records(): readonly CampaignCandidateInsertion[] {
    const map = this.parseMap(this.persistence.readSync(this.ledgerKey));
    return this.manifest.briefs.flatMap((brief) => brief.candidateSlots.flatMap((slot) => {
      const record = map.get(`${brief.id}:${slot.id}`);
      return record ? [record] : [];
    }));
  }

  isComplete(): boolean {
    return this.records().length === this.manifest.briefs.flatMap((brief) => brief.candidateSlots).length;
  }
}
