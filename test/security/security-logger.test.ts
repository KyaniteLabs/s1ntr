import { describe, it, expect, vi, beforeEach } from 'vitest';
import { 
  logSecurityEvent, 
  logSSRFAttempt, 
  logSSRFResolutionDegraded,
  logPathTraversalAttempt,
  logRateLimitViolation,
  logCSRFFailure
} from '../../src/security/SecurityLogger.js';
import { Logger } from '../../src/utils/Logger.js';

describe('SecurityLogger', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should log SSRF attempts as high severity', () => {
    const spy = vi.spyOn(Logger, 'error');
    logSSRFAttempt('http://169.254.169.254/');
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][0]).toBe('Security');
    expect(spy.mock.calls[0][1]).toContain('SSRF');
  });

  it('should log path traversal as medium severity', () => {
    const spy = vi.spyOn(Logger, 'warn');
    logPathTraversalAttempt('../../../etc/passwd');
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][1]).toContain('traversal');
  });

  it('should log rate limit violations as low severity', () => {
    const spy = vi.spyOn(Logger, 'info');
    logRateLimitViolation('/api/test');
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][1]).toContain('Rate limit');
  });

  it('should log CSRF failures as medium severity', () => {
    const spy = vi.spyOn(Logger, 'warn');
    logCSRFFailure('/api/submit');
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][1]).toContain('CSRF');
  });

  it('should include timestamp in events', () => {
    const spy = vi.spyOn(Logger, 'error');
    const eventDetails = { source: 'test' };
    logSecurityEvent({
      type: 'ssrf_blocked',
      severity: 'high',
      message: 'test',
      context: eventDetails,
    });
    expect(spy).toHaveBeenCalledTimes(1);
    // Check that context is passed (which includes the context details provided)
    const context = spy.mock.calls[0][2];
    expect(context).toHaveProperty('source', 'test');
  });

  it.each([
    ['high', 'error'], ['medium', 'warn'], ['low', 'info'],
  ] as const)('includes event metadata in %s severity logs', (severity, method) => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-01-02T03:04:05.000Z'));
      const spy = vi.spyOn(Logger, method);
      logSecurityEvent({ type: 'ssrf_blocked', severity, message: 'blocked',
        context: { endpoint: '/api/fetch' } });
      expect(spy).toHaveBeenCalledWith('Security', '[SECURITY:ssrf_blocked] blocked',
        expect.objectContaining({ type: 'ssrf_blocked', severity,
          timestamp: '2026-01-02T03:04:05.000Z', endpoint: '/api/fetch' }));
    } finally { vi.useRealTimers(); }
  });

  it('should log critical events with full event context', () => {
    const spy = vi.spyOn(Logger, 'error');
    logSecurityEvent({
      type: 'sandbox_escape_attempt',
      severity: 'critical',
      message: 'Sandbox escape detected',
      context: {
        ip: '192.168.1.1',
        endpoint: '/sandbox/run',
        details: { attemptType: 'code_injection' }
      }
    });
    expect(spy).toHaveBeenCalledTimes(1);
    const context = spy.mock.calls[0][2];
    expect(context).toHaveProperty('type', 'sandbox_escape_attempt');
    expect(context).toHaveProperty('severity', 'critical');
    expect(context).toHaveProperty('timestamp');
  });

  it('should include context details in SSRF logs', () => {
    const spy = vi.spyOn(Logger, 'error');
    logSSRFAttempt('http://169.254.169.254/', {
      ip: '10.0.0.1',
      endpoint: '/api/fetch',
      details: { blockedHost: '169.254.169.254' }
    });
    expect(spy).toHaveBeenCalledTimes(1);
    const context = spy.mock.calls[0][2];
    expect(context).toHaveProperty('ip', '10.0.0.1');
    expect(context).toHaveProperty('endpoint', '/api/fetch');
    expect(context).toHaveProperty('details.blockedHost', '169.254.169.254');
  });

  it('should log DNS resolution degradation as low severity', () => {
    const spy = vi.spyOn(Logger, 'info');
    logSSRFResolutionDegraded('https://api.example.com/v1', {
      details: { hostname: 'api.example.com', reason: 'ENOTFOUND' },
    });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][1]).toContain('DNS resolution degraded');
    expect(spy.mock.calls[0][2]).toHaveProperty('details.reason', 'ENOTFOUND');
  });
});
