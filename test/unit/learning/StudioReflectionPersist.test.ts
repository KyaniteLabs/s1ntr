import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// HarnessMemory writes under the real home directory: stub that filesystem boundary.
const memory = vi.hoisted(() => ({
  episodes: [] as unknown[],
  initialize: async () => {},
  saveFails: false,
  save: async () => (memory.saveFails ? { isErr: () => true, error: new Error('disk full') } : { isErr: () => false }),
  getEpisodesByDomain: () => memory.episodes,
  recordEpisode(e: unknown) { memory.episodes.push(e); },
}));
vi.mock('../../../src/harness/HarnessMemory.js', () => ({ harnessMemory: memory }));

import { SinterFS } from '../../../src/fs/index.js';
import { SessionGraph } from '../../../src/agent/SessionGraph.js';
import { reflectUnreflectedSessions } from '../../../src/learning/StudioReflection.js';

const TASTE = '{"likes":["teal glow"],"dislikes":["busy"],"intentSummary":"quiet pond","satisfaction":0.9}';

describe('F14 reflection persists before it acknowledges', () => {
  let dir: string;
  let fs: SinterFS;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'reflect-persist-'));
    fs = SinterFS.open(dir);
    memory.episodes.length = 0; memory.saveFails = false;
    new SessionGraph('sess-a', fs).recordTurn({ turnId: 't0', input: 'fireflies', intent: 'create',
      delegatedTo: 'generator', response: 'made fireflies', durationMs: 1 });
  });
  afterEach(() => { fs.close(); rmSync(dir, { recursive: true, force: true }); });
  const up = { generate: async () => ({ code: TASTE }) };

  it('retries a failed memory write without duplicating the feedback episode', async () => {
    memory.saveFails = true;
    const first = await reflectUnreflectedSessions(fs, up);
    expect(first).toMatchObject({ reflected: 0, failed: 1 });
    expect(first.errors[0]).toContain('disk full');
    expect(fs.readManifest('session/sess-a/reflected')).toBeNull();
    memory.saveFails = false;
    expect(await reflectUnreflectedSessions(fs, up)).toMatchObject({ reflected: 1, failed: 0 });
    expect(fs.readManifest('session/sess-a/reflected')).toMatchObject({ reflectedAt: expect.any(String) });
    expect(memory.episodes).toEqual([
      expect.objectContaining({ score: 0.9, tags: ['session-taste', 'studio-reflection', 'teal glow'] }),
      expect.objectContaining({ score: 0, tags: ['session-taste', 'studio-reflection', 'dislike', 'busy'] }),
    ]);
  });
});
