import { describe, expect, it } from 'vitest';
import { JSDOM } from 'jsdom';
import { GenericWrapper } from '../../../src/core/wrappers/GenericWrapper';
import { HeadlessRenderer } from '../../../src/render/HeadlessRenderer';
import type { RenderDomain } from '../../../src/render/HeadlessRenderer';

/**
 * Chrome starts audio only inside a trusted click, so the renderer must press
 * the Start button of the shell it rendered. The page below runs the real
 * shell: click() is the renderer's trusted click, and evaluate() runs in the
 * page, as the renderer's untrusted fallback does. Each artwork records when
 * its own start path runs, because the shell starts the Transport by itself
 * and a started Transport with nothing scheduled is silence.
 */
function shellPage(html: string, globals: Record<string, unknown>, opts: { covered?: boolean } = {}) {
  const dom = new JSDOM(html, {
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    beforeParse(window) {
      const pen = new Proxy({}, { get: () => () => undefined, set: () => true });
      window.HTMLCanvasElement.prototype.getContext = (() => pen) as never;
      Object.assign(window, globals, { __sinterDrawScope: () => undefined, __name: (value: unknown) => value });
    },
  });
  const { window } = dom;
  const find = (selector: string) => window.document.querySelector<HTMLElement>(selector);
  const page = {
    waitForTimeout: (ms: number) => new Promise((resolve) => setTimeout(resolve, Math.min(ms, 40))),
    waitForSelector: async (selector: string) => {
      if (!find(selector)) throw new Error(`waiting for ${selector} timed out`);
    },
    // A covered button: Playwright's click waits for it, then times out.
    click: async (selector: string) => {
      if (opts.covered) throw new Error(`<canvas> intercepts pointer events while clicking ${selector}`);
      find(selector)!.click();
    },
    focus: async (selector: string) => find(selector)!.focus(),
    // A trusted key press activates the focused button whatever covers it.
    keyboard: { press: async (key: string) => {
      const el = window.document.activeElement as HTMLElement | null;
      if (key === 'Enter' && el?.tagName === 'BUTTON') el.click();
    } },
    evaluate: async (fn: (arg?: unknown) => unknown, arg?: unknown) =>
      window.eval(`(${fn.toString()})(${JSON.stringify(arg)})`),
  };
  return { page, window: window as unknown as Record<string, unknown> };
}

// Tone.start() resumes the AudioContext; the real one does so only inside a trusted click.
function fakeTone() {
  const tone = {
    starts: 0,
    context: { state: 'suspended' },
    start: async () => { tone.starts += 1; tone.context.state = 'running'; },
    Transport: { bpm: { value: 120 }, state: 'stopped', start() { this.state = 'started'; }, stop() {}, cancel() {} },
  };
  return tone;
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

async function trigger(page: unknown, domain: RenderDomain) {
  const renderer = new HeadlessRenderer() as unknown as {
    triggerAudioPlayback(page: unknown, domain: RenderDomain): Promise<{ controlsAccessible: boolean; started: boolean }>;
  };
  return renderer.triggerAudioPlayback(page, domain);
}

const toneHtml = (body: string) => `<!DOCTYPE html><html><head>
<script src="https://unpkg.com/tone@14.8.49/build/Tone.js"></script></head><body>${body}</body></html>`;

describe('the renderer starts every audio shell with a real click', () => {
  const tonePieces: Array<[string, string]> = [
    ['plain Tone.js with play()', 'function play() { window.artworkStarted = true; }'],
    ['Tone HTML with play()', toneHtml('<script>function play() { window.artworkStarted = true; }</script>')],
    ['Tone HTML that starts from its own button', toneHtml(`<button id="go">Play</button>
<script>document.getElementById('go').addEventListener('click', () => { window.artworkStarted = true; });</script>`)],
  ];

  it.each(tonePieces)('%s', async (_, code) => {
    const Tone = fakeTone();
    const { page, window } = shellPage(GenericWrapper.wrap(code, { domain: 'tone' }), { Tone });
    const result = await trigger(page, 'tone');
    await settle();
    expect(result.controlsAccessible).toBe(true);
    expect(result.started).toBe(true);
    expect(window.artworkStarted).toBe(true);
    expect(Tone.starts).toBeGreaterThan(0);
  });

  it("presses the shell's Start button, not an artwork button that is also called #start", async () => {
    const Tone = fakeTone();
    const code = toneHtml(`<button id="start">Go</button>
<script>document.getElementById('start').addEventListener('click', () => { window.artworkStarted = true; });</script>`);
    const { page, window } = shellPage(GenericWrapper.wrap(code, { domain: 'tone' }), { Tone });
    await trigger(page, 'tone');
    await settle();
    // Only the shell's handler unlocks audio with Tone.start(), then presses the artwork's button.
    expect(Tone.starts).toBeGreaterThan(0);
    expect(window.artworkStarted).toBe(true);
  });

  it('starts a Tone piece whose own layer covers the Start button (#1757)', async () => {
    const Tone = fakeTone();
    const code = 'const layer = document.createElement("canvas"); document.body.appendChild(layer);\nfunction play() { window.artworkStarted = true; }';
    const { page, window } = shellPage(GenericWrapper.wrap(code, { domain: 'tone' }), { Tone }, { covered: true });
    const result = await trigger(page, 'tone');
    await settle();
    expect(result.started).toBe(true);
    expect(Tone.starts).toBeGreaterThan(0);
    expect(window.artworkStarted).toBe(true);
  });

  it('starts a Tone script whose sound starts only from its own labelled Play button (#1757)', async () => {
    const Tone = fakeTone();
    const code = `(() => {
  const stop = document.createElement('button'); stop.className = 'play-stop'; stop.setAttribute('aria-label', 'Stop');
  stop.addEventListener('click', () => { window.stopPressed = true; });
  const go = document.createElement('button'); go.className = 'play'; go.setAttribute('aria-label', 'Play');
  go.addEventListener('click', async () => { await Tone.start(); window.artworkStarted = true; });
  document.body.append(stop, go);
})();`;
    const { page, window } = shellPage(GenericWrapper.wrap(code, { domain: 'tone' }), { Tone });
    const result = await trigger(page, 'tone');
    await settle();
    expect(result.started).toBe(true);
    expect(window.artworkStarted).toBe(true);
    expect(window.stopPressed).toBeUndefined();
  });

  function fakeStrudel(bootMs: number, evaluateError?: Error) {
    const strudel = {
      evaluated: '',
      initStrudel: () => new Promise((resolve) => setTimeout(resolve, bootMs)),
      samples: async () => undefined,
      getAudioContext: () => ({ state: 'running' }),
      evaluate: async (code: string) => {
        if (evaluateError) throw evaluateError;
        strudel.evaluated = code;
        return { pattern: code };
      },
      hush: () => undefined,
    };
    return strudel;
  }

  it('strudel, booted', async () => {
    const strudel = fakeStrudel(0);
    const { page } = shellPage(GenericWrapper.wrap('note("c3 e3")', { domain: 'strudel' }), { strudel });
    const result = await trigger(page, 'strudel');
    await settle();
    expect(result.started).toBe(true);
    expect(strudel.evaluated).toContain('note("c3 e3")');
  });

  it('strudel, still loading its sample banks at the first press', async () => {
    const strudel = fakeStrudel(70);
    const { page } = shellPage(GenericWrapper.wrap('note("c3 e3")', { domain: 'strudel' }), { strudel });
    const result = await trigger(page, 'strudel');
    await settle();
    expect(result.started).toBe(true);
    expect(strudel.evaluated).toContain('note("c3 e3")');
  });

  it('a page without the shell play button has no accessible control, whatever other buttons it has', async () => {
    const { page } = shellPage('<!DOCTYPE html><html><body><button>Share</button></body></html>', {});
    const result = await trigger(page, 'tone');
    expect(result.controlsAccessible).toBe(false);
    expect(result.started).toBe(false);
  });

  it('strudel whose pattern fails to evaluate is not started', async () => {
    const strudel = fakeStrudel(0, new Error('note is not defined'));
    const { page } = shellPage(GenericWrapper.wrap('note("c3 e3")', { domain: 'strudel' }), { strudel });
    expect((await trigger(page, 'strudel')).started).toBe(false);
  });

  // The real REPL catches the error, logs it and resolves with no pattern.
  it('strudel whose pattern throws inside the REPL is not started', async () => {
    const strudel = { ...fakeStrudel(0), evaluate: async () => undefined };
    const { page } = shellPage(GenericWrapper.wrap('note("c3").undefinedMethod()', { domain: 'strudel' }), { strudel });
    expect((await trigger(page, 'strudel')).started).toBe(false);
  });

  it('a Tone page whose play() is only called, never clicked, is not started', async () => {
    const Tone = { ...fakeTone(), start: async () => undefined };
    const { page } = shellPage('<!DOCTYPE html><html><body><script>function play() {}</script></body></html>', { Tone });
    expect((await trigger(page, 'tone')).started).toBe(false);
  });

  it('a Tone page that keeps Tone off window counts once a context it made runs', async () => {
    const context = { state: 'suspended' };
    const code = toneHtml(`<button id="go">Play</button>
<script>document.getElementById('go').addEventListener('click', () => { window.__ctx.state = 'running'; });</script>`);
    const { page } = shellPage(GenericWrapper.wrap(code, { domain: 'tone' }), {
      Tone: { ...fakeTone(), context: { state: 'suspended' }, start: async () => undefined },
      __ctx: context,
      __audioCaptureDestinations: [{ context }],
    });
    expect((await trigger(page, 'tone')).started).toBe(true);
  });

  it('a strudel boot error stops the presses', async () => {
    const strudel = { ...fakeStrudel(0), initStrudel: () => Promise.reject(new Error('booting the worklet failed')) };
    const { page } = shellPage(GenericWrapper.wrap('note("c3 e3")', { domain: 'strudel' }), { strudel });
    let presses = 0;
    const click = page.click;
    page.click = async (selector: string) => { presses += 1; await click(selector); };
    await settle();
    expect((await trigger(page, 'strudel')).started).toBe(false);
    expect(presses).toBe(1);
  });

  it('strudel that never boots is not started', async () => {
    const strudel = { ...fakeStrudel(0), initStrudel: () => Promise.reject(new Error('audio worklet failed')) };
    const { page } = shellPage(GenericWrapper.wrap('note("c3 e3")', { domain: 'strudel' }), { strudel });
    expect((await trigger(page, 'strudel')).started).toBe(false);
  });
});
