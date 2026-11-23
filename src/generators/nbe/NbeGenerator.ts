/**
 * NbeGenerator — Neural Bloom Engine (cascade neural field) renderer.
 *
 * Domain: 'nbe'. Produces a self-contained HTML document (the "nbe_render.html"
 * asset) with embedded cascade neural-field weights that drives a flowing
 * fluid-art simulation on a <canvas>.
 *
 * The governed generator chooses bounded settings from the brief. This renderer
 * turns those settings into the simulation. Registry callers can also supply
 * parameters directly for reproducible renders.
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
import { scriptString } from '../../utils/scriptEmbed.js';
import { engineLayerCss, engineRuntimeScript } from '../engine/EngineRuntime.js';

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

/** How the picture is fed and toned. Chosen by the model through NbeSettings; defaults keep a lone centre bloom. */
export interface NbeLook {
  /** Sources of light in normalised 0..1 space. */
  emitters: Array<[number, number]>;
  /** 0..1: how strongly each source spins the fluid into a vortex. */
  swirl: number;
  /** 0..1: bloom, how strongly bright regions saturate toward the top colour. */
  glow: number;
  /** Multiplier on how fast the currents evolve. */
  speed: number;
}

export interface NbeGeneratorParams {
  /** Named preset, a custom weight set, or omitted for the default ('aurora'). */
  weights?: NbeWeightPreset | NbeWeightSet;
  /** Overrides for the initial simulation state. */
  initialParams?: Partial<NbeInitialParams>;
  /** Simulation steps before the convergence signal fires. */
  convergenceSteps?: number;
  /** Source layout, vortex, glow and current speed (see NbeSettings). */
  look?: Partial<NbeLook>;
  /** One sentence on why these settings fit the brief; recorded in the thinking trace. */
  reason?: string;
}

const DEFAULT_INITIAL: NbeInitialParams = {
  gridWidth: 192,
  gridHeight: 120,
  damping: 0.985,
  inject: 0.22,
  seed: 1337,
};

const DEFAULT_LOOK: NbeLook = { emitters: [[0.5, 0.5]], swirl: 0.4, glow: 0.6, speed: 1 };

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
    const look: NbeLook = { ...DEFAULT_LOOK, ...params.look };

    const code = this.renderHtml({
      prompt,
      weightSet,
      initial,
      convergenceSteps,
      look,
    });

    return {
      code,
      model: 'nbe-neural-field',
      thinking: [
        `NBE deterministic render for prompt: "${prompt.slice(0, 120)}".`,
        `cascade preset="${weightSet.palette.id}" (${weightSet.weights.length} layers),`,
        `grid=${initial.gridWidth}x${initial.gridHeight}, damping=${initial.damping},`,
        `${look.emitters.length} emitter(s), swirl=${look.swirl}, glow=${look.glow},`,
        `convergence after ${convergenceSteps} steps.`,
        params.reason ? `Chosen because: ${params.reason}` : 'Settings not model-chosen (library defaults).',
      ].join(' '),
    };
  }

  private renderHtml(args: {
    prompt: string;
    weightSet: NbeWeightSet;
    initial: NbeInitialParams;
    convergenceSteps: number;
    look: NbeLook;
  }): string {
    const { prompt, weightSet, initial, convergenceSteps, look } = args;
    const cascadeJson = JSON.stringify(weightSet.weights);
    const paletteJson = JSON.stringify(weightSet.palette);
    const initialJson = JSON.stringify(initial);
    const lookJson = JSON.stringify(look);

    return `<!DOCTYPE html>
<html lang="en" data-sinter-engine="nbe">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>S1NTR nbe</title>
<style>
  html, body { margin: 0; padding: 0; height: 100%; background: #04060a; overflow: hidden; }
  #stage { display: block; width: 100vw; height: 100vh; image-rendering: auto; }
  ${engineLayerCss()}
</style>
</head>
<body>
<canvas id="stage"></canvas>
<!--
  nbe_render.html — produced by NbeGenerator (domain: 'nbe').
  Prompt: ${prompt.replace(/--!?>/g, '--&gt;')}
  Convergence contract: posts window.postMessage('nbe:converged', '*') once after
  ${convergenceSteps} simulation steps, and sets window.sinterEngine.state = 'ready'.
-->
<script>${engineRuntimeScript({ id: 'nbe', readyMessage: null })}</script>
<script>
(function () {
  'use strict';
  // --- Embedded cascade neural-field weights (parameterize the velocity field) ---
  var CASCADE = ${cascadeJson};
  var PALETTE = ${paletteJson};
  var INITIAL = ${initialJson};
  var CONVERGENCE_STEPS = ${convergenceSteps};
  var PROMPT = ${scriptString(prompt)};
  var LOOK = ${lookJson};
  var E = window.sinterEngine;

  var W = INITIAL.gridWidth, H = INITIAL.gridHeight;
  var canvas = document.getElementById('stage');
  canvas.width = W; canvas.height = H;
  var ctx = canvas.getContext('2d');
  if (!ctx) { E.fail('2d canvas context unavailable'); return; }
  var img = ctx.createImageData(W, H);

  // Density + scratch buffers and the per-step velocity field.
  var dens = new Float32Array(W * H);
  var next = new Float32Array(W * H);
  var VX = new Float32Array(W * H);
  var VY = new Float32Array(W * H);

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
  for (var i = 0; i < dens.length; i++) dens[i] = rand() * 0.12;

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

  var TAU = Math.PI * 2;
  var time = 0;
  var gain = 1.5 + 4.5 * LOOK.glow;
  var toneNorm = 1 / (1 - Math.exp(-gain));

  // Cascade neural-field velocity for the whole grid at time t. Each layer is a travelling
  // wave across a rotated axis, so currents cross and curl instead of only shearing.
  function buildField(t) {
    VX.fill(0); VY.fill(0);
    for (var l = 0; l < CASCADE.length; l++) {
      var L = CASCADE[l];
      var th = L.phaseX + l * 0.9;
      var c1 = Math.cos(th), s1 = Math.sin(th), c2 = Math.cos(th + 1.7), s2 = Math.sin(th + 1.7);
      var f = L.freq * TAU;
      var ox = L.phaseX + t * L.speed, oy = L.phaseY + t * L.speed * 0.83;
      for (var y = 0; y < H; y++) {
        var ny = y / H;
        for (var x = 0; x < W; x++) {
          var nx = x / W, p = y * W + x;
          VX[p] += L.amp * Math.sin(f * (nx * c1 + ny * s1) + ox);
          VY[p] += L.amp * Math.cos(f * (nx * c2 + ny * s2) + oy);
        }
      }
    }
    // Vortices around each source.
    if (LOOK.swirl > 0) {
      for (var e = 0; e < LOOK.emitters.length; e++) {
        var ex = LOOK.emitters[e][0] * W, ey = LOOK.emitters[e][1] * H;
        var dir = (e % 2 === 0 ? 1 : -1) * LOOK.swirl * 2.2;
        for (var yy = 0; yy < H; yy++) {
          for (var xx = 0; xx < W; xx++) {
            var dx = xx - ex, dy = yy - ey;
            var r = Math.sqrt(dx * dx + dy * dy) + 2;
            var w = dir * Math.exp(-r / (0.22 * W)) / r * 6;
            var q = yy * W + xx;
            VX[q] += -dy * w; VY[q] += dx * w;
          }
        }
      }
    }
  }

  function inject() {
    var amt = INITIAL.inject;
    for (var e = 0; e < LOOK.emitters.length; e++) {
      var cx = Math.round(LOOK.emitters[e][0] * (W - 1)), cy = Math.round(LOOK.emitters[e][1] * (H - 1));
      for (var dy = -5; dy <= 5; dy++) {
        for (var dx = -5; dx <= 5; dx++) {
          var xi = cx + dx, yi = cy + dy;
          if (xi >= 0 && xi < W && yi >= 0 && yi < H) {
            var fall = Math.exp(-(dx * dx + dy * dy) / 9);
            var ii = yi * W + xi;
            dens[ii] = Math.min(1, dens[ii] + amt * fall * (0.5 + 0.5 * rand()) * (1 + E.input));
          }
        }
      }
    }
  }

  function step() {
    time += 0.05 * LOOK.speed;
    inject();
    buildField(time);
    var damping = INITIAL.damping;
    // Semi-Lagrangian advection through the cascade velocity field.
    for (var y = 0; y < H; y++) {
      for (var x = 0; x < W; x++) {
        var p = y * W + x;
        var px = x - VX[p] * 0.3, py = y - VY[p] * 0.3;
        var x0 = Math.max(0, Math.min(W - 1, px));
        var y0 = Math.max(0, Math.min(H - 1, py));
        var xf = Math.floor(x0), yf = Math.floor(y0);
        var x1 = Math.min(W - 1, xf + 1), y1 = Math.min(H - 1, yf + 1);
        var fx = x0 - xf, fy = y0 - yf;
        var top = dens[yf * W + xf] + (dens[yf * W + x1] - dens[yf * W + xf]) * fx;
        var bot = dens[y1 * W + xf] + (dens[y1 * W + x1] - dens[y1 * W + xf]) * fx;
        next[p] = (top + (bot - top) * fy) * damping;
      }
    }
    var tmp = dens; dens = next; next = tmp;
  }

  function draw() {
    var data = img.data;
    var layer = E.layer;
    for (var p = 0; p < dens.length; p++) {
      var d = dens[p] < 0 ? 0 : dens[p];
      var tone = (1 - Math.exp(-d * gain)) * toneNorm;
      if (tone > 1) tone = 1;
      var li = ((tone * (LUT_SIZE - 1)) | 0) * 3;
      var o = p * 4;
      if (layer === 'mask') {
        var g = (tone * 255) | 0;
        data[o] = g; data[o + 1] = g; data[o + 2] = g; data[o + 3] = 255;
      } else {
        data[o] = lut[li]; data[o + 1] = lut[li + 1]; data[o + 2] = lut[li + 2];
        data[o + 3] = layer === 'overlay' ? (tone * 255) | 0 : 255;
      }
    }
    ctx.putImageData(img, 0, 0);
  }

  var converged = false;
  E.run({
    step: function () {
      step();
      if (!converged && E.steps + 1 >= CONVERGENCE_STEPS) {
        converged = true;
        // Convergence signal — the legacy contract; E.ready() raises the same state for capture.
        window.postMessage('nbe:converged', '*');
      }
    },
    draw: draw,
    readyAfter: CONVERGENCE_STEPS,
    warmSteps: 240,
    stepsPerFrame: 2
  });
})();
</script>
</body>
</html>`;
  }
}
