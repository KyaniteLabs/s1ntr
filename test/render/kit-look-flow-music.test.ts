import { describe, expect, it } from 'vitest';
import { renderKitPiece } from './kitRender.js';

describe('sinter look / flow / music kits through the real harness', () => {
  it('sinter-look over a p5 piece: overlay exists and the frame is non-blank', async () => {
    const code = `function setup(){ createCanvas(windowWidth, windowHeight); background(20,24,40); noStroke(); fill(255,120,40); circle(width/2,height/2,200);
      const look = SinterLook.apply({ phosphor: 'hermes', tint: 0.5 });
      console.log('look:' + !!document.querySelector('[data-sinter-look]') + ' ' + SinterLook.PHOSPHOR.s1ntr.body); }
    function draw(){}`;
    const { result, analysis } = await renderKitPiece(code, 'p5', ['sinter-look']);
    expect(result.success, result.error).toBe(true);
    expect(result.logs.join('\n')).toContain('look:true #b29cff');
    expect(analysis?.hasVisibleContent).toBe(true);
  }, 90_000);

  it('sinter-flow in an html canvas piece: flow strokes render non-blank', async () => {
    const code = `<!doctype html><html><body style="margin:0;background:#06080f"><canvas id="c" width="640" height="360"></canvas><script>
      SinterFlow.seed(7); const ctx = document.getElementById('c').getContext('2d');
      const flow = new SinterFlow.Flow(640, 360, { count: 500, mode: 'curl', scale: 0.01, speed: 2 });
      ctx.strokeStyle = 'rgba(120,220,255,0.6)'; ctx.lineWidth = 1.5;
      for (let i = 0; i < 120; i++) flow.step(ctx);
      console.log('flow:' + (SinterFlow.noise2(1.3, 2.7) >= 0));
    </script></body></html>`;
    const { result, analysis } = await renderKitPiece(code, 'html', ['sinter-flow']);
    expect(result.success, result.error).toBe(true);
    expect(result.logs.join('\n')).toContain('flow:true');
    expect(analysis?.hasVisibleContent).toBe(true);
  }, 90_000);

  it('sinter-music loads in a tone piece and returns the documented shapes', async () => {
    const code = `const e = SinterMusic.euclid(8, 3, 0), m = SinterMusic.euclidMini('bd', 8, 3), a = SinterMusic.arp(['C4','E4','G4'], 'updown'), k = SinterMusic.markov(['C4','E4','G4','E4'], 8, 7), s = SinterMusic.structure('verse-chorus', 8);
      console.log('music:' + JSON.stringify([e, m, a, k.length, s.length]));
      const paper = document.getElementById('paper'); if (paper) { const c = paper.getContext('2d'); c.fillStyle = '#f59e0b'; c.fillRect(0, 0, paper.width, paper.height); }`;
    const { result } = await renderKitPiece(code, 'tone', ['sinter-music']);
    expect(result.logs.join('\n')).toContain('music:[[1,0,0,1,0,0,1,0],"bd ~ ~ bd ~ ~ bd ~",["C4","E4","G4","E4"],8,8]');
  }, 90_000);

  it('sinter-music is callable inside strudel\'s evaluate and the piece plays', async () => {
    // The pattern string is built by the kit helpers; strudel must evaluate it with the global in scope.
    const code = `const mini = SinterMusic.euclidMini('bd', 8, 3);
      console.log('strudel-mini:' + mini);
      s(mini).bank('RolandTR909').gain(0.8)`;
    const { result } = await renderKitPiece(code, 'strudel' as never, ['sinter-music']);
    const logs = result.logs.join('\n');
    expect(logs).toContain('strudel-mini:bd ~ ~ bd ~ ~ bd ~');
    expect(logs).not.toMatch(/Playback error|SinterMusic is not defined/);
    expect(result.audio?.success, result.audio?.error).toBe(true);
    const peak = Math.max(0, ...Array.from(result.audio?.samples ?? []).map(Math.abs));
    expect(peak, 'strudel render is silent').toBeGreaterThan(0.001);
  }, 120_000);

  it('full d3 card: forceSimulation + hierarchy run in an html piece and draw', async () => {
    const code = `<!doctype html><html><body style="margin:0;background:#06080f"><canvas id="c" width="640" height="360"></canvas><script>
      const nodes = d3.range(60).map(i => ({ i })); const sim = d3.forceSimulation(nodes).force('charge', d3.forceManyBody().strength(-8)).force('center', d3.forceCenter(320, 180)).stop();
      for (let k = 0; k < 120; k++) sim.tick();
      const root = d3.hierarchy({ children: nodes.map(n => ({ v: 1 + (n.i % 5) })) }).sum(d => d.v || 0);
      const ctx = document.getElementById('c').getContext('2d'); ctx.fillStyle = '#7dd3fc';
      nodes.forEach(n => { ctx.beginPath(); ctx.arc(n.x, n.y, 6, 0, 6.3); ctx.fill(); });
      console.log('d3:' + (root.value > 0) + ' ' + (typeof d3.treemap));
    </script></body></html>`;
    const { result, analysis } = await renderKitPiece(code, 'html', ['d3']);
    expect(result.success, result.error).toBe(true);
    expect(result.logs.join('\n')).toContain('d3:true function');
    expect(analysis?.hasVisibleContent).toBe(true);
  }, 90_000);
});
