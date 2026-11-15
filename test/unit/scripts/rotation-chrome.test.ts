import { describe, expect, it } from 'vitest';
import {
  ensureRotationBrowserEnv,
  puppeteerLaunchOptions,
  resolveChromeExecutable,
} from '../../../scripts/rotation/chrome.mjs';

describe('rotation chrome.mjs (F23)', () => {
  it('sets purge-resistant cache dirs when unset', () => {
    const env: NodeJS.ProcessEnv = {};
    ensureRotationBrowserEnv(env);
    expect(env.PUPPETEER_CACHE_DIR).toMatch(/\.sinter[/\\]browsers[/\\]puppeteer$/);
    expect(env.PLAYWRIGHT_BROWSERS_PATH).toMatch(/\.sinter[/\\]browsers[/\\]playwright$/);
  });

  it('does not overwrite existing env paths', () => {
    const env: NodeJS.ProcessEnv = {
      PUPPETEER_CACHE_DIR: '/tmp/p',
      PLAYWRIGHT_BROWSERS_PATH: '/tmp/w',
    };
    ensureRotationBrowserEnv(env);
    expect(env.PUPPETEER_CACHE_DIR).toBe('/tmp/p');
    expect(env.PLAYWRIGHT_BROWSERS_PATH).toBe('/tmp/w');
  });

  it('resolves explicit PUPPETEER_EXECUTABLE_PATH when present', () => {
    // Use this test file as a stand-in path that exists
    const self = new URL(import.meta.url).pathname;
    const env: NodeJS.ProcessEnv = {
      PUPPETEER_EXECUTABLE_PATH: self,
    };
    expect(resolveChromeExecutable(env)).toBe(self);
  });

  it('puppeteerLaunchOptions includes executablePath when resolvable', () => {
    const self = new URL(import.meta.url).pathname;
    const prev = process.env.PUPPETEER_EXECUTABLE_PATH;
    process.env.PUPPETEER_EXECUTABLE_PATH = self;
    try {
      const opts = puppeteerLaunchOptions({ args: ['--no-sandbox'] });
      expect(opts.headless).toBe('new');
      expect(opts.executablePath).toBe(self);
      expect(opts.args).toContain('--no-sandbox');
    } finally {
      if (prev == null) delete process.env.PUPPETEER_EXECUTABLE_PATH;
      else process.env.PUPPETEER_EXECUTABLE_PATH = prev;
    }
  });
});
