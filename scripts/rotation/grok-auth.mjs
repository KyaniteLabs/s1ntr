/**
 * Resolve Grok / xAI OIDC credentials from ~/.grok/auth.json (Grok CLI auth).
 * Never logs token values. Used by rotation --auth grok for wave batteries.
 */
import fsSync from 'node:fs';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const GROK_DEFAULT_BASE_URL = 'https://api.x.ai/v1';
export const GROK_DEFAULT_MODEL = 'grok-4.5';
/** Default seat-cell buffer: 1 hour (tour-preflight / wave2Allowed soft gate). */
export const GROK_MIN_TTL_MS_DEFAULT = 3_600_000;

/**
 * Non-throwing readiness probe for preflight (no secret values in detail).
 * Parses nested `https://auth.x.ai::<id>` entries (Grok CLI OIDC shape).
 *
 * @returns {{ ok: boolean, detail: string, hoursLeft: number|null, keySource: string|null }}
 */
export function inspectGrokOidcAuth({
  authPath = path.join(os.homedir(), '.grok', 'auth.json'),
  minTtlMs = GROK_MIN_TTL_MS_DEFAULT,
  env = process.env,
} = {}) {
  const envKey = env.XAI_API_KEY || env.GROK_API_KEY || null;
  let raw;
  try {
    if (!fsSync.existsSync(authPath)) {
      if (envKey) {
        return { ok: true, detail: 'XAI_API_KEY/GROK_API_KEY present', hoursLeft: null, keySource: 'env' };
      }
      return { ok: false, detail: `missing ${authPath}`, hoursLeft: null, keySource: null };
    }
    raw = JSON.parse(fsSync.readFileSync(authPath, 'utf8'));
  } catch (err) {
    if (envKey) {
      return {
        ok: true,
        detail: 'XAI_API_KEY/GROK_API_KEY present (auth.json unreadable)',
        hoursLeft: null,
        keySource: 'env',
      };
    }
    return {
      ok: false,
      detail: `auth unreadable: ${err instanceof Error ? err.message : String(err)}`,
      hoursLeft: null,
      keySource: null,
    };
  }

  const entries = Object.entries(raw || {}).filter(([, v]) => v && typeof v === 'object' && v.key);
  // Rare flat shape with key at top level
  if (raw && typeof raw === 'object' && raw.key && !entries.length) {
    entries.push(['flat', raw]);
  }
  if (entries.length === 0) {
    if (envKey) {
      return { ok: true, detail: 'XAI_API_KEY/GROK_API_KEY present', hoursLeft: null, keySource: 'env' };
    }
    return { ok: false, detail: 'auth.json has no OIDC entry with key', hoursLeft: null, keySource: null };
  }

  entries.sort((a, b) => {
    const ta = Date.parse(a[1].create_time || a[1].expires_at || 0) || 0;
    const tb = Date.parse(b[1].create_time || b[1].expires_at || 0) || 0;
    return tb - ta;
  });
  const [, entry] = entries[0];
  const expiresAt = entry.expires_at || entry.expiresAt || null;
  let hoursLeft = null;
  if (expiresAt) {
    const expMs = Date.parse(String(expiresAt));
    if (Number.isFinite(expMs)) hoursLeft = (expMs - Date.now()) / 3_600_000;
  }
  if (hoursLeft != null && hoursLeft * 3_600_000 < minTtlMs) {
    if (envKey) {
      return {
        ok: true,
        detail: `OIDC expiring (hoursLeft=${hoursLeft.toFixed(1)}); using env key`,
        hoursLeft,
        keySource: 'env',
      };
    }
    return {
      ok: false,
      detail: `OIDC hoursLeft=${hoursLeft.toFixed(1)} (need ≥${(minTtlMs / 3_600_000).toFixed(1)}); run grok login`,
      hoursLeft,
      keySource: 'grok-oidc',
    };
  }
  return {
    ok: true,
    detail: hoursLeft == null
      ? 'OIDC key present (no expires_at)'
      : `OIDC hoursLeft=${hoursLeft.toFixed(1)} (need ≥${(minTtlMs / 3_600_000).toFixed(1)}) mode=${entry.auth_mode || 'oidc'}`,
    hoursLeft,
    keySource: 'grok-oidc',
  };
}

/**
 * @returns {{
 *   baseUrl: string,
 *   apiKey: string,
 *   model: string,
 *   keySource: string,
 *   provider: string,
 *   expiresAt: string|null,
 *   email: string|null,
 * }}
 */
export async function loadGrokOidcAuth({
  authPath = path.join(os.homedir(), '.grok', 'auth.json'),
  model = GROK_DEFAULT_MODEL,
  baseUrl = GROK_DEFAULT_BASE_URL,
  minTtlMs = 60_000,
} = {}) {
  let raw;
  try {
    raw = JSON.parse(await fs.readFile(authPath, 'utf8'));
  } catch (err) {
    throw new Error(
      `Grok auth unavailable at ${authPath}: ${err instanceof Error ? err.message : String(err)}. `
      + 'Run `grok login` (OIDC via auth.x.ai) or set XAI_API_KEY.',
    );
  }

  const envKey = process.env.XAI_API_KEY || process.env.GROK_API_KEY || null;

  const entries = Object.entries(raw || {}).filter(([, v]) => v && typeof v === 'object' && v.key);
  if (entries.length === 0) {
    if (envKey) {
      return {
        baseUrl,
        apiKey: envKey,
        model,
        keySource: 'env',
        provider: 'xai',
        expiresAt: null,
        email: null,
      };
    }
    throw new Error('Grok auth.json has no usable OIDC key; run `grok login` or set XAI_API_KEY');
  }

  entries.sort((a, b) => {
    const ta = Date.parse(a[1].create_time || a[1].expires_at || 0) || 0;
    const tb = Date.parse(b[1].create_time || b[1].expires_at || 0) || 0;
    return tb - ta;
  });
  const [, entry] = entries[0];
  const expiresAt = entry.expires_at || null;
  if (expiresAt) {
    const expMs = Date.parse(expiresAt);
    if (Number.isFinite(expMs) && expMs - Date.now() < minTtlMs) {
      if (envKey) {
        return {
          baseUrl,
          apiKey: envKey,
          model,
          keySource: 'env',
          provider: 'xai',
          expiresAt: null,
          email: entry.email || null,
        };
      }
      throw new Error(
        `Grok OIDC token expired or expiring soon (${expiresAt}). Run \`grok login\` to refresh.`,
      );
    }
  }

  return {
    baseUrl,
    apiKey: String(entry.key),
    model,
    keySource: 'grok-oidc',
    provider: 'xai',
    expiresAt,
    email: entry.email || null,
  };
}

export function isGrokModelId(model) {
  if (!model || typeof model !== 'string') return false;
  return /^grok[-_]/i.test(model) || model.toLowerCase().includes('grok');
}
