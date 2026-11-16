import { describe, expect, it } from 'vitest';
import { generatorRoleNeedsNoKey } from '../../../src/cli/generationKeyPreflight.js';

// #1592: a keyless local config must pass the generate preflight with an empty env.
describe('generation key preflight (#1592)', () => {
  it('a local Ollama generator needs no key', () => {
    expect(generatorRoleNeedsNoKey({ provider: 'ollama', baseUrl: 'http://localhost:11434' })).toBe(true);
    expect(generatorRoleNeedsNoKey({ provider: 'ollama', baseUrl: 'http://127.0.0.1:11434/v1' })).toBe(true);
    expect(generatorRoleNeedsNoKey({ provider: 'ollama', baseUrl: 'http://192.168.1.20:11434' })).toBe(true);
  });

  it('LM Studio and any loopback server need no key', () => {
    expect(generatorRoleNeedsNoKey({ provider: 'lmstudio', baseUrl: 'http://localhost:1234/v1' })).toBe(true);
    expect(generatorRoleNeedsNoKey({ provider: 'openai', baseUrl: 'http://[::1]:8080/v1' })).toBe(true);
  });

  it('pinned keys and cli:// seats carry their own auth', () => {
    expect(generatorRoleNeedsNoKey({ provider: 'anthropic', baseUrl: 'https://api.anthropic.com/v1', apiKey: 'k' })).toBe(true);
    expect(generatorRoleNeedsNoKey({ baseUrl: 'cli://claude' })).toBe(true);
  });

  it('hosted providers without a key still go to the key check', () => {
    expect(generatorRoleNeedsNoKey({ provider: 'anthropic', baseUrl: 'https://api.anthropic.com/v1' })).toBe(false);
    expect(generatorRoleNeedsNoKey({ provider: 'ollama', baseUrl: 'https://ollama.com/v1' })).toBe(false);
    expect(generatorRoleNeedsNoKey({ provider: 'openai', baseUrl: 'https://localhost.evil.example/v1' })).toBe(false);
    expect(generatorRoleNeedsNoKey(null)).toBe(false);
    expect(generatorRoleNeedsNoKey({ provider: 'ollama', baseUrl: 'not a url' })).toBe(false);
  });
});
