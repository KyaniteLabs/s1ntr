import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { bootstrapExecutorAuthority } from '../../../src/identity/executorAuthorityBootstrap.js';
import { LLMClient } from '../../../src/llm/LLMClient.js';
import type { ProviderConfig } from '../../../src/llm/ProviderTypes.js';
import { createProvider, detectProvider } from '../../../src/llm/ProviderFactory.js';
import {
  GrokCliProvider,
  type GrokCliRunner,
} from '../../../src/llm/providers/GrokCliProvider.js';

const config: ProviderConfig = {
  baseUrl: 'grok-cli://local',
  logicalProvider: 'openai',
  model: 'grok-test-model',
  timeout: 5000,
};

describe('GrokCliProvider', () => {
  it('is selected only by the explicit CLI endpoint', () => {
    expect(detectProvider(config)).toBe('grok-cli');
    expect(createProvider(config)).toBeInstanceOf(GrokCliProvider);
  });

  it('passes rendered evidence as bounded JSON content blocks', async () => {
    const runner = vi.fn<GrokCliRunner>().mockResolvedValue({ stdout: '{"score":0.8}' });
    const provider = new GrokCliProvider(config, runner);

    const result = await provider.generate({
      systemPrompt: 'Evaluate only the supplied rendered evidence.',
      userPrompt: 'Score this candidate.',
      imageInputs: [{ mimeType: 'image/png', dataBase64: 'ZmFrZQ==', label: 'candidate-A-early' }],
    });

    expect(result.isOk()).toBe(true);
    expect(runner).toHaveBeenCalledOnce();
    const args = runner.mock.calls[0][0];
    const prompt = JSON.parse(args[args.indexOf('--prompt-json') + 1]);
    expect(prompt).toEqual([
      { type: 'text', text: 'Score this candidate.' },
      { type: 'text', text: 'Evidence frame: candidate-A-early' },
      { type: 'image', data: 'ZmFrZQ==', mimeType: 'image/png' },
    ]);
    expect(args).toEqual(expect.arrayContaining([
      '--model', 'grok-test-model', '--max-turns', '2', '--no-subagents',
      '--no-memory', '--disable-web-search', '--permission-mode', 'plan',
      '--sandbox', 'read-only', '--verbatim',
    ]));
    expect(args).toEqual(expect.arrayContaining(['--cwd', tmpdir()]));
    expect(runner.mock.calls[0][1].cwd).toBe(tmpdir());
  });

  it('uses the CLI structured-output control in JSON mode', async () => {
    const runner = vi.fn<GrokCliRunner>().mockResolvedValue({
      stdout: '{"text":"{\\"score\\":0.8}","structuredOutput":{"score":0.8}}',
    });
    const provider = new GrokCliProvider(config, runner);

    const result = await provider.generate({ systemPrompt: 'system', userPrompt: 'score', jsonMode: true });

    const args = runner.mock.calls[0][0];
    expect(args).toEqual(expect.arrayContaining(['--json-schema', '{"type":"object"}']));
    expect(args).not.toEqual(expect.arrayContaining(['--output-format', 'plain']));
    expect(result.isOk() && result.value.content).toBe('{"score":0.8}');
  });

  it('fails closed when the CLI transport fails', async () => {
    const runner = vi.fn<GrokCliRunner>().mockRejectedValue(new Error('seat unavailable'));
    const provider = new GrokCliProvider(config, runner);

    const result = await provider.generate({
      systemPrompt: 'system',
      userPrompt: 'prompt',
    });

    expect(result.isErr()).toBe(true);
    if (result.isErr()) expect(result.error.message).toContain('seat unavailable');
  });

  it('streams large rendered evidence over ACP instead of process arguments', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'grok-cli-acp-'));
    const executable = join(directory, 'grok');
    const exactFrame = `frame-start-${'A'.repeat(150_000)}-frame-end`;
    const script = `#!/usr/bin/env node
const readline = require('node:readline');
const rl = readline.createInterface({ input: process.stdin });
const expectedFrame = 'frame-start-' + 'A'.repeat(150000) + '-frame-end';
const expectedArgs = ['agent', '--model', 'grok-test-model', '--no-leader', 'stdio'];
rl.on('line', line => {
  const message = JSON.parse(line);
  let result = {};
  if (message.method === 'initialize') result = { authMethods: [{ id: 'cached_token' }] };
  if (message.method === 'session/new') {
    const system = message.params._meta.systemPromptOverride;
    if (JSON.stringify(process.argv.slice(2)) !== JSON.stringify(expectedArgs) ||
        !system.includes('Return only one valid JSON object.') ||
        message.params._meta.yoloMode !== false || message.params._meta.autoMode !== false)
      process.exit(41);
    result = { sessionId: 'test-session' };
  }
  if (message.method === 'session/prompt') {
    const image = message.params.prompt.find(block => block.type === 'image');
    const score = image && image.data === expectedFrame ? 0.8 : 0.1;
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', method: 'session/update',
      params: { update: { sessionUpdate: 'agent_message_chunk',
        content: { text: JSON.stringify({ score }) } } } }) + '\\n');
  }
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }) + '\\n');
});`;
    writeFileSync(executable, script);
    chmodSync(executable, 0o700);
    const previousPath = process.env.PATH;
    process.env.PATH = `${directory}:${previousPath ?? ''}`;
    try {
      const provider = new GrokCliProvider(config);
      const result = await provider.generate({ systemPrompt: 'system', userPrompt: 'score',
        jsonMode: true,
        imageInputs: [{ mimeType: 'image/png', dataBase64: exactFrame }] });
      expect(result.isOk() && result.value.content).toBe('{"score":0.8}');
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('fails closed when ACP exits after returning partial output', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'grok-cli-acp-crash-'));
    const executable = join(directory, 'grok');
    const script = `#!/usr/bin/env node
const readline = require('node:readline');
readline.createInterface({ input: process.stdin }).on('line', line => {
  const message = JSON.parse(line);
  let result = {};
  if (message.method === 'initialize') result = { authMethods: [{ id: 'cached_token' }] };
  if (message.method === 'session/new') result = { sessionId: 'test-session' };
  if (message.method === 'session/prompt') {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', method: 'session/update',
      params: { update: { sessionUpdate: 'agent_message_chunk',
        content: { text: '{"score":0.9}' } } } }) + '\\n');
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }) + '\\n',
      () => process.exit(42));
    return;
  }
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }) + '\\n');
});`;
    writeFileSync(executable, script);
    chmodSync(executable, 0o700);
    const previousPath = process.env.PATH;
    process.env.PATH = `${directory}:${previousPath ?? ''}`;
    try {
      const provider = new GrokCliProvider(config);
      const result = await provider.generate({ systemPrompt: 'system', userPrompt: 'score',
        imageInputs: [{ mimeType: 'image/png', dataBase64: 'A'.repeat(150_000) }] });
      expect(result.isErr()).toBe(true);
      if (result.isErr()) expect(result.error.message).toContain('exited 42');
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('fails closed when ACP closes stdin before the next request', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'grok-cli-acp-epipe-'));
    const executable = join(directory, 'grok');
    // Read only the initialize request, close stdin, answer it, then stay alive
    // so the provider's next write hits a closed pipe before the exit event.
    const script = `#!/bin/sh
IFS= read -r line
exec 0<&-
printf '%s\\n' '{"jsonrpc":"2.0","id":1,"result":{"authMethods":[{"id":"cached_token"}]}}'
sleep 3
`;
    writeFileSync(executable, script);
    chmodSync(executable, 0o700);
    const previousPath = process.env.PATH;
    process.env.PATH = `${directory}:${previousPath ?? ''}`;
    try {
      const provider = new GrokCliProvider(config);
      const result = await provider.generate({ systemPrompt: 'system', userPrompt: 'score',
        imageInputs: [{ mimeType: 'image/png', dataBase64: 'A'.repeat(150_000) }] });
      expect(result.isErr()).toBe(true);
      if (result.isErr()) expect(result.error.message).toMatch(/EPIPE/);
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('aborts an in-flight ACP evaluation', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'grok-cli-acp-abort-'));
    const executable = join(directory, 'grok');
    const script = `#!/usr/bin/env node
const readline = require('node:readline');
readline.createInterface({ input: process.stdin }).on('line', line => {
  const message = JSON.parse(line);
  let result = {};
  if (message.method === 'initialize') result = { authMethods: [{ id: 'cached_token' }] };
  if (message.method === 'session/new') result = { sessionId: 'test-session' };
  if (message.method !== 'session/prompt')
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }) + '\\n');
});`;
    writeFileSync(executable, script);
    chmodSync(executable, 0o700);
    const previousPath = process.env.PATH;
    process.env.PATH = `${directory}:${previousPath ?? ''}`;
    try {
      const controller = new AbortController();
      const provider = new GrokCliProvider(config);
      const pending = provider.generate({ systemPrompt: 'system', userPrompt: 'score',
        signal: controller.signal,
        imageInputs: [{ mimeType: 'image/png', dataBase64: 'A'.repeat(150_000) }] });
      setTimeout(() => controller.abort(), 50);
      const result = await pending;
      expect(result.isErr()).toBe(true);
      if (result.isErr()) expect(result.error.message).toContain('aborted');
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('completes one attested evaluator command without network access', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'grok-cli-provider-'));
    const executable = join(directory, 'grok');
    writeFileSync(executable, '#!/bin/sh\nprintf \'%s\' \'{"score":0.8}\'\n');
    chmodSync(executable, 0o700);
    const previousPath = process.env.PATH;
    process.env.PATH = `${directory}:${previousPath ?? ''}`;
    try {
      const authority = bootstrapExecutorAuthority({ rootDir: join(directory, 'authority') });
      const client = new LLMClient({
        role: 'evaluator', provider: 'openai', baseUrl: 'grok-cli://local',
        apiKey: 'seat-test', model: 'grok-test-model', harnessTransportAuthority: authority,
      });
      const result = await client.complete({
        systemPrompt: 'system', prompt: 'prompt',
        imageInputs: [{ mimeType: 'image/png', dataBase64: 'ZmFrZQ==' }],
      });

      expect(result).toMatchObject({ success: true, provider: 'grok-cli', text: '{"score":0.8}' });
      expect(client.getHarnessExecutorProjection()).toMatchObject({ status: 'verified', attempts: [{
        attestation: { subject: { surface: 'grok-cli-seat',
          funding: { mode: 'subscription-seat', quotaSurface: 'grok-cli-seat' } } },
      }] });
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
