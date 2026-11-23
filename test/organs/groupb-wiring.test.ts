/**
 * Organ group B, provider-path wiring proofs (built bin/sinter, fake provider, no key, no network):
 * gallery (a saved seed reaches the next brief), collab (a reviewer memo reaches the brief), media (a reference image is
 * checked and receipted; a fake image is refused), music (theory brief behind --theory; forced template fallback),
 * composite (a validated spec renders through compose),
 * analytics (the real daemon's events leave no prompt text, email or home path).
 * One spawned generate takes ~100 s, so assertions are batched per spawn.
 */
import http from 'node:http';
import { gunzipSync } from 'node:zlib';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { fakeProviderEnv, goodJudgeReply, LIVELY_HTML, runSinterAsync, startFakeProvider, type FakeCall, type FakeProvider } from '../helpers/fakeProviderServer.js';

vi.setConfig({ testTimeout: 280_000 });

const P5 = `function setup(){ createCanvas(400, 400); noStroke(); }
function draw(){ background(10, 20, 40); for (let i = 0; i < 40; i++) { fill(80 + i * 4, 200, 255 - i * 3, 180); circle(200 + 150 * Math.cos(frameCount * 0.02 + i), 200 + 150 * Math.sin(frameCount * 0.02 + i), 14); } }`;
const SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><defs><linearGradient id="g"><stop offset="0" stop-color="#7fd6ff"/><stop offset="1" stop-color="#ff7a90"/></linearGradient></defs><circle cx="50" cy="50" r="30" fill="url(#g)"><animate attributeName="r" values="20;34;20" dur="3s" repeatCount="indefinite"/></circle></svg>';
const HYDRA = 'osc(20, 0.1, 0.8).kaleid(4).modulate(noise(3, 0.2), 0.2).color(0.9, 0.4, 1).rotate(() => time * 0.1).out(o0)';
const STRUDEL = 's("bd*4, hh*8").bank("RolandTR909").slow(2)\n.stack(note("c2 eb2 g2").s("sawtooth").lpf(600))';

let work: string; let fake: FakeProvider; let n = 0;
let reply = (c: FakeCall): string => (c.user.includes('<task domain="svg">') ? SVG : c.user.includes('<task domain="hydra">') || /hydra/i.test(c.user.slice(0, 400)) ? HYDRA : c.user.includes('<task domain="strudel">') ? STRUDEL : c.user.includes('<task domain="p5">') ? P5 : LIVELY_HTML);
beforeAll(async () => {
  work = mkdtempSync(path.join(tmpdir(), 'sinter-groupb-wiring-'));
  fake = await startFakeProvider({ generate: (c) => reply(c), judge: () => goodJudgeReply(0.8) });
});
afterAll(async () => { await fake.close(); rmSync(work, { recursive: true, force: true }); });
const env = (extra: Record<string, string> = {}) => { const i = n++; return { ...fakeProviderEnv(fake, { home: path.join(work, `home${i}`), stateRoot: path.join(work, `state${i}`) }), ...extra }; };
const inDir = (name: string) => { const d = path.join(work, name); mkdirSync(d, { recursive: true }); return d; };
const briefOf = (before: number) => fake.generated.slice(before).map(c => c.user).join('\n---\n');

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
const tone = (hz: number, amp: number, sec = 2) => Float32Array.from({ length: 44100 * sec }, (_, i) => amp * Math.sin((2 * Math.PI * hz * i) / 44100));

describe('gallery + collab + media: one generate carrying a saved seed, a critique memo and a reference image', () => {
  it('each reaches the brief and leaves its record; the same generate without them has none of it; a fake image is refused', async () => {
    const e = env(); const d = inDir('gen');
    const seed = await runSinterAsync(['seed', 'save', 'tidal-orbit', '--prompt', 'SEEDMARK a slow tidal orbit of lanterns', '--domain', 'html', '--title', 'calm and wide'], e);
    expect(seed.status, seed.out).toBe(0);
    expect((await runSinterAsync(['seed', 'list'], e)).out).toContain('tidal-orbit');
    const memoFile = path.join(d, 'memo.json');
    const memo = await runSinterAsync(['memo', '-o', memoFile, '--by', 'fakeseat-roaster', '--verdict', 'revise', '--score', '0.35', '--title', 'Roast', '--section', 'Motion|MEMOMARK the orbit is too static|high', 'judge the lantern orbit'], e);
    expect(memo.status, memo.out).toBe(0);
    const png = path.join(d, 'ref.png');
    await sharp({ create: { width: 64, height: 64, channels: 3, background: { r: 220, g: 20, b: 20 } } }).png().toFile(png);

    const before = fake.generated.length; const out1 = path.join(d, 'with');
    const withAll = await runSinterAsync(['generate', '-o', out1, '--domain', 'html', '--seed', 'tidal-orbit', '--memo', memoFile, '--ref', png, 'a slow orbit'], e);
    expect(withAll.status, withAll.out).toBe(0);
    const brief = briefOf(before);
    expect(brief).toContain('SEEDMARK'); expect(brief).toContain('calm and wide');
    expect(brief).toContain('MEMOMARK'); expect(brief).toContain('fakeseat-roaster');
    const receipts = JSON.parse(readFileSync(path.join(out1, 'reference.receipt.json'), 'utf8'));
    expect(receipts[0]).toMatchObject({ schema: 'sinter-image-input-receipt-v1', mimeType: 'image/png', role: 'reference' });
    expect(receipts[0].imageSha256).toMatch(/^[0-9a-f]{64}$/);

    const before2 = fake.generated.length; const out2 = path.join(d, 'without');
    const plain = await runSinterAsync(['generate', '-o', out2, '--domain', 'html', 'a slow orbit'], e);
    expect(plain.status, plain.out).toBe(0);
    const brief2 = briefOf(before2);
    expect(brief2).not.toContain('SEEDMARK'); expect(brief2).not.toContain('MEMOMARK');
    expect(existsSync(path.join(out2, 'reference.receipt.json'))).toBe(false);

    const fakeImg = path.join(d, 'notreally.png'); writeFileSync(fakeImg, 'this is plain text, not a picture');
    const bad = await runSinterAsync(['generate', '-o', path.join(d, 'bad'), '--domain', 'html', '--ref', fakeImg, 'x'], e);
    expect(bad.status).toBe(1);
    expect(bad.out).toMatch(/reference image rejected|REVERSE_REF_UNDECODABLE/);
    const missing = await runSinterAsync(['generate', '-o', path.join(d, 'miss'), '--domain', 'html', '--seed', 'nope', 'x'], e);
    expect(missing.status).toBe(1); expect(missing.out).toMatch(/no saved seed named nope/);
  }, 560_000);
});

describe('music: the theory brief is opt-in; the template fallback must be asked for', () => {
  it('live-music --theory puts key, scale, rhythm and chords in the model brief; without it they are absent', async () => {
    const e = env();
    let before = fake.generated.length;
    const on = await runSinterAsync(['live-music', 'a dark minor drone', '-o', path.join(work, 'lm-on'), '--theory'], e);
    expect(on.status, on.out).toBe(0);
    const briefOn = briefOf(before);
    expect(briefOn).toContain('Music theory plan'); expect(briefOn).toMatch(/Key and scale/); expect(briefOn).toMatch(/Euclidean E\(/);
    before = fake.generated.length;
    const off = await runSinterAsync(['live-music', 'a dark minor drone', '-o', path.join(work, 'lm-off')], e);
    expect(off.status, off.out).toBe(0);
    expect(briefOf(before)).not.toContain('Music theory plan');
  }, 560_000);

  it('when the model fails the built-in pattern is used only with allowTemplateFallback, and its theory follows the mood', async () => {
    const { generateMusic, buildMusicTheoryBrief } = await import('../../src/music/generateMusic.js');
    const broken = { generate: async () => { throw new Error('provider down'); } } as never;
    await expect(generateMusic({ prompt: 'a dark minor drone', llm: broken })).rejects.toThrow(/refusing the built-in pattern/);
    const dark = await generateMusic({ prompt: 'a dark minor drone', llm: broken, allowTemplateFallback: true });
    const bright = await generateMusic({ prompt: 'a bright happy major dance', llm: broken, allowTemplateFallback: true });
    expect(dark.source).toBe('template'); expect(bright.source).toBe('template');
    expect(dark.code).not.toBe(bright.code);
    expect(buildMusicTheoryBrief('a dark minor drone')).not.toBe(buildMusicTheoryBrief('a bright happy major dance'));
  });
});

it.each([
  { command: ['sing', 'A lantern that listens.'] },
  { command: ['sing a lantern'] },
])('reports the Sing move without asking a provider to generate art for $command', async ({ command }) => {
  const before = fake.calls.length;
  const result = await runSinterAsync(command, env());
  expect(result.status).toBe(1);
  expect(result.out).toContain('Sing moved to LoopCover.');
  expect(fake.calls).toHaveLength(before);
});

describe('composite: a validated spec renders each layer own media', () => {
  it('each layer embeds its real file (unique colour and sound), with blend and opacity applied; a missing source or invalid spec renders nothing', async () => {
    const d = inDir('composite');
    const png = path.join(d, 'marker.png'); const mp4 = path.join(d, 'clip.mp4'); const sound = path.join(d, 'tone.wav');
    await sharp({ create: { width: 48, height: 48, channels: 3, background: { r: 18, g: 171, b: 52 } } }).png().toFile(png);
    const ff = spawnSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=0xab1234:s=64x64:d=1:r=10', '-pix_fmt', 'yuv420p', mp4]);
    expect(ff.status, String(ff.stderr)).toBe(0);
    writeFileSync(sound, wav(tone(523, 0.4, 1)));
    const spec = (over: object = {}) => ({ width: 640, height: 360, fps: 24, duration: 4, layers: [{ type: 'video', source: mp4 }, { type: 'image', source: png, blend: 'screen', opacity: 0.6 }, { type: 'audio', source: sound }], ...over });
    const f = path.join(d, 'spec.json'); writeFileSync(f, JSON.stringify(spec()));
    const before = fake.generated.length;
    const run = await runSinterAsync(['composite', '--spec', f, '--render', '--render-out', path.join(d, 'out')], env({ SINTER_COMPOSITE_GATE: '0' }));
    expect(run.status, run.out).toBe(0);
    expect(fake.generated.length - before).toBe(0);
    const html = readFileSync(path.join(d, 'out', 'composition.html'), 'utf8');
    // each layer is an iframe whose src is the layer page as a base64 data URI: decode them and look for the real bytes
    const layerPages = [...html.matchAll(/<iframe[^>]*src="data:text\/html;base64,([^"]+)"/g)].map(m => Buffer.from(m[1], 'base64').toString('utf8'));
    expect(layerPages).toHaveLength(3);
    for (const [file, mime, tag] of [[mp4, 'video/mp4', '<video'], [png, 'image/png', '<img'], [sound, 'audio/wav', '<audio']] as const) {
      const page = layerPages.find(p => p.includes(`data:${mime};base64,`))!;
      expect(page, `${mime} layer page`).toContain(tag);
      expect(page, `real bytes of ${path.basename(file)}`).toContain(readFileSync(file).toString('base64'));
    }
    expect(html).toMatch(/mix-blend-mode:screen;opacity:0\.6/);
    expect(JSON.parse(readFileSync(path.join(d, 'out', 'composition.layers.json'), 'utf8')).layers).toHaveLength(3);
    const gone = path.join(d, 'gone.json'); writeFileSync(gone, JSON.stringify(spec({ layers: [{ type: 'image', source: path.join(d, 'nope.png') }] })));
    const missing = await runSinterAsync(['composite', '--spec', gone, '--render', '--render-out', path.join(d, 'gone-out')], env());
    expect(missing.status).toBe(1); expect(missing.out).toMatch(/layer source not found/); expect(existsSync(path.join(d, 'gone-out', 'composition.html'))).toBe(false);
    const bad = path.join(d, 'bad.json'); writeFileSync(bad, JSON.stringify(spec({ width: 0 })));
    const refused = await runSinterAsync(['composite', '--spec', bad, '--render', '--render-out', path.join(d, 'bad-out')], env());
    expect(refused.status).toBe(1); expect(existsSync(path.join(d, 'bad-out', 'composition.html'))).toBe(false);
  }, 560_000);
});

describe('compose: prompt layers go through the provider path', () => {
  it('a spec of prompt-only layers makes provider calls and renders each answer into composition.html', async () => {
    const d = inDir('compose-prompt'); const spec = path.join(d, 'spec.json');
    writeFileSync(spec, JSON.stringify({ title: 'two prompt layers', layers: [{ domain: 'p5', prompt: 'drifting particles' }, { domain: 'html', prompt: 'a calm gradient field', blendMode: 'screen', opacity: 0.7 }] }));
    const before = fake.generated.length;
    const run = await runSinterAsync(['compose', '--spec', spec, '-o', path.join(d, 'out')], env({ SINTER_COMPOSITE_GATE: '0' }));
    expect(run.status, run.out).toBe(0);
    expect(fake.generated.length - before).toBeGreaterThanOrEqual(2);
    const html = readFileSync(path.join(d, 'out', 'composition.html'), 'utf8');
    const pages = [...html.matchAll(/<iframe[^>]*src="data:text\/html;base64,([^"]+)"/g)].map(m => Buffer.from(m[1], 'base64').toString('utf8'));
    expect(pages).toHaveLength(2);
    expect(pages.some(p => p.includes('createCanvas(400, 400)'))).toBe(true);
    expect(html).toMatch(/mix-blend-mode:screen;opacity:0\.7/);
  }, 560_000);
});

describe('analytics: the spawned site daemon sends events to the configured host and nothing personal', () => {
  it('site evolve --once posts liminal_* events to the fake endpoint without prompt text, email or home path; unset key sends nothing', async () => {
    const bodies: string[] = [];
    const srv = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', c => chunks.push(c));
      req.on('end', () => { const raw = Buffer.concat(chunks); let t: string; try { t = gunzipSync(raw).toString('utf8'); } catch { t = raw.toString('utf8'); } bodies.push(t); res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"status":1}'); });
    });
    await new Promise<void>(r => srv.listen(0, '127.0.0.1', r));
    const host = `http://127.0.0.1:${(srv.address() as { port: number }).port}`;
    try {
      const assets = inDir('site-assets'); const cwd = inDir('analytics');
      const base = env({ SINTER_SITE_ASSET_DIR: assets, SINTER_DEBUG: '1' });
      const seed = await runSinterAsync(['site', 'seed', '--slots', '2'], base, cwd);
      expect(seed.status, seed.out).toBe(0);
      const e = { ...base, LIMINAL_POSTHOG_KEY: 'phc_test_not_real', LIMINAL_POSTHOG_HOST: host };
      const before = fake.generated.length;
      const evolve = await runSinterAsync(['site', 'evolve', '--once'], e, cwd);
      expect(evolve.status, evolve.out).toBe(0);
      expect(fake.generated.length - before).toBeGreaterThan(0);
      const all = bodies.join('\n');
      expect(all).toMatch(/liminal_variant_(generated|rejected)/);
      expect(all).toContain('sinter-daemon');
      expect(all).not.toMatch(/[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+\.[a-z]{2,}/i);
      expect(all).not.toContain(work); expect(all).not.toMatch(/\/home\/[a-z]+/i);
      for (const body of bodies) for (const bad of ['prompt', 'userName', 'email']) expect(body).not.toMatch(new RegExp(`"${bad}"`, 'i'));
      const sent = bodies.length;
      await runSinterAsync(['site', 'evolve', '--once'], { ...base, LIMINAL_POSTHOG_HOST: host }, cwd);
      expect(bodies.length).toBe(sent);
    } finally { await new Promise<void>(r => srv.close(() => r())); }
  }, 560_000);
});
