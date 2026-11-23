/**
 * A local OpenAI-compatible provider the REAL `bin/sinter` talks to over HTTP, no network beyond loopback.
 * Built for Sol audit F04/G01/F06, which stayed at unit level because no harness let the binary run a governed
 * Create without a paid provider. Reusable by any end-to-end test (organ harness included):
 *
 *   const fake = await startFakeProvider({ generate: ({ index }) => html(index) });
 *   const run = runSinter(['generate', '-o', out, '--domain', 'html', 'a prompt'], fakeProviderEnv(fake, { home, stateRoot }));
 *   expect(fake.generatorCalls).toBe(1);
 *
 * Requests that carry images are the vision judge; everything else is the generator.
 */
import { assertProofCannotTouchRealState } from '../../src/config/ProofIsolationGuard.js';
import http from 'node:http';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';

export interface FakeCall { readonly index: number; readonly system: string; readonly user: string; readonly images: number }
export interface FakeProviderOptions {
  /** Generator reply text for the Nth generator call (0-based). */
  readonly generate?: (call: FakeCall) => string;
  /** Judge reply for the Nth judge call (0-based). */
  readonly judge?: (call: FakeCall) => Record<string, unknown>;
  /** Raw judge reply text for a judge call; wins over `judge`. For replies that are not valid JSON (truncated, prose). */
  readonly judgeText?: (call: FakeCall) => string;
  /** Hold every judge (image) reply this long before answering, to drive evaluator timeouts. */
  readonly judgeDelayMs?: number;
  /** Two-stage judge (#1731) code-audit reply; text-only call recognised by its system prompt. Default: no findings, 0.9. */
  readonly audit?: (call: FakeCall) => Record<string, unknown>;
  /** Two-stage judge visual-bugs (B1) reply; image call recognised by its system prompt. Default: pass. */
  readonly bugs?: (call: FakeCall) => Record<string, unknown>;
}
export interface FakeProvider {
  readonly baseUrl: string;
  readonly calls: FakeCall[];
  readonly judged: FakeCall[];
  readonly generated: FakeCall[];
  /** Raw request bodies in arrival order (to assert the model name and reasoning fields actually sent). */
  readonly bodies: string[];
  close(): Promise<void>;
}

export const LIVELY_HTML = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Orbit</title><meta name="viewport" content="width=device-width,initial-scale=1"><style>html,body{margin:0;height:100%;background:#0b0b1a;overflow:hidden}canvas{display:block}</style></head><body><canvas id="c"></canvas><script>const c=document.getElementById('c');const x=c.getContext('2d');function fit(){c.width=innerWidth;c.height=innerHeight}fit();addEventListener('resize',fit);let t=0;(function f(){t+=0.04;x.fillStyle='rgba(11,11,26,0.18)';x.fillRect(0,0,c.width,c.height);for(let i=0;i<40;i++){const a=t*(0.3+i*0.02)+i;const r=60+i*7+Math.sin(t+i)*30;x.fillStyle='hsl('+(i*9+t*40)%360+',90%,'+(35+25*Math.sin(t+i))+'%)';x.beginPath();x.arc(c.width/2+Math.cos(a)*r,c.height/2+Math.sin(a)*r,4+3*Math.sin(t*2+i),0,7);x.fill()}requestAnimationFrame(f)})();</script></body></html>`;

const DIMENSIONS = ['cohesion', 'structuralDepth', 'spatialEmbodiment', 'materiality', 'motionPurpose', 'composition', 'palette', 'finish'];
export const goodJudgeReply = (score = 0.8): Record<string, unknown> => ({ score, confidence: 0.9, reasoning: 'fake judge',
  dimensions: Object.fromEntries(DIMENSIONS.map(d => [d, score])) });

export async function startFakeProvider(options: FakeProviderOptions = {}): Promise<FakeProvider> {
  const bodies: string[] = []; const calls: FakeCall[] = []; const judged: FakeCall[] = []; const generated: FakeCall[] = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      if (req.method !== 'GET') bodies.push(body);
      if (req.method === 'GET') { res.end(JSON.stringify({ object: 'list', data: [{ id: 'gpt-5.4', object: 'model' }] })); return; }
      let messages: Array<{ role: string; content: unknown }> = [];
      try { messages = (JSON.parse(body) as { messages?: typeof messages }).messages ?? []; } catch { /* malformed: treated as empty */ }
      const text = (c: unknown) => typeof c === 'string' ? c
        : Array.isArray(c) ? c.map((p: { type?: string; text?: string }) => p.type === 'text' ? p.text ?? '' : '').join('') : '';
      const images = messages.reduce((n, m) => n + (Array.isArray(m.content)
        ? m.content.filter((p: { type?: string }) => p.type === 'image_url' || p.type === 'image').length : 0), 0);
      const system = messages.filter(m => m.role === 'system').map(m => text(m.content)).join('\n');
      const user = text(messages.filter(m => m.role === 'user').at(-1)?.content);
      const isJudge = images > 0;
      const isAudit = /senior code auditor/.test(system);
      const list = (isJudge || isAudit) ? judged : generated;
      const call: FakeCall = { index: list.length, system, user, images };
      list.push(call); calls.push(call);
      const isBugs = /check rendered frames for visual defects/.test(system);
      const content = isAudit
        ? JSON.stringify((options.audit ?? (() => ({ findings: [], score: 0.9 })))(call))
        : isBugs
        ? JSON.stringify((options.bugs ?? (() => ({ pass: true, bugs: [] })))(call))
        : isJudge
        ? (options.judgeText ? options.judgeText(call) : JSON.stringify((options.judge ?? (() => goodJudgeReply()))(call)))
        : (options.generate ?? (() => LIVELY_HTML))(call);
      const reply = () => res.end(JSON.stringify({ id: 'fake', object: 'chat.completion', model: 'gpt-5.4',
        choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } }));
      if (isJudge && options.judgeDelayMs) setTimeout(() => { if (!res.destroyed) reply(); }, options.judgeDelayMs); else reply();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return { baseUrl: `http://127.0.0.1:${port}/v1`, calls, judged, generated, bodies,
    close: () => new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections?.(); }) };
}

/** Env that points the real binary at the fake provider with an isolated HOME and state root; pass projectRoot to isolate `.sinter` and the gallery too. */
export function fakeProviderEnv(fake: Pick<FakeProvider, 'baseUrl'>, opts: { home: string; stateRoot: string; projectRoot?: string }): NodeJS.ProcessEnv {
  // Test runners set VITEST/NODE_ENV=test/SINTER_* which switch the binary into harness-executor mode; the fake
  // provider run must look like a plain user shell.
  const base: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (/^(VITEST|NODE_ENV|SINTER_|LIMINAL_|CI$|TEST)/.test(k)) continue;
    base[k] = v;
  }
  return {
    ...base,
    HOME: opts.home, USERPROFILE: opts.home, SINTER_PROOF_ISOLATION: '1',
    PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH ?? path.join(process.env.HOME ?? '', '.cache', 'ms-playwright'),
    LIMINAL_ALLOW_LOCALHOST: 'true', LIMINAL_ALLOW_LOCALHOST_LLM: 'true',
    LIMINAL_LLM_BASE_URL: fake.baseUrl, LIMINAL_LLM_MODEL: 'gpt-5.4', LIMINAL_LLM_API_KEY: 'fake-key',
    SINTER_LIMINAL_RUNTIME_ROOT: opts.stateRoot,
    // The strip above removes the SINTER_PROJECT_ROOT that test/setup.ts sets, so the binary falls back to cwd. Several
    // tests rely on that (they pass their own cwd). A test that spawns from the repo root must pass projectRoot, or
    // accepted pieces and the judge's praise land in <repo>/.sinter/seed-archive and later runs read them back as
    // exemplars (spawned-wiring CI flake, run 3895).
    ...(opts.projectRoot ? { SINTER_PROJECT_ROOT: opts.projectRoot } : {}),
  };
}

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
/** Runs bin/sinter without blocking the event loop (spawnSync would stall the in-process fake server). */
export function runSinterAsync(args: string[], env: NodeJS.ProcessEnv, cwd = repoRoot, timeoutMs = 240_000):
  Promise<{ status: number | null; out: string; stdout: string; stderr: string }> {
  if (env.SINTER_PROOF_REAL_STATE === '1') {
    env = { ...env, SINTER_PROOF_ISOLATION: '0' };
  } else {
    env = { ...env, SINTER_PROOF_ISOLATION: '1' };
    if (!env.HOME) throw new Error('runSinterAsync requires a temporary HOME');
    assertProofCannotTouchRealState(env.HOME, env);
  }
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(repoRoot, 'bin/sinter'), ...args], { cwd, env });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', d => { stdout += d; }); child.stderr.on('data', d => { stderr += d; });
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.on('close', (status) => {
      clearTimeout(timer);
      // a CLI that cannot load its own dist is a build problem, not a product failure: say so plainly
      const hint = /ERR_MODULE_NOT_FOUND|Cannot find module[^\n]*\/dist\//.test(stderr)
        ? '\n[test harness] dist is missing, mid-build or stale: run `pnpm build` (atomic) and retry.\n' : '';
      resolve({ status, stdout, stderr: stderr + hint, out: stdout + stderr + hint });
    });
  });
}
