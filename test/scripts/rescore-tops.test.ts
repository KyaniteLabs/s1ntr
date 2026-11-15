import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { execSync } from 'child_process';
import { join } from 'path';
import { existsSync, mkdirSync, writeFileSync, rmSync, writeFileSync as writeSync } from 'fs';

// ---------------------------------------------------------------------------
// Test helper: build the project before running integration-style tests.
// ---------------------------------------------------------------------------
const REPO_ROOT = join(__dirname, '../..');
const FIXTURES_DIR = join(__dirname, 'fixtures/rescore');

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

// One SVG entry — SVG doesn't rely on canvas so it avoids the perception
// check that produces failureClass='render' for blank p5 canvases.
const ARCHIVE_SVG_ONE_ENTRY = JSON.stringify({
  archives: {
    svg: [
      {
        id: 'svg-entry-1',
        domain: 'svg',
        prompt: 'a simple svg circle',
        output: '<svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg"><circle cx="50" cy="50" r="40" fill="red"/></svg>',
        qualityScore: 0.8,
        metadata: {},
        createdAt: new Date().toISOString(),
      },
    ],
    p5: [], glsl: [], three: [], hydra: [], ascii: [], textgen: [], kinetic: [],
  },
});

// Empty archives — used for preflight-only tests.
const ARCHIVE_EMPTY = JSON.stringify({
  archives: { p5: [], glsl: [], three: [], hydra: [], svg: [], ascii: [], textgen: [], kinetic: [] },
});

beforeAll(() => {
  mkdirSync(FIXTURES_DIR, { recursive: true });
});

afterAll(() => {
  try { rmSync(FIXTURES_DIR, { recursive: true, force: true }); } catch { /* noop */ }
});

// ---------------------------------------------------------------------------
// Chromium preflight: explicit override (deterministic, no browser needed)
// ---------------------------------------------------------------------------

describe('rescore-tops preflight: chromium executable check', () => {
  it('exits non-zero with remediation hint when chromium binary is absent', () => {
    writeFileSync(join(FIXTURES_DIR, 'archive-empty.json'), ARCHIVE_EMPTY);

    const fakePath = '/tmp/this-browser-definitely-does-not-exist-rescore-test';
    const env = {
      ...process.env,
      QUALITY_ARCHIVE_PATH: join(FIXTURES_DIR, 'archive-empty.json'),
      PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH: fakePath,
    };

    let rc = 0;
    let stderr = '';
    try {
      execSync(
        `node "${join(REPO_ROOT, 'scripts/quality/rescore-tops.mjs')}" --domain p5`,
        {
          cwd: REPO_ROOT,
          encoding: 'utf-8',
          env,
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      );
    } catch (err: unknown) {
      const execErr = err as { status?: number; stderr?: string };
      rc = execErr.status ?? 1;
      stderr = execErr.stderr ?? '';
    }

    expect(rc).toBe(1);
    expect(stderr).toContain('FATAL');
    expect(stderr).toMatch(/PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH|FATAL.*chromium/i);
  });

  it('produces no JSON records when chromium is missing (clean abort)', () => {
    writeFileSync(join(FIXTURES_DIR, 'archive-empty.json'), ARCHIVE_EMPTY);

    const fakePath = '/tmp/this-browser-definitely-does-not-exist-rescore-test';
    const env = {
      ...process.env,
      QUALITY_ARCHIVE_PATH: join(FIXTURES_DIR, 'archive-empty.json'),
      PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH: fakePath,
    };

    let stdout = '';
    try {
      execSync(
        `node "${join(REPO_ROOT, 'scripts/quality/rescore-tops.mjs')}" --domain p5`,
        {
          cwd: REPO_ROOT,
          encoding: 'utf-8',
          env,
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      );
    } catch (err: unknown) {
      const execErr = err as { stdout?: string };
      stdout = execErr.stdout ?? '';
    }

    const lines = stdout.trim().split('\n').filter(Boolean);
    const jsonRecords = lines.filter((l) => {
      try { JSON.parse(l); return true; } catch { return false; }
    });
    expect(jsonRecords).toHaveLength(0);
  });

  it('preflight passes when PLAYWRIGHT_BROWSERS_PATH contains a chrome stub (fallback path)', () => {
    writeFileSync(join(FIXTURES_DIR, 'archive-empty.json'), ARCHIVE_EMPTY);

    // Create a minimal chromium stub directory structure that the fallback scan
    // will discover: PLAYWRIGHT_BROWSERS_PATH/chromium-1234/chrome-linux/chrome
    const stubDir = join(FIXTURES_DIR, 'pw-browsers-stub');
    const chromeDir = join(stubDir, 'chromium-1234', 'chrome-linux');
    mkdirSync(chromeDir, { recursive: true });
    // Write a tiny stub binary — it only needs to exist so existsSync returns true.
    // The preflight does NOT attempt to execute it; HeadlessRenderer does.
    writeSync(join(chromeDir, 'chrome'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });

    const env = {
      ...process.env,
      QUALITY_ARCHIVE_PATH: join(FIXTURES_DIR, 'archive-empty.json'),
      // Clear the override so the fallback scan is exercised.
      PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH: '',
      PLAYWRIGHT_BROWSERS_PATH: stubDir,
      // Force the archive to be empty so no scoring is attempted (which would
      // fail because the stub binary isn't a real browser). The preflight is
      // the only thing that runs and must succeed.
      SINTER_LLM_BASE_URL: 'http://127.0.0.1:1/unreachable',
    };

    let rc = 0;
    let stderr = '';
    try {
      execSync(
        `node "${join(REPO_ROOT, 'scripts/quality/rescore-tops.mjs')}" --domain p5`,
        {
          cwd: REPO_ROOT,
          encoding: 'utf-8',
          env,
          stdio: ['ignore', 'pipe', 'pipe'],
          timeout: 30_000,
        },
      );
    } catch (err: unknown) {
      const execErr = err as { status?: number; stderr?: string };
      rc = execErr.status ?? 1;
      stderr = execErr.stderr ?? '';
    }

    // Preflight must NOT abort with a FATAL about missing chromium.
    // It is acceptable for the script to exit non-zero if the stub binary
    // fails later (e.g. the archive has entries and HeadlessRenderer fails
    // to launch), but the preflight itself must pass.
    expect(stderr).not.toMatch(/FATAL.*Chromium binary found/i);
    expect(stderr).not.toMatch(/FATAL.*No Chromium binary found/i);

    // Clean up stub dir.
    try { rmSync(stubDir, { recursive: true, force: true }); } catch { /* noop */ }
  });
});

// ---------------------------------------------------------------------------
// All-degraded guard: pure unit tests (no browser, no LLM needed)
// ---------------------------------------------------------------------------

describe('rescore-tops all-degraded guard', () => {
  // Dynamically import the pure guard function from the built dist.
  // Build is guaranteed by beforeAll in setup.ts.
  let allDegradedGuard: (total: number, honest: number) => {
    allDegraded: boolean; exitCode: number; message: string | null;
  };

  beforeAll(async () => {
    const mod = await import(join(REPO_ROOT, 'dist/utils/browserAssetFallbacks.js'));
    allDegradedGuard = mod.allDegradedGuard;
  });

  it('fires (exit 1) when all entries are scorer-degraded', () => {
    const result = allDegradedGuard(/* totalEntries */ 1, /* honestEntries */ 0);
    expect(result.allDegraded).toBe(true);
    expect(result.exitCode).toBe(1);
    expect(result.message).toMatch(/all 1 entries infra-degraded/i);
  });

  it('fires (exit 1) when all entries are infra-degraded', () => {
    const result = allDegradedGuard(/* totalEntries */ 3, /* honestEntries */ 0);
    expect(result.allDegraded).toBe(true);
    expect(result.exitCode).toBe(1);
    expect(result.message).toMatch(/all 3 entries infra-degraded/i);
  });

  it('does not fire when at least one entry has honest evidence', () => {
    const result = allDegradedGuard(/* totalEntries */ 3, /* honestEntries */ 1);
    expect(result.allDegraded).toBe(false);
    expect(result.exitCode).toBe(0);
    expect(result.message).toBeNull();
  });

  it('does not fire when no entries were processed', () => {
    const result = allDegradedGuard(/* totalEntries */ 0, /* honestEntries */ 0);
    expect(result.allDegraded).toBe(false);
    expect(result.exitCode).toBe(0);
    expect(result.message).toBeNull();
  });

  it('fires only on totalEntries>0 AND honestEntries===0', () => {
    // totalEntries=0, honestEntries=0 → no-op (nothing processed)
    expect(allDegradedGuard(0, 0).allDegraded).toBe(false);
    // totalEntries>0, honestEntries=0 → degraded
    expect(allDegradedGuard(1, 0).allDegraded).toBe(true);
    // totalEntries>0, honestEntries>0 → fine
    expect(allDegradedGuard(1, 1).allDegraded).toBe(false);
    expect(allDegradedGuard(10, 5).allDegraded).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// resolveChromiumExecutablePath: fallback path unit tests
// ---------------------------------------------------------------------------

describe('resolveChromiumExecutablePath fallback scanning', () => {
  let resolveChromiumExecutablePath: () => string | undefined;
  let isPuppeteerChromeCompatible: (
    path: string,
    platform?: NodeJS.Platform,
    arch?: string,
  ) => boolean;

  beforeAll(async () => {
    const mod = await import(join(REPO_ROOT, 'dist/utils/browserAssetFallbacks.js'));
    resolveChromiumExecutablePath = mod.resolveChromiumExecutablePath;
    isPuppeteerChromeCompatible = mod.isPuppeteerChromeCompatible;
  });

  it('rejects Puppeteer x64 Chrome on Linux arm64', () => {
    expect(isPuppeteerChromeCompatible(
      '/root/.cache/puppeteer/chrome/linux_arm-146/chrome-linux64/chrome',
      'linux',
      'arm64',
    )).toBe(false);
    expect(isPuppeteerChromeCompatible('/cache/chrome-linux64/chrome', 'linux', 'x64')).toBe(true);
  });

  it('finds chrome when PLAYWRIGHT_BROWSERS_PATH contains chromium*/chrome-linux/chrome', () => {
    const stubDir = join(FIXTURES_DIR, 'pw-browsers-fallback-test');
    const chromeDir = join(stubDir, 'chromium-1234', 'chrome-linux');
    mkdirSync(chromeDir, { recursive: true });
    writeSync(join(chromeDir, 'chrome'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });

    const origPath = process.env.PLAYWRIGHT_BROWSERS_PATH;
    const origOverride = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
    const origPuppeteer = process.env.PUPPETEER_EXECUTABLE_PATH;
    try {
      process.env.PLAYWRIGHT_BROWSERS_PATH = stubDir;
      process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH = '';
      process.env.PUPPETEER_EXECUTABLE_PATH = '/missing/puppeteer-chrome';

      const result = resolveChromiumExecutablePath();
      expect(result).toBe(join(chromeDir, 'chrome'));
    } finally {
      process.env.PLAYWRIGHT_BROWSERS_PATH = origPath ?? '';
      process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH = origOverride ?? '';
      process.env.PUPPETEER_EXECUTABLE_PATH = origPuppeteer ?? '';
      try { rmSync(stubDir, { recursive: true, force: true }); } catch { /* noop */ }
    }
  });

  it('returns undefined when PLAYWRIGHT_BROWSERS_PATH contains no chromium dirs', () => {
    const emptyDir = join(FIXTURES_DIR, 'pw-browsers-empty-test');
    mkdirSync(emptyDir, { recursive: true });

    const origPath = process.env.PLAYWRIGHT_BROWSERS_PATH;
    const origOverride = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
    const origPuppeteer = process.env.PUPPETEER_EXECUTABLE_PATH;
    try {
      process.env.PLAYWRIGHT_BROWSERS_PATH = emptyDir;
      process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH = '';
      process.env.PUPPETEER_EXECUTABLE_PATH = '/missing/puppeteer-chrome';

      // skipInstall: empty explicit path must fail closed (no legacy Caches/ leak, F9)
      const result = resolveChromiumExecutablePath({ skipInstall: true });
      expect(result).toBeUndefined();
    } finally {
      process.env.PLAYWRIGHT_BROWSERS_PATH = origPath ?? '';
      process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH = origOverride ?? '';
      process.env.PUPPETEER_EXECUTABLE_PATH = origPuppeteer ?? '';
      try { rmSync(emptyDir, { recursive: true, force: true }); } catch { /* noop */ }
    }
  });
});

// ---------------------------------------------------------------------------
// Cadence script integration: verify non-zero is surfaced
// ---------------------------------------------------------------------------

describe('rescore-cadence.sh surfaces non-zero from rescore-tops.mjs', () => {
  it('writes FAILED line when rescore-tops exits non-zero (preflight abort)', () => {
    writeFileSync(join(FIXTURES_DIR, 'archive-empty.json'), ARCHIVE_EMPTY);

    const fakePath = '/tmp/this-browser-definitely-does-not-exist-rescore-test';
    const env = {
      ...process.env,
      QUALITY_ARCHIVE_PATH: join(FIXTURES_DIR, 'archive-empty.json'),
      PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH: fakePath,
      SINTER_REPO: REPO_ROOT,
    };

    let combined = '';
    try {
      execSync(
        `bash "${join(REPO_ROOT, 'scripts/quality/rescore-cadence.sh')}"`,
        {
          cwd: REPO_ROOT,
          encoding: 'utf-8',
          env,
          stdio: ['ignore', 'pipe', 'pipe'],
          timeout: 30_000,
        },
      );
    } catch (err: unknown) {
      const execErr = err as { stdout?: string; stderr?: string };
      combined = (execErr.stdout ?? '') + (execErr.stderr ?? '');
    }

    // The cadence script MUST print "FAILED" when the inner script exits non-zero.
    expect(combined).toMatch(/FAILED|rescore.*FATAL/i);
    // Must NOT print "ok — N records" when the inner script failed.
    expect(combined).not.toMatch(/^.*rescore.*ok.*[0-9]+ records/s);
  });
});
