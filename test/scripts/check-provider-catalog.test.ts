import { describe, it, expect } from 'vitest';
import { diffCatalog } from '../../scripts/ci/check-provider-catalog.js';
import { MODEL_CHOICES } from '../../src/tui-bridge/ModelPickerCatalog.js';

// Live z.ai and MiniMax /models listings captured 2026-11-10.
const GLM_LIVE_20261110 = ['glm-4.5', 'glm-4.5-air', 'glm-4.6', 'glm-4.7', 'glm-5', 'glm-5-turbo', 'glm-5.1', 'glm-5.2', 'glm-5.3', 'glm-5.3-flash', 'glm-5.3-flashx', 'glm-5.3-flashx-legal'];
const MINIMAX_LIVE_20261110 = ['MiniMax-M2', 'MiniMax-M2.1', 'MiniMax-M2.1-highspeed', 'MiniMax-M2.5', 'MiniMax-M2.5-highspeed', 'MiniMax-M2.7', 'MiniMax-M2.7-highspeed', 'MiniMax-M3', 'MiniMax-M3.1-Flash'];
const picker = (p: string) => MODEL_CHOICES.filter((c) => c.provider === p).map((c) => c.model);

describe('check-provider-catalog diffCatalog', () => {
  it('flags the newest GLM models the old picker lacked', () => {
    expect(diffCatalog(['GLM-5v-turbo', 'glm-5.1'], GLM_LIVE_20261110)).toEqual({
      newer: ['glm-5-turbo', 'glm-5.2', 'glm-5.3', 'glm-5.3-flash', 'glm-5.3-flashx'],
      unlisted: ['GLM-5v-turbo'],
    });
  });

  it('the refreshed picker carries every current MiniMax model', () => {
    expect(diffCatalog(picker('minimax'), MINIMAX_LIVE_20261110)).toEqual({ newer: [], unlisted: [] });
  });

  it('the refreshed picker carries GLM 5.3 and 5.3 Flash', () => {
    expect(diffCatalog(picker('glm'), GLM_LIVE_20261110).newer).toEqual(['glm-5-turbo', 'glm-5.2', 'glm-5.3-flashx']);
  });

  it('matches case-insensitively', () => {
    expect(diffCatalog(['minimax-m3'], ['MiniMax-M3'])).toEqual({ newer: [], unlisted: [] });
  });

  it('handles empty listings and an empty picker', () => {
    expect(diffCatalog(['glm-5.3'], [])).toEqual({ newer: [], unlisted: ['glm-5.3'] });
    expect(diffCatalog([], [])).toEqual({ newer: [], unlisted: [] });
  });
});
