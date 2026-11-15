import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { CliProvider } from '../../../src/llm/providers/CliProvider.js';
import type { ProviderRequest } from '../../../src/llm/ProviderTypes.js';

class TestCliProvider extends CliProvider {
  run(request: ProviderRequest) { return this.generateImpl(request); }
}

describe('CLI transport abort', () => {
  it('passes a scoped reasoning effort to Codex and rejects invalid values', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'sinter-codex-effort-'));
    const previousBin = process.env.CODEX_BIN;
    const previousEffort = process.env.SINTER_CODEX_REASONING_EFFORT;
    const previousArgs = process.env.SINTER_CODEX_ARGV_FILE;
    try {
      const executable = path.join(directory, 'codex-fixture');
      const argsFile = path.join(directory, 'args');
      await writeFile(executable, '#!/bin/sh\nprintf "%s\\n" "$@" > "$SINTER_CODEX_ARGV_FILE"\nprintf "art"\n');
      await chmod(executable, 0o700);
      process.env.CODEX_BIN = executable;
      process.env.SINTER_CODEX_ARGV_FILE = argsFile;
      process.env.SINTER_CODEX_REASONING_EFFORT = 'low';
      const provider = new TestCliProvider({ baseUrl: 'cli://codex', model: 'gpt-5.6-terra' } as never);
      const result = await provider.run({ systemPrompt: '', userPrompt: 'art' } as ProviderRequest);
      expect(result.isOk() && result.value.content).toBe('art');
      expect((await readFile(argsFile, 'utf8')).trim().split('\n')).toEqual([
        'exec', '-m', 'gpt-5.6-terra', '-c', 'model_reasoning_effort=low',
        '--skip-git-repo-check', '--sandbox', 'read-only', 'art',
      ]);
      process.env.SINTER_CODEX_REASONING_EFFORT = 'invalid';
      expect((await provider.run({ systemPrompt: '', userPrompt: 'art' } as ProviderRequest)).isErr()).toBe(true);
    } finally {
      if (previousBin === undefined) delete process.env.CODEX_BIN;
      else process.env.CODEX_BIN = previousBin;
      if (previousEffort === undefined) delete process.env.SINTER_CODEX_REASONING_EFFORT;
      else process.env.SINTER_CODEX_REASONING_EFFORT = previousEffort;
      if (previousArgs === undefined) delete process.env.SINTER_CODEX_ARGV_FILE;
      else process.env.SINTER_CODEX_ARGV_FILE = previousArgs;
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('kills a delayed child and rejects its partial stdout', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'sinter-cli-abort-'));
    const command = 'sinter-abort-fixture';
    const previousPath = process.env.PATH;
    const previousPidFile = process.env.SINTER_ABORT_TEST_PID_FILE;
    try {
      const executable = path.join(directory, command);
      const pidFile = path.join(directory, 'child.pid');
      await writeFile(executable, '#!/usr/bin/env node\n'
        + 'require("node:fs").writeFileSync(process.env.SINTER_ABORT_TEST_PID_FILE, String(process.pid));\n'
        + 'process.stdout.write("partial"); setTimeout(() => console.log("late"), 1000);\n');
      await chmod(executable, 0o755);
      process.env.PATH = `${directory}${path.delimiter}${previousPath ?? ''}`;
      process.env.SINTER_ABORT_TEST_PID_FILE = pidFile;
      const provider = new TestCliProvider({ baseUrl: `cli://${command}`, model: 'default' } as never);
      const controller = new AbortController();
      const pending = provider.run({ systemPrompt: '', userPrompt: 'test',
        signal: controller.signal } as ProviderRequest);
      let childPid = 0;
      for (let i = 0; i < 50 && !childPid; i++) {
        try { childPid = Number(await readFile(pidFile, 'utf8')); }
        catch { await new Promise(resolve => setTimeout(resolve, 10)); }
      }
      expect(childPid).toBeGreaterThan(0);
      const start = performance.now();
      controller.abort();
      const result = await pending;
      expect(performance.now() - start).toBeLessThan(500);
      expect(result.isErr()).toBe(true);
      let alive = true;
      for (let i = 0; i < 30 && alive; i++) {
        try { process.kill(childPid, 0); await new Promise(resolve => setTimeout(resolve, 10)); }
        catch { alive = false; }
      }
      expect(alive).toBe(false);
      await writeFile(executable, '#!/usr/bin/env node\nconsole.log("complete");\n');
      const normal = await provider.run({ systemPrompt: '', userPrompt: 'test' } as ProviderRequest);
      expect(normal.isOk() && normal.value.content).toBe('complete');
    } finally {
      process.env.PATH = previousPath;
      if (previousPidFile === undefined) delete process.env.SINTER_ABORT_TEST_PID_FILE;
      else process.env.SINTER_ABORT_TEST_PID_FILE = previousPidFile;
      await rm(directory, { recursive: true, force: true });
    }
  });
});
