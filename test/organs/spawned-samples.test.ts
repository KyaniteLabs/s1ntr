/**
 * Dogfood 2026-11-19 (findings 1, 4, 6): replace export-list samples with the real command output the operator
 * now gets. Spawned CLI + fake provider; samples are written to test/organs/outputs when WRITE_ORGAN_SAMPLES=1.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { fakeProviderEnv, runSinterAsync, startFakeProvider, type FakeProvider } from '../helpers/fakeProviderServer.js';

vi.setConfig({ testTimeout: 280_000, hookTimeout: 280_000 });
const WRITE = process.env.WRITE_ORGAN_SAMPLES === '1';
let work: string; let fake: FakeProvider; let env: NodeJS.ProcessEnv; let proj: string;
const run = (args: string[]) => runSinterAsync(args, env, proj);
const clean = (t: string) => t.replace(work, '<work>').replace(/\/(home|Users|tmp|var)\/[^\s"']+/g, '<path>').replace(/[\w.+-]+@[\w-]+\.[a-z]{2,}/g, '<email>');
function emit(organ: string, steps: Array<{ cmd: string; out: string; status: number | null }>): void {
  const body = steps.map(s => `$ ${s.cmd}\n${s.out.trim().split('\n').slice(0, 14).join('\n')}\n# exit: ${s.status}`).join('\n\n');
  const text = clean(`# organ: ${organ} | data: real command, fake provider\n${body}\n`).split('\n').slice(0, 64).join('\n') + '\n';
  if (WRITE) writeFileSync(path.join('test/organs/outputs', `${organ}.txt`), text);
}
const step = async (args: string[]) => { const r = await run(args); return { cmd: `sinter ${args.join(' ')}`.replace(work, '<work>'), out: r.out, status: r.status }; };

beforeAll(async () => {
  work = mkdtempSync(path.join(tmpdir(), 'sinter-samples-')); fake = await startFakeProvider();
  proj = path.join(work, 'proj'); mkdirSync(proj, { recursive: true });
  env = fakeProviderEnv(fake, { home: path.join(work, 'home'), stateRoot: path.join(work, 'state') });
});
afterAll(async () => { await fake.close(); rmSync(work, { recursive: true, force: true }); });

describe('operator-visible samples after one accepted generate', () => {
  it('every organ prints something real once a piece exists', async () => {
    const before = await step(['entropy']);
    const g = await run(['generate', '-o', path.join(work, 'out'), '--domain', 'html', 'a slow orbit of colored light']);
    expect(g.status).toBe(0);
    const gen = { cmd: 'sinter generate --domain html "a slow orbit of colored light"', out: g.out, status: g.status };
    const entropy = await step(['entropy']); expect(entropy.out).toMatch(/harvested/);
    emit('entropy', [before, entropy]);
    const fsOut = await step(['fs', 'artifacts']); expect(fsOut.out).not.toMatch(/No artifacts found/);
    emit('fs', [gen, fsOut]);
    const compost = await step(['compost', 'status']); emit('compost', [compost]);
    const gallery = await step(['gallery', 'list']); expect(gallery.out).toMatch(/1 project/);
    emit('gallery', [gallery]);
    const seed = await step(['site', 'seed', '--slots', '2']); expect(seed.out).toMatch(/Seeded 2 slot/);
    emit('site', [seed]);
    const sw = await step(['swarm', 'sessions']); expect(sw.out).toMatch(/swarm sessions/i);
    emit('swarm', [sw]);
    const dir = path.join(work, 'plugins'); mkdirSync(path.join(dir, 'demo'), { recursive: true });
    writeFileSync(path.join(dir, 'demo', 'plugin.json'), JSON.stringify({ id: 'demo', version: '1.0.0', entry: 'index.js', domains: ['html'] }));
    writeFileSync(path.join(dir, 'demo', 'index.js'), 'export function generate() { return "<html></html>"; }\n');
    const p1 = await step(['plugins', 'status', '--plugins-dir', dir]); const p2 = await step(['plugins', 'pin', 'demo', '--plugins-dir', dir]); const p3 = await step(['plugins', 'status', '--plugins-dir', dir]);
    expect(p3.out).toMatch(/demo\s+admitted/); emit('plugins', [p1, p2, p3]);
    const gbg = await step(['gbg']); expect(gbg.out.trim().length).toBeGreaterThan(30);
    emit('atelier', [gbg]);
    const fixDir = path.join(work, 'fixdir'); mkdirSync(path.join(fixDir, 'src'), { recursive: true }); writeFileSync(path.join(fixDir, 'src', 'add.js'), 'export const add = (a, b) => a - b;\n');
    const f = await runSinterAsync(['fix', 'src/add.js', '--error', 'add(1,2) returned -1, expected 3', '--confirm', 'never'], env, fixDir);
    emit('fix', [{ cmd: 'sinter fix src/add.js --error "add(1,2) returned -1, expected 3" --confirm never', out: f.out.split('\n').filter(l => !l.startsWith('[CLI]')).join('\n'), status: f.status }]);
    const rate = 8000; const pcm = Buffer.alloc(rate * 2 * 2); for (let i = 0; i < rate * 2; i++) pcm.writeInt16LE(Math.round(9000 * Math.sin(2 * Math.PI * 220 * i / rate)), i * 2);
    const h = Buffer.alloc(44); h.write('RIFF', 0); h.writeUInt32LE(36 + pcm.length, 4); h.write('WAVEfmt ', 8); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write('data', 36); h.writeUInt32LE(pcm.length, 40);
    const wavPath = path.join(work, 'hum.wav'); writeFileSync(wavPath, Buffer.concat([h, pcm]));
    const { analyzeVoiceFile, buildVoiceBrief } = await import('../../src/audio/VoiceBrief.js');
    const brief = buildVoiceBrief(await analyzeVoiceFile(wavPath)); expect(brief).toMatch(/Palette:/);
    emit('audio', [{ cmd: 'buildVoiceBrief(analyzeVoiceFile(hum.wav))  # what `generate --voice-file hum.wav` adds to the brief', out: brief, status: 0 }]);
    const spec = path.join(work, 'suite.json'); mkdirSync(path.join(work, 'cand'), { recursive: true });
    writeFileSync(spec, JSON.stringify({ name: 's', cases: [{ id: 'c1', prompt: 'orbit', domain: 'html', minScore: 0.3, tags: [] }], createdAt: '2026-01-01T00:00:00Z' }));
    writeFileSync(path.join(work, 'cand', 'c1.html'), '<!DOCTYPE html><html><body><canvas id=c></canvas><script>const x=document.getElementById("c").getContext("2d");let t=0;function f(){t+=.1;x.fillStyle="hsl("+t*40+",80%,50%)";x.fillRect(0,0,99,99);requestAnimationFrame(f)}f()</script></body></html>');
    const q = await step(['quality', 'run', '--spec', spec, '--candidates', path.join(work, 'cand')]); expect(q.out).toMatch(/PASS c1/);
    emit('quality', [q]);
    const sched = path.join(work, 'sched.json'); const inc = path.join(work, 'inc.json'); const cand = path.join(work, 'cand.json');
    // The guard needs at least DEFAULT_MIN_SCHEDULED (8) paired prompts before it will decide.
    const ids = Array.from({ length: 8 }, (_, i) => `p${i + 1}`); const scores = (v: number) => Object.fromEntries(ids.map(id => [id, v]));
    writeFileSync(sched, JSON.stringify(ids)); writeFileSync(inc, JSON.stringify(scores(0.5))); writeFileSync(cand, JSON.stringify(scores(0.8)));
    const d = await step(['dream', 'guard', '--scheduled', sched, '--incumbent', inc, '--candidate', cand]);
    writeFileSync(cand, JSON.stringify(scores(0.4)));
    const d2 = await step(['dream', 'guard', '--scheduled', sched, '--incumbent', inc, '--candidate', cand]);
    expect(d.status).toBe(0); expect(d2.status).toBe(4);
    emit('dreaming', [d, d2]);
  });
});
