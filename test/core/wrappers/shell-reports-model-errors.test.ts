import { describe, expect, it } from 'vitest';
import { JSDOM, VirtualConsole } from 'jsdom';
import { GenericWrapper } from '../../../src/core/wrappers/GenericWrapper';
import { ToneGenerator } from '../../../src/generators/tone/ToneGenerator';

/**
 * A preview shell may catch an error the artwork throws, so the page keeps its
 * controls. It must still report the error as a console error: that is what
 * the renderer counts as a page error, and what the repair loop reads. A
 * caught error that only reaches console.warn or the status line makes a
 * broken, silent piece look clean (Kaggle v2-v4: 13 silent Tone renders).
 */
type Page = { errors: string[]; window: JSDOM['window'] };

function load(html: string, globals: Record<string, unknown>): Page {
  const errors: string[] = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('error', (...args: unknown[]) => errors.push(args.map(String).join(' ')));
  // An uncaught error is a page error to the renderer too.
  virtualConsole.on('jsdomError', (error: Error) => errors.push(`uncaught: ${error.message}`));
  const dom = new JSDOM(html, {
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    virtualConsole,
    beforeParse(window) {
      const pen = new Proxy({}, { get: () => () => undefined, set: () => true });
      window.HTMLCanvasElement.prototype.getContext = (() => pen) as never;
      Object.assign(window, globals, { __sinterDrawScope: () => undefined });
    },
  });
  return { errors, window: dom.window };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

function fakeTone(start: () => Promise<unknown> = async () => undefined) {
  return {
    start,
    Transport: { bpm: { value: 120 }, state: 'stopped', start() { this.state = 'started'; }, stop() {} },
  };
}

function fakeStrudel(evaluate: () => Promise<unknown>, boot: () => Promise<unknown> = async () => undefined) {
  return {
    initStrudel: boot,
    samples: async () => undefined,
    getAudioContext: () => ({ state: 'running' }),
    evaluate,
    hush: () => undefined,
  };
}

describe('preview shells report the errors they catch', () => {
  it('tone: an artwork that throws at load is a console error', () => {
    const page = load(GenericWrapper.wrap('Tone.Transport();', { domain: 'tone' }), { Tone: fakeTone() });
    expect(page.errors.join('\n')).toMatch(/Tone\.Transport is not a function/);
  });

  it('tone: an artwork that runs is not an error', () => {
    const page = load(GenericWrapper.wrap('const bpm = Tone.Transport.bpm.value;', { domain: 'tone' }), { Tone: fakeTone() });
    expect(page.errors).toEqual([]);
  });

  it('tone: a play() that throws on Play is a console error', async () => {
    const page = load(GenericWrapper.wrap('function play() { new Tone.Reverb().sampler(); }', { domain: 'tone' }), {
      Tone: { ...fakeTone(), Reverb: class {} },
    });
    expect(page.errors).toEqual([]);
    page.window.document.getElementById('start')!.click();
    await settle();
    expect(page.errors.join('\n')).toMatch(/sampler is not a function/);
  });

  // Autoplay policy can refuse the audio context in a page that never got a
  // gesture. That is the page, not the artwork, so a healthy piece stays clean.
  const refused = () => Promise.reject(new Error('The AudioContext was not allowed to start'));

  it('tone: a refused audio context is not an artwork error', async () => {
    const page = load(GenericWrapper.wrap('function play() {}', { domain: 'tone' }), { Tone: fakeTone(refused) });
    page.window.document.getElementById('start')!.click();
    await settle();
    expect(page.errors).toEqual([]);
  });

  it('tone html: a refused audio context is not an artwork error', async () => {
    const html = `<!DOCTYPE html><html><head><script src="https://unpkg.com/tone@14.8.49/build/Tone.js"></script></head>
<body><script>function play() {}</script></body></html>`;
    const page = load(GenericWrapper.wrap(html, { domain: 'tone' }), { Tone: fakeTone(refused) });
    page.window.document.getElementById('sinter-tone-start')!.click();
    await settle();
    expect(page.errors).toEqual([]);
  });

  it('tone gallery page: a refused audio context is not an artwork error', async () => {
    const page = load(new ToneGenerator().wrapForGallery('function play() {}'), { Tone: fakeTone(refused) });
    page.window.document.getElementById('playBtn')!.click();
    await settle();
    expect(page.errors).toEqual([]);
  });

  it('tone html: an inline script that throws is a console error', () => {
    const html = `<!DOCTYPE html><html><head><script src="https://unpkg.com/tone@14.8.49/build/Tone.js"></script></head>
<body><script>Tone.Part.createPart();</script></body></html>`;
    const page = load(GenericWrapper.wrap(html, { domain: 'tone' }), { Tone: { ...fakeTone(), Part: {} } });
    expect(page.errors.join('\n')).toMatch(/createPart is not a function/);
  });

  it('tone html: a play() that throws on start is a console error', async () => {
    const html = `<!DOCTYPE html><html><head><script src="https://unpkg.com/tone@14.8.49/build/Tone.js"></script></head>
<body><script>function play() { new Tone.Reverb().sampler(); }</script></body></html>`;
    const page = load(GenericWrapper.wrap(html, { domain: 'tone' }), { Tone: { ...fakeTone(), Reverb: class {} } });
    expect(page.errors).toEqual([]);
    page.window.document.getElementById('sinter-tone-start')!.click();
    await settle();
    expect(page.errors.join('\n')).toMatch(/sampler is not a function/);
  });

  it('strudel: a pattern that fails to evaluate is a console error', async () => {
    const strudel = fakeStrudel(() => Promise.reject(new Error("missing ) after argument list")));
    const page = load(GenericWrapper.wrap('note("c3").fast(', { domain: 'strudel' }), { strudel });
    await settle();
    page.window.document.getElementById('sinter-strudel-play')!.click();
    await settle();
    expect(page.errors.join('\n')).toMatch(/missing \) after argument list/);
  });

  it('strudel: a pattern that evaluates is not an error', async () => {
    const page = load(GenericWrapper.wrap('note("c3")', { domain: 'strudel' }), { strudel: fakeStrudel(async () => ({ pattern: 'c3' })) });
    await settle();
    page.window.document.getElementById('sinter-strudel-play')!.click();
    await settle();
    expect(page.errors).toEqual([]);
  });

  it('strudel: a failed boot is shell trouble, not an artwork error', async () => {
    const strudel = fakeStrudel(async () => undefined, () => Promise.reject(new Error('audio worklet failed')));
    const page = load(GenericWrapper.wrap('note("c3")', { domain: 'strudel' }), { strudel });
    await settle();
    expect(page.errors).toEqual([]);
    expect(page.window.document.body.textContent).toMatch(/Boot error: audio worklet failed/);
  });

  it('hyperframes: a timeline that throws is a console error', () => {
    const shell = GenericWrapper.wrap('<div data-composition-id="c"></div>', { domain: 'hyperframes' });
    const srcdoc = /srcdoc="([^"]*)"/.exec(shell)![1]
      .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&');
    const timeline = { progress() { throw new Error('onUpdate: target is null'); } };
    const page = load(srcdoc, { __timelines: { main: timeline }, setTimeout: (run: () => void) => { run(); return 0; } });
    expect(page.errors.join('\n')).toMatch(/target is null/);
  });

  it('tone gallery page: a patch that throws on play is a console error', async () => {
    const page = load(new ToneGenerator().wrapForGallery('Tone.Transport();'), { Tone: fakeTone() });
    page.window.document.getElementById('playBtn')!.click();
    await settle();
    expect(page.errors.join('\n')).toMatch(/Tone\.Transport is not a function/);
  });
});
