import { existsSync, lstatSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CliProvider } from '../../../src/llm/providers/CliProvider.js';
import type { ProviderRequest } from '../../../src/llm/ProviderTypes.js';

// An art seat on cli://codex spent ~80 KB of every prompt on the operator's own
// context: their global AGENTS.md, skills, the repo AGENTS.md from Sinter's cwd,
// and agent roles. The model then followed those instructions instead of the
// brief. A seat gets a fresh CODEX_HOME holding only the login, an empty HOME
// and an empty cwd, so the brief is the only instruction it sees.

class TestCliProvider extends CliProvider {
  run(request: ProviderRequest) { return this.generateImpl(request); }
}

const KEYS = ['CODEX_BIN', 'CODEX_HOME', 'SINTER_ARGV_FILE'];
let saved: Record<string, string | undefined>;
let directory: string;
let argsFile: string;
let userCodexHome: string;

const fixture = async () => {
  const executable = path.join(directory, 'codex-fixture');
  await writeFile(executable, [
    '#!/bin/sh',
    'pwd > "$SINTER_ARGV_FILE"',
    'printf "%s\\n%s\\n" "$CODEX_HOME" "$HOME" >> "$SINTER_ARGV_FILE"',
    'ls -A "$CODEX_HOME" | tr "\\n" " " >> "$SINTER_ARGV_FILE"; echo >> "$SINTER_ARGV_FILE"',
    'ls -A . | tr "\\n" " " >> "$SINTER_ARGV_FILE"; echo >> "$SINTER_ARGV_FILE"',
    'printf "%s\\n" "$@" >> "$SINTER_ARGV_FILE"',
    `printf '%s\\n' '{"type":"item.completed","item":{"type":"agent_message","text":"art"}}'`,
    '',
  ].join('\n'));
  await chmod(executable, 0o700);
  return executable;
};
const recorded = async () => {
  const [cwd, codexHome, home, homeFiles, cwdFiles, ...args] = (await readFile(argsFile, 'utf8')).split('\n').slice(0, -1);
  return { cwd, codexHome, home, homeFiles: homeFiles.trim(), cwdFiles: cwdFiles.trim(), args };
};
const request = { systemPrompt: '', userPrompt: 'art' } as ProviderRequest;

beforeEach(async () => {
  saved = Object.fromEntries(KEYS.map((key) => [key, process.env[key]]));
  directory = await mkdtemp(path.join(os.tmpdir(), 'sinter-codex-seat-test-'));
  argsFile = path.join(directory, 'args');
  userCodexHome = path.join(directory, 'user-codex');
  await mkdir(userCodexHome);
  await writeFile(path.join(userCodexHome, 'auth.json'), '{"fixture":true}');
  await writeFile(path.join(userCodexHome, 'AGENTS.md'), 'operator instructions');
  await writeFile(path.join(userCodexHome, 'config.toml'), 'sandbox_mode = "danger-full-access"');
  process.env.SINTER_ARGV_FILE = argsFile;
  process.env.CODEX_HOME = userCodexHome;
  process.env.CODEX_BIN = await fixture();
});

afterEach(async () => {
  for (const key of KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  await rm(directory, { recursive: true, force: true });
});

describe('cli://codex seat isolation', () => {
  it('runs codex with only the login: no user AGENTS.md, config, skills, repo cwd or HOME', async () => {
    const result = await new TestCliProvider({ baseUrl: 'cli://codex', model: 'gpt-6-astra' } as never).run(request);

    expect(result.isOk() && result.value.content).toBe('art');
    const seen = await recorded();
    expect(seen.homeFiles).toBe('auth.json');
    expect(seen.cwdFiles).toBe('');
    expect(seen.cwd).toMatch(/sinter-codex-seat-[^/]+\/work$/);
    expect(seen.codexHome).not.toBe(userCodexHome);
    expect(seen.home).not.toBe(os.homedir());
    expect(seen.args).toEqual([
      'exec', '-m', 'gpt-6-astra',
      '--skip-git-repo-check', '--sandbox', 'read-only', '--ephemeral',
      '--json', '--disable', 'multi_agent', '--disable', 'apps', '--disable', 'plugins',
      '--disable', 'memories', '--disable', 'hooks', 'art',
    ]);
    // The seat home is gone after the call, and the user's login is untouched.
    expect(existsSync(seen.codexHome)).toBe(false);
    expect(await readFile(path.join(userCodexHome, 'auth.json'), 'utf8')).toBe('{"fixture":true}');
  });

  it('links the login, never copies it', async () => {
    await writeFile(process.env.CODEX_BIN!, [
      '#!/bin/sh',
      'readlink "$CODEX_HOME/auth.json" > "$SINTER_ARGV_FILE"',
      'printf "art"', '',
    ].join('\n'));
    await new TestCliProvider({ baseUrl: 'cli://codex', model: 'gpt-6-astra' } as never).run(request);
    expect((await readFile(argsFile, 'utf8')).trim()).toBe(path.join(userCodexHome, 'auth.json'));
    expect(lstatSync(path.join(userCodexHome, 'auth.json')).isSymbolicLink()).toBe(false);
  });

  it('keeps the user CODEX_HOME when there is no file login to link', async () => {
    await rm(path.join(userCodexHome, 'auth.json'));
    await new TestCliProvider({ baseUrl: 'cli://codex', model: 'gpt-6-astra' } as never).run(request);
    const seen = await recorded();
    expect(seen.codexHome).toBe(userCodexHome);
    expect(seen.cwdFiles).toBe('');
  });
});
