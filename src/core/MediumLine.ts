/**
 * MediumLine: the plain, human-readable record of what S1NTR ended up building.
 *
 * Every piece (single-domain or hybrid) gets one `medium.json` next to its artifact
 * carrying `medium_line`, so a wall card can say what the system actually did instead
 * of surfacing a bare domain id. A custom-domain piece is described by the descriptor
 * the generator embedded in the artifact, never as just "custom".
 */
// Deliberately no import from generators/custom: the governed generate entry's
// production-authority scan follows static imports, and CustomGenerator pulls in
// provider code. The descriptor format is the one CustomGenerator documents.
export interface MetaDomainDescriptor {
  name: string;
  runtime: string;
  libraries: string[];
  renderTarget: string;
  notes: string;
}

const DESCRIPTOR_OPEN = '<!--SINTER-META-DESCRIPTOR';
const DESCRIPTOR_CLOSE = '-->';

/** Same contract as CustomGenerator.parseMetaDescriptorFromHtml (kept in step by MediumLine.test.ts). */
export function parseMetaDescriptor(html: string): MetaDomainDescriptor | null {
  const open = html.indexOf(DESCRIPTOR_OPEN);
  if (open === -1) return null;
  const close = html.indexOf(DESCRIPTOR_CLOSE, open + DESCRIPTOR_OPEN.length);
  if (close === -1) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(html.slice(open + DESCRIPTOR_OPEN.length, close).trim());
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const obj = parsed as Record<string, unknown>;
  const text = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');
  const name = text(obj.name);
  const runtime = text(obj.runtime);
  const renderTarget = text(obj.renderTarget);
  const libraries = Array.isArray(obj.libraries)
    ? obj.libraries.filter((l): l is string => typeof l === 'string').map((l) => l.trim()).filter(Boolean)
    : [];
  if (!name || !runtime || !renderTarget) return null;
  return { name, runtime, libraries, renderTarget, notes: text(obj.notes) };
}

/**
 * What the governed `custom` domain asks the model to emit first, so every custom piece says what
 * medium it invented. Same format CustomGenerator documents and parseMetaDescriptor reads.
 */
export const META_DESCRIPTOR_CONTRACT =
  `Begin the document with one single-line comment, exactly: ${DESCRIPTOR_OPEN} `
  + '{"name":"<short-kebab-slug>","runtime":"<canvas|svg|webgl|audio|dom|...>","libraries":["<library names, or empty>"],'
  + '"renderTarget":"<#mount-id or canvas/svg>","notes":"<one line: the technique>"}-->'
  + ' then <!DOCTYPE html> and the page.';

export const MEDIUM_SCHEMA = 'sinter.medium' as const;
export const MEDIUM_FILENAME = 'medium.json';

export type MediumDecisionSource =
  | 'forced'      // the operator named the domain (--domain)
  | 'prompt-cue'  // the prompt itself named or implied a medium
  | 'planner'     // S1NTR's planner chose, with a recorded reason
  | 'default';    // nothing chose: the fallback medium was used (said out loud)

export interface MediumDecision {
  readonly source: MediumDecisionSource;
  /** One sentence: why this medium. */
  readonly reason: string;
}

export interface MediumLayerSummary {
  readonly id: string;
  readonly domain: string;
  readonly role: string;
  readonly why?: string;
}

export interface MediumRecord {
  readonly schema: typeof MEDIUM_SCHEMA;
  readonly schemaVersion: '1.0';
  /** The line the wall shows: what S1NTR built and why. Never a bare domain id. */
  /** The line the wall shows (new name). */
  readonly made_with: string;
  /** Same text as `made_with`; written for one release, read either. */
  readonly medium_line: string;
  readonly domain: string;
  readonly kind: 'single' | 'layered';
  readonly decision: MediumDecision;
  readonly libraries: readonly string[];
  readonly renderTarget: string;
  readonly descriptor?: MetaDomainDescriptor;
  readonly layers?: readonly MediumLayerSummary[];
}

const DOMAIN_LABEL: Record<string, string> = {
  p5: 'p5.js sketch',
  three: 'three.js scene',
  glsl: 'GLSL shader',
  shader: 'GLSL shader',
  hydra: 'hydra feedback synth',
  svg: 'SVG drawing',
  html: 'HTML/CSS page',
  dataviz: 'D3 data visualization',
  kinetic: 'kinetic typography',
  ascii: 'ASCII render',
  textgen: 'generated text',
  strudel: 'strudel live-coded music',
  tone: 'Tone.js sound piece',
  music: 'generated music',
  blender: 'Blender render',
  nbe: 'neural-field fluid render',
  custom: 'custom medium',
};

const LIBRARY_PROBES: ReadonlyArray<readonly [string, RegExp]> = [
  ['p5.js', /\bp5(?:\.min)?\.js\b|\/vendor\/p5\/|new\s+p5\s*\(|function\s+setup\s*\(/],
  ['three.js', /\bTHREE\.|from\s+['"]three['"]|\/vendor\/three\//],
  ['Tone.js', /\bTone\.(?:Transport|Synth|start|Oscillator|Player)|\/vendor\/tone\//],
  ['hydra', /\bhydra-synth\b|\/vendor\/hydra\/|\bnew\s+Hydra\s*\(/],
  ['strudel', /@strudel|\/vendor\/strudel\/|\bstrudel\b/],
  ['d3', /\bd3\.(?:select|scale|svg|geo|forceSimulation)|\/vendor\/d3\//],
  ['gsap', /\bgsap\.(?:to|from|timeline)|\/vendor\/gsap\//],
  ['WebGL/GLSL', /gl_FragColor|fragColor|getContext\(\s*['"]webgl2?['"]/],
];

export function detectLibraries(source: string): string[] {
  const found: string[] = [];
  for (const [name, pattern] of LIBRARY_PROBES) if (pattern.test(source)) found.push(name);
  return found;
}

function detectRenderTarget(domain: string, source: string): string {
  if (/<canvas\b|createCanvas\(|getContext\(/.test(source)) return 'canvas';
  if (/<svg\b/i.test(source)) return 'svg';
  if (domain === 'tone' || domain === 'strudel' || domain === 'music') return 'audio';
  if (domain === 'blender') return 'png still';
  return 'dom';
}

function sentence(value: string): string {
  const trimmed = value.trim().replace(/\s+/g, ' ');
  return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

export interface DescribeMediumInput {
  readonly domain: string;
  /** The artifact source (HTML/JS/GLSL); used to read the descriptor and libraries actually used. */
  readonly source: string;
  readonly decision: MediumDecision;
  readonly layers?: readonly MediumLayerSummary[];
  /** Hybrid pieces supply the libraries/target they merged; single pieces derive them. */
  readonly libraries?: readonly string[];
  readonly renderTarget?: string;
}

export function describeMedium(input: DescribeMediumInput): MediumRecord {
  const domain = input.domain.toLowerCase();
  const hybrid = (input.layers?.length ?? 0) > 1;
  const descriptor = domain === 'custom'
    ? parseMetaDescriptor(input.source) ?? undefined : undefined;
  const libraries = input.libraries
    ? [...input.libraries]
    : descriptor && descriptor.libraries.length > 0
      ? [...descriptor.libraries]
      : detectLibraries(input.source);
  const renderTarget = input.renderTarget
    ?? (descriptor?.renderTarget || detectRenderTarget(domain, input.source));

  let build: string;
  if (hybrid) {
    const parts = input.layers!.map((layer) => `${layer.domain} ${layer.role}`);
    build = `layered piece of ${parts.join(' + ')}`;
  } else if (descriptor) {
    build = `custom medium "${descriptor.name}" (${descriptor.runtime})`;
  } else if (domain === 'custom') {
    build = 'custom medium (no descriptor was embedded in the artifact)';
  } else {
    build = DOMAIN_LABEL[domain] ?? `${domain} piece`;
  }
  const via = libraries.length > 0 ? `, using ${libraries.join(', ')}` : '';
  const note = descriptor?.notes ? ` Technique: ${sentence(descriptor.notes)}` : '';
  const medium_line = `S1NTR built a ${build}${via}, rendering to ${renderTarget}. `
    + `Why: ${sentence(input.decision.reason)}${note}`;
  return Object.freeze({
    schema: MEDIUM_SCHEMA,
    schemaVersion: '1.0' as const,
    made_with: medium_line,
    medium_line,
    domain,
    kind: hybrid ? 'layered' as const : 'single' as const,
    decision: input.decision,
    libraries,
    renderTarget,
    ...(descriptor ? { descriptor } : {}),
    ...(input.layers ? { layers: input.layers } : {}),
  });
}

/** Decision recorded for the single-domain `generate` path, honest about silent defaults. */
export function decideGenerateMedium(input: {
  readonly domain: string;
  readonly forced: boolean;
  readonly detected: string | undefined;
}): MediumDecision {
  if (input.forced) {
    return { source: 'forced', reason: `the operator asked for ${input.domain} with --domain` };
  }
  if (input.detected) {
    return { source: 'prompt-cue', reason: `the prompt's wording pointed to ${input.detected}` };
  }
  return {
    source: 'default',
    reason: `the prompt named no medium and no planner was asked, so S1NTR fell back to ${input.domain}`
      + ' (set SINTER_LAYERED=1 to let S1NTR choose the medium and layers)',
  };
}

/** Read a medium.json written by any release: old `medium_line` / `kind: 'hybrid'` still load. */
export function readMediumRecord(raw: unknown): { made_with: string; kind: 'single' | 'layered' } {
  const r = (raw ?? {}) as { made_with?: unknown; medium_line?: unknown; kind?: unknown };
  const text = typeof r.made_with === 'string' ? r.made_with : typeof r.medium_line === 'string' ? r.medium_line : '';
  if (!text) throw new Error('medium.json has neither made_with nor medium_line');
  return { made_with: text, kind: r.kind === 'layered' || r.kind === 'hybrid' ? 'layered' : 'single' };
}
