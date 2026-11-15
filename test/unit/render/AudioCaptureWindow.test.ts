import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { audioCapturePageInit, HeadlessRenderer } from '../../../src/render/HeadlessRenderer.js';
import { measureLength } from '../../../src/reverse/RenderFit.js';
import { summarizeAudioCapture } from '../../../src/render/AudioEvidence.js';

type Processor = { onaudioprocess?: (e: { inputBuffer: { getChannelData: () => Float32Array } }) => void };

/** Minimal Web Audio stand-in: the page init subclasses window.AudioContext. */
class FakeAudioContext {
  static processors: Processor[] = [];
  static rate = 44_100;
  sampleRate = FakeAudioContext.rate;
  destination = {};
  createMediaStreamDestination() { return {}; }
  createScriptProcessor(): Processor & { connect: () => void } {
    const p = { connect: () => undefined };
    FakeAudioContext.processors.push(p);
    return p;
  }
  createGain() { return { gain: { value: 1 }, connect: () => undefined }; }
  createOscillator() { return { connect: () => undefined }; }
  createBufferSource() { return { connect: () => undefined }; }
}

const feed = (p: Processor, samples: number[]) =>
  p.onaudioprocess?.({ inputBuffer: { getChannelData: () => Float32Array.from(samples) } });

describe('audio capture window', () => {
  const g = globalThis as Record<string, unknown>;
  beforeEach(() => {
    vi.useFakeTimers();
    FakeAudioContext.processors = [];
    FakeAudioContext.rate = 44_100;
    g.window = { AudioContext: FakeAudioContext };
  });
  afterEach(() => {
    vi.useRealTimers();
    delete g.window;
    delete g.bpm;
    delete g.setbpm;
  });

  const capture = () => (g.window as { __audioCaptureData: number[] }).__audioCaptureData;

  it('opens at the first sound, so a late first note is not judged silent', () => {
    audioCapturePageInit(4);
    new (g.window as { AudioContext: new () => unknown }).AudioContext();
    const [proc] = FakeAudioContext.processors;

    feed(proc, [0, 0, 0, 0]);
    expect(capture()).toEqual([]);
    feed(proc, [0, 0, 0.5, -0.25]);
    feed(proc, [0, 0.125, 0.75]);

    expect(capture()).toEqual([0.5, -0.25, 0, 0.125]);
  });

  it('keeps nothing for a piece that never sounds', () => {
    audioCapturePageInit(4);
    new (g.window as { AudioContext: new () => unknown }).AudioContext();
    feed(FakeAudioContext.processors[0], [0, 0, 0, 0, 0, 0]);

    expect(capture()).toEqual([]);
  });
});

describe('capture sample rate', () => {
  const g = globalThis as Record<string, unknown>;
  const win = () => g.window as { __audioCaptureData: number[]; __audioCaptureRate?: number; AudioContext: new () => unknown };
  beforeEach(() => { vi.useFakeTimers(); FakeAudioContext.processors = []; g.window = { AudioContext: FakeAudioContext }; });
  afterEach(() => { vi.useRealTimers(); delete g.window; delete g.bpm; delete g.setbpm; FakeAudioContext.rate = 44_100; });

  it('records the rate of the context that produced the samples (48 kHz CoreAudio)', () => {
    FakeAudioContext.rate = 48_000;
    audioCapturePageInit(100);
    new (win().AudioContext)();
    feed(FakeAudioContext.processors[0], [0.5]);
    expect(win().__audioCaptureRate).toBe(48_000);
  });

  it('keeps a full window at 48 kHz instead of cutting it at the 44.1 kHz sample budget', () => {
    FakeAudioContext.rate = 48_000;
    audioCapturePageInit(44_100); // budget for a 1 s window, sized at 44.1 kHz
    new (win().AudioContext)();
    feed(FakeAudioContext.processors[0], new Array(48_000).fill(0.5));
    expect(win().__audioCaptureData.length).toBe(48_000);
  });
});

describe('HeadlessRenderer.captureAudio sample rate', () => {
  const g = globalThis as Record<string, unknown>;
  afterEach(() => { delete g.window; });
  const run = async (rate: number | undefined, count: number) => {
    g.window = { __audioCaptureData: new Array(count).fill(0.25), __audioCaptureWarnings: [],
      ...(rate === undefined ? {} : { __audioCaptureRate: rate }) };
    const page = {
      waitForTimeout: async () => undefined,
      evaluate: async (fn: (d: number) => unknown, arg: number) => fn(arg),
    };
    const call = (new HeadlessRenderer() as unknown as {
      captureAudio: (p: unknown, o: { stabilizationTime: number }) => Promise<{ samples: Float32Array; sampleRate: number; duration: number }>;
    }).captureAudio;
    return call.call(new HeadlessRenderer(), page, { stabilizationTime: 1000 });
  };

  it('reports the captured 48 kHz rate and keeps all 48000 samples of a 1 s window', async () => {
    const r = await run(48_000, 48_000);
    expect(r.sampleRate).toBe(48_000);
    expect(r.samples.length).toBe(48_000);
    expect(r.samples.length / r.sampleRate).toBe(1);
  });

  it('keeps 44.1 kHz for a context that reports it, and as the fallback when none was recorded', async () => {
    expect((await run(44_100, 44_100)).sampleRate).toBe(44_100);
    const fallback = await run(undefined, 44_100);
    expect(fallback.sampleRate).toBe(44_100);
    expect(fallback.samples.length).toBe(44_100);
  });
});

describe('length measurement follows the buffer rate', () => {
  const burst = (rate: number, seconds: number, total: number) => {
    const s = new Float32Array(Math.round(rate * total));
    s.fill(0.5, 0, Math.round(rate * seconds));
    return s;
  };
  it.each([44_100, 48_000])('measures 2.0 s of sound at %i Hz as 2.0 s', (rate) => {
    expect(measureLength(burst(rate, 2, 3), rate)).toBe(2);
  });
  it('would be 8.8% long if a 48 kHz buffer were labelled 44.1 kHz', () => {
    expect(measureLength(burst(48_000, 2, 3), 44_100)).toBeCloseTo(2.177, 3);
  });
});

describe('summarizeAudioCapture', () => {
  it('calls captured all-zero audio inaudible', () => {
    const summary = summarizeAudioCapture({
      samples: new Float32Array(8), sampleRate: 44_100, duration: 0.75, success: true, warnings: [],
    });
    expect(summary?.success).toBe(false);
    expect(summary?.peakAmplitude).toBe(0);
  });

  it('calls captured non-zero audio audible with its peak', () => {
    const summary = summarizeAudioCapture({
      samples: Float32Array.from([0, 0.5, -0.75]), sampleRate: 44_100, duration: 0.75, success: true, warnings: [],
    });
    expect(summary?.success).toBe(true);
    expect(summary?.peakAmplitude).toBe(0.75);
  });

  it('returns undefined when there was no capture', () => {
    expect(summarizeAudioCapture(undefined)).toBe(undefined);
  });
});
