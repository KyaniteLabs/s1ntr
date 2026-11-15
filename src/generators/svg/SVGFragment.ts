import { validateSVG, type SVGValidationResult } from './SVGValidator.js';

/**
 * Embeddable SVG output mode (#1162). `standalone` is the default and changes
 * nothing. `fragment` asks for an inline <svg> that lives inside a host page
 * and takes its colours from the host's CSS custom properties.
 */
export type SVGOutputMode = 'standalone' | 'fragment';
export type SVGMotion = 'none' | 'hover' | 'loop';

export interface SVGFragmentSpec {
  /** Host CSS custom property names, without the leading `--`. Empty = any token. */
  readonly tokens: readonly string[];
  readonly container?: { readonly width: number; readonly height: number };
  readonly motion: SVGMotion;
}

export interface SVGOutputFlags {
  outputMode?: string;
  tokens?: string;
  container?: string;
  motion?: string;
}

const TOKEN_RE = /^[a-z][a-z0-9_-]*$/i;
const MOTIONS: readonly SVGMotion[] = ['none', 'hover', 'loop'];
const MAX_TOKENS = 24;
const MARKER_RE = /^\[sinter-svg-fragment tokens=(\S*) container=(\S*) motion=(\S+)\]$/m;

/**
 * Turn raw CLI flag values into a spec. Returns null for standalone output.
 * Throws a plain-English Error on bad input so the CLI can refuse before any
 * provider call is made.
 */
export function parseSvgOutputFlags(flags: SVGOutputFlags): SVGFragmentSpec | null {
  const mode = (flags.outputMode ?? 'standalone').toLowerCase();
  if (mode !== 'standalone' && mode !== 'fragment') {
    throw new Error(`--output-mode must be "standalone" or "fragment", got "${flags.outputMode}"`);
  }
  if (mode === 'standalone') {
    const stray = [flags.tokens && '--tokens', flags.container && '--container', flags.motion && '--motion']
      .filter(Boolean);
    if (stray.length) throw new Error(`${stray.join(', ')} only apply with --output-mode fragment`);
    return null;
  }
  const tokens = (flags.tokens ?? '').split(',').map((t) => t.trim().replace(/^--/, '')).filter(Boolean);
  const badToken = tokens.find((t) => !TOKEN_RE.test(t));
  if (badToken !== undefined) throw new Error(`--tokens: "${badToken}" is not a CSS custom property name`);
  if (tokens.length > MAX_TOKENS) throw new Error(`--tokens: at most ${MAX_TOKENS} tokens`);

  let container: SVGFragmentSpec['container'];
  if (flags.container !== undefined) {
    const m = /^(\d+(?:\.\d+)?)x(\d+(?:\.\d+)?)$/i.exec(flags.container.trim());
    if (!m || Number(m[1]) <= 0 || Number(m[2]) <= 0) {
      throw new Error('--container must look like 320x80 (width x height in CSS pixels)');
    }
    container = { width: Number(m[1]), height: Number(m[2]) };
  }
  const motion = (flags.motion ?? 'none').toLowerCase() as SVGMotion;
  if (!MOTIONS.includes(motion)) throw new Error('--motion must be none, hover or loop');
  return { tokens: [...new Set(tokens)], container, motion };
}

/**
 * Append the host constraints to the brief. The trailing marker line lets the
 * generation effect recover the spec from the prompt, so the command schema
 * and receipt chain stay untouched.
 */
export function buildFragmentBrief(prompt: string, spec: SVGFragmentSpec): string {
  const lines = [
    prompt,
    '',
    'HOST CONSTRAINTS (embeddable svg fragment):',
    '- Output one inline <svg> fragment for a host web page. No <html>, <head>, <body>, doctype or <script>.',
    '- The root <svg> needs a viewBox, no width or height, and aria-hidden="true".',
    spec.tokens.length
      ? `- Colour only with the host tokens: ${spec.tokens.map((t) => `var(--${t})`).join(', ')}. Use none where no token fits. Never write a bare colour.`
      : '- Colour with host tokens as var(--name) or currentColor. Never write a bare colour.',
    spec.container
      ? `- Target container is ${spec.container.width}x${spec.container.height} CSS px; pick a viewBox with that aspect ratio so it scales responsively.`
      : '- Container size is unknown; keep the viewBox responsive.',
    spec.motion === 'none'
      ? '- Motion: none. Static artwork.'
      : `- Motion: ${spec.motion}. Do not animate inside the SVG. Give moving parts stable class names so the host CSS can animate them on ${spec.motion}; the host will honour prefers-reduced-motion.`,
    `[sinter-svg-fragment tokens=${spec.tokens.join(',')} container=${spec.container ? `${spec.container.width}x${spec.container.height}` : 'auto'} motion=${spec.motion}]`,
  ];
  return lines.join('\n');
}

/** Recover a spec from a brief built by buildFragmentBrief, or null. */
export function extractFragmentSpec(prompt: string): SVGFragmentSpec | null {
  const m = MARKER_RE.exec(prompt);
  if (!m) return null;
  const size = /^(\d+(?:\.\d+)?)x(\d+(?:\.\d+)?)$/.exec(m[2]);
  return {
    tokens: m[1] ? m[1].split(',').filter((t) => TOKEN_RE.test(t)) : [],
    container: size ? { width: Number(size[1]), height: Number(size[2]) } : undefined,
    motion: MOTIONS.includes(m[3] as SVGMotion) ? (m[3] as SVGMotion) : 'none',
  };
}

/**
 * Validate a fragment. Stricter than the embed profile alone: wrappers and
 * scripts are rejected before salvage can quietly strip them, and colours must
 * come from the listed tokens.
 */
export function validateSVGFragment(input: string, spec: SVGFragmentSpec): SVGValidationResult {
  const raw = input.trim();
  if (/<script\b/i.test(raw)) return { valid: false, error: 'fragment must not contain <script>' };
  if (/<!doctype|<\/?(?:html|head|body)\b/i.test(raw)) {
    return { valid: false, error: 'fragment must not have an <html>/<body> wrapper' };
  }
  if (/<style\b/i.test(raw)) {
    return { valid: false, error: 'fragment must not contain <style>; the host page owns styling' };
  }
  if (!/^<svg\b/i.test(raw)) return { valid: false, error: 'fragment must start with a root <svg>' };
  // The sanitizer would invent a viewBox; a fragment must declare its own so the host can scale it.
  if (!/\bviewBox\s*=/i.test(raw.match(/^<svg\b[^>]*>/i)?.[0] ?? '')) {
    return { valid: false, error: 'SVG must include a valid viewBox' };
  }
  return validateSVG(raw, { mode: 'embed', hostTokens: spec.tokens });
}
