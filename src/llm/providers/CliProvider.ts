/**
 * CliProvider — generation through subscription CLIs (no API key lanes).
 *
 * The CEO fleet rotation (2026-08-30) includes seats that have no HTTP API for
 * sinter: command-code (62-model separate subscription), agy (Gemini OAuth),
 * codex (Luna subscription). This provider shells out to the CLI headless
 * print mode and returns stdout as the completion.
 *
 * baseUrl scheme: `cli://<command>` — e.g. cli://command-code, cli://agy,
 * cli://codex. The command must be on PATH; model flows through the normal
 * role/env override (SINTER_GENERATOR_MODEL).
 *
 * Hermes seat: `cli://hermes/<hermes-provider>/<reasoning>`, e.g.
 * cli://hermes/openai-api/high. Path segments, not a query string, because
 * rotation may append /chat/completions to a seat URL.
 */

import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { ok, err, type Result } from 'neverthrow';
import { CapabilityRegistry } from '../CapabilityRegistry.js';
import { HERMES_REASONING_LEVELS, parseHermesSeat, type HermesSeat } from '../../identity/cliSeatUrl.js';
import { LLMError } from '../errors.js';
import type {
  ProviderCapabilities,
  ProviderImageInput,
  ProviderRequest,
  ProviderResponse,
  StreamEvent,
} from '../ProviderTypes.js';
import { BaseProvider } from './BaseProvider.js';

interface CliSpec {
  /** Flag that selects the model. */
  modelFlag: string;
  /** Extra fixed args for headless print mode. */
  extraArgs: readonly string[];
  /** Subcommand before the prompt, when the CLI needs one (codex: exec). */
  subcommand?: string;
}

const KNOWN_CLIS: Record<string, CliSpec> = {
  'command-code': {
    modelFlag: '--model',
    extraArgs: ['-p', '--no-session', '--skip-onboarding'],
  },
  agy: {
    modelFlag: '--model',
    extraArgs: ['-p'],
  },
  codex: {
    modelFlag: '-m',
    // codex is an agent: a user config with danger-full-access would let a
    // generation turn write into Sinter's cwd. A seat returns text, nothing else.
    extraArgs: ['--skip-git-repo-check', '--sandbox', 'read-only'],
    subcommand: 'exec',
  },
  grok: {
    modelFlag: '--model',
    extraArgs: ['-p'],
  },
};

export { HERMES_REASONING_LEVELS, parseHermesSeat, type HermesSeat } from '../../identity/cliSeatUrl.js';

/**
 * Hermes argv. --ignore-user-config drops the profile's fallback_providers:
 * with it on, a failed request is silently answered by another model (seen
 * 2026-11-10: a DeepSeek 402 came back as a fallback model's PONG), which
 * would credit the wrong model with the work. Credentials in .env still load.
 * -t todo keeps the agent to one inert tool so a generation turn cannot touch
 * files or the shell.
 */
/** Fence waits before giving up: 8 x 15s covers a ~2 min update finish. */
const HERMES_FENCE_ATTEMPTS = 8;

export function hermesArgs(model: string, seat: HermesSeat): string[] {
  return [
    'chat', '--query-file', '-', '--oneshot', '--format', 'stream-json',
    '-m', model, '--provider', seat.provider, '--reasoning', seat.reasoning,
    '--ignore-user-config', '--ignore-rules', '-t', 'todo', '--max-turns', '2',
  ];
}

/**
 * Python run inside Hermes's own runtime (`hermes --print-runtime-command`)
 * before `hermes_cli.main`. The gateway chat client refuses `--image`, but the
 * gateway takes images the way Hermes's own gateway_agent sends them: each one
 * staged with `image.attach_bytes`, then listed as `attachments` on
 * `prompt.submit`. The gateway then routes them natively for a vision model
 * (verified 2026-11-10 on luna, terra, sol, sonnet, opus and fable: one
 * direct API call each, no helper-model description). Paths and MIME types
 * arrive in SINTER_HERMES_IMAGE_FILES as JSON [[path, mime], ...]. A failed
 * staging call raises, so the seat fails instead of judging blind.
 */
export const HERMES_IMAGE_PATCH = [
  'import base64, json, os',
  'from hermes_cli.gateway_chat_view import GatewayChatView as _V',
  "_files = json.loads(os.environ.pop('SINTER_HERMES_IMAGE_FILES'))",
  "_urls = ['data:%s;base64,%s' % (m, base64.b64encode(open(p, 'rb').read()).decode()) for p, m in _files]",
  '_submit = _V.submit',
  'async def _sinter_submit(self, text):',
  "    staged = [await self.client.rpc('image.attach_bytes', session_id=self.session_id, content_base64=u) for u in _urls]",
  '    rpc = self.client.rpc',
  '    async def call(method, **params):',
  "        if method == 'prompt.submit':",
  "            params['attachments'] = [{'path': s['path'], 'mime': s['mime']} for s in staged]",
  '        return await rpc(method, **params)',
  '    self.client.rpc = call',
  '    try:',
  '        return await _submit(self, text)',
  '    finally:',
  '        self.client.rpc = rpc',
  '_V.submit = _sinter_submit',
].join('\n');

/**
 * Turn Hermes's printed runtime command into one that runs HERMES_IMAGE_PATCH
 * first. Null when the command no longer has the shape this relies on.
 */
export function hermesImageCommand(printed: string): string[] | null {
  let argv: unknown;
  try { argv = JSON.parse(printed.trim()); } catch { return null; }
  if (!Array.isArray(argv) || !argv.every(a => typeof a === 'string')) return null;
  const codeAt = argv.indexOf('-c') + 1;
  const code = codeAt > 0 ? argv[codeAt] as string | undefined : undefined;
  const hook = 'runpy.run_module(';
  if (!code || code.split(hook).length !== 2) return null;
  const patched = [...argv as string[]];
  patched[codeAt] = code.replace(hook, `exec(${JSON.stringify(HERMES_IMAGE_PATCH)}); ${hook}`);
  return patched;
}

export interface HermesResult {
  text: string;
  inputTokens: number;
  outputTokens: number;
}

/** Read the terminal `result` record from Hermes stream-json stdout. */
export function parseHermesStream(stdout: string): Result<HermesResult, string> {
  type ResultRecord = { type?: string; exit_code?: number; text?: string; error?: string;
    tokens?: { input?: number; output?: number } };
  let result: ResultRecord | null = null;
  for (const line of stdout.split('\n')) {
    if (!line.startsWith('{')) continue;
    try {
      const event = JSON.parse(line) as ResultRecord;
      if (event.type === 'result') result = event;
    } catch { /* non-JSON noise line */ }
  }
  if (!result) return err('no result record in hermes output');
  const text = (result.text ?? '').trim();
  if (result.exit_code !== 0) return err(result.error ?? (text.slice(0, 300) || `exit_code ${String(result.exit_code)}`));
  if (!text) return err('hermes returned an empty reply');
  return ok({ text, inputTokens: result.tokens?.input ?? 0, outputTokens: result.tokens?.output ?? 0 });
}

function hermesCwd(): string {
  // Not under /tmp: the Hermes gateway runs with a private /tmp and refuses a
  // client cwd it cannot see.
  const dir = process.env.SINTER_HERMES_CWD || join(homedir(), '.cache', 'sinter-hermes-seat');
  mkdirSync(dir, { recursive: true });
  return dir;
}

function specFor(command: string): CliSpec {
  return KNOWN_CLIS[command] ?? { modelFlag: '--model', extraArgs: ['-p'] };
}

export class CliProvider extends BaseProvider {
  readonly name = 'cli';

  get capabilities(): ProviderCapabilities {
    return CapabilityRegistry.getCapabilities(this.config.model);
  }

  private command(): string {
    // baseUrl: cli://<command>
    return this.config.baseUrl.replace(/^cli:\/\//, '').split(/[/?]/)[0];
  }

  protected async generateImpl(req: ProviderRequest): Promise<Result<ProviderResponse, LLMError>> {
    const command = this.command();
    if (command === 'hermes') return this.generateHermes(req);
    const spec = specFor(command);
    // Model flag FIRST, extraArgs (-p) after: grok's -p/--single consumes the
    // NEXT token as its value, so ['-p', '--model', X, prompt] made -p swallow
    // '--model' and the call die (the grok fallback was broken this way while
    // direct probes with [-m X -p prompt] worked). cmd/agy accept either order.
    const args: string[] = [];
    if (spec.subcommand) args.push(spec.subcommand);
    if (this.config.model && this.config.model !== 'default') {
      args.push(spec.modelFlag, this.config.model);
    }
    const effort = process.env.SINTER_CODEX_REASONING_EFFORT;
    if (command === 'codex' && effort) {
      if (!['low', 'medium', 'high', 'xhigh'].includes(effort)) {
        return err(new LLMError('invalid Codex reasoning effort', 'cli'));
      }
      args.push('-c', `model_reasoning_effort=${effort}`);
    }
    args.push(...spec.extraArgs);
    // command-code/agy take the prompt as the -p value; codex exec takes it
    // positionally. Both forms: append the prompt last.
    const prompt = req.systemPrompt?.trim()
      ? `${req.systemPrompt.trim()}\n\n${req.userPrompt}`
      : req.userPrompt;
    args.push(prompt);

    const timeoutMs = this.config.timeout ?? 560_000;
    return new Promise(resolve => {
      const child = execFile(command === 'codex' ? (process.env.CODEX_BIN || command) : command, args, {
        cwd: process.cwd(),
        encoding: 'utf8',
        timeout: timeoutMs,
        signal: req.signal,
        maxBuffer: 10 * 1024 * 1024,
        env: { ...process.env, NO_COLOR: '1', CI: '1' },
      }, (error, stdout, stderr) => {
        if (error) {
          resolve(err(new LLMError(
            `cli:${command} failed: ${error.message}${stderr ? ` — ${stderr.slice(0, 300)}` : ''}`,
            'cli',
          )));
          return;
        }
        const content = stdout.trim();
        if (!content) {
          resolve(err(new LLMError(`cli:${command} returned empty stdout`, 'cli')));
          return;
        }
        resolve(ok({
          content,
          model: this.config.model,
          success: true,
          usage: { inputTokens: 0, outputTokens: 0 },
          finishReason: 'stop',
        }));
      });
      // These adapters receive the prompt as argv and require stdin EOF.
      child.stdin?.end();
    });
  }

  private generateHermes(req: ProviderRequest): Promise<Result<ProviderResponse, LLMError>> {
    const seat = parseHermesSeat(this.config.baseUrl);
    if (!seat) {
      return Promise.resolve(err(new LLMError(
        `cli:hermes seat URL must be cli://hermes/<provider>/<${HERMES_REASONING_LEVELS.join('|')}>`, 'cli')));
    }
    if (!this.config.model || this.config.model === 'default') {
      return Promise.resolve(err(new LLMError('cli:hermes needs an explicit model', 'cli')));
    }
    const prompt = req.systemPrompt?.trim()
      ? `${req.systemPrompt.trim()}\n\n${req.userPrompt}`
      : req.userPrompt;
    return this.runHermesThroughFence(seat, prompt, req);
  }

  /** Write the images where the patched client can read them; removed by the caller. */
  private static writeImages(images: readonly ProviderImageInput[]): { dir: string; files: [string, string][] } {
    const dir = mkdtempSync(join(tmpdir(), 'sinter-hermes-img-'));
    const files = images.map((image, i): [string, string] => {
      const path = join(dir, `image-${i}`);
      writeFileSync(path, Buffer.from(image.dataBase64, 'base64'));
      return [path, image.mimeType || 'image/png'];
    });
    return { dir, files };
  }

  /** The argv for this launch: plain `hermes chat`, or the patched runtime when images ride along. */
  private async hermesLaunch(seat: HermesSeat, imageFiles: [string, string][]): Promise<Result<string[], string>> {
    const bin = process.env.HERMES_BIN || 'hermes';
    const args = hermesArgs(this.config.model, seat);
    if (imageFiles.length === 0) return ok([bin, ...args]);
    return new Promise(resolve => {
      execFile(bin, ['--print-runtime-command', ...args], { encoding: 'utf8', timeout: 120_000 }, (error, stdout) => {
        const argv = error ? null : hermesImageCommand(stdout);
        resolve(argv ? ok(argv) : err(`cannot attach images: hermes --print-runtime-command ${
          error ? `failed: ${error.message}` : 'printed an unexpected shape'}`));
      });
    });
  }

  /**
   * Every `hermes` launch finishes the install's update first and holds the
   * update fence while it does; a launch that lands inside another launch's
   * fence is refused with "Gateway draining: update_paused" before any model
   * call (0 tokens). Wait for the fence instead of failing the seat.
   */
  private async runHermesThroughFence(
    seat: HermesSeat, prompt: string, req: ProviderRequest,
  ): Promise<Result<ProviderResponse, LLMError>> {
    const waitMs = Number(process.env.SINTER_HERMES_FENCE_WAIT_MS ?? 15_000);
    const images = req.imageInputs ?? [];
    const written = images.length > 0 ? CliProvider.writeImages(images) : null;
    try {
      const launch = await this.hermesLaunch(seat, written?.files ?? []);
      if (launch.isErr()) {
        return err(new LLMError(`cli:hermes ${seat.provider}/${this.config.model} ${launch.error}`, 'cli'));
      }
      const env: Record<string, string> = written ? { SINTER_HERMES_IMAGE_FILES: JSON.stringify(written.files) } : {};
      for (let attempt = 1; ; attempt++) {
        const result = await this.runHermesOnce(seat, prompt, req, launch.value, env);
        // 'not_ready' is the same fence while a launch prepares the data root's deps.
        const fenced = result.isErr() && /Gateway draining: (update_paused|not_ready)/.test(result.error.message);
        if (!fenced || attempt >= HERMES_FENCE_ATTEMPTS || req.signal?.aborted) return result;
        await new Promise(r => setTimeout(r, waitMs));
      }
    } finally {
      if (written) rmSync(written.dir, { recursive: true, force: true });
    }
  }

  private runHermesOnce(
    seat: HermesSeat, prompt: string, req: ProviderRequest, argv: string[], extraEnv: Record<string, string>,
  ): Promise<Result<ProviderResponse, LLMError>> {
    return new Promise(resolve => {
      const child = execFile(argv[0], argv.slice(1), {
        cwd: hermesCwd(),
        encoding: 'utf8',
        timeout: this.config.timeout ?? 560_000,
        signal: req.signal,
        maxBuffer: 20 * 1024 * 1024,
        env: { ...process.env, NO_COLOR: '1', ...extraEnv },
      }, (error, stdout, stderr) => {
        const parsed = parseHermesStream(stdout ?? '');
        if (parsed.isErr()) {
          const why = error ? `${error.message}; ${parsed.error}` : parsed.error;
          resolve(err(new LLMError(`cli:hermes ${seat.provider}/${this.config.model} failed: ${why}${
            stderr && !parsed.error.includes(stderr.slice(0, 50)) ? ` — ${stderr.slice(0, 300)}` : ''}`, 'cli')));
          return;
        }
        resolve(ok({
          content: parsed.value.text,
          model: this.config.model,
          success: true,
          usage: { inputTokens: parsed.value.inputTokens, outputTokens: parsed.value.outputTokens },
          finishReason: 'stop',
        }));
      });
      // Prompt on stdin (--query-file -): no argv length limit, no shell parsing.
      child.stdin?.end(prompt);
    });
  }

  protected async *streamImpl(req: ProviderRequest): AsyncGenerator<StreamEvent> {
    // CLI lanes are request/response; fake a single content event.
    const result = await this.generateImpl(req);
    if (result.isOk()) {
      yield { type: 'content', content: result.value.content };
    }
    yield { type: 'done' };
  }
}
