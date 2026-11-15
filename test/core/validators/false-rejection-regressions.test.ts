/**
 * False-rejection regression suite — reproductions from the 2026-08-29
 * deep-diver validator audit (H6 tone, H9 three, M6 p5, M4 strudel, H5
 * GenericWrapper). Each block pins a piece that IS valid art but WAS
 * killed by its validator/wrapper, plus the true positives that must
 * stay caught.
 */
import { describe, it, expect } from 'vitest';
import { ToneValidator } from '../../../src/core/validators/ToneValidator.js';
import { ThreeValidator } from '../../../src/core/validators/ThreeValidator.js';
import { P5Validator } from '../../../src/core/validators/P5Validator.js';
import { StrudelValidator } from '../../../src/core/validators/StrudelValidator.js';
import { GenericWrapper } from '../../../src/core/wrappers/GenericWrapper.js';

describe('false-rejection regressions (audit 2026-08-29)', () => {
  describe('H6 ToneValidator', () => {
    it('accepts Array.prototype.filter on plain arrays', () => {
      const code = `
const synth = new Tone.Synth().toDestination();
const notes = ["C4", "E4", "G4", "B4"];
const heard = notes.filter(n => n !== "E4");
heard.forEach((note, i) => synth.triggerAttackRelease(note, "8n", Tone.now() + i * 0.4));
      `;

      const result = ToneValidator.validate(code);
      expect(result.errors).not.toContain(expect.stringContaining('.filter'));
      expect(result.valid).toBe(true);
    });

    it('accepts osc.detune.value on Tone.Oscillator (detune is a Signal)', () => {
      const code = `
const osc = new Tone.Oscillator(220, "sine").toDestination();
osc.detune.value = -8;
osc.start();
      `;

      const result = ToneValidator.validate(code);
      expect(result.errors).not.toContain(expect.stringContaining('detune'));
      expect(result.valid).toBe(true);
    });

    it('accepts OmniOscillator, GrainPlayer and CrossFade classes', () => {
      const code = `
const osc = new Tone.OmniOscillator("sawtooth").toDestination();
const fade = new Tone.CrossFade(0.5).toDestination();
const player = new Tone.GrainPlayer("./loop.wav").connect(fade);
osc.start();
      `;

      const result = ToneValidator.validate(code);
      expect(result.errors).not.toContain(expect.stringContaining('Invalid class'));
      expect(result.valid).toBe(true);
    });

    it('still flags .filter on a receiver declared as a filterless synth', () => {
      const code = `
const pad = new Tone.PolySynth(Tone.Synth).toDestination();
pad.filter.frequency.value = 400;
pad.triggerAttackRelease(["C4", "E4"], "2n");
      `;

      const result = ToneValidator.validate(code);
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes('does not expose .filter'))).toBe(true);
    });

    it('still flags detune.value on a receiver declared as PolySynth', () => {
      const code = `
const pad = new Tone.PolySynth(Tone.Synth).toDestination();
pad.detune.value = 200;
      `;

      const result = ToneValidator.validate(code);
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes('PolySynth'))).toBe(true);
    });

    it('rejects syntactically broken code at validation (new syntax gate)', () => {
      const code = `
const synth = new Tone.Synth({
  oscillator: { type: "triangle"
      `;

      const result = ToneValidator.validate(code);
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes('invalid JavaScript syntax'))).toBe(true);
    });
  });

  describe('H9 ThreeValidator', () => {
    const sceneSetup = `
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 1000);
const renderer = new THREE.WebGLRenderer();
renderer.setSize(window.innerWidth, window.innerHeight);
document.body.appendChild(renderer.domElement);
const geometry = new THREE.BoxGeometry();
const material = new THREE.MeshBasicMaterial({ color: 0x4488cc });
const cube = new THREE.Mesh(geometry, material);
scene.add(cube);
camera.position.z = 5;
    `;

    it('accepts the canonical renderer.setAnimationLoop(animate) start', () => {
      const code = `${sceneSetup}
function animate() {
  cube.rotation.x += 0.01;
  cube.rotation.y += 0.01;
  renderer.render(scene, camera);
}
renderer.setAnimationLoop(animate);
      `;

      const result = ThreeValidator.validate(code);
      expect(result.errors).not.toContain(expect.stringContaining('never started'));
      expect(result.valid).toBe(true);
    });

    it('accepts requestAnimationFrame(animate) as the loop start', () => {
      const code = `${sceneSetup}
function animate() {
  cube.rotation.x += 0.01;
  renderer.render(scene, camera);
}
requestAnimationFrame(animate);
      `;

      const result = ThreeValidator.validate(code);
      expect(result.errors).not.toContain(expect.stringContaining('never started'));
      expect(result.valid).toBe(true);
    });

    it('skips the inline-mutation heuristic when animate delegates to a project helper', () => {
      const code = `${sceneSetup}
function updateCubeRotation(target, delta) {
  target.rotation.y += delta;
}
function animate() {
  updateCubeRotation(cube, 0.02);
  renderer.render(scene, camera);
}
renderer.setAnimationLoop(animate);
      `;

      const result = ThreeValidator.validate(code);
      expect(result.errors).not.toContain(expect.stringContaining('should mutate scene state'));
      expect(result.valid).toBe(true);
    });

    it('still flags an animate() that is never started', () => {
      const code = `${sceneSetup}
function animate() {
  cube.rotation.x += 0.01;
  renderer.render(scene, camera);
}
      `;

      const result = ThreeValidator.validate(code);
      expect(result.errors.some(e => e.includes('never started with animate()'))).toBe(true);
    });
  });

  describe('M6 P5Validator browser globals', () => {
    it('accepts performance/localStorage/devicePixelRatio/location/URL/fetch', () => {
      const code = `
let seedTime = performance.now();
let visits = 0;
try { visits = Number(localStorage.getItem("visits")) || 0; } catch (e) {}
visits += 1;
try { localStorage.setItem("visits", String(visits)); } catch (e) {}

function setup() {
  createCanvas(400, 400);
  pixelDensity(devicePixelRatio > 1 ? 2 : 1);
  const page = new URL(location.href);
  console.log(page.pathname);
}

function draw() {
  background(20);
  const elapsed = performance.now() - seedTime;
  ellipse(200 + 80 * Math.sin(elapsed / 900), 200, 40, 40);
  if (frameCount === 1) fetch("/ping").catch(() => {});
}
      `;

      const result = P5Validator.validate(code);
      expect(result.errors.filter(e => e.includes('undeclared identifier'))).toEqual([]);
      expect(result.valid).toBe(true);
    });
  });

  describe('M4 StrudelValidator paren balance', () => {
    it('rejects typographic characters the transpiler cannot parse (widened ASCII gate)', () => {
      const code = `
// wet ink scroll \u2014 variation 6583
$: s("bd sd hh")
      `;
      const result = StrudelValidator.validate(code);
      expect(result.errors.some(e => e.includes('non-ASCII'))).toBe(true);

      const asciiCode = `
// wet ink scroll - variation 6583
$: s("bd sd hh")
      `;
      expect(StrudelValidator.validate(asciiCode).valid).toBe(true);
    });

    it('ignores parens inside comments (smiley / prose false-kills)', () => {
      const code = `
// nice groove :)
$: s("bd sd hh")
      `;

      const result = StrudelValidator.validate(code);
      expect(result.errors).not.toContain(expect.stringContaining('unmatched parentheses'));
      expect(result.valid).toBe(true);
    });

    it('ignores parens inside pattern strings and template literals', () => {
      const code = `
// Voicing (open fifth
$: note(\`c3 [e3 g3]\`).s("piano")
$: s("bd sd").gain("[0.5 1]")
      `;

      const result = StrudelValidator.validate(code);
      expect(result.errors).not.toContain(expect.stringContaining('unmatched parentheses'));
      expect(result.valid).toBe(true);
    });

    it('still flags genuinely unbalanced code parens', () => {
      const code = `
$: s("bd sd"
      `;

      const result = StrudelValidator.validate(code);
      expect(result.errors.some(e => e.includes('unmatched parentheses'))).toBe(true);
    });
  });

  describe('H5 GenericWrapper raw-script embeds', () => {
    it('tone wrapper does not corrupt artwork template literals with backslash-escaping', () => {
      const code = `
const synth = new Tone.Synth().toDestination();
const label = \`bpm \${60 / 0.5}\`;
console.log(label);
synth.triggerAttackRelease("C4", "8n");
      `;

      const wrapped = GenericWrapper.wrap(code, { domain: 'tone' });
      expect(wrapped).toContain('`bpm');
      expect(wrapped).not.toContain('\\`');
    });

    it('tone artwork containing </script> routes to the HTML path — the page gains no extra script-close tag', () => {
      const code = `
const synth = new Tone.Synth().toDestination();
const broken = "</script>";
console.log(broken);
      `;

      const wrapped = GenericWrapper.wrap(code, { domain: 'tone' });
      // isHTMLFragment routes this to wrapToneHTML; the only </script> tags in
      // the page must be the wrapper's own (audio scope + CDN + inline = 3) —
      // the artwork's literal must never add a fourth.
      const closes = wrapped.match(/<\/script>/g) ?? [];
      expect(closes.length).toBe(3);
    });

    it('hydra wrapper does not corrupt artwork template literals', () => {
      const code = `
osc(30, 0.1, 0.5).color(2, 0.8, 0.4).out(o0);
const note = \`sync \${30 / 60}\`;
console.log(note);
      `;

      const wrapped = GenericWrapper.wrap(code, { domain: 'hydra' });
      expect(wrapped).toContain('`sync');
      expect(wrapped).not.toContain('\\`');
    });

    it('hydra wrapper escapes </script> in the artwork', () => {
      const code = `
osc(30).out(o0);
const closer = "</script>";
      `;

      const wrapped = GenericWrapper.wrap(code, { domain: 'hydra' });
      expect(wrapped).toContain('<\\/script>');
    });

    it('strudel artwork JSON embed escapes < so </script> cannot terminate the script tag, and still round-trips', () => {
      const code = `// intro (tape stop
$: s("bd sd hh").slow(2) // mention of </script> in a comment
$: note("c3 e3 g3").s("piano")
      `;

      const wrapped = GenericWrapper.wrap(code, { domain: 'strudel' });
      expect(wrapped).toContain('\\u003c');

      const artworkJson = wrapped.match(/var artwork = ("(?:[^"\\]|\\.)*")/)?.[1];
      expect(typeof artworkJson).toBe('string');
      expect(JSON.parse(artworkJson as string)).toBe(code);
    });
  });
});
