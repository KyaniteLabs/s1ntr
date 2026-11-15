// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { installGuiAuth, readGuiToken } from '../../../gui/src/gui/guiAuth.js';

function memoryStorage(seed: Record<string, string> = {}) {
  const data = new Map(Object.entries(seed));
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => { data.set(key, value); },
    dump: () => Object.fromEntries(data),
  };
}

describe('Studio auth token plumbing', () => {
  it('moves ?token= into storage and out of the URL', () => {
    const storage = memoryStorage();
    const replaceUrl = vi.fn();
    const result = readGuiToken({
      href: 'http://127.0.0.1:5174/?token=secret-token&x=1',
      storage,
      replaceUrl,
    });

    expect(result.token).toBe('secret-token');
    expect(storage.dump().liminalGuiToken).toBe('secret-token');
    expect(replaceUrl).toHaveBeenCalledWith('http://127.0.0.1:5174/?x=1');
    expect(result.href).not.toContain('secret-token');
  });

  it('falls back to the stored token on later loads', () => {
    const result = readGuiToken({
      href: 'http://127.0.0.1:5174/',
      storage: memoryStorage({ liminalGuiToken: 'stored-token' }),
      replaceUrl: vi.fn(),
    });
    expect(result.token).toBe('stored-token');
  });

  it('attaches the bearer token to same-origin /api requests only', async () => {
    const storage = memoryStorage({ liminalGuiToken: 'secret-token' });
    const fetch = vi.fn(async () => new Response('ok'));
    installGuiAuth({ href: 'http://127.0.0.1:5174/', storage, replaceUrl: vi.fn(), fetch });

    await window.fetch('/api/preview/run', { method: 'POST' });
    await window.fetch('http://127.0.0.1:5174/api/config', { method: 'POST' });
    await window.fetch('https://example.invalid/api/config', { method: 'POST' });
    await window.fetch('/assets/logo.svg');

    const headersFor = (call: number) => new Headers((fetch.mock.calls[call]![1] as RequestInit).headers);
    // Call 0 is the session cookie exchange, sent before any API request.
    expect(fetch.mock.calls[0]![0]).toBe('http://127.0.0.1:5174/api/auth/session');
    expect((fetch.mock.calls[0]![1] as RequestInit).method).toBe('POST');
    expect(headersFor(0).get('Authorization')).toBe('Bearer secret-token');
    expect(headersFor(1).get('Authorization')).toBe('Bearer secret-token');
    expect(headersFor(2).get('Authorization')).toBe('Bearer secret-token');
    expect(headersFor(3).get('Authorization')).toBeNull();
    expect(headersFor(4).get('Authorization')).toBeNull();
  });

  it('still sends API requests when the session exchange fails', async () => {
    const storage = memoryStorage({ liminalGuiToken: 'secret-token' });
    const fetch = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).endsWith('/api/auth/session')) throw new TypeError('offline');
      return new Response('ok');
    });
    installGuiAuth({ href: 'http://127.0.0.1:5174/', storage, replaceUrl: vi.fn(), fetch });

    const response = await window.fetch('/api/config');
    expect(await response.text()).toBe('ok');
    expect(fetch.mock.calls[1]![0]).toBe('/api/config');
  });
});

