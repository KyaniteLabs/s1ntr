import { afterAll, describe, expect, it, vi } from 'vitest';
import type { Browser, BrowserContext } from 'playwright';
import { HeadlessRenderer } from '../../src/render/HeadlessRenderer.js';

describe('embedded render containment in Chrome', () => {
  const renderer = new HeadlessRenderer();
  afterAll(async () => { await renderer.close(); });

  it('denies storage and realtime networking before embedded code runs', async () => {
    const html = `<!doctype html><html><head></head><body><canvas width="10" height="10"></canvas>
      <script>
        let storage = 'allowed', socket = 'allowed';
        try { void localStorage; } catch (e) { storage = e.message; }
        try { new WebSocket('ws://x'); } catch (e) { socket = e.message; }
        console.log('guard-probe:' + JSON.stringify({ storage, socket,
          installed: window.__liminalContainmentInstalled === true }));
        setTimeout(() => {}, 0);
      </script></body></html>`;
    const result = await renderer.render(html, {
      domain: 'html', networkPolicy: 'isolated', waitForStabilization: false,
    });
    expect(result.success, result.error).toBe(true);
    expect(result.logs).toContain('[log] guard-probe:{"storage":"LIMINAL_STORAGE_DENIED","socket":"LIMINAL_NETWORK_DENIED","installed":true}');
    expect(result.containment?.networkIsolated).toBe(true);
    expect(result.containment?.postRunCensus?.timers).toBeGreaterThanOrEqual(1);
  }, 30_000);
  it('keeps the guards when a vendor import map moves the page to the render origin', async () => {
    const code = `let storage='allowed',socket='allowed';
try{void localStorage;}catch(e){storage=e.message;}
try{new WebSocket('ws://x');}catch(e){socket=e.message;}
console.log('guard-probe:'+JSON.stringify({storage,socket,installed:window.__liminalContainmentInstalled===true}));
const r=new THREE.WebGLRenderer();r.setSize(64,64);document.body.appendChild(r.domElement);
r.render(new THREE.Scene(),new THREE.PerspectiveCamera());`;
    const result = await renderer.render(code, {
      domain: 'three', width: 64, height: 64, stabilizationTime: 300, timeout: 20_000, networkPolicy: 'isolated',
    });
    expect(result.success, result.error).toBe(true);
    expect(result.logs).toContain('[log] guard-probe:{"storage":"LIMINAL_STORAGE_DENIED","socket":"LIMINAL_NETWORK_DENIED","installed":true}');
    expect(result.containment?.networkIsolated).toBe(true);
  }, 60_000);

  it('closes all pages owned by each concurrent isolated render', async () => {
    await renderer.initialize();
    const { browser } = renderer as unknown as { browser: Browser };
    const newContext = browser.newContext.bind(browser);
    const owned: BrowserContext[] = [];
    const secondaryProbes: string[][] = [];
    const spy = vi.spyOn(browser, 'newContext').mockImplementation(async (options) => {
      const context = await newContext(options);
      owned.push(context);
      const addInitScript = context.addInitScript.bind(context);
      vi.spyOn(context, 'addInitScript').mockImplementationOnce(async (script) => {
        await addInitScript(script);
        const extra = await context.newPage();
        await extra.goto('about:blank');
        secondaryProbes.push(await extra.evaluate(() => [
          () => new WebSocket('ws://127.0.0.1:1'),
          () => new RTCPeerConnection(),
          () => window.localStorage,
        ].map(probe => {
          try { probe(); return 'allowed'; } catch (error) { return (error as Error).message; }
        })));
      });
      return context;
    });
    try {
      const html = '<!doctype html><html><body><canvas width="10" height="10"></canvas></body></html>';
      const render = () => renderer.render(html, {
        domain: 'html', networkPolicy: 'isolated', waitForStabilization: false,
      });
      const results = await Promise.all([render(), render()]);
      const denied = ['LIMINAL_NETWORK_DENIED', 'LIMINAL_NETWORK_DENIED', 'LIMINAL_STORAGE_DENIED'];
      expect(secondaryProbes).toEqual([denied, denied]);
      expect(owned).toHaveLength(2);
      expect(owned.map(context => context.pages())).toEqual([[], []]);
      for (const result of results) {
        expect(result.success, result.error).toBe(true);
        expect(result.containment).toMatchObject({
          networkIsolated: true, cleanupSucceeded: true, postRunCensus: { pagesBefore: 0, pagesAfter: 0 },
        });
      }
    } finally {
      spy.mockRestore();
    }
  }, 30_000);
});
