/**
 * Deterministic repair before the gate (LFM3 shard A, 2026-11-15). Each case is a failure
 * class from the shard's rows: code a model wrote that the gate rejected for one mechanical
 * slip. The repair runs only on rejected code and is kept only when the repaired code passes
 * every check, so code that already passes is never touched.
 */
import { describe, it, expect } from 'vitest';
import { CodeValidator } from '../../../src/core/CodeValidator.js';

// repairs run only after a rejection, so a non-empty \`repairs\` proves the fixture was rejected as written
function repaired(code: string, domain: string) {
  const r = CodeValidator.validate(code, domain);
  expect(r.repairs?.length, 'expected the fixture to be rejected, then repaired').toBeGreaterThan(0);
  return r;
}

describe('deterministic repair before the gate', () => {
  it('three: sets tone mapping on the renderer for a lit scene', () => {
    const code = `const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(60, innerWidth / innerHeight, 0.1, 100);
const renderer = new THREE.WebGLRenderer({
  antialias: true,
});
renderer.setSize(innerWidth, innerHeight);
document.body.appendChild(renderer.domElement);
const mesh = new THREE.Mesh(new THREE.TorusKnotGeometry(1, 0.3, 128, 16), new THREE.MeshStandardMaterial({ color: 0x8866ff }));
scene.add(mesh);
scene.add(new THREE.AmbientLight(0xffffff, 0.4));
const key = new THREE.DirectionalLight(0xffffff, 1.2); key.position.set(3, 4, 5); scene.add(key);
camera.position.z = 5;
function animate() { requestAnimationFrame(animate); mesh.rotation.y += 0.01; renderer.render(scene, camera); }
animate();`;
    const r = repaired(code, 'three');
    expect(r.errors).toEqual([]);
    expect(r.valid).toBe(true);
    expect(r.cleanedCode).toMatch(/\}\);\nrenderer\.toneMapping = THREE\.ACESFilmicToneMapping;/);
    expect(r.repairs).toEqual(['three:toneMapping']);
  });

  it('three: adds lights to a lit scene that has none', () => {
    const code = `const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(60, innerWidth / innerHeight, 0.1, 100);
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = 1.0;
renderer.setSize(innerWidth, innerHeight);
document.body.appendChild(renderer.domElement);
const mesh = new THREE.Mesh(new THREE.SphereGeometry(1, 48, 48), new THREE.MeshStandardMaterial({ color: 0x8866ff }));
scene.add(mesh);
camera.position.z = 4;
function animate() { requestAnimationFrame(animate); mesh.rotation.y += 0.01; renderer.render(scene, camera); }
animate();`;
    const r = repaired(code, 'three');
    expect(r.errors).toEqual([]);
    expect(r.repairs).toEqual(['three:lights']);
  });

  it('three: keeps a canvas the sketch makes for itself; the wrapper supplies none (#1756)', () => {
    const code = `const canvas = document.createElement('canvas');
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(60, innerWidth / innerHeight, 0.1, 100);
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setSize(innerWidth, innerHeight);
const mesh = new THREE.Mesh(new THREE.IcosahedronGeometry(1, 2), new THREE.MeshBasicMaterial({ color: 0x8866ff, wireframe: true }));
scene.add(mesh);
const starGeo = new THREE.BufferGeometry();
const starPos = new Float32Array(600 * 3);
for (let i = 0; i < starPos.length; i++) starPos[i] = (Math.random() - 0.5) * 40;
starGeo.setAttribute('position', new THREE.BufferAttribute(starPos, 3));
const stars = new THREE.Points(starGeo, new THREE.PointsMaterial({ color: 0xccbbff, size: 0.05 }));
scene.add(stars);
camera.position.z = 4;
function animate() {
  requestAnimationFrame(animate);
  mesh.rotation.y += 0.01;
  mesh.rotation.x += 0.004;
  stars.rotation.y -= 0.0005;
  renderer.render(scene, camera);
}
animate();`;
    // The removed `three:canvas` repair deleted this line and left `canvas` undeclared.
    const r = CodeValidator.validate(code, 'three');
    expect(r.errors).toEqual([]);
    expect(r.repairs ?? []).toEqual([]);
    expect(r.cleanedCode ?? code).toMatch(/const canvas = document\.createElement\('canvas'\);/);
  });

  it('hydra: drops import lines and closes the last chain with .out()', () => {
    const code = `import Hydra from 'hydra-synth'
osc(10, 0.1, 1.2)
  .kaleid(4)
  .color(0.9, 0.4, 1.2)
  .modulate(noise(3, 0.1), 0.2)
  .rotate(() => time * 0.05)
  .blend(shape(5, 0.4, 0.02).repeat(3, 3), 0.3)`;
    const r = repaired(code, 'hydra');
    expect(r.errors).toEqual([]);
    expect(r.cleanedCode).not.toMatch(/import/);
    expect(r.cleanedCode.trim().endsWith('.out()')).toBe(true);
    expect(r.repairs).toEqual(['hydra:imports', 'hydra:out']);
  });

  it('strudel: maps typographic characters to ASCII', () => {
    const code = `// drums — kick and snare
stack(s("bd ~ sd ~"), note("c3 e3 g3").s("sawtooth"))`;
    const r = repaired(code, 'strudel');
    expect(r.errors).toEqual([]);
    expect(r.cleanedCode).toContain('// drums - kick and snare');
    expect(r.repairs).toEqual(['strudel:ascii']);
  });

  it('glsl: declares the uniforms the wrapper supplies', () => {
    const code = `precision mediump float;
void main() {
  vec2 uv = gl_FragCoord.xy / u_resolution.xy;
  vec2 p = uv - 0.5;
  p.x *= u_resolution.x / u_resolution.y;
  float ring = smoothstep(0.02, 0.0, abs(length(p) - 0.3 - 0.05 * sin(u_time * 2.0)));
  vec3 col = 0.5 + 0.5 * cos(u_time + uv.xyx + vec3(0.0, 2.0, 4.0));
  gl_FragColor = vec4(col * (0.4 + ring), 1.0);
}`;
    const r = repaired(code, 'glsl');
    expect(r.errors).toEqual([]);
    expect(r.cleanedCode).toContain('uniform float u_time;');
    expect(r.cleanedCode).toContain('uniform vec2 u_resolution;');
    expect(r.repairs).toEqual(['glsl:uniforms']);
  });

  it('glsl: leaves a uniform the wrapper does not supply as an error', () => {
    const r = CodeValidator.validate(`precision mediump float;
uniform float u_time;
uniform vec2 u_resolution;
void main() {
  vec2 uv = gl_FragCoord.xy / u_resolution.xy;
  float wave = sin(uv.x * 12.0 + u_time * u_speed) * 0.5 + 0.5;
  vec3 col = mix(vec3(0.1, 0.0, 0.3), vec3(0.8, 0.5, 1.0), wave * uv.y);
  gl_FragColor = vec4(col, 1.0);
}`, 'glsl');
    expect(r.valid).toBe(false);
    expect(r.errors).toEqual(expect.arrayContaining([expect.stringContaining("'u_speed'")]));
    expect(r.repairs).toBeUndefined();
  });

  it('tone: maps Tone.OSC to Tone.Oscillator; invented classes with no clear match stay errors', () => {
    const osc = `const osc = new Tone.OSC(220, "sine").toDestination();
osc.volume.value = -12;
osc.start();
Tone.Transport.start();`;
    const r = repaired(osc, 'tone');
    expect(r.errors).toEqual([]);
    expect(r.cleanedCode).toContain('new Tone.Oscillator(');
    expect(r.repairs).toEqual(['tone:aliases']);

    const note = CodeValidator.validate(`const n = new Tone.Note("C4");
const s = new Tone.Synth().toDestination();
s.triggerAttackRelease("C4", "8n");`, 'tone');
    expect(note.valid).toBe(false);
    expect(note.repairs).toBeUndefined();
  });

  it('never touches code that already passes', () => {
    const ok = `osc(10, 0.1, 1.2)
  .kaleid(4)
  .color(0.9, 0.4, 1.2)
  .modulate(noise(3, 0.1), 0.2)
  .rotate(() => time * 0.05)
  .blend(shape(5, 0.4, 0.02).repeat(3, 3), 0.3)
  .out()`;
    const r = CodeValidator.validate(ok, 'hydra');
    expect(r.valid).toBe(true);
    expect(r.cleanedCode).toBe(ok);
    expect(r.repairs).toBeUndefined();
  });

  it('keeps the original errors when a repair does not make the code pass', () => {
    const code = `import x from 'y'
const notHydra = 1;`;
    const r = CodeValidator.validate(code, 'hydra');
    expect(r.valid).toBe(false);
    expect(r.cleanedCode).toContain('import');
    expect(r.repairs).toBeUndefined();
  });
});
