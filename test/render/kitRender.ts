import { HeadlessRenderer, type RenderOptions } from '../../src/render/HeadlessRenderer.js';
import { HTMLWrapper } from '../../src/utils/htmlWrapper.js';
import { analyzeScreenshotBuffer } from '../../src/render/DecodedImageVisibility.js';

/** Wrap a generated-style piece the way production does (libraries declared),
 * then render it through the real HeadlessRenderer and judge the frames. */
export async function renderKitPiece(code: string, domain: 'three' | 'p5' | 'html' | 'custom' | 'glsl' | 'hydra', libraries: string[], opts: RenderOptions = {}) {
  const renderer = new HeadlessRenderer();
  try {
    const wrapped = domain === 'glsl' ? code : HTMLWrapper.wrap(code, { domain: domain === 'custom' ? 'custom' : domain, libraries } as never);
    const result = await renderer.render(wrapped, {
      domain, width: 640, height: 360, stabilizationTime: 800, timeout: 30_000, networkPolicy: 'isolated', ...opts,
    });
    const shot = result.screenshot?.success ? result.screenshot.buffer : undefined;
    const analysis = shot ? await analyzeScreenshotBuffer(shot) : undefined;
    return { result, analysis, shot };
  } finally {
    await renderer.close();
  }
}
