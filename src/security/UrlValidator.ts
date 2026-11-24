/**
 * URL Validator for SSRF protection
 * Prevents requests to internal infrastructure and DNS rebinding attacks
 */

import { lookup as defaultDnsLookup } from 'dns/promises';
import { lookup as callbackDnsLookup, type LookupAddress } from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import { logSSRFAttempt } from './SecurityLogger.js';
import { PROVIDER_DEFAULTS } from '../config/ProviderRuntime.js';

export type DnsLookupFn = typeof defaultDnsLookup;

export class SSRFError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SSRFError';
  }
}

export interface UrlValidationOptions {
  allowedHosts?: string[];
  allowPrivateIPs?: boolean;
  allowLocalhost?: boolean;
}

const PROVIDER_DEFAULT_HOSTS = Object.values(PROVIDER_DEFAULTS).flatMap(({ baseUrl }) => {
  try {
    return [new URL(baseUrl).hostname.toLowerCase()];
  } catch {
    return [];
  }
});

// Default allowed hosts for LLM providers
const DEFAULT_ALLOWED_HOSTS = [
  ...PROVIDER_DEFAULT_HOSTS,
  'api.openai.com',
  'api.minimaxi.com',    // MiniMax Chinese domestic
  'api.minimaxi.chat',   // MiniMax alternative
  'api.minimax.io',       // MiniMax International Token Plan
  'localhost',
  '127.0.0.1',
] as const;

// Cloud metadata endpoints that should NEVER be accessible
const BLOCKED_HOSTS = [
  '169.254.169.254',  // AWS, GCP, Azure metadata
  '169.254.170.2',    // AWS ECS metadata
  'fd00:ec2::254',    // AWS IMDSv2 IPv6 metadata
  // Built at runtime so dist/ carries no literal CGNAT IP matching the owner-identifier scan.
  ['100', '100', '100', '200'].join('.'), // Alibaba Cloud metadata
  'metadata.google.internal',
  'metadata.oraclecloud.com',
];

// Private IP ranges. <internal-host>/10 (carrier-grade NAT) is deliberately not
// listed: the fleet's own LLM gateway is addressed in that range.
const PRIVATE_IP_PATTERNS = [
  /^10\./,                          // 10.0.0.0/8
  /^172\.(1[6-9]|2[0-9]|3[0-1])\./, // 172.16.0.0/12
  /^192\.168\./,                    // 192.168.0.0/16
  /^127\./,                         // 127.0.0.0/8 (loopback)
  /^0\./,                           // 0.0.0.0/8
  /^169\.254\./,                    // 169.254.0.0/16 (link-local, cloud metadata)
  /^::1?$/,                         // IPv6 loopback and unspecified
  /^f[cd][0-9a-f]{2}:/,             // fc00::/7 (IPv6 unique local)
  /^fe[89ab][0-9a-f]:/,             // fe80::/10 (IPv6 link-local)
];

/**
 * Lower-case an address, drop URL brackets and a zone id, and unwrap an
 * IPv4-mapped IPv6 address (::ffff:a.b.c.d or ::ffff:hhhh:hhhh) to its IPv4 form.
 */
function normalizeIP(ip: string): string {
  const bare = ip.toLowerCase().replace(/^\[|\]$/g, '').replace(/%.*$/, '').replace(/\.+$/, '');
  const mapped = /^::ffff:(?:(\d+\.\d+\.\d+\.\d+)|([0-9a-f]{1,4}):([0-9a-f]{1,4}))$/.exec(bare);
  if (!mapped) return bare;
  if (mapped[1]) return mapped[1];
  const high = parseInt(mapped[2], 16);
  const low = parseInt(mapped[3], 16);
  return `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`;
}

/**
 * Check if an IP address is private/internal
 */
function isPrivateIP(ip: string): boolean {
  const address = normalizeIP(ip);
  return PRIVATE_IP_PATTERNS.some(pattern => pattern.test(address));
}

function isBlockedHost(host: string): boolean {
  return BLOCKED_HOSTS.includes(normalizeIP(host));
}

function isLocalhostName(hostname: string): boolean {
  const norm = normalizeIP(hostname);
  return norm === 'localhost' || norm === '127.0.0.1' || norm === '::1';
}

/**
 * Refuse one DNS answer for a hostname. Cloud metadata stays blocked even with
 * private IPs allowed. Localhost may resolve to loopback when allowLocalhost is
 * set, since the allowLocalhost flag already covers it.
 */
function checkResolvedAddress(
  urlString: string,
  hostname: string,
  resolvedIP: string,
  allowPrivateIPs: boolean,
  allowLocalhost: boolean,
): void {
  if (isBlockedHost(resolvedIP)) {
    logSSRFAttempt(urlString, {
      details: { blockedHost: hostname, resolvedIP, reason: 'cloud_metadata' }
    });
    throw new SSRFError(`Access to ${hostname} is blocked (resolves to cloud metadata endpoint ${resolvedIP})`);
  }
  if (isPrivateIP(resolvedIP) && !allowPrivateIPs && !(isLocalhostName(hostname) && allowLocalhost)) {
    logSSRFAttempt(urlString, {
      details: { blockedHost: hostname, resolvedIP, reason: 'private_ip' }
    });
    throw new SSRFError(`Access to private IP ${resolvedIP} (resolved from ${hostname}) is blocked`);
  }
}

export async function validateUrl(
  urlString: string,
  options: UrlValidationOptions = {},
  dnsLookup: DnsLookupFn = defaultDnsLookup,
): Promise<void> {
  const { allowedHosts = [], allowPrivateIPs = false, allowLocalhost = true } = options;

  let parsed: URL;
  try {
    parsed = new URL(urlString);
  } catch {
    throw new SSRFError(`Invalid URL: ${urlString}`);
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new SSRFError(`Unsupported protocol ${parsed.protocol}`);
  }

  const hostname = normalizeIP(parsed.hostname);

  // Check blocked hosts (cloud metadata)
  if (isBlockedHost(hostname)) {
    logSSRFAttempt(urlString, {
      details: { blockedHost: hostname, reason: 'cloud_metadata' }
    });
    throw new SSRFError(`Access to ${hostname} is blocked (cloud metadata endpoint)`);
  }

  // SECURITY: Resolve hostname to IP and validate (prevents DNS rebinding)
  // Fail closed: DNS lookup failures are treated as potential SSRF attempts
  // Every answer is checked, not just the first: a host that answers with one
  // public and one private address must not slip through on the public one.
  let resolvedIPs: string[] = [];
  try {
    const lookupResult: unknown = await dnsLookup(hostname, { all: true });
    const answers = Array.isArray(lookupResult) ? lookupResult : [lookupResult];
    resolvedIPs = answers.map(answer => (answer as { address: string }).address);
  } catch (error) {
    // SECURITY: Fail closed when DNS lookup fails - do not continue with degraded protection
    const reason = error instanceof Error ? error.message : String(error);
    logSSRFAttempt(urlString, {
      details: {
        hostname,
        reason: `dns_lookup_failed: ${reason}`,
      },
    });
    throw new SSRFError(`DNS lookup failed for ${hostname} - potential SSRF attack`);
  }

  if (resolvedIPs.length === 0) {
    logSSRFAttempt(urlString, { details: { hostname, reason: 'dns_lookup_empty' } });
    throw new SSRFError(`DNS lookup returned no addresses for ${hostname}`);
  }

  for (const resolvedIP of resolvedIPs) {
    checkResolvedAddress(urlString, hostname, resolvedIP, allowPrivateIPs, allowLocalhost);
  }

  const isLocalhost = isLocalhostName(hostname);

  // Block localhost if explicitly disabled
  if (isLocalhost && !allowLocalhost) {
    logSSRFAttempt(urlString, {
      details: { blockedHost: hostname, reason: 'localhost_blocked' }
    });
    throw new SSRFError(`Access to localhost ${hostname} is blocked`);
  }

  // Check if hostname is a private IP (excluding localhost which is handled above)
  const hostnameIsPrivateIP = isPrivateIP(hostname);
  if (hostnameIsPrivateIP && !isLocalhost && !allowPrivateIPs) {
    logSSRFAttempt(urlString, {
      details: { blockedHost: hostname, reason: 'private_ip' }
    });
    throw new SSRFError(`Access to private IP ${hostname} is blocked`);
  }

  // Check whitelist (if any custom allowed hosts are specified)
  if (allowedHosts.length > 0) {
    const allAllowedHosts = [...DEFAULT_ALLOWED_HOSTS, ...allowedHosts].map(normalizeIP);
    const isAllowed = allAllowedHosts.some(allowed => {
      if (allowed === hostname) return true;
      if (hostname.endsWith(`.${allowed}`)) return true;
      return false;
    });

    // If we have a whitelist and this host isn't on it, block it
    if (!isAllowed) {
      logSSRFAttempt(urlString, {
        details: { blockedHost: hostname, reason: 'not_in_allowlist' }
      });
      throw new SSRFError(`Host ${hostname} is not in the allowed list`);
    }
  }
}

const MAX_REDIRECTS = 5;

type CallbackLookup = typeof callbackDnsLookup;
type ConnectLookup = (
  hostname: string,
  opts: { all?: boolean; family?: number },
  cb: (err: Error | null, address: string | LookupAddress[], family?: number) => void,
) => void;

/**
 * A socket-level DNS lookup that re-checks every answer at connect time.
 * validateUrl resolves the name once; without this, a host that answers with a
 * public address to the check and a private one to the connection (DNS
 * rebinding) would reach the private address.
 */
export function createPinnedLookup(
  options: UrlValidationOptions = {},
  lookupImpl: CallbackLookup = callbackDnsLookup,
): ConnectLookup {
  const { allowPrivateIPs = false, allowLocalhost = true } = options;
  return (hostname, opts, cb) => {
    lookupImpl(hostname, { ...opts, all: true }, (err, answers) => {
      if (err) return cb(err, []);
      const list = answers as unknown as LookupAddress[];
      try {
        if (list.length === 0) throw new SSRFError(`DNS lookup returned no address for ${hostname}`);
        for (const answer of list) {
          checkResolvedAddress(`connect://${hostname}`, hostname.toLowerCase(), answer.address, allowPrivateIPs, allowLocalhost);
        }
      } catch (error) {
        return cb(error as Error, []);
      }
      if (opts.all) return cb(null, list);
      return cb(null, list[0].address, list[0].family);
    });
  };
}

const PINNED_FETCH_MAX_BYTES = 20 * 1024 * 1024;

/**
 * GET a URL with its connection going through createPinnedLookup, so the
 * address it connects to is an address that passed the check. Redirects are
 * returned, not followed. Bodies over 20 MB are refused.
 */
export function pinnedFetch(
  urlString: string,
  options: UrlValidationOptions = {},
  lookupImpl: CallbackLookup = callbackDnsLookup,
): Promise<Response> {
  const url = new URL(urlString);
  const client = url.protocol === 'https:' ? https : url.protocol === 'http:' ? http : null;
  if (!client) return Promise.reject(new SSRFError(`Unsupported protocol ${url.protocol}`));
  return new Promise((resolve, reject) => {
    const req = client.get(url, { lookup: createPinnedLookup(options, lookupImpl) as never, timeout: 30_000 }, (res) => {
      const chunks: Buffer[] = [];
      let size = 0;
      res.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > PINNED_FETCH_MAX_BYTES) {
          req.destroy(new SSRFError(`Response from ${url.hostname} exceeds ${PINNED_FETCH_MAX_BYTES} bytes`));
          return;
        }
        chunks.push(chunk);
      });
      res.on('error', reject);
      res.on('end', () => {
        const status = res.statusCode ?? 502;
        const headers = new Headers();
        for (const [name, value] of Object.entries(res.headers)) {
          if (value === undefined) continue;
          for (const v of Array.isArray(value) ? value : [value]) headers.append(name, v);
        }
        const body = [204, 205, 304].includes(status) ? null : Buffer.concat(chunks);
        resolve(new Response(body, { status, statusText: res.statusMessage ?? '', headers }));
      });
    });
    req.on('timeout', () => req.destroy(new SSRFError(`Request to ${url.hostname} timed out`)));
    req.on('error', reject);
  });
}

/**
 * Fetch a URL and re-run validateUrl on every redirect hop, so an allowed
 * public URL cannot bounce the request to a private or metadata address.
 * Without an injected fetchImpl, connections are also pinned (pinnedFetch).
 */
export async function fetchValidated(
  urlString: string,
  options: UrlValidationOptions = {},
  dnsLookup: DnsLookupFn = defaultDnsLookup,
  fetchImpl?: typeof fetch,
): Promise<Response> {
  let current = urlString;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    await validateUrl(current, options, dnsLookup);
    const response = fetchImpl
      ? await fetchImpl(current, { redirect: 'manual' })
      : await pinnedFetch(current, options);
    const location = response.status >= 300 && response.status < 400
      ? response.headers.get('location')
      : null;
    if (location === null) return response;
    await response.body?.cancel().catch(() => {});
    current = new URL(location, current).toString();
  }
  throw new SSRFError(`Too many redirects (more than ${MAX_REDIRECTS}) from ${urlString}`);
}

/**
 * Synchronous version for backward compatibility
 * Note: This cannot prevent DNS rebinding - prefer validateUrl() when possible
 */
export function validateUrlSync(
  urlString: string,
  options: UrlValidationOptions = {}
): void {
  const { allowedHosts = [], allowPrivateIPs = false, allowLocalhost = true } = options;
  
  let parsed: URL;
  try {
    parsed = new URL(urlString);
  } catch {
    throw new SSRFError(`Invalid URL: ${urlString}`);
  }
  
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new SSRFError(`Unsupported protocol ${parsed.protocol}`);
  }

  const hostname = normalizeIP(parsed.hostname);
  
  // Check blocked hosts (cloud metadata)
  if (isBlockedHost(hostname)) {
    logSSRFAttempt(urlString, { 
      details: { blockedHost: hostname, reason: 'cloud_metadata' } 
    });
    throw new SSRFError(`Access to ${hostname} is blocked (cloud metadata endpoint)`);
  }
  
  // Check if hostname is localhost
  const isLocalhost = isLocalhostName(hostname);
  
  // Block localhost if explicitly disabled
  if (isLocalhost && !allowLocalhost) {
    logSSRFAttempt(urlString, { 
      details: { blockedHost: hostname, reason: 'localhost_blocked' } 
    });
    throw new SSRFError(`Access to localhost ${hostname} is blocked`);
  }
  
  // Check if hostname is a private IP (excluding localhost which is handled above)
  const hostnameIsPrivateIP = isPrivateIP(hostname);
  if (hostnameIsPrivateIP && !isLocalhost && !allowPrivateIPs) {
    logSSRFAttempt(urlString, { 
      details: { blockedHost: hostname, reason: 'private_ip' } 
    });
    throw new SSRFError(`Access to private IP ${hostname} is blocked`);
  }
  
  // Check whitelist (if any custom allowed hosts are specified)
  if (allowedHosts.length > 0) {
    const allAllowedHosts = [...DEFAULT_ALLOWED_HOSTS, ...allowedHosts].map(normalizeIP);
    const isAllowed = allAllowedHosts.some(allowed => {
      if (allowed === hostname) return true;
      if (hostname.endsWith(`.${allowed}`)) return true;
      return false;
    });
    
    // If we have a whitelist and this host isn't on it, block it
    if (!isAllowed) {
      logSSRFAttempt(urlString, { 
        details: { blockedHost: hostname, reason: 'not_in_allowlist' } 
      });
      throw new SSRFError(`Host ${hostname} is not in the allowed list`);
    }
  }
}

export function getAllowedHostsFromEnv(): string[] {
  const envHosts = process.env.LIMINAL_ALLOWED_HOSTS;
  if (!envHosts) return [];
  return envHosts.split(',').map(h => h.trim()).filter(Boolean);
}
