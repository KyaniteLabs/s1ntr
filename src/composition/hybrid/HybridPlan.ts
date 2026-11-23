/**
 * Hybrid plan: S1NTR's own decision about what a piece is made of.
 *
 * A hybrid plan says which domains stack, what role each plays, the shared
 * palette and tempo, the cross-layer signals, and WHY. The same plan type covers a
 * single-medium choice (one layer), so "S1NTR chose" is recorded for every piece.
 * Parsing is strict: a plan that cannot be read, or names a layer we cannot build,
 * is an error naming the layer, never a silent p5 fallback.
 */
import type { BlendMode, DomainType } from '../types.js';
import { answerJson } from '../../llm/ModelOutput.js';

/** Operator switch for layered pieces. */
export const LAYERED_FLAG = 'SINTER_LAYERED';
/** Silent alias, still read (naming decision 2026-11-18). */
export const HYBRID_FLAG = 'SINTER_HYBRID_LAYERS';

export function hybridEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[LAYERED_FLAG] === '1' || env[HYBRID_FLAG] === '1';
}

export type HybridRole = 'background' | 'overlay' | 'mask' | 'sound' | 'accent';

/** Browser-domain layers a planner may stack. Blender, dataviz and textgen are follow-ups. */
export const HYBRID_DOMAINS = [
  'p5', 'three', 'glsl', 'hydra', 'svg', 'html', 'kinetic', 'ascii', 'tone', 'strudel', 'nbe', 'custom',
] as const satisfies readonly DomainType[];

const SOUND_DOMAINS = new Set<string>(['tone', 'strudel']);
const ROLES: readonly HybridRole[] = ['background', 'overlay', 'mask', 'sound', 'accent'];
const BLENDS: readonly BlendMode[] = ['normal', 'screen', 'multiply', 'overlay', 'lighten', 'darken', 'difference', 'exclusion'];

export interface HybridLayer {
  readonly domain: DomainType;
  readonly role: HybridRole;
  readonly prompt: string;
  /** One sentence: why S1NTR gave this layer this medium and role. */
  readonly why: string;
  readonly blendMode: BlendMode;
  readonly opacity: number;
  /** Mask layers: index of the layer this mask cuts. */
  readonly maskTarget?: number;
  /** Operator-supplied code, used as-is (never set by the planner). */
  readonly code?: string;
}

export interface HybridSignal {
  readonly kind: 'beat';
  /** Layer index that owns the rhythm (the sound layer, else the shared clock). */
  readonly from: number | 'clock';
  readonly to: number;
  readonly param: 'scale' | 'opacity';
  /** 0..1 strength of the visible response. */
  readonly depth: number;
}

export interface HybridPlan {
  readonly title: string;
  readonly background: string;
  readonly kind: 'single' | 'layered';
  readonly chosenBy: 'planner' | 'operator-layers';
  /** One sentence: why single vs hybrid and why these mediums. */
  readonly reason: string;
  readonly palette: { readonly background: string; readonly colors: readonly string[] };
  readonly bpm: number | null;
  readonly layers: readonly HybridLayer[];
  readonly signals: readonly HybridSignal[];
}

export class HybridPlanError extends Error {
  constructor(message: string, readonly layerIndex?: number, readonly domain?: string) {
    super(message);
    this.name = 'HybridPlanError';
  }
}

export interface ExplicitLayerRequest { readonly domain: string; readonly role: HybridRole }

function validateLayerRole(domain: string, role: HybridRole, fail: (message: string) => never): void {
  if (role === 'mask' && domain !== 'svg') fail('a mask layer must be svg');
  if (SOUND_DOMAINS.has(domain) && role !== 'sound') fail('tone and strudel layers play the sound role');
}

/** Parse "glsl:background,kinetic:overlay,tone:sound" (role optional: first = background, sound for tone/strudel). */
export function parseLayerList(list: string): ExplicitLayerRequest[] {
  const items = list.split(',').map((s) => s.trim()).filter(Boolean);
  if (items.length === 0) throw new HybridPlanError('--layers is empty');
  return items.map((item, index) => {
    const [rawDomain, rawRole] = item.split(':').map((s) => s.trim().toLowerCase());
    const domain = rawDomain === 'shader' ? 'glsl' : rawDomain;
    if (!(HYBRID_DOMAINS as readonly string[]).includes(domain)) {
      throw new HybridPlanError(`layer ${index} names unsupported domain "${rawDomain}" (supported: ${HYBRID_DOMAINS.join(', ')})`, index, rawDomain);
    }
    const role = (rawRole || (SOUND_DOMAINS.has(domain) ? 'sound' : index === 0 ? 'background' : 'overlay')) as HybridRole;
    if (!ROLES.includes(role)) throw new HybridPlanError(`layer ${index} (${domain}) has unknown role "${rawRole}"`, index, domain);
    validateLayerRole(domain, role, message => { throw new HybridPlanError(`layer ${index} (${domain}): ${message}`, index, domain); });
    if (role === 'mask' && items.length === 1) throw new HybridPlanError('a mask layer needs another layer to mask', index, domain);
    return { domain, role };
  });
}

const HEX = /^#[0-9a-f]{3,8}$/i;

function text(value: unknown, field: string, fail: (m: string) => never): string {
  if (typeof value !== 'string' || !value.trim()) fail(`${field} is missing`);
  return (value as string).trim();
}

export function parseHybridPlan(raw: string, explicit?: readonly ExplicitLayerRequest[]): HybridPlan {
  let obj: Record<string, unknown>;
  try {
    const json = answerJson(raw);
    const start = json.indexOf('{');
    const end = json.lastIndexOf('}');
    obj = JSON.parse(start >= 0 && end > start ? json.slice(start, end + 1) : json) as Record<string, unknown>;
  } catch {
    throw new HybridPlanError('the planner reply was not valid JSON');
  }
  const planFail = (m: string): never => { throw new HybridPlanError(`plan: ${m}`); };
  const rawLayers = Array.isArray(obj.layers) ? obj.layers : [];
  if (rawLayers.length === 0) planFail('no layers');
  const layers: HybridLayer[] = rawLayers.map((entry, index) => {
    const r = (entry && typeof entry === 'object' ? entry : {}) as Record<string, unknown>;
    const rawDomain = String(r.domain ?? '').toLowerCase();
    const domain = (rawDomain === 'shader' ? 'glsl' : rawDomain) as DomainType;
    const fail = (m: string): never => { throw new HybridPlanError(`layer ${index} (${rawDomain || '?'}): ${m}`, index, rawDomain); };
    if (!(HYBRID_DOMAINS as readonly string[]).includes(domain)) fail('unsupported domain');
    const role = String(r.role ?? '').toLowerCase() as HybridRole;
    if (!ROLES.includes(role)) fail(`unknown role "${String(r.role)}"`);
    validateLayerRole(domain, role, fail);
    const blend = String(r.blendMode ?? 'normal').toLowerCase() as BlendMode;
    const opacity = Number(r.opacity ?? 1);
    const maskTarget = r.maskTarget === undefined ? undefined : Number(r.maskTarget);
    if (role === 'mask') {
      if (maskTarget === undefined || !Number.isInteger(maskTarget) || maskTarget < 0 || maskTarget >= rawLayers.length
        || maskTarget === index) fail('a mask layer needs a maskTarget naming another layer index');
    }
    return {
      domain, role,
      prompt: text(r.prompt, 'prompt', fail),
      why: text(r.why, 'why', fail),
      blendMode: BLENDS.includes(blend) ? blend : 'normal',
      opacity: Number.isFinite(opacity) ? Math.min(1, Math.max(0, opacity)) : 1,
      ...(role === 'mask' ? { maskTarget } : {}),
    };
  });
  if (explicit) {
    if (explicit.length !== layers.length || explicit.some((e, i) => e.domain !== layers[i].domain || e.role !== layers[i].role)) {
      const describe = (items: readonly ExplicitLayerRequest[]) => items.map(({ domain, role }) => `${domain}:${role}`).join(', ');
      throw new HybridPlanError(`the planner changed the operator's layer list (asked ${describe(explicit)}; got ${describe(layers)})`);
    }
  }
  const palette = (obj.palette && typeof obj.palette === 'object' ? obj.palette : {}) as Record<string, unknown>;
  const colors = Array.isArray(palette.colors) ? palette.colors.map(String).filter((c) => HEX.test(c)) : [];
  const background = typeof palette.background === 'string' && HEX.test(palette.background) ? palette.background : '#05070f';
  if (colors.length < 2) planFail('palette needs at least two hex colors');
  const bpmValue = obj.bpm === null || obj.bpm === undefined ? null : Number(obj.bpm);
  const hasSound = layers.some((l) => SOUND_DOMAINS.has(l.domain));
  if (hasSound && !(bpmValue && bpmValue >= 40 && bpmValue <= 220)) planFail('a sound layer needs a bpm between 40 and 220');
  const bpm = bpmValue && bpmValue >= 40 && bpmValue <= 220 ? Math.round(bpmValue) : null;
  const signals: HybridSignal[] = (Array.isArray(obj.signals) ? obj.signals : []).map((entry, i) => {
    const r = (entry && typeof entry === 'object' ? entry : {}) as Record<string, unknown>;
    const to = Number(r.to);
    const from = r.from === 'clock' ? 'clock' as const : Number(r.from);
    const param = r.param === 'opacity' ? 'opacity' as const : 'scale' as const;
    const depth = Number(r.depth ?? 0.4);
    if (!Number.isInteger(to) || to < 0 || to >= layers.length || SOUND_DOMAINS.has(layers[to].domain)) {
      throw new HybridPlanError(`signal ${i}: "to" must name a visual layer index`);
    }
    if (from !== 'clock' && (!Number.isInteger(from) || from < 0 || from >= layers.length)) {
      throw new HybridPlanError(`signal ${i}: "from" must be a layer index or "clock"`);
    }
    if (bpm === null) throw new HybridPlanError(`signal ${i}: a beat signal needs a bpm`);
    return { kind: 'beat', from, to, param, depth: Number.isFinite(depth) ? Math.min(1, Math.max(0.05, depth)) : 0.4 };
  });
  const title = typeof obj.title === 'string' && obj.title.trim() ? obj.title.trim() : 'S1NTR Hybrid';
  return {
    title, background,
    kind: layers.length > 1 ? 'layered' : 'single',
    chosenBy: explicit ? 'operator-layers' : 'planner',
    reason: text(obj.reason, 'reason', planFail),
    palette: { background, colors },
    bpm, layers, signals,
  };
}

const ROLE_BRIEF: Record<HybridRole, string> = {
  background: 'Role: the BACKGROUND field. Fill the whole frame; you are the lowest layer.',
  overlay: 'Role: an OVERLAY. Draw on a transparent canvas so the layers beneath show through.',
  accent: 'Role: a small ACCENT. Transparent canvas; one restrained focal mark, not a fill.',
  mask: 'Role: a MASK for another layer. Output a single inline SVG: pure black background rect, then white shapes. White reveals the target layer, black hides it. No colour, no text unless it is the shape.',
  sound: 'Role: the SOUND of the piece.',
};

/** What a beat-wired layer is told: the signal, where to read it, and that the response must be visible. */
function signalBrief(bpm: number, params: readonly string[], domain: string): string {
  const controls = [...new Set(params)].map((p) => `window.sinterControl.${p}`).join(' and ');
  return `Shared tempo: ${bpm} bpm. This layer is WIRED to the beat. Every frame read window.sinterSignal.beat (0..1: 1 on the beat, decaying between beats) and ${controls} (0..1, the beat scaled by its depth; 0 until the first beat); the window events 'sinter:signal' and 'sinter:control' fire on each message. Make the beat VISIBLE in this layer's own pixels: a pulse in size or brightness, a hard cut, or a colour shift toward the accents, strong enough to see at a glance between two frames. Do not keep your own clock for it. ${domain === 'glsl' ? ' In a shader, declare `uniform float u_beat;` (the host sets it from the beat, 0..1) and let it change the colour or brightness of the whole field.' : ''} A wired layer that ignores the beat fails the piece.`;
}

/** The per-layer prompt: the planner's words plus the shared contract (role, palette, tempo, signal). */
export function layerPromptWithContract(plan: HybridPlan, index: number): string {
  const layer = plan.layers[index];
  const parts = [layer.prompt, ROLE_BRIEF[layer.role]];
  if (layer.role !== 'mask' && !SOUND_DOMAINS.has(layer.domain)) {
    parts.push(`Shared palette: background ${plan.palette.background}; accents ${plan.palette.colors.join(", ")}. Stay inside these hues and their tints.`);
  }
  if (plan.bpm !== null) {
    const wired = plan.signals.filter((s) => s.kind === 'beat' && s.to === index);
    parts.push(SOUND_DOMAINS.has(layer.domain)
      ? `Shared tempo: ${plan.bpm} bpm.`
      : wired.length > 0 && layer.role !== 'mask'
        ? signalBrief(plan.bpm, wired.map((s) => s.param), layer.domain)
        : `Shared tempo: ${plan.bpm} bpm. If you animate to rhythm, read window.sinterSignal.beat (0..1, spikes to 1 on every beat) instead of keeping your own clock.`);
  }
  return parts.join('\n');
}

const DOMAIN_GUIDE: Record<string, string> = {
  p5: '2D drawing, particles, generative marks',
  three: '3D scenes, depth, lighting',
  glsl: 'full-frame shader fields, light, noise, flow',
  hydra: 'video-feedback synth textures',
  svg: 'crisp vector shapes (also the only mask medium)',
  html: 'DOM/CSS layout, typography, interface-like pieces',
  kinetic: 'moving type',
  ascii: 'text-glyph rendering',
  tone: 'synthesized sound (deterministic)',
  strudel: 'live-coded rhythmic music (deterministic)',
  nbe: 'neural-field fluid renderings',
  custom: 'a medium invented for the idea when no other fits',
};

export function plannerSystemPrompt(explicit?: readonly ExplicitLayerRequest[]): string {
  const guide = HYBRID_DOMAINS.map((d) => `${d}: ${DOMAIN_GUIDE[d]}`).join('; ');
  return [
    'You are S1NTR deciding what a piece is made of. Given an idea (it may be only a word, a mood, a question or a contradiction), choose the medium or the layered combination of mediums that best serves it, and say why. Reply with ONLY strict JSON.',
    `Mediums: ${guide}.`,
    explicit
      ? `The operator fixed the layers: ${explicit.map((e) => `${e.domain}:${e.role}`).join(', ')}, in that order. Use exactly those domains in that order; you still decide each prompt, the palette, tempo, signals and reasons.`
      : 'Choose one medium when the idea is whole in one; choose 2 to 4 layers when depth, motion, text or sound each earn a layer. Do not stack mediums for show.',
    'JSON shape: {"title": string, "reason": one sentence on single vs hybrid and why these mediums, "palette": {"background": "#hex", "colors": ["#hex","#hex",...]}, "bpm": number 40-220 or null (required if a tone/strudel layer exists), "layers": [{"domain": string, "role": "background|overlay|accent|mask|sound", "prompt": string (say what the layer shows and why, never how to code it), "why": one sentence, "blendMode": "normal|screen|lighten|multiply", "opacity": 0..1, "maskTarget": layer index (mask layers only)}], "signals": [{"kind":"beat","from": layer index or "clock","to": visual layer index,"param":"scale|opacity","depth":0..1}]}.',
    'Order layers back to front; the first is the background. A mask layer is svg, role "mask", with maskTarget naming the layer it cuts. At most one brightening (screen/lighten) overlay; other overlays use normal. Pick a deliberate palette with real contrast between background and accents. Add a beat signal when a sound layer exists so a visual layer answers the rhythm. Let the idea decide; leave room for the layer generators to be inventive.',
  ].join(' ');
}
