/**
 * Per-domain validator checklists injected into the GENERATION USER PROMPT.
 *
 * Why the user prompt (not the system tail): PE-2's 2026-09-01 bisection
 * proved an optional, system-prompt-buried library section was ignored by
 * 12/12 card-bearing generations — salience beats placement-in-system. These
 * are the same checks CodeValidator enforces, stated as explicit build rules
 * so the model knows the contract BEFORE writing code (rejection-rate fix #3,
 * PICARD-style API-surface injection).
 *
 * Source of truth: PE-2's validator-checklists v1 (Forgejo #988, 2026-09-01).
 * Canonical source: docs/prompts/validator-checklists.json (PE-2, 2026-09-01).
 * This inline copy is kept build-simple on purpose; the drift-guard test
 * (test/unit/runtime-core/validator-checklist-drift.test.ts) fails on ANY
 * divergence between this copy and the canonical file, and on any
 * spine-supported domain missing a checklist.
 */
export const DOMAIN_CHECKLISTS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  p5: [
    'define BOTH setup() and draw()',
    'reference p5 globals (createCanvas, background, ...) — no DOM-only code',
    'close every brace and paren',
  ],
  three: [
    'reference THREE.* or import from "three" (exactly ONE THREE import)',
    'create scene, camera, renderer; call renderer.render',
    'an animation loop (requestAnimationFrame or setAnimationLoop)',
    'every light intensity <= 3.0 (key 0.8-2.0, ambient 0.25-0.6) with renderer.toneMapping = THREE.ACESFilmicToneMapping',
    'scene background / clear color is a deep mid-tone (e.g. 0x2a3a4e or lighter), never near-black',
  ],
  glsl: [
    'one complete fragment shader with void main()',
    'declare precision (mediump/highp float)',
    'type every uniform (vec2/vec3/float/mat)',
    'no setup()/draw() — this is raw GLSL',
  ],
  strudel: [
    'use strudel patterns (s("..."), note(), stack(), bpm())',
    'do NOT prefix with $: (that is hydra notation)',
  ],
  hydra: [
    'use hydra sources (osc/src/noise/shape/solid/voronoi/gradient)',
    'end the chain with .out()',
    'no $: prefix',
  ],
  tone: [
    'use the global Tone.* (already loaded) — no import statements',
    'connect synths to destination',
    'schedule with Tone.now()/transport, not setInterval',
  ],
  html: [
    'balance every tag you open (the validator checks closing tags)',
    'NO inline on*= handlers, NO javascript: URLs',
    'no node:/fs/child_process imports — browser only',
  ],
  dataviz: [
    'MUST load D3.js (script tag or import) — a dataviz piece without D3 fails validation',
    'balance all tags; browser-only imports',
  ],
  meta: [
    'MUST include a render mount (the element your composition attaches to)',
    'balance all tags',
  ],
  hyperframes: [
    'window.__timelines structure with clip classes',
    'gsap timeline/from/to calls',
  ],
  svg: [
    'root element must be <svg>',
    'well-formed XML',
  ],
  kinetic: [
    'motion-driven animation (animate transforms over time)',
    'an explicit loop or animation driver',
  ],
  ascii: ['plain ASCII art block (no code execution expected)'],
  music: ['either strudel or hydra idioms (see those checklists)'],
  textgen: [
    'return RAW TEXT (the text itself is the artwork) — NOT an HTML document',
    'at least 3 non-empty lines',
    'substantial output — a receipt under the minimum size fails validation',
    'vary the line lengths — fewer than 3 distinct lengths among non-empty lines is rejected as a non-generative receipt',
  ],
  blender: [
    'a raw Python script that imports bpy (no HTML, no markdown fences)',
    'no network, subprocess, shell, os file access or exec/eval — those constructs are rejected before Blender runs',
    'build objects, a light and a camera, and set bpy.context.scene.camera',
    'never call bpy.ops.render or set the output path: the host renders one capped still',
  ],  revideo: [
    'one Revideo scene source file (TSX): export default makeScene2D("SceneName", function* (view) { ... }) — no HTML, no markdown fences',
    'import only from @revideo/2d and @revideo/core; @revideo/react, Remotion, React.FC, useCurrentFrame, p5 setup()/draw() are rejected',
    'nothing external: no fetch, no URL images or video, no staticFile, no Audio/Video nodes — the render is offline',
    'the scene must animate (yield* on node signals) and end: total length between 4 and 20 seconds',
  ],
});

/** User-prompt block for a domain; empty string when the domain has no list. */
export function validatorChecklistBlock(domain: string): string {
  const rules = DOMAIN_CHECKLISTS[domain === 'shader' ? 'glsl' : domain];
  if (!rules || rules.length === 0) return '';
  const lines = rules.map((rule, i) => `${i + 1}. ${rule}`).join('\n');
  return `REQUIRED BUILD RULES — a machine validator checks your code and ANY single failed rule rejects the whole piece:\n${lines}`;
}

/** The repair-turn user prompt: original brief + exact failing checks +
 * explain-then-fix contract (enriched repair feedback, arXiv:2304.05128 —
 * the first repair turn captures most of the recovery gain). */
export function buildRepairUserPrompt(
  originalUserPrompt: string,
  failedCode: string,
  errors: readonly string[],
): string {
  const checks = errors.map((e, i) => `${i + 1}. ${e}`).join('\n');
  return `${originalUserPrompt}

---
YOUR PREVIOUS CODE FAILED MACHINE VALIDATION. The exact failing checks:
${checks}

Your previous code (tail, for reference):
${failedCode.slice(-2500)}

Reply in EXACTLY this format:
ROOT CAUSE: one sentence per failing check above, naming the actual defect in your previous code.
CORRECTED CODE: the complete corrected code — same domain contract, every build rule satisfied, no prose before or after.`;
}
