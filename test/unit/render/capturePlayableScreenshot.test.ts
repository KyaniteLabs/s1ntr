import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  launch: vi.fn(), resolve: vi.fn(), close: vi.fn(), goto: vi.fn(),
  screenshot: vi.fn(), wait: vi.fn(), on: vi.fn(), newPage: vi.fn(), route: vi.fn(),
}));
vi.mock('playwright', () => ({ chromium: { launch: mocks.launch } }));
vi.mock('../../../src/utils/browserAssetFallbacks.js', () => ({ resolveChromiumExecutablePath: mocks.resolve }));
vi.mock('../../../src/utils/vendorAssets.js', () => ({
  isVendorAssetPath: (path: string) => [
    '/vendor/hydra-synth/1.3.10/hydra-synth.js',
    '/vendor/strudel-web/1.3.0/assets/clockworker-ZDiUtESR.js',
  ].includes(path),
  readVendorAsset: vi.fn().mockResolvedValue('pinned Hydra bytes'),
}));
import { capturePlayableScreenshot } from '../../../src/render/capturePlayableScreenshot.js';
import { readVendorAsset } from '../../../src/utils/vendorAssets.js';

describe('playable screenshot ownership and failure handling', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(readVendorAsset).mockResolvedValue('pinned Hydra bytes');
    mocks.resolve.mockReturnValue('/browser');
    mocks.launch.mockResolvedValue({ newPage: mocks.newPage, close: mocks.close });
    mocks.newPage.mockResolvedValue({ goto: mocks.goto, route: mocks.route, screenshot: mocks.screenshot,
      waitForTimeout: mocks.wait, on: mocks.on });
  });
  it('encodes artifact filenames and closes its browser after capture', async () => {
    await capturePlayableScreenshot('/tmp/art #1/playable.html', '/tmp/shot.png');
    expect(mocks.goto).toHaveBeenCalledWith('file:///tmp/art%20%231/playable.html',
      expect.objectContaining({ timeout: 15_000 }));
    expect(mocks.screenshot).toHaveBeenCalledWith({ path: '/tmp/shot.png', timeout: 60_000 });
    expect(mocks.close).toHaveBeenCalledOnce();
  });
  it('serves a pinned vendor script to a file artifact and blocks unknown vendor paths', async () => {
    await capturePlayableScreenshot('/tmp/page.html', '/tmp/shot.png');
    expect(mocks.route).toHaveBeenCalledWith('file:///vendor/**', expect.any(Function));
    const handler = mocks.route.mock.calls[0]![1];
    const fulfill = vi.fn(); const abort = vi.fn();
    await handler({ request: () => ({ url: () => 'file:///vendor/hydra-synth/1.3.10/hydra-synth.js' }), fulfill, abort });
    expect(fulfill).toHaveBeenCalledWith(expect.objectContaining({ body: 'pinned Hydra bytes' }));
    await handler({ request: () => ({ url: () => 'file:///vendor/strudel-web/1.3.0/assets/clockworker-ZDiUtESR.js' }), fulfill, abort });
    expect(fulfill).toHaveBeenCalledTimes(2);
    await handler({ request: () => ({ url: () => 'file:///vendor/unknown.js' }), fulfill, abort });
    expect(abort).toHaveBeenCalledWith('blockedbyclient');
  });
  it.each(['navigation', 'screenshot'])('closes after %s failure without leaking browser error text', async stage => {
    mocks[stage === 'navigation' ? 'goto' : 'screenshot'].mockRejectedValue(new Error('secret page URL'));
    await expect(capturePlayableScreenshot('/tmp/page.html', '/tmp/shot.png'))
      .rejects.toThrow(`SCORE_CAPTURE_FAILED: ${stage}`);
    expect(mocks.close).toHaveBeenCalledOnce();
  });
  it('L3-16: a screenshot deadline is a typed timeout, a plain browser failure is not', async () => {
    mocks.screenshot.mockRejectedValueOnce(Object.assign(new Error('Timeout 60000ms exceeded'), { name: 'TimeoutError' }));
    await expect(capturePlayableScreenshot('/tmp/page.html', '/tmp/shot.png')).rejects.toMatchObject({
      message: 'SCORE_CAPTURE_FAILED: screenshot (timeout)', stage: 'screenshot', timedOut: true });
    mocks.screenshot.mockRejectedValueOnce(new Error('Target closed'));
    await expect(capturePlayableScreenshot('/tmp/page.html', '/tmp/shot.png')).rejects.toMatchObject({
      message: 'SCORE_CAPTURE_FAILED: screenshot', timedOut: false });
  });
  it('launches sandboxed unless the container opt-out is set', async () => {
    const saved = process.env.LIMINAL_DISABLE_SANDBOX;
    try {
      delete process.env.LIMINAL_DISABLE_SANDBOX;
      await capturePlayableScreenshot('/tmp/page.html', '/tmp/shot.png');
      expect(mocks.launch.mock.calls[0]![0].args).toEqual(['--use-angle=swiftshader', '--enable-unsafe-swiftshader']);
      process.env.LIMINAL_DISABLE_SANDBOX = 'true';
      await capturePlayableScreenshot('/tmp/page.html', '/tmp/shot.png');
      expect(mocks.launch.mock.calls[1]![0].args).toEqual(['--no-sandbox', '--disable-setuid-sandbox',
        '--use-angle=swiftshader', '--enable-unsafe-swiftshader']);
    } finally {
      if (saved === undefined) delete process.env.LIMINAL_DISABLE_SANDBOX; else process.env.LIMINAL_DISABLE_SANDBOX = saved;
    }
  });
  it('fails closed if no browser is installed', async () => {
    mocks.resolve.mockReturnValue(undefined);
    await expect(capturePlayableScreenshot('/tmp/page.html', '/tmp/shot.png'))
      .rejects.toThrow('SCORE_CAPTURE_FAILED: browser unavailable');
    expect(mocks.launch).not.toHaveBeenCalled();
  });
});
