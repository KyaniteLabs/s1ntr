import { execFile } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { AddressInfo } from 'node:net';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isolatedCliEnv } from '../helpers/isolatedCli.js';

/**
 * Behavioral CLI-wiring test for `sinter model audition <model> --live`.
 *
 * The LLM provider is the mocked boundary: a local OpenAI-format stub server
 * returns a fixed candidate completion. Everything between the CLI flags and
 * the printed verdict is the REAL code path — the bin/sinter `model audition`
 * handler constructs a real LLMClient against the stub, dispatches to
 * runLiveModelAssimilationAudition, derives evidence from the stub's actual
 * output, and prints the live verdict. This is what proves the `--live` path
 * is wired, not just that the runner exists.
 *
 * Custom (127.0.0.1) base URLs resolve to the OpenAI adapter, so the stub
 * speaks `/chat/completions`. The model name is non-placeholder so the client
 * never hits `/models` autodetection.
 */

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const binPath = path.join(repoRoot, 'bin', 'sinter');
const AUDITION_MODEL = 'audition-cli-stub-model';

const VALID_TOOL_CALL = JSON.stringify({
  tool: 'apply_edit',
  arguments: { domain: 'p5', path: 'sketch.js', edit: 'background(0);', noop: false },
});

/** Start a one-shot OpenAI-format LLM stub returning a fixed completion. */
function startStubServer(completion: string): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  return new Promise((resolve, reject) => {
    const server: Server = createServer((req, res) => {
      if (req.method === 'GET' && (req.url === '/v1/models' || req.url === '/models')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ object: 'list', data: [{ id: AUDITION_MODEL, object: 'model' }] }));
        return;
      }
      if (req.method !== 'POST') {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'not found' }));
        return;
      }
      // Drain the request body, then return the fixed completion.
      req.on('data', () => {});
      req.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          id: 'chatcmpl-audition-stub',
          object: 'chat.completion',
          model: AUDITION_MODEL,
          choices: [{ index: 0, message: { role: 'assistant', content: completion }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 16, completion_tokens: 48, total_tokens: 64 },
        }));
      });
    });
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as AddressInfo).port;
      resolve({
        baseUrl: `http://127.0.0.1:${port}/v1`,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}

interface CliResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

async function runAuditionCli(baseUrl: string): Promise<CliResult> {
  try {
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      [
        binPath,
        'model',
        'audition',
        AUDITION_MODEL,
        '--live',
        '--provider',
        'lmstudio', // requiresKey: false, so no real API key is needed
        '--base-url',
        baseUrl,
      ],
      {
        cwd: repoRoot,
        env: {
          ...isolatedCliEnv().env,
          NODE_ENV: 'test',
          DOTENV_CONFIG_QUIET: 'true',
          // Stub is loopback-only; SSRF still blocks non-localhost private IPs.
          LIMINAL_ALLOW_LOCALHOST_LLM: 'true',
        },
      },
    );
    return { stdout, stderr, exitCode: 0 };
  } catch (error) {
    const e = error as { stdout?: string; stderr?: string; code?: number };
    return { stdout: e.stdout ?? '', stderr: e.stderr ?? '', exitCode: e.code ?? 1 };
  }
}

describe('sinter model audition --live CLI wiring', () => {
  let stub: { baseUrl: string; close: () => Promise<void> } | null = null;

  afterEach(async () => {
    if (stub) {
      await stub.close();
      stub = null;
    }
  });

  describe('when the candidate emits a valid tool call', () => {
    beforeEach(async () => {
      stub = await startStubServer(VALID_TOOL_CALL);
    });

    it('runs a live audition through the real handler and prints a passing verdict', async () => {
      const { stdout, stderr, exitCode } = await runAuditionCli(stub!.baseUrl);

      // Live source proves the handler invoked the candidate, not the dry-run path.
      expect(stdout, stderr).toContain('Source: live');
      expect(stdout).not.toContain('UNVERIFIED');
      expect(stdout).toContain(`Model: ${AUDITION_MODEL}`);
      expect(stdout).toContain('Ready: YES');
      // Every gauntlet check was derived from the stub's real output.
      expect(stdout).toContain('PASS Tool-call schema reliability');
      expect(stdout).toContain('PASS Creative-domain routing');
      expect(stdout).toContain('PASS Self-improvement mutation readiness');
      expect(stdout).toContain('PASS No-op honesty');
      expect(stdout).toContain('PASS Cost/latency record');
      expect(stdout).toContain('passed a live audition');
      expect(exitCode).toBe(0);
    });
  });

  describe('when the candidate emits prose instead of a tool call', () => {
    beforeEach(async () => {
      stub = await startStubServer('Sure, I would add background(0) to the draw loop.');
    });

    it('flows a live FAIL through the CLI with a non-zero exit code', async () => {
      const { stdout, stderr, exitCode } = await runAuditionCli(stub!.baseUrl);

      expect(stdout, stderr).toContain('Source: live');
      expect(stdout).toContain('Ready: NO');
      expect(stdout).toContain('FAIL Tool-call schema reliability');
      expect(stdout).toContain('not eligible for promotion');
      expect(exitCode).toBe(1);
    });
  });
});
