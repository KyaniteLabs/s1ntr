import { describe, expect, it } from 'vitest';
import { err, ok } from 'neverthrow';
import { liveSettingsFromProjectConfig, liveSyncContract, parseLiveSettings, withLiveSync } from '../../../src/music/liveSyncContract.js';

describe('live sync contract (Sol F17)', () => {
  it('reads the live block from a successful project-config Result', () => {
    expect(liveSettingsFromProjectConfig(ok({ live: { syncMode: 'osc', oscHost: '127.0.0.1:57120' } }) as never))
      .toEqual({ syncMode: 'osc', oscHost: '127.0.0.1:57120' });
  });
  it('a missing or failed project config means no settings', () => {
    expect(liveSettingsFromProjectConfig(err(new Error('none')) as never)).toEqual({});
    expect(liveSettingsFromProjectConfig(ok({}) as never)).toEqual({});
  });
  it.each([[{ syncMode: 'warp' }], [{ oscHost: 'bad host!' }], [{ syncMode: 3 }], ['x']])('rejects malformed %j', bad => {
    expect(() => parseLiveSettings(bad)).toThrow(/live/);
  });
  it('the contract names the sync mode and OSC host, and is empty when nothing is set', () => {
    const text = withLiveSync('aurora', { syncMode: 'midi', oscHost: 'studio.local:9000' });
    expect(text.startsWith('aurora')).toBe(true);
    expect(text).toContain('Sync mode: midi');
    expect(text).toContain('OSC host: studio.local:9000');
    expect(liveSyncContract({})).toBe('');
    expect(withLiveSync('aurora', {})).toBe('aurora');
  });
});
