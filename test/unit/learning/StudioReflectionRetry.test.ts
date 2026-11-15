import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// HarnessMemory writes under the real home directory: stub that filesystem boundary.
const memory = vi.hoisted(() => ({
  episodes: [] as unknown[],
  initialize: async () => {},
  save: async () => {},
  recordEpisode(e: unknown) { memory.episodes.push(e); },
}));
vi.mock('../../../src/harness/HarnessMemory.js', () => ({ harnessMemory: memory }));

import { SinterFS } from '../../../src/fs/index.js';
import { SessionGraph } from '../../../src/agent/SessionGraph.js';
import { reflectUnreflectedSessions } from '../../../src/learning/StudioReflection.js';

const TASTE = '{"likes":["teal glow"],"dislikes":["busy"],"intentSummary":"quiet pond","satisfaction":0.9}';

describe('reflectUnreflectedSessions retry semantics', () => {
  let dir: string;
  let fs: SinterFS;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'reflect-retry-'));
    fs = SinterFS.open(dir);
    memory.episodes.length = 0;
    new SessionGraph('sess-a', fs).recordTurn({ turnId: 't0', input: 'fireflies', intent: 'create',
      delegatedTo: 'generator', response: 'made fireflies', durationMs: 1 });
  });
  afterEach(() => {
    fs.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('a failed model call leaves the session un-reflected and the next run reflects it', async () => {
    const down = { generate: async () => { throw new Error('Provider transport requires Liminal product command authority'); } };
    const first = await reflectUnreflectedSessions(fs, down);
    expect(first).toMatchObject({ reflected: 0, skipped: 0, failed: 1 });
    expect(first.errors).toEqual(['sess-a: Provider transport requires Liminal product command authority']);
    expect(fs.readManifest('session/sess-a/reflected')).toBeNull();
    expect(memory.episodes).toEqual([]);

    const up = { generate: async () => ({ code: TASTE }) };
    const second = await reflectUnreflectedSessions(fs, up);
    expect(second).toMatchObject({ reflected: 1, skipped: 0, failed: 0, errors: [] });
    expect(second.signals[0].intentSummary).toBe('quiet pond');
    expect(memory.episodes).toHaveLength(1);
  });

  it('an unparseable reply is marked so it is not retried forever', async () => {
    const junk = { generate: async () => ({ code: 'no json here' }) };
    expect(await reflectUnreflectedSessions(fs, junk)).toMatchObject({ reflected: 0, skipped: 1, failed: 0 });
    const again = await reflectUnreflectedSessions(fs, { generate: async () => ({ code: TASTE }) });
    expect(again).toMatchObject({ reflected: 0, skipped: 1, failed: 0 });
  });
});
