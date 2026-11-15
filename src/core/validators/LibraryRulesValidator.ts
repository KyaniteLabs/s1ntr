/**
 * LibraryRulesValidator — per-library legality checks for vendored-library
 * pieces (docs/medium-lab/ specs, #1000 integration phase).
 *
 * Cross-domain: any executable-JS domain can pull a vendored library, so
 * these rules key on what the SOURCE actually references (globals, imports,
 * vendored script tags) rather than on declared intent or domain. Source
 * detection also catches undeclared use and needs no new state threaded
 * through the validation call path (LAW 33).
 *
 * Detection runs on comment-stripped code with string literals KEPT: usage
 * evidence (import specifiers, script src tags, interpolator space args)
 * lives inside strings, so stripping them would blind every rule. Comments
 * alone are the false-positive surface ("// use culori" prose) and are
 * stripped.
 *
 * Rules (from the medium-lab specs):
 *  - culori: build ramps in OKLCH, never hex lerp. A piece that imports a
 *    perceptual color library but then interpolates through hex/sRGB space
 *    defeats the library — catch the known hand-rolled shapes.
 *  - rapier2d: deterministic stepping. A dynamic `world.timestep` (fed by
 *    frame deltas/clocks) breaks replay determinism — the whole reason the
 *    library exists. Fixed timestep + accumulator is the legal pattern.
 *  - physics budget: unrolled body-creation statements burn the render and
 *    judge budget. Static call-site count is a coarse gate for the unrolled
 *    form; loop-spawned runtime counts belong to the render-alive gate.
 */

export interface LibraryRulesResult {
  valid: boolean;
  errors: string[];
}

/** Max static body-creation call sites before the piece is rejected. */
export const MAX_PHYSICS_CREATION_SITES = 128;

// --- library usage detection -------------------------------------------------

// Usage keys on bare identifiers so every access form is caught: the script
// global (`culori.formatHex`), destructuring (`const { oklch } = culori`),
// ESM imports, and vendored script tags. Comments (the prose false-positive
// surface) are stripped before detection; string mentions are kept
// deliberately — import specifiers and script tags live in strings.
const USES_CULORI = /\bculori\b/;
const USES_RAPIER = /\bRAPIER\b|\brapier2d\b|\/vendor\/rapier2d\//;
const USES_MATTER = /\bMatter\b|\bmatter-js\b|\/vendor\/matter-js\//;

// --- culori: no hex lerp -------------------------------------------------------

// Hand-rolled hex interpolation helpers by any common name.
const HEX_LERP_HELPER = /\b(?:lerpHex|hexLerp|mixHex|hexMix|blendHex|hexBlend|lerpColorHex|hexToRgbLerp)\s*\(/;

// p5's lerpColor interpolates in RGB space — legal in plain p5 pieces, but a
// defect in a piece that asked for a perceptual library.
const P5_LERP_COLOR = /\blerpColor\s*\(/;

// Interpolation through a non-perceptual space, in either shape: an explicit
// space argument (interpolate(a, b, 'rgb') / mix(a, b, "hsl")) or the named
// non-perceptual interpolators (interpolateRgb etc.). Perceptual spaces
// (oklch, oklab, lab, lch, p3…) are the legal route.
const NON_PERCEPTUAL_SPACE = /\b(?:interpolate|mix)\s*\([^()]*(?:'|")(rgb|srgb|hsl|hsv|hex)(?:'|")|\binterpolate(?:Rgb|RGB|Srgb|Hsl|HSV|Hsv|Hex)\s*\(/;

// --- rapier: deterministic stepping ---------------------------------------------

// `world.timestep = <anything dynamic>` — frame deltas, clocks, elapsed time.
// Tokens are word-bounded so fixed-step constants held in named variables
// (FIXED_DELTA, fixedDelta) are NOT rejected — only true dynamic feeds.
const DYNAMIC_TIMESTEP = /\.timestep\s*=\s*[^;\n]*(?:\bdt\b|\bdelta\w*\b|\belapsed\w*\b|\b\w*elapsed\w*\b|\b(?:frameDelta|deltaTime|timeDelta|stepDelta|simDelta)\b|performance\.now|Date\.now|\bclock\b|getTime\b)/i;

// --- physics budget --------------------------------------------------------------

const RAPIER_CREATION_SITE = /\bRigidBodyDesc\s*\.\s*(?:dynamic|fixed|kinematicPositionBased|kinematicVelocityBased)\s*\(/g;
const MATTER_CREATION_SITE = /\b(?:Matter\.)?Bodies\s*\.\s*\w+\s*\(|\b(?:Matter\.)?Body\s*\.\s*create\s*\(/g;

export class LibraryRulesValidator {
  /** Library ids the source actually references (culori / rapier2d / matter-js). */
  static detectLibraries(code: string): string[] {
    const surface = stripComments(code);
    const found: string[] = [];
    if (USES_CULORI.test(surface)) found.push('culori');
    if (USES_RAPIER.test(surface)) found.push('rapier2d');
    if (USES_MATTER.test(surface)) found.push('matter-js');
    return found;
  }

  static validate(code: string): LibraryRulesResult {
    const errors: string[] = [];
    const surface = stripComments(code);

    if (USES_CULORI.test(surface)) {
      errors.push(...LibraryRulesValidator.validateCulori(surface));
    }
    if (USES_RAPIER.test(surface)) {
      errors.push(...LibraryRulesValidator.validateRapier(surface));
      errors.push(...LibraryRulesValidator.validatePhysicsBudget(surface, [RAPIER_CREATION_SITE], 'rapier2d'));
    }
    if (USES_MATTER.test(surface)) {
      errors.push(...LibraryRulesValidator.validatePhysicsBudget(surface, [MATTER_CREATION_SITE], 'matter-js'));
    }

    return { valid: errors.length === 0, errors };
  }

  /** culori pieces must interpolate through perceptual space, never hex. */
  private static validateCulori(surface: string): string[] {
    const errors: string[] = [];
    if (HEX_LERP_HELPER.test(surface)) {
      errors.push('Library rule (culori): hand-rolled hex lerp detected — build ramps in OKLCH, never hex lerp (use culori.interpolate(oklch(a), oklch(b)) or mix(a, b, "oklch"))');
    }
    if (P5_LERP_COLOR.test(surface)) {
      errors.push('Library rule (culori): p5 lerpColor interpolates in RGB space — use culori perceptual interpolation (oklch) for color ramps instead');
    }
    if (NON_PERCEPTUAL_SPACE.test(surface)) {
      errors.push('Library rule (culori): interpolation through a non-perceptual space (rgb/srgb/hsl/hsv/hex) — route ramps through oklch/oklab/lab/lch');
    }
    return errors;
  }

  /** rapier pieces must step with a fixed timestep for deterministic replays. */
  private static validateRapier(surface: string): string[] {
    if (DYNAMIC_TIMESTEP.test(surface)) {
      return ['Library rule (rapier2d): dynamic world.timestep breaks deterministic replays — use a fixed timestep (e.g. world.timestep = 1/60) and decouple frame rate with an accumulator'];
    }
    return [];
  }

  /** Coarse static budget on body-creation call sites (the unrolled form). */
  private static validatePhysicsBudget(
    surface: string,
    sitePatterns: RegExp[],
    engine: string,
  ): string[] {
    let sites = 0;
    for (const pattern of sitePatterns) {
      const re = new RegExp(pattern.source, pattern.flags);
      sites += (surface.match(re) || []).length;
    }
    if (sites > MAX_PHYSICS_CREATION_SITES) {
      return [`Library rule (${engine}): ${sites} body-creation call sites exceed the physics budget of ${MAX_PHYSICS_CREATION_SITES} — spawn bodies in a bounded loop instead of unrolled statements`];
    }
    return [];
  }
}

/**
 * Blank comments (block, line, HTML) so prose that merely mentions an API
 * cannot trip the rules. STRING-AWARE: string literals are kept intact AND
 * a `//` inside a string (https:// URLs) no longer blanks the rest of the
 * line — the v1 regex stripper ate real code after URLs (GLM #1068 note).
 * Walks the source once tracking string state; comments outside strings
 * are blanked in place.
 */
function stripComments(code: string): string {
  const out: string[] = [];
  let i = 0;
  const n = code.length;
  while (i < n) {
    const ch = code[i];
    if (ch === '\'' || ch === '"' || ch === '`') {
      const quote = ch;
      out.push(ch);
      i++;
      while (i < n) {
        if (code[i] === '\\' && i + 1 < n) { out.push(code[i], code[i + 1]); i += 2; continue; }
        out.push(code[i]);
        if (code[i] === quote) { i++; break; }
        i++;
      }
      continue;
    }
    if (ch === '/' && code[i + 1] === '/') {
      while (i < n && code[i] !== '\n') { out.push(' '); i++; }
      continue;
    }
    if (ch === '/' && code[i + 1] === '*') {
      out.push(' ', ' ');
      i += 2;
      while (i < n && !(code[i] === '*' && code[i + 1] === '/')) { out.push(code[i] === '\n' ? '\n' : ' '); i++; }
      if (i < n) { out.push(' ', ' '); i += 2; }
      continue;
    }
    if (ch === '<' && code.startsWith('<!--', i)) {
      const end = code.indexOf('-->', i + 4);
      const stop = end === -1 ? n : end + 3;
      while (i < stop) { out.push(code[i] === '\n' ? '\n' : ' '); i++; }
      continue;
    }
    out.push(ch);
    i++;
  }
  return out.join('');
}
