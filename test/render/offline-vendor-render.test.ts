/**
 * Offline render proof for vendored artifacts (issue #924).
 *
 * Builds wrapped artifacts for p5, three, and tone, serves them over HTTP the
 * way the fleet does (artifact + /vendor/* from one origin), blocks ALL
 * non-loopback egress at the browser level, and asserts each artifact renders
 * NON-BLANK pixels. A CDN outage must not be able to kill artifact renders.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import { readFile, mkdtemp, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import puppeteer from 'puppeteer';
import type { Browser, Page } from 'puppeteer';
import { HTMLWrapper } from '../../src/utils/htmlWrapper.js';
import { resolveChromiumExecutablePath, isPuppeteerChromeCompatible } from '../../src/utils/browserAssetFallbacks.js';
import { vendorRoot } from '../../src/utils/vendorAssets.js';

const P5_CODE = `
function setup() {
  createCanvas(400, 300);
  background(20, 24, 40);
  noStroke();
  fill(255, 120, 40);
  rect(60, 60, 280, 180);
  noLoop();
}
function draw() {}
`;

const THREE_CODE = `
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.1, 100);
camera.position.z = 3;
const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
renderer.setSize(window.innerWidth, window.innerHeight);
document.body.appendChild(renderer.domElement);
const material = new THREE.MeshBasicMaterial({ color: 0xff5522 });
const mesh = new THREE.Mesh(new THREE.SphereGeometry(1, 32, 32), material);
scene.add(mesh);
renderer.render(scene, camera);
`;

const TONE_CODE = `
// Retained raw Tone artifacts draw into the canvas supplied by the wrapper.
const synth = new Tone.Synth().toDestination();
const paper = document.getElementById('paper');
const paperContext = paper.getContext('2d');
paperContext.fillStyle = '#f59e0b';
paperContext.fillRect(0, 0, paper.width, paper.height);
window.__retainedTonePaperDrew = true;
`;

interface ServedArtifact {
  path: string;
  html: string;
}

describe('offline rendering of vendored artifacts (#924)', () => {
  let server: Server;
  let baseUrl: string;
  let browser: Browser;
  let artifacts: Record<string, string>;

  const blocked: string[] = [];

  beforeAll(async () => {
    // Build wrapped artifacts exactly as production wrappers do.
    artifacts = {
      'p5.html': HTMLWrapper.wrap(P5_CODE, { domain: 'p5', title: 'offline p5' }),
      'three.html': HTMLWrapper.wrap(THREE_CODE, { domain: 'three', title: 'offline three' }),
      'tone.html': HTMLWrapper.wrap(TONE_CODE, { domain: 'tone', title: 'offline tone' }),
    };

    // Serve artifacts + vendored libs from one loopback origin (fleet contract).
    const docroot = await mkdtemp(join(tmpdir(), 'sinter-vendor-render-'));
    for (const [name, html] of Object.entries(artifacts)) {
      await writeFile(join(docroot, name), html);
    }
    await mkdir(join(docroot, 'artifacts'), { recursive: true });

    const vendorBase = resolve(vendorRoot());
    server = createServer(async (req, res) => {
      try {
        const url = new URL(req.url ?? '/', 'http://127.0.0.1');
        let filePath: string | null = null;
        if (url.pathname.startsWith('/vendor/')) {
          const target = resolve(join(vendorBase, url.pathname.slice('/vendor/'.length)));
          if (target.startsWith(vendorBase + sep) || target === vendorBase) filePath = target;
        } else if (url.pathname === '/' || url.pathname.endsWith('.html')) {
          filePath = join(docroot, url.pathname === '/' ? 'p5.html' : url.pathname.slice(1));
        }
        if (!filePath) {
          res.writeHead(404); res.end('not found'); return;
        }
        const body = await readFile(filePath);
        const type = filePath.endsWith('.html') ? 'text/html' : filePath.endsWith('.js') ? 'text/javascript' : 'application/json';
        res.writeHead(200, { 'Content-Type': type });
        res.end(body);
      } catch {
        res.writeHead(404); res.end('not found');
      }
    });
    await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
    baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

    const executablePath = resolveChromiumExecutablePath({ skipInstall: true });
    browser = await puppeteer.launch({
      headless: true,
      ...(executablePath && isPuppeteerChromeCompatible(executablePath) ? { executablePath } : {}),
      args: ['--no-sandbox', '--disable-dev-shm-usage'],
    });
  }, 60_000);

  afterAll(async () => {
    await browser?.close().catch(() => undefined);
    await new Promise<void>(done => server.close(() => done()));
  });

  async function renderOffline(path: string, probe: (page: Page) => Promise<{ nonBlank: boolean; detail: string }>): Promise<void> {
    const page = await browser.newPage();
    try {
      // Network egress BLOCKED: only the loopback artifact server may answer.
      await page.setRequestInterception(true);
      page.on('request', (req) => {
        if (req.url().startsWith(baseUrl)) {
          void req.continue();
        } else {
          blocked.push(req.url());
          void req.abort('failed');
        }
      });
      const pageErrors: string[] = [];
      page.on('pageerror', (err) => pageErrors.push(String(err)));

      await page.goto(`${baseUrl}/${path}`, { waitUntil: 'load', timeout: 30_000 });
      await new Promise(r => setTimeout(r, 1200));

      const result = await probe(page);
      expect(
        result.nonBlank,
        `${path} rendered blank offline (blocked: ${JSON.stringify(blocked)}; errors: ${pageErrors.join(' | ')}). ${result.detail}`,
      ).toBe(true);
    } finally {
      await page.close();
    }
  }

  async function canvas2dNonBlank(page: Page, selector: string): Promise<{ nonBlank: boolean; detail: string }> {
    return page.evaluate((sel) => {
      const canvas = document.querySelector(sel) as HTMLCanvasElement | null;
      if (!canvas) return { nonBlank: false, detail: `no canvas ${sel}` };
      const ctx = canvas.getContext('2d');
      if (!ctx) return { nonBlank: false, detail: `no 2d context on ${sel}` };
      const { width, height } = canvas;
      const data = ctx.getImageData(0, 0, width, height).data;
      let distinct = 0;
      const first = [data[0], data[1], data[2]];
      for (let i = 0; i < data.length; i += 40) {
        if (Math.abs(data[i] - first[0]) + Math.abs(data[i + 1] - first[1]) + Math.abs(data[i + 2] - first[2]) > 24) distinct++;
      }
      return { nonBlank: distinct > 50, detail: `${distinct} distinct samples on ${sel} (${width}x${height})` };
    }, selector);
  }

  it('p5 artifact renders non-blank with zero CDN access', async () => {
    await renderOffline('p5.html', (page) => canvas2dNonBlank(page, 'canvas'));
  }, 60_000);

  it('three artifact renders non-blank with zero CDN access', async () => {
    await renderOffline('three.html', async (page) => {
      const ok = await page.evaluate(() => typeof (window as unknown as { THREE?: unknown }).THREE !== 'undefined'
        || !!document.querySelector('canvas'));
      if (!ok) return { nonBlank: false, detail: 'three module never loaded' };
      // WebGL canvas with preserveDrawingBuffer: read pixels directly.
      return page.evaluate(() => {
        const canvas = document.querySelector('canvas');
        if (!canvas) return { nonBlank: false, detail: 'no canvas' };
        const gl = canvas.getContext('webgl2') ?? canvas.getContext('webgl');
        if (!gl) return { nonBlank: false, detail: 'no webgl context' };
        const px = new Uint8Array(4 * 25);
        const { width, height } = canvas;
        let colored = 0;
        for (let yi = 0; yi < 5; yi++) {
          for (let xi = 0; xi < 5; xi++) {
            gl.readPixels(
              Math.floor((xi + 0.5) * width / 5), Math.floor((yi + 0.5) * height / 5),
              1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px.subarray((yi * 5 + xi) * 4),
            );
            const o = (yi * 5 + xi) * 4;
            if (px[o] > 60 || px[o + 1] > 60 || px[o + 2] > 60) colored++;
          }
        }
        return { nonBlank: colored > 3, detail: `${colored}/25 bright samples` };
      });
    });
  }, 60_000);

  it('tone artifact renders its expected paper canvas without a caught runtime error', async () => {
    await renderOffline('tone.html', async (page) => {
      const status = await page.$eval('#status', node => node.textContent ?? '');
      if (status.includes('runtime issue')) return { nonBlank: false, detail: status };
      const artifactDrew = await page.evaluate(() => Boolean((window as unknown as { __retainedTonePaperDrew?: boolean }).__retainedTonePaperDrew));
      if (!artifactDrew) return { nonBlank: false, detail: 'retained Tone drawing code did not complete' };
      if (process.env.SINTER_TONE_SCREENSHOT) await page.screenshot({ path: process.env.SINTER_TONE_SCREENSHOT });
      return canvas2dNonBlank(page, '#paper');
    });
  }, 60_000);

  it('blocked-egress log contains no CDN hosts (nothing even tried)', () => {
    const cdnAttempts = blocked.filter(u => /cdnjs\.cloudflare\.com|cdn\.jsdelivr\.net|unpkg\.com/.test(u));
    expect(cdnAttempts, `artifacts attempted CDN loads: ${cdnAttempts.join(', ')}`).toEqual([]);
  });
});
