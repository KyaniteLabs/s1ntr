import { afterEach, describe, expect, it, vi } from 'vitest';
import { SecurityLogger } from '../../src/security/SecurityLogger.js';
import { Logger } from '../../src/utils/Logger.js';

describe('SIEM delivery recovery', () => {
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

  it('counts consecutive failures and resets after a successful delivery', async () => {
    const fetch = vi.fn().mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce({ ok: false, status: 503 })
      .mockResolvedValueOnce({ ok: true })
      .mockRejectedValueOnce(new Error('offline again'));
    vi.stubGlobal('fetch', fetch);
    const error = vi.spyOn(Logger, 'error').mockImplementation(() => {});
    const logger = new SecurityLogger({ enableSIEM: true,
      siemEndpoint: 'https://siem.example.test/events' });
    for (let index = 0; index < 4; index++) {
      logger.logRateLimitViolation('/api/test');
      await vi.waitFor(() => { expect(fetch).toHaveBeenCalledTimes(index + 1); });
      await new Promise<void>(resolve => setImmediate(resolve));
    }
    expect(error.mock.calls).toEqual([
      ['SecurityLogger', 'SIEM delivery failed (consecutive: 1): offline'],
      ['SecurityLogger', 'SIEM delivery failed (consecutive: 2): SIEM returned 503'],
      ['SecurityLogger', 'SIEM delivery failed (consecutive: 1): offline again'],
    ]);
  });

  it('does not let a slow failure extend the streak past a newer success', async () => {
    let failSlow!: (error: Error) => void;
    const fetch = vi.fn()
      .mockReturnValueOnce(new Promise((_, reject) => { failSlow = reject; }))
      .mockResolvedValueOnce({ ok: true })
      .mockRejectedValueOnce(new Error('offline'));
    vi.stubGlobal('fetch', fetch);
    const error = vi.spyOn(Logger, 'error').mockImplementation(() => {});
    const logger = new SecurityLogger({ enableSIEM: true,
      siemEndpoint: 'https://siem.example.test/events' });
    logger.logRateLimitViolation('/slow');
    logger.logRateLimitViolation('/fast');
    await vi.waitFor(() => { expect(fetch).toHaveBeenCalledTimes(2); });
    await new Promise<void>(resolve => setImmediate(resolve));
    failSlow(new Error('slow timeout'));
    await new Promise<void>(resolve => setImmediate(resolve));
    logger.logRateLimitViolation('/next');
    await vi.waitFor(() => { expect(error).toHaveBeenCalledTimes(2); });
    expect(error.mock.calls).toEqual([
      ['SecurityLogger', 'SIEM delivery failed (a later delivery succeeded): slow timeout'],
      ['SecurityLogger', 'SIEM delivery failed (consecutive: 1): offline'],
    ]);
  });

  it.each([undefined, { enableSIEM: false,
    siemEndpoint: 'https://siem.example.test/events' }, { enableSIEM: true }])(
    'does not send when forwarding is disabled or has no endpoint (%j)', config => {
      const fetch = vi.fn();
      vi.stubGlobal('fetch', fetch);
      new SecurityLogger(config).logRateLimitViolation('/api/test');
      expect(fetch).toHaveBeenCalledTimes(0);
    });

  it('keeps failure counts separate for each logger', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
    const error = vi.spyOn(Logger, 'error').mockImplementation(() => {});
    const config = { enableSIEM: true,
      siemEndpoint: 'https://siem.example.test/events' };
    const first = new SecurityLogger(config);
    const second = new SecurityLogger(config);
    first.logRateLimitViolation('/first');
    second.logRateLimitViolation('/second');
    await vi.waitFor(() => { expect(error).toHaveBeenCalledTimes(2); });
    expect(error.mock.calls).toEqual([
      ['SecurityLogger', 'SIEM delivery failed (consecutive: 1): offline'],
      ['SecurityLogger', 'SIEM delivery failed (consecutive: 1): offline'],
    ]);
  });
});
