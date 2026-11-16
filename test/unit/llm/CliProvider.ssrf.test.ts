import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { bootstrapExecutorAuthority, classifyProviderSurface } from '../../../src/identity/executorAuthorityBootstrap.js';
import { LLMClient } from '../../../src/llm/LLMClient.js';
import { CliProvider } from '../../../src/llm/providers/CliProvider.js';
import { OpenAIProvider } from '../../../src/llm/providers/OpenAIProvider.js';

const providerOf = (client: LLMClient): Promise<unknown> =>
  (client as unknown as { getProvider(): Promise<unknown> }).getProvider();

describe('local CLI provider URL validation', () => {
  it('lets an exact local Codex adapter reach CliProvider', async () => {
    const client = new LLMClient({
      role: 'generator', provider: 'cli', baseUrl: 'cli://codex', model: 'gpt-6-luna',
    });
    await expect(providerOf(client)).resolves.toBeInstanceOf(CliProvider);
  });

  it('attests a local Codex subscription command as a generator', async () => {
    expect(classifyProviderSurface('cli', 'cli://codex', { model: 'gpt-6-luna' }))
      .toBe('codex-cli-seat');
    expect(classifyProviderSurface('cli', 'cli://codex/chat/completions', { model: 'gpt-6-luna' }))
      .toBe('codex-cli-seat');
    expect(classifyProviderSurface('cli', 'cli://codex/other/chat/completions', { model: 'gpt-6-luna' }))
      .toBe('unknown');
    expect(classifyProviderSurface('cli', 'cli://codex', { model: 'gpt-6.1-terra' }))
      .toBe('codex-cli-seat');
    expect(classifyProviderSurface('cli', 'cli://codex', { model: 'unknown' }))
      .toBe('unknown');
    const directory = mkdtempSync(join(tmpdir(), 'codex-cli-provider-'));
    const executable = join(directory, 'codex');
    writeFileSync(executable, `#!/bin/sh\ncat >/dev/null\nprintf '%s\\n' '{"type":"item.completed","item":{"type":"agent_message","text":"generated artwork"}}'\n`);
    chmodSync(executable, 0o700);
    const previousCodexBin = process.env.CODEX_BIN;
    process.env.CODEX_BIN = executable;
    try {
      const authority = bootstrapExecutorAuthority({ rootDir: join(directory, 'authority') });
      const client = new LLMClient({
        role: 'generator', provider: 'cli', baseUrl: 'cli://codex/chat/completions',
        model: 'gpt-6-luna', timeout: 3000, harnessTransportAuthority: authority,
      });
      const result = await client.complete({ systemPrompt: 'system', prompt: 'art' });
      expect(result).toMatchObject({ success: true, provider: 'cli', text: 'generated artwork' });
      expect(client.getHarnessExecutorProjection()).toMatchObject({
        status: 'verified', attempts: [{ attestation: { subject: {
          surface: 'codex-cli-seat', funding: { mode: 'subscription-seat', quotaSurface: 'codex-cli-seat' },
        } } }],
      });
    } finally {
      if (previousCodexBin === undefined) delete process.env.CODEX_BIN;
      else process.env.CODEX_BIN = previousCodexBin;
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('attests the exact AGY Gemini medium seat as a generator', async () => {
    expect(classifyProviderSurface('cli', 'cli://agy', { model: 'gemini-3.7-flash-medium' }))
      .toBe('agy-cli-seat');
    expect(classifyProviderSurface('cli', 'cli://agy/chat/completions', { model: 'gemini-3.7-flash-medium' }))
      .toBe('agy-cli-seat');
    expect(classifyProviderSurface('cli', 'cli://agy', { model: 'gemini-3.8-flash-high' }))
      .toBe('unknown');
    const directory = mkdtempSync(join(tmpdir(), 'agy-cli-provider-'));
    const executable = join(directory, 'agy');
    writeFileSync(executable, '#!/bin/sh\nprintf "generated artwork"\n');
    chmodSync(executable, 0o700);
    const previousPath = process.env.PATH;
    process.env.PATH = `${directory}:${previousPath ?? ''}`;
    try {
      const authority = bootstrapExecutorAuthority({ rootDir: join(directory, 'authority') });
      const client = new LLMClient({ role: 'generator', provider: 'cli', baseUrl: 'cli://agy/chat/completions',
        model: 'gemini-3.7-flash-medium', harnessTransportAuthority: authority });
      const result = await client.complete({ systemPrompt: 'system', prompt: 'art' });
      expect(result).toMatchObject({ success: true, provider: 'cli', text: 'generated artwork' });
      expect(client.getHarnessExecutorProjection()).toMatchObject({ status: 'verified',
        attempts: [{ attestation: { subject: { surface: 'agy-cli-seat',
          funding: { mode: 'subscription-seat', quotaSurface: 'agy-cli-seat' } } } }] });
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('attests the exact command-code DeepSeek seat as a generator', async () => {
    expect(classifyProviderSurface('cli', 'cli://command-code', { model: 'deepseek/deepseek-v4-pro' }))
      .toBe('command-code-cli-seat');
    expect(classifyProviderSurface('cli', 'cli://command-code/chat/completions', { model: 'deepseek/deepseek-v4-pro' }))
      .toBe('command-code-cli-seat');
    expect(classifyProviderSurface('cli', 'cli://command-code/chat/completions', { model: 'deepseek/deepseek-v4.1-flash' }))
      .toBe('unknown');
    expect(classifyProviderSurface('cli', 'cli://command-code', { model: 'deepseek/other' }))
      .toBe('unknown');
    const directory = mkdtempSync(join(tmpdir(), 'command-code-cli-provider-'));
    const executable = join(directory, 'command-code');
    writeFileSync(executable, '#!/bin/sh\nprintf "generated artwork"\n');
    chmodSync(executable, 0o700);
    const previousPath = process.env.PATH;
    process.env.PATH = `${directory}:${previousPath ?? ''}`;
    try {
      const authority = bootstrapExecutorAuthority({ rootDir: join(directory, 'authority') });
      const client = new LLMClient({ role: 'generator', provider: 'cli', baseUrl: 'cli://command-code/chat/completions',
        model: 'deepseek/deepseek-v4-pro', harnessTransportAuthority: authority });
      const result = await client.complete({ systemPrompt: 'system', prompt: 'art' });
      expect(result).toMatchObject({ success: true, provider: 'cli', text: 'generated artwork' });
      expect(client.getHarnessExecutorProjection()).toMatchObject({ status: 'verified',
        attempts: [{ attestation: { subject: { surface: 'command-code-cli-seat',
          resolvedIdentity: { provider: 'openai', model: 'deepseek-v4-pro' },
          funding: { mode: 'subscription-seat', quotaSurface: 'command-code-cli-seat' } } } }] });
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('keeps arbitrary CLI endpoints inside SSRF validation', async () => {
    const client = new LLMClient({
      role: 'generator', provider: 'cli', baseUrl: 'cli://127.0.0.1', model: 'test',
    });
    await expect(providerOf(client)).rejects.toThrow('SSRF Protection');
  });
});

describe('declared local LLM endpoint URL validation', () => {
  it('lets a declared LM Studio server on loopback through on any port', async () => {
    const client = new LLMClient({ role: 'generator', provider: 'lmstudio',
      baseUrl: 'http://127.0.0.1:46407/v1', model: '/srv/models/lfm3/LFM3-1.7B-Q4_K_M.gguf' });
    await expect(providerOf(client)).resolves.toBeInstanceOf(OpenAIProvider);
  });

  it('refuses loopback on an unlisted port when no local provider is declared', async () => {
    const client = new LLMClient({ role: 'generator', provider: 'openai',
      baseUrl: 'http://127.0.0.1:46407/v1', model: 'gpt-4o' });
    await expect(providerOf(client)).rejects.toThrow('SSRF Protection: Access to private IP 127.0.0.1');
  });

  it('refuses a declared local provider on a private address that is not loopback', async () => {
    const client = new LLMClient({ role: 'generator', provider: 'lmstudio',
      baseUrl: 'http://10.0.0.5:1234/v1', model: 'lfm3' });
    await expect(providerOf(client)).rejects.toThrow('SSRF Protection: Access to private IP 10.0.0.5');
  });
});
