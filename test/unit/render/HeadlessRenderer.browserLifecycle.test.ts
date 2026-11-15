import { afterEach, describe, expect, it, vi } from 'vitest';

const { launch } = vi.hoisted(() => ({ launch: vi.fn() }));

vi.mock('playwright', () => ({ chromium: { launch } }));
vi.mock('../../../src/utils/browserAssetFallbacks.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  resolveChromiumExecutablePath: () => '/usr/bin/chromium',
}));

import { HeadlessRenderer } from '../../../src/render/HeadlessRenderer.js';

function fakeBrowser() {
  const context = { close: vi.fn().mockResolvedValue(undefined) };
  return {
    context,
    browser: {
      version: () => '1.0',
      newContext: vi.fn().mockResolvedValue(context),
      close: vi.fn().mockResolvedValue(undefined),
    },
  };
}

describe('HeadlessRenderer browser lifecycle', () => {
  afterEach(() => { launch.mockReset(); });

  it('launches a single browser when initialize() is called concurrently', async () => {
    const { browser } = fakeBrowser();
    launch.mockResolvedValue(browser);
    const renderer = new (HeadlessRenderer as unknown as new () => HeadlessRenderer)();
    await Promise.all([renderer.initialize(), renderer.initialize(), renderer.initialize()]);
    expect(launch).toHaveBeenCalledTimes(1);
    expect(browser.newContext).toHaveBeenCalledTimes(1);
    await renderer.close();
    expect(browser.close).toHaveBeenCalledTimes(1);
  });

  it('closes the browser launched by an initialize() still in flight', async () => {
    const { browser, context } = fakeBrowser();
    launch.mockResolvedValue(browser);
    const renderer = new (HeadlessRenderer as unknown as new () => HeadlessRenderer)();
    const init = renderer.initialize();
    await renderer.close();
    await init;
    expect(context.close).toHaveBeenCalledTimes(1);
    expect(browser.close).toHaveBeenCalledTimes(1);
  });

  it('lets a failed launch be retried', async () => {
    launch.mockRejectedValueOnce(new Error('spawn failed'));
    const renderer = new (HeadlessRenderer as unknown as new () => HeadlessRenderer)();
    await expect(renderer.initialize()).rejects.toThrow('Failed to initialize headless browser: spawn failed');
    const { browser } = fakeBrowser();
    launch.mockResolvedValueOnce(browser);
    await renderer.initialize();
    expect(launch).toHaveBeenCalledTimes(2);
    await renderer.close();
    expect(browser.close).toHaveBeenCalledTimes(1);
  });
});
