import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DreamResearchJournal } from '../../../src/dreaming/research/DreamResearchJournal.js';
import { frozenExperiment } from './dreamResearchFixtures.js';

describe('DreamResearchJournal', () => {
  const roots: string[] = [];
  afterEach(async () => Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))));

  async function journal() {
    const root = await mkdtemp(path.join(tmpdir(), 'dream-journal-'));
    roots.push(root);
    return new DreamResearchJournal(path.join(root, 'dream.sqlite'));
  }

  it('chains revisions and deduplicates exact command replay', async () => {
    const store = await journal();
    const payload = { plan: frozenExperiment() };
    const event = store.append({ aggregateId: 'dream-1', expectedRevision: 0,
      commandId: 'plan-1', type: 'experiment-planned', payload });
    const replay = store.append({ aggregateId: 'dream-1', expectedRevision: 0,
      commandId: 'plan-1', type: 'experiment-planned', payload });
    expect(replay).toEqual(event);
    expect(store.events('dream-1')).toHaveLength(1);
    expect(() => store.append({ aggregateId: 'dream-1', expectedRevision: 0,
      commandId: 'freeze-1', type: 'experiment-frozen', payload: {} }))
      .toThrow('DREAM_JOURNAL_REVISION_CONFLICT');
    store.close();
  });

  it('rejects command-id reuse with different content', async () => {
    const store = await journal();
    store.append({ aggregateId: 'dream-1', expectedRevision: 0,
      commandId: 'same', type: 'experiment-planned',
      payload: { plan: frozenExperiment() } });
    expect(() => store.append({ aggregateId: 'dream-1', expectedRevision: 1,
      commandId: 'same', type: 'experiment-frozen', payload: { value: 2 } }))
      .toThrow('DREAM_JOURNAL_COMMAND_CONFLICT');
    store.close();
  });

  it('updates a rebuildable projection and durable outbox atomically', async () => {
    const store = await journal();
    store.append({ aggregateId: 'dream-1', expectedRevision: 0,
      commandId: 'plan', type: 'experiment-planned',
      payload: { plan: frozenExperiment() } });
    expect(store.projection('dream-1')).toMatchObject({ state: 'planned', revision: 1 });
    expect(store.pendingOutbox()).toHaveLength(1);
    store.markPublished(store.pendingOutbox()[0].eventDigest);
    expect(store.pendingOutbox()).toEqual([]);
    store.close();
  });
});
