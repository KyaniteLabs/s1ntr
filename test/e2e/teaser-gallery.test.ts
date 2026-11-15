import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import { createServer, type Server } from 'node:http';
import { copyFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { extname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

let root: string, output: string, url: string, server: Server, browser: Browser, page: Page;
type GalleryWindow = Window & { __exhibit: { idx: number; playing: boolean; mute(muted: boolean): void } };
type BedWindow = Window & { beginCalls: number; running: boolean; bedState: { running: boolean }; releaseStarts(): void; rejectStarts(): void };
type RetiredBedWindow = Window & { retiredBed: { state: { running: boolean }; release(): void } };
beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'gallery-interaction-'));
  const teaser = join(root, 'teaser'), artifacts = join(root, 'artifacts');
  for (const directory of [teaser, artifacts]) mkdirSync(directory);
  for (const name of ['build-v2.mjs', 'vendor-paths.mjs']) copyFileSync(resolve('teaser', name), join(teaser, name));
  cpSync(resolve('teaser/ab'), join(teaser, 'ab'), { recursive: true });
  for (const name of ['fonts', 'og']) symlinkSync(resolve('teaser', name), join(teaser, name));
  const artifact = join(artifacts, 'work.html'), ledger = join(root, 'ledger.jsonl');
  writeFileSync(artifact, '<html><body><svg xmlns="http://www.w3.org/2000/svg" width="800" height="800"><rect width="800" height="800" fill="navy"/></svg></body></html>');
  writeFileSync(ledger, JSON.stringify({ event_type: 'artifact_scored', domain: 'svg', artifact, axes: 'D=8 A=8 R=8 N=8' }) + '\n');
  const bed = join(artifacts, 'bed.html');
  writeFileSync(bed, `<html><body><script>
    const audio = {beginCalls:0, running:false}; window.bedState = audio;
    Object.defineProperty(window, 'beginCalls', {get:() => audio.beginCalls});
    Object.defineProperty(window, 'running', {get:() => audio.running});
    const starts = [];
    window.__sinterBegin = () => {
      audio.beginCalls++;
      // This provider's operation survives iframe retirement in the host realm.
      return new parent.Promise((resolve, reject) => starts.push({resolve, reject}));
    };
    window.__sinterRest = () => { audio.running = false; };
    window.releaseStarts = () => starts.splice(0).forEach(start => { audio.running = true; start.resolve(); });
    window.rejectStarts = () => starts.splice(0).forEach(start => start.reject(new Error('Test audio start failed')));
    window.Tone = {Transport: {get state() { return audio.running ? 'started' : 'stopped'; }}, getContext: () => ({state:'running'})};
  </script></body></html>`);
  const build = spawnSync(process.execPath, ['build-v2.mjs', '--ledger', ledger, '--out', 'output', '--bed', bed], {
    cwd: teaser, env: { PATH: process.env.PATH, SINTER_TEASER_ARTIFACT_ROOT: artifacts }, encoding: 'utf8',
  });
  expect(build.status, build.stderr).toBe(0);
  output = join(teaser, 'output');
  // Supply the live gallery's 14-control count without real provider/art dependencies.
  const extra = Array.from({ length: 12 }, (_, i) => `<section class="work" id="fixture-${i}" data-cls="fixture"><div class="tag">fixture</div></section>`).join('');
  const index = join(output, 'index.html');
  writeFileSync(index, readFileSync(index, 'utf8').replace('</main>', extra + '</main>'));
  server = createServer((request, response) => {
    const pathname = new URL(request.url!, 'http://localhost').pathname;
    const file = resolve(output, '.' + (pathname === '/' ? '/index.html' : pathname));
    if (!file.startsWith(output + '/')) { response.writeHead(404).end(); return; }
    try { response.setHeader('content-type', extname(file) === '.html' ? 'text/html' : 'text/javascript'); response.end(readFileSync(file)); }
    catch { response.writeHead(404).end(); }
  });
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing gallery fixture port');
  url = `http://127.0.0.1:${address.port}/?dwell=2000&hold=300`;
  browser = await chromium.launch();
}, 30_000);

afterEach(async () => { await page?.context().close(); });
afterAll(async () => {
  await browser?.close();
  if (server) await new Promise<void>(done => server.close(() => done()));
  if (root) rmSync(root, { recursive: true, force: true });
});
async function open(reducedMotion = false, height = 844) {
  const context = await browser.newContext({ viewport: { width: 320, height }, reducedMotion: reducedMotion ? 'reduce' : 'no-preference' });
  page = await context.newPage();
  await page.goto(url);
  await page.waitForFunction(() => (window as GalleryWindow).__exhibit?.idx >= 0);
}
const index = () => page.evaluate(() => (window as GalleryWindow).__exhibit.idx);
const playing = () => page.evaluate(() => (window as GalleryWindow).__exhibit.playing);

describe('generated gallery controls', () => {
  it('does not reload a legitimate audio start that is still pending', async () => {
    await open();
    const bed = page.frames().find(frame => frame.url().endsWith('/bed.html'))!;
    await bed.waitForFunction(() => (window as BedWindow).beginCalls >= 1);
    await page.evaluate(() => {
      const source = document.querySelector<HTMLIFrameElement>('.bedlayer iframe')!.contentWindow as BedWindow;
      (window as RetiredBedWindow).retiredBed = { state: source.bedState, release: source.releaseStarts };
    });
    await page.locator('.mark').click(); await page.waitForTimeout(1550);
    expect(await page.evaluate(() => {
      const source = document.querySelector<HTMLIFrameElement>('.bedlayer iframe')!.contentWindow as BedWindow;
      return source.bedState === (window as RetiredBedWindow).retiredBed.state;
    })).toBe(true);
  });

  it('preserves a muted bed when the gesture recovery timer fires', async () => {
    await open();
    const bed = page.frames().find(frame => frame.url().endsWith('/bed.html'))!;
    await bed.waitForFunction(() => (window as BedWindow).beginCalls >= 1);
    await bed.evaluate(() => (window as BedWindow).releaseStarts());
    await expect.poll(() => bed.evaluate(() => (window as BedWindow).running)).toBe(true);
    await page.evaluate(() => {
      const source = document.querySelector<HTMLIFrameElement>('.bedlayer iframe')!.contentWindow as BedWindow;
      (window as RetiredBedWindow).retiredBed = { state: source.bedState, release: source.releaseStarts };
    });
    await page.locator('.mark').click();
    await page.evaluate(() => (window as GalleryWindow).__exhibit.mute(true));
    await page.waitForTimeout(1550);
    expect(await page.evaluate(() => {
      const source = document.querySelector<HTMLIFrameElement>('.bedlayer iframe')!.contentWindow as BedWindow;
      return source.bedState === (window as RetiredBedWindow).retiredBed.state && !source.running;
    })).toBe(true);
    await expect.poll(() => page.locator('#sndline').textContent()).toContain('muted');
  });

  it('starts a replacement bed when recovery reloads an unavailable engine', async () => {
    await open();
    const bed = page.frames().find(frame => frame.url().endsWith('/bed.html'))!;
    await bed.waitForFunction(() => (window as BedWindow).beginCalls >= 1);
    await page.evaluate(() => (window as GalleryWindow).__exhibit.mute(true));
    await bed.evaluate(() => {
      delete (window as Window & { __sinterBegin?: unknown }).__sinterBegin;
      (window as BedWindow).rejectStarts();
    });
    await page.evaluate(() => {
      const source = document.querySelector<HTMLIFrameElement>('.bedlayer iframe')!.contentWindow as BedWindow;
      (window as RetiredBedWindow).retiredBed = { state: source.bedState, release: source.releaseStarts };
      (window as GalleryWindow).__exhibit.mute(false);
    });
    await page.locator('.mark').click();
    await expect.poll(() => page.evaluate(() => {
      const source = document.querySelector<HTMLIFrameElement>('.bedlayer iframe')!.contentWindow as BedWindow;
      return source.bedState !== (window as RetiredBedWindow).retiredBed.state && source.beginCalls === 1;
    }), { timeout: 4000 }).toBe(true);
  });

  it('lets API mute replace a stale audio failure status', async () => {
    await open();
    const bed = page.frames().find(frame => frame.url().endsWith('/bed.html'))!;
    await bed.waitForFunction(() => (window as BedWindow).beginCalls >= 1);
    await bed.evaluate(() => (window as BedWindow).rejectStarts());
    await expect.poll(() => page.locator('#sndline').textContent()).toContain('sound unavailable');
    await page.evaluate(() => (window as GalleryWindow).__exhibit.mute(true));
    await page.waitForTimeout(850);
    expect(await page.locator('#sndline').textContent()).toContain('muted');
  });

  it('stops a retired document when its audio start finishes after reload', async () => {
    await open();
    const bed = page.frames().find(frame => frame.url().endsWith('/bed.html'))!;
    await bed.waitForFunction(() => (window as BedWindow).beginCalls >= 1);
    await page.evaluate(() => {
      const frame = document.querySelector<HTMLIFrameElement>('.bedlayer iframe')!;
      const source = frame.contentWindow as BedWindow;
      (window as RetiredBedWindow).retiredBed = { state: source.bedState, release: source.releaseStarts };
      frame.src = frame.src;
    });
    await page.waitForFunction(() => {
      const frame = document.querySelector<HTMLIFrameElement>('.bedlayer iframe')!;
      return (frame.contentWindow as BedWindow).bedState !== (window as RetiredBedWindow).retiredBed.state;
    });
    await page.evaluate(() => (window as RetiredBedWindow).retiredBed.release());
    await expect.poll(() => page.evaluate(() => (window as RetiredBedWindow).retiredBed.state.running)).toBe(false);
  });

  it('shows mute after a failed audio start when the user turns sound off', async () => {
    await open();
    const bed = page.frames().find(frame => frame.url().endsWith('/bed.html'))!;
    await bed.waitForFunction(() => (window as BedWindow).beginCalls >= 1);
    await bed.evaluate(() => (window as BedWindow).rejectStarts());
    await expect.poll(() => page.locator('#sndline').textContent()).toContain('sound unavailable');
    await page.locator('#mute').click();
    await page.waitForTimeout(850); // Exercise the 800ms truth poll after the click.
    expect(await page.locator('#sndline').textContent()).toContain('muted');
  });

  it.each([['k1ln.dev', 'K1LN'], ['s1ntr.com', 'S1NTR']])('keeps rendered branding consistent on %s', async (host, name) => {
    const context = await browser.newContext(); page = await context.newPage();
    await page.route(`https://${host}/**`, async route => {
      const pathname = new URL(route.request().url()).pathname;
      const file = resolve(output, '.' + (pathname === '/' ? '/index.html' : pathname));
      if (!file.startsWith(output + '/')) { await route.fulfill({ status: 404, body: '' }); return; }
      try { await route.fulfill({ contentType: extname(file) === '.html' ? 'text/html' : 'text/javascript', body: readFileSync(file) }); }
      catch { await route.fulfill({ status: 404, body: '' }); }
    });
    await page.goto(`https://${host}/`, { waitUntil: 'domcontentloaded' });
    expect(await page.title()).toBe(name);
    expect(await page.locator('#mark .d').count()).toBe(1);
    expect(await page.locator('#mark .d').textContent()).toBe('1');
    expect(await page.locator('meta[property="og:title"]').getAttribute('content')).toBe(name);
    expect(await page.locator('meta[name="twitter:title"]').getAttribute('content')).toBe(name);
    expect(await page.locator('script[type="application/ld+json"]').evaluate(el => JSON.parse(el.textContent!).name)).toBe(name);
  });

  it('keeps persistent text readable over the brightest artwork background', async () => {
    await open();
    const samples = await page.locator('.work.on .tag, #sndline').evaluateAll(elements => elements.map(el => {
      const style = getComputedStyle(el);
      return { foreground: style.color, background: style.backgroundColor, opacity: Number(style.opacity) };
    }));
    const luminance = (channels: number[]) => channels.map(c => c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)
      .reduce((sum, c, i) => sum + c * [0.2126, 0.7152, 0.0722][i], 0);
    for (const sample of samples) {
      const fg = sample.foreground.match(/[\d.]+/g)!.map(Number);
      const bg = sample.background.match(/[\d.]+/g)!.map(Number);
      const alpha = bg[3] ?? 1;
      const background = bg.slice(0, 3).map(c => (c * alpha + 255 * (1 - alpha)) / 255);
      const foreground = fg.slice(0, 3).map((c, i) => c / 255 * sample.opacity + background[i] * (1 - sample.opacity));
      const contrast = (luminance(foreground) + 0.05) / (luminance(background) + 0.05);
      expect(contrast).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('shares an in-flight audio start across repeated gestures', async () => {
    await open();
    const bed = page.frames().find(frame => frame.url().endsWith('/bed.html'))!;
    await bed.waitForFunction(() => (window as BedWindow).beginCalls >= 1);
    await page.locator('.mark').click(); await page.locator('.mark').click();
    expect(await bed.evaluate(() => (window as BedWindow).beginCalls)).toBe(1);
  });

  it('keeps a late audio start stopped after the user mutes', async () => {
    await open();
    const bed = page.frames().find(frame => frame.url().endsWith('/bed.html'))!;
    await bed.waitForFunction(() => (window as BedWindow).beginCalls >= 1);
    await page.locator('#mute').click();
    await bed.evaluate(() => (window as BedWindow).releaseStarts());
    await expect.poll(() => bed.evaluate(() => (window as BedWindow).running)).toBe(false);
  });

  it('handles an asynchronous audio failure and reports it truthfully', async () => {
    await open();
    const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
    const bed = page.frames().find(frame => frame.url().endsWith('/bed.html'))!;
    await bed.waitForFunction(() => (window as BedWindow).beginCalls >= 1);
    await bed.evaluate(() => (window as BedWindow).rejectStarts());
    await expect.poll(() => page.locator('#sndline').textContent()).toContain('sound unavailable');
    expect(errors).toEqual([]);
  });

  it('exposes hover metadata to keyboard focus', async () => {
    await open();
    const tag = page.locator('.work.on .tag');
    await tag.focus();
    expect(await tag.locator('.meta').evaluate(el => getComputedStyle(el).display)).not.toBe('none');
  });

  it('leaves keys consumed by interactive artwork inside that artwork', async () => {
    await open();
    const frame = page.frames().find(frame => frame !== page.mainFrame() && frame.url().includes('/w/'))!;
    await frame.evaluate(() => window.addEventListener('keydown', event => event.preventDefault()));
    await page.locator('.work.on iframe').click({ position: { x: 100, y: 100 } });
    await page.keyboard.press('ArrowRight');
    expect(await index()).toBe(0);
  });

  it('keeps focused metadata visible until the visitor resumes rotation', async () => {
    await open();
    const initial = await index();
    await page.locator('.work.on .tag').focus();
    await page.waitForTimeout(2700);
    expect(await index()).toBe(initial);
    expect(await playing()).toBe(false);
    await page.getByRole('button', { name: 'Resume rotation' }).click();
    expect(await playing()).toBe(true);
    await expect.poll(index, { timeout: 3500 }).not.toBe(initial);
  });

  it('keeps focus visible when metadata arrow navigation changes the work', async () => {
    await open(true);
    await page.locator('.work.on .tag').focus();
    await page.keyboard.press('ArrowRight');
    expect(await index()).toBe(1);
    expect(await page.evaluate(() => {
      const active = document.activeElement;
      return !!active && (!!active.closest('.work.on') || active.matches('.rail button[aria-current="true"]'));
    })).toBe(true);
  });

  it('starts rotation paused for reduced motion and exposes an explicit resume control', async () => {
    await open(true);
    expect(await playing()).toBe(false);
    const resume = page.getByRole('button', { name: 'Resume rotation' });
    expect(await resume.count()).toBe(1);
    await resume.click();
    expect(await playing()).toBe(true);
  });

  it('exposes the current work and its name to assistive technology', async () => {
    await open();
    const current = page.locator('.rail button').first();
    expect(await current.getAttribute('aria-current')).toBe('true');
    expect(await current.getAttribute('aria-label')).toContain('line');
  });

  it('keeps fourteen control targets inside a short viewport', async () => {
    await open(false, 256);
    const targets = await page.locator('.rail button').evaluateAll(buttons => buttons.map(button => {
      const r = button.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, width: r.width, height: r.height };
    }));
    expect(targets).toHaveLength(14);
    for (const target of targets) {
      expect(target.top).toBeGreaterThanOrEqual(0); expect(target.bottom).toBeLessThanOrEqual(256);
      expect(target.width).toBeGreaterThanOrEqual(24); expect(target.height).toBeGreaterThanOrEqual(24);
    }
  });

  it('lets Space activate the focused mute button', async () => {
    await open();
    await page.locator('#mute').focus(); await page.keyboard.press('Space');
    expect(await page.locator('#mute').getAttribute('aria-pressed')).toBe('true');
  });

  it('lets Space activate a focused work button', async () => {
    await open();
    await page.locator('.rail button').nth(1).focus(); await page.keyboard.press('Space');
    await expect.poll(index).toBe(1);
  });

  it('keeps arrow navigation available after clicking into artwork', async () => {
    await open();
    await page.locator('.work.on iframe').click({ position: { x: 100, y: 100 } });
    await page.keyboard.press('ArrowRight');
    await expect.poll(index).toBe(1);
  });
});
