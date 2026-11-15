/**
 * Wave 3A P0-2 — canonical host identity for credential routing.
 */
import { describe, expect, it } from 'vitest';
import {
  canonicalizeHost,
  classifyEndpoint,
  hostsMatch,
} from '../../../scripts/rotation/host-identity.mjs';

describe('canonicalizeHost', () => {
  it('lowercases and strips default ports', () => {
    expect(canonicalizeHost('https://API.X.AI:443/v1')).toBe('api.x.ai');
    expect(canonicalizeHost('http://localhost:80/')).toBe('localhost');
  });

  it('maps loopback aliases to localhost', () => {
    expect(canonicalizeHost('http://127.0.0.1:8317/v1')).toBe('localhost:8317');
    expect(canonicalizeHost('http://localhost:8317/v1')).toBe('localhost:8317');
    expect(canonicalizeHost('http://[::1]:8317/v1')).toBe('localhost:8317');
  });

  it('preserves non-default ports', () => {
    expect(canonicalizeHost('https://api.kilo.ai:8443/gateway')).toBe('api.kilo.ai:8443');
  });

  it('returns null for empty input', () => {
    expect(canonicalizeHost('')).toBe(null);
    expect(canonicalizeHost(null)).toBe(null);
    expect(canonicalizeHost(undefined)).toBe(null);
  });
});

describe('hostsMatch', () => {
  it('matches 127.0.0.1 and localhost for cliproxy', () => {
    expect(hostsMatch('http://127.0.0.1:8317/v1', 'http://localhost:8317/v1')).toBe(true);
  });

  it('does not match different families', () => {
    expect(hostsMatch('https://api.x.ai/v1', 'http://localhost:8317/v1')).toBe(false);
    expect(hostsMatch('https://api.kilo.ai/api/gateway', 'https://api.z.ai/api/anthropic')).toBe(
      false,
    );
  });
});

describe('classifyEndpoint', () => {
  it('classifies known families', () => {
    expect(classifyEndpoint('http://localhost:8317/v1')).toBe('cliproxy');
    expect(classifyEndpoint('http://127.0.0.1:8317/v1')).toBe('cliproxy');
    expect(classifyEndpoint('https://api.kilo.ai/api/gateway')).toBe('kilo');
    expect(classifyEndpoint('https://api.z.ai/api/anthropic')).toBe('zai');
    expect(classifyEndpoint('https://api.x.ai/v1')).toBe('xai');
    expect(classifyEndpoint('https://api.deepseek.com/v1')).toBe('deepseek');
    expect(classifyEndpoint('https://example.com/v1')).toBe('unknown');
  });

  it('ignores path injection and lookalike domains (Terra PR#589 high)', () => {
    expect(classifyEndpoint('https://attacker.invalid/127.0.0.1:8317/v1')).toBe('unknown');
    expect(classifyEndpoint('https://evil.example/localhost:8317/creds')).toBe('unknown');
    expect(classifyEndpoint('https://not-kilo.ai.evil/v1')).toBe('unknown');
    expect(classifyEndpoint('https://api.kilo.ai.evil/v1')).toBe('unknown');
    expect(classifyEndpoint('https://api.x.ai.evil/v1')).toBe('unknown');
    expect(classifyEndpoint('https://api.deepseek.com.evil/v1')).toBe('unknown');
    expect(classifyEndpoint('https://deepseek.com/v1')).toBe('unknown');
    expect(classifyEndpoint('http://api.deepseek.com/v1')).toBe('unknown');
    expect(classifyEndpoint('https://api.deepseek.com:8443/v1')).toBe('unknown');
    expect(classifyEndpoint('http://localhost:11434/v1')).toBe('ollama');
    // wrong port on loopback is not cliproxy
    expect(classifyEndpoint('http://localhost:3000/v1')).toBe('unknown');
  });
});
