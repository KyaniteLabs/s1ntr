import { describe, expect, it } from 'vitest';
import {
  canonicalCliSeatUrl,
  HERMES_REASONING_LEVELS,
  parseHermesSeat,
} from '../../../src/identity/cliSeatUrl.js';

describe('canonicalCliSeatUrl', () => {
  it.each(['codex', 'agy', 'command-code'])('strips /chat/completions from cli://%s', (seat) => {
    expect(canonicalCliSeatUrl(`cli://${seat}/chat/completions`)).toBe(`cli://${seat}`);
  });

  it('leaves unknown seats and plain urls alone', () => {
    expect(canonicalCliSeatUrl('cli://other/chat/completions')).toBe('cli://other/chat/completions');
    expect(canonicalCliSeatUrl('https://api.z.ai/v1/chat/completions')).toBe('https://api.z.ai/v1/chat/completions');
    expect(canonicalCliSeatUrl('cli://codex')).toBe('cli://codex');
  });
});

describe('parseHermesSeat', () => {
  it('exposes the owner-approved reasoning band', () => {
    expect([...HERMES_REASONING_LEVELS]).toEqual(['medium', 'high', 'xhigh']);
  });

  it('parses provider and reasoning, with or without the chat suffix', () => {
    expect(parseHermesSeat('cli://hermes/zai/high')).toEqual({ provider: 'zai', reasoning: 'high' });
    expect(parseHermesSeat('cli://hermes/deep-seek2/xhigh/chat/completions')).toEqual({ provider: 'deep-seek2', reasoning: 'xhigh' });
    expect(parseHermesSeat('cli://hermes/zai/medium/')).toEqual({ provider: 'zai', reasoning: 'medium' });
  });

  it.each([
    'cli://hermes/zai/low',
    'cli://hermes/zai',
    'cli://hermes/ZAI/high',
    'cli://codex/zai/high',
    'https://hermes/zai/high',
    '',
  ])('rejects %j', (url) => {
    expect(parseHermesSeat(url)).toBeNull();
  });
});
