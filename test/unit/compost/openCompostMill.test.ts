import { describe, expect, it } from 'vitest';
import { openCompostMill } from '../../../src/compost/openCompostMill.js';

const llm = {
  generate: async () => ({ success: true, code: '{}' }),
  getConfig: () => ({ provider: 'fake', model: 'fake' }),
} as never;

describe('openCompostMill', () => {
  it('builds a mill with the soup default enabled but no entropy engine', () => {
    expect(() => openCompostMill({ llm })).not.toThrow();
  });

  it('refuses to request soup without an entropy engine', () => {
    expect(() => openCompostMill({ llm, enableSoup: true })).toThrow(/requires an entropy engine/);
  });

  it('accepts an explicit entropy engine when soup is requested', () => {
    const entropy = { setGetTopSeeds: () => undefined } as never;
    expect(() => openCompostMill({ llm, enableSoup: true, entropy })).not.toThrow();
  });
});
