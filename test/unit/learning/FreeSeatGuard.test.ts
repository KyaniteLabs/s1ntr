import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { assertFreeLearningSeat } from '../../../src/learning/FreeSeatGuard.js';

describe('assertFreeLearningSeat', () => {
  const cfg = path.join(mkdtempSync(path.join(tmpdir(), 'free-seat-')), 'compost-config.json');
  writeFileSync(cfg, '{}');
  it('is inert unless SINTER_LEARNING_FREE_SEATS_ONLY=1', () => {
    expect(() => assertFreeLearningSeat({}, 'anthropic')).not.toThrow();
  });
  it('refuses a missing config file', () => {
    expect(() => assertFreeLearningSeat({ SINTER_LEARNING_FREE_SEATS_ONLY: '1', SINTER_CONFIG_PATH: '/nonexistent/c.json' }, 'glm'))
      .toThrow(/LEARNING_NO_FREE_SEAT.*does not exist/);
    expect(() => assertFreeLearningSeat({ SINTER_LEARNING_FREE_SEATS_ONLY: '1' }, 'glm')).toThrow(/is not set/);
  });
  it('refuses anthropic/openai/auto fall-through', () => {
    for (const p of ['anthropic', 'openai', 'auto', undefined]) {
      expect(() => assertFreeLearningSeat({ SINTER_LEARNING_FREE_SEATS_ONLY: '1', SINTER_CONFIG_PATH: cfg }, p))
        .toThrow(/LEARNING_NO_FREE_SEAT/);
    }
  });
  it('accepts a configured free seat', () => {
    expect(() => assertFreeLearningSeat({ SINTER_LEARNING_FREE_SEATS_ONLY: '1', SINTER_CONFIG_PATH: cfg }, 'glm')).not.toThrow();
  });
});
