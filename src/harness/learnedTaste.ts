import { harnessMemory } from './HarnessMemory.js';

/**
 * The artist's learned taste tags from past Studio sessions.
 *
 * StudioReflection distills a kept/revised session into `session-taste`
 * feedback episodes tagged with what the user favored (e.g. "restraint",
 * "calm slow motion", "dim highlights"). This reads those tags so the next
 * generation can lean toward them — closing the taste loop at the point of
 * generation. Single source of truth for both the GuidanceEngine suggestion
 * and the creative prompt's taste line.
 *
 * Reads the in-memory `harnessMemory` singleton (microseconds, no I/O) and
 * never throws — a memory read failure degrades to "no learned taste".
 */
export function getLearnedTasteLikes(limit = 5): string[] {
  try {
    const tasteEpisodes = harnessMemory
      .getRecentEpisodes(50)
      .filter(ep => ep.type === 'feedback' && (ep.tags?.includes('session-taste') ?? false));
    if (tasteEpisodes.length === 0) return [];
    return [
      ...new Set(
        tasteEpisodes.flatMap(ep =>
          (ep.tags ?? []).filter(tag => tag !== 'session-taste' && tag !== 'studio-reflection'),
        ),
      ),
    ].slice(0, Math.max(0, limit));
  } catch {
    return [];
  }
}

/** A single prompt line biasing generation toward learned taste, or '' if none. */
export function buildLearnedTasteLine(limit = 5): string {
  const likes = getLearnedTasteLikes(limit);
  if (likes.length === 0) return '';
  return `Lean toward the artist's learned taste from past sessions: ${likes.join(', ')}.`;
}
