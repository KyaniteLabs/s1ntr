import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { scanChromiumUnder } from '../../../src/utils/browserPreflight.js';

// #1594: an interrupted browser download leaves the executable without the
// rest of the bundle. The scan must skip it instead of handing it to launch.
const roots: string[] = [];
function root(): string {
  const dir = mkdtempSync(join(tmpdir(), 'browser-preflight-'));
  roots.push(dir);
  return dir;
}
function touch(path: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, '');
}
afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('scanChromiumUnder skips half-installed browsers (#1594)', () => {
  it('skips a Playwright dir holding only the binary', () => {
    const base = root();
    touch(join(base, 'chromium-1200', 'chrome-linux', 'chrome'));
    expect(scanChromiumUnder(base)).toBeUndefined();
  });

  it('accepts a Playwright dir with INSTALLATION_COMPLETE', () => {
    const base = root();
    const binary = join(base, 'chromium-1200', 'chrome-linux', 'chrome');
    touch(binary);
    touch(join(base, 'chromium-1200', 'INSTALLATION_COMPLETE'));
    expect(scanChromiumUnder(base)).toBe(binary);
  });

  it('skips a macOS app bundle without Frameworks', () => {
    const base = root();
    touch(join(base, 'chromium-1200', 'INSTALLATION_COMPLETE'));
    touch(join(base, 'chromium-1200', 'chrome-mac', 'Chromium.app', 'Contents', 'MacOS', 'Chromium'));
    expect(scanChromiumUnder(base)).toBeUndefined();
  });

  it('accepts a macOS app bundle with Frameworks', () => {
    const base = root();
    const binary = join(base, 'chromium-1200', 'chrome-mac', 'Chromium.app', 'Contents', 'MacOS', 'Chromium');
    touch(join(base, 'chromium-1200', 'INSTALLATION_COMPLETE'));
    touch(binary);
    touch(join(base, 'chromium-1200', 'chrome-mac', 'Chromium.app', 'Contents', 'Frameworks', 'Chromium Framework.framework', 'x'));
    expect(scanChromiumUnder(base)).toBe(binary);
  });

  it('falls through a broken install to a complete one', () => {
    const base = root();
    touch(join(base, 'chromium-1100', 'chrome-linux', 'chrome'));
    const good = join(base, 'chromium-1200', 'chrome-linux', 'chrome');
    touch(good);
    touch(join(base, 'chromium-1200', 'INSTALLATION_COMPLETE'));
    expect(scanChromiumUnder(base)).toBe(good);
  });
});
