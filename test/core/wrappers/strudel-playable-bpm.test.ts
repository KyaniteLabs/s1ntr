import { describe, expect, it } from 'vitest';
import { JSDOM, VirtualConsole } from 'jsdom';
import { GenericWrapper } from '../../../src/core/wrappers/GenericWrapper';

/**
 * Strudel has no global bpm(), yet S1NTR's retry prompt asks for one and the
 * judge's renderer shims it. Without the same global on the playable page, a
 * viewer gets "bpm is not defined" and silence for a piece the judge heard.
 */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

function load(html: string, extra: Record<string, unknown> = {}) {
  const cps: number[] = [];
  const dom = new JSDOM(html, {
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    virtualConsole: new VirtualConsole(),
    beforeParse(window) {
      const pen = new Proxy({}, { get: () => () => undefined, set: () => true });
      window.HTMLCanvasElement.prototype.getContext = (() => pen) as never;
      Object.assign(window, {
        __sinterDrawScope: () => undefined,
        setcps: (v: number) => { cps.push(v); },
        strudel: {
          initStrudel: async () => undefined,
          samples: async () => undefined,
          getAudioContext: () => ({ state: 'running' }),
          evaluate: async () => ({}),
          hush: () => undefined,
        },
      }, extra);
    },
  });
  return { window: dom.window as unknown as Record<string, unknown>, cps };
}

describe('strudel playable page: bpm() works as it does for the judge', () => {
  it('defines bpm() and setbpm() as tempo setters (the 1769 contract: bpm/240 cycles per second, 120 BPM = 0.5 cps)', async () => {
    const page = load(GenericWrapper.wrap('bpm(90)\ns("bd hh")', { domain: 'strudel' }));
    await settle(); await settle();
    expect(typeof page.window.bpm).toBe('function');
    expect(typeof page.window.setbpm).toBe('function');
    (page.window.bpm as (v: number) => void)(90);
    (page.window.setbpm as (v: number) => void)(120);
    expect(page.cps).toEqual([0.375, 0.5]);
  });

  it('ignores a non-positive tempo', async () => {
    const page = load(GenericWrapper.wrap('s("bd")', { domain: 'strudel' }));
    await settle(); await settle();
    (page.window.bpm as (v: unknown) => void)('x');
    (page.window.bpm as (v: number) => void)(0);
    expect(page.cps).toEqual([]);
  });

  it('keeps a bpm() the runtime already provides', async () => {
    const own = () => 'own';
    const page = load(GenericWrapper.wrap('s("bd")', { domain: 'strudel' }), { bpm: own });
    await settle(); await settle();
    expect(page.window.bpm).toBe(own);
  });
});
