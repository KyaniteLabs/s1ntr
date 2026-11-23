import { afterAll, expect, it } from 'vitest';
import { HeadlessRenderer } from '../../src/render/HeadlessRenderer.js';

// Real-browser gate (Sol G15): an NBE frame is captured only after the page posts nbe:converged.
const renderer = new HeadlessRenderer();
afterAll(async () => { await renderer.close(); });

const page = (script: string) => `<!doctype html><html><body style="margin:0;background:#000"><canvas id="c" width="200" height="120"></canvas><script>${script}</script></body></html>`;
const PAINT = `const x=document.getElementById('c').getContext('2d');x.fillStyle='#ff0000';x.fillRect(0,0,200,120);`;

it('waits for a delayed convergence and captures the evolved frame, not the blank one', async () => {
  const html = page(`setTimeout(function(){${PAINT}window.postMessage('nbe:converged','*');},1500);`);
  const out = await renderer.render(html, { domain: 'nbe', width: 200, height: 120, stabilizationTime: 200, timeout: 20000 });
  expect(out.errors).toEqual([]);
  expect(out.success).toBe(true);
  const sharp = (await import('sharp')).default;
  const { data } = await sharp(out.screenshot!.buffer).removeAlpha().raw().extract({ left: 100, top: 60, width: 1, height: 1 }).toBuffer({ resolveWithObject: true });
  expect([data[0] > 200, data[1] < 40, data[2] < 40]).toEqual([true, true, true]);
}, 60000);

it('fails explicitly when the page never posts nbe:converged', async () => {
  const out = await renderer.render(page(PAINT), { domain: 'nbe', width: 200, height: 120, stabilizationTime: 200, timeout: 20000, nbeConvergenceTimeoutMs: 1500 });
  expect(out.success).toBe(false);
  expect(out.error).toContain('nbe:converged');
}, 60000);
