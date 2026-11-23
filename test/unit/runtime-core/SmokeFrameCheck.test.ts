import { describe, it, expect } from 'vitest';
import sharp from 'sharp';
import { luminanceProblem, smokeFrameProblem, smokeRuntimeErrors } from '../../../src/runtime-core/SmokeFrameCheck.js';

const frame = async (seed: number) => {
  const raw = Buffer.alloc(64 * 64 * 3);
  for (let i = 0; i < raw.length; i++) raw[i] = (i * seed + 7) % 256;
  return { buffer: await sharp(raw, { raw: { width: 64, height: 64, channels: 3 } }).png().toBuffer(), width: 64, height: 64, success: true };
};

describe('smokeFrameProblem', () => {
  it('flags identical early and late frames for an animated domain', async () => {
    const f = await frame(91);
    expect(await smokeFrameProblem('p5', { screenshot: f, lateScreenshot: f })).toMatch(/static/);
  });
  it('flags a static custom piece (custom is the renamed meta domain)', async () => {
    const f = await frame(91);
    expect(await smokeFrameProblem('custom', { screenshot: f, lateScreenshot: f })).toMatch(/static/);
  });
  it('accepts a piece whose frames differ', async () => {
    expect(await smokeFrameProblem('p5', { screenshot: await frame(91), lateScreenshot: await frame(37) })).toBeNull();
  });
  it.each(['svg', 'ascii', 'textgen', 'dataviz', 'tone', 'strudel'])('does not call %s static', async (domain) => {
    const f = await frame(91);
    expect(await smokeFrameProblem(domain, { screenshot: f, lateScreenshot: f })).toBeNull();
  });
});

// A crushed frame shaped like first-scored-20261123: near-black with a few thin lit strokes, moving.
const darkFrame = async (offset: number) => {
  const w = 64, h = 64, raw = Buffer.alloc(w * h * 3, 3);
  for (let x = 0; x < w; x++) { const y = (x + offset) % h; raw[(y * w + x) * 3] = 40; raw[(y * w + x) * 3 + 2] = 60; }
  return { buffer: await sharp(raw, { raw: { width: w, height: h, channels: 3 } }).png().toBuffer(), width: w, height: h, success: true };
};

describe('smokeFrameProblem luminance', () => {
  it('sends a crushed-dark moving frame to the repair turn with the judge measure', async () => {
    const problem = await smokeFrameProblem('html', { screenshot: await darkFrame(0), lateScreenshot: await darkFrame(9) });
    expect(problem).toMatch(/too dark/);
    expect(problem).toMatch(/40%/);
  });
  it('leaves a lit moving frame alone', async () => {
    expect(await smokeFrameProblem('html', { screenshot: await frame(91), lateScreenshot: await frame(37) })).toBeNull();
  });
  it('never checks luminance for domains without pixel output', async () => {
    expect(await smokeFrameProblem('tone', { screenshot: await darkFrame(0), lateScreenshot: await darkFrame(9) })).toBeNull();
  });
});

describe('luminanceProblem', () => {
  const base = { meanLuminance: 0.015, brightFraction: 0.004, darkFraction: 0.981 };
  it('is null for ok and for a missing measure', () => {
    expect(luminanceProblem(undefined)).toBeNull();
    expect(luminanceProblem({ ...base, verdict: 'ok' })).toBeNull();
  });
  it('names the decay when the first frame was fine', () => {
    expect(luminanceProblem({ ...base, verdict: 'too-dark', temporalDecay: true })).toMatch(/decays/);
  });
  it('gives washout its own fix', () => {
    expect(luminanceProblem({ meanLuminance: 0.9, brightFraction: 1, darkFraction: 0, verdict: 'washout' })).toMatch(/washed out/);
  });
});

describe('smokeRuntimeErrors', () => {
  it('keeps console errors beside the uncaught throw, throw first, no duplicates', () => {
    const nan = 'Error: <path> attribute d: Expected number, "M10,NaN L50,50".';
    const out = smokeRuntimeErrors({ success: false, pageErrors: ['x.getTexture is not a function'], errors: [nan, 'x.getTexture is not a function', nan] });
    expect(out).toEqual(['x.getTexture is not a function', nan]);
  });
  it('reads console errors from a render that succeeded', () => {
    expect(smokeRuntimeErrors({ success: true, pageErrors: [], errors: ['boom'] })).toEqual(['boom']);
  });
  it('leaves infrastructure failures (no uncaught throw) out of the repair', () => {
    expect(smokeRuntimeErrors({ success: false, pageErrors: [], errors: ['RENDER_TIMEOUT'] })).toEqual([]);
  });
});
