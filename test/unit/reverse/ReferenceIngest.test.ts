import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { MAX_REFERENCE_BYTES, ReferenceIngestError, ingestReference, ingestReferences, readLocalFile }
  from '../../../src/reverse/ReferenceIngest.js';
import { describeCard } from '../../../src/reverse/ReverseBrief.js';

const fx = (n: string) => path.resolve('test/fixtures/reverse', n);
const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;
const tmp = mkdtempSync(path.join(tmpdir(), 'reverse-ingest-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe('audio feature cards (deterministic, no LLM)', () => {
  it('reads song A: 150 BPM within +-2, C major, per-bar energy, three sections', async () => {
    const card = await ingestReference(fx('song-a-150bpm-cmaj.wav'));
    const f = card.features as Record<string, any>;
    expect(card.kind).toBe('audio');
    expect(card.sha256).toBe(createHash('sha256').update(readFileSync(fx('song-a-150bpm-cmaj.wav'))).digest('hex'));
    expect(Math.abs(f.bpm - 150)).toBeLessThanOrEqual(2);
    expect(f.key).toBe('C major');
    expect(f.mode).toBe('major');
    expect(f.durationSec).toBeCloseTo(9.6, 1);
    expect(f.barEnergy).toHaveLength(6);
    // bars 3-4 are the loud section, bars 1-2 the quiet one
    expect(f.barEnergy[2]).toBeGreaterThan(f.barEnergy[0] * 2);
    expect(f.barEnergy[2]).toBeGreaterThan(0.9);
    expect(f.sections).toHaveLength(3);
    expect(f.sections.map((s: { energy: number }) => s.energy > 0.7)).toEqual([false, true, false]);
    expect(f.onsetDensity).toBeGreaterThan(1.5);
    expect(f.onsetDensity).toBeLessThan(3.5);
    expect(f.spectralCentroidHz).toBeGreaterThan(50);
    expect(f.spectralCentroidHz).toBeLessThan(1500);
  });

  it('reads song B: 100 BPM within +-2, A minor, four rising bars', async () => {
    const f = (await ingestReference(fx('song-b-100bpm-amin.wav'))).features as Record<string, any>;
    expect(Math.abs(f.bpm - 100)).toBeLessThanOrEqual(2);
    expect(f.key).toBe('A minor');
    expect(f.barEnergy).toHaveLength(4);
    expect(f.barEnergy[3]).toBe(1);
    expect(f.barEnergy[0]).toBeLessThan(f.barEnergy[3]);
  });

  it('fails loudly on a corrupt wav, naming the file', async () => {
    const bad = path.join(tmp, 'broken.wav');
    writeFileSync(bad, Buffer.from('RIFF0000WAVEjunk'));
    await expect(ingestReference(bad)).rejects.toThrow(/REVERSE_REF_UNDECODABLE.*broken\.wav/);
  });

  it('names ffmpeg as the missing decoder for mp3 when it is not on PATH', async () => {
    const mp3 = path.join(tmp, 'x.mp3');
    writeFileSync(mp3, Buffer.from([0xff, 0xfb, 0x90, 0x00]));
    await expect(ingestReference(mp3, { ffmpeg: null }))
      .rejects.toThrow(/REVERSE_REF_DECODER_MISSING.*x\.mp3.*ffmpeg/);
  });

  it.skipIf(!hasFfmpeg)('decodes an mp3 of song B through ffmpeg', async () => {
    const mp3 = path.join(tmp, 'b.mp3');
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', fx('song-b-100bpm-amin.wav'), mp3]);
    const f = (await ingestReference(mp3)).features as Record<string, any>;
    expect(Math.abs(f.bpm - 100)).toBeLessThanOrEqual(2);
    expect(f.key).toBe('A minor');
  });
});

describe('image, svg, text and video cards', () => {
  it('image: palette, brightness, contrast, edge density, balance', async () => {
    const card = await ingestReference(fx('storyboard.png'));
    const f = card.features as Record<string, any>;
    expect(card.kind).toBe('image');
    expect(f.width).toBe(160);
    expect(f.height).toBe(90);
    expect(f.palette.length).toBeGreaterThanOrEqual(3);
    expect(f.palette[0]).toMatch(/^#[0-9a-f]{6}$/);
    expect(f.palette.some((hex: string) => parseInt(hex.slice(1, 3), 16) > 180 && parseInt(hex.slice(3, 5), 16) < 80)).toBe(true);
    expect(f.brightness).toBeGreaterThan(0.25);
    expect(f.brightness).toBeLessThan(0.6);
    expect(f.contrast).toBeGreaterThan(0.15);
    expect(f.edgeDensity).toBeGreaterThan(0.005);
    expect(f.edgeDensity).toBeLessThan(0.3);
    // brighter on the right half
    expect(f.balance.x).toBeGreaterThan(0.1);
  });

  it('svg: text labels and the polyline read as an energy curve (high = low y)', async () => {
    const card = await ingestReference(fx('arc-diagram.svg'));
    const f = card.features as Record<string, any>;
    expect(card.kind).toBe('diagram');
    expect(f.labels).toEqual(['Intro', 'Climax', 'Outro']);
    expect(f.curve).toHaveLength(5);
    expect(f.curve).toEqual([{ x: 0, energy: 0 }, { x: 0.25, energy: 0.125 }, { x: 0.5, energy: 1 },
      { x: 0.75, energy: 0.875 }, { x: 1, energy: 0.125 }]);
  });

  it('svg without a curve still yields labels and shape counts', async () => {
    const p = path.join(tmp, 'flat.svg');
    writeFileSync(p, '<svg xmlns="http://www.w3.org/2000/svg"><rect width="5" height="5"/><text>Only</text></svg>');
    const f = (await ingestReference(p)).features as Record<string, any>;
    expect(f.labels).toEqual(['Only']);
    expect(f.curve).toBeNull();
    expect(f.shapes).toEqual({ rect: 1 });
  });

  it('text and markdown: headings and length', async () => {
    const card = await ingestReference(fx('brief.md'));
    const f = card.features as Record<string, any>;
    expect(card.kind).toBe('text');
    expect(f.headings).toEqual([
      { level: 1, text: 'Launch reel' }, { level: 2, text: 'Opening' },
      { level: 2, text: 'Drop' }, { level: 3, text: 'Tail' }]);
    expect(f.words).toBe(11);
    expect(f.lines).toBe(12);
  });

  it.skipIf(!hasFfmpeg)('video: palette, motion energy over time and scene-change times', async () => {
    const mp4 = path.join(tmp, 'cuts.mp4');
    // red 1s, blue 1s (a hard cut at 1.0s), then a moving gradient for 1s
    execFileSync('ffmpeg', ['-v', 'error', '-y',
      '-f', 'lavfi', '-i', 'color=c=red:s=64x36:r=10:d=1',
      '-f', 'lavfi', '-i', 'color=c=blue:s=64x36:r=10:d=1',
      '-f', 'lavfi', '-i', 'testsrc=s=64x36:r=10:d=1',
      '-filter_complex', '[0][1][2]concat=n=3:v=1:a=0', '-pix_fmt', 'yuv420p', mp4]);
    const f = (await ingestReference(mp4)).features as Record<string, any>;
    expect(f.durationSec).toBeCloseTo(3, 0);
    expect(f.palette.length).toBeGreaterThanOrEqual(2);
    expect(f.motionEnergy.length).toBeGreaterThanOrEqual(10);
    expect(f.cuts.length).toBeGreaterThanOrEqual(1);
    expect(f.cuts.some((t: number) => Math.abs(t - 1) < 0.3)).toBe(true);
    expect(f.cutRhythm.cutsPerMinute).toBeGreaterThan(10);
  });
});

describe('failure is loud, never a silent skip', () => {
  it('rejects an unsupported extension naming the file and the missing decoder', async () => {
    const p = path.join(tmp, 'deck.pdf');
    writeFileSync(p, '%PDF-1.4');
    await expect(ingestReference(p)).rejects.toThrow(/REVERSE_REF_UNSUPPORTED.*deck\.pdf.*no decoder for \.pdf/);
  });

  it('rejects a missing file', async () => {
    await expect(ingestReference(path.join(tmp, 'ghost.wav'))).rejects.toThrow(/REVERSE_REF_MISSING.*ghost\.wav/);
  });

  it('rejects an undecodable image', async () => {
    const p = path.join(tmp, 'not-an-image.png');
    writeFileSync(p, 'this is text');
    await expect(ingestReference(p)).rejects.toThrow(/REVERSE_REF_UNDECODABLE.*not-an-image\.png/);
  });

  it('rejects video when ffmpeg is missing, naming ffmpeg', async () => {
    const p = path.join(tmp, 'clip.mp4');
    writeFileSync(p, 'x');
    await expect(ingestReference(p, { ffmpeg: null })).rejects.toThrow(/REVERSE_REF_DECODER_MISSING.*clip\.mp4.*ffmpeg/);
  });

  it('exposes a typed error code', async () => {
    const err = await ingestReference(path.join(tmp, 'a.xyz')).catch((e) => e);
    expect(err).toBeInstanceOf(ReferenceIngestError);
  });

  it('ingests several references in order and stops at the first failure', async () => {
    const cards = await ingestReferences([fx('storyboard.png'), fx('brief.md')]);
    expect(cards.map((c) => c.kind)).toEqual(['image', 'text']);
    await expect(ingestReferences([fx('brief.md'), path.join(tmp, 'nope.zzz')])).rejects.toThrow(/nope\.zzz/);
  });
});

describe('hostile paths are refused before any byte is read', () => {
  it('refuses a symlink, even one pointing at a readable text file', async () => {
    const target = path.join(tmp, 'private-notes.md');
    writeFileSync(target, '# secret heading\nbody');
    const link = path.join(tmp, 'innocent.md');
    symlinkSync(target, link);
    const err = await ingestReference(link).catch((e) => e);
    expect(err).toBeInstanceOf(ReferenceIngestError);
    expect(err.code).toBe('NOT_A_FILE');
    expect(err.message).toMatch(/REVERSE_REF_NOT_A_FILE: innocent\.md: is a symlink/);
    expect(err.message).not.toContain('secret heading');
  });

  it('refuses a symlink to a device that would never end (/dev/zero)', async () => {
    const link = path.join(tmp, 'zeros.wav');
    symlinkSync('/dev/zero', link);
    await expect(ingestReference(link)).rejects.toThrow(/REVERSE_REF_NOT_A_FILE: zeros\.wav: is a symlink/);
  });

  it.skipIf(process.platform === 'win32')('refuses a fifo without blocking on it', async () => {
    const fifo = path.join(tmp, 'pipe.wav');
    execFileSync('mkfifo', [fifo]);
    const started = Date.now();
    await expect(ingestReference(fifo)).rejects.toThrow(/REVERSE_REF_NOT_A_FILE: pipe\.wav: is not a regular file/);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('refuses a directory as NOT_A_FILE, not MISSING', async () => {
    const dir = path.join(tmp, 'folder.wav');
    mkdirSync(dir);
    await expect(ingestReference(dir)).rejects.toThrow(/REVERSE_REF_NOT_A_FILE: folder\.wav: is not a regular file/);
  });

  it('refuses a file over the size cap without reading it', async () => {
    const big = path.join(tmp, 'huge.wav');
    writeFileSync(big, '');
    truncateSync(big, MAX_REFERENCE_BYTES + 1);
    const err = await ingestReference(big).catch((e) => e);
    expect(err.code).toBe('TOO_LARGE');
    expect(err.message).toMatch(/REVERSE_REF_TOO_LARGE: huge\.wav: .* over the 512 MB limit/);
  });

  it('refuses an empty file instead of making an empty card', async () => {
    const empty = path.join(tmp, 'empty.md');
    writeFileSync(empty, '');
    await expect(ingestReference(empty)).rejects.toThrow(/REVERSE_REF_UNDECODABLE: empty\.md: file is empty/);
  });

  it('readLocalFile applies its own cap and reads a regular file', async () => {
    const p = path.join(tmp, 'small.json');
    writeFileSync(p, '{"a":1}');
    expect((await readLocalFile(p, 100)).toString('utf8')).toBe('{"a":1}');
    await expect(readLocalFile(p, 3)).rejects.toMatchObject({ code: 'TOO_LARGE' });
    await expect(readLocalFile(path.join(tmp, 'absent.json'), 100)).rejects.toMatchObject({ code: 'MISSING' });
  });
});

describe.skipIf(!hasFfmpeg)('video refs: picture and soundtrack, bounded', () => {
  // Constructed at 25 fps: red 2.52 s, blue 2.56 s, moving test pattern 2.88 s, green 4.04 s.
  // Cuts land at 2.52, 5.08 and 7.96 s; the soundtrack is an A major chord with a click every 0.5 s (120 BPM).
  const CUTS = [2.52, 5.08, 7.96];
  const pictures = 'color=c=0xff0000:s=160x90:r=25:d=2.52[a];color=c=0x0000ff:s=160x90:r=25:d=2.56[b];'
    + 'testsrc2=s=160x90:r=25:d=2.88[c];color=c=0x00ff00:s=160x90:r=25:d=4.04[d];'
    + '[a][b][c][d]concat=n=4:v=1:a=0,format=yuv420p[v]';
  const soundtrack = "aevalsrc='(0.25*sin(2*PI*440*t)+0.2*sin(2*PI*554.37*t)+0.2*sin(2*PI*659.25*t))*(0.3+0.7*t/12)"
    + "+0.9*lt(mod(t,0.5),0.01)*sin(2*PI*2000*t)':s=44100:d=12[s]";
  const make = (name: string, withAudio: boolean, codec: string[] = ['-c:v', 'libx264']) => {
    const out = path.join(tmp, name);
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-filter_complex', withAudio ? `${pictures};${soundtrack}` : pictures,
      '-map', '[v]', ...(withAudio ? ['-map', '[s]'] : []), ...codec, out]);
    return out;
  };
  const sinterTemps = () => readdirSync(tmpdir()).filter((n) => n.startsWith('sinter-ref-')).sort();

  it('finds each constructed cut within one frame, the palette and the moving segment', async () => {
    const f = (await ingestReference(make('cuts.mp4', true))).features as Record<string, any>;
    expect(f.durationSec).toBe(12);
    expect(f.analyzedSec).toBe(12);
    expect(f.cuts).toHaveLength(3);
    f.cuts.forEach((t: number, i: number) => expect(Math.abs(t - CUTS[i])).toBeLessThanOrEqual(0.04));
    expect(f.palette.slice(0, 3).sort()).toEqual(['#0808f8', '#08f808', '#f80808']);
    const at = (t: number) => f.motionEnergy[Math.floor(t / f.motionBucketSec)];
    for (const still of [1, 4, 10]) expect(at(still)).toBe(0);
    for (const moving of [5.6, 6.5, 7.4]) expect(at(moving)).toBeGreaterThan(0.01);
  });

  it('analyses the soundtrack with the audio card: tempo, key, energy rising', async () => {
    const f = (await ingestReference(make('song.mov', true))).features as Record<string, any>;
    expect(f.audio).toMatchObject({ mode: 'major', sampleRate: 22050 });
    expect(Math.abs(f.audio.bpm - 120)).toBeLessThanOrEqual(2);
    expect(f.audio.key).toBe('A major');
    expect(f.audio.durationSec).toBeCloseTo(12, 0);
    expect(f.audio.barEnergy.at(-1)).toBeGreaterThan(f.audio.barEnergy[0]);
  });

  it('says so when a video has no audio track', async () => {
    const card = await ingestReference(make('silent.webm', false, ['-c:v', 'libvpx-vp9', '-deadline', 'realtime']));
    expect((card.features as Record<string, any>).audio).toBeNull();
    expect(describeCard(card)).toContain('audio track: none');
  });

  it('puts the soundtrack in the prompt card next to the picture', async () => {
    const line = describeCard(await ingestReference(make('brief.mp4', true)));
    expect(line).toMatch(/cuts at 2\.5\d?s, 5\.0\d?s, 7\.9\d?s/);
    expect(line).toMatch(/audio track: tempo 120 BPM, key A major/);
  });

  it('mentions a partial analysis only when part of the picture was really skipped', () => {
    const features = { durationSec: 12.01, analyzedSec: 12, sampleFps: 25, palette: ['#808080'], motionEnergy: [0],
      motionBucketSec: 0.2, cuts: [], cutRhythm: { cutsPerMinute: 0, meanShotSec: 12 }, audio: null };
    const card = { kind: 'video' as const, file: 'a.webm', sha256: 'x', bytes: 1, features };
    expect(describeCard(card)).not.toContain('analysed for the first');
    expect(describeCard({ ...card, features: { ...features, durationSec: 700, analyzedSec: 600 } }))
      .toContain('(picture analysed for the first 600s)');
  });

  it('reports the full length of a long video and how much of it was analysed', async () => {
    const long = path.join(tmp, 'long.mp4');
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=gray:s=16x16:r=1:d=700',
      '-c:v', 'libx264', '-preset', 'ultrafast', long]);
    const f = (await ingestReference(long)).features as Record<string, any>;
    expect(f.durationSec).toBe(700);
    expect(f.analyzedSec).toBe(600);
    expect(f.motionEnergy.length).toBeLessThanOrEqual(60);
  });

  it('decodes the bytes it checked, not whatever an ffmpeg protocol prefix points at', async () => {
    const dir = mkdtempSync(path.join(tmp, 'proto-'));
    const secret = make('secret-12s.mp4', false);
    symlinkSync(secret, path.join(dir, 'other.mp4'));
    const literal = path.join(dir, 'concat:other.mp4');
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=gray:s=32x32:r=25:d=2',
      '-c:v', 'libx264', path.join(dir, 'gray.mp4')]);
    writeFileSync(literal, readFileSync(path.join(dir, 'gray.mp4')));
    // A relative path, as `--ref concat:other.mp4` would pass it, is where ffmpeg reads the prefix as a protocol.
    const cwd = process.cwd();
    process.chdir(dir);
    let f: Record<string, any>;
    try { f = (await ingestReference('concat:other.mp4')).features as Record<string, any>; } finally { process.chdir(cwd); }
    expect(f.durationSec).toBe(2);
    expect(f.cuts).toEqual([]);
  });

  it('names the file and ffmpeg\'s reason for a corrupt video, and leaves no temp files', async () => {
    const before = sinterTemps();
    const bad = path.join(tmp, 'corrupt.mp4');
    writeFileSync(bad, Buffer.alloc(4096, 7));
    await expect(ingestReference(bad)).rejects.toThrow(/REVERSE_REF_UNDECODABLE: corrupt\.mp4: \.mp4 could not be decoded \(.*Invalid data/);
    await ingestReference(make('clean.mp4', true));
    expect(sinterTemps()).toEqual(before);
  });

  it('stops a decoder that hangs and says how long it waited', async () => {
    const fake = path.join(tmp, 'slow-ffmpeg.sh');
    writeFileSync(fake, '#!/bin/sh\n[ "$1" = "-version" ] && exit 0\nexec sleep 30\n', { mode: 0o755 });
    const clip = make('slow.mp4', false);
    const started = Date.now();
    await expect(ingestReference(clip, { ffmpeg: fake, timeoutMs: 500 }))
      .rejects.toThrow(/REVERSE_REF_UNDECODABLE: slow\.mp4: .*took longer than 0\.5 s/);
    expect(Date.now() - started).toBeLessThan(5000);
  });
});
