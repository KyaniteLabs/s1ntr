import { describe, expect, it } from 'vitest';
import { JSDOM, VirtualConsole } from 'jsdom';
import { GenericWrapper } from '../../../src/core/wrappers/GenericWrapper';
import { musicRuntimeScript, STRUDEL_PATTERN_NOOPS, STRUDEL_SAMPLE_BANKS } from '../../../src/core/wrappers/musicRuntime';
import { HeadlessRenderer } from '../../../src/render/HeadlessRenderer';

/**
 * #1732: the playable page and the judge's renderer run ONE music runtime, so
 * the judge scores what a viewer hears. These tests load the page the way the
 * viewer gets it and the way the judge gets it (capture script first).
 */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

function fakeStrudel() {
  const calls = { init: 0, banks: [] as string[], evaluated: 0 };
  function Pattern(this: unknown) { /* fake */ }
  const strudel = {
    Pattern,
    initStrudel: async () => { calls.init += 1; },
    samples: async (u: string) => { calls.banks.push(u); },
    getAudioContext: () => ({ state: 'running' }),
    evaluate: async () => { calls.evaluated += 1; return {}; },
    hush: () => undefined,
  };
  return { strudel, calls };
}

function load(html: string) {
  const { strudel, calls } = fakeStrudel();
  const dom = new JSDOM(html, {
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    virtualConsole: new VirtualConsole(),
    beforeParse(window) {
      const pen = new Proxy({}, { get: () => () => undefined, set: () => true });
      window.HTMLCanvasElement.prototype.getContext = (() => pen) as never;
      Object.assign(window, { __sinterDrawScope: () => undefined, setcps: () => undefined, strudel });
    },
  });
  return { window: dom.window as unknown as Record<string, unknown> & { document: Document }, calls, strudel };
}

const captureScript = (HeadlessRenderer as unknown as { audioCaptureScript(ms: number): string }).audioCaptureScript(1000);

describe('one music runtime for viewer and judge (#1732)', () => {
  it('the renderer injects the same runtime script the playable page embeds', () => {
    const page = GenericWrapper.wrap('s("bd")', { domain: 'strudel' });
    expect(page).toContain(musicRuntimeScript());
    expect(captureScript.startsWith(musicRuntimeScript())).toBe(true);
  });

  it('viewer page: invented Pattern tempo methods become no-ops and every bank loads once', async () => {
    const p = load(GenericWrapper.wrap('s("bd").bpm(120)', { domain: 'strudel' }));
    await settle(); await settle();
    const proto = (p.strudel.Pattern as unknown as { prototype: Record<string, unknown> }).prototype;
    for (const m of STRUDEL_PATTERN_NOOPS) expect(typeof proto[m]).toBe('function');
    const pat = {};
    expect((proto.bpm as (this: unknown, v: number) => unknown).call(pat, 120)).toBe(pat);
    expect(p.calls.init).toBe(1);
    expect(p.calls.banks).toEqual([...STRUDEL_SAMPLE_BANKS]);
  });

  it('judge path (runtime injected first) boots once and the page still becomes ready', async () => {
    const html = GenericWrapper.wrap('s("bd")', { domain: 'strudel' }).replace('<head>', '<head>' + captureScript);
    const p = load(html);
    await settle(); await settle(); await settle();
    expect(p.calls.init).toBe(1);
    expect(p.calls.banks).toEqual([...STRUDEL_SAMPLE_BANKS]);
    expect(p.window.document.getElementById('sinter-strudel-status')?.textContent).toBe('Ready.');
  });

  it('keeps a Pattern method Strudel already has', async () => {
    const { strudel } = fakeStrudel();
    const own = function own() { return 'own'; };
    (strudel.Pattern as unknown as { prototype: Record<string, unknown> }).prototype.tempo = own;
    const dom = new JSDOM('<!doctype html><body>' + musicRuntimeScript(), {
      runScripts: 'dangerously', virtualConsole: new VirtualConsole(),
      beforeParse(window) { Object.assign(window, { strudel }); },
    });
    await settle();
    expect((strudel.Pattern as unknown as { prototype: Record<string, unknown> }).prototype.tempo).toBe(own);
    dom.window.close();
  });
});
