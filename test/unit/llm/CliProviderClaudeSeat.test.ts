import { realpathSync } from 'node:fs';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CliProvider, seatEffort } from '../../../src/llm/providers/CliProvider.js';
import type { ProviderRequest } from '../../../src/llm/ProviderTypes.js';

class TestCliProvider extends CliProvider {
  run(request: ProviderRequest) { return this.generateImpl(request); }
}

const KEYS = ['CLAUDE_BIN', 'CODEX_BIN', 'SINTER_ARGV_FILE', 'SINTER_CLAUDE_EFFORT', 'SINTER_CODEX_REASONING_EFFORT'];
let saved: Record<string, string | undefined>;
let directory: string;
let argsFile: string;

const fixture = async (name: string) => {
  const executable = path.join(directory, name);
  await writeFile(executable, '#!/bin/sh\npwd > "$SINTER_ARGV_FILE"\nprintf "%s\\n" "$@" >> "$SINTER_ARGV_FILE"\nprintf "art"\n');
  await chmod(executable, 0o700);
  return executable;
};
const recorded = async () => (await readFile(argsFile, 'utf8')).split('\n').slice(0, -1);
const request = { systemPrompt: '', userPrompt: 'art' } as ProviderRequest;

beforeEach(async () => {
  saved = Object.fromEntries(KEYS.map((key) => [key, process.env[key]]));
  for (const key of KEYS) delete process.env[key];
  directory = await mkdtemp(path.join(os.tmpdir(), 'sinter-claude-seat-'));
  argsFile = path.join(directory, 'args');
  process.env.SINTER_ARGV_FILE = argsFile;
});

afterEach(async () => {
  for (const key of KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  await rm(directory, { recursive: true, force: true });
});

describe('cli://claude seat', () => {
  it('runs Claude Code with no tools, MCP, settings or project context', async () => {
    process.env.CLAUDE_BIN = await fixture('claude-fixture');
    const provider = new TestCliProvider({ baseUrl: 'cli://claude', model: 'claude-fable-5-2' } as never);

    const result = await provider.run(request);

    expect(result.isOk() && result.value.content).toBe('art');
    const [cwd, ...args] = await recorded();
    expect(args).toEqual([
      '--model', 'claude-fable-5-2',
      '--tools', '', '--strict-mcp-config', '--setting-sources', '',
      '--disable-slash-commands', '--no-session-persistence', '-p', 'art',
    ]);
    expect(realpathSync(cwd)).toBe(realpathSync(os.tmpdir()));
  });

  it('takes its effort from the seat URL, ahead of the env default', async () => {
    process.env.CLAUDE_BIN = await fixture('claude-fixture');
    process.env.SINTER_CLAUDE_EFFORT = 'low';
    await new TestCliProvider({ baseUrl: 'cli://claude/high/chat/completions', model: 'claude-opus-5-5' } as never).run(request);
    expect(await recorded()).toEqual(expect.arrayContaining(['--effort', 'high']));

    await new TestCliProvider({ baseUrl: 'cli://claude', model: 'claude-opus-5-5' } as never).run(request);
    expect(await recorded()).toEqual(expect.arrayContaining(['--effort', 'low']));
  });
});

describe('per-seat effort', () => {
  it('lets two codex seats run at different efforts', async () => {
    process.env.CODEX_BIN = await fixture('codex-fixture');
    process.env.SINTER_CODEX_REASONING_EFFORT = 'medium';
    await new TestCliProvider({ baseUrl: 'cli://codex/xhigh', model: 'gpt-6-astra' } as never).run(request);
    expect((await recorded()).slice(1)).toEqual([
      'exec', '-m', 'gpt-6-astra', '-c', 'model_reasoning_effort=xhigh',
      '--skip-git-repo-check', '--sandbox', 'read-only', '--ephemeral',
      '--json', '--disable', 'multi_agent', '--disable', 'apps', '--disable', 'plugins',
      '--disable', 'memories', '--disable', 'hooks', 'art',
    ]);
  });

  it('ignores non-effort segments and rejects a bad env default', () => {
    expect(seatEffort('codex', 'cli://codex/chat/completions')._unsafeUnwrap()).toBeUndefined();
    expect(seatEffort('claude', 'cli://claude/max')._unsafeUnwrap()).toBe('max');
    expect(seatEffort('codex', 'cli://codex/max')._unsafeUnwrap()).toBeUndefined();
    expect(seatEffort('agy', 'cli://agy/high')._unsafeUnwrap()).toBe('high');
    expect(seatEffort('hermes', 'cli://hermes/high')._unsafeUnwrap()).toBeUndefined();
    process.env.SINTER_CLAUDE_EFFORT = 'turbo';
    expect(seatEffort('claude', 'cli://claude').isErr()).toBe(true);
  });
});
