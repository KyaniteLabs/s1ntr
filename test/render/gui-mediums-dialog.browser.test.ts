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
const temporary = mkdtempSync(path.join(tmpdir(), 'sinter-dialog-'));
let browser: Browser;
let bundle: string;
beforeAll(async () => {
  const { build } = await import(createRequire(require.resolve('vite')).resolve('esbuild'));
  const source = `import React from 'react'; import {createRoot} from 'react-dom/client';
    import {MediumsGuide} from '${root}/gui/src/components/MediumsGuide.tsx';
    createRoot(document.getElementById('app')).render(<><button id="before">Before</button>
    <MediumsGuide onPick={window.selectable ? id => document.body.dataset.picked=id : undefined}/>
    <button id="after">After</button></>);`;
  const result = await build({ stdin: { contents: source, resolveDir: root, loader: 'tsx' },
    bundle: true, write: false, format: 'iife', define: { 'process.env.NODE_ENV': '"production"' } });
  bundle = result.outputFiles[0].text;
  const executablePath = resolveChromiumExecutablePath({ skipInstall: true });
  browser = await puppeteer.launch({
    headless: true,
    userDataDir: path.join(temporary, 'profile'),
    ...(executablePath && isPuppeteerChromeCompatible(executablePath) ? { executablePath } : {}),
    // Chrome refuses its sandbox as root (CI containers); fixtures here are local and all requests are aborted.
    args: process.getuid?.() === 0 ? ['--no-sandbox'] : sandboxOptOutArgs(),
  });
});
afterAll(async () => {
  await browser?.close();
  rmSync(temporary, { recursive: true, force: true });
});
async function fixture(selectable: boolean): Promise<Page> {
  const page = await browser.newPage();
  await page.setRequestInterception(true);
  page.on('request', request => { void request.abort(); });
  await page.setContent('<html lang="en"><body><div id="app"></div></body></html>');
  await page.addStyleTag({ content: readFileSync(path.join(root, 'gui/src/index.css'), 'utf8') });
  await page.evaluate(value => { Object.assign(window, { selectable: value }); }, selectable);
  await page.addScriptTag({ content: bundle });
  await page.waitForSelector('.sinter-mediums-trigger');
  return page;
}
describe('Mediums guide keyboard operation', () => {
  it('moves focus into the modal, contains Tab, closes with Escape and restores focus', async () => {
    const page = await fixture(false);
    try {
      await page.focus('.sinter-mediums-trigger');
      await page.keyboard.press('Enter');
      await page.waitForSelector('.sinter-mediums-overlay');
      expect(await page.evaluate(() => document.activeElement?.className)).toBe('sinter-mediums-close');
      await page.keyboard.down('Shift');
      await page.keyboard.press('Tab');
      await page.keyboard.up('Shift');
      // Native dialogs may cycle to browser chrome, but the page behind stays inert.
      expect(await page.evaluate(() => document.activeElement?.id)).not.toMatch(/^(before|after)$/);
      expect(await page.evaluate(() => {
        document.querySelector<HTMLButtonElement>('#after')?.focus();
        return document.activeElement?.id === 'after';
      })).toBe(false);
      await page.focus('.sinter-mediums-close');
      await page.keyboard.press('Escape');
      await page.waitForSelector('.sinter-mediums-overlay', { hidden: true });
      expect(await page.evaluate(() => document.activeElement?.className)).toBe('sinter-mediums-trigger');
    } finally { await page.close(); }
  });
  it('selects an enabled medium with the keyboard and closes without changing it on cancellation', async () => {
    const page = await fixture(true);
    try {
      await page.focus('.sinter-mediums-trigger');
      await page.keyboard.press('Enter');
      await page.waitForSelector('.sinter-mediums-overlay');
      await page.keyboard.press('Tab');
      await page.keyboard.press('Enter');
      await page.waitForSelector('.sinter-mediums-overlay', { hidden: true });
      expect(await page.evaluate(() => document.body.dataset.picked)).toBe('auto');
      await page.keyboard.press('Enter');
      await page.waitForSelector('.sinter-mediums-overlay');
      await page.keyboard.press('Escape');
      await page.waitForSelector('.sinter-mediums-overlay', { hidden: true });
      expect(await page.evaluate(() => document.body.dataset.picked)).toBe('auto');
    } finally { await page.close(); }
  });
});
