import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CliProvider, parseCodexExecJson } from '../../../src/llm/providers/CliProvider.js';
import type { ProviderRequest } from '../../../src/llm/ProviderTypes.js';

// #1656: a CLI seat reports the tokens the CLI printed, or nothing; never a proxy zero.
class TestCliProvider extends CliProvider {
  run(request: ProviderRequest) { return this.generateImpl(request); }
}

const FIXTURE = path.resolve(__dirname, '../../fixtures/cli/codex-exec-json-0.167.1.jsonl');
const KEYS = ['CODEX_BIN', 'CODEX_HOME'];
const request = { systemPrompt: '', userPrompt: 'say OK' } as ProviderRequest;
let saved: Record<string, string | undefined>;
let directory: string;

const stub = async (name: string, body: string) => {
  const executable = path.join(directory, name);
  await writeFile(executable, `#!/bin/sh\n${body}\n`);
  await chmod(executable, 0o700);
  return executable;
};

beforeEach(async () => {
  saved = Object.fromEntries(KEYS.map((key) => [key, process.env[key]]));
  directory = await mkdtemp(path.join(os.tmpdir(), 'sinter-cli-usage-'));
  process.env.CODEX_HOME = path.join(directory, 'no-codex-home');
});

afterEach(async () => {
  for (const key of KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  await rm(directory, { recursive: true, force: true });
});

describe('parseCodexExecJson', () => {
  it('reads the answer and real token counts from a captured codex 0.167.1 run', () => {
    const parsed = parseCodexExecJson(readFileSync(FIXTURE, 'utf8'));
    expect(parsed._unsafeUnwrap()).toEqual({
      content: 'OK',
      usage: { inputTokens: 21968, outputTokens: 5, thinkingTokens: 0 },
    });
  });

  it('takes the last agent_message and skips non-JSON lines and other items', () => {
    const out = [
      'warning: not json',
      '{"type":"item.completed","item":{"type":"reasoning","text":"hm"}}',
      '{"type":"item.completed","item":{"type":"agent_message","text":"draft"}}',
      '{"type":"item.completed","item":{"type":"command_execution","command":"ls"}}',
      '{"type":"item.completed","item":{"type":"agent_message","text":"final"}}',
      '{"type":"turn.completed","usage":{"input_tokens":10,"output_tokens":4}}',
    ].join('\n');
    expect(parseCodexExecJson(out)._unsafeUnwrap()).toEqual({
      content: 'final',
      usage: { inputTokens: 10, outputTokens: 4 },
    });
  });

  it('keeps output_tokens whole and reports reasoning as its subset (synthetic line, OpenAI convention)', () => {
    const out = [
      '{"type":"item.completed","item":{"type":"agent_message","text":"hi"}}',
      '{"type":"turn.completed","usage":{"input_tokens":100,"output_tokens":50,"reasoning_output_tokens":20}}',
    ].join('\n');
    expect(parseCodexExecJson(out)._unsafeUnwrap().usage).toEqual({ inputTokens: 100, outputTokens: 50, thinkingTokens: 20 });
  });

  it('turn.failed with no agent_message returns the real cause', () => {
    const out = '{"type":"turn.started"}\n{"type":"turn.failed","error":{"message":"usage limit reached"}}';
    expect(parseCodexExecJson(out)._unsafeUnwrapErr()).toMatch(/usage limit reached/);
  });

  it('an agent_message followed by turn.failed is a failure, not a success', () => {
    const out = [
      '{"type":"item.completed","item":{"type":"agent_message","text":"partial"}}',
      '{"type":"turn.failed","error":{"message":"stream disconnected"}}',
    ].join('\n');
    expect(parseCodexExecJson(out)._unsafeUnwrapErr()).toMatch(/stream disconnected/);
  });

  it('an error event with no answer carries its message', () => {
    expect(parseCodexExecJson('{"type":"error","message":"bad auth"}')._unsafeUnwrapErr()).toMatch(/bad auth/);
  });

  it('returns usage undefined when any completed turn lacked usage, never a partial sum', () => {
    const out = [
      '{"type":"item.completed","item":{"type":"agent_message","text":"hi"}}',
      '{"type":"turn.completed","usage":{"input_tokens":10,"output_tokens":4}}',
      '{"type":"turn.completed","usage":{"input_tokens":"x"}}',
    ].join('\n');
    expect(parseCodexExecJson(out)._unsafeUnwrap()).toEqual({ content: 'hi' });
  });

  it('leaves usage undefined when no turn.completed arrived, and errors without an agent_message', () => {
    const noUsage = '{"type":"item.completed","item":{"type":"agent_message","text":"hi"}}';
    expect(parseCodexExecJson(noUsage)._unsafeUnwrap()).toEqual({ content: 'hi' });
    expect(parseCodexExecJson('{"type":"turn.started"}\nplain text').isErr()).toBe(true);
  });
});

describe('CliProvider usage', () => {
  it('codex seat returns the usage codex printed', async () => {
    process.env.CODEX_BIN = await stub('codex-fixture', `cat '${FIXTURE}'`);
    const result = await new TestCliProvider({ baseUrl: 'cli://codex', model: 'gpt-x' } as never).run(request);
    const value = result._unsafeUnwrap();
    expect(value.content).toBe('OK');
    expect(value.usage).toEqual({ inputTokens: 21968, outputTokens: 5, thinkingTokens: 0 });
  });

  it('codex seat errors when stdout has no agent_message', async () => {
    process.env.CODEX_BIN = await stub('codex-plain', 'printf "plain text"');
    const result = await new TestCliProvider({ baseUrl: 'cli://codex', model: 'gpt-x' } as never).run(request);
    expect(result._unsafeUnwrapErr().message).toMatch(/no agent_message/);
  });

  it('an argv adapter that reports no usage returns undefined, not zeros', async () => {
    await stub('grok', 'printf "hello"');
    const saveEnvPath = process.env.PATH;
    process.env.PATH = `${directory}:${saveEnvPath}`;
    try {
      const result = await new TestCliProvider({ baseUrl: 'cli://grok', model: 'grok-x' } as never).run(request);
      const value = result._unsafeUnwrap();
      expect(value.content).toBe('hello');
      expect(value.usage).toBeUndefined();
    } finally {
      process.env.PATH = saveEnvPath;
    }
  });
});
