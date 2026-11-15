import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LLMClient } from '../../../src/llm/LLMClient.js';
import type { BaseProvider } from '../../../src/llm/providers/BaseProvider.js';
import {
  CliProvider,
  HERMES_IMAGE_PATCH,
  hermesArgs,
  hermesImageCommand,
  parseHermesSeat,
  parseHermesStream,
} from '../../../src/llm/providers/CliProvider.js';

const RESULT_OK = '{"type": "result", "exit_code": 0, "text": "PONG", "tokens": {"input": 3197, "output": 4}}';

describe('parseHermesSeat', () => {
  it('reads provider and reasoning from the seat path', () => {
    expect(parseHermesSeat('cli://hermes/openai-api/high')).toEqual({ provider: 'openai-api', reasoning: 'high' });
    expect(parseHermesSeat('cli://hermes/anthropic/xhigh/chat/completions')).toEqual({ provider: 'anthropic', reasoning: 'xhigh' });
  });

  it('rejects reasoning outside medium..xhigh and malformed URLs', () => {
    expect(parseHermesSeat('cli://hermes/openai-api/low')).toBeNull();
    expect(parseHermesSeat('cli://hermes/openai-api/max')).toBeNull();
    expect(parseHermesSeat('cli://hermes/openai-api')).toBeNull();
    expect(parseHermesSeat('cli://hermes?provider=openai-api&reasoning=high')).toBeNull();
    expect(parseHermesSeat('cli://hermes/Bad_Provider/high')).toBeNull();
    expect(parseHermesSeat('')).toBeNull();
  });
});

describe('hermesArgs', () => {
  it('disables the profile fallback chain and pins model, provider and reasoning', () => {
    const args = hermesArgs('gpt-6.1-terra', { provider: 'openai-api', reasoning: 'high' });
    expect(args.slice(0, 6)).toEqual(['chat', '--query-file', '-', '--oneshot', '--format', 'stream-json']);
    expect(args).toEqual(expect.arrayContaining(['--ignore-user-config', '--ignore-rules']));
    expect(args[args.indexOf('-m') + 1]).toBe('gpt-6.1-terra');
    expect(args[args.indexOf('--provider') + 1]).toBe('openai-api');
    expect(args[args.indexOf('--reasoning') + 1]).toBe('high');
    expect(args[args.indexOf('-t') + 1]).toBe('todo');
  });
});

const RUNTIME = (code: string) => JSON.stringify(['/py', '-I', '-c', code, 'chat', '-m', 'm']);

describe('hermesImageCommand', () => {
  it('runs the image patch right before hermes_cli.main and keeps the rest of the argv', () => {
    const argv = hermesImageCommand(RUNTIME("import os; runpy.run_module('hermes_cli.main', run_name='__main__')"));
    expect(argv?.[0]).toBe('/py');
    expect(argv?.slice(4)).toEqual(['chat', '-m', 'm']);
    expect(argv?.[3]).toBe(`import os; exec(${JSON.stringify(HERMES_IMAGE_PATCH)}); runpy.run_module('hermes_cli.main', run_name='__main__')`);
  });

  it('refuses a printed command it does not recognise', () => {
    expect(hermesImageCommand('not json')).toBeNull();
    expect(hermesImageCommand('{"a": 1}')).toBeNull();
    expect(hermesImageCommand(JSON.stringify(['/py', 'chat']))).toBeNull();
    expect(hermesImageCommand(RUNTIME('import hermes_cli.main'))).toBeNull();
    expect(hermesImageCommand(RUNTIME('runpy.run_module(a); runpy.run_module(b)'))).toBeNull();
  });
});

const PYTHON = (() => {
  try { execFileSync('python3', ['--version']); return 'python3'; } catch { return null; }
})();

describe.skipIf(!PYTHON)('HERMES_IMAGE_PATCH against a stub gateway client', () => {
  it('stages each image with image.attach_bytes and lists them as prompt.submit attachments', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hermes-patch-'));
    try {
      mkdirSync(join(dir, 'hermes_cli'));
      writeFileSync(join(dir, 'hermes_cli', '__init__.py'), '');
      writeFileSync(join(dir, 'hermes_cli', 'gateway_chat_view.py'), [
        'class GatewayChatView:',
        '    async def submit(self, text):',
        "        return await self.client.rpc('prompt.submit', session_id=self.session_id, text=text)",
      ].join('\n'));
      writeFileSync(join(dir, 'a.png'), Buffer.from([1, 2, 3]));
      const driver = [
        'import asyncio, json, os',
        'calls = []',
        'class Client:',
        '    async def rpc(self, method, **params):',
        '        calls.append([method, params])',
        "        return {'path': '/staged/%d.png' % len(calls), 'mime': 'image/png'} if method == 'image.attach_bytes' else {}",
        `exec(${JSON.stringify(HERMES_IMAGE_PATCH)})`,
        'view = _V(); view.client = Client(); view.session_id = "s1"',
        "asyncio.run(view.submit('judge this'))",
        "print(json.dumps({'calls': calls, 'env_left': 'SINTER_HERMES_IMAGE_FILES' in os.environ}))",
      ].join('\n');
      const out = execFileSync(PYTHON as string, ['-c', driver], {
        cwd: dir, encoding: 'utf8',
        env: { ...process.env, PYTHONPATH: dir, SINTER_HERMES_IMAGE_FILES: JSON.stringify([[join(dir, 'a.png'), 'image/png']]) },
      });
      expect(JSON.parse(out)).toEqual({
        calls: [
          ['image.attach_bytes', { session_id: 's1', content_base64: 'data:image/png;base64,AQID' }],
          ['prompt.submit', { session_id: 's1', text: 'judge this', attachments: [{ path: '/staged/1.png', mime: 'image/png' }] }],
        ],
        env_left: false,
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('parseHermesStream', () => {
  it('returns the result text and token usage', () => {
    const out = `{"type": "system", "subtype": "init", "model": "m"}\nSession: local-x\n{"type": "text", "text": "PO"}\n${RESULT_OK}\n`;
    const r = parseHermesStream(out);
    expect(r.isOk() && r.value).toEqual({ text: 'PONG', inputTokens: 3197, outputTokens: 4 });
  });

  it('fails on a non-zero result (provider 402) instead of returning the error text as content', () => {
    const r = parseHermesStream('{"type": "result", "exit_code": 1, "text": "Billing or credits exhausted: HTTP 402"}');
    expect(r.isErr() && r.error).toBe('Billing or credits exhausted: HTTP 402');
  });

  it('fails on missing result, empty text and empty output', () => {
    expect(parseHermesStream('{"type": "text", "text": "partial"}').isErr()).toBe(true);
    expect(parseHermesStream('{"type": "result", "exit_code": 0, "text": "  "}')._unsafeUnwrapErr()).toBe('hermes returned an empty reply');
    expect(parseHermesStream('')._unsafeUnwrapErr()).toBe('no result record in hermes output');
  });
});

describe('CliProvider hermes seat (fake hermes binary)', () => {
  let dir: string;
  const saved = { bin: process.env.HERMES_BIN, cwd: process.env.SINTER_HERMES_CWD, wait: process.env.SINTER_HERMES_FENCE_WAIT_MS };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'hermes-seat-'));
    process.env.SINTER_HERMES_CWD = join(dir, 'cwd');
    process.env.SINTER_HERMES_FENCE_WAIT_MS = '5';
  });
  afterEach(() => {
    process.env.HERMES_BIN = saved.bin;
    process.env.SINTER_HERMES_CWD = saved.cwd;
    if (saved.bin === undefined) delete process.env.HERMES_BIN;
    if (saved.cwd === undefined) delete process.env.SINTER_HERMES_CWD;
    if (saved.wait === undefined) delete process.env.SINTER_HERMES_FENCE_WAIT_MS;
    else process.env.SINTER_HERMES_FENCE_WAIT_MS = saved.wait;
    rmSync(dir, { recursive: true, force: true });
  });

  function fakeHermes(body: string): void {
    const bin = join(dir, 'hermes');
    writeFileSync(bin, `#!/bin/sh\n${body}\n`);
    chmodSync(bin, 0o755);
    process.env.HERMES_BIN = bin;
  }

  it('sends the prompt on stdin from the seat cwd and returns the reply', async () => {
    fakeHermes(`cat > "${dir}/stdin"; pwd > "${dir}/pwd"; echo "$@" > "${dir}/argv"; echo '${RESULT_OK}'`);
    const provider = new CliProvider({ baseUrl: 'cli://hermes/anthropic/medium', model: 'claude-sonnet-5-5', timeout: 10_000 });
    const result = await provider.generate({ systemPrompt: 'Be terse.', userPrompt: 'Say PONG' });
    expect(result.isOk() && result.value.content).toBe('PONG');
    expect(result.isOk() && result.value.usage).toEqual({ inputTokens: 3197, outputTokens: 4 });
    expect(readFileSync(join(dir, 'stdin'), 'utf8')).toBe('Be terse.\n\nSay PONG');
    expect(readFileSync(join(dir, 'pwd'), 'utf8').trim()).toBe(join(dir, 'cwd'));
    expect(readFileSync(join(dir, 'argv'), 'utf8')).toContain('-m claude-sonnet-5-5 --provider anthropic --reasoning medium');
  });

  it('surfaces a provider failure as an error naming the seat', async () => {
    fakeHermes(`cat >/dev/null; echo '{"type": "result", "exit_code": 1, "text": "HTTP 402: Insufficient Balance"}'; exit 1`);
    const provider = new CliProvider({ baseUrl: 'cli://hermes/deepseek/medium', model: 'deepseek-v4.1-flash-1017', timeout: 10_000 });
    const result = await provider.generate({ userPrompt: 'x' });
    expect(result.isErr() && result.error.message).toContain('cli:hermes deepseek/deepseek-v4.1-flash-1017 failed');
    expect(result.isErr() && result.error.message).toContain('HTTP 402: Insufficient Balance');
  });

  it('waits out another launch\'s update fence, then answers', async () => {
    const fenced = `{"type": "result", "exit_code": 1, "text": ""}`;
    fakeHermes(`cat >/dev/null; n=$(cat "${dir}/n" 2>/dev/null || echo 0); n=$((n+1)); echo $n > "${dir}/n"; `
      + `if [ $n -lt 3 ]; then echo 'Error: Gateway draining: update_paused' >&2; echo '${fenced}'; exit 1; fi; echo '${RESULT_OK}'`);
    const provider = new CliProvider({ baseUrl: 'cli://hermes/openai-api/medium', model: 'gpt-6.1-terra', timeout: 10_000 });
    const result = await provider.generate({ userPrompt: 'x' });
    expect(result.isOk() && result.value.content).toBe('PONG');
    expect(readFileSync(join(dir, 'n'), 'utf8').trim()).toBe('3');
  });

  it('waits out the not_ready fence while a launch prepares dependencies', async () => {
    const fenced = `{"type": "result", "exit_code": 1, "text": ""}`;
    fakeHermes(`cat >/dev/null; n=$(cat "${dir}/n" 2>/dev/null || echo 0); n=$((n+1)); echo $n > "${dir}/n"; `
      + `if [ $n -lt 2 ]; then echo 'Error: Gateway draining: not_ready' >&2; echo '${fenced}'; exit 1; fi; echo '${RESULT_OK}'`);
    const provider = new CliProvider({ baseUrl: 'cli://hermes/openai-api/medium', model: 'gpt-6-luna', timeout: 10_000 });
    const result = await provider.generate({ userPrompt: 'x' });
    expect(result.isOk() && result.value.content).toBe('PONG');
    expect(readFileSync(join(dir, 'n'), 'utf8').trim()).toBe('2');
  });

  it('gives up after 8 fenced launches and reports the fence', async () => {
    fakeHermes(`cat >/dev/null; n=$(cat "${dir}/n" 2>/dev/null || echo 0); echo $((n+1)) > "${dir}/n"; `
      + `echo 'Error: Gateway draining: update_paused' >&2; echo '{"type": "result", "exit_code": 1, "text": ""}'; exit 1`);
    const provider = new CliProvider({ baseUrl: 'cli://hermes/openai-api/medium', model: 'gpt-6.1-terra', timeout: 10_000 });
    const result = await provider.generate({ userPrompt: 'x' });
    expect(result.isErr() && result.error.message).toContain('update_paused');
    expect(readFileSync(join(dir, 'n'), 'utf8').trim()).toBe('8');
  });

  const FRAMES = [
    { mimeType: 'image/png', dataBase64: Buffer.from('early').toString('base64'), label: 'early' },
    { mimeType: 'image/jpeg', dataBase64: Buffer.from('late').toString('base64'), label: 'late' },
  ];

  it('sends images through the patched Hermes runtime and removes them afterwards', async () => {
    const py = join(dir, 'py');
    writeFileSync(py, `#!/bin/sh\ncat > "${dir}/stdin"; printf '%s' "$3" > "${dir}/code"; `
      + `printf '%s' "$SINTER_HERMES_IMAGE_FILES" > "${dir}/files"; `
      + `for f in $(echo "$SINTER_HERMES_IMAGE_FILES" | tr -d '[]"' | tr ',' ' '); do case "$f" in /*) cat "$f"; echo;; esac; done > "${dir}/bytes"; `
      + `echo '${RESULT_OK}'\n`);
    chmodSync(py, 0o755);
    fakeHermes(`if [ "$1" = "--print-runtime-command" ]; then shift; `
      + `printf '["${py}", "-I", "-c", "import os; runpy.run_module(\\"hermes_cli.main\\")"]'; exit 0; fi; echo unpatched >&2; exit 9`);
    const provider = new CliProvider({ baseUrl: 'cli://hermes/anthropic/high', model: 'claude-opus-5-5', timeout: 10_000 });
    const result = await provider.generate({ userPrompt: 'Score it', imageInputs: FRAMES });
    expect(result.isOk() && result.value.content).toBe('PONG');
    expect(readFileSync(join(dir, 'code'), 'utf8')).toContain(`exec(${JSON.stringify(HERMES_IMAGE_PATCH)}); runpy.run_module(`);
    const files = JSON.parse(readFileSync(join(dir, 'files'), 'utf8')) as [string, string][];
    expect(files.map(([, mime]) => mime)).toEqual(['image/png', 'image/jpeg']);
    expect(readFileSync(join(dir, 'bytes'), 'utf8')).toBe('early\nlate\n');
    expect(files.some(([path]) => existsSync(path))).toBe(false);
    expect(readFileSync(join(dir, 'stdin'), 'utf8')).toBe('Score it');
  });

  it('fails the call instead of judging blind when the runtime command cannot be patched', async () => {
    fakeHermes(`if [ "$1" = "--print-runtime-command" ]; then echo '["/py", "chat"]'; exit 0; fi; touch "${dir}/spawned"; echo '${RESULT_OK}'`);
    const provider = new CliProvider({ baseUrl: 'cli://hermes/openai-api/medium', model: 'gpt-6-luna', timeout: 10_000 });
    const result = await provider.generate({ userPrompt: 'Score it', imageInputs: FRAMES });
    expect(result.isErr() && result.error.message).toBe(
      'cli:hermes openai-api/gpt-6-luna cannot attach images: hermes --print-runtime-command printed an unexpected shape');
    expect(existsSync(join(dir, 'spawned'))).toBe(false);
  });

  it('refuses a seat with a disallowed reasoning level or no model, without spawning', async () => {
    fakeHermes(`touch "${dir}/spawned"; echo '${RESULT_OK}'`);
    const low = new CliProvider({ baseUrl: 'cli://hermes/openai-api/low', model: 'gpt-6-luna', timeout: 10_000 });
    const noModel = new CliProvider({ baseUrl: 'cli://hermes/openai-api/high', model: 'default', timeout: 10_000 });
    expect((await low.generate({ userPrompt: 'x' }))._unsafeUnwrapErr().message).toContain('medium|high|xhigh');
    expect((await noModel.generate({ userPrompt: 'x' }))._unsafeUnwrapErr().message).toBe('cli:hermes needs an explicit model');
    expect(() => readFileSync(join(dir, 'spawned'))).toThrow();
  });
});

describe('hermes seat routing', () => {
  function providerFor(baseUrl: string): Promise<BaseProvider> {
    const client = new LLMClient({ baseUrl, model: 'fixture-model' });
    return (client as unknown as { getProvider(): Promise<BaseProvider> }).getProvider();
  }

  it('routes a well-formed hermes seat to the CLI provider', async () => {
    await expect(providerFor('cli://hermes/openai-api/high')).resolves.toBeInstanceOf(CliProvider);
    await expect(providerFor('cli://hermes/openai-api/high/chat/completions')).resolves.toBeInstanceOf(CliProvider);
  });

  it('labels a hermes seat by the provider in its path, not as local', () => {
    const label = (baseUrl: string, model: string) =>
      (new LLMClient({ baseUrl, model }) as unknown as { detectProvider(): string }).detectProvider();
    expect(label('cli://hermes/openai-api/medium', 'gpt-6.1-sol')).toBe('hermes:openai-api');
    expect(label('cli://hermes/anthropic/high/chat/completions', 'claude-opus-5-5')).toBe('hermes:anthropic');
  });

  it('admits a harness seat by the model family in its path, and still refuses Luna', () => {
    const check = (baseUrl: string, model: string) => {
      const client = new LLMClient({ role: 'harness', baseUrl, model, provider: 'cli' });
      const provider = { name: 'cli', getModel: () => model, getConfig: () => ({ baseUrl }) };
      return () => (client as unknown as { assertRoleAttemptEligible(p: unknown, phase: string): void })
        .assertRoleAttemptEligible(provider, 'pre-primary-transport');
    };
    expect(check('cli://hermes/openai-api/high', 'gpt-6.1-terra')).not.toThrow();
    expect(check('cli://hermes/anthropic/xhigh', 'claude-opus-5-5')).not.toThrow();
    expect(check('cli://hermes/openai-api/high', 'gpt-6-luna')).toThrow(/Harness executor blocked before transport: role-luna-harness-forbidden/);
  });

  it('blocks a malformed hermes seat at the SSRF gate', async () => {
    await expect(providerFor('cli://hermes/openai-api/max')).rejects.toThrow(/SSRF Protection/);
  });
});
