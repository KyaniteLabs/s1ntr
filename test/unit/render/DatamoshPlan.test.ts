import { describe, expect, it } from 'vitest';
import { parseMoshPlan } from '../../../src/render/DatamoshPlan.js';

const ok = { segments: [{ clip: 'waves', start: 1, duration: 3 }], strip: 'all', holds: [{ at: 20, repeat: 15 }], post: { saturation: 2.5, hue: 40 } };

describe('parseMoshPlan', () => {
  it('accepts a well-formed plan, with or without a code fence', () => {
    expect(parseMoshPlan(JSON.stringify(ok)).plan.segments[0].clip).toBe('waves');
    expect(parseMoshPlan('```json\n' + JSON.stringify(ok) + '\n```').plan.holds).toEqual([{ at: 20, repeat: 15 }]);
  });
  it('fills defaults: gop, fps, width', () => {
    expect(parseMoshPlan(JSON.stringify({ segments: ok.segments })).plan).toMatchObject({ gop: 12, fps: 24, width: 480, strip: 'all', holds: [] });
  });
  it.each([
    ['not JSON', 'make it glitchy'],
    ['no segments', '{"segments":[]}'],
    ['three segments', JSON.stringify({ segments: [ok.segments[0], ok.segments[0], ok.segments[0]] })],
    ['negative start', JSON.stringify({ segments: [{ clip: 'a', start: -1, duration: 2 }] })],
    ['total over 12 s', JSON.stringify({ segments: [{ clip: 'a', start: 0, duration: 10 }, { clip: 'b', start: 0, duration: 5 }] })],
    ['path-like clip id', JSON.stringify({ segments: [{ clip: '../x', start: 0, duration: 2 }] })],
    ['gop of 1', JSON.stringify({ segments: ok.segments, gop: 1 })],
    ['width 4000', JSON.stringify({ segments: ok.segments, width: 4000 })],
    ['saturation 99', JSON.stringify({ segments: ok.segments, post: { saturation: 99 } })],
  ])('rejects %s', (_name, text) => {
    expect(() => parseMoshPlan(text)).toThrow();
  });
});
