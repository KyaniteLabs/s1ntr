/**
 * LocalRequestGuard — refuses browser requests that a page on another site can
 * aim at a loopback server. Shared by the preview server (`sinter serve`) and
 * the TUI bridge; ported from Studio's guard in gui/server.js.
 *
 * - DNS rebinding: a foreign site resolves its own name to 127.0.0.1, and the
 *   browser then sends that foreign name in Host. Only loopback names (and the
 *   explicitly bound host) may reach the server.
 * - Cross-site writes: a simple POST needs no CORS preflight. Browsers label it
 *   with Sec-Fetch-Site: cross-site and a foreign or "null" Origin. Non-browser
 *   clients send neither header and pass.
 */

import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from 'node:http';

const LOOPBACK_HOSTNAMES = ['localhost', '127.0.0.1', '::1'];
const WILDCARD_HOSTNAMES = new Set(['0.0.0.0', '::']);
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

const normalize = (name: string): string => name.toLowerCase().replace(/^\[|\]$/g, '');

/** Host names a server bound to `bindHost` answers to; null when bound to every interface. */
export function allowedHostsFor(bindHost?: string | null): ReadonlySet<string> | null {
  const bound = normalize((bindHost ?? '').trim());
  if (WILDCARD_HOSTNAMES.has(bound)) return null;
  const names = [...LOOPBACK_HOSTNAMES];
  if (bound) names.push(bound);
  return new Set(names.map(normalize));
}

/** Hostname from a Host header without port or IPv6 brackets; null when absent, '' when malformed. */
export function hostnameOf(hostHeader: string | undefined): string | null {
  if (hostHeader === undefined) return null;
  if (typeof hostHeader !== 'string' || hostHeader === '' || /\s/.test(hostHeader)) return '';
  try {
    const parsed = new URL(`http://${hostHeader}`);
    if (parsed.username !== '' || parsed.password !== '' || parsed.pathname !== '/' || parsed.search !== '' || parsed.hash !== '') {
      return '';
    }
    return normalize(parsed.hostname);
  } catch {
    return '';
  }
}

/** Explicit port from a Host header ('' if omitted); null when absent or malformed. */
export function portOf(hostHeader: string | undefined): string | null {
  if (hostHeader === undefined) return null;
  if (typeof hostHeader !== 'string' || hostHeader === '' || /\s/.test(hostHeader)) return null;
  try {
    const parsed = new URL(`http://${hostHeader}`);
    if (parsed.username !== '' || parsed.password !== '' || parsed.pathname !== '/' || parsed.search !== '' || parsed.hash !== '') {
      return null;
    }
    return parsed.port;
  } catch {
    return null;
  }
}

/** True when a browser sent this write from another site (or another port on localhost). */
export function isCrossSiteWrite(headers: IncomingHttpHeaders, allowedHosts: ReadonlySet<string> | null): boolean {
  const sfs = headers['sec-fetch-site'];
  const sfsValues = Array.isArray(sfs) ? sfs : sfs !== undefined ? [sfs] : [];
  if (sfsValues.some((v) => v.trim().toLowerCase() === 'cross-site')) return true;
  const origin = headers.origin;
  if (origin === undefined) return false;
  if (origin === 'null') return true;
  let originUrl: URL;
  try {
    originUrl = new URL(origin);
  } catch {
    return true;
  }
  const originHost = normalize(originUrl.hostname);
  if (allowedHosts !== null && !allowedHosts.has(originHost)) return true;

  // Enforce Host match on wildcard binds (0.0.0.0 / ::) and port match on every
  // request carrying a Host header (blocks cross-port localhost CSRF).
  const hostHeader = headers.host;
  if (hostHeader !== undefined) {
    const targetHost = hostnameOf(hostHeader);
    if (!targetHost) return true;
    if (allowedHosts === null && originHost !== targetHost) return true;
    const targetPort = portOf(hostHeader);
    if (targetPort === null) return true;
    const effectiveOriginPort = originUrl.port || (originUrl.protocol === 'https:' ? '443' : '80');
    const effectiveTargetPort = targetPort || '80';
    if (effectiveOriginPort !== effectiveTargetPort) return true;
  } else if (allowedHosts === null) {
    return true;
  }

  return false;
}

/**
 * Writes a 403 and returns true when the request must be refused; returns
 * false (and writes nothing) when it may proceed.
 */
export function rejectForeignRequest(
  req: IncomingMessage,
  res: ServerResponse,
  allowedHosts: ReadonlySet<string> | null,
): boolean {
  let error: string | null = null;
  if (allowedHosts) {
    const hostname = hostnameOf(req.headers.host);
    if (hostname !== null && !allowedHosts.has(hostname)) error = 'Forbidden host';
  }
  if (!error && !SAFE_METHODS.has((req.method ?? 'GET').toUpperCase()) && isCrossSiteWrite(req.headers, allowedHosts)) {
    error = 'Forbidden origin';
  }
  if (!error) return false;
  res.writeHead(403, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error }));
  return true;
}
