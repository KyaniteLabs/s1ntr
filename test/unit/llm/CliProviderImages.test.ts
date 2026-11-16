import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CliProvider, CliSeatImageRefusedError } from '../../../src/llm/providers/CliProvider.js';
import type { ProviderRequest } from '../../../src/llm/ProviderTypes.js';

// #1593: a cli:// seat must carry the render images or refuse; never judge blind.
class TestCliProvider extends CliProvider {
  run(request: ProviderRequest) { return this.generateImpl(request); }
}

const KEYS = ['CLAUDE_BIN', 'CODEX_BIN', 'SINTER_ARGV_FILE'];
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
let saved: Record<string, string | undefined>;
let directory: string;
let argsFile: string;

const fixture = async (name: string) => {
  const executable = path.join(directory, name);
  // Record argv and whether each --image file exists while the CLI runs.
  await writeFile(executable, [
    '#!/bin/sh',
    ': > "$SINTER_ARGV_FILE"',
    'for a in "$@"; do printf "%s\\n" "$a" >> "$SINTER_ARGV_FILE"',
    '  case "$a" in --image=*) f="${a#--image=}"; [ -s "$f" ] && echo "EXISTS" >> "$SINTER_ARGV_FILE";; esac',
    'done',
    `printf '%s\\n' '{"type":"item.completed","item":{"type":"agent_message","text":"seen"}}'`,
  ].join('\n'));
  await chmod(executable, 0o700);
  return executable;
};
const recorded = async () => (await readFile(argsFile, 'utf8')).split('\n').slice(0, -1);
const withImages = (n: number) => ({
  systemPrompt: '', userPrompt: '-score this',
  imageInputs: Array.from({ length: n }, () => ({ dataBase64: PNG, mimeType: 'image/png' })),
}) as unknown as ProviderRequest;

beforeEach(async () => {
  saved = Object.fromEntries(KEYS.map((key) => [key, process.env[key]]));
  for (const key of KEYS) delete process.env[key];
  directory = await mkdtemp(path.join(os.tmpdir(), 'sinter-cli-images-'));
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

describe('cli:// seats and image inputs (#1593)', () => {
  it('codex gets each image as a file, and the prompt after --', async () => {
    process.env.CODEX_BIN = await fixture('codex-fixture');
    const provider = new TestCliProvider({ baseUrl: 'cli://codex', model: 'gpt-x' } as never);

    const result = await provider.run(withImages(2));

    expect(result.isOk() && result.value.content).toBe('seen');
    const args = await recorded();
    const images = args.filter(a => a.startsWith('--image='));
    expect(images).toHaveLength(2);
    expect(args.filter(a => a === 'EXISTS')).toHaveLength(2);
    expect(args.slice(-2)).toEqual(['--', '-score this']);
    // The files are cleaned up after the call.
    for (const image of images) expect(existsSync(image.slice('--image='.length))).toBe(false);
  });

  it('codex without images keeps its old argv', async () => {
    process.env.CODEX_BIN = await fixture('codex-fixture');
    await new TestCliProvider({ baseUrl: 'cli://codex', model: 'gpt-x' } as never)
      .run({ systemPrompt: '', userPrompt: 'art' } as ProviderRequest);
    const args = await recorded();
    expect(args).not.toContain('--');
    expect(args.at(-1)).toBe('art');
  });

  it('claude refuses images with a typed error and never runs', async () => {
    process.env.CLAUDE_BIN = await fixture('claude-fixture');
    const result = await new TestCliProvider({ baseUrl: 'cli://claude', model: 'claude-opus-5-5' } as never)
      .run(withImages(1));

    expect(result.isErr()).toBe(true);
    if (result.isErr()) expect(result.error).toBeInstanceOf(CliSeatImageRefusedError);
    expect(existsSync(argsFile)).toBe(false);
  });

  it('other CLIs refuse images too', async () => {
    const result = await new TestCliProvider({ baseUrl: 'cli://agy', model: 'gemini' } as never).run(withImages(1));
    expect(result.isErr() && result.error).toBeInstanceOf(CliSeatImageRefusedError);
  });
});
