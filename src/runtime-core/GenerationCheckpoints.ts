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
  /** Fingerprint of the effective request settings (endpoint, sampling, thinking) the reply was made under. */
  readonly settings?: string;
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

/**
 * Stable across reruns of the SAME request: seat, domain, brief, call kind and the effective request settings.
 * Changing the endpoint, model, sampling or thinking budget under the same provider/model label is a different
 * request and must not reuse an old reply (Sol G05).
 */
export function generationCheckpointKey(parts: {
  readonly identity: string; readonly domain: string; readonly prompt: string; readonly kind: string;
  readonly settings?: string;
}): string {
  return createHash('sha256')
    .update(JSON.stringify([parts.identity, parts.domain, parts.prompt, parts.kind, parts.settings ?? '']))
    .digest('hex');
}

/** Normalised fingerprint of what shapes the wire request apart from the prompt text. */
export function requestSettingsFingerprint(config: {
  readonly baseUrl?: string; readonly model?: string; readonly temperature?: number; readonly maxTokens?: number;
  readonly thinking?: unknown; readonly reasoningEffort?: unknown;
}): string {
  const url = (config.baseUrl ?? '').trim().toLowerCase().replace(/\/+$/, '');
  return createHash('sha256').update(JSON.stringify([url, config.model ?? '', config.temperature ?? null,
    config.maxTokens ?? null, config.thinking ?? null, config.reasoningEffort ?? null])).digest('hex').slice(0, 16);
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
