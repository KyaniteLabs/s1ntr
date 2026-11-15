import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NimaService, isValidNimaScore, scoreImage } from '../../../src/learning/NimaService.js';

const fetchMock = vi.fn();
const ok = (body: unknown) => ({ ok: true, json: () => Promise.resolve(body) });
const IMG = Buffer.from('png-bytes');

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  (NimaService as unknown as { instance: unknown }).instance = null;
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('isValidNimaScore', () => {
  it.each([1, 5.5, 10])('accepts %s', v => expect(isValidNimaScore(v)).toBe(true));
  it.each([0.99, 10.01, NaN, Infinity, '7', null, undefined])('rejects %s', v => expect(isValidNimaScore(v)).toBe(false));
});

describe('NimaService.isAvailable', () => {
  it('is true when /health answers ok, and caches for 60 seconds', async () => {
    vi.useFakeTimers();
    fetchMock.mockResolvedValue({ ok: true });
    const svc = new NimaService();
    expect(await svc.isAvailable()).toBe(true);
    expect(fetchMock.mock.calls[0][0]).toBe('http://127.0.0.1:8765/health');
    vi.advanceTimersByTime(59_000);
    expect(await svc.isAvailable()).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(2_000);
    await svc.isAvailable();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('is false on a non-ok health response or a network error', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false });
    expect(await new NimaService().isAvailable()).toBe(false);
    fetchMock.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    expect(await new NimaService().isAvailable()).toBe(false);
  });
});

describe('NimaService.score', () => {
  it('returns null without calling /score when the service is down', async () => {
    fetchMock.mockRejectedValue(new Error('down'));
    expect(await new NimaService().score(IMG)).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('posts the raw bytes and returns score and histogram', async () => {
    fetchMock.mockResolvedValueOnce({ ok: true }).mockResolvedValueOnce(ok({ score: 6.28, histogram: [0.1, 0.9] }));
    const res = await new NimaService().score(new Uint8Array([1, 2, 3]));
    expect(res).toEqual({ score: 6.28, histogram: [0.1, 0.9] });
    const [url, init] = fetchMock.mock.calls[1];
    expect(url).toBe('http://127.0.0.1:8765/score');
    expect(init.method).toBe('POST');
    expect(Buffer.isBuffer(init.body)).toBe(true);
    expect([...init.body]).toEqual([1, 2, 3]);
  });

  it.each([
    ['an HTTP error', { ok: false }],
    ['an out-of-range score', ok({ score: 11 })],
    ['a missing score', ok({})],
  ])('returns null for %s', async (_name, response) => {
    fetchMock.mockResolvedValueOnce({ ok: true }).mockResolvedValueOnce(response);
    expect(await new NimaService().score(IMG)).toBeNull();
  });

  it('returns null when the request throws', async () => {
    fetchMock.mockResolvedValueOnce({ ok: true }).mockRejectedValueOnce(new Error('reset'));
    expect(await new NimaService().score(IMG)).toBeNull();
  });
});

describe('NimaService.scoreBatch', () => {
  it('sends base64 images and returns the scores in order', async () => {
    fetchMock.mockResolvedValueOnce({ ok: true }).mockResolvedValueOnce(ok({ scores: [4, 8.5] }));
    const res = await new NimaService().scoreBatch([IMG, new Uint8Array([0xff])]);
    expect(res).toEqual([4, 8.5]);
    const [url, init] = fetchMock.mock.calls[1];
    expect(url).toBe('http://127.0.0.1:8765/batch');
    expect(JSON.parse(init.body)).toEqual([IMG.toString('base64'), '/w==']);
  });

  it('returns null for an empty batch without calling /batch', async () => {
    expect(await new NimaService().scoreBatch([])).toBeNull();
    expect(fetchMock.mock.calls.map(c => c[0])).not.toContain('http://127.0.0.1:8765/batch');
  });

  it.each([
    ['a wrong-length score list', { scores: [5] }],
    ['an invalid score inside the list', { scores: [5, 0] }],
    ['a missing scores field', {}],
  ])('returns null for %s', async (_name, body) => {
    fetchMock.mockResolvedValueOnce({ ok: true }).mockResolvedValueOnce(ok(body));
    expect(await new NimaService().scoreBatch([IMG, IMG])).toBeNull();
  });
});

describe('singleton and scoreImage', () => {
  it('getInstance returns one shared instance', () => {
    expect(NimaService.getInstance()).toBe(NimaService.getInstance());
  });

  it('scoreImage unwraps the score, or null when scoring fails', async () => {
    fetchMock.mockResolvedValueOnce({ ok: true }).mockResolvedValueOnce(ok({ score: 7.1 }));
    expect(await scoreImage(IMG)).toBe(7.1);
    (NimaService as unknown as { instance: unknown }).instance = null;
    fetchMock.mockRejectedValue(new Error('down'));
    expect(await scoreImage(IMG)).toBeNull();
  });
});
