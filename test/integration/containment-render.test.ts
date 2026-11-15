import { afterAll, describe, expect, it } from 'vitest';
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
});
