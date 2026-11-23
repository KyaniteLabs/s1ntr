/**
 * LibraryIntent — the model→wrapper library connector (#1000 integration).
 *
 * The MODEL decides which vendored capability libraries a piece wants, at
 * plan-time, from capability knowledge (the LibraryCards in
 * creative-vocabulary) — never by default. This module is the typed pipe:
 * it reads the model's declared intent from the generation response,
 * validates it against the vendored index (unknown ids fail LOUD here,
 * before wrap, not as a dead render), enforces the ≤3-per-piece budget,
 * and hands a clean `libraries: string[]` to the wrapper + the provenance
 * era-stamp.
 *
 * Composite-native (#1000 CEO layering correction): the model may declare
 * per-LAYER intents — `layers: [{ domain, libraries[] }]` — and the final
 * piece-level library set is the deduplicated union (the budget applies to
 * the union; the wrapper injects once, every layer sees every library).
 *
 * Intent format the model emits (in its response, after the code block):
 *   libraries: culori, roughjs, thing
 * or for composite pieces:
 *   layers: p5[culori,roughjs] strudel[tonaljs]
 * Both are parsed; unknown ids throw with the known-id list.
 */

import { assertVendoredLibraries, VENDORED_LIBRARIES } from '../core/wrappers/VendoredLibraries.js';
import { fencedBlocks } from '../llm/ModelOutput.js';
import { inferLibrariesFromCode } from '../core/validators/ImportSpecifiers.js';

/** Hard budget: a piece may request at most this many distinct libraries. */
export const MAX_LIBRARIES_PER_PIECE = 3;

export interface ParsedLibraryIntent {
  /** The piece-level library set (deduplicated union across layers). */
  readonly libraries: string[];
  /** Per-layer intents when the model declared layers; empty for singles. */
  readonly layers: ReadonlyArray<{ domain: string; libraries: string[] }>;
  /** Declared ids that are not in the vendored index (a small model names the CDN
   *  libraries its code loads, or invents an id). They are dropped, not fatal. */
  readonly ignored?: string[];
}

// Declarations live in a TRAILING block only — the model emits its intent
// after the code (the cards instruct this form). Mid-response prose and
// code comments mentioning "libraries:" are never parsed as intent.
const TRAILING_CHARS = 200;
/** Kits that ship inside the wrapper itself (no vendored file to load); declaring one is harmless. */
const BUILTIN_KIT_IDS: ReadonlySet<string> = new Set(['sinter-glsl']);
const BARE_RE = /^\s*libraries?\s*:\s*([a-z0-9-]+(?:\s*[,;]\s*[a-z0-9-]+)*)\s*$/im;
const LAYERS_RE = /^\s*layers?\s*:\s*(.+)$/im;
const LAYER_SPEC_RE = /([a-z0-9]+)\[([^\]]*)\]/gi;

function trailingBlock(text: string): string {
  // A response that ends inside a code fence has no declaration zone.
  if (fencedBlocks(text).at(-1)?.closed === false) return '';
  return text.slice(-TRAILING_CHARS);
}

/**
 * Parse the model's declared library intent from its raw response text.
 * Returns { libraries: [], layers: [] } when no intent was declared —
 * a piece with no libraries is valid, just not library-bearing.
 * Throws on unknown ids and budget violations (fail-loud, pre-wrap).
 */
export function parseLibraryIntent(responseText: string): ParsedLibraryIntent {
  const libraries = new Set<string>();
  const layers: Array<{ domain: string; libraries: string[] }> = [];
  const zone = trailingBlock(responseText);
  if (!zone) return { libraries: [], layers: [] };

  // GLM round-1 follow-up: a declaration-SHAPED prefix visible in the tail
  // but unparseable (e.g., clipped by the 200-char window on a 3-id list)
  // degrades silently to empty — emit a one-line warn so the miss is
  // diagnosable in logs rather than invisible.
  if (zone && /libraries?\s*:/i.test(zone) && !BARE_RE.test(zone) && !LAYERS_RE.test(zone)) {
    // visible "libraries:" but the full pattern didn't match — likely clipped
    // eslint-disable-next-line no-console -- intentional diagnosable-miss warning
    console.warn('[LibraryIntent] declaration-shaped text visible in tail but unparseable (possible 200-char clip):', zone.slice(-80));
  }

  const bare = BARE_RE.exec(zone);
  if (bare) {
    for (const id of bare[1].split(/[,;]\s*/)) {
      const trimmed = id.trim().toLowerCase();
      // "libraries: none" is how a model says it wants no library; it is not an id.
      if (trimmed && trimmed !== 'none' && !BUILTIN_KIT_IDS.has(trimmed)) libraries.add(trimmed);
    }
  }

  const layered = LAYERS_RE.exec(zone);
  if (layered) {
    for (const m of layered[1].matchAll(LAYER_SPEC_RE)) {
      const domain = m[1].toLowerCase();
      const layerLibs = m[2].split(/[,;]\s*/).map((s: string) => s.trim().toLowerCase()).filter((s: string) => s !== '' && s !== 'none');
      layers.push({ domain, libraries: layerLibs });
      for (const id of layerLibs) if (!BUILTIN_KIT_IDS.has(id)) libraries.add(id);
    }
  }

  // A declared id outside the vendored index used to throw here. That throw sat after
  // the repair loop, so one stray id (`libraries: d3`) cost the whole Create: 66 of the
  // 720 v2r1 runs (d3, strudel, three, gsap, p5, osc, canvas, bpy). The browser asset
  // fallbacks already serve the CDN libraries; ids that are not real are harmless to
  // drop. Typos of real ids are still recovered from the code's imports by
  // resolveLibraryIntent, and unknown imports stay the validator's job.
  const ignored = [...libraries].filter((id) => !Object.hasOwn(VENDORED_LIBRARIES, id));
  for (const id of ignored) libraries.delete(id);
  if (ignored.length > 0) {
    // eslint-disable-next-line no-console -- intentional diagnosable-drop warning
    console.warn(`[LibraryIntent] ignored declared libraries not in the vendored index: ${ignored.join(', ')}`);
  }
  const list = [...libraries];
  assertVendoredLibraries(list);
  if (list.length > MAX_LIBRARIES_PER_PIECE) {
    throw new Error(
      `Library budget exceeded: ${list.length} requested (${list.join(', ')}), max ${MAX_LIBRARIES_PER_PIECE} per piece. ` +
      'Trim to the libraries this piece genuinely needs.',
    );
  }
  return { libraries: list, layers: layers.map((l) => ({ ...l, libraries: l.libraries.filter((id) => Object.hasOwn(VENDORED_LIBRARIES, id)) })), ...(ignored.length > 0 ? { ignored } : {}) };
}

/**
 * The piece's library set: the model's declaration UNIONED with every library
 * its code imports (static, dynamic, import map). A model that imports
 * "holospot" but forgets the trailing `libraries:` line used to get the
 * default wrapper and a blank page; the code is the stronger signal.
 * Declared ids come first, the ≤3 budget applies to the union, and unknown
 * bare specifiers are the validator's job (LibraryRulesValidator) — they
 * never reach here from an accepted piece.
 */
export function resolveLibraryIntent(responseText: string, code: string): ParsedLibraryIntent {
  const declared = parseLibraryIntent(responseText);
  const libraries = [...declared.libraries];
  for (const id of inferLibrariesFromCode(code).libraries) {
    if (!libraries.includes(id)) libraries.push(id);
  }
  if (libraries.length > MAX_LIBRARIES_PER_PIECE) {
    throw new Error(
      `Library budget exceeded: ${libraries.length} requested (${libraries.join(', ')}), max ${MAX_LIBRARIES_PER_PIECE} per piece. ` +
      'Trim to the libraries this piece genuinely needs.',
    );
  }
  return { libraries, layers: declared.layers, ...(declared.ignored ? { ignored: declared.ignored } : {}) };
}

/**
 * Era-stamp payload for the provenance row: the full capability vector the
 * PM's trend emitter carries (domains[] is his field; libraries[] is ours —
 * bare ids, same vocabulary as the LibraryCards).
 */
export function eraStampPayload(intent: ParsedLibraryIntent, primaryDomain: string): {
  domains: string[];
  libraries: string[];
} {
  const domains = [primaryDomain];
  for (const layer of intent.layers) {
    if (layer.domain !== primaryDomain && !domains.includes(layer.domain)) domains.push(layer.domain);
  }
  return { domains, libraries: intent.libraries };
}
