import { execFile, spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { createInterface } from 'node:readline';
import { err, ok, type Result } from 'neverthrow';
import { CapabilityRegistry } from '../CapabilityRegistry.js';
import { LLMError } from '../errors.js';
import type {
  ProviderCapabilities,
  ProviderConfig,
  ProviderRequest,
  ProviderResponse,
  StreamEvent,
} from '../ProviderTypes.js';
import { BaseProvider } from './BaseProvider.js';

export interface GrokCliRunOptions {
  readonly cwd: string;
  readonly signal?: AbortSignal;
  readonly timeoutMs: number;
  readonly promptBlocks?: readonly unknown[];
  readonly model?: string;
  readonly systemPrompt?: string;
  readonly jsonMode?: boolean;
}

export type GrokCliRunner = (
  args: readonly string[],
  options: GrokCliRunOptions,
) => Promise<{ readonly stdout: string }>;

const runHeadless: GrokCliRunner = (args, options) => new Promise((resolve, reject) => {
  execFile('grok', [...args], {
    cwd: options.cwd,
    encoding: 'utf8',
    signal: options.signal,
    timeout: options.timeoutMs,
    maxBuffer: 10 * 1024 * 1024,
  }, (error, stdout) => {
    if (error) reject(error);
    else resolve({ stdout });
  });
});

const runAcp: GrokCliRunner = (_args, options) => new Promise((resolve, reject) => {
  if (!options.model || !options.systemPrompt) {
    reject(new Error('Grok ACP requires model and system prompt'));
    return;
  }
  const child = spawn('grok', ['agent', '--model', options.model, '--no-leader', 'stdio'], {
    cwd: options.cwd,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const lines = createInterface({ input: child.stdout });
  let nextId = 1;
  let text = '';
  let stderr = '';
  let settled = false;
  let expectedShutdown = false;
  const pending = new Map<number, {
    resolve: (value: Record<string, unknown>) => void;
    reject: (error: Error) => void;
  }>();
  const cleanup = (): void => {
    clearTimeout(timeout);
    options.signal?.removeEventListener('abort', abort);
    lines.close();
    child.kill();
  };
  const fail = (error: Error): void => {
    if (settled) return;
    settled = true;
    for (const request of pending.values()) request.reject(error);
    pending.clear();
    cleanup();
    reject(error);
  };
  const timeout = setTimeout(() => fail(new Error('Grok ACP timed out')), options.timeoutMs);
  const abort = (): void => fail(new Error('Grok ACP aborted'));
  if (options.signal?.aborted) {
    abort();
    return;
  }
  options.signal?.addEventListener('abort', abort, { once: true });
  child.stderr.on('data', chunk => { stderr += String(chunk); });
  child.on('error', fail);
  // A child that closes stdin early makes our next write fail with EPIPE;
  // without a listener that error is thrown as an uncaught exception.
  child.stdin.on('error', fail);
  child.on('exit', code => {
    if (!expectedShutdown) fail(new Error(stderr.trim() || `Grok ACP exited ${code ?? 'early'}`));
  });
  lines.on('line', line => {
    let message: { id?: number; method?: string; params?: Record<string, unknown>;
      result?: Record<string, unknown>; error?: { message?: string } };
    try { message = JSON.parse(line); } catch { return; }
    if (message.method === 'session/update') {
      const update = message.params?.update as { sessionUpdate?: string;
        content?: { text?: string } } | undefined;
      if (update?.sessionUpdate === 'agent_message_chunk' && update.content?.text) {
        text += update.content.text;
      }
      return;
    }
    if (message.id === undefined) return;
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    if (message.error) request.reject(new Error(message.error.message ?? 'Grok ACP error'));
    else request.resolve(message.result ?? {});
  });
  const request = (method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> => {
    const id = nextId++;
    return new Promise((resolveRequest, rejectRequest) => {
      pending.set(id, { resolve: resolveRequest, reject: rejectRequest });
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  };
  void (async () => {
    const initialized = await request('initialize', {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
    });
    const methods = (initialized.authMethods as Array<{ id?: string }> | undefined) ?? [];
    const ids = new Set(methods.map(method => method.id));
    const methodId = process.env.XAI_API_KEY && ids.has('xai.api_key')
      ? 'xai.api_key'
      : ids.has('cached_token') ? 'cached_token' : null;
    if (!methodId) throw new Error('Grok ACP has no usable authentication method');
    await request('authenticate', { methodId, _meta: { headless: true } });
    const responseRule = options.jsonMode ? '\nReturn only one valid JSON object.' : '';
    const session = await request('session/new', {
      cwd: options.cwd,
      mcpServers: [],
      _meta: {
        systemPromptOverride: `${options.systemPrompt}\nDo not use tools, files, web search, or subagents.${responseRule}`,
        yoloMode: false,
        autoMode: false,
      },
    });
    const sessionId = session.sessionId;
    if (typeof sessionId !== 'string') throw new Error('Grok ACP did not create a session');
    await request('session/prompt', { sessionId, prompt: options.promptBlocks ?? [] });
    let previousLength = -1;
    let stableChecks = 0;
    while (stableChecks < 2) {
      await new Promise(done => setTimeout(done, 150));
      if (text.length === previousLength) stableChecks += 1;
      else { previousLength = text.length; stableChecks = 0; }
    }
    if (settled) return;
    settled = true;
    expectedShutdown = true;
    cleanup();
    resolve({ stdout: text });
  })().catch(error => fail(error instanceof Error ? error : new Error(String(error))));
});

const PROMPT_ARG_SAFE_BYTES = 32 * 1024;

const defaultRunner: GrokCliRunner = (args, options) => {
  const promptIndex = args.indexOf('--prompt-json');
  const promptBytes = promptIndex < 0 ? 0 : Buffer.byteLength(args[promptIndex + 1] ?? '');
  return options.promptBlocks && promptBytes > PROMPT_ARG_SAFE_BYTES
    ? runAcp(args, options)
    : runHeadless(args, options);
};

function promptBlocks(req: ProviderRequest): unknown[] {
  return [
    { type: 'text', text: req.userPrompt },
    ...(req.imageInputs ?? []).flatMap(image => [
      ...(image.label ? [{ type: 'text', text: `Evidence frame: ${image.label}` }] : []),
      { type: 'image', data: image.dataBase64, mimeType: image.mimeType },
    ]),
  ];
}

function responseContent(stdout: string, jsonMode?: boolean): string {
  const content = stdout.trim();
  if (!jsonMode) return content;
  try {
    const envelope = JSON.parse(content) as { structuredOutput?: unknown; text?: unknown };
    if (envelope.structuredOutput && typeof envelope.structuredOutput === 'object') {
      return JSON.stringify(envelope.structuredOutput);
    }
    if (typeof envelope.text === 'string') return envelope.text.trim();
  } catch {
    // Some runners return the constrained object directly.
  }
  return content;
}

export class GrokCliProvider extends BaseProvider {
  readonly name = 'grok-cli';

  constructor(config: ProviderConfig, private readonly runner: GrokCliRunner = defaultRunner) {
    super(config);
  }

  get capabilities(): ProviderCapabilities {
    return CapabilityRegistry.getCapabilities(this.config.model);
  }

  protected async generateImpl(req: ProviderRequest): Promise<Result<ProviderResponse, LLMError>> {
    const evaluatorCwd = tmpdir();
    const blocks = promptBlocks(req);
    const outputArgs = req.jsonMode
      ? ['--json-schema', '{"type":"object"}']
      : ['--output-format', 'plain'];
    const args = [
      '--model', this.config.model,
      '--cwd', evaluatorCwd,
      '--system-prompt-override', req.systemPrompt,
      '--prompt-json', JSON.stringify(blocks),
      ...outputArgs,
      '--max-turns', '2',
      '--no-subagents', '--no-memory', '--no-auto-update', '--disable-web-search',
      '--permission-mode', 'plan', '--sandbox', 'read-only', '--verbatim',
    ];
    try {
      const { stdout } = await this.runner(args, {
        cwd: evaluatorCwd,
        signal: req.signal,
        timeoutMs: this.config.timeout ?? 120_000,
        promptBlocks: blocks,
        model: this.config.model,
        systemPrompt: req.systemPrompt,
        jsonMode: req.jsonMode,
      });
      const content = responseContent(stdout, req.jsonMode);
      if (!content) {
        return err(new LLMError('Grok CLI returned an empty response', this.name));
      }
      return ok({
        content,
        model: this.config.model,
        success: true,
        finishReason: 'stop',
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      return err(new LLMError(`Grok CLI failed: ${detail}`, this.name));
    }
  }

  protected async *streamImpl(req: ProviderRequest): AsyncGenerator<StreamEvent> {
    const result = await this.generateImpl(req);
    if (result.isErr()) {
      yield { type: 'error', error: result.error.message };
      return;
    }
    yield { type: 'content', content: result.value.content };
    yield { type: 'done', usage: result.value.usage };
  }
}
