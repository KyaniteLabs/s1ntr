/**
 * Creative coding domains supported by Sinter
 * Use these instead of magic strings
 */
import { resolveMediumName } from './mediumNames.js';

export enum Domain {
  P5 = 'p5',
  GLSL = 'glsl',
  THREE = 'three',
  TONE = 'tone',
  HYDRA = 'hydra',
  UNKNOWN = 'unknown',
  GENERIC = 'generic',
  WEBGL = 'webgl',
  SHADER = 'shader',
  STRUDEL = 'strudel',
  ASCII = 'ascii',
  MUSIC = 'music',
  CODE = 'code',
  KINETIC = 'kinetic',
  SVG = 'svg',
  HTML = 'html',
  DATAVIZ = 'dataviz', // Self-contained HTML page that loads D3.js v7 and renders a data-driven visualization
  CUSTOM = 'custom', // Custom-domain catch-all generator (formerly 'meta'): self-contained HTML for ANY medium outside the 14 fixed domains
  TEXTGEN = 'textgen',
  BLENDER = 'blender', // Blender bpy script rendered headless to a PNG still
  NBE = 'nbe', // Neural Bloom Engine: cascade neural-field HTML render
  EMPTY = ''
}

/**
 * The canonical Domain values as a string union — for modules that need a string
 * type instead of the enum. Derived from the enum so the two can never drift; this
 * is the single source other modules should import instead of re-declaring their own
 * `type Domain = '...'` unions (the audit found 9 incompatible copies).
 */
export type DomainString = `${Domain}`;

/**
 * DomainString plus the export-engine ids that are NOT art domains. `revideo` is a
 * video-assembly engine owned by KinoCut: validators, wrappers and renderers still
 * accept it as input, but S1NTR no longer generates it (Simon, 2026-11-19).
 */
export type EngineDomainString = DomainString | 'revideo' | 'hyperframes';

/**
 * Type guard for Domain enum
 */
export function isValidDomain(value: string): value is Domain {
  return Object.values(Domain).includes(value as Domain);
}

/**
 * Synonyms some generators/labels use for the same underlying domain. Intentionally
 * narrow — only true aliases, NOT distinct generators (`tone` and `strudel` are both
 * music but are different generators and must stay distinct).
 */
const DOMAIN_SYNONYMS: Record<string, Domain> = {
  webgl: Domain.WEBGL,
  fragment: Domain.GLSL,
  d3: Domain.DATAVIZ,
  meta: Domain.CUSTOM, // deprecated alias (see DEPRECATED_DOMAIN_ALIASES)
  revideo: Domain.CUSTOM, // legacy stored runs: removed art domain, loads as custom
  hyperframes: Domain.CUSTOM, // legacy stored runs: removed art domain, loads as custom
  bpy: Domain.BLENDER,
};

/**
 * Deprecated domain ids that still resolve to a current one. The single place the
 * CLI and input boundaries read: `meta` was renamed `custom` (2026-11-18), but
 * running benches, the hillclimb and old corpora still say `meta`.
 */
export const DEPRECATED_DOMAIN_ALIASES: Readonly<Record<string, string>> = Object.freeze({
  meta: Domain.CUSTOM,
});

/**
 * Art domains that were removed (Simon, 2026-11-19). `revideo` and `hyperframes` are
 * video-assembly engines that belong to KinoCut (their renderers stay as export engines).
 * Stored runs, ledgers and prompts that still carry the id load as `custom`
 * instead of crashing. Deliberately separate from DEPRECATED_DOMAIN_ALIASES: the
 * validators, wrappers and renderers read that one, and must keep treating
 * `revideo` / `hyperframes` as the engine ids they are.
 */
export const REMOVED_ART_DOMAIN_ALIASES: Readonly<Record<string, string>> = Object.freeze({
  revideo: Domain.CUSTOM,
  hyperframes: Domain.CUSTOM, // code-defined video timeline, KinoCut territory (Simon, 2026-11-19)
});

/**
 * Resolve a stored/legacy domain id for generation-side and display use: deprecated
 * aliases (`meta`) and removed art domains (`revideo`) both map to a live domain.
 */
export function legacyDomainId(value: string): string {
  const from = String(value ?? '').toLowerCase().trim();
  return REMOVED_ART_DOMAIN_ALIASES[from] ?? canonicalDomainId(value);
}

/**
 * Resolve a deprecated domain id (e.g. `meta`) to its current id (`custom`).
 * Any other value is returned exactly as given. `onDeprecated` fires when an
 * alias was used (the CLI prints a deprecation note).
 */
export function canonicalDomainId(value: string, onDeprecated?: (from: string, to: string) => void): string {
  const from = String(value ?? '').toLowerCase().trim();
  const to = DEPRECATED_DOMAIN_ALIASES[from];
  if (!to) return resolveMediumName(value);
  onDeprecated?.(from, to);
  return to;
}

/**
 * Map an arbitrary domain label to a canonical Domain: validate membership and
 * resolve known synonyms, returning Domain.UNKNOWN for anything unrecognized instead
 * of lying via `as Domain`. Use this in place of unchecked `someString as Domain` casts.
 */
export function normalizeDomain(value: string | undefined | null): Domain {
  if (!value) return Domain.UNKNOWN;
  const lower = value.toLowerCase().trim();
  if (lower in DOMAIN_SYNONYMS) return DOMAIN_SYNONYMS[lower];
  const named = resolveMediumName(lower);
  if (named !== lower) return isValidDomain(named) ? (named as Domain) : Domain.UNKNOWN;
  return isValidDomain(lower) ? (lower as Domain) : Domain.UNKNOWN;
}

/**
 * Get default domain for fallback scenarios
 */
export function getDefaultDomain(): Domain {
  return Domain.UNKNOWN;
}

/**
 * Domains that require HTML wrapper
 */
export const WRAPPED_DOMAINS = [Domain.P5, Domain.THREE, Domain.TONE, Domain.HYDRA];

/**
 * Domains that are shader-based
 */
export const SHADER_DOMAINS = [Domain.GLSL, Domain.SHADER, Domain.WEBGL];

/**
 * Domains for music generation
 */
export const MUSIC_DOMAINS = [Domain.TONE, Domain.STRUDEL, Domain.HYDRA];

/**
 * Domains for video composition
 */
/** No video domains remain: revideo and hyperframes are KinoCut export engines, not art domains. */
export const VIDEO_DOMAINS: Domain[] = [];
