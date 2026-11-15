import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { validateUrl, validateUrlSync, SSRFError, getAllowedHostsFromEnv, fetchValidated, createPinnedLookup, pinnedFetch, type DnsLookupFn } from '../../src/security/UrlValidator.js';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import * as SecurityLogger from '../../src/security/SecurityLogger.js';

// For tests that need the async validateUrl, provide a safe mock dnsLookup.
// This avoids real DNS calls while allowing validateUrl to be properly tested.
async function mockDnsLookup(hostname: string): Promise<{ address: string; family: number }> {
  // Map known hosts to stable IPs so tests are deterministic
  const map: Record<string, string> = {
    'localhost': '127.0.0.1',
    '127.0.0.1': '127.0.0.1',
    '::1': '::1',
    'api.openai.com': '8.8.8.8',
    'api.minimax.io': '8.8.8.8',
    'api.z.ai': '8.8.8.8',
    'openrouter.ai': '8.8.8.8',
    'api.kimi.com': '8.8.8.8',
    'api.moonshot.ai': '8.8.8.8',
    'sub.api.openai.com': '8.8.8.8',
    'custom.llm.provider.com': '8.8.8.8',
    'evil.com': '8.8.8.8',
    '10.0.0.1': '10.0.0.1',
    '10.255.255.255': '10.255.255.255',
    '172.16.0.1': '172.16.0.1',
    '172.31.255.255': '172.31.255.255',
    '192.168.1.1': '192.168.1.1',
    '192.168.0.1': '192.168.0.1',
  };
  return { address: map[hostname] ?? '8.8.8.8', family: 4 };
}

describe('UrlValidator', () => {
  describe('validateUrlSync', () => {
    // All sync tests use validateUrlSync — no DNS calls needed, no async issues

    it('should allow OpenAI API', () => {
      expect(() => validateUrlSync('https://api.openai.com/v1/chat/completions')).not.toThrow();
    });

    it('should allow Minimax API', () => {
      expect(() => validateUrlSync('https://api.minimax.io/v1/chat/completions')).not.toThrow();
    });

    it('should allow canonical cloud provider APIs when a whitelist is active', () => {
      const options = { allowedHosts: ['custom.llm.provider.com'] };
      expect(() => validateUrlSync('https://api.z.ai/api/anthropic', options)).not.toThrow();
      expect(() => validateUrlSync('https://openrouter.ai/api/v1', options)).not.toThrow();
      expect(() => validateUrlSync('https://api.kimi.com/coding/v1', options)).not.toThrow();
      expect(() => validateUrlSync('https://api.moonshot.ai/v1', options)).not.toThrow();
    });

    it('should block AWS metadata endpoint', () => {
      expect(() => validateUrlSync('http://169.254.169.254/latest/meta-data/')).toThrow(SSRFError);
    });

    it('should block GCP metadata endpoint', () => {
      expect(() => validateUrlSync('http://metadata.google.internal/computeMetadata/v1/')).toThrow(SSRFError);
    });

    it('should block Oracle Cloud metadata endpoint', () => {
      expect(() => validateUrlSync('http://metadata.oraclecloud.com/')).toThrow(SSRFError);
    });

    it('should block AWS ECS metadata endpoint', () => {
      expect(() => validateUrlSync('http://169.254.170.2/v2/credentials/')).toThrow(SSRFError);
    });

    it('should block private IP ranges (10.x.x.x)', () => {
      expect(() => validateUrlSync('http://10.0.0.1/secret')).toThrow(SSRFError);
      expect(() => validateUrlSync('http://10.255.255.255/admin')).toThrow(SSRFError);
    });

    it('should block private IP ranges (172.16-31.x.x)', () => {
      expect(() => validateUrlSync('http://172.16.0.1/internal')).toThrow(SSRFError);
      expect(() => validateUrlSync('http://172.31.255.255/api')).toThrow(SSRFError);
    });

    it('should block private IP ranges (192.168.x.x)', () => {
      expect(() => validateUrlSync('http://192.168.1.1/admin')).toThrow(SSRFError);
      expect(() => validateUrlSync('http://192.168.0.1/router')).toThrow(SSRFError);
    });

    it('should allow localhost by default', () => {
      expect(() => validateUrlSync('http://localhost:1234/v1')).not.toThrow();
      expect(() => validateUrlSync('http://127.0.0.1:1234/v1')).not.toThrow();
    });

    it('should block localhost when disabled', () => {
      expect(() => validateUrlSync('http://localhost:1234/v1', { allowLocalhost: false })).toThrow(SSRFError);
      expect(() => validateUrlSync('http://127.0.0.1:1234/v1', { allowLocalhost: false })).toThrow(SSRFError);
    });

    it('should allow private IPs when explicitly enabled', () => {
      expect(() => validateUrlSync('http://10.0.0.1/api', { allowPrivateIPs: true })).not.toThrow();
      expect(() => validateUrlSync('http://192.168.1.1/admin', { allowPrivateIPs: true })).not.toThrow();
    });

    it('should block invalid URLs', () => {
      expect(() => validateUrlSync('not-a-valid-url')).toThrow(SSRFError);
      expect(() => validateUrlSync('')).toThrow(SSRFError);
    });

    it('should block hosts not in whitelist when whitelist is provided', () => {
      expect(() => validateUrlSync('https://evil.com/api', {
        allowedHosts: ['custom.llm.provider.com']
      })).toThrow(SSRFError);
    });

    it('should be case insensitive for hostnames', () => {
      expect(() => validateUrlSync('http://169.254.169.254/LATEST/META-DATA/')).toThrow(SSRFError);
      expect(() => validateUrlSync('HTTP://LOCALHOST:1234/V1')).not.toThrow();
    });

    it('should block Azure metadata endpoint', () => {
      expect(() => validateUrlSync('http://169.254.169.254/metadata/v1/maintenance')).toThrow(SSRFError);
    });
  });

  describe('validateUrlSync address ranges', () => {
    it('should block an IPv4 link-local literal', () => {
      expect(() => validateUrlSync('http://169.254.1.1/latest'))
        .toThrow('Access to private IP 169.254.1.1 is blocked');
    });

    it('should block IPv4-mapped cloud metadata even when private IPs are allowed', () => {
      expect(() => validateUrlSync('http://[::ffff:169.254.169.254]/latest', { allowPrivateIPs: true }))
        .toThrow('is blocked (cloud metadata endpoint)');
    });

    it('should still allow a private IP literal when private IPs are allowed', () => {
      expect(() => validateUrlSync('http://10.0.0.1:8080/v1', { allowPrivateIPs: true })).not.toThrow();
    });
  });

  describe('validateUrl (async with mock DNS)', () => {
    // These tests exercise the async validateUrl path with a controlled DNS mock

    it('should allow localhost via async path (mocked DNS)', async () => {
      await expect(validateUrl('http://localhost:1234/v1', {}, mockDnsLookup)).resolves.toBeUndefined();
    });

    it('should allow public host via async path', async () => {
      await expect(validateUrl('https://api.openai.com/v1', {}, mockDnsLookup)).resolves.toBeUndefined();
    });

    it('should block private IP when DNS resolves to private address', async () => {
      // Provide a custom dnsLookup that returns a private IP for a public-looking hostname
      const badLookup = async (): Promise<{ address: string; family: number }> =>
        ({ address: '10.0.0.1', family: 4 });
      await expect(validateUrl('https://api.company.com/v1', {}, badLookup))
        .rejects.toThrow(SSRFError);
    });

    const resolvingTo = (address: string) => async (): Promise<{ address: string; family: number }> =>
      ({ address, family: address.includes(':') ? 6 : 4 });

    it.each([
      '169.254.1.1',        // IPv4 link-local
      'fd12:3456::1',       // IPv6 unique local (fc00::/7, not only fc00:)
      'fc01::1',
      'fe90::1',            // IPv6 link-local (fe80::/10, not only fe80:)
      '::ffff:127.0.0.1',   // IPv4-mapped loopback
      '::ffff:10.0.0.1',    // IPv4-mapped private
      '::ffff:a00:1',       // the same address in hex form
      '::',                 // unspecified
    ])('should block a public-looking host that resolves to %s', async (address) => {
      await expect(validateUrl('https://api.company.com/v1', {}, resolvingTo(address)))
        .rejects.toThrow(`Access to private IP ${address} (resolved from api.company.com) is blocked`);
    });

    it.each(['169.254.169.254', '::ffff:169.254.169.254', '::ffff:a9fe:a9fe'])(
      'should block a host that resolves to cloud metadata (%s) even when private IPs are allowed',
      async (address) => {
        await expect(validateUrl('https://api.company.com/v1', { allowPrivateIPs: true }, resolvingTo(address)))
          .rejects.toThrow(`Access to api.company.com is blocked (resolves to cloud metadata endpoint ${address})`);
      });

    it('should still allow public IPv6 and the carrier-grade NAT range the fleet gateway uses', async () => {
      await expect(validateUrl('https://api.company.com/v1', {}, resolvingTo('2606:4700::1111')))
        .resolves.toBeUndefined();
      await expect(validateUrl('https://api.company.com/v1', {}, resolvingTo('<internal-host>')))
        .resolves.toBeUndefined();
    });

    it('should allow localhost resolving to ::1 via async path (IPv6 fix)', async () => {
      // localhost resolving to ::1 should NOT be blocked — it bypasses DNS entirely
      // via the isLocalhost hostname check and allowLocalhost=true default
      await expect(validateUrl('http://localhost:11434/api/generate', {}, mockDnsLookup))
        .resolves.toBeUndefined();
    });

    it('should fail closed and log SSRF attempt when DNS lookup fails', async () => {
      const spy = vi.spyOn(SecurityLogger, 'logSSRFAttempt');
      const failingLookup = async (): Promise<{ address: string; family: number }> => {
        throw new Error('getaddrinfo ENOTFOUND api.example.com');
      };

      await expect(validateUrl('https://api.example.com/v1', {}, failingLookup))
        .rejects.toThrow('DNS lookup failed for api.example.com - potential SSRF attack');

      expect(spy).toHaveBeenCalledWith('https://api.example.com/v1', {
        details: {
          hostname: 'api.example.com',
          reason: 'dns_lookup_failed: getaddrinfo ENOTFOUND api.example.com',
        },
      });
    });
  });

  describe('getAllowedHostsFromEnv', () => {
    // Per-key env save/restore avoids whole-object process.env replacement.
    const envKey = 'LIMINAL_ALLOWED_HOSTS';
    let savedValue: string | undefined;

    beforeEach(() => {
      savedValue = process.env[envKey];
      delete process.env[envKey];
    });

    afterEach(() => {
      if (savedValue === undefined) delete process.env[envKey];
      else process.env[envKey] = savedValue;
    });

    it('should return empty array when env var is not set', () => {
      expect(getAllowedHostsFromEnv()).toEqual([]);
    });

    it('should parse comma-separated hosts', () => {
      process.env.LIMINAL_ALLOWED_HOSTS = 'host1.com, host2.com, host3.com';
      expect(getAllowedHostsFromEnv()).toEqual(['host1.com', 'host2.com', 'host3.com']);
    });

    it('should handle empty env var', () => {
      process.env.LIMINAL_ALLOWED_HOSTS = '';
      expect(getAllowedHostsFromEnv()).toEqual([]);
    });

    it('should filter out empty entries', () => {
      process.env.LIMINAL_ALLOWED_HOSTS = 'host1.com,,host2.com, ,host3.com';
      expect(getAllowedHostsFromEnv()).toEqual(['host1.com', 'host2.com', 'host3.com']);
    });
  });

  describe('every DNS answer and redirect hop is checked', () => {
    // A host whose answers mix a public and a private address.
    const mixedLookup = (async () => [
      { address: '8.8.8.8', family: 4 },
      { address: '10.0.0.5', family: 4 },
    ]) as unknown as DnsLookupFn;
    const publicLookup = (async () => [{ address: '8.8.8.8', family: 4 }]) as unknown as DnsLookupFn;

    it('refuses a host when any answer is private, not just the first', async () => {
      await expect(validateUrl('https://mixed.example/x', { allowLocalhost: false }, mixedLookup))
        .rejects.toThrow('Access to private IP 10.0.0.5 (resolved from mixed.example) is blocked');
    });

    it('refuses a redirect to the cloud metadata address', async () => {
      const fetchImpl = vi.fn(async () => new Response(null, {
        status: 302,
        headers: { location: 'http://169.254.169.254/latest/meta-data/' },
      })) as unknown as typeof fetch;
      await expect(fetchValidated('https://ok.example/p.json', {}, publicLookup, fetchImpl))
        .rejects.toThrow(SSRFError);
    });

    it('follows a relative redirect to a public host and returns its body', async () => {
      const fetchImpl = vi.fn(async (url: string) => url.endsWith('/old')
        ? new Response(null, { status: 301, headers: { location: '/new' } })
        : new Response('{"ok":true}', { status: 200 })) as unknown as typeof fetch;
      const response = await fetchValidated('https://ok.example/old', {}, publicLookup, fetchImpl);
      expect(await response.json()).toEqual({ ok: true });
    });

    it('gives up after five redirects', async () => {
      const fetchImpl = vi.fn(async () => new Response(null, {
        status: 302,
        headers: { location: '/again' },
      })) as unknown as typeof fetch;
      await expect(fetchValidated('https://ok.example/start', {}, publicLookup, fetchImpl))
        .rejects.toThrow('Too many redirects (more than 5) from https://ok.example/start');
    });
  });

  describe('connect-time pinning (DNS rebinding)', () => {
    // A rebinding host answers the pre-flight check with a public address and
    // the socket's own lookup with a private one. The socket lookup must refuse.
    const rebindLookup = ((_host: string, _opts: unknown, cb: (e: Error | null, a: unknown) => void) =>
      cb(null, [{ address: '127.0.0.1', family: 4 }])) as never;
    const publicLookupCb = ((_host: string, _opts: unknown, cb: (e: Error | null, a: unknown) => void) =>
      cb(null, [{ address: '8.8.8.8', family: 4 }])) as never;

    function runLookup(lookup: ReturnType<typeof createPinnedLookup>, all: boolean) {
      return new Promise<{ err: Error | null; address: unknown; family?: number }>((resolve) =>
        lookup('rebind.example', { all }, (err, address, family) => resolve({ err, address, family })));
    }

    it('refuses a private answer at connect time', async () => {
      const { err } = await runLookup(createPinnedLookup({ allowLocalhost: false }, rebindLookup), false);
      expect(err).toBeInstanceOf(SSRFError);
      expect(err?.message).toBe('Access to private IP 127.0.0.1 (resolved from rebind.example) is blocked');
    });

    it('passes a public answer in both single and all forms', async () => {
      const single = await runLookup(createPinnedLookup({}, publicLookupCb), false);
      expect(single).toEqual({ err: null, address: '8.8.8.8', family: 4 });
      const all = await runLookup(createPinnedLookup({}, publicLookupCb), true);
      expect(all.address).toEqual([{ address: '8.8.8.8', family: 4 }]);
    });

    it('passes a DNS error through', async () => {
      const failing = ((_h: string, _o: unknown, cb: (e: Error | null, a: unknown) => void) =>
        cb(new Error('ENOTFOUND'), [])) as never;
      const { err } = await runLookup(createPinnedLookup({}, failing), false);
      expect(err?.message).toBe('ENOTFOUND');
    });

    it('never connects to a rebound private server', async () => {
      let hits = 0;
      const server = http.createServer((_req, res) => { hits++; res.end('secret'); });
      await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
      const port = (server.address() as AddressInfo).port;
      try {
        await expect(pinnedFetch(`http://rebind.example:${port}/`, { allowLocalhost: false }, rebindLookup))
          .rejects.toThrow(SSRFError);
        expect(hits).toBe(0);
      } finally {
        await new Promise((r) => server.close(r));
      }
    });

    it('fetches through the pinned lookup when the address is allowed', async () => {
      const server = http.createServer((_req, res) => { res.setHeader('x-a', '1'); res.end('{"ok":true}'); });
      await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
      const port = (server.address() as AddressInfo).port;
      try {
        const res = await pinnedFetch(`http://pinned.example:${port}/`, { allowPrivateIPs: true }, rebindLookup);
        expect(res.status).toBe(200);
        expect(res.headers.get('x-a')).toBe('1');
        expect(await res.json()).toEqual({ ok: true });
      } finally {
        await new Promise((r) => server.close(r));
      }
    });
  });
});
