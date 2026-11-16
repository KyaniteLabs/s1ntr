/**
 * Reduce a known local CLI seat URL to its bare seat: drop the OpenAI-compatible
 * path and a per-seat effort segment (cli://codex/xhigh, cli://claude/high).
 * The effort is read by the provider, not by admission.
 */
export function canonicalCliSeatUrl(baseUrl: string): string {
  return baseUrl.replace(
    /^(cli:\/\/(?:codex|agy|command-code|claude))(?:\/(?:low|medium|high|xhigh|max))?(?:\/chat\/completions)?$/, '$1');
}

/** Owner rule (2026-11-10): seats run between medium and xhigh reasoning. */
export const HERMES_REASONING_LEVELS = ['medium', 'high', 'xhigh'] as const;

export interface HermesSeat {
  provider: string;
  reasoning: (typeof HERMES_REASONING_LEVELS)[number];
}

/** Parse cli://hermes/<provider>/<reasoning>[/chat/completions]; null if malformed. */
export function parseHermesSeat(baseUrl: string): HermesSeat | null {
  const m = /^cli:\/\/hermes\/([a-z0-9-]+)\/([a-z]+)(?:\/chat\/completions)?\/?$/.exec(baseUrl);
  if (!m) return null;
  const reasoning = m[2] as HermesSeat['reasoning'];
  if (!HERMES_REASONING_LEVELS.includes(reasoning)) return null;
  return { provider: m[1], reasoning };
}
