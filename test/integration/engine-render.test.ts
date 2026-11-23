import { afterAll, describe, expect, it } from 'vitest';
import { HeadlessRenderer } from '../../src/render/HeadlessRenderer.js';
import { analyzeScreenshotBuffer } from '../../src/render/DecodedImageVisibility.js';
import { renderNbeFromChoice, validateNbeSettings } from '../../src/generators/nbe/NbeSettings.js';

const EMBERS = { palette: ['#05030f', '#2a0f5c', '#b0306a', '#ffb347'], layout: 'ring', emitters: 5,
  fieldScale: 2.4, fieldLayers: 5, flow: 1.8, swirl: 0.8, speed: 1.4, persistence: 0.99, glow: 0.9, seed: 7,
  reason: 'A ring of embers wants warm colour and tight vortices.' };
const HORIZON = { palette: ['#000814', '#003566', '#00b4d8', '#e0fbfc'], layout: 'line', emitters: 3,
  fieldScale: 0.6, fieldLayers: 3, flow: 0.7, swirl: 0.1, speed: 0.5, persistence: 0.97, glow: 0.3, seed: 99,
  reason: 'A calm horizon needs slow wide currents in cold blues.' };

describe('engine pages through the real capture path', () => {
  const renderer = new HeadlessRenderer();
  afterAll(async () => { await renderer.close(); });
  const opts = { domain: 'nbe' as const, width: 480, height: 300, timeout: 30_000, networkPolicy: 'isolated' as const };

  it('nbe: ready fires, frames are not blank, move over time, and differ per prompt', async () => {
    const embers = await renderer.render(renderNbeFromChoice('embers', validateNbeSettings(EMBERS)), opts);
    const horizon = await renderer.render(renderNbeFromChoice('horizon', validateNbeSettings(HORIZON)), opts);
    for (const r of [embers, horizon]) {
      expect(r.success, r.error).toBe(true);
      expect(r.errors).toEqual([]);
      expect((await analyzeScreenshotBuffer(r.lateScreenshot!.buffer)).hasVisibleContent).toBe(true);
      expect(r.screenshot!.buffer.equals(r.lateScreenshot!.buffer)).toBe(false);
    }
    expect(embers.lateScreenshot!.buffer.equals(horizon.lateScreenshot!.buffer)).toBe(false);
  }, 90_000);

  it('a failing engine fails the render loudly, naming the engine', async () => {
    const html = renderNbeFromChoice('boom', validateNbeSettings(EMBERS))
      .replace("var ctx = canvas.getContext('2d');", "var ctx = null;");
    const r = await renderer.render(html, opts);
    expect(r.success).toBe(false);
    expect(r.error).toContain('ENGINE_FAILED:nbe');
  }, 60_000);

  it('an engine that never gets ready fails as ENGINE_NOT_READY naming the engine', async () => {
    const html = renderNbeFromChoice('slow', validateNbeSettings(EMBERS))
      .replace('var CONVERGENCE_STEPS = 360;', 'var CONVERGENCE_STEPS = 99999999;');
    const r = await renderer.render(html, { ...opts, timeout: 4_000 });
    expect(r.success).toBe(false);
    expect(r.error).toContain('ENGINE_NOT_READY:nbe');
  }, 60_000);
});
