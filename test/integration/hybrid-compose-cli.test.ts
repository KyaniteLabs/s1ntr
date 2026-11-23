/**
 * Spawned-CLI proof for the hybrid path: the real bin/sinter against the fake provider, config pinned by
 * isolatedCliEnv. Needs a built dist (pnpm build). No real provider is reachable.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fakeProviderEnv, runSinterAsync, startFakeProvider, type FakeCall, type FakeProvider } from '../helpers/fakeProviderServer.js';
import { isolatedCliEnv } from '../helpers/isolatedCli.js';

const GLSL = 'precision mediump float;uniform float u_time;uniform vec2 u_resolution;'
  + 'float hash(vec2 p){return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453);}'
  + 'float noise(vec2 p){vec2 i=floor(p),f=fract(p);f=f*f*(3.0-2.0*f);return mix(mix(hash(i),hash(i+vec2(1,0)),f.x),mix(hash(i+vec2(0,1)),hash(i+vec2(1,1)),f.x),f.y);}'
  + 'void main(){vec2 uv=gl_FragCoord.xy/u_resolution;float n=noise(uv*6.0+u_time*0.3);'
  + 'vec3 a=vec3(0.1,0.3,0.6),b=vec3(0.9,0.5,0.3),c=vec3(0.2,0.8,0.7);gl_FragColor=vec4(mix(mix(a,b,n),c,uv.y),1.0);}';
const KINETIC = '<!DOCTYPE html><html><head><meta charset="utf-8"><title>drift</title><style>html,body{margin:0;height:100%;background:transparent}'
  + '#k{position:fixed;inset:0;display:flex;align-items:center;justify-content:center;color:#ffe9a8;font:700 14vw monospace;animation:d 3s ease-in-out infinite alternate}'
  + '@keyframes d{from{letter-spacing:0}to{letter-spacing:2vw}}</style></head><body><div id="k">DRIFT</div>'
  + '<script>(function(){var k=document.getElementById("k");function f(){var b=(window.sinterSignal&&window.sinterSignal.beat)||0;'
  + 'k.style.opacity=String(0.1+0.9*b);k.style.transform="scale("+(1+0.5*b)+")";document.body.style.background="rgba(255,233,168,"+(0.9*b)+")";requestAnimationFrame(f)}f()})()</script></body></html>';
const P5 = 'function setup(){createCanvas(windowWidth,windowHeight);noStroke();}'
  + 'function draw(){background(30,60,120);fill(255,200,80);for(let i=0;i<30;i++){circle((i*97+frameCount*3)%width,(i*53)%height,60);}}';
const MASK_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect width="100" height="100" fill="#000"/>'
  + '<circle cx="50" cy="50" r="30" fill="#fff"/></svg>';
const PALETTE = { background: '#0b1020', colors: ['#7fd6ff', '#ffe9a8', '#ff7a90'] };
const planJson = (layers: unknown[], extra: Record<string, unknown> = {}) => JSON.stringify({
  title: 'CLI hybrid', reason: 'the idea wants depth and a pulse, so a field and a word', palette: PALETTE, bpm: 100, signals: [], layers, ...extra });
const L = (domain: string, role: string, extra: Record<string, unknown> = {}) => (
  { domain, role, prompt: `${domain} ${role}`, why: `${domain} serves the ${role}`, blendMode: 'normal', opacity: 1, ...extra });

const isPlanner = (c: FakeCall) => c.system.includes('deciding what a piece is made of');
function layerReply(c: FakeCall): string {
  const hay = `${c.system}\n${c.user}`;
  if (/kinetic/i.test(c.system) || /CSS kinetic|kinetic typography/i.test(c.user)) return KINETIC;
  if (/<task domain="shader"|runnable shader code/i.test(hay)) return GLSL;
  if (c.user.includes('<task domain="svg">')) return MASK_SVG;
  return P5;
}

let fake: FakeProvider;
let plan = planJson([L('glsl', 'background'), L('kinetic', 'overlay', { blendMode: 'screen' })],
  { signals: [{ kind: 'beat', from: 'clock', to: 1, param: 'scale', depth: 0.5 }] });
beforeAll(async () => {
  expect(existsSync(path.resolve('dist/composition/hybrid/HybridPlan.js')), 'run pnpm build first').toBe(true);
  fake = await startFakeProvider({ generate: (c) => (isPlanner(c) ? plan : layerReply(c)) });
});
afterAll(async () => { await fake.close(); });

function env() {
  const iso = isolatedCliEnv();
  const stateRoot = mkdtempSync(path.join(tmpdir(), 'hybrid-state-'));
  return { ...fakeProviderEnv(fake, { home: iso.home, stateRoot }), SINTER_CONFIG_PATH: iso.env.SINTER_CONFIG_PATH,
    // the headless judge launches Chromium; this host (like CI containers) has no unprivileged user namespaces
    LIMINAL_DISABLE_SANDBOX: 'true' };
}

describe('sinter compose, layered (spawned CLI, fake provider; SINTER_LAYERED, --layers, old --hybrid and SINTER_HYBRID_LAYERS spellings)', () => {
  it('plans, composes, renders and judges; writes the manifest, project and medium.json', async () => {
    const out = mkdtempSync(path.join(tmpdir(), 'hybrid-out-'));
    const run = await runSinterAsync(['compose', '--prompt', 'a field and one drifting word', '-o', out], { ...env(), SINTER_LAYERED: '1' });
    expect(run.status, run.out).toBe(0);
    const manifest = JSON.parse(readFileSync(path.join(out, 'composition.hybrid.json'), 'utf8'));
    expect(manifest.chosenBy).toBe('planner');
    expect(manifest.medium_line).toContain('layered piece of glsl background + kinetic overlay');
    expect(manifest.judge.verdict).toBe('pass');
    expect(manifest.judge.coherence.criterion).toBe('seam/coherence between layers');
    expect(manifest.composition.control.recipeId).toBe('layered-beat');
    expect(typeof manifest.judge.control[0].target).toBe('number');
    expect(manifest.made_with).toBe(manifest.medium_line);
    expect(manifest.kind).toBe('layered');
    // The layers came from LayerSequencer.generateLayers, one prompt each; a build that bypasses it has no such record.
    expect(manifest.composition.generation).toMatchObject({ via: 'LayerSequencer.generateLayers', order: [0, 1], perLayerPrompts: 2 });
    expect(manifest.composition.beatAnimations).toHaveLength(1);
    expect(JSON.parse(readFileSync(path.join(out, 'medium.json'), 'utf8')).medium_line).toBe(manifest.medium_line);
    const project = JSON.parse(readFileSync(path.join(out, 'composition.project.json'), 'utf8'));
    expect(project.composition.layers).toHaveLength(2);
    expect(project.animations).toHaveLength(1);
    expect(readFileSync(path.join(out, 'composition.html'), 'utf8')).toContain('@keyframes sinter-');
    expect(existsSync(path.join(out, 'hybrid-late.png'))).toBe(true);
    expect(run.out).toContain(manifest.medium_line);
  }, 300_000);

  it('--layers fixes the domains and the planner fills in the rest (visual + mask)', async () => {
    plan = planJson([L('p5', 'background'), L('svg', 'mask', { maskTarget: 0 })], { bpm: null });
    const out = mkdtempSync(path.join(tmpdir(), 'hybrid-out-'));
    const run = await runSinterAsync(['compose', '--layers', 'p5:background,svg:mask', '--prompt', 'a window onto a field', '-o', out], env());
    expect(run.status, run.out).toBe(0);
    const manifest = JSON.parse(readFileSync(path.join(out, 'composition.hybrid.json'), 'utf8'));
    expect(manifest.chosenBy).toBe('operator-layers');
    expect(manifest.composition.masks).toEqual([{ source: 1, target: 0 }]);
    expect(manifest.composition.generation).toMatchObject({ via: 'LayerSequencer.generateLayers', order: [0, 1], perLayerPrompts: 2 });
    expect(readFileSync(path.join(out, 'composition.html'), 'utf8')).toContain('mask-image: var(--mask-source);');
  }, 300_000);

  it('rejects a planner substitution of the requested layer role', async () => {
    plan = planJson([L('p5', 'background'), L('svg', 'overlay')]);
    const out = mkdtempSync(path.join(tmpdir(), 'hybrid-out-'));
    const run = await runSinterAsync(['compose', '--hybrid', '--layers', 'p5:background,svg:mask', '--prompt', 'x', '-o', out], env());
    expect(run.status).not.toBe(0);
    expect(run.out).toContain("the planner changed the operator's layer list");
    expect(existsSync(path.join(out, 'composition.html'))).toBe(false);
  }, 300_000);
});

describe('layered generation runs through LayerSequencer.generateLayers (spawned CLI)', () => {
  it('a failing first layer stops the sequence: named in the error, later layers never asked for', async () => {
    const saved = plan;
    plan = planJson([L('glsl', 'background'), L('kinetic', 'overlay', { blendMode: 'screen' }), L('p5', 'overlay', { blendMode: 'screen' })]);
    const broken = await startFakeProvider({
      generate: (c) => (isPlanner(c) ? plan : /<task domain="shader"|runnable shader code/i.test(`${c.system}\n${c.user}`) ? '' : layerReply(c)),
    });
    try {
      const out = mkdtempSync(path.join(tmpdir(), 'hybrid-out-'));
      const iso = isolatedCliEnv();
      const stateRoot = mkdtempSync(path.join(tmpdir(), 'hybrid-state-'));
      const run = await runSinterAsync(['compose', '--layers', 'glsl:background,kinetic:overlay,p5:overlay', '--prompt', 'ember field', '-o', out],
        { ...fakeProviderEnv(broken, { home: iso.home, stateRoot }), SINTER_CONFIG_PATH: iso.env.SINTER_CONFIG_PATH, LIMINAL_DISABLE_SANDBOX: 'true' });
      expect(run.status).not.toBe(0);
      expect(run.out).toMatch(/hybrid layer 0 \(glsl, background\) failed/);
      expect(existsSync(path.join(out, 'composition.html'))).toBe(false);
      const asked = broken.generated.filter((c) => !isPlanner(c)).map((c) => `${c.system}\n${c.user}`);
      expect(asked.length).toBeGreaterThan(0);
      // Sequenced: nothing after the failed layer was asked for. The old concurrent compose() asked for all three.
      expect(asked.some((h) => /<task domain="shader"|runnable shader code/i.test(h))).toBe(true);
      expect(asked.some((h) => /<task domain="(kinetic|p5)"|CSS kinetic|kinetic typography/i.test(h))).toBe(false);
    } finally { await broken.close(); plan = saved; }
  }, 300_000);
});

describe('sinter generate with no medium named', () => {
  it.each([
    ['--ref', 'missing.png'],
    ['--concept-graph', 'missing.json'],
    ['--seed', 'missing-seed'],
    ['--memo', 'missing.json'],
    ['--voice-file', 'missing.wav'],
    ['--output-mode', 'fragment'],
    ['--output-mode', 'standalone'],
    ['--arc'],
    ['--teach', 'visual'],
    ['--retry-unknown'],
  ])('rejects %s before an automatic compose dispatch can drop it', async (flag, value) => {
    const out = mkdtempSync(path.join(tmpdir(), 'hybrid-refusal-'));
    const unexpectedProvider = await startFakeProvider({ generate: () => '' });
    try {
      const args = ['generate', '--hybrid', '-o', out, 'ember', flag, ...(value ? [value] : [])];
      const run = await runSinterAsync(args, {
        ...fakeProviderEnv(unexpectedProvider, { home: path.join(out, 'home'), stateRoot: path.join(out, 'state') }),
        SINTER_CONFIG_PATH: path.join(out, 'no-default-seat.json'),
      });
      expect(unexpectedProvider.calls, run.out).toHaveLength(0);
      expect(run.status, run.out).toBe(1);
      expect(run.stderr).toContain(flag === '--ref' ? 'missing.png' : flag);
      expect(existsSync(path.join(out, 'composition.html'))).toBe(false);
    } finally {
      await unexpectedProvider.close();
      rmSync(out, { recursive: true, force: true });
    }
  }, 60_000);

  it('gives the planner the graph and references and records the medium and provenance', async () => {
    const out = mkdtempSync(path.join(tmpdir(), 'hybrid-gen-'));
    const graph = path.join(out, 'graph.json');
    const reference = path.join(out, 'reference.svg');
    writeFileSync(graph, JSON.stringify({ nodes: [{ id: 'harbour', label: 'harbour at dusk', type: 'component' }], edges: [] }));
    writeFileSync(reference, MASK_SVG);
    const before = fake.generated.length;
    const run = await runSinterAsync(['generate', '-o', out, '--concept-graph', graph, '--ref', reference, 'ember'],
      { ...env(), SINTER_HYBRID_LAYERS: '1' });
    expect(run.status, run.out).toBe(0);
    const planner = fake.generated.slice(before).find(isPlanner);
    expect(planner?.user).toContain('harbour at dusk');
    expect(planner?.user).toContain('reference.svg (diagram)');
    const provenance = JSON.parse(readFileSync(path.join(out, 'reverse-provenance.json'), 'utf8'));
    expect(provenance.references).toMatchObject([{ file: 'reference.svg', kind: 'diagram', sha256: expect.stringMatching(/^[a-f0-9]{64}$/) }]);
    const files = ['medium.json', 'composition.hybrid.json'].map((f) => path.join(out, f));
    const any = files.find((f) => existsSync(f));
    expect(typeof any, run.out).toBe("string");
    const rec = JSON.parse(readFileSync(any!, 'utf8'));
    expect(rec.made_with).toBe(rec.medium_line);
    const line = rec.made_with as string;
    expect(line).toMatch(/^S1NTR built a /);
    expect(line).not.toMatch(/^S1NTR built a (custom|meta)\b/);
  }, 300_000);
});
