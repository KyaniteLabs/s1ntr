import { describe, expect, it } from 'vitest';
import { LLMClient } from '../../../src/llm/LLMClient.js';
import { CliProvider } from '../../../src/llm/providers/CliProvider.js';
import type { BaseProvider } from '../../../src/llm/providers/BaseProvider.js';

function providerFor(baseUrl: string): Promise<BaseProvider> {
  const client = new LLMClient({ baseUrl, model: 'fixture-model' });
  return (client as unknown as { getProvider(): Promise<BaseProvider> }).getProvider();
}

describe('subscription CLI routing', () => {
  it('creates the CLI provider without resolving its executable as a DNS hostname', async () => {
    await expect(providerFor('cli://command-code/chat/completions')).resolves.toBeInstanceOf(CliProvider);
    await expect(providerFor('cli://codex/chat/completions')).resolves.toBeInstanceOf(CliProvider);
    await expect(providerFor('cli://command-code')).resolves.toBeInstanceOf(CliProvider);
  });

  it('still blocks a forbidden HTTP endpoint', async () => {
    await expect(providerFor('http://169.254.169.254/v1')).rejects.toThrow(/SSRF Protection/);
    await expect(providerFor('cli://arbitrary-command/chat/completions')).rejects.toThrow(/SSRF Protection/);
  });
});
