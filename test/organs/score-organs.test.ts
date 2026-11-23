/**
 * Organs that decide the score: with the judge stub returning the SAME verdict every time, the
 * only thing that can move the final score is what the real renderer, perception, glitch-liveness
 * and value-structure (mud-camo) organs measure from the pixels.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { DEFAULT_JUDGE_REPLY, LIVELY_HTML, runOrganGeneration, type OrganRun } from './harness.js';

const runs: OrganRun[] = [];
const go = async (code: string, judgeReply?: Record<string, unknown>) => { const r = await runOrganGeneration({ code, judgeReply }); runs.push(r); return r; };
const judgeAt = (v: number) => ({ score: v, confidence: 0.9, reasoning: 'stub', dimensions: Object.fromEntries(Object.keys((DEFAULT_JUDGE_REPLY as { dimensions: object }).dimensions).map(k => [k, v])) });
afterAll(async () => { for (const r of runs) await r.cleanup(); });

// Frozen, near-uniform olive field: no motion, no contrast (the mud-camo failure).
const MUD_STATIC = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Mud</title>
<style>html,body{margin:0;height:100%;background:#5a5d3c}</style></head><body><div style="width:100%;height:100%;background:#5b5e3d"></div></body></html>`;

// Overmixed: drifting low-chroma olive/teal blobs at low contrast (the regression-to-the-mean look), not blank.
const MUD_MOVING = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Mud</title><style>html,body{margin:0;height:100%;background:#59593b}canvas{display:block}</style></head><body><canvas id="c"></canvas><script>
const c=document.getElementById('c');c.width=innerWidth;c.height=innerHeight;const x=c.getContext('2d');let t=0;
(function f(){t+=0.03;x.fillStyle='#59593b';x.fillRect(0,0,c.width,c.height);
for(let i=0;i<30;i++){x.fillStyle=i%2?'#5f6240':'#52583f';x.beginPath();x.arc(c.width/2+Math.cos(t+i)*(80+i*9),c.height/2+Math.sin(t*1.3+i)*(60+i*7),50,0,7);x.fill()}
requestAnimationFrame(f)})();</script></body></html>`;

// Alive glitch: saturated random blocks re-rolled every frame (many colours, hard edges, big motion).
const GLITCH_ALIVE = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Glitch</title><style>html,body{margin:0;height:100%;background:#000}canvas{display:block}</style></head><body><canvas id="c"></canvas><script>
const c=document.getElementById('c');c.width=innerWidth;c.height=innerHeight;const x=c.getContext('2d');
(function f(){for(let i=0;i<260;i++){x.fillStyle='hsl('+(Math.random()*360|0)+',100%,'+(35+Math.random()*30|0)+'%)';
x.fillRect(Math.random()*c.width,Math.random()*c.height,20+Math.random()*160,10+Math.random()*80)}
requestAnimationFrame(f)})();</script></body></html>`;

describe('score organs (production generation, constant judge verdict)', () => {
  it('render-measure gate: a frozen flat piece is rejected by the real renderer evidence while a lively one is admitted under the same judge', async () => {
    const lively = await go(LIVELY_HTML);
    const mud = await go(MUD_STATIC);
    process.stderr.write(`ORGAN lively=${JSON.stringify(lively.evaluation).slice(0, 600)}\nORGAN mud=${JSON.stringify(mud.evaluation).slice(0, 600)}\n`);
    expect(mud.evaluation.score).toBeLessThan(lively.evaluation.score);
    expect(mud.evaluation.admissionEligible).toBe(false);
    expect(lively.evaluation.admissionEligible).toBe(true);
  }, 240_000);

  it('mud-camo organ (value structure): a moving but overmixed olive field is capped, a colourful one is not', async () => {
    const mud = await go(MUD_MOVING, judgeAt(0.9));
    process.stderr.write(`ORGAN mudmoving=${JSON.stringify(mud.evaluation).slice(0, 500)}\n`);
    expect(mud.evaluation.score).toBeLessThanOrEqual(0.29);
  }, 240_000);

  it('glitch-liveness organ: a saturated, structured, moving glitch the judge hates is lifted to the alive floor', async () => {
    const glitch = await go(GLITCH_ALIVE, judgeAt(0.1));
    process.stderr.write(`ORGAN glitch=${JSON.stringify(glitch.evaluation).slice(0, 500)}\n`);
    expect(glitch.evaluation.score).toBeGreaterThanOrEqual(0.4);
  }, 240_000);
});
