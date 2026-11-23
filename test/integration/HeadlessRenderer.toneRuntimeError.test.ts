import { afterAll, expect, it } from 'vitest';
import { HeadlessRenderer } from '../../src/render/HeadlessRenderer.js';

// #1760, replayed for real: ds0731 / v16-rain-drone wired `noiseGain.connect(noise)`.
// A Noise source has no input, so Tone throws inside the piece, the tone shell
// catches it, and the page makes no sound. Real Chromium, real Tone, real shell.
const RAIN_DRONE = `
const master = new Tone.Gain(0.7).toDestination();
const noise = new Tone.Noise({ type: "pink" }).connect(new Tone.Filter({
  type: "bandpass", frequency: 2500, Q: 0.7 }).connect(master));
const noiseGain = new Tone.Gain(0.12).connect(noise);
`;

const renderer = new HeadlessRenderer();
afterAll(async () => { await renderer.close?.(); });

it('leads the silent-audio failure with the artwork runtime error', async () => {
  const result = await renderer.render(RAIN_DRONE, { domain: 'tone', waitForStabilization: false });

  expect(result.audio?.success).toBe(false);
  expect(result.audio?.error).toMatch(/Cannot connect to node with no inputs/);
  expect(result.audio?.error).toMatch(/No audio captured during render window/);
  expect(result.audio!.error!.indexOf('Cannot connect')).toBeLessThan(result.audio!.error!.indexOf('No audio captured'));
  // generateExitDecision prints errors.find(nonblank): the cause must be first.
  expect(result.errors.find(e => e.trim())).toMatch(/Cannot connect to node with no inputs/);
}, 120_000);
