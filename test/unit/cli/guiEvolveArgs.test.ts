import { describe, expect, it } from 'vitest';
import { isTransientTransportError, parseGuiEvolveArgs } from '../../../src/cli/guiEvolveArgs.js';

describe('parseGuiEvolveArgs (Sol F12)', () => {
  it('defaults to one run cycle', () => expect(parseGuiEvolveArgs(undefined, undefined)).toEqual({ sub: 'run', cycles: 1 }));
  it('accepts run, report and a whole --n', () => {
    expect(parseGuiEvolveArgs('report', undefined).sub).toBe('report');
    expect(parseGuiEvolveArgs('run', '3')).toEqual({ sub: 'run', cycles: 3 });
  });
  it.each(['0', '-1', 'abc', '1.5', '', '1000'])('refuses --n %j', bad => {
    expect(() => parseGuiEvolveArgs('run', bad)).toThrow(/--n must be a whole number/);
  });
  it('refuses an unknown subcommand', () => expect(() => parseGuiEvolveArgs('reprot', '1')).toThrow(/unknown subcommand/));
});

describe('isTransientTransportError', () => {
  it.each(['fetch failed', 'ETIMEDOUT', 'HTTP 503 upstream', 'rate limit hit', 'request timed out'])('retries %s', m => {
    expect(isTransientTransportError(new Error(m))).toBe(true);
  });
  it.each(['metered funding evidence missing for x', 'IDENTITY_MISMATCH', 'SyntaxError: bad json', 'plain logic bug'])('does not retry %s', m => {
    expect(isTransientTransportError(new Error(m))).toBe(false);
  });
});
