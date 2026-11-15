import { createHash } from 'node:crypto';
import { afterAll, expect, it } from 'vitest';
import { HeadlessRenderer } from '../../src/render/HeadlessRenderer.js';
import { readVendorAsset, VENDOR_ASSETS } from '../../src/utils/vendorAssets.js';

// Real-browser gate: wrapped Three.js must load its pinned module under the
// wrapper's own CSP (script-src 'self', no data:) and draw to its canvas.
const renderer = new HeadlessRenderer();
afterAll(async () => { await renderer.close(); });

const TORUS = `const scene=new THREE.Scene();scene.background=new THREE.Color(0x000000);
const camera=new THREE.PerspectiveCamera(45,innerWidth/innerHeight,.1,100);camera.position.z=4;
const r=new THREE.WebGLRenderer({preserveDrawingBuffer:true});r.setSize(innerWidth,innerHeight);
document.body.appendChild(r.domElement);
scene.add(new THREE.Mesh(new THREE.TorusGeometry(1,.4,32,64),new THREE.MeshBasicMaterial({color:0xff0000})));
r.render(scene,camera);`;

it('renders wrapped Three.js through the pinned module under the wrapper CSP', async () => {
  const out = await renderer.render(TORUS, { domain: 'three', width: 320, height: 240,
    stabilizationTime: 500, timeout: 20000, networkPolicy: 'isolated' });
  expect(out.error).toBeUndefined();
  expect(out.success).toBe(true);
  expect(out.errors).toEqual([]);
  const moduleDigest = createHash('sha256')
    .update(await readVendorAsset(VENDOR_ASSETS.threeModule)).digest('hex');
  expect(out.containment?.assetDigests).toContain(moduleDigest);
  const sharp = (await import('sharp')).default;
  const { data } = await sharp(out.screenshot!.buffer).removeAlpha().raw()
    .extract({ left: 160 - 50, top: 120 - 1, width: 1, height: 1 }).toBuffer({ resolveWithObject: true });
  // The torus ring sits ~50px left of centre: pure red, not the black background.
  expect([data[0] > 200, data[1] < 40, data[2] < 40]).toEqual([true, true, true]);
}, 60000);

it('blocks a /vendor/ import outside the pinned registry', async () => {
  const html = `<!doctype html><html><head><script type="importmap">{"imports":{"x":"/vendor/three/0.160.0/not-pinned.js"}}</script></head>
<body><script type="module">import 'x';</script><canvas></canvas></body></html>`;
  const out = await renderer.render(html, { domain: 'html', width: 200, height: 100,
    stabilizationTime: 300, timeout: 15000 });
  expect(out.containment?.blockedRequests).toBe(1);
}, 60000);
