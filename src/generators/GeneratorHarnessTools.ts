import { MetabolicEntropyEngine } from '../entropy/MetabolicEntropyEngine.js';
import type { GenerationEvaluation } from '../core/types/GenerationEvaluation.js';

/**
 * GeneratorHarnessTools - Thin domain-contract harness helpers
 *
 * Provides bounded, stochastic rails that help LLMs produce valid domain output
 * without replacing LLM generation with static template fallback.
 *
 * Core principle: generators are thin harnesses. They give the model better rails
 * before generation (via skeleton/API/hint sampling) and better repair instructions
 * after validation failures (via failure classification + targeted prompts).
 *
 * NON-GOALS:
 * - NOT a static template fallback system
 * - NOT a deterministic code generator
 * - NOT a multimodal evaluator
 *
 * This slice implements only the helper service + wiring into TierBasedGenerator.
 * Success memory is in-memory only (file-backed storage is optional/non-blocking).
 */

export type FailureClass =
  | 'wrong_domain'
  | 'missing_required_api'
  | 'too_short'
  | 'truncated'
  | 'empty_after_reasoning_strip'
  | 'wrapper_contract_mismatch'
  | 'runtime_error'
  | 'unknown';

// ---------------------------------------------------------------------------
// Failure Classification Normalization (DF3 Flywheel Unlock)
// ---------------------------------------------------------------------------

/**
 * Map domain-specific FailureClass values to the shared GenerationEvaluation contract.
 */
export function classifyFailureForEvaluation(
  failure: FailureClass | string,
  context?: { renderFailed?: boolean; validationFailed?: boolean; scoreFailed?: boolean }
): GenerationEvaluation['failureClass'] {
  if (context?.renderFailed) {
    return 'render';
  }
  if (context?.validationFailed) {
    return 'validator';
  }
  if (context?.scoreFailed) {
    return 'scorer';
  }

  switch (failure) {
    case 'runtime_error':
    case 'wrapper_contract_mismatch':
    case 'wrong_domain':
    case 'missing_required_api':
    case 'too_short':
    case 'truncated':
    case 'empty_after_reasoning_strip':
      return 'validator';
    default:
      return 'none';
  }
}

/**
 * Build a minimal GenerationEvaluation pick from a classified failure.
 */
export function buildFailureEvaluation(
  failure: FailureClass | string,
  context?: { renderFailed?: boolean; validationFailed?: boolean; scoreFailed?: boolean }
): Pick<GenerationEvaluation, 'score' | 'confidence' | 'failureClass'> {
  return {
    score: 0,
    confidence: 1,
    failureClass: classifyFailureForEvaluation(failure, context),
  };
}

// ---------------------------------------------------------------------------
// Domain Skeleton & API Data
// ---------------------------------------------------------------------------

interface DomainSkeleton {
  domain: string;
  skeletonText: string;
  requiredApis: string[];
  shapeNotes: string;
}

interface DomainApiVocab {
  domain: string;
  apis: string[];
  contaminationDomains: string[];
}

const PILOT_DOMAINS: DomainSkeleton[] = [
  {
    domain: 'tone',
    skeletonText: `// Tone.js synthesis skeleton
const synth = new Tone.Synth().toDestination();
// Transport pattern:
Tone.Transport.scheduleRepeat((time) => {
  synth.triggerAttackRelease("C4", "8n", time);
}, "4n");
Tone.Transport.start();`,
    requiredApis: ['Tone.Synth', 'Tone.PolySynth', 'Tone.LFO', 'Tone.Reverb', 'Tone.Transport', 'Tone.Sequence', 'Tone.Part', 'Tone.Sampler'],
    shapeNotes: 'full Tone.js synth chain with Transport',
  },
  {
    domain: 'strudel',
    skeletonText: `// Strudel pattern skeleton
stack(
  s("bd cp:2 ~ hh").swing(0.1),
  note("C4 ~ D4 E4 ~").swing(0.1)
)`,
    requiredApis: ['stack', 's(', 'sound(', 'note(', 'slow(', 'fast(', 'gain', '.delay(', '.room(', '.pan('],
    shapeNotes: 'Strudel REPL pattern with stack + sound/note calls',
  },
  {
    domain: 'ascii',
    skeletonText: `// ASCII art -- 40 chars wide, allowed: . - ~ + = * # % @ / \\ | _ ( ) [ ]
// Example line:    . - ~ + = * # % @ / \\ | _ ( ) [ ]
   .-..   .-..
  /   \\ |   |
 | ^   || ^ |
  \\   / \\   /
   \`-.-'   \`-.`,
    requiredApis: [],
    shapeNotes: 'fixed-width monospace grid, 40 columns, no code fences',
  },
  {
    domain: 'three',
    skeletonText: `// Three.js scene skeleton
const scene = new THREE.Scene();
const width = window.innerWidth;
const height = window.innerHeight;
const camera = new THREE.PerspectiveCamera(75, width / height, 0.1, 1000);
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(width, height);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.0;
document.body.appendChild(renderer.domElement);
// Mesh:
const geo = new THREE.BoxGeometry(1, 1, 1);
const mat = new THREE.MeshStandardMaterial({ color: 0xff0000 });
const mesh = new THREE.Mesh(geo, mat);
scene.add(mesh);
scene.add(new THREE.AmbientLight(0xffffff, 0.5));
const keyLight = new THREE.DirectionalLight(0xffffff, 1);
keyLight.position.set(3, 4, 5);
scene.add(keyLight);
camera.position.z = 5;
// Render loop:
function animate() {
  requestAnimationFrame(animate);
  mesh.rotation.y += 0.01;
  renderer.render(scene, camera);
}
animate();`,
    requiredApis: ['THREE.Scene', 'THREE.WebGLRenderer', 'THREE.PerspectiveCamera', 'THREE.Mesh', 'THREE.BoxGeometry', 'THREE.MeshStandardMaterial', 'scene.add', 'requestAnimationFrame'],
    shapeNotes: 'Three.js scene + camera + renderer + mesh + render loop',
  },
  {
    domain: 'glsl',
    skeletonText: `// GLSL fragment shader skeleton
precision mediump float;
uniform float u_time;
uniform vec2 u_resolution;
void main() {
  vec2 uv = gl_FragCoord.xy / u_resolution.xy;
  vec3 color = vec3(uv.x, uv.y, 0.5 + 0.5 * sin(u_time));
  gl_FragColor = vec4(color, 1.0);
}
//// Alternative mainImage variant:
// void mainImage(out vec4 fragColor, in vec2 fragCoord) {
//   vec2 uv = fragCoord / u_resolution;
//   fragColor = vec4(uv, 0.5, 1.0);
// }`,
    requiredApis: ['precision', 'uniform float u_time', 'uniform vec2 u_resolution', 'gl_FragColor', 'void main', 'mainImage', 'vec2', 'vec3', 'vec4'],
    shapeNotes: 'GLSL fragment shader with precision + uniforms + main() or mainImage()',
  },
  {
    domain: 'revideo',
    skeletonText: `// Revideo scene skeleton -- generator function shape, not React component
// Do not use Remotion, @revideo/react, React.FC, useFrame, useCurrentFrame, or makeScene({ render: ... }).
import { makeScene2D, Txt, Rect } from '@revideo/2d';
import { createRef, waitFor } from '@revideo/core';

export default makeScene2D('TypingScene', function* (view) {
  const text = createRef<Txt>();
  view.add(
    <Rect width={'100%'} height={'100%'} fill={'#111'}>
      <Txt ref={text} text={'Hello'} fill={'#fff'} fontSize={72} />
    </Rect>
  );
  yield* text().opacity(1, 0.5);
  yield* waitFor(1);
});`,
    requiredApis: ['makeScene2D', 'createRef', 'waitFor', '@revideo/core', '@revideo/2d', 'Txt', 'Rect', 'view.add', 'yield*'],
    shapeNotes: 'Revideo makeScene2D(name, function* (view) { view.add(...); yield* ... }) scene',
  },
  {
    domain: 'hyperframes',
    skeletonText: `<!doctype html>
<html>
<head>
<script src="/vendor/gsap/3.15.0/gsap.min.js"></script>
<style>html,body{margin:0;width:100%;height:100%;background:#05060a;overflow:hidden}
.stage{position:absolute;inset:0}.shape{position:absolute;left:45%;top:45%;width:10%;height:10%;background:#9b8cff}</style>
</head>
<body>
<div class="stage" data-composition-id="main" data-width="1920" data-height="1080" data-duration="8">
  <div class="clip shape" data-start="0" data-duration="8"></div>
</div>
<script>
const tl = gsap.timeline({ paused: true });
tl.from('.shape', { scale: 0, opacity: 0, duration: 1.5, ease: 'power2.out' })
  .to('.shape', { rotation: 180, x: 200, duration: 3, ease: 'sine.inOut' });
window.__timelines = { main: tl };
</script>
</body>
</html>`,
    requiredApis: ['data-composition-id', 'class="clip"', 'gsap.timeline', 'tl.to', 'tl.from', 'window.__timelines', '/vendor/gsap/3.15.0/gsap.min.js'],
    shapeNotes: 'one HTML page: a data-composition-id="main" root with class="clip" elements, a paused gsap.timeline registered on window.__timelines',
  },
  {
    domain: 'hydra',
    skeletonText: `// Hydra video synth skeleton -- globals only, no imports, one chain ending in .out()
osc(12, 0.08, 1.4)
  .rotate(() => time * 0.05)
  .modulate(noise(3, 0.2), 0.15)
  .kaleid(5)
  .color(0.7, 0.5, 1.0)
  .out()`,
    requiredApis: ['osc(', 'noise(', 'shape(', 'voronoi(', '.rotate(', '.modulate(', '.kaleid(', '.color(', '.out()'],
    shapeNotes: 'Hydra source -> transforms -> .out(); globals, no import or export',
  },
  {
    domain: 'p5',
    skeletonText: `// p5.js sketch skeleton -- global mode, no imports
function setup() {
  createCanvas(800, 600);
  noStroke();
}
function draw() {
  background(5, 6, 10, 40);
  const t = frameCount * 0.01;
  for (let i = 0; i < 12; i++) {
    fill(155, 140, 255, 160);
    circle(width / 2 + cos(t + i) * 200, height / 2 + sin(t * 1.3 + i) * 150, 24);
  }
}`,
    requiredApis: ['function setup', 'createCanvas', 'function draw', 'background', 'frameCount', 'noise(', 'fill', 'circle'],
    shapeNotes: 'p5 global mode: setup() with createCanvas, draw() loop',
  },
];

const DOMAIN_API_VOCAB: DomainApiVocab[] = [
  {
    domain: 'tone',
    apis: ['Tone.Synth', 'Tone.PolySynth', 'Tone.FMSynth', 'Tone.AMSynth', 'Tone.MembraneSynth', 'Tone.MetalSynth', 'Tone.LFO', 'Tone.Reverb', 'Tone.Delay', 'Tone.Chorus', 'Tone.Distortion', 'Tone.Phaser', 'Tone.Tremolo', 'Tone.Transport', 'Tone.Sequence', 'Tone.Part', 'Tone.Sampler', 'Tone.Channel', 'Tone.Filter', 'Tone.Panner', '.toDestination()', '.triggerAttackRelease('],
    contaminationDomains: ['p5.sound', 'Howler.js', 'Tone.js sync with seconds not 4n'],
  },
  {
    domain: 'strudel',
    apis: ['stack(', 's(', 'sound(', 'note(', '.slow(', '.fast(', '.gain(', '.delay(', '.room(', '.pan(', '.cutoff(', '.resonance(', '.attack(', '.decay(', '.sustain(', '.release(', '.every(', '.cat(', '.seq(', '.struct(', '// $:'],
    contaminationDomains: ['TidalCycles', 'SuperDirt', 'hydra', 'p5.sound'],
  },
  {
    domain: 'ascii',
    apis: [],
    contaminationDomains: ['SVG', 'HTML canvas', 'WebGL', 'unicode art symbols'],
  },
  {
    domain: 'three',
    apis: ['THREE.Scene', 'THREE.WebGLRenderer', 'THREE.PerspectiveCamera', 'THREE.OrthographicCamera', 'THREE.Mesh', 'THREE.BoxGeometry', 'THREE.SphereGeometry', 'THREE.PlaneGeometry', 'THREE.MeshStandardMaterial', 'THREE.MeshBasicMaterial', 'THREE.Color', 'THREE.DirectionalLight', 'THREE.AmbientLight', 'THREE.PointLight', 'THREE.BufferGeometry', 'THREE.BufferAttribute', 'scene.add(', 'requestAnimationFrame', 'renderer.render(', 'camera.position', '.setSize('],
    contaminationDomains: ['three-glfx', 'three-bokeh', 'generic WebGL without THREE namespace', 'Remotion THREE import'],
  },
  {
    domain: 'glsl',
    apis: ['precision mediump float', 'uniform float u_time', 'uniform vec2 u_resolution', 'uniform vec2 u_mouse', 'gl_FragColor', 'gl_FragCoord', 'void main()', 'void mainImage(', 'vec2 uv', 'vec3 color', 'vec4(', 'float ', 'int ', 'mat2', 'mat3', 'mat4', 'sampler2D', 'texture2D(', 'sin(', 'cos(', 'mix(', 'smoothstep(', 'length(', 'distance(', 'normalize(', 'reflect('],
    contaminationDomains: ['three-glsl', 'Unity HLSL', 'WebGL1 without precision', 'shadertoy without gl_FragColor'],
  },
  {
    domain: 'revideo',
    apis: ['makeScene2D', 'createRef', 'waitFor', '@revideo/core', '@revideo/2d', 'Txt', 'Rect', 'view.add(', 'yield*', 'function* (view)', 'export default makeScene2D('],
    contaminationDomains: ['remotion', '@revideo/react', 'useFrame', 'useCurrentFrame', 'React.FC', 'makeScene({ render:', 'elements: ['],
  },
];

// ---------------------------------------------------------------------------
// Prompt Hardening Hints
// ---------------------------------------------------------------------------

interface HardeningHint {
  id: string;
  text: string;
  domains: string[] | 'all';
}

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

/** SSS+ system lessons (sovereign channel): scorecard defects compound into
 *  generation hints at runtime — the system improves without code edits. */
function loadSystemLessons(domain: string): HardeningHint[] {
  try {
    const lessonsPath = join(process.cwd(), '.omx', 'atelier', 'lessons', 'hints.json');
    if (!existsSync(lessonsPath)) return [];
    const parsed = JSON.parse(readFileSync(lessonsPath, 'utf8')) as HardeningHint[];
    return parsed.filter(h => h.domains === 'all' || (Array.isArray(h.domains) && h.domains.includes(domain)));
  } catch (error) {
    console.warn(`[teaching] system lessons file is invalid and was skipped: ${error instanceof Error ? error.message : String(error)}`);
    return [];
  }
}

const HARDENING_HINTS: HardeningHint[] = [
  { id: 'raw_code_only', text: 'Output only raw code. No prose, no markdown fences, no explanation.', domains: 'all' },
  { id: 'include_required_imports', text: 'Include all required import statements or CDN links for the target library.', domains: ['tone', 'strudel', 'hydra', 'revideo', 'p5'] },
  { id: 'full_html_shell', text: 'Wrap output in a complete, runnable HTML document (doctype + html + head + body).', domains: ['tone', 'strudel', 'hydra', 'p5', 'kinetic', 'nbe'] },
  { id: 'p5_valid_syntax_no_shadowing', text: 'Emit syntactically valid JavaScript only — balanced braces/parens/brackets, complete statements. Never declare local variables or functions that shadow p5.js built-ins (pop, push, redraw, scale, rotate, translate, background, fill).', domains: ['p5'] },
  { id: 'tone_transport_pattern', text: 'Use Tone.Transport.scheduleRepeat or Tone.Sequence for rhythmic patterns. Do not use Tone.start() without Transport. Tone.Transport and Tone.Destination are ready-made objects: never write new Tone.Transport() or Tone.Destination(); waveforms are set with oscillator.type, not setValueAtTime.', domains: ['tone'] },
  { id: 'tone_synth_chain', text: 'Chain: Synth -> Channel/Effects -> toDestination(). Include Tone.Transport.start().', domains: ['tone'] },
  { id: 'hydra_api_constraints', text: 'Hydra has NO .sin()/.cos()/.sqrt()/.pow()/.feedback() methods — never call JS math on sources. Build visuals from osc()/noise()/shape()/gradient() chained with .rotate()/.scale()/.modulate()/.kaleid()/.repeat()/.color(); math-like shaping via .mult()/.add() with other sources. .modulate() and .mult()/.add()/.blend()/.diff()/.layer()/.mask() take a SOURCE first, then an amount: .modulate(noise(3), 0.1), .mult(osc(4), 0.5); never .modulate(0.5), .modulate(() => ...) or an empty .modulate(). Number transforms (.scale/.rotate/.scrollX) take numbers or () => ... directly. ALWAYS end the chain with .out().', domains: ['hydra'] },
  { id: 'strudel_stack', text: 'Wrap patterns in stack() to combine multiple voices. End with the bare stack(...) expression: no .out() (that is a Kabelsalat signal method; on a pattern it routes the sound away and the piece plays silence).', domains: ['strudel'] },
  { id: 'strudel_sound_note', text: 'Use s() for samples and note() for synthesized notes.', domains: ['strudel'] },
  { id: 'strudel_pattern_strings', text: 'Pass quoted pattern strings to s(), sound(), and note() — never raw numbers like s(100).', domains: ['strudel'] },
  { id: 'strudel_complete_structure', text: 'If you open stack(, close it and include complete child patterns; do not leave truncated stack(...) output.', domains: ['strudel'] },
  { id: 'ascii_monospace', text: 'ASCII art must be fixed-width monospace. Prefer standard ASCII symbols, but extended art glyphs like box drawing, block elements, stars, and diagonal strokes are allowed when they improve the piece.', domains: ['ascii'] },
  { id: 'ascii_no_fences', text: 'Output raw ASCII only. No code fences, no triple-backtick, no markdown markers.', domains: ['ascii'] },
  { id: 'three_scene_camera_renderer', text: 'Include THREE.Scene, THREE.PerspectiveCamera, THREE.WebGLRenderer, and a mesh in scene. Call renderer.render in a loop.', domains: ['three'] },
  { id: 'three_wrapper_raw_scene', text: 'Return raw Three.js scene JavaScript only. Do not include imports, import maps, <script>, <!DOCTYPE html>, or <html>; the gallery wrapper supplies those.', domains: ['three'] },
  { id: 'glsl_precision', text: 'Always start with precision mediump float; and declare all uniforms (u_time, u_resolution).', domains: ['glsl'] },
  { id: 'glsl_main_or_mainimage', text: 'Use either void main() with gl_FragColor, or void mainImage(out vec4, in vec2) -- not both mixed.', domains: ['glsl'] },
  { id: 'revideo_makescene_shape', text: 'Use export default makeScene2D("SceneName", function* (view) { ... }). Do not use makeScene({ render: ... }).', domains: ['revideo'] },
  { id: 'revideo_no_react', text: 'Do not use Remotion, @revideo/react, React.FC, useFrame, or useCurrentFrame. Use @revideo/core plus @revideo/2d.', domains: ['revideo'] },
  { id: 'revideo_scene_components', text: 'Use view.add(...), yield* animations, and @revideo/2d components such as Txt and Rect.', domains: ['revideo'] },
  { id: 'no_contamination', text: 'Do not mix frameworks. For Three.js, use only THREE namespace. For GLSL, use only WebGL/GLSL conventions.', domains: 'all' },
  { id: 'wrapper_full_html', text: 'Return a complete HTML file. Do not return a fragment or code block -- wrapForGallery depends on full HTML.', domains: ['tone', 'strudel'] },
];

// ---------------------------------------------------------------------------
// Failure-Class Repair Prompts
// ---------------------------------------------------------------------------

interface RepairPromptTemplate {
  failureClass: FailureClass;
  template: string;
}

const REPAIR_PROMPT_TEMPLATES: RepairPromptTemplate[] = [
  {
    failureClass: 'wrong_domain',
    template: 'The output used the wrong framework or domain.\nREGENERATE in the exact target domain. Forbidden frameworks: {forbiddenDomains}.\nRequired domain APIs: {requiredApis}.\nOutput only raw code, no prose.',
  },
  {
    failureClass: 'missing_required_api',
    template: 'The output is missing required API tokens for this domain.\nPATCH or REGENERATE using these required APIs: {requiredApis}\nKeep the same intent and structure, but ensure at least 2 of these APIs appear in the output.\nOutput the complete artifact as raw code, no prose.',
  },
  {
    failureClass: 'too_short',
    template: 'The output is too short to be a complete {domain} artifact.\nEXPAND while preserving the domain and intent.\nAdd more content: fuller implementation, more detail, more complete structure.\nOutput the complete expanded artifact code, no prose.',
  },
  {
    failureClass: 'truncated',
    template: 'The output appears to be truncated (unclosed braces, incomplete expression, or missing trailing characters), most often because it hit the output token limit.\nREGENERATE the complete {domain} artifact from its first line, more compact so it fits: fewer lines, no comments, no repeated blocks.\nNever output a continuation or a fragment; the reply code replaces the previous output whole. No markdown fences.',
  },
  {
    failureClass: 'empty_after_reasoning_strip',
    template: 'All content was stripped away (reasoning tags, explanation, etc.) and nothing usable remains.\nREGENERATE: output only the final raw {domain} code/art with zero reasoning, explanation, or prose.\nNo <think> tags. No markdown fences. No comments explaining the output.',
  },
  {
    failureClass: 'wrapper_contract_mismatch',
    template: 'The output does not match the wrapper contract for {domain}.\nExpected: {wrapperExpectation}\nREGENERATE to match the exact contract. For HTML domains, return a full DOCTYPE document. For fragment-returning wrappers, return the fragment only.\nOutput only the correctly formatted code, no explanation.',
  },
  {
    failureClass: 'runtime_error',
    template: 'The output caused a runtime or compile error.\nMINIMAL REPAIR: fix the failing section and keep everything else as it was.\nError: {runtimeError}\nOutput the complete corrected artifact code, not just the changed section; the reply replaces the previous output whole. No explanation.',
  },
  {
    failureClass: 'unknown',
    template: 'The output failed validation for an unknown reason.\nREGENERATE from scratch with more care. Ensure the output:\n1. Is valid {domain} code/art\n2. Contains required APIs: {requiredApis}\n3. Is a complete, non-empty artifact\nOutput only the regenerated code, no prose.',
  },
];

// ---------------------------------------------------------------------------
// Wrapper Contract Descriptions
// ---------------------------------------------------------------------------

const WRAPPER_CONTRACTS: Record<string, string> = {
  tone: 'Complete HTML page with Tone.js loaded via CDN, synth/pattern code in a <script type="module">, audio-playing pattern.',
  strudel: 'Complete HTML page with Strudel REPL loaded via CDN, pattern code ending in a bare stack(...) (no .out()) in a <script type="module">.',
  ascii: 'Raw fixed-width ASCII art text only -- no HTML, no code fences, no markdown.',
  three: 'Raw Three.js scene JavaScript only; the gallery wrapper injects the HTML shell, module script, and Three.js CDN. Do not return <!DOCTYPE html>, <html>, <script>, import maps, or import statements.',
  glsl: 'GLSL fragment shader code only (precision + uniforms + main or mainImage), no HTML wrapper.',
  shader: 'GLSL fragment shader code only (precision + uniforms + main or mainImage), no HTML wrapper.',
  hydra: 'Complete HTML page with Hydra loaded via CDN, visual synth code in <script type="module">.',
  kinetic: 'Complete HTML page with kineticjs or raw DOM animation, full document structure.',
  revideo: 'Revideo scene file using export default makeScene2D("SceneName", function* (view) { ... }), @revideo/2d components, @revideo/core helpers, view.add(...), and yield* animations. No Remotion, @revideo/react, React.FC, useFrame, useCurrentFrame, or makeScene({ render: ... }).',
  p5: 'Complete HTML page with p5.js loaded via CDN, draw() and setup() functions in <script>.',
};

// ---------------------------------------------------------------------------
// GeneratorHarnessTools
// ---------------------------------------------------------------------------

/**
 * The full, unsampled scaffold for a domain: a skeleton that passes the domain's own gate,
 * its API vocabulary and every static hardening rule. External harnesses (the LFM3 shard
 * worker) read this so a rule hardened here reaches every model that writes for sinter.
 */
export function domainScaffold(domain: string): { skeleton: string; apis: string[]; rules: string[] } | null {
  const d = domain === 'shader' ? 'glsl' : domain;
  const skeleton = PILOT_DOMAINS.find(s => s.domain === d);
  if (!skeleton) return null;
  return {
    skeleton: skeleton.skeletonText,
    apis: [...(DOMAIN_API_VOCAB.find(v => v.domain === d)?.apis ?? [])],
    rules: HARDENING_HINTS.filter(h => h.domains === 'all' || h.domains.includes(d)).map(h => h.text),
  };
}

export interface GeneratorHarnessContext {
  domain: string;
  skeletonHint: string;
  sampledApis: string[];
  hardeningHints: string[];
  hintsWereSampled: boolean;
}

export interface FailureClassification {
  failureClass: FailureClass;
  evidence: string;
  suggestedApis?: string[];
  forbiddenDomains?: string[];
  runtimeError?: string;
}

export interface SuccessMetadata {
  domain: string;
  codeLength: number;
  apiCount: number;
  timestamp: string;
}

/**
 * GeneratorHarnessTools - thin domain-contract harness helpers
 *
 * @param options - optional constructor options. Either `seededRandom` or `entropySource`
 *                  must be provided; the constructor throws if neither is given.

 */
export class GeneratorHarnessTools {
  private rng: () => number;
  private successMemory: SuccessMetadata[] = [];

  // Maximum artifacts kept in memory before eviction
  private static readonly MAX_MEMORY = 100;

  constructor(options?: { seededRandom?: () => number; entropySource?: MetabolicEntropyEngine }) {
    if (options?.seededRandom) {
      this.rng = options.seededRandom;
    } else if (options?.entropySource) {
      const entropySource = options.entropySource;
      this.rng = () => entropySource.nextFloat();
    } else {
      throw new Error('GeneratorHarnessTools: either seededRandom or entropySource must be provided');
    }
  }

  // -------------------------------------------------------------------------
  // prepare() -- build harness context with sampled rails
  // -------------------------------------------------------------------------

  /**
   * Build a GeneratorHarnessContext with sampled skeleton, APIs, and hints.
   *
   * Returns null skeleton/API/hints if domain is not supported.
   * Always returns a context object (never null).
   */
  prepare(domain: string): GeneratorHarnessContext {
    const lookupDomain = this.normalizeDomain(domain);
    const skeleton = this.sampleDomainSkeleton(lookupDomain);
    const apis = this.sampleApis(lookupDomain, 3);
    const hints = this.sampleHardeningHints(lookupDomain, 2);

    return {
      domain,
      skeletonHint: skeleton ?? '',
      sampledApis: apis,
      hardeningHints: hints,
      hintsWereSampled: (skeleton !== null || apis.length > 0 || hints.length > 0),
    };
  }

  // -------------------------------------------------------------------------
  // classifyFailure() -- classify a validation or runtime failure
  // -------------------------------------------------------------------------

  /**
   * Classify a failure into a FailureClass with evidence and suggested hints.
   *
   * @param error - the validation error message or runtime error string
   * @param code - the generated code that failed (used for structural analysis)
   */
  classifyFailure(error: string, code: string): FailureClassification {
    const errorLower = error.toLowerCase();
    const codeLower = code.toLowerCase();
    const trimmedCode = code.trim();
    const lastChar = trimmedCode.slice(-1);

    // wrong_domain: error mentions wrong framework, OR code contains contamination
    if (
      /\b(p5|hydra|strudel|tone|three|revideo|glsl|shader|canvas|svg)\b/.test(errorLower) &&
      /wrong|incorrect|not valid|does not use|framework/i.test(error)
    ) {
      return {
        failureClass: 'wrong_domain',
        evidence: error,
        forbiddenDomains: this.getContaminationDomains(codeLower),
      };
    }

    if (/does not use|not use|no .*(three|tone|hydra|strudel|tidal)/i.test(error)) {
      return {
        failureClass: 'wrong_domain',
        evidence: error,
        forbiddenDomains: this.getContaminationDomains(codeLower),
      };
    }

    // missing_required_api: error or code missing key APIs
    const domainApis = this.getDomainApis(codeLower);
    if (domainApis.length === 0 && code.trim().length > 0) {
      return {
        failureClass: 'missing_required_api',
        evidence: error,
        suggestedApis: this.getDomainSuggestedApis(codeLower),
      };
    }

    // too_short: code is suspiciously short
    if (code.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '').trim().length < 30) {
      return {
        failureClass: 'too_short',
        evidence: `Code is only ${code.trim().length} chars after stripping comments`,
      };
    }

    // empty_after_reasoning_strip: code is empty or whitespace after LLM reasoning removal
    if (trimmedCode.length === 0) {
      return {
        failureClass: 'empty_after_reasoning_strip',
        evidence: 'Code is empty after stripping',
      };
    }

    // truncated: unclosed braces, parens, or missing terminating characters
    const openBraces = (code.match(/\{/g) || []).length;
    const closeBraces = (code.match(/\}/g) || []).length;
    const openParens = (code.match(/\(/g) || []).length;
    const closeParens = (code.match(/\)/g) || []).length;
    const openBrackets = (code.match(/\[/g) || []).length;
    const closeBrackets = (code.match(/\]/g) || []).length;

    if (
      openBraces > closeBraces ||
      openParens > closeParens ||
      openBrackets > closeBrackets ||
      (!['}', ';', '\n', ')', ']'].includes(lastChar) && lastChar.length > 0 && !/^\s+$/.test(lastChar))
    ) {
      return {
        failureClass: 'truncated',
        evidence: `Unclosed: {${openBraces}>${closeBraces} (${openBraces - closeBraces}), (${openParens}>${closeParens} (${openParens - closeParens}), [${openBrackets}>${closeBrackets} (${openBrackets - closeBrackets})`,
      };
    }

    // wrapper_contract_mismatch: missing expected wrapper structure
    if (/full html|doctype|wrapper|complete document/i.test(error)) {
      return {
        failureClass: 'wrapper_contract_mismatch',
        evidence: error,
      };
    }

    // runtime_error: error message contains runtime/compile keywords
    if (
      /\b(error|exception|undefined|cannot read|is not a|failed to|unexpected|syntax error|runtime)\b/i.test(error) &&
      !/validation|valid/i.test(error)
    ) {
      return {
        failureClass: 'runtime_error',
        evidence: error,
        runtimeError: error,
      };
    }

    // unknown
    return {
      failureClass: 'unknown',
      evidence: error,
    };
  }

  // -------------------------------------------------------------------------
  // buildRepairPrompt() -- build a targeted repair prompt from a failure
  // -------------------------------------------------------------------------

  /**
   * Build a repair prompt string from a classified failure.
   */
  buildRepairPrompt(domain: string, _prompt: string, code: string, failure: FailureClassification): string {
    const tmpl = REPAIR_PROMPT_TEMPLATES.find(t => t.failureClass === failure.failureClass);
    if (!tmpl) return '';

    let result = tmpl.template;

    result = result.replace('{forbiddenDomains}', (failure.forbiddenDomains ?? []).join(', ') || 'other frameworks');
    const _apis = failure.suggestedApis ?? this.getDomainSuggestedApis(code.toLowerCase());
    result = result.replace('{requiredApis}', _apis.length > 0 ? _apis.join(', ') : 'domain-specific APIs');
    result = result.replace('{domain}', domain);
    result = result.replace('{wrapperExpectation}', WRAPPER_CONTRACTS[domain] ?? 'complete, runnable artifact');
    result = result.replace('{runtimeError}', failure.runtimeError ?? '');

    return result;
  }

  // -------------------------------------------------------------------------
  // recordSuccess() -- in-memory success memory
  // -------------------------------------------------------------------------

  /**
   * Record a successful generation for future hint sampling.
   * Storage is in-memory only in this slice.
   * Failures to store do NOT throw or fail the generation.
   */
  recordSuccess(domain: string, code: string, _metadata?: Record<string, unknown>): void {
    try {
      const apis = this.getDomainApis(code.toLowerCase());
      const entry: SuccessMetadata = {
        domain,
        codeLength: code.length,
        apiCount: apis.length,
        timestamp: new Date().toISOString(),
      };

      this.successMemory.push(entry);

      // Evict oldest entries if over limit
      if (this.successMemory.length > GeneratorHarnessTools.MAX_MEMORY) {
        this.successMemory = this.successMemory.slice(-GeneratorHarnessTools.MAX_MEMORY);
      }
    } catch {
      // Swallow: memory recording must never block generation
    }
  }

  /**
   * Get a compact summary of recorded successes for a domain.
   */
  getSuccessSummary(domain?: string): SuccessMetadata[] {
    if (domain) {
      return this.successMemory.filter(m => m.domain === domain);
    }
    return [...this.successMemory];
  }

  // -------------------------------------------------------------------------
  // buildRepairPacket() -- compact repair packet with repeated-failure detection
  // -------------------------------------------------------------------------

  /**
   * Build a compact repair packet from a GenerationEvaluation.
   *
   * @param evaluation - the evaluation containing repairAdvice
   * @param history - optional prior evaluations to detect repeated failures
   * @returns a compact string suitable for injection into a generation prompt
   */
  buildRepairPacket(
    evaluation: GenerationEvaluation,
    history?: GenerationEvaluation[]
  ): string {
    const advice = evaluation.repairAdvice;
    if (!advice) return '';

    const parts: string[] = [];
    parts.push(`[repair] issue: ${advice.issue}`);
    parts.push(`[repair] fix: ${advice.fix}`);
    parts.push(`[repair] constraint: ${advice.constraint}`);

    if (history && history.length > 0) {
      const repeated = history.filter(
        h => h.failureClass === evaluation.failureClass ||
          (h.repairAdvice && advice.issue && h.repairAdvice.issue.toLowerCase() === advice.issue.toLowerCase())
      ).length;
      if (repeated >= 2) {
        parts.push(`[repair] escalation: This failure has occurred ${repeated} times. Try a fundamentally different approach.`);
      }
    }

    return parts.join('\n');
  }

  // -------------------------------------------------------------------------
  // Candidate ranking / selection hooks (DF3 Phase 5)
  // -------------------------------------------------------------------------

  /**
   * Normalize a GenerationEvaluation into a scalar comparable score.
   * Applies penalties for non-'none' failure classes and down-weights low confidence.
   */
  scoreCandidateForSelection(evaluation: GenerationEvaluation): number {
    let score = evaluation.score;
    if (evaluation.failureClass !== 'none') {
      score *= 0.5;
    }
    if (evaluation.confidence < 0.5) {
      score *= 0.8;
    }
    return score;
  }

  /**
   * Rank candidates by their selection score.
   * Returns sorted indices (best first) and the winner index.
   */
  rankCandidates(_codes: string[], evaluations: GenerationEvaluation[]): { rankedIndices: number[]; winnerIndex: number } {
    if (evaluations.length === 0) {
      return { rankedIndices: [], winnerIndex: -1 };
    }
    const indexed = evaluations.map((evalItem, idx) => ({
      idx,
      score: this.scoreCandidateForSelection(evalItem),
    }));
    indexed.sort((a, b) => b.score - a.score);
    return {
      rankedIndices: indexed.map(i => i.idx),
      winnerIndex: indexed[0]?.idx ?? 0,
    };
  }

  /**
   * Modulate a repair prompt with an optional entropy-driven exploration phrase.
   */
  modulateRepairPrompt(basePrompt: string, entropyPhrase?: string): string {
    if (entropyPhrase && entropyPhrase.trim().length > 0) {
      return `${basePrompt}\n\n---\nEntropy-driven exploration: consider ${entropyPhrase.trim()}`;
    }
    return basePrompt;
  }

  /**
   * Build a perturbed variant of a prompt to encourage candidate diversity.
   */
  buildDiversityPrompt(basePrompt: string, index: number, total: number, entropyPhrase?: string): string {
    if (total <= 1) return basePrompt;
    if (entropyPhrase && entropyPhrase.trim().length > 0) {
      return `${basePrompt}\n\n---\nVariation hint: ${entropyPhrase.trim()}`;
    }
    const perturbations = [
      'Try a different creative approach.',
      'Emphasize visual contrast and bold shapes.',
      'Focus on subtle details and delicate patterns.',
      'Use an unexpected color palette or rhythm.',
      'Simplify the composition to its essential elements.',
      'Add complexity through layered interactions.',
    ];
    const hint = perturbations[index % perturbations.length] ?? perturbations[0];
    return `${basePrompt}\n\n---\nVariation hint: ${hint}`;
  }

  // -------------------------------------------------------------------------
  // buildRuntimeFeedbackHint() -- placeholder for future multimodal feedback
  // -------------------------------------------------------------------------

  /**
   * Placeholder for future runtime/artifact feedback integration.
   * In this slice, returns an empty string.
   *
   * Future implementation would parse:
   * - WebGL compile errors
   * - blank screenshots
   * - audio graphs with no source
   * - video scenes missing makeScene
   * - screenshots that are nearly monochrome
   */
  buildRuntimeFeedbackHint(_domain: string, _runtimeResult: unknown): string {
    return '';
  }

  // -------------------------------------------------------------------------
  // Private sampling helpers
  // -------------------------------------------------------------------------

  private sampleDomainSkeleton(domain: string): string | null {
    const skeleton = PILOT_DOMAINS.find(d => d.domain === domain);
    if (!skeleton) return null;

    // Sample at most 1 skeleton (deterministic index via rng)
    const idx = Math.floor(this.rng() * 1);
    if (idx === 0) {
      return `// Domain scaffold for ${domain}\n${skeleton.skeletonText}`;
    }
    return null;
  }

  private normalizeDomain(domain: string): string {
    return domain === 'shader' ? 'glsl' : domain;
  }

  private sampleApis(domain: string, count: number): string[] {
    const vocab = DOMAIN_API_VOCAB.find(v => v.domain === domain);
    if (!vocab || vocab.apis.length === 0) return [];

    // Deterministic shuffle via Fisher-Yates with injected rng
    const shuffled = [...vocab.apis];
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(this.rng() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }

    return shuffled.slice(0, Math.min(count, shuffled.length));
  }

  private sampleHardeningHints(domain: string, count: number): string[] {
    const eligible = HARDENING_HINTS.filter(
      h => h.domains === 'all' || h.domains.includes(domain)
    );
    const systemLessons = loadSystemLessons(domain);
    if (eligible.length === 0 && systemLessons.length === 0) return [];

    // Deterministic shuffle via Fisher-Yates with injected rng — STATIC hints only.
    const shuffled = [...eligible];
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(this.rng() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }

    // SSS+ system lessons are ALWAYS fully injected — never sampled away. The
    // verification protocol depends on deterministic lesson presence (A/B arms).
    return [...shuffled.slice(0, Math.min(count, shuffled.length)).map(h => h.text),
      ...systemLessons.map(h => h.text)];
  }

  private getDomainApis(codeLower: string): string[] {
    const matches: string[] = [];

    if (/tone\.\w+/.test(codeLower)) matches.push('Tone.js');
    if (/three\.\w+/.test(codeLower)) matches.push('THREE');
    if (/\b(stack|sound|note|\.out)\b/.test(codeLower)) matches.push('strudel');
    if (/hydra|osc\(|\.out\(/.test(codeLower)) matches.push('hydra');
    if (/precision|uniform|void main/.test(codeLower)) matches.push('glsl');
    if (/makescene|@revideo\/core|usetime|createsignal/.test(codeLower)) matches.push('revideo');
    if (/p5|setup\(\)|draw\(\)/.test(codeLower)) matches.push('p5');
    if (/^[\s.\-~+=*#%@]+$/.test(codeLower)) matches.push('ascii');

    return matches;
  }

  private getDomainSuggestedApis(codeLower: string): string[] {
    const vocab = DOMAIN_API_VOCAB.find(v => {
      if (/tone|tonedot/.test(codeLower)) return v.domain === 'tone';
      if (/three/i.test(codeLower)) return v.domain === 'three';
      if (/strudel|sound\(|note\(/.test(codeLower)) return v.domain === 'strudel';
      if (/hydra|osc\(/.test(codeLower)) return v.domain === 'hydra';
      if (/glsl|shader|void main|precision/.test(codeLower)) return v.domain === 'glsl';
      if (/makeScene|revideo/.test(codeLower)) return v.domain === 'revideo';
      return false;
    });
    return vocab ? vocab.apis.slice(0, 4) : [];
  }

  private getContaminationDomains(codeLower: string): string[] {
    const found: string[] = [];

    const vocabList = DOMAIN_API_VOCAB.find(v => {
      if (/tone|tonedot/.test(codeLower)) return v.domain === 'tone';
      if (/three/i.test(codeLower)) return v.domain === 'three';
      if (/strudel/.test(codeLower)) return v.domain === 'strudel';
      if (/hydra/.test(codeLower)) return v.domain === 'hydra';
      if (/glsl|shader/.test(codeLower)) return v.domain === 'glsl';
      return false;
    });

    if (vocabList) {
      for (const api of vocabList.apis) {
        if (new RegExp(api.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i').test(codeLower)) {
          found.push(api);
        }
      }
    }

    return found.slice(0, 3);
  }
}
