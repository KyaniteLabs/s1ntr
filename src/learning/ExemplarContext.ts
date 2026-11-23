import { readFileSync } from 'node:fs';

/**
 * In-context retrieval arm: diverse, domain-matched top exemplars (code + score, owner likes first) from a
 * file built by scripts/learning/build-exemplars.py. It is an experiment arm, not governed knowledge: it only
 * exists when SINTER_EXEMPLARS_FILE is set, and a set-but-broken file throws so an arm can never silently
 * degrade into no teaching.
 */
export const EXEMPLAR_FILE_ENV = 'SINTER_EXEMPLARS_FILE';
const MAX_EXEMPLARS = 3;
const MAX_CODE_CHARS = 3500;

interface Exemplar { readonly domain: string; readonly score: number; readonly liked?: boolean; readonly code: string }

export function exemplarSection(domain: string, env: NodeJS.ProcessEnv = process.env): string {
  const file = env[EXEMPLAR_FILE_ENV];
  if (!file) return '';
  let parsed: { exemplars?: Exemplar[] };
  try { parsed = JSON.parse(readFileSync(file, 'utf8')) as { exemplars?: Exemplar[] }; } catch (error) {
    throw new Error(`EXEMPLARS_FILE_UNREADABLE:${error instanceof Error ? error.message : String(error)}`);
  }
  if (!Array.isArray(parsed.exemplars)) throw new Error('EXEMPLARS_FILE_INVALID');
  const picked = parsed.exemplars.filter(item => item && item.domain === domain
    && typeof item.code === 'string' && Number.isFinite(item.score)).slice(0, MAX_EXEMPLARS);
  if (picked.length === 0) throw new Error(`EXEMPLARS_NONE_FOR_DOMAIN:${domain}`);
  const blocks = picked.map((item, index) => `Reference ${index + 1} (judge score ${item.score.toFixed(2)}${item.liked ? ', liked by the owner' : ''}):\n${item.code.slice(0, MAX_CODE_CHARS)}`);
  return `Reference pieces that scored well for this kind of work. Study their structure, depth and craft; write a new, original piece for the request below and never copy them.\n\n${blocks.join('\n\n')}`;
}
