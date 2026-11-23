/**
 * The first scored piece on main (first-scored-20261123) rendered 98% dark; the judge's measure cut its 0.66 to 0.40
 * and admission rejected it with no repair turn. The real binary must send a too-dark smoke frame to the repair turn.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { LIVELY_HTML, fakeProviderEnv, goodJudgeReply, runSinterAsync, startFakeProvider, type FakeProvider } from '../helpers/fakeProviderServer.js';

vi.setConfig({ testTimeout: 280_000, hookTimeout: 280_000 });

// Near-black ground, one thin dim ring and a small moving dot: runs clean, moves, and measures too-dark.
const DARK_HTML = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Orbit</title><style>html,body{margin:0;height:100%;background:#020205;overflow:hidden}canvas{display:block}</style></head><body><canvas id="c"></canvas><script>const c=document.getElementById('c');const x=c.getContext('2d');c.width=innerWidth;c.height=innerHeight;let t=0;(function f(){t+=0.02;x.fillStyle='#020205';x.fillRect(0,0,c.width,c.height);x.strokeStyle='rgba(60,60,110,0.5)';x.lineWidth=1;x.beginPath();x.ellipse(c.width/2,c.height/2,160,50,0,0,7);x.stroke();x.fillStyle='#5a4a20';x.beginPath();x.arc(c.width/2+Math.cos(t)*160,c.height/2+Math.sin(t)*50,2,0,7);x.fill();requestAnimationFrame(f)})();</script></body></html>`;

let work: string; let fake: FakeProvider; let env: NodeJS.ProcessEnv;
beforeAll(async () => {
  work = mkdtempSync(path.join(tmpdir(), 'sinter-dark-repair-'));
  fake = await startFakeProvider({ generate: ({ index }) => (index === 0 ? DARK_HTML : LIVELY_HTML), judge: () => goodJudgeReply(0.66) });
  env = fakeProviderEnv(fake, { home: path.join(work, 'home'), stateRoot: path.join(work, 'state') });
});
afterAll(async () => { await fake.close(); rmSync(work, { recursive: true, force: true }); });

describe('generate repairs a too-dark frame before the judge', () => {
  it('sends the judge measure to one repair turn and keeps the lit repair', async () => {
    const r = await runSinterAsync(['generate', '-o', path.join(work, 'out'), '--domain', 'html', 'a slow orbit of colored light'], env, work);
    expect(fake.generated.length, r.out.slice(-1500)).toBe(2);
    expect(fake.generated[1].user).toMatch(/too dark/);
    expect(r.out, r.out.slice(-1500)).not.toMatch(/Measured render penalty applied/);
    expect(r.status, r.out.slice(-1500)).toBe(0);
  });
});
