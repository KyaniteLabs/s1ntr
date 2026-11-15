/**
 * FABLE-R3.6: Stop on a Tone piece must silence sound the piece started outside
 * the transport, not only the transport. Real wrapper code runs in a DOM with a
 * stand-in Tone that counts what Stop asked the audio context to do.
 */
import { describe, it, expect } from 'vitest';
import { JSDOM } from 'jsdom';
import { HTMLWrapper } from '../../src/utils/htmlWrapper.js';

const PIECE = 'window.osc = new Tone.Oscillator(440).toDestination().start();';
const FULL_PAGE = `<!DOCTYPE html><html><head><title>t</title></head><body><button>Play</button><script>${PIECE}</script></body></html>`;

function pressStop(html: string, stop: string, status: string, withContext = true) {
  const calls = { suspend: 0, transportStop: 0 };
  const dom = new JSDOM(html, {
    runScripts: 'dangerously',
    pretendToBeVisual: true, // gives the page requestAnimationFrame
    beforeParse(window) {
      // jsdom has no canvas; the shell's meter only needs calls that do nothing.
      const pen = new Proxy({}, { get: () => () => undefined, set: () => true });
      window.HTMLCanvasElement.prototype.getContext = (() => pen) as never;
      (window as unknown as { Tone: unknown }).Tone = {
        start: async () => undefined,
        ...(withContext ? { getContext: () => ({ rawContext: { suspend: () => { calls.suspend += 1; } } }) } : {}),
        Transport: {
          stop: () => { calls.transportStop += 1; }, cancel: () => undefined, start: () => undefined,
          bpm: { value: 120 }, state: 'stopped',
        },
        Oscillator: class { toDestination() { return this; } start() { return this; } },
      };
    },
  });
  const doc = dom.window.document;
  (doc.querySelector(stop) as HTMLElement).click();
  const result = { ...calls, status: doc.querySelector(status)?.textContent };
  dom.window.close();
  return result;
}

describe('Tone Stop silences the whole piece', () => {
  it('suspends the audio context when the piece code is wrapped', () => {
    const result = pressStop(HTMLWrapper.wrap(PIECE, { domain: 'tone' }), '#stop', '#status');
    expect(result).toEqual({ suspend: 1, transportStop: 1, status: 'Stopped' });
  });

  it('suspends the audio context when the model wrote a full Tone page', () => {
    const result = pressStop(HTMLWrapper.wrap(FULL_PAGE, { domain: 'tone' }), '#sinter-tone-stop', '#sinter-tone-status');
    expect(result).toEqual({ suspend: 1, transportStop: 1, status: 'Stopped.' });
  });

  it('still stops the transport and reports Stopped when Tone offers no context to suspend', () => {
    const result = pressStop(HTMLWrapper.wrap(PIECE, { domain: 'tone' }), '#stop', '#status', false);
    expect(result).toEqual({ suspend: 0, transportStop: 1, status: 'Stopped' });
  });
});
