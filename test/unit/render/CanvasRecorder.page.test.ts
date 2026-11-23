import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const { mockLaunch, framesToVideo, probe } = vi.hoisted(() => ({ mockLaunch: vi.fn(), framesToVideo: vi.fn(), probe: vi.fn() }));
vi.mock('puppeteer', () => ({ default: { launch: mockLaunch } }));
vi.mock('../../../src/export/VideoExporter.js', () => ({
  VideoExporter: class { framesToVideo = framesToVideo; probe = probe; },
}));

const mockResolve = vi.hoisted(() => vi.fn(() => '/opt/chromium' as string | null));
vi.mock('../../../src/utils/browserAssetFallbacks.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/utils/browserAssetFallbacks.js')>()),
  resolveChromiumExecutablePath: mockResolve,
}));
import { CanvasRecorder } from '../../../src/render/CanvasRecorder.js';
import { RENDER_ORIGIN } from '../../../src/render/HeadlessRenderer.js';
import { readVendorAsset } from '../../../src/utils/vendorAssets.js';

type Step = 'load' | 'frame';

/**
 * A page that keeps what the browser is handed, answers requests through the
 * recorder's own handler, and can throw like a sketch at load or mid-recording.
 */
function fakePage(opts: { throwAt?: Step; noCanvas?: boolean } = {}) {
  const page = Object.assign(new EventEmitter(), {
    html: '',
    visited: [] as string[],
    setViewport: vi.fn(),
    intercepting: false,
    setRequestInterception: vi.fn(async (on: boolean) => { page.intercepting = on; }),
    goto: vi.fn(async (url: string) => {
      if (!page.intercepting) throw new Error('goto before interception: the private origin would hit the network');
      page.visited.push(url);
    }),
    setContent: vi.fn(async (html: string) => {
      page.html = html;
      if (opts.throwAt === 'load') page.emit('pageerror', new Error('Error creating webgl context'));
    }),
    waitForSelector: vi.fn(async () => {
      if (opts.noCanvas) throw new Error('Waiting for selector `canvas` failed');
    }),
    evaluate: vi.fn(async () => {
      if (opts.throwAt === 'frame') page.emit('pageerror', new Error('x is not defined'));
    }),
    $: vi.fn().mockResolvedValue({ screenshot: vi.fn() }),
  });
  return page;
}

/** Sends one request through the page's request handler and reports the answer. */
async function request(page: ReturnType<typeof fakePage>, url: string) {
  const answer = { respond: vi.fn(async () => undefined), abort: vi.fn(async () => undefined), continue: vi.fn(async () => undefined) };
  page.emit('request', { url: () => url, ...answer });
  await vi.waitFor(() => expect(answer.respond.mock.calls.length + answer.abort.mock.calls.length + answer.continue.mock.calls.length).toBe(1));
  return answer;
}

let outputDir: string;
const outputPath = () => path.join(outputDir, 'out.mp4');
const record = (code: string, domain = 'p5') =>
  new CanvasRecorder({ fps: 2, duration: 1, width: 64, height: 64 }).record(code, domain as never, outputPath());
const P5 = 'function setup(){createCanvas(64,64)} function draw(){background(frameCount%255)}';
const THREE = "import * as THREE from 'three'; const r = new THREE.WebGLRenderer(); document.body.appendChild(r.domElement);";

/** A run of the vendored file from its middle, past any banner it shares with other files. */
async function vendoredSlice(path: string) {
  const body = await readVendorAsset(path);
  return body.slice(body.length / 2, body.length / 2 + 400);
}

let page: ReturnType<typeof fakePage>;
const usePage = (next: ReturnType<typeof fakePage>) => { page = next; };
beforeEach(async () => {
  outputDir = await mkdtemp(path.join(os.tmpdir(), 'sinter-recorder-test-'));
  mockResolve.mockReturnValue('/opt/chromium');
  mockLaunch.mockReset();
  framesToVideo.mockReset().mockImplementation(async (_frames, output: string) => writeFile(output, 'new video'));
  probe.mockReset().mockResolvedValue({ width: 1, height: 1, durationSec: 1 });
  usePage(fakePage());
  mockLaunch.mockImplementation(async () => ({ newPage: async () => page, close: vi.fn() }));
});

afterEach(() => rm(outputDir, { force: true, recursive: true }));

describe('CanvasRecorder hands the browser a page that can run', () => {
  it('records a working p5 sketch to video', async () => {
    await expect(record(P5)).resolves.toBe(outputPath());
    expect(framesToVideo).toHaveBeenCalledTimes(1);
    const stagedOutput = framesToVideo.mock.calls[0]![1];
    expect(stagedOutput).not.toBe(outputPath());
    expect(probe).toHaveBeenCalledWith(stagedOutput);
    expect(await readFile(outputPath(), 'utf8')).toBe('new video');
  });

  it('preserves the existing output when ffprobe rejects the staged recording', async () => {
    await writeFile(outputPath(), 'existing video');
    probe.mockRejectedValueOnce(new Error('invalid video'));
    await expect(record(P5)).rejects.toThrow('invalid video');
    expect(await readFile(outputPath(), 'utf8')).toBe('existing video');
    expect(await readdir(outputDir)).toEqual(['out.mp4']);
  });

  it('inlines p5, which a /vendor/ link would never load at about:blank', async () => {
    await record(P5);
    expect(page.html).not.toContain('/vendor/');
    expect(page.html).toContain(await vendoredSlice('/vendor/p5/1.9.0/p5.min.js'));
  });

  it('serves Three modules from a private origin the page CSP allows', async () => {
    await record(THREE, 'three');
    expect(page.visited).toEqual([`${RENDER_ORIGIN}/`]);
    expect(page.html).toContain('"three": "/vendor/three/0.160.0/three.module.js"');
    const module = await request(page, `${RENDER_ORIGIN}/vendor/three/0.160.0/three.module.js`);
    expect(module.respond).toHaveBeenCalledWith(expect.objectContaining({
      status: 200,
      body: await readVendorAsset('/vendor/three/0.160.0/three.module.js'),
    }));
  });

  it('fails the request, once, when a vendored module cannot be read', async () => {
    const vendor = await import('../../../src/utils/vendorAssets.js');
    const read = vi.spyOn(vendor, 'readVendorAsset').mockRejectedValueOnce(new Error('vendored asset missing on disk'));
    await record(THREE, 'three');
    const module = await request(page, `${RENDER_ORIGIN}/vendor/three/0.160.0/three.module.js`);
    expect(module.abort).toHaveBeenCalledOnce();
    expect(module.abort).toHaveBeenCalledWith('failed');
    expect(module.respond).not.toHaveBeenCalled();
    read.mockRestore();
  });

  it('serves nothing else from the private origin', async () => {
    await record(THREE, 'three');
    const other = await request(page, `${RENDER_ORIGIN}/secrets.json`);
    expect(other.abort).toHaveBeenCalledWith('blockedbyclient');
    expect(other.respond).not.toHaveBeenCalled();
  });
});

describe('CanvasRecorder launches the resolved Chromium', () => {
  it('passes the resolved executablePath to launch', async () => {
    await record(P5);
    expect(mockLaunch).toHaveBeenCalledWith(expect.objectContaining({ executablePath: '/opt/chromium' }));
  });

  it('throws the missing-browser error and never launches when nothing resolves', async () => {
    mockResolve.mockReturnValue(null);
    await expect(record(P5)).rejects.toThrow(/Chromium executable not found/);
    expect(mockLaunch).not.toHaveBeenCalled();
  });
});

describe('CanvasRecorder export deadline', () => {
  it('terminates the launched browser when the browser drive hangs and never starts encoding', async () => {
    const close = vi.fn();
    const kill = vi.fn();
    mockLaunch.mockResolvedValue({
      newPage: () => new Promise(() => undefined),
      process: () => ({ kill }),
      close,
    });
    const recorder = new CanvasRecorder({ fps: 2, duration: 1, width: 64, height: 64, timeoutMs: 300 });
    await expect(recorder.record(P5, 'p5', '/tmp/sinter-recorder-test/out.mp4'))
      .rejects.toThrow(/Canvas recording exceeded the export deadline/);
    expect(kill).toHaveBeenCalledWith('SIGKILL');
    expect(framesToVideo).not.toHaveBeenCalled();
  });
});

describe('CanvasRecorder fails an export of a sketch that threw', () => {
  it('names the error when the sketch throws mid-recording', async () => {
    usePage(fakePage({ throwAt: 'frame' }));
    await expect(record(P5)).rejects.toThrow('The sketch threw while recording: x is not defined');
    expect(framesToVideo).not.toHaveBeenCalled();
  });

  it('names the error, not the canvas wait, when a crash leaves no canvas', async () => {
    usePage(fakePage({ throwAt: 'load', noCanvas: true }));
    await expect(record(P5)).rejects.toThrow('The sketch threw while recording: Error creating webgl context');
  });

  it('still reports the canvas wait when nothing threw', async () => {
    usePage(fakePage({ noCanvas: true }));
    await expect(record(P5)).rejects.toThrow('Waiting for selector `canvas` failed');
  });
});
