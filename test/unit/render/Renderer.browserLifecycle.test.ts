import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { launch, makeBrowser } = vi.hoisted(() => {
  const makeBrowser = (id: string) => ({ id, close: vi.fn().mockResolvedValue(undefined), newPage: vi.fn() });
  return { launch: vi.fn(), makeBrowser };
});

vi.mock('puppeteer', () => ({ default: { launch } }));
vi.mock('../../../src/utils/browserAssetFallbacks.js', () => ({
  resolveChromiumExecutablePath: () => '/usr/bin/chromium',
  getLocalP5ScriptForUrl: () => null,
}));

import { Renderer } from '../../../src/render/Renderer.js';

type TestBrowser = ReturnType<typeof makeBrowser>;
const getBrowser = (): Promise<TestBrowser> =>
  (Renderer as unknown as { getBrowser(): Promise<TestBrowser> }).getBrowser();

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

describe('Renderer shared browser lifecycle', () => {
  beforeEach(async () => { launch.mockReset(); await Renderer.closeBrowser(); });
  afterEach(async () => { await Renderer.closeBrowser(); });

  it('launches one browser for concurrent callers and reuses it', async () => {
    const browser = makeBrowser('a');
    launch.mockResolvedValue(browser);
    const [first, second] = await Promise.all([getBrowser(), getBrowser()]);
    expect(first).toBe(browser);
    expect(second).toBe(browser);
    expect(await getBrowser()).toBe(browser);
    expect(launch).toHaveBeenCalledTimes(1);
  });

  it('closes a browser whose launch was still pending when closeBrowser ran', async () => {
    const pending = deferred<TestBrowser>();
    launch.mockReturnValueOnce(pending.promise);
    const caller = getBrowser();
    const closing = Renderer.closeBrowser();
    const browser = makeBrowser('late');
    pending.resolve(browser);
    await closing;
    await expect(caller).rejects.toThrow('RENDERER_BROWSER_CLOSED_DURING_LAUNCH');
    expect(browser.close).toHaveBeenCalledTimes(1);

    const fresh = makeBrowser('fresh');
    launch.mockResolvedValueOnce(fresh);
    expect(await getBrowser()).toBe(fresh);
  });

  it('does not hand out a browser that is being closed', async () => {
    const old = makeBrowser('old');
    const closeGate = deferred<undefined>();
    old.close.mockReturnValueOnce(closeGate.promise);
    launch.mockResolvedValueOnce(old);
    expect(await getBrowser()).toBe(old);

    const closing = Renderer.closeBrowser();
    const fresh = makeBrowser('fresh');
    launch.mockResolvedValueOnce(fresh);
    const next = getBrowser();
    closeGate.resolve(undefined);
    await closing;
    expect(await next).toBe(fresh);
  });

  it('clears a failed launch so the next call retries', async () => {
    launch.mockRejectedValueOnce(new Error('spawn failed'));
    await expect(getBrowser()).rejects.toThrow('spawn failed');
    const browser = makeBrowser('retry');
    launch.mockResolvedValueOnce(browser);
    expect(await getBrowser()).toBe(browser);
  });
});
