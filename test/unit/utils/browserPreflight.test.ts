/**
 * F9 browser preflight — no real downloads.
 * Covers: env defaults + override, install inject (ok/fail/offline), disk sentinel.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  __resetBrowserPreflightForTests,
  chromiumLaunchOptions,
  ensurePurgeResistantBrowserEnv,
  defaultPlaywrightBrowsersPath,
  defaultPuppeteerCacheDir,
  attemptBrowserInstallOnce,
  checkDiskPressureOnce,
  probeDiskPressure,
  missingChromiumError,
  preflightChromiumExecutablePath,
  DISK_PRESSURE_FREE_RATIO,
  type BrowserInstallResult,
  type DiskPressureFinding,
} from '../../../src/utils/browserPreflight.js';
import {
  resolveChromiumExecutablePath,
  resolveChromiumExecutablePathLookup,
} from '../../../src/utils/browserAssetFallbacks.js';

describe('chromiumLaunchOptions', () => {
  it('passes the CI Chromium override to Playwright', () => {
    expect(chromiumLaunchOptions({
      PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH: '/usr/bin/chromium',
    })).toEqual({
      headless: true,
      executablePath: '/usr/bin/chromium',
    });
  });

  it('omits an empty override so Playwright can resolve its managed browser', () => {
    expect(chromiumLaunchOptions({
      PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH: '  ',
    })).toEqual({ headless: true });
  });

  it('pins a durable managed executable for direct Playwright launches', () => {
    expect(chromiumLaunchOptions({}, () => '/durable/chrome-headless-shell')).toEqual({
      headless: true,
      executablePath: '/durable/chrome-headless-shell',
    });
  });
});

const SAVED = {
  PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH,
  PUPPETEER_CACHE_DIR: process.env.PUPPETEER_CACHE_DIR,
  PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
  LIMINAL_ALLOW_BROWSER_INSTALL: process.env.LIMINAL_ALLOW_BROWSER_INSTALL,
  LIMINAL_SKIP_BROWSER_INSTALL: process.env.LIMINAL_SKIP_BROWSER_INSTALL,
  LIMINAL_CI_FAST: process.env.LIMINAL_CI_FAST,
};

function restoreEnv(): void {
  for (const [k, v] of Object.entries(SAVED)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

beforeEach(() => {
  __resetBrowserPreflightForTests();
  delete process.env.PLAYWRIGHT_BROWSERS_PATH;
  delete process.env.PUPPETEER_CACHE_DIR;
  delete process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
  delete process.env.LIMINAL_ALLOW_BROWSER_INSTALL;
  // Keep CI-fast/vitest skip behavior for accidental default installer; tests inject.
  process.env.LIMINAL_SKIP_BROWSER_INSTALL = '1';
});

afterEach(() => {
  __resetBrowserPreflightForTests();
  restoreEnv();
});

describe('ensurePurgeResistantBrowserEnv', () => {
  it('defaults PLAYWRIGHT_BROWSERS_PATH and PUPPETEER_CACHE_DIR under ~/.sinter/browsers', () => {
    const home = mkdtempSync(join(tmpdir(), 'sinter-browsers-'));
    try {
      const env: NodeJS.ProcessEnv = {};
      const result = ensurePurgeResistantBrowserEnv(env, { home, mkdir: true });

      expect(result.playwrightPath).toBe(defaultPlaywrightBrowsersPath(home));
      expect(result.puppeteerPath).toBe(defaultPuppeteerCacheDir(home));
      expect(env.PLAYWRIGHT_BROWSERS_PATH).toBe(result.playwrightPath);
      expect(env.PUPPETEER_CACHE_DIR).toBe(result.puppeteerPath);
      expect(result.playwrightPath).toBe(join(home, 'playwright'));
      expect(result.puppeteerPath).toBe(join(home, 'puppeteer'));
      expect(result.playwrightPath).not.toMatch(/Caches|\.cache[/\\]puppeteer/);
      expect(result.puppeteerPath).not.toMatch(/Caches/);
      // Production default (no home override) is under ~/.sinter/browsers
      expect(defaultPlaywrightBrowsersPath()).toMatch(/\.sinter[/\\]browsers[/\\]playwright$/);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('respects explicit PLAYWRIGHT_BROWSERS_PATH and PUPPETEER_CACHE_DIR overrides', () => {
    const home = mkdtempSync(join(tmpdir(), 'sinter-browsers-'));
    const customPw = join(home, 'custom-pw');
    const customPup = join(home, 'custom-pup');
    try {
      const env: NodeJS.ProcessEnv = {
        PLAYWRIGHT_BROWSERS_PATH: customPw,
        PUPPETEER_CACHE_DIR: customPup,
      };
      const result = ensurePurgeResistantBrowserEnv(env, { home, mkdir: true });

      expect(result.playwrightPath).toBe(customPw);
      expect(result.puppeteerPath).toBe(customPup);
      expect(env.PLAYWRIGHT_BROWSERS_PATH).toBe(customPw);
      expect(env.PUPPETEER_CACHE_DIR).toBe(customPup);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('attemptBrowserInstallOnce (injected installer)', () => {
  it('succeeds once and does not call installer a second time', () => {
    const calls: string[] = [];
    const installer = (kind: 'playwright-chromium' | 'puppeteer-chrome'): BrowserInstallResult => {
      calls.push(kind);
      return { ok: true, message: 'ok', kind };
    };
    const stderr: string[] = [];

    const first = attemptBrowserInstallOnce('playwright-chromium', {
      installer,
      forceInstallAttempt: true,
      stderrWrite: (c) => stderr.push(c),
    });
    const second = attemptBrowserInstallOnce('playwright-chromium', {
      installer,
      stderrWrite: (c) => stderr.push(c),
    });

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(calls).toEqual(['playwright-chromium']); // once only
    expect(stderr.some((l) => l.includes('one-shot install'))).toBe(true);
  });

  it('failure surfaces ok:false with installer message (loud path material)', () => {
    const installer = (): BrowserInstallResult => ({
      ok: false,
      message: 'ENOSPC disk full',
      kind: 'playwright-chromium',
    });
    const result = attemptBrowserInstallOnce('playwright-chromium', {
      installer,
      forceInstallAttempt: true,
      stderrWrite: () => {},
    });
    expect(result.ok).toBe(false);
    expect(result.message).toBe('ENOSPC disk full');

    const err = missingChromiumError({ installResult: result, browsersPath: '/tmp/x' });
    expect(err.message).toMatch(/FATAL: Chromium executable not found/);
    expect(err.message).toMatch(/ENOSPC disk full/);
    expect(err.message).toMatch(/playwright install chromium/);
    expect(err.message).toMatch(/browser-home\.md/);
  });

  it('offline/unavailable gap flags offlineOrUnavailable and error names the gap', () => {
    const installer = (): BrowserInstallResult => ({
      ok: false,
      offlineOrUnavailable: true,
      message: 'getaddrinfo ENOTFOUND',
      kind: 'puppeteer-chrome',
    });
    const result = attemptBrowserInstallOnce('puppeteer-chrome', {
      installer,
      forceInstallAttempt: true,
      stderrWrite: () => {},
    });
    expect(result.offlineOrUnavailable).toBe(true);

    const err = missingChromiumError({ installResult: result });
    expect(err.message).toMatch(/offline|Network/i);
    expect(err.message).toMatch(/getaddrinfo ENOTFOUND/);
  });
});

describe('disk-pressure sentinel', () => {
  it('probeDiskPressure returns structured free ratio when statfs works', () => {
    const finding = probeDiskPressure(process.cwd(), DISK_PRESSURE_FREE_RATIO);
    // May be null only if statfs unavailable; on this host it should work.
    if (finding) {
      expect(finding.totalBytes).toBeGreaterThan(0);
      expect(finding.freeRatio).toBeGreaterThanOrEqual(0);
      expect(finding.freeRatio).toBeLessThanOrEqual(1);
      expect(finding.underPressure === true || finding.underPressure === false).toBe(true);
      if (finding.underPressure) {
        expect(finding.message).toMatch(/DISK PRESSURE/);
        expect(finding.message).toMatch(/\.sinter\/browsers/);
      }
    }
  });

  it('emits warning finding when free ratio is below 10% and does not throw', () => {
    const finding: DiskPressureFinding = {
      underPressure: true,
      path: '/volume',
      freeBytes: 5 * 1024 ** 3,
      totalBytes: 100 * 1024 ** 3,
      freeRatio: 0.05,
      freeGB: 5,
      freePct: 5,
      message:
        '[browser-preflight] DISK PRESSURE: volume for "/volume" has 5.0GB free (5.0% < 10%). ' +
        'macOS purges regenerable caches first',
    };
    const stderr: string[] = [];
    const recorded: DiskPressureFinding[] = [];

    const result = checkDiskPressureOnce({
      forceDiskCheck: true,
      diskProbe: () => finding,
      stderrWrite: (c) => stderr.push(c),
      recordFinding: (f) => recorded.push(f),
    });

    expect(result?.underPressure).toBe(true);
    expect(stderr[0]).toMatch(/DISK PRESSURE/);
    expect(stderr[0]).toMatch(/5\.0%/);
    expect(recorded).toHaveLength(1);
    expect(recorded[0].freePct).toBe(5);
  });

  it('does not warn when free ratio is above threshold', () => {
    const finding: DiskPressureFinding = {
      underPressure: false,
      path: '/volume',
      freeBytes: 50 * 1024 ** 3,
      totalBytes: 100 * 1024 ** 3,
      freeRatio: 0.5,
      freeGB: 50,
      freePct: 50,
      message: null,
    };
    const stderr: string[] = [];
    checkDiskPressureOnce({
      forceDiskCheck: true,
      diskProbe: () => finding,
      stderrWrite: (c) => stderr.push(c),
      recordFinding: () => {
        throw new Error('should not record');
      },
    });
    expect(stderr).toEqual([]);
  });

  it('threshold boundary: freeRatio 0.099 is under pressure, 0.10 is not', () => {
    const under = probeFromRatio(0.099);
    const at = probeFromRatio(0.10);
    expect(under.underPressure).toBe(true);
    expect(at.underPressure).toBe(false);
  });
});

function probeFromRatio(freeRatio: number): DiskPressureFinding {
  const totalBytes = 1000;
  const freeBytes = freeRatio * totalBytes;
  return {
    underPressure: freeRatio < DISK_PRESSURE_FREE_RATIO,
    path: '/x',
    freeBytes,
    totalBytes,
    freeRatio,
    freeGB: freeBytes / 1024 ** 3,
    freePct: freeRatio * 100,
    message: freeRatio < DISK_PRESSURE_FREE_RATIO ? 'warn' : null,
  };
}

describe('preflightChromiumExecutablePath', () => {
  it('returns path when resolve finds binary without calling installer', () => {
    const installer = vi.fn((): BrowserInstallResult => ({
      ok: true,
      message: 'should not run',
      kind: 'playwright-chromium',
    }));
    const path = preflightChromiumExecutablePath(() => '/usr/bin/chromium', {
      installer,
      throwIfMissing: true,
      stderrWrite: () => {},
      diskProbe: () => null,
    });
    expect(path).toBe('/usr/bin/chromium');
    expect(installer).not.toHaveBeenCalled();
  });

  it('install success then resolve success', () => {
    let present = false;
    const installer = (): BrowserInstallResult => {
      present = true;
      return { ok: true, message: 'installed', kind: 'playwright-chromium' };
    };
    const path = preflightChromiumExecutablePath(
      () => (present ? '/tmp/chromium-fake' : undefined),
      {
        installer,
        forceInstallAttempt: true,
        throwIfMissing: true,
        stderrWrite: () => {},
        diskProbe: () => null,
      },
    );
    expect(path).toBe('/tmp/chromium-fake');
  });

  it('install failure throws loud actionable error', () => {
    expect(() =>
      preflightChromiumExecutablePath(() => undefined, {
        installer: () => ({
          ok: false,
          message: 'spawn npx ENOENT',
          offlineOrUnavailable: true,
          kind: 'playwright-chromium',
        }),
        forceInstallAttempt: true,
        throwIfMissing: true,
        stderrWrite: () => {},
        diskProbe: () => null,
      }),
    ).toThrow(/FATAL: Chromium executable not found/);
  });
});

describe('resolveChromiumExecutablePath env + install wiring', () => {
  it('applies purge-resistant defaults when env unset', () => {
    delete process.env.PLAYWRIGHT_BROWSERS_PATH;
    delete process.env.PUPPETEER_CACHE_DIR;
    // skipInstall so we only exercise env defaults
    resolveChromiumExecutablePath({
      skipInstall: true,
      diskProbe: () => null,
      stderrWrite: () => {},
    });
    expect(process.env.PLAYWRIGHT_BROWSERS_PATH).toMatch(/\.sinter\/browsers\/playwright$/);
    expect(process.env.PUPPETEER_CACHE_DIR).toMatch(/\.sinter\/browsers\/puppeteer$/);
  });

  it('respects explicit PLAYWRIGHT_BROWSERS_PATH override during resolve', () => {
    const home = mkdtempSync(join(tmpdir(), 'pw-override-'));
    const chromiumDir = join(home, 'chromium-1234', 'chrome-linux');
    mkdirSync(chromiumDir, { recursive: true });
    const chromeBin = join(chromiumDir, 'chrome');
    writeFileSync(chromeBin, '#!/bin/sh\n');
    try {
      process.env.PLAYWRIGHT_BROWSERS_PATH = home;
      process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH = '';
      delete process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;

      const path = resolveChromiumExecutablePathLookup();
      expect(path).toBe(chromeBin);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('on miss, uses injected installer once then returns path if install planted binary', () => {
    // Use controlled resolve (not real playwright.executablePath) so a host
    // with leftover ~/Library/Caches/ms-playwright cannot short-circuit.
    const home = mkdtempSync(join(tmpdir(), 'pw-install-'));
    const chromiumDir = join(home, 'chromium-9999', 'chrome-linux');
    const chromeBin = join(chromiumDir, 'chrome');
    let planted = false;

    __resetBrowserPreflightForTests();
    const path = preflightChromiumExecutablePath(
      () => (planted ? chromeBin : undefined),
      {
        forceInstallAttempt: true,
        throwIfMissing: true,
        diskProbe: () => null,
        stderrWrite: () => {},
        installer: () => {
          mkdirSync(chromiumDir, { recursive: true });
          writeFileSync(chromeBin, '#!/bin/sh\n');
          planted = true;
          return { ok: true, message: 'planted', kind: 'playwright-chromium' };
        },
      },
    );

    expect(path).toBe(chromeBin);
    rmSync(home, { recursive: true, force: true });
  });
});
