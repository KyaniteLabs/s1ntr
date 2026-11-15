import { describe, expect, it } from 'vitest';
import SECURITY_HEADERS, {
  P5_SENSOR_POLICY_SCRIPT,
  SECURITY_HEADERS as NAMED_HEADERS,
} from '../../../src/core/wrappers/SecurityHeaders.js';

describe('SecurityHeaders', () => {
  it('default export is the named export', () => {
    expect(SECURITY_HEADERS).toBe(NAMED_HEADERS);
  });

  it('locks the CSP to no network and no default sources', () => {
    expect(NAMED_HEADERS).toContain("default-src 'none'");
    expect(NAMED_HEADERS).toContain("connect-src 'none'");
    expect(NAMED_HEADERS).toContain("img-src 'self' data: blob:");
  });

  it('never allows remote script origins or eval', () => {
    expect(NAMED_HEADERS).not.toMatch(/https?:/);
    expect(NAMED_HEADERS).not.toContain("'unsafe-eval'");
  });

  it('sets nosniff and a strict referrer policy', () => {
    expect(NAMED_HEADERS).toContain('<meta http-equiv="X-Content-Type-Options" content="nosniff">');
    expect(NAMED_HEADERS).toContain('content="strict-origin-when-cross-origin"');
  });

  it('the p5 sensor policy blocks all three motion and orientation events', () => {
    expect(P5_SENSOR_POLICY_SCRIPT).toContain("'devicemotion'");
    expect(P5_SENSOR_POLICY_SCRIPT).toContain("'deviceorientation'");
    expect(P5_SENSOR_POLICY_SCRIPT).toContain("'deviceorientationabsolute'");
    expect(P5_SENSOR_POLICY_SCRIPT.trim().startsWith('<script>')).toBe(true);
    expect(P5_SENSOR_POLICY_SCRIPT.trim().endsWith('</script>')).toBe(true);
  });
});
