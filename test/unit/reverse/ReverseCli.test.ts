import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { applyReverseBrief } from '../../../src/reverse/ReverseBrief.js';
import { parseReverseFlags, prepareReverse, writeReverseProvenance }
  from '../../../src/cli/ReverseCli.js';

const fx = (n: string) => path.resolve('test/fixtures/reverse', n);
const tmp = mkdtempSync(path.join(tmpdir(), 'reverse-cli-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const ARC_JSON = JSON.stringify({ sections: [
  { t_start: 0, t_end: 30, energy: 0.2, label: 'calm' },
  { t_start: 30, t_end: 100, energy: 0.9, label: 'rise' },
  { t_start: 100, t_end: 112.4, energy: 0.3, label: 'out' }],
cues: [{ t: 112.4, kind: 'hit' }] });

function fakeVision(arcJson: string) {
  const calls: Array<{ system: string; user: string; images: Array<{ mimeType: string; dataBase64: string; width?: number }> }> = [];
  return {
    calls,
    client: {
      generateWithImages: vi.fn(async (system: string, user: string, images: Array<{ mimeType: string; dataBase64: string; width?: number }>) => {
        calls.push({ system, user, images });
        return { code: arcJson, success: true };
      }),
    },
  };
}

describe('parseReverseFlags', () => {
  it('collects repeated --ref, --arc, --duration, --cues', () => {
    expect(parseReverseFlags({ ref: ['a.wav', 'b.wav'], arc: 'arc.json', duration: '112.4', cues: 'c.json' }))
      .toEqual({ refs: ['a.wav', 'b.wav'], arcPath: 'arc.json', duration: 112.4, cuesPath: 'c.json' });
  });
  it('returns null when no reverse flag is present', () => {
    expect(parseReverseFlags({})).toBeNull();
  });
  it('accepts a single --ref string', () => {
    expect(parseReverseFlags({ ref: 'a.wav' })?.refs).toEqual(['a.wav']);
  });
  it('rejects bad durations and empty values loudly', () => {
    expect(() => parseReverseFlags({ ref: 'a.wav', duration: 'abc' })).toThrow(/--duration must be a positive number of seconds/);
    expect(() => parseReverseFlags({ ref: 'a.wav', duration: '0' })).toThrow(/--duration/);
    expect(() => parseReverseFlags({ duration: '-5' })).toThrow(/--duration/);
    expect(() => parseReverseFlags({ ref: true as never })).toThrow(/--ref needs a file path/);
    expect(() => parseReverseFlags({ arc: true as never })).toThrow(/--arc needs a file path/);
  });
  it('bounds --duration to 1..600 seconds so a typo cannot start an endless render', () => {
    expect(() => parseReverseFlags({ duration: '1e9' })).toThrow('--duration must be between 1 and 600 seconds (got 1e9)');
    expect(() => parseReverseFlags({ duration: '86400' })).toThrow(/between 1 and 600 seconds/);
    expect(() => parseReverseFlags({ duration: '0.001' })).toThrow(/between 1 and 600 seconds/);
    expect(parseReverseFlags({ duration: '600' })?.duration).toBe(600);
    expect(parseReverseFlags({ duration: '1' })?.duration).toBe(1);
  });
});

describe('prepareReverse', () => {
  it('two wavs + arc.json: brief carries the cards and arc, never the bytes', async () => {
    const arcPath = path.join(tmp, 'arc.json');
    writeFileSync(arcPath, ARC_JSON);
    const { brief, notices } = await prepareReverse({
      refs: [fx('song-a-150bpm-cmaj.wav'), fx('song-b-100bpm-amin.wav')], arcPath, duration: 112.4 });
    const prompt = applyReverseBrief('score for the launch reel', brief);
    expect(prompt.startsWith('score for the launch reel')).toBe(true);
    expect(prompt).toContain('song-a-150bpm-cmaj.wav');
    expect(prompt).toMatch(/tempo \d+ BPM, key C major/);
    expect(prompt).toMatch(/tempo \d+ BPM, key A minor/);
    expect(prompt).toContain('0-30s energy 0.2 "calm"');
    expect(prompt).toContain('30-100s energy 0.9 "rise"');
    expect(prompt).toContain('hit at 112.4s');
    expect(prompt).toContain('112.4 seconds');
    expect(notices.join('\n')).toContain('Arc (from arc.json)');
    // privacy: no raw or base64 reference bytes in the prompt
    for (const name of ['song-a-150bpm-cmaj.wav', 'song-b-100bpm-amin.wav']) {
      const bytes = readFileSync(fx(name));
      expect(prompt).not.toContain(bytes.subarray(44, 400).toString('base64').slice(0, 80));
    }
    expect(prompt).not.toMatch(/[A-Za-z0-9+/=]{200,}/);
  });

  it('provenance records sha256 + feature card per reference, and the arc', async () => {
    const arcPath = path.join(tmp, 'arc2.json');
    writeFileSync(arcPath, ARC_JSON);
    const { brief } = await prepareReverse({ refs: [fx('storyboard.png'), fx('brief.md')], arcPath, duration: 112.4 });
    const prov = brief.provenance;
    expect(prov.schema).toBe('sinter-reverse-provenance-v1');
    expect(prov.references.map((r) => [r.file, r.kind, r.sha256.length])).toEqual([
      ['storyboard.png', 'image', 64], ['brief.md', 'text', 64]]);
    expect(prov.references[1].features).toMatchObject({ words: 11 });
    expect(prov.arc.sections).toHaveLength(3);
    expect(prov.arcSource).toBe('file:arc2.json');
    expect(prov.durationSec).toBe(112.4);
    const out = await writeReverseProvenance(tmp, prov);
    expect(path.basename(out)).toBe('reverse-provenance.json');
    expect(JSON.parse(readFileSync(out, 'utf8')).references[0].sha256).toBe(prov.references[0].sha256);
  });

  it('with no --arc, derives the arc from the audio card scaled to --duration', async () => {
    const { brief, notices } = await prepareReverse({ refs: [fx('song-a-150bpm-cmaj.wav')], duration: 60 });
    expect(brief.provenance.arcSource).toBe('derived:song-a-150bpm-cmaj.wav');
    const sections = brief.provenance.arc.sections;
    expect(sections).toHaveLength(3);
    expect(sections[0].t_start).toBe(0);
    expect(sections[2].t_end).toBe(60);
    expect(notices.join('\n')).toContain('Arc (derived from song-a-150bpm-cmaj.wav)');
  });

  it('references without any arc source still make a brief (arc is null, cards still feed the prompt)', async () => {
    const { brief } = await prepareReverse({ refs: [fx('brief.md'), fx('storyboard.png')], duration: 30 });
    expect(brief.provenance.arc).toBeNull();
    expect(brief.provenance.arcSource).toBe('none');
    const prompt = applyReverseBrief('mood piece', brief);
    expect(prompt).toContain('headings: Launch reel > Opening, Drop, Tail');
    expect(prompt).toContain('30 seconds');
    expect(prompt).not.toContain('Energy arc');
  });

  it('cues file is merged into the arc', async () => {
    const arcPath = path.join(tmp, 'arc3.json');
    writeFileSync(arcPath, ARC_JSON);
    const cuesPath = path.join(tmp, 'cues.json');
    writeFileSync(cuesPath, '[{"t":30,"kind":"drop"}]');
    const { brief } = await prepareReverse({ refs: [], arcPath, cuesPath, duration: 112.4 });
    expect(brief.provenance.arc.cues).toEqual([{ t: 112.4, kind: 'hit' }, { t: 30, kind: 'drop' }]);
  });

  it('svg --arc becomes the arc deterministically, scaled to --duration, with no model call', async () => {
    const vision = fakeVision('{}');
    const { brief } = await prepareReverse({ refs: [], arcPath: fx('arc-diagram.svg'), duration: 100, visionClient: vision.client });
    expect(vision.client.generateWithImages).not.toHaveBeenCalled();
    const s = brief.provenance.arc.sections;
    expect(s[0].t_start).toBe(0);
    expect(s[s.length - 1].t_end).toBe(100);
    expect(s.map((x) => x.label)).toEqual(['Intro', 'Climax', 'Outro']);
    expect(s[1].energy).toBeGreaterThan(s[0].energy);
    expect(s[1].energy).toBeGreaterThan(s[2].energy);
  });

  it('image --arc goes through the vision lane, is downscaled, and the derived arc is printed', async () => {
    const big = path.join(tmp, 'big-storyboard.png');
    await sharp({ create: { width: 2400, height: 1200, channels: 3, background: { r: 10, g: 200, b: 90 } } }).png().toFile(big);
    const vision = fakeVision('```json\n' + ARC_JSON + '\n```');
    const { brief, notices } = await prepareReverse({ refs: [], arcPath: big, duration: 112.4, visionClient: vision.client });
    expect(brief.provenance.arc.sections.map((s) => s.label)).toEqual(['calm', 'rise', 'out']);
    expect(brief.provenance.arcSource).toBe('vision:big-storyboard.png');
    expect(vision.calls).toHaveLength(1);
    expect(vision.calls[0].images).toHaveLength(1);
    const sent = vision.calls[0].images[0];
    const sentMeta = await sharp(Buffer.from(sent.dataBase64, 'base64')).metadata();
    expect(Math.max(sentMeta.width ?? 0, sentMeta.height ?? 0)).toBeLessThanOrEqual(768);
    expect(sent.dataBase64).not.toBe(readFileSync(big).toString('base64'));
    const text = notices.join('\n');
    expect(text).toContain('downscaled');
    expect(text).toMatch(/2400x1200 to 768x384/);
    expect(text).toContain('rise');
    expect(text).not.toContain('"label"');
    expect(vision.calls[0].user).toContain('112.4');
  });

  it('privacy: no provider request carries --ref bytes; only the --arc image is sent, once', async () => {
    const refImage = fx('storyboard.png');
    const arcImage = path.join(tmp, 'arc-board.png');
    await sharp({ create: { width: 900, height: 300, channels: 3, background: { r: 200, g: 30, b: 30 } } }).png().toFile(arcImage);
    const vision = fakeVision(ARC_JSON);
    const { brief } = await prepareReverse({
      refs: [refImage, fx('song-a-150bpm-cmaj.wav'), fx('arc-diagram.svg')],
      arcPath: arcImage, duration: 112.4, visionClient: vision.client });
    const prompt = applyReverseBrief('score it', brief);
    const refB64 = readFileSync(refImage).toString('base64');
    const wavB64 = readFileSync(fx('song-a-150bpm-cmaj.wav')).toString('base64');
    const everythingSent = JSON.stringify({ calls: vision.calls, prompt });
    expect(vision.calls).toHaveLength(1);
    expect(vision.calls[0].images).toHaveLength(1);
    for (const chunk of [refB64, wavB64]) {
      expect(everythingSent).not.toContain(chunk.slice(0, 120));
      expect(everythingSent).not.toContain(chunk.slice(chunk.length - 160, chunk.length - 40));
    }
    expect(vision.calls[0].images[0].dataBase64).not.toBe(refB64);
    expect(prompt).not.toMatch(/[A-Za-z0-9+/=]{200,}/);
  });

  it('refuses an image arc when the model cannot see images, instead of letting it guess an arc from text', async () => {
    const vision = fakeVision('{"sections":[{"t_start":0,"t_end":60,"energy":0.5,"label":"all"}],"cues":[]}');
    const textOnly = { ...vision.client, resolveEffectiveModel: async () => 'glm-5.3' };
    await expect(prepareReverse({ refs: [], arcPath: fx('storyboard.png'), duration: 60, visionClient: textOnly }))
      .rejects.toThrow(/REVERSE_VISION_NOT_CAPABLE: storyboard\.png: glm-5\.3 cannot see images/);
    expect(vision.calls).toHaveLength(0);
    const seeing = { ...vision.client, resolveEffectiveModel: async () => 'glm-4.6v' };
    const { brief } = await prepareReverse({ refs: [], arcPath: fx('storyboard.png'), duration: 60, visionClient: seeing });
    expect(brief.provenance.arc.sections).toHaveLength(1);
    expect(vision.calls).toHaveLength(1);
  });

  it('fails loudly: image/svg arc without --duration, bad vision JSON, arc/duration mismatch, missing ref', async () => {
    await expect(prepareReverse({ refs: [], arcPath: fx('arc-diagram.svg') })).rejects.toThrow(/REVERSE_DURATION_REQUIRED.*arc-diagram\.svg/);
    await expect(prepareReverse({ refs: [], arcPath: fx('storyboard.png'), duration: 60, visionClient: fakeVision('not json').client }))
      .rejects.toThrow(/REVERSE_ARC_INVALID.*vision:storyboard\.png/);
    await expect(prepareReverse({ refs: [], arcPath: fx('storyboard.png'), duration: 60 }))
      .rejects.toThrow(/REVERSE_VISION_CLIENT_MISSING/);
    await expect(prepareReverse({ refs: [], arcPath: fx('arc.json'), duration: 112.4 }))
      .rejects.toThrow(/REVERSE_ARC_DURATION_MISMATCH.*60.*112\.4/);
    await expect(prepareReverse({ refs: [path.join(tmp, 'gone.wav')], duration: 10 })).rejects.toThrow(/REVERSE_REF_MISSING.*gone\.wav/);
    await expect(prepareReverse({ refs: [], arcPath: path.join(tmp, 'nope.json') })).rejects.toThrow(/REVERSE_ARC_UNREADABLE.*nope\.json/);
  });
});

describe('prepareReverse: printed arc and cue checks', () => {
  const arcPath = path.join(tmp, 'arc-print.json');
  writeFileSync(arcPath, ARC_JSON);

  it('prints the arc after --cues are merged, as a compact table', async () => {
    const cuesPath = path.join(tmp, 'cues-print.json');
    writeFileSync(cuesPath, '[{"t":30,"kind":"drop"},{"t":60,"kind":"cut"}]');
    const { notices } = await prepareReverse({ refs: [], arcPath, cuesPath, duration: 112.4 });
    const arcText = notices.find((n) => n.startsWith('Arc ('));
    expect(arcText).toBe([
      'Arc (from arc-print.json + cues from cues-print.json), 112.4 s:',
      '     0.0-30.0 s  energy 0.20 ##          calm',
      '   30.0-100.0 s  energy 0.90 #########   rise',
      '  100.0-112.4 s  energy 0.30 ###         out',
      '  cues: drop 30 s, cut 60 s, hit 112.4 s',
    ].join('\n'));
  });

  it('rejects a cue past the end of the arc, naming the cues file', async () => {
    const cuesPath = path.join(tmp, 'cues-late.json');
    writeFileSync(cuesPath, '[{"t":999,"kind":"hit"}]');
    await expect(prepareReverse({ refs: [], arcPath, cuesPath, duration: 112.4 }))
      .rejects.toThrow('REVERSE_CUES_OUT_OF_RANGE: cues-late.json: cue hit at 999s is after the arc ends at 112.4s');
  });

  it('refuses a symlinked --arc or --cues file instead of reading through it', async () => {
    const link = path.join(tmp, 'arc-link.json');
    symlinkSync(arcPath, link);
    await expect(prepareReverse({ refs: [], arcPath: link, duration: 112.4 }))
      .rejects.toThrow(/REVERSE_ARC_UNREADABLE: arc-link\.json: is a symlink/);
    const cuesLink = path.join(tmp, 'cues-link.json');
    symlinkSync('/etc/passwd', cuesLink);
    await expect(prepareReverse({ refs: [], arcPath, cuesPath: cuesLink, duration: 112.4 }))
      .rejects.toThrow(/REVERSE_CUES_UNREADABLE: cues-link\.json: is a symlink/);
  });

  it('a non-svg .svg --arc fails with the arc error code and file name', async () => {
    const bad = path.join(tmp, 'plain.svg');
    writeFileSync(bad, 'hello');
    await expect(prepareReverse({ refs: [], arcPath: bad, duration: 20 }))
      .rejects.toThrow(/REVERSE_ARC_INVALID: plain\.svg: no <svg> root element/);
  });

  it('the printed arc names a phrase-out ending', async () => {
    const p = path.join(tmp, 'arc-phrase.json');
    writeFileSync(p, JSON.stringify({ ...JSON.parse(ARC_JSON), cues: [], ending: 'phrase-out' }));
    const { notices } = await prepareReverse({ refs: [], arcPath: p, duration: 112.4 });
    expect(notices.at(-1)?.split('\n').slice(-2)).toEqual(['  cues: none', '  ending: phrase-out']);
  });
});
