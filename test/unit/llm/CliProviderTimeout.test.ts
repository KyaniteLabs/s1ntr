import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CliProvider } from '../../../src/llm/providers/CliProvider.js';
import type { ProviderRequest } from '../../../src/llm/ProviderTypes.js';

// #1613: a CLI killed at its timeout is a timeout, never "empty stdout" or a success.
// Seen live: codex at cli://codex/xhigh traps SIGTERM, exits 0 with no output,
// and the run reported "cli:codex returned empty stdout" after exactly 900 s.

class TestCliProvider extends CliProvider {
  run(request: ProviderRequest) { return this.generateImpl(request); }
}

const dirs: string[] = [];
const previousBin = process.env.CODEX_BIN;
afterEach(async () => {
  if (previousBin === undefined) delete process.env.CODEX_BIN;
  else process.env.CODEX_BIN = previousBin;
  await Promise.all(dirs.splice(0).map(d => rm(d, { recursive: true, force: true })));
});

async function fixture(body: string): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'sinter-cli-timeout-'));
  dirs.push(directory);
  const executable = path.join(directory, 'codex-fixture');
  await writeFile(executable, `#!/usr/bin/env node\n${body}\n`);
  await chmod(executable, 0o755);
  return executable;
}

const request = { systemPrompt: '', userPrompt: 'art' } as ProviderRequest;

describe('CLI transport timeout', () => {
  it('reports a child that traps SIGTERM and exits 0 as a timeout', async () => {
    process.env.CODEX_BIN = await fixture(
      'process.on("SIGTERM", () => process.exit(0)); setTimeout(() => {}, 10000);');
    const provider = new TestCliProvider({ baseUrl: 'cli://codex', model: 'gpt-5.6-terra', timeout: 300 } as never);
    const result = await provider.run(request);
    expect(result.isErr() && result.error.message).toBe('cli:codex timed out after 300 ms (killed; output discarded)');
    // Never retried: one CLI seat call can be a 15-minute premium prompt.
    expect(result.isErr() && result.error.retryable).toBe(false);
  });

  it('reports partial stdout from a child killed at the timeout as a timeout, not art', async () => {
    process.env.CODEX_BIN = await fixture(
      'process.stdout.write("function setup() {"); process.on("SIGTERM", () => process.exit(0)); setTimeout(() => {}, 10000);');
    const provider = new TestCliProvider({ baseUrl: 'cli://codex', model: 'gpt-5.6-terra', timeout: 300 } as never);
    const result = await provider.run(request);
    expect(result.isErr() && result.error.message).toMatch(/^cli:codex timed out after 300 ms/);
  });

  it('still returns the output of a child that finishes in time', async () => {
    process.env.CODEX_BIN = await fixture('process.stdout.write(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "art" } }));');
    const provider = new TestCliProvider({ baseUrl: 'cli://codex', model: 'gpt-5.6-terra', timeout: 5000 } as never);
    const result = await provider.run(request);
    expect(result.isOk() && result.value.content).toBe('art');
  });
});

// #1630: a failed seat reports the exit and the stderr tail, never the prompt.
describe('CLI transport failure message', () => {
  it('keeps the end of a long stderr and leaves the prompt out', async () => {
    process.env.CODEX_BIN = await fixture(
      'process.stderr.write("noise ".repeat(500) + "FINAL: unrecognized_model {\\"model\\":\\"x-1\\"}"); process.exit(3);');
    const provider = new TestCliProvider({ baseUrl: 'cli://codex', model: 'gpt-5.6-terra', timeout: 5000 } as never);
    const result = await provider.run({ systemPrompt: '', userPrompt: 'SECRET-PROMPT-BODY' } as ProviderRequest);
    const message = result.isErr() ? result.error.message : '';
    expect(message).toMatch(/^cli:codex failed \(exit 3\): …/);
    expect(message).toContain('FINAL: unrecognized_model {"model":"x-1"}');
    expect(message).not.toContain('SECRET-PROMPT-BODY');
  });

  it('says so when the CLI wrote nothing to stderr', async () => {
    process.env.CODEX_BIN = await fixture('process.exit(2);');
    const provider = new TestCliProvider({ baseUrl: 'cli://codex', model: 'gpt-5.6-terra', timeout: 5000 } as never);
    const result = await provider.run(request);
    expect(result.isErr() && result.error.message).toBe('cli:codex failed (exit 2): no stderr');
  });
});
