import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CliProvider, seatEffort } from '../../../src/llm/providers/CliProvider.js';
import type { ProviderRequest } from '../../../src/llm/ProviderTypes.js';

class TestCliProvider extends CliProvider {
  run(request: ProviderRequest) { return this.generateImpl(request); }
}

let directory: string;
let argsFile: string;
let savedPath: string | undefined;
const ENV = ['SINTER_AGY_EFFORT', 'SINTER_GROK_EFFORT', 'SINTER_COMMAND_CODE_EFFORT'];
const request = { systemPrompt: '', userPrompt: 'art' } as ProviderRequest;

beforeEach(async () => {
  savedPath = process.env.PATH;
  for (const key of ENV) delete process.env[key];
  directory = await mkdtemp(path.join(os.tmpdir(), 'sinter-effort-'));
  argsFile = path.join(directory, 'args');
  process.env.SINTER_ARGV_FILE = argsFile;
  for (const name of ['agy', 'grok', 'command-code']) {
    const bin = path.join(directory, name);
    await writeFile(bin, '#!/bin/sh\nprintf "%s\\n" "$@" > "$SINTER_ARGV_FILE"\nprintf "art"\n');
    await chmod(bin, 0o700);
  }
  process.env.PATH = `${directory}:${savedPath}`;
});
afterEach(async () => {
  process.env.PATH = savedPath;
  delete process.env.SINTER_ARGV_FILE;
  await rm(directory, { recursive: true, force: true });
});
const argv = async () => (await readFile(argsFile, 'utf8')).split('\n').slice(0, -1);

describe('cli seat effort passthrough', () => {
  it.each([
    ['agy', 'high', ['--effort', 'high']],
    ['agy', 'max', ['--effort', 'max']],
    ['grok', 'medium', ['--reasoning-effort', 'medium']],
    ['command-code', 'low', ['--effort', 'low']],
  ])('passes %s effort %s from the seat URL', async (command, level, flag) => {
    const provider = new TestCliProvider({ baseUrl: `cli://${command}/${level}`, model: 'default' } as never);
    const result = await provider.run(request);
    expect(result.isOk()).toBe(true);
    const args = await argv();
    const at = args.indexOf(flag[0]);
    expect(args.slice(at, at + 2)).toEqual(flag);
    expect(args.at(-1)).toBe('art');
  });
  it('passes no effort flag when none is set', async () => {
    await new TestCliProvider({ baseUrl: 'cli://agy', model: 'default' } as never).run(request);
    expect(await argv()).not.toContain('--effort');
  });
  it('takes the fleet default from the env and rejects an invalid one', async () => {
    process.env.SINTER_AGY_EFFORT = 'xhigh';
    expect(seatEffort('agy', 'cli://agy')._unsafeUnwrap()).toBe('xhigh');
    process.env.SINTER_AGY_EFFORT = 'ludicrous';
    expect(seatEffort('agy', 'cli://agy').isErr()).toBe(true);
  });
  it('ignores a level the CLI does not accept in the URL', () => {
    expect(seatEffort('grok', 'cli://grok/xhigh')._unsafeUnwrap()).toBeUndefined();
  });
});
