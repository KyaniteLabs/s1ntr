import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const pw = vi.hoisted(() => ({
  launchError: undefined as Error | undefined,
  controlSelector: true as boolean,
  fallbackControl: false as boolean,
  statuses: [] as boolean[],
  events: 0,
  clicks: 0,
  closed: 0,
  content: '' as string,
  launchArgs: undefined as unknown,
}));

vi.mock('playwright', () => {
  const control = { click: async () => { pw.clicks++; } };
  const page = {
    setContent: async (html: string) => { pw.content = html; },
    waitForSelector: async () => (pw.controlSelector ? control : Promise.reject(new Error('timeout'))),
    $: async () => (pw.fallbackControl ? control : null),
    evaluate: async (fn: () => unknown) => {
      const src = String(fn);
      if (src.includes('booting')) return pw.statuses.shift() ?? false;
      return pw.events;
    },
    waitForTimeout: async () => undefined,
    waitForFunction: async () => undefined,
  };
  const browser = { newPage: async () => page, close: async () => { pw.closed++; } };
  return { chromium: { launch: async (opts: unknown) => {
    pw.launchArgs = opts;
    if (pw.launchError) throw pw.launchError;
    return browser;
  } } };
});
vi.mock('../../../src/utils/browserAssetFallbacks.js', () => ({ resolveChromiumExecutablePath: () => '/fake/chrome' }));
vi.mock('../../../src/utils/vendorAssets.js', () => ({ inlineVendorAssets: async (h: string) => h.replace('/vendor/x.js', 'INLINED') }));
vi.mock('../../../src/render/HeadlessRenderer.js', () => ({ audioCapturePageInit: function shim() { /* marker */ } }));

import { probeAudio } from '../../../src/atelier/AudioProbe.js';
import { musicRuntimeScript } from '../../../src/core/wrappers/musicRuntime.js';

let file: string;
beforeEach(() => {
  Object.assign(pw, { launchError: undefined, controlSelector: true, fallbackControl: false, statuses: [], events: 0, clicks: 0, closed: 0, content: '', launchArgs: undefined });
  file = join(mkdtempSync(join(tmpdir(), 'audio-probe-')), 'piece.html');
  writeFileSync(file, '<html><script src="/vendor/x.js"></script></html>');
});

describe('probeAudio', () => {
  it('injects the shared music runtime before the capture init, like the renderer', async () => {
    pw.events = 1;
    await probeAudio(file);
    const runtimeAt = pw.content.indexOf(musicRuntimeScript());
    expect(runtimeAt).toBeGreaterThan(-1);
    expect(runtimeAt).toBeLessThan(pw.content.indexOf('marker'));
    expect(runtimeAt).toBeLessThan(pw.content.indexOf('INLINED'));
  });

  it('clicks play once and reports the audio source starts', async () => {
    pw.events = 3;
    expect(await probeAudio(file)).toEqual({ events: 3, clicked: true });
    expect(pw.clicks).toBe(1);
    expect(pw.closed).toBe(1);
    const launch = pw.launchArgs as { executablePath: string; args: string[] };
    expect(launch.executablePath).toBe('/fake/chrome');
    expect(launch.args).toContain('--autoplay-policy=no-user-gesture-required');
  });

  it('prepends the audio patch and page shim, and inlines vendor assets', async () => {
    await probeAudio(file);
    expect(pw.content.startsWith('<script>')).toBe(true);
    expect(pw.content).toContain('window.__sinterAudioEvents = 0');
    expect(pw.content).toContain('function shim()');
    expect(pw.content).toContain('INLINED');
    expect(pw.content).not.toContain('/vendor/x.js');
  });

  it('re-clicks while the shell reports booting, up to the first settled status', async () => {
    pw.statuses = [true, true, false];
    pw.events = 1;
    expect(await probeAudio(file)).toEqual({ events: 1, clicked: true });
    expect(pw.clicks).toBe(3);
  });

  it('gives up re-clicking after four attempts', async () => {
    pw.statuses = [true, true, true, true, true];
    await probeAudio(file);
    expect(pw.clicks).toBe(4);
  });

  it('falls back to a text-matched button when the id selectors time out', async () => {
    pw.controlSelector = false;
    pw.fallbackControl = true;
    pw.events = 2;
    expect(await probeAudio(file)).toEqual({ events: 2, clicked: true });
  });

  it('reports NO_PLAY_CONTROL and still closes the browser', async () => {
    pw.controlSelector = false;
    expect(await probeAudio(file)).toEqual({ events: 0, clicked: false, error: 'NO_PLAY_CONTROL' });
    expect(pw.clicks).toBe(0);
    expect(pw.closed).toBe(1);
  });

  it('returns the launch error instead of throwing', async () => {
    pw.launchError = new Error('no chromium');
    expect(await probeAudio(file)).toEqual({ events: 0, clicked: false, error: 'no chromium' });
    expect(pw.closed).toBe(0);
  });

  it('returns an error when the html file cannot be read, closing the browser', async () => {
    const res = await probeAudio(join(file, 'missing.html'));
    expect(res.events).toBe(0);
    expect(res.clicked).toBe(false);
    expect(res.error).toMatch(/ENOENT|ENOTDIR/);
    expect(pw.closed).toBe(1);
  });
});
