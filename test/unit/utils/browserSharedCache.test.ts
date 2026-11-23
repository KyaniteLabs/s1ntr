/**
 * A throwaway HOME (spawned CLIs, sandboxes) must still find the shared Playwright
 * cache before the preflight fails, and a failure must say where it looked.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  missingChromiumError,
  scanLegacyBrowserCaches,
  sharedBrowserCacheRoots,
} from '../../../src/utils/browserPreflight.js';

const dirs: string[] = [];
const saved = process.env.PLAYWRIGHT_BROWSERS_PATH;
afterEach(() => {
  if (saved === undefined) delete process.env.PLAYWRIGHT_BROWSERS_PATH;
  else process.env.PLAYWRIGHT_BROWSERS_PATH = saved;
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('shared browser cache fallback', () => {
  it('finds chromium under PLAYWRIGHT_BROWSERS_PATH from the parent environment', () => {
    const cache = mkdtempSync(join(tmpdir(), 'shared-pw-'));
    dirs.push(cache);
    const bin = join(cache, 'chromium-9999', 'chrome-linux64', 'chrome');
    mkdirSync(join(cache, 'chromium-9999', 'chrome-linux64'), { recursive: true });
    writeFileSync(bin, '');
    writeFileSync(join(cache, 'chromium-9999', 'INSTALLATION_COMPLETE'), '');
    process.env.PLAYWRIGHT_BROWSERS_PATH = cache;
    expect(sharedBrowserCacheRoots()[0]).toBe(cache);
    expect(scanLegacyBrowserCaches()).toBe(bin);
  });

  it('names the shared caches it looked in when nothing is found', () => {
    process.env.PLAYWRIGHT_BROWSERS_PATH = '/nonexistent/pw-cache';
    expect(missingChromiumError().message).toContain('/nonexistent/pw-cache');
    expect(missingChromiumError().message).toContain('.cache/ms-playwright');
  });
});
