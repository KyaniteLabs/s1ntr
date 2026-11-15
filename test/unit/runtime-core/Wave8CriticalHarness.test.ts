import { describe, expect, it } from 'vitest';
import {
  canonicalWave8CriticalHarnessModel,
  isWave8CriticalHarnessModel,
  WAVE8_CRITICAL_HARNESS_MODEL,
  wave8CriticalHarnessModelFromExecutor,
} from '../../../src/runtime-core/Wave8CriticalHarness.js';

describe('Wave8CriticalHarness', () => {
  it('canonical id is kimi-k3', () => {
    expect(WAVE8_CRITICAL_HARNESS_MODEL).toBe('kimi-k3');
  });

  it('accepts only the bare and gateway-prefixed kimi-k3 ids', () => {
    expect(isWave8CriticalHarnessModel('kimi-k3')).toBe(true);
    expect(isWave8CriticalHarnessModel('moonshotai/kimi-k3')).toBe(true);
    expect(isWave8CriticalHarnessModel('Kimi-K3')).toBe(false);
    expect(isWave8CriticalHarnessModel('gpt-5.6-sol')).toBe(false);
    expect(isWave8CriticalHarnessModel('')).toBe(false);
  });

  it('normalizes aliases to the canonical id', () => {
    expect(canonicalWave8CriticalHarnessModel('moonshotai/kimi-k3')).toBe('kimi-k3');
    expect(canonicalWave8CriticalHarnessModel('kimi-k3')).toBe('kimi-k3');
  });

  it('refuses to canonicalize a non-harness model (Sol approvals are not invented)', () => {
    expect(() => canonicalWave8CriticalHarnessModel('gpt-5.6-sol')).toThrow('not a Wave 8 critical harness model: gpt-5.6-sol');
  });

  describe('wave8CriticalHarnessModelFromExecutor', () => {
    it.each(['kimi-k3', 'cliproxy-kimi', 'kimi-cli', 'kimi-k3-cli'])('binds executor %s to the harness', (executor) => {
      expect(wave8CriticalHarnessModelFromExecutor(executor, 'whatever')).toBe('kimi-k3');
    });

    it('keeps the reviewer model verbatim when it is itself a harness alias', () => {
      expect(wave8CriticalHarnessModelFromExecutor('kimi-cli', 'moonshotai/kimi-k3')).toBe('moonshotai/kimi-k3');
    });

    it('accepts a harness model id passed as the executor', () => {
      expect(wave8CriticalHarnessModelFromExecutor('moonshotai/kimi-k3', 'x')).toBe('moonshotai/kimi-k3');
    });

    it('returns undefined for other executors and for null/undefined', () => {
      expect(wave8CriticalHarnessModelFromExecutor('codex-sol', 'kimi-k3')).toBeUndefined();
      expect(wave8CriticalHarnessModelFromExecutor(undefined, 'kimi-k3')).toBeUndefined();
      expect(wave8CriticalHarnessModelFromExecutor(null, 'kimi-k3')).toBeUndefined();
    });
  });
});
