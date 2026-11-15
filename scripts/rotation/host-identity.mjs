/**
 * Canonical host identity for credential + productCandidate routing (Wave 3A P0-2).
 * All consumers should compare hosts via canonicalizeHost(), never raw baseUrl strings.
 *
 * Security: classifyEndpoint MUST use only parsed hostname/port — never raw path regexes
 * (path-injection e.g. https://attacker/127.0.0.1:8317 would otherwise steal cliproxy keys).
 */

/**
 * Normalize a URL or host string for stable matching.
 * - lowercase hostname
 * - strip trailing slashes on path root
 * - drop default ports (80/443)
 * - known aliases (127.0.0.1 ↔ localhost for loopback)
 *
 * @param {string|null|undefined} input
 * @returns {string|null} canonical host:port or host, null if unparseable
 */
export function canonicalizeHost(input) {
  if (input == null) return null;
  const raw = String(input).trim();
  if (!raw) return null;

  let urlStr = raw;
  if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(urlStr)) {
    // bare host or host/path
    urlStr = `https://${urlStr}`;
  }

  let u;
  try {
    u = new URL(urlStr);
  } catch {
    // last resort: strip path junk — host only, never use path content
    const hostOnly = raw.replace(/^https?:\/\//i, '').split('/')[0].toLowerCase();
    return hostOnly || null;
  }

  let host = (u.hostname || '').toLowerCase();
  if (!host) return null;

  // Loopback aliases (IPv4, IPv6, bracketed IPv6 from some parsers)
  if (
    host === '127.0.0.1'
    || host === '::1'
    || host === '[::1]'
    || host === '0:0:0:0:0:0:0:1'
  ) {
    host = 'localhost';
  }

  const port = u.port;
  const isDefault =
    !port
    || (u.protocol === 'https:' && port === '443')
    || (u.protocol === 'http:' && port === '80');

  return isDefault ? host : `${host}:${port}`;
}

/**
 * True if two base URLs resolve to the same canonical host identity.
 */
export function hostsMatch(a, b) {
  const ca = canonicalizeHost(a);
  const cb = canonicalizeHost(b);
  if (!ca || !cb) return false;
  return ca === cb;
}

/**
 * Classify endpoint family for credential routing using **hostname/port only**.
 * Path and query are never inspected (blocks path-injection key exfil).
 *
 * @returns {'cliproxy'|'ollama'|'kilo'|'zai'|'xai'|'deepseek'|'unknown'}
 */
export function classifyEndpoint(baseUrl) {
  const c = canonicalizeHost(baseUrl);
  if (!c) return 'unknown';

  // cliproxy: loopback on port 8317 only
  if (c === 'localhost:8317') return 'cliproxy';

  // ollama: loopback on port 11434 only
  if (c === 'localhost:11434') return 'ollama';

  // Exact hostnames (and optional non-default ports still match family by hostname prefix)
  const hostname = c.split(':')[0];
  if (hostname === 'api.kilo.ai' || hostname === 'kilo.ai') return 'kilo';
  if (hostname === 'api.z.ai' || hostname === 'z.ai') return 'zai';
  if (hostname === 'api.x.ai' || hostname === 'x.ai') return 'xai';
  if (c === 'api.deepseek.com' && /^https:\/\//i.test(String(baseUrl))) return 'deepseek';

  return 'unknown';
}
