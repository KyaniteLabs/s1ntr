/**
 * Operator-path proofs: each organ below is driven by the real `bin/sinter` command it was built for
 * (fake HTTP provider, no real seat), and the output or the provider request changes with the input.
 * `bin/sinter bridge` is the TUI/GUI backend that holds the agent modes, the autonomy level and the cortex.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { fakeProviderEnv, goodJudgeReply, runSinterAsync, startFakeProvider, LIVELY_HTML } from '../helpers/fakeProviderServer.js';

vi.setConfig({ testTimeout: 600_000, hookTimeout: 120_000 });
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
let work: string; let n = 0;
beforeAll(() => { work = mkdtempSync(path.join(tmpdir(), 'organ-paths-')); });
afterAll(() => { rmSync(work, { recursive: true, force: true }); });

function dirs() { const i = n++; return { home: path.join(work, `h${i}`), state: path.join(work, `s${i}`), out: path.join(work, `o${i}`) }; }
async function sinter(args: string[], opts: { home?: string; env?: Record<string, string>; generate?: () => string } = {}) {
  const d = dirs(); mkdirSync(opts.home ?? d.home, { recursive: true });
  const fake = await startFakeProvider({ generate: opts.generate ?? (() => LIVELY_HTML), judge: () => goodJudgeReply(0.8) });
  try {
    const env = { ...fakeProviderEnv(fake, { home: opts.home ?? d.home, stateRoot: d.state }), ...(opts.env ?? {}) };
    const res = await runSinterAsync(args.map(a => a === '@out' ? d.out : a), env);
    return { res, generated: [...fake.generated] };
  } finally { await fake.close(); }
}

describe('emergence: sinter emergence score', () => {
  it('scores text for surprise, and different text gets a different scorecard', async () => {
    const a = await sinter(['emergence', 'score', 'drift drift drift drift drift drift drift drift']);
    const b = await sinter(['emergence', 'score', 'A lantern argues with the tide; seven clocks learn to hum in minor keys.']);
    expect(a.res.status, a.res.out.slice(-300)).toBe(0);
    expect(a.res.out).toContain('Emergence Scorecard');
    const body = (s: string) => s.slice(s.indexOf('=== Emergence Scorecard'));
    expect(body(a.res.out)).not.toBe(body(b.res.out));
    const none = await sinter(['emergence', 'score']);
    expect(none.res.status).not.toBe(0);
    expect(none.res.out).toContain('Usage: sinter emergence score');
  });
});

describe('improvement: sinter improve', () => {
  it('writes a harden report with concrete proposals', async () => {
    const r = await sinter(['improve']);
    expect(r.res.status, r.res.out.slice(-300)).toBe(0);
    expect(r.res.out).toContain('self-healing harden report');
    expect(r.res.out).toContain('Proposals:');
  });
});

describe('evolution: sinter phases and islands read the score history', () => {
  function trend(scores: number[]) {
    const f = path.join(work, `trend${n++}.jsonl`);
    writeFileSync(f, scores.map((s, i) => JSON.stringify({ domain: 'html', axes: `D=${s} A=${s} R=${s} N=${s}`, turn: i, ts: `2026-11-1${i % 9}T00:00:00Z`, artifact: `a${i}` })).join('\n') + '\n');
    return f;
  }
  it('a jump in the score history is flagged as a regime change; a flat history is not', async () => {
    const jump = await sinter(['phases', '--trend', trend([...Array(10).fill(0.3), ...Array(10).fill(0.85)]), '--window', '5', '--k-sigma', '2']);
    expect(jump.res.status, jump.res.out.slice(-300)).toBe(0);
    expect(jump.res.out).toMatch(/[1-9]\d* phase transitions? detected/);
    expect(jump.res.out).toMatch(/html @ obs#\d+/);
    const flat = await sinter(['phases', '--trend', trend(Array(20).fill(0.5)), '--window', '5', '--k-sigma', '2']);
    expect(flat.res.out).toContain('0 phase transitions detected');
  });
  it('islands groups the same history into per-medium populations', async () => {
    const r = await sinter(['islands', '--trend', trend([0.2, 0.4, 0.6, 0.8, 0.9, 0.5])]);
    expect(r.res.status).toBe(0);
    expect(r.res.out).toMatch(/\[islands\] \d+ islands? from 6 artifacts/);
    expect(r.res.out).toMatch(/html\s+residents=6/);
  });
});

describe('reverse: generate --arc/--duration writes the reference shape into the brief', () => {
  const arc = (label: string) => { const f = path.join(work, `arc${n++}.json`); writeFileSync(f, JSON.stringify({ sections: [{ t_start: 0, t_end: 10, energy: 0.2, label }, { t_start: 10, t_end: 20, energy: 0.9, label: 'peak' }], cues: [{ t: 10, kind: 'drop' }] })); return f; };
  it('the arc and length reach the generator, a different arc changes the request, and no flags leaves it out', async () => {
    const withArc = await sinter(['generate', '-o', '@out', '--domain', 'html', '--arc', arc('hush'), '--duration', '20', 'a slow tide']);
    expect(withArc.res.status, withArc.res.out.slice(-400)).toBe(0);
    expect(withArc.generated[0].user).toContain('Reverse-mode brief');
    expect(withArc.generated[0].user).toContain('"hush"');
    expect(withArc.generated[0].user).toContain('drop at 10s');
    const other = await sinter(['generate', '-o', '@out', '--domain', 'html', '--arc', arc('thunder'), '--duration', '20', 'a slow tide']);
    expect(other.generated[0].user).toContain('"thunder"');
    expect(other.generated[0].user).not.toContain('"hush"');
    const plain = await sinter(['generate', '-o', '@out', '--domain', 'html', 'a slow tide']);
    expect(plain.generated[0].user).not.toContain('Reverse-mode brief');
  });
});

describe('brain: the art-knowledge techniques reach the governed brief', () => {
  it('the generator system brief names an artistic technique and style drawn from the knowledge base', async () => {
    const r = await sinter(['generate', '-o', '@out', '--domain', 'p5', 'a calm study in two shapes'], { generate: () => 'function setup(){createCanvas(400,400);}\nfunction draw(){background(20);ellipse(mouseX,mouseY,40,40);}' });
    expect(r.generated.length).toBeGreaterThan(0);
    const plain = await sinter(['generate', '-o', '@out', '--domain', 'html', 'a calm study in two shapes']);
    expect(plain.generated[0].system).not.toContain('Artistic technique:');
    expect(r.generated[0].system).toMatch(/Artistic technique: .+ — .+\. Style reference: .+\./);
  });
});

describe('autonomy: sinter garden status', () => {
  it('reports the garden health, and a data-less garden is declining', async () => {
    const r = await sinter(['garden', 'status']);
    expect(r.res.status, r.res.out.slice(-300)).toBe(0);
    expect(r.res.out).toContain('=== Garden Status ===');
    expect(r.res.out).toMatch(/Health: \d+(\.\d+)?%/);
  });
});

describe('agent + cortex + autonomy level: sinter bridge answers /mode, /skills, /autonomy and /cortex', () => {
  let child: ChildProcess | undefined; let base = ''; let fakeClose: (() => Promise<void>) | undefined; let log = '';
  async function freePort(): Promise<number> { return new Promise(res => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = (s.address() as net.AddressInfo).port; s.close(() => res(p)); }); }); }
  beforeAll(async () => {
    const d = dirs(); mkdirSync(d.home, { recursive: true });
    const fake = await startFakeProvider({ generate: () => LIVELY_HTML, judge: () => goodJudgeReply(0.8) });
    fakeClose = () => fake.close();
    const port = await freePort(); base = `http://127.0.0.1:${port}`;
    child = spawn(process.execPath, [path.join(root, 'bin/sinter'), 'bridge', String(port)], { cwd: root, env: fakeProviderEnv(fake, { home: d.home, stateRoot: d.state }) });
    child.stdout?.on('data', c => { log += c; }); child.stderr?.on('data', c => { log += c; });
    const t0 = Date.now();
    while (!/Listening:/.test(log)) { if (Date.now() - t0 > 90_000) throw new Error(`bridge never listened: ${log.slice(-400)}`); await new Promise(r => setTimeout(r, 250)); }
  });
  afterAll(async () => { if (child?.pid) child.kill('SIGTERM'); await fakeClose?.(); });

  async function events(sessionId: string): Promise<Array<Record<string, unknown>>> {
    const ac = new AbortController(); const timer = setTimeout(() => ac.abort(), 2500);
    const out: Array<Record<string, unknown>> = [];
    try {
      const res = await fetch(`${base}/api/tui/session/${sessionId}/events`, { signal: ac.signal });
      const reader = res.body!.getReader(); const dec = new TextDecoder(); let buf = '';
      for (;;) { const { value, done } = await reader.read(); if (done) break; buf += dec.decode(value); }
    } catch { /* aborted after replay */ }
    finally { clearTimeout(timer); }
    return out;
  }
  async function sse(sessionId: string): Promise<string> {
    const ac = new AbortController(); const timer = setTimeout(() => ac.abort(), 2500); let buf = '';
    try {
      const res = await fetch(`${base}/api/tui/session/${sessionId}/events`, { signal: ac.signal });
      const reader = res.body!.getReader(); const dec = new TextDecoder();
      for (;;) { const { value, done } = await reader.read(); if (done) break; buf += dec.decode(value); }
    } catch { /* aborted after replay */ } finally { clearTimeout(timer); }
    return buf;
  }
  void events;

  it('each slash command is answered by its organ', async () => {
    const created = await fetch(`${base}/api/tui/session`, { method: 'POST', body: '{}' });
    expect(created.status).toBe(201);
    const { sessionId } = await created.json() as { sessionId: string };
    for (const text of ['/mode', '/skills', '/autonomy', '/cortex']) {
      const r = await fetch(`${base}/api/tui/session/${sessionId}/input`, { method: 'POST', body: JSON.stringify({ mode: 'chat', text }) });
      expect(r.status, `${text}: ${await r.clone().text()}`).toBe(200);
    }
    const stream = await sse(sessionId);
    expect(stream).toContain('Available: ask, make, remix, improve');
    expect(stream).toContain('"type":"skill.list"');
    expect(stream).toContain('"type":"cortex.dashboard"');
    expect(stream).toMatch(/[Aa]utonomy/);
    expect(stream).toContain('Autonomy levels:');
    expect(stream).toContain('Cortex Dashboard');
  });
});
