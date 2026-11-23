import { existsSync, mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CompositionOrchestrator, type CompositionResult } from '../../../../src/composition/CompositionOrchestrator.js';
import {
  finalizeHybrid, judgeHybrid, HybridLayerError, planHybrid, specFromPlan, writeHybridArtifacts,
} from '../../../../src/composition/hybrid/HybridComposition.js';
import { HybridPlanError, parseHybridPlan, parseLayerList, type HybridPlan } from '../../../../src/composition/hybrid/HybridPlan.js';
import type { LLMClient } from '../../../../src/llm/LLMClient.js';

const GLSL = 'precision mediump float;uniform float u_time;uniform vec2 u_resolution;void main(){vec2 uv=gl_FragCoord.xy/u_resolution;'
  + 'gl_FragColor=vec4(0.1+0.4*uv.x,0.15+0.2*sin(u_time*2.0+uv.y*6.0),0.5+0.3*uv.y,1.0);}';
const KINETIC = '<div id="k" style="position:fixed;inset:0;display:flex;align-items:center;justify-content:center;color:#ffe9a8;'
  + 'font:700 14vw monospace;text-shadow:0 0 20px #ff9">DRIFT</div>';
/** Responsive kinetic overlay: reads the beat every frame and pulses its own size and brightness. */
const RESP_KINETIC = KINETIC + '<script>(function(){var k=document.getElementById("k");function f(){var b=window.sinterSignal.beat;'
  + 'k.style.opacity=String(0.1+0.9*b);k.style.transform="scale("+(1+0.5*b)+")";document.body.style.background="rgba(255,233,168,"+(0.9*b)+")";requestAnimationFrame(f)}f()})()</script>';
/** Responsive shader: u_beat (set by the host from the beat) flashes the whole field. */
const RESP_GLSL = 'precision mediump float;uniform float u_time;uniform vec2 u_resolution;uniform float u_beat;void main(){vec2 uv=gl_FragCoord.xy/u_resolution;'
  + 'gl_FragColor=vec4(0.1+0.4*uv.x+0.5*u_beat,0.15+0.2*sin(u_time*2.0+uv.y*6.0)+0.4*u_beat,0.5+0.3*uv.y,1.0);}';
const P5 = 'function setup(){createCanvas(windowWidth,windowHeight);noStroke();}'
  + 'function draw(){background(30,60,120);fill(255,200,80);for(let i=0;i<30;i++){circle((i*97+frameCount*3)%width,(i*53)%height,60);}}';
const MASK_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect width="100" height="100" fill="#000"/>'
  + '<circle cx="50" cy="50" r="30" fill="#fff"/></svg>';

const PALETTE = { background: '#0b1020', colors: ['#7fd6ff', '#ffe9a8', '#ff7a90'] };
const planJson = (over: Record<string, unknown>) => JSON.stringify({
  title: 'T', reason: 'because the idea wants depth and a pulse', palette: PALETTE, bpm: null, signals: [], ...over,
});
const layer = (domain: string, role: string, extra: Record<string, unknown> = {}) => (
  { domain, role, prompt: `${domain} ${role} layer`, why: `${domain} serves the ${role}`, blendMode: 'normal', opacity: 1, ...extra });

let outRoot: string;
let prevGate: string | undefined;
beforeAll(() => {
  outRoot = process.env.SINTER_HYBRID_PROOF_DIR ?? mkdtempSync(path.join(tmpdir(), 'hybrid-'));
  prevGate = process.env.SINTER_COMPOSITE_GATE;
  process.env.SINTER_COMPOSITE_GATE = '0';
});
afterAll(() => {
  if (prevGate === undefined) delete process.env.SINTER_COMPOSITE_GATE;
  else process.env.SINTER_COMPOSITE_GATE = prevGate;
});

function withCode(plan: HybridPlan, codes: Array<string | undefined>): HybridPlan {
  return { ...plan, layers: plan.layers.map((l, i) => ({ ...l, code: codes[i] })) };
}
const fakeLlm = (reply: (idea: string) => string): LLMClient =>
  ({ generate: async (_system: string, user: string) => ({ code: reply(user) }) }) as unknown as LLMClient;

async function build(name: string, plan: HybridPlan) {
  const result = await CompositionOrchestrator.compose(specFromPlan(plan));
  const finalized = finalizeHybrid(result, plan);
  const outDir = path.join(outRoot, name);
  const artifacts = await writeHybridArtifacts(outDir, result, finalized);
  return { result, finalized, outDir, artifacts, manifest: JSON.parse(readFileSync(artifacts.manifestPath, 'utf8')) };
}

const CLASH_GLSL = 'precision mediump float;uniform float u_time;uniform vec2 u_resolution;void main(){vec2 uv=gl_FragCoord.xy/u_resolution;'
  + 'gl_FragColor=vec4(0.0,0.9+0.1*sin(u_time*2.0+uv.y*6.0),0.1,1.0);}';
const CLASH_KINETIC = '<div id="k" style="position:fixed;inset:0;display:flex;align-items:center;justify-content:center;color:#ff6a00;'
  + 'font:700 14vw monospace">DRIFT</div>';

describe('layered switch spellings', () => {
  it('SINTER_LAYERED and the old SINTER_HYBRID_LAYERS both turn it on; neither is the default', async () => {
    const { hybridEnabled } = await import('../../../../src/composition/hybrid/HybridPlan.js');
    expect(hybridEnabled({})).toBe(false);
    expect(hybridEnabled({ SINTER_LAYERED: '1' })).toBe(true);
    expect(hybridEnabled({ SINTER_HYBRID_LAYERS: '1' })).toBe(true);
  });
});

describe('beat signals run through the control-recipe organs', () => {
  it('builds a valid ControlRecipe and rehearses it on the host CompositionControlRuntime', async () => {
    const { buildHybridControlRecipe, rehearseHybridControl } = await import('../../../../src/composition/hybrid/HybridControl.js');
    const plan = parseHybridPlan(planJson({
      bpm: 90, layers: [layer('glsl', 'background'), layer('kinetic', 'overlay'), layer('tone', 'sound')],
      signals: [{ kind: 'beat', from: 2, to: 1, param: 'scale', depth: 0.5 }, { kind: 'beat', from: 2, to: 0, param: 'opacity', depth: 0.25 }],
    }));
    const recipe = buildHybridControlRecipe(plan)!;
    expect(recipe.mappings.map((m) => m.targetId)).toEqual(['t0-scale', 't1-opacity']);
    const written = rehearseHybridControl(recipe);
    expect(written.get('t0-scale')).toBe(0.5);
    expect(written.get('t1-opacity')).toBe(0.25);
    expect(buildHybridControlRecipe(parseHybridPlan(planJson({ bpm: null, layers: [layer('glsl', 'background')] })))).toBeUndefined();
  });
});

it('blocks outbound browser requests before judging the composition', async () => {
  let requests = 0;
  const server = createServer((_req, res) => { requests++; res.end('external'); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Expected a TCP address');
    const url = `http://127.0.0.1:${address.port}/probe`;
    const plan = parseHybridPlan(planJson({ layers: [layer('glsl', 'background')] }));
    const dir = mkdtempSync(path.join(tmpdir(), 'hybrid-isolation-'));
    const html = `<img src="${url}"><iframe src="${url}"></iframe><script>fetch("${url}").catch(()=>{});</script>`;
    const result = await judgeHybrid(html, plan, dir, { width: 160, height: 90, earlyMs: 100, lateMs: 200 });
    expect(['pass', 'fail']).toContain(result.verdict);
    expect(requests).toBe(0);
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
}, 45_000);

describe('judge criterion: seam/coherence between layers', () => {
  it('scores a palette-clashing pair lower than a coherent pair, and names the criterion', async () => {
    const mk = (codes: string[]) => withCode(parseHybridPlan(planJson({
      bpm: 100, layers: [layer('glsl', 'background'), layer('kinetic', 'overlay', { blendMode: 'normal' })], signals: [],
    })), codes);
    const good = await build('coherent', mk([GLSL, KINETIC]));
    const badPlan = mk([CLASH_GLSL, CLASH_KINETIC]);
    const badResult = await CompositionOrchestrator.compose(specFromPlan(badPlan));
    const badFinalized = finalizeHybrid(badResult, badPlan);
    const bad = await judgeHybrid(badFinalized.html, badPlan, path.join(outRoot, 'incoherent-evidence'), {
      analyzer: badFinalized.build.analyzer, control: badFinalized.build.control,
    });
    expect(good.artifacts.judgement.coherence!.criterion).toBe('seam/coherence between layers');
    expect(good.manifest.judge.coherence.analyzerAgreement).toBeGreaterThanOrEqual(0);
    expect(good.artifacts.judgement.coherence!.score).toBeGreaterThan(bad.coherence!.score + 0.3);
    expect(bad.verdict).toBe('fail');
    expect(bad.reason).toContain('seam/coherence between layers');
  }, 120_000);
});

describe('hybrid recipes render and are judged', () => {
  it('visual + visual: glsl background with kinetic overlay pulsing on the beat', async () => {
    const plan = withCode(parseHybridPlan(planJson({
      bpm: 100, layers: [layer('glsl', 'background'), layer('kinetic', 'overlay', { blendMode: 'screen' })],
      signals: [{ kind: 'beat', from: 'clock', to: 1, param: 'scale', depth: 0.5 }],
    })), [GLSL, RESP_KINETIC]);
    const { artifacts, manifest, finalized } = await build('visual-visual', plan);
    expect(artifacts.judgement.verdict).toBe('pass');
    expect(artifacts.judgement.framesDiffer).toBe(true);
    expect(artifacts.judgement.early!.spread).toBeGreaterThan(0.02);
    expect(existsSync(artifacts.judgement.stills!.early)).toBe(true);
    expect(manifest.medium_line).toContain('layered piece of glsl background + kinetic overlay');
    expect(manifest.signals).toHaveLength(1);
    expect(finalized.html).toContain('id="sinter-hybrid-stage"');
    // the beat grid is KeyframeAnimation CSS, one loop per beat (60000/100 ms), on the kinetic layer
    expect(finalized.html).toMatch(/@keyframes sinter-[\w-]+ \{[\s\S]*transform: scale\(1\.04\)/);
    expect(finalized.html).toContain('animation-duration: 600ms');
    expect(finalized.build.project.animations).toHaveLength(1);
    expect(finalized.build.sequencerOrder).toEqual(['glsl', 'kinetic']);
    // the beat signal runs as a ControlRecipe through the in-page control runtime, and it really wrote the target
    expect(manifest.composition.control).toMatchObject({ recipeId: 'layered-beat', mappings: ['beat-0'] });
    expect(finalized.html).toContain('id="sinter-hybrid-control"');
    expect(artifacts.judgement.control).toHaveLength(1);
    expect(typeof artifacts.judgement.control![0].target).toBe('number');
  }, 90_000);

  it('visual + mask: an svg layer cuts a p5 layer as a luminance mask', async () => {
    const plan = withCode(parseHybridPlan(planJson({
      layers: [layer('p5', 'background'), layer('svg', 'mask', { maskTarget: 0 })],
    })), [P5, MASK_SVG]);
    const { artifacts, manifest, finalized } = await build('visual-mask', plan);
    // the mask CSS comes from LayerMaskManager.generateCSSMask, bound to the target iframe
    expect(finalized.html).toMatch(/iframe\.sinter-layer\[data-layer-index="0"\] \{\s*--mask-source: url\("data:image\/svg\+xml;base64,/);
    expect(finalized.html).toContain('mask-image: var(--mask-source);');
    expect(finalized.build.masks).toEqual([expect.objectContaining({ source: 1, target: 0 })]);
    expect(finalized.build.project.masks).toHaveLength(1);
    expect(manifest.layers[1]).toMatchObject({ domain: 'svg', role: 'mask', maskTarget: 0 });
    expect(artifacts.judgement.verdict).toBe('pass');
    // the circle mask leaves the corners black: the masked frame is darker than the bare p5 field
    expect(artifacts.judgement.early!.meanLuminance).toBeLessThan(0.3);
  }, 90_000);

  it('visual + sound: glsl field and a tone layer share one bpm, and the beat drives the field', async () => {
    const plan = withCode(parseHybridPlan(planJson({
      bpm: 96, layers: [layer('glsl', 'background', { prompt: 'a slow blue field' }),
        layer('tone', 'sound', { prompt: 'a slow ambient pulse, warm drone' })],
      signals: [{ kind: 'beat', from: 1, to: 0, param: 'opacity', depth: 0.6 }],
    })), [RESP_GLSL, undefined]);
    const { artifacts, manifest, result } = await build('visual-sound', plan);
    expect(result.layers[1].generated).toBe(true);
    expect(manifest.bpm).toBe(96);
    expect(manifest.signals[0]).toMatchObject({ from: 1, to: 0, param: 'opacity' });
    expect(manifest.medium_line).toContain('layered piece of glsl background + tone sound');
    expect(manifest.medium_line).toContain('Tone.js');
    expect(artifacts.judgement.verdict).toBe('pass');
    expect(artifacts.judgement.framesDiffer).toBe(true);
  }, 240_000);
});

describe('a failing layer fails loudly and names the layer', () => {
  it('a layer that did not generate names its index, domain and role', () => {
    const plan = parseHybridPlan(planJson({ layers: [layer('glsl', 'background'), layer('kinetic', 'overlay')] }));
    const result = { html: '<html><body></body></html>', layers: [
      { generated: true, codeLength: 1 }, { generated: false, error: 'provider said no', codeLength: 0 }],
    } as unknown as CompositionResult;
    expect(() => finalizeHybrid(result, plan)).toThrow(HybridLayerError);
    expect(() => finalizeHybrid(result, plan)).toThrow('hybrid layer 1 (kinetic, overlay) failed: provider said no');
  });

  it('a layer that throws at runtime preserves the entire prior export', async () => {
    const plan = withCode(parseHybridPlan(planJson({ layers: [layer('glsl', 'background'), layer('p5', 'overlay')] })),
      [GLSL, 'function setup(){ createCanvas(100,100); }\nfunction draw(){ throw new Error("boom-in-layer"); }']);
    const good = withCode(parseHybridPlan(planJson({
      bpm: 100, layers: [layer('glsl', 'background'), layer('kinetic', 'overlay', { blendMode: 'screen' })],
      signals: [{ kind: 'beat', from: 'clock', to: 1, param: 'scale', depth: 0.5 }],
    })), [GLSL, RESP_KINETIC]);
    const { outDir, artifacts } = await build('preserve-judged-export', good);
    expect(artifacts.judgement.verdict).toBe('pass');
    const bundle = () => readdirSync(outDir).sort().map(name => [name, readFileSync(path.join(outDir, name))]);
    const previous = bundle();
    expect(previous.map(([name]) => name)).toEqual([
      'composition.html', 'composition.hybrid.json', 'composition.project.json',
      'hybrid-early.png', 'hybrid-late.png', 'medium.json',
    ]);
    const result = await CompositionOrchestrator.compose(specFromPlan(plan));
    await expect(writeHybridArtifacts(outDir, result, finalizeHybrid(result, plan)))
      .rejects.toThrow(/layer 1 \(p5, overlay\) threw: .*boom-in-layer/);
    expect(bundle()).toEqual(previous);
  }, 90_000);

  it('rejects plans instead of silently defaulting to p5', () => {
    expect(() => parseHybridPlan(planJson({ layers: [layer('blender', 'background')] })))
      .toThrow('layer 0 (blender): unsupported domain');
    expect(() => parseHybridPlan(planJson({ layers: [] }))).toThrow('plan: no layers');
    expect(() => parseHybridPlan('not json at all')).toThrow(HybridPlanError);
    expect(() => parseHybridPlan(planJson({ layers: [layer('p5', 'background'), layer('p5', 'mask', { maskTarget: 0 })] })))
      .toThrow('layer 1 (p5): a mask layer must be svg');
    expect(() => parseHybridPlan(planJson({ layers: [layer('tone', 'sound')] }))).toThrow('a sound layer needs a bpm');
  });

  it('refuses an operator layer list the planner changed', () => {
    const wanted = parseLayerList('glsl:background,kinetic:overlay');
    expect(() => parseHybridPlan(planJson({ layers: [layer('p5', 'background'), layer('kinetic', 'overlay')] }), wanted))
      .toThrow("the planner changed the operator's layer list");
  });
});

describe('adapter checks fail loudly, naming the layer', () => {
  it('a p5 layer without setup/draw is refused by the p5 adapter', () => {
    const plan = parseHybridPlan(planJson({ layers: [layer('p5', 'background')] }));
    const result = { html: '<html><body></body></html>', layers: [{ generated: true, codeLength: 1, artifactHtml: 'noop()' }] } as unknown as CompositionResult;
    expect(() => finalizeHybrid(result, plan)).toThrow('layer 0 (p5, background) failed its adapter check: Missing setup() function');
  });
});

describe('open prompts: S1NTR decides and records why', () => {
  const PLANS: Record<string, string> = {
    'Idea: ember': planJson({ reason: 'ember is one glowing field, so one medium is enough', layers: [layer('glsl', 'background')] }),
    'Idea: what does a lighthouse dream of?': planJson({
      bpm: 72, reason: 'a dream needs a slow field, a beacon shape and a low hum',
      layers: [layer('hydra', 'background'), layer('svg', 'overlay'), layer('tone', 'sound')] }),
    'Idea: loud silence': planJson({ reason: 'a contradiction reads best as type over stillness',
      layers: [layer('p5', 'background'), layer('kinetic', 'overlay')] }),
  };
  it('different open prompts yield different domain choices, each with a reason in the manifest', async () => {
    const llm = fakeLlm((idea) => PLANS[idea]);
    const chosen = new Set<string>();
    for (const idea of ['ember', 'what does a lighthouse dream of?', 'loud silence']) {
      const plan = await planHybrid(idea, llm);
      expect(plan.chosenBy).toBe('planner');
      expect(plan.reason.length).toBeGreaterThan(10);
      chosen.add(plan.layers.map((l) => l.domain).join('+'));
      const dir = path.join(outRoot, `open-${chosen.size}`);
      const result = { html: '<html><body></body></html>', layers: plan.layers.map((l) => ({ generated: true, codeLength: 1, artifactHtml: l.domain === 'hydra' ? 'osc(10).out()' : l.domain === 'tone' ? 'Tone.start()' : l.domain === 'p5' ? 'function setup(){} function draw(){}' : '<svg/>' })) } as unknown as CompositionResult;
      const art = await writeHybridArtifacts(dir, result, finalizeHybrid(result, plan), { judge: false });
      const manifest = JSON.parse(readFileSync(art.manifestPath, 'utf8'));
      expect(manifest.reason).toBe(plan.reason);
      expect(manifest.layers.every((l: { why: string }) => l.why.length > 0)).toBe(true);
      expect(manifest.medium_line).toContain(`Why: ${plan.reason}`);
      expect(JSON.parse(readFileSync(art.mediumPath, 'utf8')).medium_line).toBe(manifest.medium_line);
    }
    expect([...chosen].sort()).toEqual(['glsl', 'hydra+svg+tone', 'p5+kinetic']);
  });

  it('a single-medium choice is recorded as single, not forced into layers', async () => {
    const plan = await planHybrid('ember', fakeLlm((idea) => PLANS[idea]));
    expect(plan.kind).toBe('single');
    expect(plan.layers).toHaveLength(1);
  });
});


describe('a beat-wired layer must answer the beat in its own pixels', () => {
  const wired = (code: string) => withCode(parseHybridPlan(planJson({
    bpm: 100, layers: [layer('glsl', 'background'), layer('kinetic', 'overlay', { blendMode: 'screen' })],
    signals: [{ kind: 'beat', from: 'clock', to: 1, param: 'scale', depth: 0.5 }],
  })), [GLSL, code]);
  const STILL_GLSL = 'precision mediump float;uniform vec2 u_resolution;void main(){vec2 uv=gl_FragCoord.xy/u_resolution;gl_FragColor=vec4(0.1+0.4*uv.x,0.2,0.5+0.3*uv.y,1.0);}';

  it('the layer brief names the signal and demands a visible response, only for wired layers', () => {
    const plan = parseHybridPlan(planJson({
      bpm: 100, layers: [layer('glsl', 'background'), layer('kinetic', 'overlay')],
      signals: [{ kind: 'beat', from: 'clock', to: 1, param: 'scale', depth: 0.5 }],
    }));
    const wiredPrompt = specFromPlan(plan).layers[1].prompt;
    expect(wiredPrompt).toContain('WIRED to the beat');
    expect(wiredPrompt).toContain('window.sinterSignal.beat');
    expect(wiredPrompt).toContain('window.sinterControl.scale');
    expect(wiredPrompt).toMatch(/VISIBLE[\s\S]*pulse[\s\S]*cut[\s\S]*colour shift/);
    const free = specFromPlan(plan).layers[0].prompt;
    expect(free).not.toContain('WIRED');
    expect(free).toContain('If you animate to rhythm');
    const glslWired = specFromPlan(parseHybridPlan(planJson({
      bpm: 100, layers: [layer('glsl', 'background'), layer('kinetic', 'overlay')],
      signals: [{ kind: 'beat', from: 'clock', to: 0, param: 'opacity', depth: 0.5 }],
    }))).layers[0].prompt;
    expect(glslWired).toContain('uniform float u_beat');
  });

  it('a responsive layer passes: the signal moves its frame by more than its own motion', async () => {
    const { artifacts } = await build('signal-responsive', wired(RESP_KINETIC));
    expect(artifacts.judgement.verdict).toBe('pass');
    const [sig] = artifacts.judgement.signals!;
    expect(sig).toMatchObject({ layer: 1, domain: 'kinetic', status: 'responsive', samples: { beat: 5, same: 6 } });
    expect(sig.effect - sig.noise).toBeGreaterThanOrEqual(0.01);
    // eslint-disable-next-line no-console
    console.info(`signal-response responsive fixture: effect ${sig.effect} vs noise ${sig.noise}`);
  }, 90_000);

  it('a deaf layer fails the coherence check, naming the layer', async () => {
    let thrown = '';
    try { await build('signal-deaf', wired(KINETIC)); } catch (e) { thrown = (e as Error).message; }
    expect(thrown).toContain('seam/coherence between layers: layer 1 (kinetic) is wired to the beat but its frames do not change with the signal');
  }, 90_000);

  const blocks = (n: number, w: number) => '<canvas id="c" style="position:fixed;inset:0;width:100%;height:100%"></canvas><script>(function(){var c=document.getElementById("c"),x=c.getContext("2d");'
    + 'c.width=320;c.height=180;function f(){for(var i=0;i<' + n + ';i++){x.fillStyle="hsl("+Math.floor(Math.random()*360)+",100%,50%)";'
    + 'x.fillRect(Math.random()*320,Math.random()*180,10+Math.random()*' + w + ',4+Math.random()*30)}requestAnimationFrame(f)}f()})()</script>';
  // A high-contrast stripe keeps the flash visible to the composite's blank-frame check.
  const flash = 'var b=(window.sinterSignal&&window.sinterSignal.beat)||0;'
    + 'if(b>0.5){x.fillStyle="#fff";x.fillRect(0,0,320,180);x.fillStyle="#333";x.fillRect(0,0,32,180);requestAnimationFrame(f);return}'
    + 'x.clearRect(0,0,320,180);';
  const GLITCH_BEAT = blocks(20, 40).replace('function f(){', 'function f(){' + flash);

  it('a saturated glitch layer that ignores the beat is recorded "not measurable" and never failed; a calm deaf one is', async () => {
    const ok = await build('signal-glitch', wired(blocks(60, 60)));
    const [sig] = ok.artifacts.judgement.signals!;
    expect(sig.noise).toBeGreaterThanOrEqual(0.03);
    expect(sig).toMatchObject({ layer: 1, status: 'not-measurable' });
    expect(ok.artifacts.judgement.verdict).toBe('pass');
    expect(ok.artifacts.judgement.notes!.join(' ')).toContain('response not measurable');
    let thrown = '';
    try { await build('signal-calm-deaf', wired(KINETIC)); } catch (e) { thrown = (e as Error).message; }
    expect(thrown).toContain('layer 1 (kinetic) is wired to the beat');
  }, 120_000);

  it('a busy glitch layer that does answer the beat passes on evidence', async () => {
    const ok = await build('signal-glitch-beat', wired(GLITCH_BEAT));
    expect(ok.artifacts.judgement.signals![0]).toMatchObject({ status: 'responsive' });
    expect(ok.artifacts.judgement.notes).toBeUndefined();
  }, 120_000);

  it('a slow glitch (own churn near 0.016) is not failed', async () => {
    const ok = await build('signal-glitch-slow', wired(blocks(2, 40)));
    const [sig] = ok.artifacts.judgement.signals!;
    expect(sig.noise).toBeGreaterThanOrEqual(0.01);
    expect(sig.status).toBe('not-measurable');
    expect(ok.artifacts.judgement.verdict).toBe('pass');
  }, 120_000);

  const FAST_GLSL = 'precision mediump float;uniform float u_time;uniform vec2 u_resolution;uniform float u_beat;'
    + 'float h(vec2 p){return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453);}void main(){vec2 uv=gl_FragCoord.xy/u_resolution;'
    + 'float n=h(floor(uv*24.0)+floor(u_time*30.0));gl_FragColor=vec4(vec3(n*0.8)+BEATEXPR,1.0);}';
  it('a fast shader that ignores the beat is never a silent pass; a fast shader that answers it passes', async () => {
    const plan = (code: string) => withCode(parseHybridPlan(planJson({
      bpm: 100, layers: [layer('glsl', 'background')], signals: [{ kind: 'beat', from: 'clock', to: 0, param: 'opacity', depth: 0.5 }],
    })), [code]);
    const deaf = await build('signal-fast-deaf', plan(FAST_GLSL.replace('BEATEXPR', '0.0')));
    expect(deaf.artifacts.judgement.signals![0].status).toBe('not-measurable');
    expect(deaf.artifacts.judgement.notes!.join(' ')).toContain('response not measurable');
    const resp = await build('signal-fast-resp', plan(FAST_GLSL.replace('BEATEXPR', 'vec3(0.0,0.0,1.0)*u_beat*0.9')));
    expect(resp.artifacts.judgement.signals![0].status).toBe('responsive');
  }, 180_000);

  it('a shader answers the beat through u_beat and a still shader is deaf', async () => {
    const plan = (code: string) => withCode(parseHybridPlan(planJson({
      bpm: 100, layers: [layer('glsl', 'background')],
      signals: [{ kind: 'beat', from: 'clock', to: 0, param: 'opacity', depth: 0.5 }],
    })), [code]);
    const ok = await build('signal-glsl', plan(RESP_GLSL));
    expect(ok.artifacts.judgement.signals![0].status).toBe('responsive');
    let thrown = '';
    try { await build('signal-glsl-still', plan(STILL_GLSL)); } catch (e) { thrown = (e as Error).message; }
    expect(thrown).toContain('layer 0 (glsl) is wired to the beat');
  }, 120_000);
});

describe('classifySignalResponse', () => {
  it('separates beat-held from same-beat differences at the same spacing', async () => {
    const { classifySignalResponse } = await import('../../../../src/composition/hybrid/HybridComposition.js');
    expect(classifySignalResponse(0, 'p5', [0.05, 0.06, 0.055, 0.052, 0.058], [0.004, 0.006, 0.005, 0.003, 0.004, 0.005]).status).toBe('responsive');
    expect(classifySignalResponse(0, 'p5', [0.004, 0.005, 0.003, 0.004, 0.006], [0.004, 0.006, 0.005, 0.003, 0.004, 0.005]).status).toBe('deaf');
    expect(classifySignalResponse(0, 'p5', [0.2, 0.3, 0.25, 0.22, 0.27], [0.25, 0.21, 0.3, 0.24, 0.26, 0.23]).status).toBe('not-measurable');
    // churn alone never separates, even when the beat shots happen to land higher on average
    expect(classifySignalResponse(0, 'p5', [0.26, 0.27, 0.28, 0.22, 0.25], [0.25, 0.21, 0.3, 0.24, 0.26, 0.23]).status).toBe('not-measurable');
    // too small a gap is not a visible response even when perfectly ordered
    expect(classifySignalResponse(0, 'p5', [0.006, 0.007, 0.0065, 0.0062, 0.0068], [0.001, 0.002, 0.001, 0.0015, 0.001, 0.002]).status).toBe('deaf');
  });

  it('the two loved glitch keepers, measured 2026-11-18, are never failed', async () => {
    const { classifySignalResponse } = await import('../../../../src/composition/hybrid/HybridComposition.js');
    // Measured medians with a synthetic spread around each.
    const around = (m: number) => [0.9, 1.1, 1.0, 0.95, 1.05, 1.0].map((k) => m * k);
    for (const [beat, same] of [[0.2418, 0.2416], [0.2039, 0.2021]]) {
      expect(classifySignalResponse(0, 'kinetic', around(beat).slice(0, 5), around(same)).status).toBe('not-measurable');
    }
  });
});
