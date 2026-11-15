import { describe, expect, it, vi } from 'vitest';
import { PreferenceEventsFSAdapter } from '../../../src/fs/adapters/PreferenceEvents.js';
import type { SinterFS } from '../../../src/fs/SinterFS.js';
import type { PreferenceRecord } from '../../../src/emergence/types.js';

function makeFs() {
  const ref = { id: 'obj-1' };
  const writeArtifact = vi.fn().mockReturnValue(ref);
  const writeRef = vi.fn();
  return { fs: { writeArtifact, writeRef } as unknown as SinterFS, writeArtifact, writeRef, ref };
}

const record: PreferenceRecord = {
  action: 'pairwise-a',
  artifactId: 'art-7',
  comparedTo: 'art-9',
  sessionId: 'sess-1',
  capturedAt: '2026-11-14T10:00:00Z',
};

describe('PreferenceEventsFSAdapter', () => {
  it('writes a preference-event artifact with metadata and returns its ref', () => {
    const { fs, writeArtifact, ref } = makeFs();
    const out = new PreferenceEventsFSAdapter(fs).writePreferenceEvent(record);
    expect(out).toBe(ref);
    const arg = writeArtifact.mock.calls[0][0];
    expect(arg.kind).toBe('preference-event');
    expect(arg.filename).toBe('pref-pairwise-a-art-7.json');
    expect(arg.metadata).toEqual({ action: 'pairwise-a', artifactId: 'art-7', comparedTo: 'art-9', sessionId: 'sess-1' });
    expect(JSON.parse(arg.content)).toEqual(record);
  });

  it('links the event under preference/<artifact>/<action>', () => {
    const { fs, writeRef, ref } = makeFs();
    new PreferenceEventsFSAdapter(fs).writePreferenceEvent(record);
    expect(writeRef).toHaveBeenCalledWith('preference/art-7/pairwise-a', ref);
  });

  it('exports a whole session with count metadata and a session ref', () => {
    const { fs, writeArtifact, writeRef, ref } = makeFs();
    const second: PreferenceRecord = { action: 'pin', artifactId: 'art-8', capturedAt: '2026-11-14T10:01:00Z' };
    const out = new PreferenceEventsFSAdapter(fs).writeSessionPreferences('sess-1', [record, second]);
    expect(out).toBe(ref);
    const arg = writeArtifact.mock.calls[0][0];
    expect(arg.filename).toBe('pref-session-sess-1.json');
    expect(arg.metadata).toEqual({ sessionId: 'sess-1', eventCount: 2 });
    const body = JSON.parse(arg.content);
    expect(body.sessionId).toBe('sess-1');
    expect(body.events).toEqual([record, second]);
    expect(Number.isNaN(Date.parse(body.exportedAt))).toBe(false);
    expect(writeRef).toHaveBeenCalledWith('preference/session/sess-1', ref);
  });

  it('exports an empty session with eventCount 0', () => {
    const { fs, writeArtifact } = makeFs();
    new PreferenceEventsFSAdapter(fs).writeSessionPreferences('empty', []);
    expect(writeArtifact.mock.calls[0][0].metadata).toEqual({ sessionId: 'empty', eventCount: 0 });
  });

  it('propagates storage failures instead of swallowing them', () => {
    const { fs, writeArtifact } = makeFs();
    writeArtifact.mockImplementation(() => { throw new Error('disk full'); });
    expect(() => new PreferenceEventsFSAdapter(fs).writePreferenceEvent(record)).toThrow('disk full');
  });
});
