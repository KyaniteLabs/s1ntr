/**
 * Provider catalog drift check (pnpm check:provider-catalog).
 *
 * Hermes keeps its model picker fresh by reading each provider's live /models
 * listing. Sinter's picker is a hand-written list, so it went months stale
 * (GLM 5.1 as newest while 5.3 shipped). This compares the picker with the live
 * listings for every provider that has a key in the Sinter config and reports:
 *   - newer: served models the picker does not offer
 *   - unlisted: picker models the provider no longer lists (some, like
 *     GLM-5v-turbo, still answer while unlisted, so this is a prompt to probe,
 *     not proof of death)
 * Report-only by default; --strict exits 1 on any drift. Keys are never printed.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { MODEL_CHOICES } from '../../src/tui-bridge/ModelPickerCatalog.js';

/** Live listing endpoints for providers whose keys sit in the Sinter config. */
export const LIVE_LISTINGS: Record<string, string> = {
  glm: 'https://api.z.ai/api/paas/v4/models',
  minimax: 'https://api.minimax.io/v1/models',
};

/**
 * Families the picker deliberately skips: legacy builds, legal/region variants.
 * Only add a pattern with a reason; an empty-reason skip is how lists rot.
 */
export const IGNORED_LIVE_MODELS: RegExp[] = [
  /^glm-4\./,            // pre-5 generation, superseded
  /^glm-5$/,             // bare 5.0, superseded by 5.x point releases
  /-legal$/,             // jurisdiction-specific variant
  /-highspeed$/,         // same model, priority lane; picked via plan, not picker
  /^MiniMax-M2(\.1)?$/,  // superseded by M2.5+
];

export interface CatalogDrift {
  newer: string[];
  unlisted: string[];
}

export function diffCatalog(pickerModels: string[], liveModels: string[]): CatalogDrift {
  const norm = (m: string) => m.toLowerCase();
  const picker = new Set(pickerModels.map(norm));
  const live = new Set(liveModels.map(norm));
  return {
    newer: liveModels
      .filter((m) => !picker.has(norm(m)) && !IGNORED_LIVE_MODELS.some((re) => re.test(m)))
      .sort(),
    unlisted: pickerModels.filter((m) => !live.has(norm(m))).sort(),
  };
}

function configPath(): string {
  return process.env.SINTER_CONFIG_PATH || process.env.LIMINAL_CONFIG_PATH || path.join(os.homedir(), '.sinter', 'config.json');
}

async function listLive(url: string, apiKey: string): Promise<string[]> {
  const res = await fetch(url, { headers: { Authorization: `Bearer ${apiKey}` }, signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = (await res.json()) as { data?: Array<{ id?: string }> };
  return (body.data ?? []).map((m) => m.id).filter((id): id is string => typeof id === 'string');
}

async function main(): Promise<number> {
  const strict = process.argv.includes('--strict');
  let providers: Record<string, { apiKey?: string }> = {};
  try {
    providers = JSON.parse(fs.readFileSync(configPath(), 'utf8')).providers ?? {};
  } catch (e) {
    console.error(`provider-catalog: cannot read config (${(e as Error).message}); nothing checked`);
    return strict ? 1 : 0;
  }
  let drift = 0;
  for (const [provider, url] of Object.entries(LIVE_LISTINGS)) {
    const apiKey = providers[provider]?.apiKey;
    if (!apiKey) { console.log(`${provider}: skipped (no key in config)`); continue; }
    try {
      const live = await listLive(url, apiKey);
      const picker = MODEL_CHOICES.filter((c) => c.provider === provider).map((c) => c.model);
      const d = diffCatalog(picker, live);
      drift += d.newer.length + d.unlisted.length;
      console.log(`${provider}: newer=[${d.newer.join(', ')}] unlisted=[${d.unlisted.join(', ')}]`);
    } catch (e) {
      console.log(`${provider}: listing failed (${(e as Error).message})`);
    }
  }
  console.log(drift === 0 ? 'provider-catalog: in sync' : `provider-catalog: ${drift} drift item(s)`);
  return strict && drift > 0 ? 1 : 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().then((code) => process.exit(code));
}
