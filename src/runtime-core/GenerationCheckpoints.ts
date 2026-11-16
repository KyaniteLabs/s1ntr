/**
 * Generation checkpoints: every completed provider reply in one generate()
 * turn is saved before the next call (strict retry, escalation, repair). When
 * a later call fails, the run still fails, but a rerun with the same brief and
 * seat reuses the saved replies instead of paying for them again. A turn that
 * succeeds clears its checkpoints, so the next run samples fresh.
 */

import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

export interface GenerationCheckpoint {
  readonly kind: string;
  readonly identity: string;
  readonly code: string;
  readonly reasoning?: string;
  readonly provenance?: unknown;
  readonly usage?: unknown;
  readonly savedAt: string;
}

export interface GenerationCheckpointStore {
  load(key: string): Promise<GenerationCheckpoint | null>;
  save(key: string, checkpoint: GenerationCheckpoint): Promise<void>;
  remove(key: string): Promise<void>;
}

/** Stable across reruns: seat, domain, the user's brief and the call kind. */
export function generationCheckpointKey(parts: {
  readonly identity: string; readonly domain: string; readonly prompt: string; readonly kind: string;
}): string {
  return createHash('sha256')
    .update(JSON.stringify([parts.identity, parts.domain, parts.prompt, parts.kind]))
    .digest('hex');
}

export class FileGenerationCheckpointStore implements GenerationCheckpointStore {
  constructor(private readonly directory: string) {}

  private file(key: string): string {
    if (!/^[A-Za-z0-9_-]+$/.test(key)) throw new Error(`GENERATION_CHECKPOINT_KEY_INVALID:${key}`);
    return path.join(this.directory, `${key}.json`);
  }

  async load(key: string): Promise<GenerationCheckpoint | null> {
    let raw: string;
    try { raw = await readFile(this.file(key), 'utf8'); } catch { return null; }
    try {
      const parsed = JSON.parse(raw) as Partial<GenerationCheckpoint>;
      if (typeof parsed.code !== 'string' || parsed.code.trim().length === 0
        || typeof parsed.kind !== 'string' || typeof parsed.identity !== 'string') return null;
      return parsed as GenerationCheckpoint;
    } catch { return null; }
  }

  async save(key: string, checkpoint: GenerationCheckpoint): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const target = this.file(key);
    const temp = `${target}.${process.pid}.tmp`;
    await writeFile(temp, JSON.stringify(checkpoint), { mode: 0o600 });
    await rename(temp, target);
  }

  async remove(key: string): Promise<void> {
    await rm(this.file(key), { force: true });
  }
}
