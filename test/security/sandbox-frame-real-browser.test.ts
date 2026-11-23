/**
 * Runtime isolation of the sandboxed generated-code frame, in real Chromium.
 *
 * jsdom neither runs srcdoc scripts nor enforces `sandbox` or CSP, so
 * test/unit/security/SandboxIsolation.test.ts can only check structure. This
 * suite loads the exact srcdoc and sandbox attribute the adapters ship into
 * an iframe on an http origin and runs hostile code in it. Each probe either
 * throws (blocked) or reaches the host (escaped). The `__pwn` probe is the
 * host function a breakout would call.
 *
 * Two negative controls prove the harness can see an escape: the same
 * payload with `allow-same-origin` added, and with the CSP meta removed.
 * If either control stops escaping, this suite is not testing anything.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import puppeteer, { type Browser, type Page } from 'puppeteer';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  SANDBOX_ATTRIBUTE,
  SANDBOX_CSP,
  buildSandboxSrcdoc,
} from '../../src/composition/adapters/sandboxFrame.js';
import { getChromeArgs } from '../../src/security/SandboxConfig.js';
import { resolveChromiumExecutablePath } from '../../src/utils/browserAssetFallbacks.js';

type Probes = Record<string, string>;

let server: Server;
let origin = '';
let leaks: string[] = [];
let browser: Browser;
let page: Page;

// Every probe reports 'blocked' when it throws and 'ESCAPED' when it works.
// Network probes cannot know the outcome in-frame, so the host counts hits.
function payload(leakUrl: string): string {
  return `
(function () {
  var out = {};
  function probe(name, fn) {
    try { out[name] = fn() === true ? 'ESCAPED' : 'blocked'; } catch (e) { out[name] = 'blocked'; }
  }
  probe('direct', function () { parent.__pwn('direct'); return true; });
  probe('top', function () { top.__pwn('top'); return true; });
  probe('ctor', function () { [].constructor.constructor('parent.__pwn("ctor")')(); return true; });
  probe('parentDocument', function () { return typeof parent.document.body === 'object'; });
  probe('localStorage', function () { return typeof window.localStorage.length === 'number'; });
  probe('cookie', function () { document.cookie = 'a=1'; return document.cookie.length > 0; });
  probe('indexedDB', function () { return typeof indexedDB.open === 'function' && !!indexedDB.open('x'); });
  probe('popup', function () { return !!window.open(${JSON.stringify(leakUrl)} + '?popup'); });
  probe('navigateTop', function () { top.location.href = ${JSON.stringify(leakUrl)} + '?nav'; return true; });
  try { fetch(${JSON.stringify(leakUrl)} + '?fetch', { mode: 'no-cors' }).catch(function () {}); } catch (e) {}
  try { var x = new XMLHttpRequest(); x.open('GET', ${JSON.stringify(leakUrl)} + '?xhr'); x.send(); } catch (e) {}
  try { new Image().src = ${JSON.stringify(leakUrl)} + '?img'; } catch (e) {}
  try { navigator.sendBeacon(${JSON.stringify(leakUrl)} + '?beacon', 'x'); } catch (e) {}
  try { new WebSocket(${JSON.stringify(leakUrl).replace('http', 'ws')} + '?ws'); } catch (e) {}
  try { var s = document.createElement('script'); s.src = ${JSON.stringify(leakUrl)} + '?script'; document.head.appendChild(s); } catch (e) {}
  window.__s1ntrReport(out);
})();`;
}

interface Run { probes: Probes; leaks: string[]; pwned: string[] }

/** Mount `srcdoc` in an iframe with the given sandbox attribute and wait for its report. */
async function runFrame(sandbox: string, srcdoc: string): Promise<Run> {
  leaks = [];
  await page.goto(`${origin}/host`);
  const probes = await page.evaluate(async (attr, doc) => {
    const w = window as unknown as { __pwned: string[] };
    w.__pwned = [];
    return await new Promise<Probes>((resolve) => {
      window.addEventListener('message', (e) => {
        const d = e.data as { tag?: string; state?: Probes } | null;
        if (d && d.tag === 's1ntr-sandbox-state' && d.state) resolve(d.state);
      });
      const f = document.createElement('iframe');
      f.setAttribute('sandbox', attr);
      f.srcdoc = doc;
      document.body.appendChild(f);
      setTimeout(() => resolve({ timeout: 'no report from frame' }), 8000);
    });
  }, sandbox, srcdoc);
  // Let in-flight network probes land (or be refused) before counting.
  await new Promise((r) => setTimeout(r, 800));
  const pwned = await page.evaluate(() => (window as unknown as { __pwned: string[] }).__pwned);
  return { probes, leaks: [...leaks], pwned };
}

const doc = (csp = true): string => {
  const html = buildSandboxSrcdoc({
    libs: [], script: payload(`${origin}/leak`), width: 100, height: 100, title: 'probe',
  });
  return csp ? html : html.replace(/<meta http-equiv="Content-Security-Policy"[^>]*>/, '');
};

beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.url?.startsWith('/leak')) {
      leaks.push(req.url);
      res.writeHead(200, { 'content-type': 'text/plain' }).end('leak');
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html' }).end(
      '<!doctype html><title>host</title><script>window.__pwned=[];window.__pwn=function(t){window.__pwned.push(t);};</script>',
    );
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const executablePath = resolveChromiumExecutablePath();
  if (!executablePath) throw new Error('No Chromium found for the real-browser sandbox test');
  browser = await puppeteer.launch({
    headless: true,
    executablePath,
    args: getChromeArgs({ forceDisableSandbox: process.env.LIMINAL_DISABLE_SANDBOX === 'true' }),
  });
  page = await browser.newPage();
}, 60_000);

afterAll(async () => {
  await browser?.close();
  await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
});

describe('sandbox frame isolation in real Chromium', () => {
  it('ships a sandbox attribute without allow-same-origin and a deny-by-default CSP', () => {
    expect(SANDBOX_ATTRIBUTE.split(/\s+/)).toEqual(['allow-scripts']);
    expect(SANDBOX_CSP).toContain("default-src 'none'");
  });

  it('blocks every host-reach probe and every network request from hostile code', async () => {
    const run = await runFrame(SANDBOX_ATTRIBUTE, doc());
    expect(run.probes).toEqual({
      direct: 'blocked', top: 'blocked', ctor: 'blocked', parentDocument: 'blocked',
      localStorage: 'blocked', cookie: 'blocked', indexedDB: 'blocked', popup: 'blocked',
      navigateTop: 'blocked',
    });
    expect(run.pwned).toEqual([]);
    expect(run.leaks).toEqual([]);
  }, 30_000);

  it('control: allow-same-origin lets the same payload reach the host (harness sees escapes)', async () => {
    const run = await runFrame(`${SANDBOX_ATTRIBUTE} allow-same-origin`, doc());
    expect(run.pwned).toEqual(expect.arrayContaining(['direct', 'ctor']));
    expect(run.probes.parentDocument).toBe('ESCAPED');
  }, 30_000);

  it('control: without the CSP meta the network probes reach the server (harness sees leaks)', async () => {
    const run = await runFrame(SANDBOX_ATTRIBUTE, doc(false));
    expect(run.leaks.length).toBeGreaterThan(0);
  }, 30_000);
});
