import { describe, expect, it } from 'vitest';
import { JSDOM } from 'jsdom';
import { GenericWrapper } from '../../../src/core/wrappers/GenericWrapper';
import { HeadlessRenderer } from '../../../src/render/HeadlessRenderer';

/**
 * #1769: the judge's renderer defined bpm() but the viewer page did not, so
 * pieces that call bpm() scored as music and were silent for a listener. Both
 * pages must now give bpm() the same meaning: Strudel's four beats per cycle,
 * so bpm(n) is setcpm(n / 4), i.e. n / 240 cycles per second.
 */
type Win = Record<string, unknown> & { bpm?: (n: number) => unknown; setbpm?: (n: number) => unknown };

function boot(html: string, preset: Record<string, unknown> = {}): { win: Win; cps: number[] } {
  const cps: number[] = [];
  const dom = new JSDOM(html, {
    runScripts: 'dangerously',
    beforeParse(window) {
      // The page sees setcps only once Strudel is up; bpm must look it up at call time.
      Object.assign(window, { AudioContext: class {}, strudel: { initStrudel: async () => undefined } }, preset);
      setTimeout(() => { (window as unknown as Win).setcps = (v: number) => { cps.push(v); }; }, 0);
    },
  });
  return { win: dom.window as unknown as Win, cps };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 5));
const viewer = () => GenericWrapper.wrap('note("c3")', { domain: 'strudel' });
const judge = () =>
  (HeadlessRenderer as unknown as { audioCaptureScript(ms: number): string }).audioCaptureScript(1000) +
  '<p>piece</p>';

describe('Strudel tempo contract (#1769)', () => {
  it.each([['viewer page', viewer], ['judge render page', judge]])('%s defines bpm() and setbpm()', async (_, page) => {
    const { win } = boot(page());
    expect(typeof win.bpm).toBe('function');
    expect(typeof win.setbpm).toBe('function');
  });

  it('viewer and judge hear the same tempo for the same bpm()', async () => {
    const heard = [];
    for (const page of [viewer, judge]) {
      const { win, cps } = boot(page());
      await tick();
      win.bpm!(72);
      win.setbpm!(120);
      heard.push(cps);
    }
    expect(heard[0]).toEqual([72 / 240, 0.5]);
    expect(heard[1]).toEqual(heard[0]);
  });

  it('bpm(n) matches the setcpm(n / 4) idiom other accepted pieces use', async () => {
    const { win, cps } = boot(viewer());
    await tick();
    win.bpm!(60);
    expect(cps[0] * 60).toBeCloseTo(60 / 4);
  });

  it('ignores nonsense tempos instead of stopping the clock', async () => {
    const { win, cps } = boot(viewer());
    await tick();
    for (const bad of [0, -10, Number.NaN, 'fast']) win.bpm!(bad as number);
    expect(cps).toEqual([]);
  });

  it('keeps a bpm() the page already has', () => {
    const own = () => 'own';
    const { win } = boot(viewer(), { bpm: own });
    expect(win.bpm).toBe(own);
  });
});
