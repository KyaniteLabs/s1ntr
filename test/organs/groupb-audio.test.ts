/**
 * Organ group B, audio: a recording changes the brief that reaches the generator.
 * RAN: spawned built CLI `generate --voice-file` against the fake provider (no key, no network).
 * USED: two different recordings give two different generator briefs; no flag gives none.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { analyzeVoiceFile, buildVoiceBrief, describeVisualMapping, VOICE_BRIEF_HEADER } from '../../src/audio/VoiceBrief.js';
import { fakeProviderEnv, goodJudgeReply, LIVELY_HTML, runSinterAsync, startFakeProvider, type FakeProvider } from '../helpers/fakeProviderServer.js';

vi.setConfig({ testTimeout: 280_000 });

function wav(samples: Float32Array, rate = 44100): Buffer {
  const data = Buffer.alloc(samples.length * 2);
  samples.forEach((s, i) => data.writeInt16LE(Math.max(-1, Math.min(1, s)) * 32767, i * 2));
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + data.length, 4); h.write('WAVEfmt ', 8);
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write('data', 36); h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}
const tone = (hz: number, amp: number, sec = 2) =>
  Float32Array.from({ length: 44100 * sec }, (_, i) => amp * Math.sin((2 * Math.PI * hz * i) / 44100));
let seed = 7;
const noise = (amp: number, sec = 2) => Float32Array.from({ length: 44100 * sec }, () => { seed = (seed * 1664525 + 1013904223) >>> 0; return amp * (seed / 2 ** 31 - 1); });

let work: string; let low: string; let hiss: string;
beforeAll(() => {
  work = mkdtempSync(path.join(tmpdir(), 'sinter-groupb-audio-'));
  low = path.join(work, 'low.wav'); hiss = path.join(work, 'hiss.wav');
  writeFileSync(low, wav(tone(110, 0.3)));
  writeFileSync(hiss, wav(noise(0.8)));
});
afterAll(() => { rmSync(work, { recursive: true, force: true }); });

describe('audio organ: a recording becomes a brief', () => {
  it('different recordings give different briefs (palette, motion or form differ)', async () => {
    const a = buildVoiceBrief(await analyzeVoiceFile(low));
    const b = buildVoiceBrief(await analyzeVoiceFile(hiss));
    expect(a.startsWith(VOICE_BRIEF_HEADER)).toBe(true);
    expect(a).toMatch(/Palette:/); expect(a).toMatch(/Motion:/);
    expect(a).not.toBe(b);
  });

  it('shares one formatter with the legacy context builder', async () => {
    const m = await analyzeVoiceFile(low);
    const { buildContextForInjection } = await import('../../src/core/ContextBuilder.js');
    expect(typeof buildContextForInjection).toBe('function');
    expect(buildVoiceBrief(m)).toBe(VOICE_BRIEF_HEADER + describeVisualMapping(m));
  });

  it('long recordings reach the real feature extractor (no silent fallback warning)', async () => {
    const { extractFeatures } = await import('../../src/audio/AudioExtractor.js');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const f = extractFeatures(tone(440, 0.4, 2)); // 88200 samples, not a power of two
    const said = [...warn.mock.calls, ...err.mock.calls].flat().join(' ');
    warn.mockRestore(); err.mockRestore();
    expect(said).not.toMatch(/Feature extraction failed/);
    expect(f.spectralCentroid).toBeGreaterThan(0);
  });

  it('refuses an unreadable file instead of silently continuing', async () => {
    await expect(analyzeVoiceFile(path.join(work, 'missing.wav'))).rejects.toThrow(/VOICE_FILE_DECODE_FAILED/);
  });
});

describe('audio organ through the real CLI (fake provider)', () => {
  let fake: FakeProvider; let n = 0;
  beforeAll(async () => { fake = await startFakeProvider({ generate: () => LIVELY_HTML, judge: () => goodJudgeReply(0.8) }); });
  afterAll(async () => { await fake.close(); });

  async function gen(extra: string[]) {
    const i = n++;
    const env = fakeProviderEnv(fake, { home: path.join(work, `home${i}`), stateRoot: path.join(work, `state${i}`) });
    const before = fake.generated.length;
    const run = await runSinterAsync(['generate', '-o', path.join(work, `out${i}`), '--domain', 'html', ...extra, 'a slow orbit of colored light'], env);
    return { run, briefs: fake.generated.slice(before).map(c => c.user) };
  }

  it('with --voice-file the generator brief carries the audio block, and it differs per recording', async () => {
    const a = await gen(['--voice-file', low]);
    const b = await gen(['--voice-file', hiss]);
    expect(a.run.out).toMatch(/Voice brief/);
    expect(a.briefs[0]).toContain('Audio-derived visual parameters');
    expect(b.briefs[0]).toContain('Audio-derived visual parameters');
    expect(a.briefs[0]).not.toBe(b.briefs[0]);
  });

  it('bypassed (no flag): the generator brief has no audio block', async () => {
    const c = await gen([]);
    expect(c.briefs[0]).not.toContain('Audio-derived visual parameters');
  });
});
