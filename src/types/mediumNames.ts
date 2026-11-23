/**
 * The ONE table for what a user reads and types for a medium.
 *
 * - `MEDIUM_LABELS`: display label per stored medium id (ids on disk never change).
 * - `MEDIUM_NAME_ALIASES`: public names that resolve to a stored id. Old names stay
 *   valid input forever (silent), and new public names resolve here too.
 *
 * Display everywhere (CLI lines, help, wall cards) must read `mediumLabel()`,
 * never re-spell a label. See work/naming-decisions.md (2026-11-18).
 */

/** Display label by stored id. Anything not listed falls back to the id itself. */
export const MEDIUM_LABELS: Readonly<Record<string, string>> = Object.freeze({
  p5: 'p5.js sketch',
  three: 'three.js scene',
  shader: 'shader',
  glsl: 'shader',
  webgl: 'shader',
  fragment: 'shader',
  hydra: 'hydra feedback synth',
  svg: 'SVG drawing',
  html: 'webpage',
  webpage: 'webpage',
  dataviz: 'data visualization',
  kinetic: 'kinetic type and CSS motion',
  ascii: 'ASCII art',
  textgen: 'concrete poetry',
  strudel: 'strudel live-coded music',
  tone: 'Tone.js sound piece',
  blender: 'Blender render',
  nbe: 'fluid light simulation',
  custom: 'invented medium',
  meta: 'invented medium',
});

/**
 * Public names (lowercase) that resolve to a stored medium id. Resolution is silent:
 * no deprecation note, because none of these is deprecated input.
 * `glsl`/`webgl`/`fragment` are NOT here: they are stored ids or existing synonyms
 * (see DOMAIN_SYNONYMS) and keep their current behaviour.
 */
export const MEDIUM_NAME_ALIASES: Readonly<Record<string, string>> = Object.freeze({
  webpage: 'html',
  'concrete-poetry': 'textgen',
  concretepoetry: 'textgen',
  concrete_poetry: 'textgen',
  poetry: 'textgen',
  concrete: 'textgen',
  fluid: 'nbe',
  invented: 'custom',
});

/** Resolve a public medium name to its stored id; anything else is returned unchanged. */
export function resolveMediumName(value: string): string {
  const key = String(value ?? '').toLowerCase().trim();
  return MEDIUM_NAME_ALIASES[key] ?? value;
}

/** Display label for a medium id or public name (falls back to what was given). */
export function mediumLabel(value: string): string {
  const raw = String(value ?? '');
  const key = raw.toLowerCase().trim();
  return MEDIUM_LABELS[key] ?? MEDIUM_LABELS[resolveMediumName(key)] ?? raw;
}

/**
 * The public mediums, in display order, as stored ids. Every public count in copy
 * ("fifteen mediums") is derived from this list; docs tests assert against it.
 */
export const PUBLIC_MEDIUMS: readonly string[] = Object.freeze([
  'p5', 'three', 'shader', 'hydra', 'svg', 'html', 'dataviz', 'kinetic',
  'ascii', 'textgen', 'strudel', 'tone', 'blender', 'nbe', 'custom',
]);

/** Ids that exist or existed but are NOT counted as separate public mediums, and why. */
export const EXCLUDED_MEDIUMS: Readonly<Record<string, string>> = Object.freeze({
  glsl: 'same medium as shader (alias)',
  webgl: 'same medium as shader (alias)',
  fragment: 'same medium as shader (alias)',
  meta: 'old name of invented medium (alias)',
  revideo: 'removed medium',
  hyperframes: 'removed medium',
  unknown: 'internal routing value',
  generic: 'internal routing value',
  music: 'internal routing value (group of strudel/tone)',
  code: 'internal routing value',
});

const NUMBER_WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten',
  'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen', 'twenty'];

/** The public medium count as a word ("fifteen"), derived from PUBLIC_MEDIUMS. */
export function mediumCountWord(): string {
  return NUMBER_WORDS[PUBLIC_MEDIUMS.length] ?? String(PUBLIC_MEDIUMS.length);
}

/**
 * Plain words for result states. Stored values (`degraded`, ...) never change;
 * only what the user reads does.
 */
export const RESULT_STATE_LABELS: Readonly<Record<string, string>> = Object.freeze({
  /** The judge could not score the piece. */
  scoreDegraded: 'unscored',
  /** The render finished but incomplete. */
  renderDegraded: 'partial',
});

/** Public entropy quality label. Event payloads retain the stored value. */
export function entropyQualityLabel(value: string): string {
  return value === 'degraded' ? 'limited' : value;
}

/** Plain words for lines printed on every generate run. */
export const RUN_LABELS = Object.freeze({
  attempts: 'Attempts',
  receipt: 'Signed receipt',
  detectedMedium: 'Detected medium',
  forcedMedium: 'Medium (forced via --domain)',
});

export const TAGLINE = 'S1NTR: a tool for coding art.';
