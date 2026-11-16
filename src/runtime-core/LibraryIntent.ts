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

import { assertVendoredLibraries } from '../core/wrappers/VendoredLibraries.js';
import { fencedBlocks } from '../llm/ModelOutput.js';

/** Hard budget: a piece may request at most this many distinct libraries. */
export const MAX_LIBRARIES_PER_PIECE = 3;

export interface ParsedLibraryIntent {
  /** The piece-level library set (deduplicated union across layers). */
  readonly libraries: string[];
  /** Per-layer intents when the model declared layers; empty for singles. */
  readonly layers: ReadonlyArray<{ domain: string; libraries: string[] }>;
}

// Declarations live in a TRAILING block only — the model emits its intent
// after the code (the cards instruct this form). Mid-response prose and
// code comments mentioning "libraries:" are never parsed as intent.
const TRAILING_CHARS = 200;
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
      if (trimmed && trimmed !== 'none') libraries.add(trimmed);
    }
  }

  const layered = LAYERS_RE.exec(zone);
  if (layered) {
    for (const m of layered[1].matchAll(LAYER_SPEC_RE)) {
      const domain = m[1].toLowerCase();
      const layerLibs = m[2].split(/[,;]\s*/).map((s: string) => s.trim().toLowerCase()).filter((s: string) => s !== '' && s !== 'none');
      layers.push({ domain, libraries: layerLibs });
      for (const id of layerLibs) libraries.add(id);
    }
  }

  const list = [...libraries];
  assertVendoredLibraries(list);
  if (list.length > MAX_LIBRARIES_PER_PIECE) {
    throw new Error(
      `Library budget exceeded: ${list.length} requested (${list.join(', ')}), max ${MAX_LIBRARIES_PER_PIECE} per piece. ` +
      'Trim to the libraries this piece genuinely needs.',
    );
  }
  return { libraries: list, layers };
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
