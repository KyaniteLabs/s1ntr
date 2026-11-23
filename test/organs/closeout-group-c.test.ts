/**
 * Group C closeout proofs through the REAL spawned binary against a local fake provider (no paid call):
 * per-medium briefs, per-seat evidence in `report fitness`, and explicit `chat reflect`.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { fakeProviderEnv, runSinterAsync, startFakeProvider, type FakeProvider } from '../helpers/fakeProviderServer.js';
import { P5_SKETCH } from './p5Sketch.js';
import { createFitnessObservation } from '../../src/quality/FitnessObservationStore.js';
import { SinterFS } from '../../src/fs/index.js';
import { SessionGraph } from '../../src/agent/SessionGraph.js';

vi.setConfig({ testTimeout: 280_000 });
let fake: FakeProvider; let work: string;
beforeAll(async () => { fake = await startFakeProvider(); work = mkdtempSync(path.join(tmpdir(), 'organ-close-c-')); });
afterAll(async () => { await fake.close(); rmSync(work, { recursive: true, force: true }); });

const gen = (out: string, domain: string) => ['generate', '-o', out, '--domain', domain, 'a slow orbit of colored light'];

describe('config: each medium brief carries its own prompt hint (the live source of what model-routing used to hold)', () => {
  const hints: Array<[string, string]> = [
    ['html', 'semantic HTML, CSS, and accessible interaction states'],
    ['strudel', 'Strudel-native patterns'],
    ['ascii', 'strong silhouette and careful spacing'],
    ['three', 'animation loop and resize handling'],
    ['glsl', 'u_time and u_resolution'],
  ];
  for (const [domain, hint] of hints) {
    it(`${domain}: the generator request carries the hint`, async () => {
      const start = fake.generated.length;
      await runSinterAsync(gen(path.join(work, `hint-${domain}`), domain),
        fakeProviderEnv(fake, { home: path.join(work, `h-${domain}`), stateRoot: path.join(work, `s-${domain}`) }));
      const first = fake.generated[start];
      expect(first, `no generator call for ${domain}`).toMatchObject({ system: expect.any(String), user: expect.any(String) });
      expect(first.system + first.user).toContain(hint);
    });
  }
});

describe('report fitness: the operator sees their own per-seat per-medium outcomes (evidence only)', () => {
  it('prints best seat, mean score and wall time from the operator own runs; one run is not evidence', async () => {
    const rows = [
      ...[0.9, 0.8, 0.85].map((score, i) => createFitnessObservation({ runId: `a${i}`, domain: 'p5', provider: 'zai', model: 'glm', sourceCode: 'x', score, confidence: 0.9, failureClass: 'none', durationMs: 4000 })),
      ...[0.4, 0.5, 0.3].map((score, i) => createFitnessObservation({ runId: `b${i}`, domain: 'p5', provider: 'kilo', model: 'ds', sourceCode: 'y', score, confidence: 0.9, failureClass: 'none', durationMs: 2000 })),
      createFitnessObservation({ runId: 'c0', domain: 'html', provider: 'zai', model: 'glm', sourceCode: 'z', score: 0.9, confidence: 0.9, failureClass: 'none' }),
    ];
    const file = path.join(work, 'fitness.jsonl');
    writeFileSync(file, rows.map(r => JSON.stringify(r)).join('\n') + '\n');
    const env = { ...fakeProviderEnv(fake, { home: path.join(work, 'h-rep'), stateRoot: path.join(work, 's-rep') }), SINTER_FITNESS_OBSERVATIONS_PATH: file };
    const r = await runSinterAsync(['report', 'fitness'], env);
    expect(r.status, r.out).toBe(0);
    expect(r.out).toMatch(/Your seats per medium/);
    expect(r.out).toMatch(/p5\s+best so far: zai\/glm/);
    expect(r.out).toMatch(/kilo\/ds: 3 runs, mean score 0\.400, 0 failed, 2\.0s avg/);
    expect(r.out).toMatch(/html\s+\(no seat has 3 scored runs yet\)/);
    // bypass: a different file changes the answer (the report reads the operator's runs, not a table)
    const file2 = path.join(work, 'fitness2.jsonl');
    writeFileSync(file2, rows.slice(3, 6).map(r2 => JSON.stringify(r2)).join('\n') + '\n');
    const r2 = await runSinterAsync(['report', 'fitness'], { ...env, SINTER_FITNESS_OBSERVATIONS_PATH: file2 });
    expect(r2.out).toMatch(/p5\s+best so far: kilo\/ds/);
    expect(r2.out).not.toMatch(/zai\/glm/);
  });
});

describe('chat reflect: distills saved sessions through the studio seat', () => {
  it('only explicit reflection reads saved sessions and sends each turn once', async () => {
    const proj = path.join(work, 'proj-chat'); mkdirSync(proj, { recursive: true });
    const g = new SessionGraph('sess-organ-1', SinterFS.open(proj));
    g.recordTurn({ turnId: 't1', input: 'ORGAN_CHAT_TURN make it slower and warmer', intent: 'create', delegatedTo: 'generator', response: 'done', durationMs: 5 });
    const chatFake = await startFakeProvider({ generate: () => JSON.stringify({ likes: ['slow'], dislikes: [], intentSummary: 'slower warmer piece', satisfaction: 0.8 }) });
    try {
      const env = fakeProviderEnv(chatFake, { home: path.join(work, 'h-chat'), stateRoot: path.join(work, 's-chat') });
      const bare = await runSinterAsync(['chat'], env, proj);
      expect(bare.status).toBe(2);
      expect(bare.out).toMatch(/retired/i);
      expect(chatFake.calls).toHaveLength(0);
      const a = await runSinterAsync(['chat', 'reflect'], env, proj);
      expect(a.status).toBe(0);
      expect(a.out).toMatch(/reflected 1 session/);
      expect(chatFake.generated.map(c => c.user).join('')).toContain('ORGAN_CHAT_TURN');
      const calls = chatFake.calls.length;
      const b = await runSinterAsync(['chat', 'reflect', '5'], env, proj);
      expect(b.out).toMatch(/reflected 0 session\(s\), skipped 1/);
      expect(chatFake.calls.length, 'a reflected session must not be sent again').toBe(calls);
    } finally { await chatFake.close(); }
  });
});

describe('tui-bridge: the spawned bridge turns a creative request into a piece over HTTP', () => {
  it('POST session, POST creative input: the provider is called and a finished piece streams back', async () => {
    const { spawn } = await import('node:child_process');
    const { createServer } = await import('node:net');
    const port: number = await new Promise((resolve) => { const s = createServer(); s.listen(0, '127.0.0.1', () => { const p = (s.address() as { port: number }).port; s.close(() => resolve(p)); }); });
    const generator = await startFakeProvider({ generate: () => `<!doctype html>
      <html><head><meta charset="utf-8"><title>Light</title><style>
      body{margin:0;min-height:100vh;display:grid;place-items:center;background:linear-gradient(125deg,#172239,#551a53);color:#fff}
      main{font:800 18vw system-ui;letter-spacing:-.1em;text-shadow:.04em .05em #111}
      span{display:inline-block;color:#ffbf5e;animation:lift 2s ease-in-out infinite alternate}
      span:last-child{color:#56e5eb;animation-delay:.4s}
      @keyframes lift{to{transform:translateY(-.35em) rotate(12deg)}}
      </style></head><body><main><span>L</span>IG<span>HT</span></main></body></html>` });
    const evaluator = await startFakeProvider();
    const stateRoot = path.join(work, 's-br');
    const env = { ...fakeProviderEnv(generator, { home: path.join(work, 'h-br'), stateRoot }),
      LIMINAL_EVALUATOR_BASE_URL: evaluator.baseUrl, LIMINAL_EVALUATOR_MODEL: 'gpt-5.4',
      LIMINAL_EVALUATOR_API_KEY: 'fake' };
    const child = spawn(process.execPath, [path.join(process.cwd(), 'bin/sinter'), 'bridge', String(port)], { env, cwd: work });
    let log = ''; child.stdout.on('data', d => { log += d; }); child.stderr.on('data', d => { log += d; });
    try {
      const base = `http://127.0.0.1:${port}`;
      for (let i = 0; i < 120 && !/Listening/.test(log); i++) await new Promise(r => setTimeout(r, 500));
      expect(log).toMatch(/Listening/);
      const created = await fetch(`${base}/api/tui/session`, { method: 'POST', body: '{}' });
      expect(created.status).toBe(201);
      const session = await created.json() as { sessionId: string };
      const before = generator.generated.length;
      const events = await fetch(`${base}/api/tui/session/${session.sessionId}/events`, { signal: AbortSignal.timeout(120_000) });
      const reader = events.body!.getReader();
      const sent = await fetch(`${base}/api/tui/session/${session.sessionId}/input`, { method: 'POST',
        body: JSON.stringify({ mode: 'chat', clientIntent: 'creative', executionMode: 'prove', maxIterations: 1, candidateCount: 1,
          text: 'Create CSS kinetic typography. Animate the word LIGHT over a shifting gradient with calm pacing.' }) });
      expect(sent.status, await sent.clone().text()).toBe(200);
      let seen = '';
      while (!/"type":"(?:generation\.complete|error)"/.test(seen)) {
        const { value, done } = await reader.read(); if (done) break; seen += Buffer.from(value).toString();
      }
      await reader.cancel().catch(() => undefined);
      const failure = seen.match(/"type":"error"[^\n]*/)?.[0];
      expect(failure, log.slice(-1800)).toBeUndefined();
      expect(seen, log.slice(-2400)).toMatch(/"type":"generation\.complete"/);
      expect(seen).toMatch(/"type":"response\.committed"/);
      expect(generator.generated.length, 'the provider was never asked').toBeGreaterThan(before);
      expect(evaluator.judged.length).toBeGreaterThan(0);
    } finally { if (child.pid) process.kill(child.pid, 'SIGTERM'); await Promise.all([generator.close(), evaluator.close()]); }
  }, 480_000);
});

describe('authority: compose --spec and swarm run open the same receipted grant as generate', () => {
  const refusal = /requires Liminal product command authority/;
  it('compose --spec with a prompt layer reaches the provider', async () => {
    const p5 = await startFakeProvider({ generate: () => P5_SKETCH });
    try {
      const dir = path.join(work, 'spec'); mkdirSync(dir, { recursive: true });
      writeFileSync(path.join(dir, 'spec.json'), JSON.stringify({ title: 'Spec', layers: [{ domain: 'p5', prompt: 'drifting colored circles' }] }));
      const env = { ...fakeProviderEnv(p5, { home: path.join(work, 'h-spec'), stateRoot: path.join(work, 's-spec') }), LIMINAL_DISABLE_SANDBOX: 'true' };
      const r = await runSinterAsync(['compose', '--spec', path.join(dir, 'spec.json'), '--output', path.join(dir, 'out')], env, dir);
      expect(r.out).not.toMatch(refusal);
      expect(r.out).not.toMatch(/data. argument must be of type string/);
      expect(p5.generated.length, r.out.slice(-800)).toBeGreaterThan(0);
    } finally { await p5.close(); }
  });
  it('swarm run reaches the provider', async () => {
    const dir = path.join(work, 'swarm'); mkdirSync(dir, { recursive: true });
    const env = fakeProviderEnv(fake, { home: path.join(work, 'h-swarm'), stateRoot: path.join(work, 's-swarm') });
    const before = fake.calls.length;
    const r = await runSinterAsync(['swarm', 'run', '--prompt', 'a slow orbit of light', '--swarm-rounds', '1', '--no-label', '--session-dir', path.join(dir, 'sessions'), '--ledger', path.join(dir, 'ledger.jsonl')], env, dir);
    expect(r.out).not.toMatch(refusal);
    expect(r.out).not.toMatch(/data. argument must be of type string/);
    expect(fake.calls.length, r.out.slice(-800)).toBeGreaterThan(before);
  });
});
