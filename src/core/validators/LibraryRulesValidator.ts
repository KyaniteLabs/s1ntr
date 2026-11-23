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
 *  - holospot: the kit draws the frame (its own AGENTS.md law). A piece that
 *    imports the kit but never applies a foil renders plain three.js; a
 *    piece that also calls renderer.render composites over a half-drawn
 *    frame. Faked foil (MeshPhysicalMaterial iridescence) is a warning —
 *    it may decorate non-holo meshes, but it cannot reproduce the look.
 */

import { stripComments } from './stripComments.js';
import { inferLibrariesFromCode } from './ImportSpecifiers.js';
import { VENDORED_LIBRARIES } from '../wrappers/VendoredLibraries.js';

export interface LibraryRulesResult {
  valid: boolean;
  errors: string[];
  /** Non-blocking advisories (severity below a rejection); today only the
   * holospot iridescence heuristic populates this. */
  warnings: readonly string[];
}

/** Max static body-creation call sites before the piece is rejected. */
export const MAX_PHYSICS_CREATION_SITES = 128;

// --- named imports must exist in the vendored library ----------------------------

/**
 * Real named exports of vendored libraries a model may import by name. Only
 * libraries listed here are checked. Guarded by a drift test against the
 * vendored dist's export clause (v7: all three pieces imported an invented
 * `studio` from "holospot" and died at module load).
 */
export const VENDORED_LIBRARY_EXPORTS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  holospot: [
    'ENGINE_COMMIT', 'Holo', 'HoloObject', 'LOOK_IDS', 'MATERIAL_IDS', 'MATERIAL_PARAMS',
    'SCENE_PARAMS', 'STUDIO_PRESETS', 'VERSION', 'lookInfo', 'resolveSettings', 'shotCamera', 'shotRotation',
  ],
});

const EXPORT_HINTS: Readonly<Record<string, string>> = Object.freeze({
  holospot: 'light with holo.setScene({"studio.preset": "studio"}) — there is no `studio` export',
});

/** Domains whose source never runs in a wrapped browser page. */
const NON_PAGE_DOMAINS: ReadonlySet<string> = new Set(['revideo', 'blender']);

// --- holospot option names (holo.d.ts ApplyOptions / CardOptions, v0.1.0) -------------

/** Options holo.apply(target, options) reads. */
export const HOLOSPOT_APPLY_OPTIONS: readonly string[] = Object.freeze([
  'material', 'sizeMm', 'settings', 'look', 'mapping', 'doubleSided', 'structureScale', 'scene',
]);
/** Options holo.card(options) reads. `sizeMm` is NOT one: a card takes widthMm/heightMm/size. */
export const HOLOSPOT_CARD_OPTIONS: readonly string[] = Object.freeze([
  'material', 'widthMm', 'heightMm', 'size', 'settings', 'look', 'scene',
]);

const HOLO_OPTION_HINTS: Readonly<Record<string, Readonly<Record<string, string>>>> = Object.freeze({
  card: {
    sizeMm: 'holo.card ignores it (that leaves a sub-pixel mesh); use widthMm/heightMm in mm (default 63 x 88) or size for the longer side in scene units',
  },
  apply: {
    size: 'holo.apply sizes by sizeMm, the real size of the largest side in mm',
    widthMm: 'widthMm/heightMm belong to holo.card; holo.apply takes sizeMm',
    heightMm: 'widthMm/heightMm belong to holo.card; holo.apply takes sizeMm',
  },
});

// import { a, b as c } from "lib" — braces may span lines; default/namespace
// forms import no named exports and are not matched.
const NAMED_IMPORT = /\bimport\s+(?:[\w$]+\s*,\s*)?\{([^}]*)\}\s*from\s*(['"])([^'"]+)\2/g;

// --- library usage detection -------------------------------------------------

// Usage keys on bare identifiers so every access form is caught: the script
// global (`culori.formatHex`), destructuring (`const { oklch } = culori`),
// ESM imports, and vendored script tags. Comments (the prose false-positive
// surface) are stripped before detection; string mentions are kept
// deliberately — import specifiers and script tags live in strings.
const USES_CULORI = /\bculori\b/;
const USES_RAPIER = /\bRAPIER\b|\brapier2d\b|\/vendor\/rapier2d\//;
const USES_MATTER = /\bMatter\b|\bmatter-js\b|\/vendor\/matter-js\//;
const USES_HOLOSPOT = /\bholospot\b|\/vendor\/holospot\//;

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

// --- holospot: the kit draws the frame ------------------------------------------

// Instance names the piece assigns (`const holo = new Holo(renderer)`,
// `this.holo = new Holo(...)`). Calls key on the real variable name so a
// renamed instance is still followed; the canonical `holo` is always a
// candidate because every kit recipe uses it.
const HOLO_INSTANCE = /\b([A-Za-z_$][\w$]*)\s*=\s*new\s+Holo\s*\(/g;
const CANONICAL_HOLO_NAME = 'holo';

// Renderer names for the render-conflict rule; `renderer` is the fallback
// every recipe and generated piece uses when the ctor is out of the regex's
// reach (global THREE, helper-constructed, …).
const WEBGL_RENDERER_INSTANCE = /\b([A-Za-z_$][\w$]*)\s*=\s*new\s+(?:[\w$]+\s*\.\s*)?WebGLRenderer\s*\(/g;
const CANONICAL_RENDERER_NAME = 'renderer';

// MeshPhysicalMaterial's iridescence block, ctor option or property form.
const IRIDESCENCE_SETTING = /\biridescence\w*\s*[:=]/i;

/** Every captured group-1 of `pattern` found in `surface`. */
function collectNames(pattern: RegExp, surface: string): string[] {
  const names: string[] = [];
  const re = new RegExp(pattern.source, pattern.flags);
  for (const match of surface.matchAll(re)) names.push(match[1]);
  return names;
}

export class LibraryRulesValidator {
  /** Library ids the source actually references (culori / rapier2d / matter-js / holospot). */
  static detectLibraries(code: string): string[] {
    const surface = stripComments(code);
    const found: string[] = [];
    if (USES_CULORI.test(surface)) found.push('culori');
    if (USES_RAPIER.test(surface)) found.push('rapier2d');
    if (USES_MATTER.test(surface)) found.push('matter-js');
    if (USES_HOLOSPOT.test(surface)) found.push('holospot');
    return found;
  }

  /**
   * @param domain when given, domains whose source is not a browser page
   * (revideo scenes, blender scripts) skip the import-specifier rule: their
   * imports resolve in their own runtime, not the wrapped page's import map.
   */
  static validate(code: string, domain?: string): LibraryRulesResult {
    const errors: string[] = [];
    const warnings: string[] = [];
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
    if (USES_HOLOSPOT.test(surface)) {
      const holo = LibraryRulesValidator.validateHolospot(surface);
      errors.push(...holo.errors);
      warnings.push(...holo.warnings);
      errors.push(...LibraryRulesValidator.validateHolospotOptions(surface));
    }

    errors.push(...LibraryRulesValidator.validateNamedImports(surface));
    if (!domain || !NON_PAGE_DOMAINS.has(domain)) errors.push(...LibraryRulesValidator.validateImportSpecifiers(code));

    return { valid: errors.length === 0, errors, warnings };
  }

  /** A named import the vendored library does not export throws at module load. */
  private static validateNamedImports(surface: string): string[] {
    const errors: string[] = [];
    for (const match of surface.matchAll(NAMED_IMPORT)) {
      const lib = match[3];
      const real = VENDORED_LIBRARY_EXPORTS[lib];
      if (!real) continue;
      const bad = match[1].split(',')
        .map(part => part.trim().split(/\s+as\s+/)[0].trim())
        .filter(name => name.length > 0 && !real.includes(name));
      for (const name of bad) {
        errors.push(`Library rule (${lib}): \`${name}\` is not exported by "${lib}" — the page throws at module load. Real exports: ${real.join(', ')}. ${EXPORT_HINTS[lib] ?? ''}`.trim());
      }
    }
    return errors;
  }


  /**
   * A bare specifier with no library card cannot resolve in the wrapped page
   * ("Failed to resolve module specifier"), which ships a blank render. Fail
   * validation by name so the repair turn can drop or replace the import.
   */
  private static validateImportSpecifiers(code: string): string[] {
    const importable = Object.keys(VENDORED_LIBRARIES).join(', ');
    return inferLibrariesFromCode(code).unknown.map(spec =>
      `Library rule (imports): "${spec}" is not importable — no vendored library provides that specifier, so the page fails to resolve it and renders blank. Importable libraries: ${importable}; "three" is always available. Remove the import or use one of these.`);
  }

  /**
   * Option names on holo.apply / holo.card must be the kit's own. An unknown
   * key is silently ignored by the kit (sizeMm on holo.card left a sub-pixel
   * mesh), so it is rejected here with the accepted names.
   */
  private static validateHolospotOptions(surface: string): string[] {
    const holoNames = new Set(collectNames(HOLO_INSTANCE, surface));
    holoNames.add(CANONICAL_HOLO_NAME);
    const errors: string[] = [];
    const specs: ReadonlyArray<{ method: 'apply' | 'card'; arg: number; allowed: readonly string[] }> = [
      { method: 'apply', arg: 1, allowed: HOLOSPOT_APPLY_OPTIONS },
      { method: 'card', arg: 0, allowed: HOLOSPOT_CARD_OPTIONS },
    ];
    for (const name of holoNames) {
      for (const { method, arg, allowed } of specs) {
        const call = new RegExp(`\\b${name}\\s*\\.\\s*${method}\\s*\\(`, 'g');
        for (const m of surface.matchAll(call)) {
          const keys = objectLiteralKeys(surface, m.index + m[0].length, arg);
          for (const key of keys) {
            if (allowed.includes(key)) continue;
            const hint = HOLO_OPTION_HINTS[method][key];
            errors.push(`Library rule (holospot): \`${key}\` is not an option of holo.${method}(...)${hint ? ` — ${hint}` : ''}. holo.${method} options: ${allowed.join(', ')}.`);
          }
        }
      }
    }
    return [...new Set(errors)];
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

  /**
   * holospot pieces must let the kit draw the frame: a foil exists only where
   * holo.apply/holo.card put it, and holo.render replaces renderer.render.
   * Iridescence is a warning, not a rejection — it cannot reproduce the foil,
   * but it may legitimately decorate non-holo meshes in the same piece.
   */
  private static validateHolospot(surface: string): { errors: string[]; warnings: string[] } {
    const errors: string[] = [];
    const warnings: string[] = [];

    const holoNames = new Set(collectNames(HOLO_INSTANCE, surface));
    holoNames.add(CANONICAL_HOLO_NAME);
    const calls = (name: string, method: string): boolean =>
      new RegExp(`\\b${name}\\s*\\.\\s*${method}\\s*\\(`).test(surface);

    const appliesFoil = [...holoNames].some(n => calls(n, 'apply') || calls(n, 'card'));
    if (!appliesFoil) {
      errors.push('Library rule (holospot): the kit is imported but holo.apply(...) / holo.card(...) is never called — no object gets a foil; apply to the hero mesh, e.g. holo.apply(mesh, { material: "nebula", sizeMm: 120 })');
    }

    // The kit frames its own shot: a hand-placed camera crops or loses the hero
    // (v8: 3 of 4 pieces off-centre or cropped; the one with shotCamera framed).
    const shotNames = ['shotCamera', ...[...surface.matchAll(/\bshotCamera\s+as\s+([A-Za-z_$][\w$]*)/g)].map(m => m[1])];
    const framesWithKit =
      /\.\s*shotCamera\s*\(/.test(surface) ||
      shotNames.some(n => new RegExp(`(?<![\\w$.])${n.replace(/\$/g, '\\$')}\\s*\\(`).test(surface));
    const FRAME_RECIPE = 'const obj = holo.apply(heroMesh, {...}); await obj.ready; shotCamera(camera, obj, { aspect: innerWidth / innerHeight })';
    const CARD_RECIPE = 'const cardMesh = holo.card({...}); scene.add(cardMesh); const obj = holo.get(cardMesh); await obj.ready; shotCamera(camera, obj, { aspect: innerWidth / innerHeight })';
    if (appliesFoil && !framesWithKit) {
      errors.push(`Library rule (holospot): the hero is framed by hand — import { shotCamera } from "holospot" and frame with the kit (and again on resize): ${FRAME_RECIPE}`);
    }
    // shotCamera reads the holo object's prepared geometry: given the bare mesh,
    // or called before obj.ready resolves, it throws "needs the object to be
    // ready" (v10: 4 of 4 pieces threw; the one that caught it framed by hand).
    if (appliesFoil && framesWithKit) {
      const holoAlt = [...holoNames].map(n => n.replace(/\$/g, '\\$')).join('|');
      const holoObjects = new Set([...surface.matchAll(
        new RegExp(`(?:\\b(?:const|let|var)\\s+)?([A-Za-z_$][\\w$]*)\\s*=\\s*(?:await\\s+)?(?:${holoAlt})\\s*\\.\\s*(?:apply|get)\\s*\\(`, 'g'),
      )].map(m => m[1]));
      const callee = `(?:\\.\\s*shotCamera|(?<![\\w$.])(?:${shotNames.map(n => n.replace(/\$/g, '\\$')).join('|')}))`;
      const framed = [...surface.matchAll(new RegExp(`${callee}\\s*\\(\\s*[^,()]+,\\s*([A-Za-z_$][\\w$.]*)`, 'g'))].map(m => m[1]);
      const ready = (n: string): boolean =>
        new RegExp(`(?:await\\s+${n.replace(/\$/g, '\\$')}\\s*\\.\\s*ready\\b|\\b${n.replace(/\$/g, '\\$')}\\s*\\.\\s*ready\\s*\\.\\s*then\\s*\\()`).test(surface);
      // holo.card returns the card MESH (no .ready: `await card.ready` is a
      // no-op and shotCamera throws). v11: the foil card rendered black.
      const cardMeshes = new Set([...surface.matchAll(
        new RegExp(`(?:\\b(?:const|let|var)\\s+)?([A-Za-z_$][\\w$]*)\\s*=\\s*(?:${holoAlt})\\s*\\.\\s*card\\s*\\(`, 'g'),
      )].map(m => m[1]));
      const bad = framed.filter(n => !holoObjects.has(n) || !ready(n));
      if (bad.length > 0) {
        const fix = cardMeshes.has(bad[0]) ? CARD_RECIPE : FRAME_RECIPE;
        errors.push(`Library rule (holospot): shotCamera(camera, ${bad[0]}) frames before the kit is ready — pass the object holo.apply/holo.get returns (holo.card returns the mesh) after awaiting its ready promise: ${fix}`);
      }
    }

    const rendererNames = new Set(collectNames(WEBGL_RENDERER_INSTANCE, surface));
    rendererNames.add(CANONICAL_RENDERER_NAME);
    const holoRenders = [...holoNames].some(n => calls(n, 'render'));
    const rendererRenders = [...rendererNames].some(n => calls(n, 'render'));
    if (holoRenders && rendererRenders) {
      errors.push('Library rule (holospot): holo.render(scene, camera) and renderer.render(...) are both called — holo.render replaces renderer.render for the frame; drop the renderer.render call');
    }

    if (IRIDESCENCE_SETTING.test(surface)) {
      warnings.push('Library rule (holospot): MeshPhysicalMaterial iridescence cannot reproduce a holographic foil — use holo.apply/holo.card materials for holo objects');
    }

    return { errors, warnings };
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
 * Top-level keys of the object literal that is argument `argIndex` of the call
 * whose "(" ends just before `start`. Returns [] when that argument is not an
 * inline object literal (a variable, a call, absent) — nothing to check.
 * Spread entries and computed keys are skipped; nested objects are not entered.
 */
function objectLiteralKeys(surface: string, start: number, argIndex: number): string[] {
  let i = start;
  let arg = 0;
  let depth = 0;
  // Walk to the target argument at call depth 0.
  while (i < surface.length && arg < argIndex) {
    const ch = surface[i];
    if (ch === '\'' || ch === '"' || ch === '`') { i = skipString(surface, i); continue; }
    if (ch === '(' || ch === '[' || ch === '{') depth++;
    else if (ch === ')' || ch === ']' || ch === '}') { if (depth === 0) return []; depth--; }
    else if (ch === ',' && depth === 0) arg++;
    i++;
  }
  while (i < surface.length && /\s/.test(surface[i])) i++;
  if (surface[i] !== '{') return [];
  i++;
  const keys: string[] = [];
  let entry = '';
  depth = 0;
  const flush = () => {
    const text = entry.trim();
    entry = '';
    if (!text || text.startsWith('...')) return;
    const k = /^(?:(['"])([^'"]+)\1|([A-Za-z_$][\w$]*))\s*(?::|\(|$)/.exec(text);
    if (k) keys.push(k[2] ?? k[3]);
  };
  while (i < surface.length) {
    const ch = surface[i];
    if (ch === '\'' || ch === '"' || ch === '`') {
      const end = skipString(surface, i);
      entry += surface.slice(i, end);
      i = end;
      continue;
    }
    if (ch === '(' || ch === '[' || ch === '{') depth++;
    else if (ch === ')' || ch === ']' || ch === '}') {
      if (depth === 0) { flush(); break; }
      depth--;
    } else if (ch === ',' && depth === 0) { flush(); i++; continue; }
    // Only the head of an entry (up to its value) matters for the key; skip
    // value text beyond depth 0 to keep entries small.
    entry += ch;
    i++;
  }
  return keys;
}

function skipString(src: string, start: number): number {
  const quote = src[start];
  let i = start + 1;
  while (i < src.length) {
    if (src[i] === '\\') { i += 2; continue; }
    if (src[i] === quote) return i + 1;
    i++;
  }
  return src.length;
}
