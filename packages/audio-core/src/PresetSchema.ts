export type SingVoiceFeature = 'rms' | 'pitchHz' | 'centroid' | 'spectralFlux' | 'onset' | 'voiced';
export type SingMappingCurve = 'linear' | 'easeIn' | 'easeOut' | 'exponential' | 'step';

/** Semantic visual channels a preset can bind to (see SemanticMapper). */
export type SemanticChannel =
  | 'palette.hue' | 'palette.saturation' | 'palette.value' | 'palette.accentHue'
  | 'form.family' | 'form.complexity' | 'form.symmetry' | 'form.sharpness'
  | 'motion.flow' | 'motion.turbulence' | 'motion.shimmer'
  | 'texture.grain' | 'texture.glow' | 'texture.softness'
  | 'density.coverage' | 'density.spawn'
  | 'composition.scale' | 'composition.focalY' | 'composition.depth';

export const SEMANTIC_CHANNELS: readonly SemanticChannel[] = [
  'palette.hue', 'palette.saturation', 'palette.value', 'palette.accentHue',
  'form.family', 'form.complexity', 'form.symmetry', 'form.sharpness',
  'motion.flow', 'motion.turbulence', 'motion.shimmer',
  'texture.grain', 'texture.glow', 'texture.softness',
  'density.coverage', 'density.spawn',
  'composition.scale', 'composition.focalY', 'composition.depth',
];

/** Raw feature → uniform binding (legacy `source` optional, defaults to raw). */
export interface SingRawMapping {
  source?: 'raw';
  feature: SingVoiceFeature;
  target: string;
  curve: SingMappingCurve;
  min: number;
  max: number;
  smoothing?: number;
}

/** Semantic channel → uniform binding. */
export interface SingSemanticMapping {
  source: 'semantic';
  channel: SemanticChannel;
  target: string;
  curve?: SingMappingCurve;
  smoothing?: number;
}

export type SingPresetMapping = SingRawMapping | SingSemanticMapping;

export interface SingPresetArtifact {
  schemaVersion: 1;
  instrument: 'sing';
  id: string;
  name: string;
  createdAt: string;
  /** GLSL fragment shader (the fast native WebGL path). */
  shader?: {
    language: 'glsl-fragment';
    source: string;
  };
  /**
   * Full HTML artifact rendered in a sandboxed iframe and fed live voice frames
   * via postMessage (the artifact reads `window.sing.*`). This is the universal
   * visual path: ANY creative-coding domain (p5, three, hydra, svg, ascii,
   * kinetic, …) AND multi-layer compositions — not just shaders. Exactly one of
   * `shader` or `html` must be present.
   */
  html?: {
    source: string;
  };
  mappings: SingPresetMapping[];
  metadata: Record<string, unknown>;
}

export type SingPresetValidation =
  | { ok: true; preset: SingPresetArtifact }
  | { ok: false; error: string };

export function createSingPreset(params: {
  id: string;
  name: string;
  shader: string;
  mappings: SingPresetMapping[];
  metadata?: Record<string, unknown>;
  createdAt?: string;
}): SingPresetArtifact {
  return {
    schemaVersion: 1,
    instrument: 'sing',
    id: params.id,
    name: params.name,
    createdAt: params.createdAt ?? new Date().toISOString(),
    shader: {
      language: 'glsl-fragment',
      source: params.shader,
    },
    mappings: params.mappings,
    metadata: params.metadata ?? {},
  };
}

/**
 * Build an HTML-artifact preset (any creative-coding domain or composition).
 * The HTML is rendered in a sandboxed iframe and fed live voice frames via
 * postMessage; the artifact reads `window.sing.*`. Mappings are optional here
 * (they only drive the GLSL uniform path) and default to none.
 */
export function createSingHtmlPreset(params: {
  id: string;
  name: string;
  html: string;
  mappings?: SingPresetMapping[];
  metadata?: Record<string, unknown>;
  createdAt?: string;
}): SingPresetArtifact {
  return {
    schemaVersion: 1,
    instrument: 'sing',
    id: params.id,
    name: params.name,
    createdAt: params.createdAt ?? new Date().toISOString(),
    html: { source: params.html },
    mappings: params.mappings ?? [],
    metadata: params.metadata ?? {},
  };
}

export function validateSingPreset(value: unknown): SingPresetValidation {
  if (!value || typeof value !== 'object') return { ok: false, error: 'preset must be an object' };
  const preset = value as Partial<SingPresetArtifact>;
  if (preset.schemaVersion !== 1) return { ok: false, error: 'schemaVersion must be 1' };
  if (preset.instrument !== 'sing') return { ok: false, error: 'instrument must be sing' };
  if (!nonEmpty(preset.id)) return { ok: false, error: 'id is required' };
  if (!nonEmpty(preset.name)) return { ok: false, error: 'name is required' };
  // Exactly one visual source: a GLSL fragment shader or an HTML artifact.
  const hasShader = !!preset.shader && preset.shader.language === 'glsl-fragment' && nonEmpty(preset.shader.source);
  const hasHtml = !!preset.html && nonEmpty(preset.html.source);
  if (preset.shader && preset.shader.language !== 'glsl-fragment') {
    return { ok: false, error: 'shader.language must be glsl-fragment' };
  }
  if (!hasShader && !hasHtml) {
    return { ok: false, error: 'preset needs a glsl-fragment shader.source or an html.source' };
  }
  if (!Array.isArray(preset.mappings)) {
    return { ok: false, error: 'mappings must be an array' };
  }
  // Mappings drive GLSL uniforms; required for the shader path, optional for html.
  if (hasShader && !hasHtml && preset.mappings.length === 0) {
    return { ok: false, error: 'shader presets need at least one mapping' };
  }
  for (const mapping of preset.mappings) {
    if (!isValidMapping(mapping)) return { ok: false, error: 'mapping is invalid' };
  }
  return { ok: true, preset: preset as SingPresetArtifact };
}

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isValidMapping(mapping: unknown): mapping is SingPresetMapping {
  if (!mapping || typeof mapping !== 'object') return false;
  const candidate = mapping as Record<string, unknown>;
  if (!nonEmpty(candidate.target)) return false;
  if (candidate.source === 'semantic') {
    return isSemanticChannel(candidate.channel)
      && (candidate.curve === undefined || isCurve(candidate.curve));
  }
  // Raw mapping (source 'raw' or absent for backward compatibility).
  return isVoiceFeature(candidate.feature)
    && isCurve(candidate.curve)
    && typeof candidate.min === 'number'
    && typeof candidate.max === 'number'
    && Number.isFinite(candidate.min)
    && Number.isFinite(candidate.max);
}

function isSemanticChannel(value: unknown): value is SemanticChannel {
  return typeof value === 'string' && (SEMANTIC_CHANNELS as readonly string[]).includes(value);
}

function isVoiceFeature(value: unknown): value is SingVoiceFeature {
  return value === 'rms' || value === 'pitchHz' || value === 'centroid' || value === 'spectralFlux' || value === 'onset' || value === 'voiced';
}

function isCurve(value: unknown): value is SingMappingCurve {
  return value === 'linear' || value === 'easeIn' || value === 'easeOut' || value === 'exponential' || value === 'step';
}
