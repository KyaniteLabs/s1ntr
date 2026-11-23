/**
 * NBE settings: what a model picks from a brief, and how they become engine parameters.
 *
 * The renderer (NbeGenerator) stays deterministic. These settings choose its palette, the shape
 * of the cascade velocity field, where density is injected, how fast it moves, and how the
 * picture is toned, so two different briefs give visibly different pieces.
 */
import {
  paletteStops, validateEngineSettings, type EngineChoice, type SettingsSpec,
} from '../engine/EngineSettings.js';
import { NbeGenerator, type NbeCascadeLayer, type NbeGeneratorParams } from './NbeGenerator.js';

export const NBE_EMITTER_LAYOUTS = ['center', 'scatter', 'ring', 'line', 'corners'] as const;
export type NbeEmitterLayout = typeof NBE_EMITTER_LAYOUTS[number];

export const NBE_SETTINGS_SPEC = {
  palette: { kind: 'palette', min: 3, max: 6, default: ['#030a18', '#083040', '#12786e', '#78e6aa', '#dcffeb'],
    about: 'Colour ramp applied to fluid density: first is the empty background, last is the hottest glow.' },
  layout: { kind: 'enum', values: NBE_EMITTER_LAYOUTS, default: 'center',
    about: 'Where light enters the fluid: one source, scattered sources, a ring, a line, or the four corners.' },
  emitters: { kind: 'number', min: 1, max: 8, integer: true, default: 3, about: 'How many sources of light.' },
  fieldScale: { kind: 'number', min: 0.4, max: 4, default: 1.2,
    about: 'Size of the currents: low = a few huge slow sweeps, high = many small eddies.' },
  fieldLayers: { kind: 'number', min: 2, max: 6, integer: true, default: 4, about: 'Octaves of detail in the currents.' },
  flow: { kind: 'number', min: 0.3, max: 3, default: 1, about: 'Strength of the currents: how far the light is carried each step.' },
  swirl: { kind: 'number', min: 0, max: 1, default: 0.4, about: 'How much the sources spin the fluid into vortices.' },
  speed: { kind: 'number', min: 0.2, max: 3, default: 1, about: 'How fast the currents themselves evolve over time.' },
  persistence: { kind: 'number', min: 0.95, max: 0.999, default: 0.985, about: 'How long light lingers: low fades quickly, high leaves long trails.' },
  glow: { kind: 'number', min: 0, max: 1, default: 0.6, about: 'Bloom: how strongly bright regions saturate and spread toward the top colour.' },
  seed: { kind: 'number', min: 0, max: 99999, integer: true, default: 1337, about: 'Seed for the starting noise and source placement.' },
} as const satisfies SettingsSpec;

export interface NbeSettings {
  palette: string[];
  layout: NbeEmitterLayout;
  emitters: number;
  fieldScale: number;
  fieldLayers: number;
  flow: number;
  swirl: number;
  speed: number;
  persistence: number;
  glow: number;
  seed: number;
}

export type NbeChoice = EngineChoice<NbeSettings>;

export function validateNbeSettings(raw: unknown): NbeChoice {
  return validateEngineSettings<NbeSettings>('nbe', NBE_SETTINGS_SPEC, raw);
}

/** Small deterministic PRNG so the same settings always build the same cascade. */
function mulberry(seed: number): () => number {
  let s = seed | 0;
  return () => {
    s = (s + 0x6D2B79F5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Sources in normalised 0..1 space, placed by layout. */
export function nbeEmitterPoints(s: Pick<NbeSettings, 'layout' | 'emitters' | 'seed'>): Array<[number, number]> {
  const rand = mulberry(s.seed ^ 0x9e3779b9);
  const n = s.layout === 'center' ? 1 : s.layout === 'corners' ? 4 : s.emitters;
  const pts: Array<[number, number]> = [];
  for (let i = 0; i < n; i++) {
    if (s.layout === 'center') pts.push([0.5, 0.5]);
    else if (s.layout === 'ring') { const a = (i / n) * Math.PI * 2 + rand() * 0.3; pts.push([0.5 + 0.3 * Math.cos(a), 0.5 + 0.3 * Math.sin(a)]); }
    else if (s.layout === 'line') pts.push([0.12 + 0.76 * (n === 1 ? 0.5 : i / (n - 1)), 0.5 + (rand() - 0.5) * 0.08]);
    else if (s.layout === 'corners') pts.push([i % 2 === 0 ? 0.18 : 0.82, i < 2 ? 0.22 : 0.78]);
    else pts.push([0.12 + rand() * 0.76, 0.15 + rand() * 0.7]);
  }
  return pts;
}

/** The cascade the settings describe: octaves of sinusoidal currents. */
export function nbeCascadeFromSettings(s: NbeSettings): NbeCascadeLayer[] {
  const rand = mulberry(s.seed);
  const layers: NbeCascadeLayer[] = [];
  for (let i = 0; i < s.fieldLayers; i++) {
    layers.push({
      freq: Math.round(s.fieldScale * (0.55 + i * 1.15) * 100) / 100,
      amp: Math.round(s.flow * 1.6 / (1 + i * 0.9) * 1000) / 1000,
      phaseX: Math.round(rand() * 6283) / 1000,
      phaseY: Math.round(rand() * 6283) / 1000,
      speed: Math.round(s.speed * (0.12 + i * 0.16) * 1000) / 1000,
    });
  }
  return layers;
}

export function nbeParamsFromSettings(s: NbeSettings): NbeGeneratorParams {
  return {
    weights: { weights: nbeCascadeFromSettings(s), palette: { id: 'custom', stops: paletteStops(s.palette) } },
    initialParams: { damping: s.persistence, seed: s.seed, inject: 0.3 },
    look: { emitters: nbeEmitterPoints(s), swirl: s.swirl, glow: s.glow, speed: s.speed },
    convergenceSteps: 360,
  };
}

export const NBE_CHOICE_TAG = 'sinter-engine-choice';

/** Render the page for a validated choice: the engine always renders, the model only chose the settings. */
export function renderNbeFromChoice(prompt: string, choice: NbeChoice): string {
  const html = new NbeGenerator().generate(prompt, { ...nbeParamsFromSettings(choice.settings), reason: choice.reason }).code;
  const record = JSON.stringify({
    engine: choice.engine, settings: choice.settings, reason: choice.reason,
    clamped: choice.clamped, defaulted: choice.defaulted,
  }).replace(/</g, '\\u003c');
  return html.replace('</head>', () => `<script type="application/json" id="${NBE_CHOICE_TAG}">${record}</script>\n</head>`);
}

/** The choice record an engine page carries, or null (hand-written pages carry none). */
export function readEngineChoice(html: string): Record<string, unknown> | null {
  const m = html.match(new RegExp(`<script type="application/json" id="${NBE_CHOICE_TAG}">([\\s\\S]*?)</script>`));
  if (!m) return null;
  try { return JSON.parse(m[1]) as Record<string, unknown>; } catch { return null; }
}
