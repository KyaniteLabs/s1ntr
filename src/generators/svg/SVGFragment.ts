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
 * Where a fragment-mode generation runs (#1162). `svg` is the only fragment
 * medium today: an explicit svg domain runs there, the custom catch-all
 * (formerly `meta`) and an undetected domain route to svg, and any other
 * explicit domain is refused — p5 instance-mode and Three.js container
 * fragments are separate issues.
 */
export interface FragmentDomainRoute {
  readonly domain: 'svg';
  /** Set when a non-svg domain choice was rerouted to svg instead of refused. */
  readonly reroutedFrom?: 'custom' | 'undetected';
  /** One human line explaining a reroute; empty when the domain was svg already. */
  readonly notice: string;
}

export const FRAGMENT_DOMAIN_ERROR = '--output-mode fragment needs the svg domain. Add --domain svg.';

export function routeFragmentDomain(domain: string | undefined):
  { ok: true; route: FragmentDomainRoute } | { ok: false; error: string } {
  if (domain === 'svg') return { ok: true, route: { domain: 'svg', notice: '' } };
  if (domain === 'custom') {
    return { ok: true, route: { domain: 'svg', reroutedFrom: 'custom',
      notice: 'fragment output routes through the svg domain: custom (formerly meta) infers a medium, and svg is the only fragment medium today' } };
  }
  if (!domain) {
    return { ok: true, route: { domain: 'svg', reroutedFrom: 'undetected',
      notice: 'fragment output defaults to the svg domain: no domain was detected and svg is the only fragment medium today' } };
  }
  return { ok: false, error: FRAGMENT_DOMAIN_ERROR };
}

/** Sample placeholder colours for the host-page token scaffold. Hosts swap these for their palette. */
const HOST_TOKEN_SAMPLES = ['#e5484d', '#3b5bdb', '#12b886', '#f59f00', '#9c36b5', '#e8590c', '#0b7285', '#343a40'] as const;

/**
 * Build the host-page proof (#1162): a paste-ready HTML page that declares the
 * host tokens on :root (with visible, editable swatches) and embeds the accepted
 * fragment inline. Opening it in a browser shows the fragment rendering with
 * host colours; editing the token values re-themes it without touching the
 * fragment. The page owns all motion and honours prefers-reduced-motion.
 */
export function buildHostProofPage(fragment: string, spec: SVGFragmentSpec): string {
  const tokens = spec.tokens;
  const tokenDecls = tokens.length
    ? tokens.map((t, i) => `      --${t}: ${HOST_TOKEN_SAMPLES[i % HOST_TOKEN_SAMPLES.length]};`).join('\n')
    : '      /* The fragment chose its own token names (or currentColor); declare them here. */';
  const swatches = tokens.map((t) =>
    `      <span class="token"><span class="swatch" style="background: var(--${t})"></span><code>--${t}</code></span>`)
    .join('\n');
  const container = spec.container
    ? `.fragment-host { width: ${spec.container.width}px; height: ${spec.container.height}px; }`
    : '.fragment-host { max-width: 640px; }';
  const motionCss = spec.motion === 'none'
    ? '    /* Motion: none — the fragment is static by request. */'
    : spec.motion === 'hover'
      ? `    /* Motion: hover — demo only. Bind real hover motion to the stable class names inside the fragment. */
    @media (prefers-reduced-motion: no-preference) {
      .fragment-host svg { transition: transform 240ms ease; }
      .fragment-host:hover svg { transform: translateY(-2px); }
    }`
      : `    /* Motion: loop — demo only. Bind real looping motion to the stable class names inside the fragment. */
    @media (prefers-reduced-motion: no-preference) {
      @keyframes sinter-fragment-drift { from { transform: translateY(0); } to { transform: translateY(-2px); } }
      .fragment-host svg { animation: sinter-fragment-drift 2.4s ease-in-out infinite alternate; }
    }`;
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Host page proof — sinter svg fragment</title>
  <style>
    /* Host tokens: replace these sample values with your own palette. */
    :root {
${tokenDecls}
    }
    body { margin: 0; padding: 24px; font: 14px/1.5 system-ui, sans-serif; color: #1f2328; }
    ${container}
${motionCss}
    .tokens { display: flex; gap: 12px; flex-wrap: wrap; margin: 0 0 16px; padding: 0; list-style: none; }
    .swatch { display: inline-block; width: 14px; height: 14px; border-radius: 3px; border: 1px solid #d0d7de; vertical-align: -2px; margin-right: 6px; }
    code { background: #f6f8fa; padding: 1px 5px; border-radius: 4px; }
  </style>
</head>
<body>
  <main>
    <h1>Host page proof</h1>
    <p>A sinter svg fragment embedded below. Edit the token values in <code>:root</code> and the artwork re-themes — the fragment itself never changes.</p>
    <ul class="tokens">
${swatches || '      <li>No token list was given; the fragment picked its own names.</li>'}
    </ul>
    <div class="fragment-host">
${fragment}
</div>
  </main>
</body>
</html>
`;
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
