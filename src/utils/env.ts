/**
 * Branded environment-variable access.
 *
 * The canonical prefix is SINTER_; the legacy LIMINAL_ prefix is still honored
 * for back-compat. `mirrorBrandEnv()` copies values across the two prefixes so
 * code reading either one (including the direct `process.env.LIMINAL_` reads)
 * works whichever the user set. It runs on module load and is also invoked from
 * the CLI entry after dotenv.
 */

const PREFIXES = ['SINTER_', 'LIMINAL_'] as const;

/**
 * Mirror every branded variable to its counterpart prefix when the counterpart
 * is unset. Idempotent; safe to call multiple times.
 */
export function mirrorBrandEnv(): void {
  const original = { ...process.env };
  for (const [key, value] of Object.entries(original)) {
    const source = PREFIXES.find(prefix => key.startsWith(prefix));
    if (!source || value === undefined) continue;
    const base = key.slice(source.length);
    if (!base) continue;
    const target = source === 'SINTER_' ? 'LIMINAL_' : 'SINTER_';
    const counterpart = target + base;
    if (original[counterpart] !== undefined) continue;
    // A mirrored credential must still point to the endpoint that supplied it.
    if (base.endsWith('_BASE_URL') && original[target + base.replace(/_BASE_URL$/, '_API_KEY')] !== undefined) {
      continue;
    }
    if (base.endsWith('_API_KEY')) {
      const endpointName = base.replace(/_API_KEY$/, '_BASE_URL');
      const targetEndpoint = original[target + endpointName];
      if (targetEndpoint !== undefined && targetEndpoint !== original[source + endpointName]) continue;
    }
    process.env[counterpart] = value;
  }
}

// Mirror once at import time so the common config paths see both prefixes.
mirrorBrandEnv();

/**
 * Get an environment variable by its un-prefixed key. Prefers the canonical
 * SINTER_ prefix and falls back to the legacy LIMINAL_ prefix.
 * @param key - Variable name without the brand prefix (e.g. 'LLM_BASE_URL')
 * @returns Value or undefined
 */
export function env(key: string): string | undefined {
  return process.env[`SINTER_${key}`] ?? process.env[`LIMINAL_${key}`];
}
