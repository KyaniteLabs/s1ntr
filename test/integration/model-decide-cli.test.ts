import { execFile } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/**
 * `sinter model kind` / `sinter model decide` CLI wiring. The decision model is
 * the mocked boundary: a loopback stub answers /v1/systemone. Between the CLI
 * flags and the printed answers everything is real — RoleConfig resolves the
 * seat's decision head from env, DecisionModelClient validates the request,
 * posts it, and validates the answers.
 */

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const binPath = path.join(repoRoot, 'bin', 'sinter');

interface Stub { baseUrl: string; requests: Array<{ url: string; body: Record<string, unknown> }>; close(): Promise<void> }

function startSystemOneStub(answers: unknown): Promise<Stub> {
  const requests: Stub['requests'] = [];
  return new Promise((resolve, reject) => {
    const server: Server = createServer((req, res) => {
      let raw = '';
      req.on('data', chunk => { raw += chunk; });
      req.on('end', () => {
        requests.push({ url: req.url ?? '', body: JSON.parse(raw || '{}') });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ answers, usage: { prompt_tokens: 12 } }));
      });
    });
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as AddressInfo).port;
      resolve({ baseUrl: `http://127.0.0.1:${port}`, requests,
        close: () => new Promise(done => server.close(() => done())) });
    });
  });
}

async function runCli(args: string[], env: Record<string, string> = {}) {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [binPath, ...args], {
      cwd: repoRoot, env: { ...process.env, NODE_ENV: 'test', DOTENV_CONFIG_QUIET: 'true', ...env } });
    return { stdout, stderr, exitCode: 0 };
  } catch (error) {
    const e = error as { stdout?: string; stderr?: string; code?: number };
    return { stdout: e.stdout ?? '', stderr: e.stderr ?? '', exitCode: e.code ?? 1 };
  }
}

describe('sinter model kind', () => {
  it('reports a d1 model as a decision model with its modalities', async () => {
    const { stdout, exitCode } = await runCli(['model', 'kind', 'LiquidAI/d1-2B']);
    expect(exitCode).toBe(0);
    expect(JSON.parse(stdout)).toEqual({ model: 'LiquidAI/d1-2B', kind: 'decision',
      inputModalities: ['text', 'image', 'video'], outputModalities: [], maxContextTokens: 128000 });
  });

  it('exits 1 with usage when no model is given', async () => {
    const { stderr, exitCode } = await runCli(['model', 'kind']);
    expect(exitCode).toBe(1);
    expect(stderr.trim()).toBe('Usage: sinter model kind <model>');
  });
});

describe('sinter model decide', () => {
  let stub: Stub | null = null;
  let dir = '';

  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'sinter-decide-'));
    writeFileSync(path.join(dir, 'q.json'), JSON.stringify({
      calm: { type: 'noul', instructions: 'Is the scene calm?' } }));
    writeFileSync(path.join(dir, 'frame.png'), Buffer.from('fake-png'));
  });

  afterEach(async () => {
    await stub?.close();
    stub = null;
    rmSync(dir, { recursive: true, force: true });
  });

  it('asks the seat decision head and prints validated answers', async () => {
    stub = await startSystemOneStub({ calm: { noul: 0.83 } });
    const { stdout, stderr, exitCode } = await runCli(['model', 'decide', '--role', 'harness',
      '--state', 'slow blue drift', '--questions', path.join(dir, 'q.json'), '--image', path.join(dir, 'frame.png')],
      { SINTER_HARNESS_DECISION_MODEL: 'LiquidAI/d1-2B', SINTER_HARNESS_DECISION_BASE_URL: stub.baseUrl });
    expect(exitCode, stderr).toBe(0);
    expect(JSON.parse(stdout)).toEqual({ role: 'harness', model: 'LiquidAI/d1-2B',
      answers: { calm: { type: 'noul', probability: 0.83 } } });
    expect(stub.requests.length).toBe(1);
    expect(stub.requests[0]!.url).toBe('/v1/systemone');
    expect(stub.requests[0]!.body.state).toBe('slow blue drift');
    expect(stub.requests[0]!.body.images).toEqual([`data:image/png;base64,${Buffer.from('fake-png').toString('base64')}`]);
  });

  it('fails loudly when the seat has no decision model', async () => {
    const { stderr, exitCode } = await runCli(['model', 'decide', '--role', 'studio',
      '--state', 'x', '--questions', path.join(dir, 'q.json')]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("DECISION_HEAD_MISSING: role 'studio' has no decision model");
  });

  it('fails loudly on a malformed answer instead of printing a default', async () => {
    stub = await startSystemOneStub({ calm: { noul: 'probably' } });
    const { stdout, stderr, exitCode } = await runCli(['model', 'decide',
      '--state', 'x', '--questions', path.join(dir, 'q.json')],
      { SINTER_EVALUATOR_DECISION_MODEL: 'LiquidAI/d1-2B', SINTER_EVALUATOR_DECISION_BASE_URL: stub.baseUrl });
    expect(exitCode).toBe(1);
    expect(stdout).toBe('');
    expect(stderr).toContain('DECISION_ANSWER_INVALID: calm noul is not a probability in [0,1]');
  });
});
