/**
 * Sol L3-09 (HyperFrames half): the preview shell around a composition is always visible, so its pixels prove nothing.
 * Real browser, real renderer: two compositions in the IDENTICAL shell and timeline script; only the one whose stage
 * paints may report a clean render. `generate --domain hyperframes` is no longer offered, so this drives the renderer
 * that VideoPipeline / Exporter still use.
 */
import { afterAll, describe, expect, it, vi } from 'vitest';
import { HeadlessRenderer } from '../../src/render/HeadlessRenderer.js';

vi.setConfig({ testTimeout: 180_000 });

const HF = (stage: string, rootStyle = '') => `<!doctype html><html><head><meta charset="utf-8"><title>hf</title>
<script src="/vendor/gsap/3.15.0/gsap.min.js"></script></head>
<body style="margin:0"><div id="root" data-composition-id="demo" data-width="1280" data-height="720" data-start="0" data-duration="4"
 style="position:relative;width:1280px;height:720px;${rootStyle}">${stage}</div>
<script>window.__timelines = window.__timelines || {};
const tl = gsap.timeline({ paused: true });
tl.to('#orb', { x: 400, duration: 2 }, 0);
window.__timelines['demo'] = tl;</script></body></html>`;
const HF_WORKING = HF(`<div id="orb" class="clip" data-start="0" data-duration="4"
 style="position:absolute;left:100px;top:200px;width:240px;height:240px;border-radius:50%;background:#f0a030"></div>
<div class="clip" data-start="0" data-duration="4" style="position:absolute;inset:0;background:#102040;z-index:-1"></div>`);
// Same shell, same timeline script, but the stage holds nothing that paints.
const HF_EMPTY = HF(`<div id="orb" class="clip" data-start="0" data-duration="4"></div>`);


afterAll(async () => { await HeadlessRenderer.getInstance().close(); });

describe('HyperFrames stage attestation', () => {
  it('a composition whose stage paints renders cleanly', async () => {
    const ev = await HeadlessRenderer.getInstance().render(HF_WORKING, { domain: 'hyperframes' });
    expect(ev.success, ev.errors.join('\n')).toBe(true);
    expect(ev.logs.join('\n')).toContain('[hyperframes] stage paint: visible');
  });
  it('accepts pixels painted only by the composition root', async () => {
    const ev = await HeadlessRenderer.getInstance().render(
      HF('<div id="orb"></div>', 'background:#203016'), { domain: 'hyperframes' });
    expect(ev.success, ev.errors.join('\n')).toBe(true);
    expect(ev.logs).toContain('[hyperframes] stage paint: visible');
  });
  it('checks only the visible viewport when the stage is far taller than the page', async () => {
    const tall = HF_WORKING.replace('data-height="720"', 'data-height="120000"');
    const ev = await HeadlessRenderer.getInstance().render(tall, { domain: 'hyperframes' });
    expect(ev.success, ev.errors.join('\n')).toBe(true);
    expect(ev.logs).toContain('[hyperframes] stage paint: visible');
  });
  it('rejects a blank canvas with a visible element box', async () => {
    const ev = await HeadlessRenderer.getInstance().render(
      HF('<canvas id="orb" width="300" height="150"></canvas>'), { domain: 'hyperframes' });
    expect(ev.success).toBe(false);
    expect(ev.errors.join('\n')).toContain('HYPERFRAMES_STAGE_EMPTY');
  });
  it('fails closed when the preview cannot identify the composition root', async () => {
    const missing = HF_WORKING.replace('data-composition-id="demo"', '');
    const ev = await HeadlessRenderer.getInstance().render(missing, { domain: 'hyperframes' });
    expect(ev.success).toBe(false);
    expect(ev.errors.join('\n')).toContain('HYPERFRAMES_STAGE_UNVERIFIED');
  });
  it('an empty stage under the identical shell is reported as HYPERFRAMES_STAGE_EMPTY', async () => {
    const ev = await HeadlessRenderer.getInstance().render(HF_EMPTY, { domain: 'hyperframes' });
    expect(ev.errors.join('\n')).toMatch(/HYPERFRAMES_STAGE_EMPTY/);
  });
});
