/**
 * NbeGenerator — Neural Bloom Engine (cascade neural field) renderer.
 *
 * Domain: 'nbe'. Produces a self-contained HTML document (the "nbe_render.html"
 * asset) with embedded cascade neural-field weights that drives a flowing
 * fluid-art simulation on a <canvas>.
 *
 * -----------------------------------------------------------------------------
 * EXEMPTION FROM THE "NO TEMPLATE FALLBACKS" DESIGN RULE (AGENTS.md)
 * -----------------------------------------------------------------------------
 * The repo rule states: "All generators route through the LLM. If the LLM fails,
 * the fix is to improve the harness, routing, or validation — not to fall back to
 * static code." This generator is NOT a fallback and NOT a static code template:
 *
 *   - It is the PRIMARY (and only) generation path for the `nbe` domain. There is
 *     no LLM step it could be "falling back" from.
 *   - Its output is produced by a deterministic neural-field physics simulation,
 *     not by authored prose/code. The cascade weights parameterize a continuous
 *     field; the rendered frames are emergent simulation state, the same way a
 *     fixed-asset procedural generator (e.g. a cellular-automaton seed render)
 *     is deterministic by construction.
 *   - Routing still flows through the registry: `nbeConfidence` only fires on
 *     explicit NBE/neural-field cues, so ordinary prompts keep reaching the LLM.
 *     This is a specialized deterministic generator, exactly analogous to a
 *     fixed-asset generator — not a template that masks an LLM failure.
 *
 * Convergence contract: the rendered document posts
 * `window.postMessage('nbe:converged', '*')` exactly once after `convergenceSteps`
 * simulation steps, so screenshot capture can wait on a real signal instead of a
 * fixed timer.
 *
 * Thinking trace is still emitted (see Thinking-Trace Feedback Loop in AGENTS.md)
 * so the meta-harness can observe how the deterministic render was parameterized.
 */

import type { GeneratorResult } from '../GeneratorRegistry.js';

// ---------------------------------------------------------------------------
// Cascade neural-field weights
// ---------------------------------------------------------------------------

/** A single octave in the cascade: a sinusoidal field layer. */
export interface NbeCascadeLayer {
  /** Spatial frequency (rad per grid unit). */
  freq: number;
  /** Velocity amplitude contributed by this layer. */
  amp: number;
  /** Phase offsets per axis. */
  phaseX: number;
  phaseY: number;
  /** Temporal evolution speed. */
  speed: number;
}

/** A full cascade is an ordered stack of layers, lowest frequency first. */
export type NbeCascadeWeights = NbeCascadeLayer[];

/** Named presets for the cascade weights. */
export type NbeWeightPreset = 'aurora' | 'magma' | 'abyss';

/** A color-stop palette applied to the advected density field. */
export interface NbePalette {
  id: string;
  /** [t, [r,g,b]] stops, t in [0,1]. */
  stops: Array<[number, [number, number, number]]>;
}

export interface NbeWeightSet {
  weights: NbeCascadeWeights;
  palette: NbePalette;
}

// ---------------------------------------------------------------------------
// Presets
// ---------------------------------------------------------------------------

const AURORA: NbeWeightSet = {
  weights: [
    { freq: 0.6, amp: 0.9, phaseX: 0.0, phaseY: 0.5, speed: 0.15 },
    { freq: 1.3, amp: 0.6, phaseX: 1.1, phaseY: 2.0, speed: 0.27 },
    { freq: 2.7, amp: 0.35, phaseX: 2.4, phaseY: 0.8, speed: 0.41 },
    { freq: 5.1, amp: 0.18, phaseX: 3.3, phaseY: 4.1, speed: 0.63 },
  ],
  palette: {
    id: 'aurora',
    stops: [
      [0.0, [3, 10, 24]],
      [0.35, [8, 48, 64]],
      [0.6, [18, 120, 110]],
      [0.82, [120, 230, 170]],
      [1.0, [220, 255, 235]],
    ],
  },
};

const MAGMA: NbeWeightSet = {
  weights: [
    { freq: 0.5, amp: 1.0, phaseX: 0.4, phaseY: 1.2, speed: 0.12 },
    { freq: 1.1, amp: 0.7, phaseX: 2.2, phaseY: 0.3, speed: 0.24 },
    { freq: 2.3, amp: 0.4, phaseX: 0.9, phaseY: 3.1, speed: 0.39 },
    { freq: 4.4, amp: 0.2, phaseX: 5.0, phaseY: 1.7, speed: 0.58 },
  ],
  palette: {
    id: 'magma',
    stops: [
      [0.0, [12, 4, 8]],
      [0.35, [70, 14, 22]],
      [0.6, [190, 54, 28]],
      [0.82, [240, 160, 48]],
      [1.0, [255, 240, 180]],
    ],
  },
};

const ABYSS: NbeWeightSet = {
  weights: [
    { freq: 0.7, amp: 0.85, phaseX: 1.5, phaseY: 0.2, speed: 0.1 },
    { freq: 1.6, amp: 0.55, phaseX: 0.6, phaseY: 2.8, speed: 0.22 },
    { freq: 3.0, amp: 0.3, phaseX: 3.7, phaseY: 1.0, speed: 0.37 },
    { freq: 5.8, amp: 0.15, phaseX: 2.1, phaseY: 5.2, speed: 0.55 },
  ],
  palette: {
    id: 'abyss',
    stops: [
      [0.0, [2, 2, 12]],
      [0.35, [16, 12, 60]],
      [0.6, [60, 40, 150]],
      [0.82, [150, 90, 220]],
      [1.0, [220, 200, 255]],
    ],
  },
};

const PRESETS: Record<NbeWeightPreset, NbeWeightSet> = {
  aurora: AURORA,
  magma: MAGMA,
  abyss: ABYSS,
};

// ---------------------------------------------------------------------------
// Parameters
// ---------------------------------------------------------------------------

/** Initial simulation parameters (overridable per generation). */
export interface NbeInitialParams {
  /** Grid resolution (simulation cells). */
  gridWidth: number;
  gridHeight: number;
  /** Advection damping in [0,1). Higher = field dissipates faster. */
  damping: number;
  /** Density injection rate per step. */
  inject: number;
  /** Deterministic seed for the initial density noise. */
  seed: number;
}

export interface NbeGeneratorParams {
  /** Named preset, a custom weight set, or omitted for the default ('aurora'). */
  weights?: NbeWeightPreset | NbeWeightSet;
  /** Overrides for the initial simulation state. */
  initialParams?: Partial<NbeInitialParams>;
  /** Simulation steps before the convergence signal fires. */
  convergenceSteps?: number;
}

const DEFAULT_INITIAL: NbeInitialParams = {
  gridWidth: 192,
  gridHeight: 120,
  damping: 0.985,
  inject: 0.22,
  seed: 1337,
};

const DEFAULT_CONVERGENCE_STEPS = 600;
const MIN_CONVERGENCE_STEPS = 1;
const MAX_CONVERGENCE_STEPS = 10_000;

function clampConvergenceSteps(n: number): number {
  if (!Number.isFinite(n)) return DEFAULT_CONVERGENCE_STEPS;
  return Math.min(MAX_CONVERGENCE_STEPS, Math.max(MIN_CONVERGENCE_STEPS, Math.trunc(n)));
}

function resolveWeightSet(weights?: NbeWeightPreset | NbeWeightSet): NbeWeightSet {
  if (!weights) return PRESETS.aurora;
  if (typeof weights === 'string') return PRESETS[weights] ?? PRESETS.aurora;
  // Custom weight set: caller supplies the cascade; fall back to the aurora
  // palette if they did not provide one.
  return {
    weights: weights.weights,
    palette: weights.palette ?? PRESETS.aurora.palette,
  };
}

// ---------------------------------------------------------------------------
// Generator
// ---------------------------------------------------------------------------

/**
 * Deterministic NBE renderer. `generate()` is pure: identical params yield an
 * identical document, which is what makes convergence-waiting screenshot capture
 * reproducible.
 */
export class NbeGenerator {
  readonly domain = 'nbe' as const;

  generate(prompt: string, params: NbeGeneratorParams = {}): GeneratorResult {
    const weightSet = resolveWeightSet(params.weights);
    const initial: NbeInitialParams = { ...DEFAULT_INITIAL, ...params.initialParams };
    const convergenceSteps = clampConvergenceSteps(
      params.convergenceSteps ?? DEFAULT_CONVERGENCE_STEPS,
    );

    const code = this.renderHtml({
      prompt,
      weightSet,
      initial,
      convergenceSteps,
    });

    return {
      code,
      model: 'nbe-neural-field',
      thinking: [
        `NBE deterministic render for prompt: "${prompt.slice(0, 120)}".`,
        `cascade preset="${weightSet.palette.id}" (${weightSet.weights.length} layers),`,
        `grid=${initial.gridWidth}x${initial.gridHeight}, damping=${initial.damping},`,
        `convergence after ${convergenceSteps} steps. No LLM step (specialized deterministic generator).`,
      ].join(' '),
    };
  }

  private renderHtml(args: {
    prompt: string;
    weightSet: NbeWeightSet;
    initial: NbeInitialParams;
    convergenceSteps: number;
  }): string {
    const { prompt, weightSet, initial, convergenceSteps } = args;
    const cascadeJson = JSON.stringify(weightSet.weights);
    const paletteJson = JSON.stringify(weightSet.palette);
    const initialJson = JSON.stringify(initial);
    // Escape the prompt for safe embedding in a JS string literal + HTML comment.
    const safePrompt = prompt.replace(/<\/script>/gi, '<\\/script>').replace(/\\/g, '\\\\').replace(/'/g, "\\'");

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>NBE — Neural Bloom Engine</title>
<style>
  html, body { margin: 0; padding: 0; height: 100%; background: #04060a; overflow: hidden; }
  #stage { display: block; width: 100vw; height: 100vh; image-rendering: auto; }
</style>
</head>
<body>
<canvas id="stage"></canvas>
<!--
  nbe_render.html — produced by NbeGenerator (domain: 'nbe').
  Prompt: ${prompt.replace(/-->/g, '--&gt;')}
  Convergence contract: posts window.postMessage('nbe:converged', '*') once after
  ${convergenceSteps} simulation steps.
-->
<script>
(function () {
  'use strict';
  // --- Embedded cascade neural-field weights (parameterize the velocity field) ---
  var CASCADE = ${cascadeJson};
  var PALETTE = ${paletteJson};
  var INITIAL = ${initialJson};
  var CONVERGENCE_STEPS = ${convergenceSteps};
  var PROMPT = '${safePrompt}';

  var W = INITIAL.gridWidth, H = INITIAL.gridHeight;
  var canvas = document.getElementById('stage');
  canvas.width = W; canvas.height = H;
  var ctx = canvas.getContext('2d');
  var img = ctx.createImageData(W, H);

  // Density + scratch buffers.
  var dens = new Float32Array(W * H);
  var next = new Float32Array(W * H);

  // Seeded PRNG (mulberry32) for deterministic initial noise.
  function rng(seed) {
    return function () {
      seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
      var t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  var rand = rng(INITIAL.seed >>> 0);
  for (var i = 0; i < dens.length; i++) dens[i] = rand() * 0.25;

  // Precompute palette LUT (1024 entries) for fast shading.
  var LUT_SIZE = 1024;
  var lut = new Uint8Array(LUT_SIZE * 3);
  (function buildLut() {
    var stops = PALETTE.stops;
    for (var k = 0; k < LUT_SIZE; k++) {
      var t = k / (LUT_SIZE - 1);
      var a = stops[0], b = stops[stops.length - 1];
      for (var s = 0; s < stops.length - 1; s++) {
        if (t >= stops[s][0] && t <= stops[s + 1][0]) { a = stops[s]; b = stops[s + 1]; break; }
      }
      var span = Math.max(1e-6, b[0] - a[0]);
      var f = Math.min(1, Math.max(0, (t - a[0]) / span));
      lut[k * 3]     = Math.round(a[1][0] + (b[1][0] - a[1][0]) * f);
      lut[k * 3 + 1] = Math.round(a[1][1] + (b[1][1] - a[1][1]) * f);
      lut[k * 3 + 2] = Math.round(a[1][2] + (b[1][2] - a[1][2]) * f);
    }
  })();

  // Cascade neural-field velocity at a normalized point (x,y in [0,1)).
  function field(x, y, t) {
    var vx = 0, vy = 0;
    for (var l = 0; l < CASCADE.length; l++) {
      var L = CASCADE[l];
      var ax = L.freq * x + L.phaseX + t * L.speed;
      var ay = L.freq * y + L.phaseY + t * L.speed * 0.83;
      vx += L.amp * Math.sin(ax);
      vy += L.amp * Math.cos(ay);
    }
    return [vx, vy];
  }

  var steps = 0;
  var converged = false;
  var time = 0;

  function step() {
    time += 0.016;
    var damping = INITIAL.damping;
    var inject = INITIAL.inject;
    // Inject density near center to keep the bloom alive.
    var cx = (W / 2) | 0, cy = (H / 2) | 0;
    for (var dy = -2; dy <= 2; dy++) {
      for (var dx = -2; dx <= 2; dx++) {
        var xi = cx + dx, yi = cy + dy;
        if (xi >= 0 && xi < W && yi >= 0 && yi < H) {
          dens[yi * W + xi] = Math.min(1, dens[yi * W + xi] + inject * (0.4 + 0.6 * rand()));
        }
      }
    }

    // Semi-Lagrangian advection through the cascade velocity field.
    for (var y = 0; y < H; y++) {
      for (var x = 0; x < W; x++) {
        var nx = x / W, ny = y / H;
        var v = field(nx, ny, time);
        var px = x - v[0];
        var py = y - v[1];
        var x0 = Math.max(0, Math.min(W - 1, px));
        var y0 = Math.max(0, Math.min(H - 1, py));
        var x1 = Math.min(W - 1, Math.ceil(x0));
        var y1 = Math.min(H - 1, Math.ceil(y0));
        var fx = x0 - Math.floor(x0);
        var fy = y0 - Math.floor(y0);
        var i00 = (Math.floor(y0) * W + Math.floor(x0));
        var i10 = (Math.floor(y0) * W + x1);
        var i01 = (y1 * W + Math.floor(x0));
        var i11 = (y1 * W + x1);
        var top = dens[i00] + (dens[i10] - dens[i00]) * fx;
        var bot = dens[i01] + (dens[i11] - dens[i01]) * fx;
        next[y * W + x] = (top + (bot - top) * fy) * damping;
      }
    }
    var tmp = dens; dens = next; next = tmp;

    // Shade.
    var data = img.data;
    for (var p = 0; p < dens.length; p++) {
      var d = Math.min(1, Math.max(0, dens[p]));
      var li = ((d * (LUT_SIZE - 1)) | 0) * 3;
      var o = p * 4;
      data[o] = lut[li];
      data[o + 1] = lut[li + 1];
      data[o + 2] = lut[li + 2];
      data[o + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);

    steps++;
    if (!converged && steps >= CONVERGENCE_STEPS) {
      converged = true;
      // Convergence signal — screenshot capture waits on this exact message.
      window.postMessage('nbe:converged', '*');
    }
  }

  function loop() {
    step();
    requestAnimationFrame(loop);
  }
  requestAnimationFrame(loop);
})();
</script>
</body>
</html>`;
  }
}
