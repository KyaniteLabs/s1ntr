import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer, { type Browser, type Page } from 'puppeteer';
import { isPuppeteerChromeCompatible, resolveChromiumExecutablePath } from '../../src/utils/browserAssetFallbacks.js';
import { sandboxOptOutArgs } from '../../src/security/SandboxConfig.js';

const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL('../..', import.meta.url));
const temporary = mkdtempSync(path.join(tmpdir(), 'sinter-motion-'));
let browser: Browser;
let bundle: string;
beforeAll(async () => {
  const { build } = await import(createRequire(require.resolve('vite')).resolve('esbuild'));
  const source = `import React from 'react'; import {createRoot} from 'react-dom/client';
    import {LocaleProvider} from '${root}/gui/src/i18n/index.tsx';
    import {StageMotionGate} from '${root}/gui/src/components/StageMotionGate.tsx';
    createRoot(document.getElementById('app')).render(<LocaleProvider><main className="stage-canvas">
    <StageMotionGate><iframe className="stage-frame" id="work" srcDoc="<p>live</p>" sandbox="allow-scripts"/></StageMotionGate>
    </main></LocaleProvider>);`;
  const result = await build({ stdin: { contents: source, resolveDir: root, loader: 'tsx' },
    bundle: true, write: false, format: 'iife', define: { 'process.env.NODE_ENV': '"production"' } });
  bundle = result.outputFiles[0].text;
  const executablePath = resolveChromiumExecutablePath({ skipInstall: true });
  browser = await puppeteer.launch({
    headless: true,
    userDataDir: path.join(temporary, 'profile'),
    ...(executablePath && isPuppeteerChromeCompatible(executablePath) ? { executablePath } : {}),
    // Chrome refuses its sandbox as root (CI containers); the fixture is local and loads nothing remote.
    args: process.getuid?.() === 0 ? ['--no-sandbox'] : sandboxOptOutArgs(),
  });
});
afterAll(async () => {
  await browser?.close();
  rmSync(temporary, { recursive: true, force: true });
});
async function fixture(reduce: boolean): Promise<Page> {
  const page = await browser.newPage();
  await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: reduce ? 'reduce' : 'no-preference' }]);
  await page.setContent('<html lang="en"><body><div id="app"></div></body></html>');
  await page.addStyleTag({ content: readFileSync(path.join(root, 'gui/src/index.css'), 'utf8') });
  await page.addScriptTag({ content: bundle });
  await page.waitForSelector('.stage-motion-toggle');
  return page;
}
const state = (page: Page) => page.evaluate(() => ({
  work: document.querySelector('#work') !== null,
  label: document.querySelector('.stage-motion-toggle')?.textContent,
  focused: document.activeElement?.classList.contains('stage-motion-toggle') ?? false,
}));
describe('Stage motion control', () => {
  it('starts stopped under reduced motion and plays only when asked', async () => {
    const page = await fixture(true);
    try {
      expect(await state(page)).toEqual({ work: false, label: 'Play motion', focused: false });
      expect(await page.$eval('.stage-empty[role="status"]', node => node.textContent))
        .toBe('Motion is stopped. Press Play motion when you want to watch it move.');
      await page.focus('.stage-motion-toggle');
      await page.keyboard.press('Enter');
      expect(await state(page)).toEqual({ work: true, label: 'Stop motion', focused: true });
    } finally { await page.close(); }
  });
  it('plays by default and unmounts the work when stopped', async () => {
    const page = await fixture(false);
    try {
      expect(await state(page)).toEqual({ work: true, label: 'Stop motion', focused: false });
      await page.focus('.stage-motion-toggle');
      await page.keyboard.press('Space');
      expect(await state(page)).toEqual({ work: false, label: 'Play motion', focused: true });
    } finally { await page.close(); }
  });
  it('follows a live change to the system setting', async () => {
    const page = await fixture(false);
    try {
      await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
      await page.waitForFunction(() => document.querySelector('#work') === null);
      expect((await state(page)).label).toBe('Play motion');
    } finally { await page.close(); }
  });
});
