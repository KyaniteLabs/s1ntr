/**
 * Spawned-CLI proof: `sinter compose --loops 3` on a layered piece, against the fake provider.
 * Loop 1 ships a kinetic overlay that ignores the beat it is wired to (the render check fails it); loop 2 must carry loop 1's
 * plan, both layers' code, the stills and the critique with the per-layer beat verdict, KEEP the working glsl layer byte-for-byte
 * (no provider call) and EDIT the kinetic one; loop 3 (nothing wrong) edits every layer.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fakeProviderEnv, goodJudgeReply, runSinterAsync, startFakeProvider, type FakeCall, type FakeProvider } from '../helpers/fakeProviderServer.js';
import { isolatedCliEnv } from '../helpers/isolatedCli.js';

const GLSL = 'precision mediump float;uniform float u_time;uniform vec2 u_resolution;'
  + 'float hash(vec2 p){return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453);}'
  + 'float noise(vec2 p){vec2 i=floor(p),f=fract(p);f=f*f*(3.0-2.0*f);return mix(mix(hash(i),hash(i+vec2(1,0)),f.x),mix(hash(i+vec2(0,1)),hash(i+vec2(1,1)),f.x),f.y);}'
  + 'void main(){vec2 uv=gl_FragCoord.xy/u_resolution;float n=noise(uv*6.0+u_time*0.3);'
  + 'vec3 a=vec3(0.1,0.3,0.6),b=vec3(0.9,0.5,0.3),c=vec3(0.2,0.8,0.7);gl_FragColor=vec4(mix(mix(a,b,n),c,uv.y),1.0);}';
const GLSL_BOLD = GLSL.replace('void main(){','void main(){\n') + '\n' + Array.from({ length: 60 }, (_, i) => `// bold new idea ${i}`).join('\n');
const KINETIC_HEAD = '<!DOCTYPE html><html><head><meta charset="utf-8"><title>drift</title><style>html,body{margin:0;height:100%;background:transparent}'
  + '#k{position:fixed;inset:0;display:flex;align-items:center;justify-content:center;color:#ffe9a8;font:700 14vw monospace}</style></head><body><div id="k">DRIFT</div>';
const KINETIC_STATIC = KINETIC_HEAD.replace('</style>', '#k{animation:d 30s ease-in-out infinite alternate}@keyframes d{from{letter-spacing:0}to{letter-spacing:2vw}}</style>')
  + '<script>/* STATIC-LOOP-ONE */document.getElementById("k").style.opacity="0.8"</script></body></html>';
const KINETIC_BEAT = KINETIC_HEAD + '<script>(function(){var k=document.getElementById("k");function f(){var b=(window.sinterSignal&&window.sinterSignal.beat)||0;'
  + 'k.style.opacity=String(0.1+0.9*b);k.style.transform="scale("+(1+0.5*b)+")";document.body.style.background="rgba(255,233,168,"+(0.9*b)+")";requestAnimationFrame(f)}f()})()</script></body></html>';
const PLAN = JSON.stringify({ title: 'Loop piece', reason: 'a field and a pulsing word', palette: { background: '#0b1020', colors: ['#7fd6ff', '#ffe9a8', '#ff7a90'] }, bpm: 100,
  signals: [{ kind: 'beat', from: 'clock', to: 1, param: 'scale', depth: 0.5 }],
  layers: [{ domain: 'glsl', role: 'background', prompt: 'glsl background', why: 'a field', blendMode: 'normal', opacity: 1 },
    { domain: 'kinetic', role: 'overlay', prompt: 'kinetic overlay', why: 'the word', blendMode: 'screen', opacity: 1 }] });

const isPlanner = (c: FakeCall) => c.system.includes('deciding what a piece is made of');
const isGlsl = (c: FakeCall) => /<task domain="shader"|runnable shader code/i.test(`${c.system}\n${c.user}`);
const isKinetic = (c: FakeCall) => /kinetic/i.test(c.system) || /CSS kinetic|kinetic typography/i.test(c.user);
const ARC_IMAGE = path.resolve('test/fixtures/reverse/storyboard.png');
const isArcReader = (call: FakeCall) => call.system.includes('You read a storyboard');

let fake: FakeProvider;
let firstPlannerCheckpoint = '';
let firstPlannerSawCheckpoint = false;
beforeAll(async () => {
  expect(existsSync(path.resolve('dist/composition/hybrid/HybridPlan.js')), 'run pnpm build first').toBe(true);
  let kineticCalls = 0;
  fake = await startFakeProvider({ judge: call => isArcReader(call)
    ? { sections: [{ t_start: 0, t_end: 12, energy: 0.8, label: 'pulse' }], cues: [] }
    : goodJudgeReply(), generate: (c) => {
    if (isPlanner(c)) {
      if (c.index === 0) firstPlannerSawCheckpoint = existsSync(firstPlannerCheckpoint);
      return PLAN;
    }
    if (isKinetic(c)) {
      kineticCalls++;
      // The initial attempt of loop 1 and the bloat retry of loop 3 fail the beat gate.
      return kineticCalls === 1 || kineticCalls === 4 ? KINETIC_STATIC : KINETIC_BEAT;
    }
    return c.user.includes('IMPROVEMENT LOOP') ? GLSL_BOLD : GLSL;
  } });
});
afterAll(async () => { await fake.close(); });

describe('sinter compose --loops 3 (spawned CLI, fake provider)', () => {
  it('carries plan + layer code + critique + beat verdict; keeps working layers, edits broken ones; saves every loop', async () => {
    const iso = isolatedCliEnv();
    const env = { ...fakeProviderEnv(fake, { home: iso.home, stateRoot: mkdtempSync(path.join(tmpdir(), 'cl-state-')) }),
      SINTER_CONFIG_PATH: iso.env.SINTER_CONFIG_PATH, LIMINAL_DISABLE_SANDBOX: 'true', SINTER_LAYERED: '1' };
    const out = mkdtempSync(path.join(tmpdir(), 'cl-out-'));
    const gallery = path.join(out, 'requested-gallery');
    const reference = path.join(out, 'notes.md');
    const cues = path.join(out, 'cues.json');
    writeFileSync(reference, '# Grey field\n\nA short pulse interrupted by silence.\n');
    writeFileSync(cues, '[{"t":6,"kind":"drop"}]');
    firstPlannerCheckpoint = path.join(out, 'loops-manifest.json');
    for (const folder of ['layers', 'loops/r2/layers', 'loops/r3/layers']) {
      const dir = path.join(out, folder);
      mkdirSync(dir, { recursive: true });
      writeFileSync(path.join(dir, 'unrelated.html'), folder);
    }
    const args = ['compose', '--prompt', 'a field and one pulsing word', '--loops', '3', '-o', out,
      '--gallery', gallery, '--export-layer', '1', '--ref', reference, '--arc', ARC_IMAGE,
      '--duration', '12', '--cues', cues];
    const run = await runSinterAsync(args, env, undefined, 600_000);
    expect(run.status, run.out).toBe(0);
    expect(run.out).toContain('Loops: r1=FAILED');
    expect(firstPlannerSawCheckpoint).toBe(true);
    expect(fake.judged.filter(isArcReader)).toHaveLength(1);
    expect(readFileSync(path.join(out, 'layers', 'unrelated.html'), 'utf8')).toBe('layers');

    const manifest = JSON.parse(readFileSync(path.join(out, 'loops-manifest.json'), 'utf8'));
    expect(manifest.loops).toBe(3);
    expect(manifest.records.map((r: { loop: number }) => r.loop)).toEqual([1, 2, 3]);
    expect(manifest.records[0]).toMatchObject({ score: null, status: 'failed', best: false });
    expect(manifest.records[2]).toMatchObject({ bloatRetried: true, status: 'ok',
      winningAttempt: { kind: 'initial' } });
    expect(manifest.providerCallsConsumed).toBe(fake.generated.length);
    expect(manifest.providerCallsConsumed).toBeLessThanOrEqual(manifest.providerCallBudget);
    if (typeof manifest.records[1].score !== 'number') throw new Error(JSON.stringify(manifest.records) + run.out.slice(-1800));
    expect(manifest.records[1].score).toBeGreaterThan(0);
    expect(manifest.records[2].score).toBeGreaterThan(0);
    expect(manifest.records.map((r: { carriedFromLoop: number | null }) => r.carriedFromLoop)).toEqual([null, 1, 2]);
    expect(manifest.records.filter((r: { best: boolean }) => r.best)).toHaveLength(1);
    expect(manifest.bestLoop === 2 || manifest.bestLoop === 3).toBe(true);
    for (const k of [1, 2, 3]) expect(existsSync(path.join(out, 'loops', `r${k}`, 'composition.html')), `loop ${k} saved`).toBe(true);
    expect(manifest.records[1].promptCarriesPriorCode).toBe(true);

    const calls = fake.generated;
    const planners = calls.filter(isPlanner);
    const glsl = calls.filter((c) => !isPlanner(c) && isGlsl(c) && !isKinetic(c));
    const kinetic = calls.filter((c) => !isPlanner(c) && isKinetic(c));
    expect(planners).toHaveLength(4);
    expect(kinetic).toHaveLength(4);
    // Loop 2 kept GLSL byte-for-byte. Loop 3 edited it and retried the oversized change.
    expect(glsl).toHaveLength(3);
    expect(glsl[1]!.user).toContain('IMPROVEMENT LOOP');
    // the loop-2 planner saw the plan, the layer code and the per-layer beat verdict
    expect(planners[1]!.user).toContain('LAYERED PIECE "Loop piece"');
    expect(planners[1]!.user).toContain('STATIC-LOOP-ONE');
    expect(planners[1]!.user).toContain('beat response: NOT responsive');
    expect(planners[1]!.user).toContain('5+6 frame pairs');
    expect(planners[0]!.user).toContain('notes.md (text)');
    // the loop-2 kinetic layer is an EDIT of loop 1's code with the verdict
    expect(kinetic[1]!.user).toContain('IMPROVEMENT LOOP');
    expect(kinetic[1]!.user).toContain('STATIC-LOOP-ONE');
    expect(kinetic[1]!.user).toContain('wired to the beat');
    expect(kinetic[0]!.user).not.toContain('IMPROVEMENT LOOP');
    // the kept layer is identical across loops 1 and 2
    const l1 = JSON.parse(readFileSync(path.join(out, 'loops', 'r1', 'compose-loop.json'), 'utf8'));
    const l2 = JSON.parse(readFileSync(path.join(out, 'loops', 'r2', 'compose-loop.json'), 'utf8'));
    expect(l2.layers[0].code).toBe(l1.layers[0].code);
    expect(l2.layers[1].code).not.toBe(l1.layers[1].code);
    expect(existsSync(path.join(out, 'composition.html'))).toBe(true);

    // resume: a rerun into the same -o reuses every finished loop (no provider traffic) and STILL returns the best piece at -o
    const before = fake.generated.length;
    const bestBytes = readFileSync(path.join(out, 'composition.html'), 'utf8');
    const galleryProjects = readdirSync(gallery);
    expect(galleryProjects).toEqual([expect.stringMatching(/--loop-piece$/)]);
    const project = path.join(gallery, galleryProjects[0]);
    expect(JSON.parse(readFileSync(path.join(project, 'v1.js'), 'utf8'))).toMatchObject({
      type: 'composition', title: 'Loop piece', code: bestBytes.trim(),
    });
    const png = path.join(out, 'layer-1.png');
    const provenance = path.join(out, 'reverse-provenance.json');
    const pngHeader = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
    expect(readFileSync(png).subarray(0, 8)).toEqual(pngHeader);
    const provenanceBytes = readFileSync(provenance, 'utf8');
    expect(JSON.parse(provenanceBytes)).toMatchObject({
      references: [{ file: 'notes.md', kind: 'text', sha256: expect.stringMatching(/^[a-f0-9]{64}$/) }],
      arcImageSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      arcSource: 'vision:storyboard.png', durationSec: 12, arc: { cues: [{ t: 6, kind: 'drop' }] },
    });
    for (const file of [path.join(out, 'composition.html'), png, provenance]) rmSync(file);
    const again = await runSinterAsync(args, env, undefined, 600_000);
    expect(again.status, again.out).toBe(0);
    const m2 = JSON.parse(readFileSync(path.join(out, 'loops-manifest.json'), 'utf8'));
    expect(m2.records.map((r: { status: string }) => r.status)).toEqual(['failed', 'resumed', 'resumed']);
    expect(fake.generated.length).toBe(before);
    expect(readFileSync(path.join(out, 'composition.html'), 'utf8')).toBe(bestBytes);
    expect(readFileSync(png).subarray(0, 8)).toEqual(pngHeader);
    expect(readFileSync(provenance, 'utf8')).toBe(provenanceBytes);
    expect(readdirSync(project)).toEqual(['v1.js']);
    expect(fake.judged.filter(isArcReader)).toHaveLength(1);

    // Simulate losing the manifest update after provider requests were already
    // journaled. The persisted failed-layer feedback must recreate the same request.
    const checkpoint = path.join(out, 'loops-manifest.json');
    const judgesBefore = fake.judged.length;
    writeFileSync(checkpoint, JSON.stringify({ ...manifest, records: manifest.records.slice(0, 1) }));
    const recovered = await runSinterAsync(args, env, undefined, 600_000);
    expect(recovered.status, recovered.out).toBe(0);
    expect(fake.generated.length).toBe(before);
    expect(fake.judged).toHaveLength(judgesBefore);
    expect(readFileSync(path.join(out, 'composition.html'), 'utf8')).toBe(bestBytes);

    const savedLoop = path.join(out, 'loops', 'r2', 'compose-loop.json');
    const originalLoop = readFileSync(savedLoop);
    writeFileSync(checkpoint, JSON.stringify({ ...manifest, records: manifest.records.slice(0, 1) }));
    try {
      const saved = JSON.parse(originalLoop.toString('utf8'));
      expect(saved.providerCalls).toBeGreaterThan(0);
      writeFileSync(savedLoop, JSON.stringify({ ...saved, providerCalls: 0 }));
      const wrongBudget = await runSinterAsync(args, env, undefined, 600_000);
      expect(wrongBudget.status, wrongBudget.out).toBe(1);
      expect(wrongBudget.out).toContain('COMPOSE_LOOP_PROVIDER_ACCOUNTING_MISMATCH');
      expect(fake.generated.length).toBe(before);
      expect(fake.judged).toHaveLength(judgesBefore);
    } finally {
      writeFileSync(savedLoop, originalLoop);
    }

    const journal = path.join(out, 'loops', 'r2', 'operation-journal.json');
    renameSync(journal, `${journal}.backup`);
    try {
      writeFileSync(checkpoint, JSON.stringify({ ...manifest, records: manifest.records.slice(0, 1) }));
      const missingJournal = await runSinterAsync(args, env, undefined, 600_000);
      expect(missingJournal.status, missingJournal.out).toBe(1);
      expect(missingJournal.out).toContain('LOOP_RECOVERY_INTEGRITY');
      expect(fake.generated.length).toBe(before);
      expect(fake.judged).toHaveLength(judgesBefore);
    } finally {
      rmSync(journal, { force: true });
      renameSync(`${journal}.backup`, journal);
      writeFileSync(checkpoint, JSON.stringify(m2));
    }

    const changedDuration = [...args];
    changedDuration[changedDuration.indexOf('--duration') + 1] = '13';
    const changedArc = await runSinterAsync(changedDuration, env);
    expect(changedArc.status, changedArc.out).toBe(1);
    expect(changedArc.out).toContain('LOOPS_RESUME_IMAGE_ARC_MISMATCH');
    expect(fake.generated.length).toBe(before);
    expect(fake.judged.filter(isArcReader)).toHaveLength(1);

    const mismatched = await runSinterAsync(args,
      { ...env, SINTER_LAYERED: '0', SINTER_HYBRID_LAYERS: '0' });
    expect(mismatched.status, mismatched.out).toBe(1);
    expect(mismatched.out).toContain('LOOPS_RESUME_REQUEST_MISMATCH');
    expect(fake.generated.length).toBe(before);

    const referenceText = readFileSync(reference, 'utf8');
    writeFileSync(reference, referenceText.replace('short', 'sharp'));
    const changedReference = await runSinterAsync(args, env);
    expect(changedReference.status, changedReference.out).toBe(1);
    expect(changedReference.out).toContain('LOOPS_RESUME_REQUEST_MISMATCH');
    expect(fake.generated.length).toBe(before);
    writeFileSync(reference, referenceText);

    const cuesText = readFileSync(cues, 'utf8');
    rmSync(cues);
    const missingCues = await runSinterAsync(args, env);
    expect(missingCues.status, missingCues.out).toBe(1);
    expect(missingCues.out).toContain('REVERSE_CUES_UNREADABLE');
    expect(fake.generated.length).toBe(before);
    expect(fake.judged.filter(isArcReader)).toHaveLength(1);
    writeFileSync(cues, cuesText);

    const winner = manifest.records.find((record: { best: boolean }) => record.best);
    writeFileSync(path.join(winner.artifactDirectory, 'composition.html'), '<html>replaced</html>');
    rmSync(path.join(out, 'composition.html'));
    const replaced = await runSinterAsync(args, env);
    expect(replaced.status, replaced.out).toBe(1);
    expect(replaced.out).toContain('LOOPS_RESUME_ARTIFACT_MISMATCH');
    expect(existsSync(path.join(out, 'composition.html'))).toBe(false);
    expect(fake.generated.length).toBe(before);
  }, 900_000);

  it('forwards operator caps from an ambiguous Generate prompt and direct Compose', async () => {
    const iso = isolatedCliEnv();
    const env = { ...fakeProviderEnv(fake, { home: iso.home, stateRoot: mkdtempSync(path.join(tmpdir(), 'cl-state-')) }),
      SINTER_CONFIG_PATH: iso.env.SINTER_CONFIG_PATH };
    const out = mkdtempSync(path.join(tmpdir(), 'cl-limited-'));
    const before = fake.generated.length;
    const run = await runSinterAsync(['generate', '--hybrid', '--prompt', 'assemble some drift',
      '--loops', '2', '--attempt', 'limited-check', '--max-provider-calls', '1', '-o', out], env);
    expect(run.status, run.out).toBe(1);
    expect(run.out).toContain('handing the choice of medium');
    const manifest = JSON.parse(readFileSync(path.join(out, 'loops-manifest.json'), 'utf8'));
    expect(manifest).toMatchObject({ providerCallBudget: 2, bestLoop: null,
      records: [{ status: 'failed', providerCallsMaximum: 1 }, { status: 'failed', providerCallsMaximum: 1 }] });
    expect(JSON.parse(manifest.resumeKey)).toEqual({ hybrid: true, layers: [], attemptId: 'limited-check' });
    expect(fake.generated.length - before).toBe(2);

    const direct = await runSinterAsync(['compose', '--hybrid', '--prompt', 'assemble some drift',
      '--max-provider-calls', '1', '-o', mkdtempSync(path.join(tmpdir(), 'cl-direct-'))], env);
    expect(fake.generated.length - before).toBe(3);
    expect(direct.out).not.toContain('✅ Saved:');
  }, 120_000);

  it('keeps failed default composition measurements out of the winner bundle', async () => {
    const dark = await startFakeProvider({ generate: (call) =>
      call.system.includes('You are a composition planner for a creative-coding studio')
        ? JSON.stringify({ title: 'Dark field', background: '#000000',
          layers: [{ domain: 'shader', prompt: 'solid black field', blendMode: 'normal', opacity: 1 }] })
        : GLSL.replace('mix(mix(a,b,n),c,uv.y),1.0', 'mix(mix(a,b,n),c,uv.y)*0.025,1.0'),
    });
    const iso = isolatedCliEnv();
    const out = mkdtempSync(path.join(tmpdir(), 'cl-dark-'));
    try {
      const env = { ...fakeProviderEnv(dark, { home: iso.home, stateRoot: path.join(out, 'state') }),
        SINTER_CONFIG_PATH: iso.env.SINTER_CONFIG_PATH, LIMINAL_DISABLE_SANDBOX: 'true',
        SINTER_LAYERED: '0', SINTER_HYBRID_LAYERS: '0' };
      const run = await runSinterAsync(['compose', '--prompt', 'a dark field', '--loops', '2', '-o', out], env);
      expect(run.status, run.out).toBe(1);
      const manifest = JSON.parse(readFileSync(path.join(out, 'loops-manifest.json'), 'utf8'));
      expect(manifest, run.out).toMatchObject({ bestLoop: null, records: [
        { status: 'failed', error: 'Composite render gate: too-dark' },
        { status: 'failed', error: 'Composite render gate: too-dark' },
      ] });
      expect(existsSync(path.join(out, 'composition.html'))).toBe(false);
    } finally {
      await dark.close();
      rmSync(out, { recursive: true, force: true });
    }
  }, 300_000);

  it.each([
    { extra: ['--retry-unknown'], message: 'LOOPS_RESUME_IMAGE_ARC' },
    { extra: ['--max-provider-calls', '0'], message: 'a cap of 0 cannot run a generation' },
    { extra: ['--max-provider-calls', '1'], message: 'Pass a JSON or SVG arc' },
    { extra: ['--layers', 'not-a-medium:background'], message: '--layers' },
    { extra: ['--layers', 'glsl:mask,kinetic:overlay'], message: 'a mask layer must be svg' },
    { extra: ['--layers', 'tone:background'], message: 'tone and strudel layers play the sound role' },
    { extra: ['--layers', 'svg:mask'], message: 'a mask layer needs another layer to mask' },
    { extra: ['--loops'], message: '--loops needs an integer' },
  ])('rejects $extra before reading an image arc', async ({ extra, message }) => {
    const out = mkdtempSync(path.join(tmpdir(), 'cl-refusal-'));
    const unexpectedProvider = await startFakeProvider({ generate: () => '' });
    try {
      const env = { ...fakeProviderEnv(unexpectedProvider, { home: path.join(out, 'home'), stateRoot: path.join(out, 'state') }),
        SINTER_CONFIG_PATH: path.join(out, 'no-default-seat.json') };
      const args = ['compose', '--prompt', 'an ember', '--loops', '2', '-o', out, '--arc', ARC_IMAGE,
        '--duration', '12', ...extra];
      const run = await runSinterAsync(args, env);
      expect(unexpectedProvider.calls, run.out).toHaveLength(0);
      expect(run.status, run.out).toBe(1);
      expect(run.stderr).toContain(message);
      expect(existsSync(path.join(out, 'loops-manifest.json'))).toBe(false);
    } finally {
      await unexpectedProvider.close();
      rmSync(out, { recursive: true, force: true });
    }
  }, 60_000);

  it('refuses --loops with a frozen --spec (no idea to improve), loudly', async () => {
    const iso = isolatedCliEnv();
    const env = { ...fakeProviderEnv(fake, { home: iso.home, stateRoot: mkdtempSync(path.join(tmpdir(), 'cl-state-')) }), SINTER_CONFIG_PATH: iso.env.SINTER_CONFIG_PATH };
    const run = await runSinterAsync(['compose', '--spec', '/nonexistent.json', '--loops', '3', '-o', mkdtempSync(path.join(tmpdir(), 'cl-out-'))], env);
    expect(run.status).toBe(1);
    expect(run.out).toContain('revises a layered piece made from an idea');
  }, 120_000);
});
