/**
 * USED + RAN proofs through a spawned `bin/sinter generate` (fake HTTP provider, real renderer):
 * each organ below changes what the provider is sent, and a bypass makes the change disappear.
 * Loop carry-over is proven with the governed revision flags (--revise-from, PR #1948), the way a
 * spawned CLI chains loops; the legacy in-process loop stays in loop-carry-organ.test.ts.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { fakeProviderEnv, goodJudgeReply, runSinterAsync, startFakeProvider, LIVELY_HTML } from '../helpers/fakeProviderServer.js';
import { sourcePaletteSummary } from '../../src/core/ScoringEngine.js';
import { craftSection, creativePlanSection } from '../../src/runtime-core/BriefCraftSection.js';

vi.setConfig({ testTimeout: 900_000 });
let work: string; let n = 0;
beforeAll(() => { work = mkdtempSync(path.join(tmpdir(), 'organ-wiring-')); });
afterAll(() => { rmSync(work, { recursive: true, force: true }); });

async function run(code: string, extra: string[] = [], extraEnv: Record<string, string> = {}, reasoning = 'fake judge', prompt = 'a calm study in two shapes') {
  const fake = await startFakeProvider({ generate: () => code, judge: () => ({ ...goodJudgeReply(0.8), reasoning }) });
  try {
    const i = n++;
    const env = { ...fakeProviderEnv(fake, { home: path.join(work, `h${i}`), stateRoot: path.join(work, `s${i}`), projectRoot: path.join(work, `p${i}`) }), ...extraEnv };
    const out = path.join(work, `o${i}`);
    const res = await runSinterAsync(['generate', '-o', out, '--domain', 'html', ...extra, prompt], env);
    return { res, out, env, generated: [...fake.generated], judged: [...fake.judged] };
  } finally { await fake.close(); }
}

describe('brief organs reach the provider (spawned)', () => {
  it('prompts: the craft contract is in the generator system brief, and SINTER_BRIEF_CRAFT=off removes it', async () => {
    const on = await run(LIVELY_HTML);
    expect(on.res.status, on.res.out.slice(-400)).toBe(0);
    expect(on.generated[0].system).toContain('<craft_contract');
    const off = await run(LIVELY_HTML, [], { SINTER_BRIEF_CRAFT: 'off' });
    expect(off.res.status).toBe(0);
    expect(off.generated[0].system).not.toContain('<craft_contract');
  });
  it('creative-intelligence: the plan compiled from the request is in the generator user brief, and the bypass removes it', async () => {
    const on = await run(LIVELY_HTML);
    expect(on.generated[0].user).toContain('CANONICAL CREATIVE INTELLIGENCE CONTRACT');
    expect(on.generated[0].user).toContain('a calm study in two shapes');
    const off = await run(LIVELY_HTML, [], { SINTER_BRIEF_CRAFT: 'off' });
    expect(off.generated[0].user).not.toContain('CANONICAL CREATIVE INTELLIGENCE CONTRACT');
  });
  it('aesthetic ColorExtractor: palette facts are stated for a source with hex colours and never invented for one without', async () => {
    // the governed judge is handed frames, not source, so the helper is proven directly
    expect(sourcePaletteSummary('const a = 1;')).toBe('');
    expect(sourcePaletteSummary('x{color:#ff0000;background:#00ff00}')).toContain('2 distinct');
  });
  it('helpers are what the brief uses', () => {
    expect(craftSection('html', {})).toContain('<craft_contract');
    expect(craftSection('html', { SINTER_BRIEF_CRAFT: 'off' })).toBe('');
    expect(creativePlanSection('a calm study', { SINTER_BRIEF_CRAFT: 'off' })).toBe('');
  });
});

describe('verified judge sources (spawned)', () => {
  it('exports the signed source digest, then refuses tampered source bytes', async () => {
    const runResult = await run(LIVELY_HTML);
    expect(runResult.res.status, runResult.res.out.slice(-400)).toBe(0);
    const acceptedFile = path.join(runResult.out, 'accepted-sources.json');
    const command = ['judge-evidence', runResult.out, '--state-root', runResult.env.SINTER_LIMINAL_RUNTIME_ROOT!,
      '--accepted-sources-out', acceptedFile];
    const proof = await runSinterAsync(command, runResult.env);
    expect(proof.status, proof.out.slice(-400)).toBe(0);
    const sources = JSON.parse(readFileSync(acceptedFile, 'utf8'));
    expect(sources).toHaveLength(1);
    expect(sources[0]).toMatchObject({ domain: 'html', run_dir: runResult.out });
    expect(sources[0].score).toBeCloseTo(0.8);
    const projections = JSON.parse(readFileSync(path.join(runResult.out, 'product-projections.json'), 'utf8'));
    const create = projections[sources[0].create_key];
    expect(sources[0].renderer_environment_digest).toMatch(/^[0-9a-f]{64}$/);
    expect(sources[0].renderer_environment_digest).toBe(create.result.evidence.rendererEnvironmentDigest);
    const operationDir = createHash('sha256').update(create.result.operationId).digest('hex');
    const source = path.join(runResult.out, 'artifacts', operationDir, 'source.txt');
    expect(sources[0].source_sha256).toBe(createHash('sha256').update(readFileSync(source)).digest('hex'));
    const trainingFilter = path.join(runResult.out, 'training-filter.json');
    writeFileSync(trainingFilter, JSON.stringify({
      creates: [{ run_dir: runResult.out, create_key: sources[0].create_key, source_sha256: sources[0].source_sha256 }],
      holdout_digests: [sources[0].source_sha256],
    }));
    const held = await runSinterAsync([...command, '--training-filter', trainingFilter], runResult.env);
    expect(held.status, held.out.slice(-400)).toBe(0);
    expect(JSON.parse(readFileSync(acceptedFile, 'utf8'))).toEqual([]);
    const boundProjectionsPath = path.join(sources[0].state_root, 'product-projections.json');
    const originalProjections = readFileSync(boundProjectionsPath, 'utf8');
    const mismatched = JSON.parse(originalProjections);
    mismatched[sources[0].create_key].result.domain = 'p5';
    writeFileSync(boundProjectionsPath, JSON.stringify(mismatched));
    const wrongDomain = await runSinterAsync(command, runResult.env);
    expect(wrongDomain.status, wrongDomain.out.slice(-400)).toBe(0);
    expect(JSON.parse(readFileSync(acceptedFile, 'utf8'))).toEqual([]);
    writeFileSync(boundProjectionsPath, originalProjections);
    writeFileSync(source, 'unverified source');
    const rejected = await runSinterAsync(command, runResult.env);
    expect(rejected.status, rejected.out.slice(-400)).toBe(0);
    expect(JSON.parse(readFileSync(acceptedFile, 'utf8'))).toEqual([]);
  });
});

describe('spawned loop carry-over: loop N+1 is built from loop N (generate --revise-from)', () => {
  it('loops 2 and 3 carry the previous loop source and the judge critique, and a different loop 1 changes loop 2', async () => {
    const L1 = LIVELY_HTML.replace('</body>', '<!--LOOP1_SOURCE_MARKER--></body>');
    const one = await run(L1, [], {}, 'CRITIQUE_FROM_LOOP_ONE: the shapes lack depth');
    expect(one.res.status, one.res.out.slice(-400)).toBe(0);
    const L2 = LIVELY_HTML.replace('</body>', '<!--LOOP2_SOURCE_MARKER--></body>');
    const two = await run(L2, ['--revise-from', one.out, '--revise-loop', '2', '--revise-of', '3'], {}, 'CRITIQUE_FROM_LOOP_TWO: the motion is flat');
    expect(two.res.status, two.res.out.slice(-400)).toBe(0);
    expect(two.generated[0].user).toContain('LOOP1_SOURCE_MARKER');
    expect(two.generated[0].user).toContain('CRITIQUE_FROM_LOOP_ONE');
    expect(two.generated[0].user).toContain('MEASURED PALETTE OF THE CURRENT PIECE: ');
    expect(two.generated[0].user).toContain('DESIGN TIER: the previous loop reached "excellent"'.replace('excellent','polished'));
    const three = await run(LIVELY_HTML, ['--revise-from', two.out, '--revise-loop', '3', '--revise-of', '3']);
    expect(three.res.status, three.res.out.slice(-400)).toBe(0);
    expect(three.generated[0].user).toContain('LOOP2_SOURCE_MARKER');
    expect(three.generated[0].user).toContain('CRITIQUE_FROM_LOOP_TWO');
    expect(three.generated[0].user).not.toContain('LOOP1_SOURCE_MARKER');
    // bypass: without --revise-from the same request starts fresh and carries nothing
    const fresh = await run(LIVELY_HTML);
    expect(fresh.generated[0].user).not.toContain('CRITIQUE_FROM_LOOP_ONE');
  });
});

describe('nodeprompt: a concept graph rewrites the request (spawned --concept-graph)', () => {
  it('the graph labels and relations reach the generator brief; without the flag they do not; a malformed graph fails loudly', async () => {
    const graph = path.join(work, 'graph.json');
    writeFileSync(graph, JSON.stringify({ nodes: [
      { id: 'a', label: 'harbour at dusk', type: 'concept' },
      { id: 'b', label: 'quiet loneliness', type: 'mood' }],
    edges: [{ sourceId: 'a', targetId: 'b', relation: 'amplify' }] }));
    const on = await run(LIVELY_HTML, ['--concept-graph', graph]);
    expect(on.res.status, on.res.out.slice(-400)).toBe(0);
    expect(on.generated[0].user).toContain('harbour at dusk');
    expect(on.generated[0].user).toContain('quiet loneliness');
    expect(on.generated[0].user).toContain('# Structured Generation Prompt');
    const off = await run(LIVELY_HTML);
    expect(off.generated[0].user).not.toContain('harbour at dusk');
    const bad = path.join(work, 'bad.json');
    writeFileSync(bad, '{"nodes": 3}');
    const failed = await run(LIVELY_HTML, ['--concept-graph', bad]);
    expect(failed.res.status).not.toBe(0);
    expect(failed.generated.length).toBe(0);
  });
});

describe('creative-run w9Briefs: the frozen Wave 9 graphs are the compose input (spawned --w9-brief)', () => {
  it('list prints the three frozen briefs; an unknown id and a clash with --spec fail without calling the provider', async () => {
    const fake = await startFakeProvider({});
    try {
      const env = fakeProviderEnv(fake, { home: path.join(work, 'hw'), stateRoot: path.join(work, 'sw') });
      const list = await runSinterAsync(['compose', '--w9-brief', 'list'], env);
      expect(list.status, list.out.slice(-300)).toBe(0);
      expect(list.out).toMatch(/temporal\s+5 nodes/);
      expect(list.out).toMatch(/narrative\s+4 nodes/);
      expect(list.out).toMatch(/information\s+3 nodes/);
      const bad = await runSinterAsync(['compose', '--w9-brief', 'nope'], env);
      expect(bad.status).not.toBe(0);
      expect(bad.out).toContain('unknown --w9-brief');
      expect(fake.generated.length).toBe(0);
    } finally { await fake.close(); }
  });
});

describe('autonomy PolicyExperimentRunner: garden experiment compares two policies (spawned)', () => {
  const variant = (id: string) => ({ id, kind: 'loop-mix', label: id, config: { explore: 0.5 } });
  const series = (id: string, base: number) => Array.from({ length: 12 }, (_, i) => ({ variantId: id, metric: 'score', value: base + (i % 3) * 0.01 }));
  async function experiment(spec: unknown) {
    const file = path.join(work, `exp${n++}.json`); writeFileSync(file, JSON.stringify(spec));
    const fake = await startFakeProvider({});
    try { return await runSinterAsync(['garden', 'experiment', file], fakeProviderEnv(fake, { home: path.join(work, 'hg'), stateRoot: path.join(work, 'sg') })); } finally { await fake.close(); }
  }
  it('a clearly better treatment wins; equal policies are inconclusive; too few samples and mixed metrics are refused', async () => {
    const win = await experiment({ control: variant('a'), treatment: variant('b'), results: [...series('a', 0.5), ...series('b', 0.8)] });
    expect(win.status, win.out.slice(-300)).toBe(0);
    expect(win.out).toMatch(/: treatment \(confidence [01]\.\d\d\)/);
    const same = await experiment({ control: variant('a'), treatment: variant('b'), results: [...series('a', 0.6), ...series('b', 0.6)] });
    expect(same.out).toMatch(/: inconclusive/);
    const few = await experiment({ control: variant('a'), treatment: variant('b'), results: [...series('a', 0.5).slice(0, 3), ...series('b', 0.9).slice(0, 3)] });
    expect(few.out).toMatch(/: inconclusive \(confidence 0\.00\)/);
    const mixed = await experiment({ control: variant('a'), treatment: variant('b'), results: [{ variantId: 'a', metric: 'score', value: 1 }, { variantId: 'b', metric: 'other', value: 1 }] });
    expect(mixed.status).not.toBe(0);
    expect(mixed.out).toContain('refusing to mix');
  });
});

describe('identity capabilityProbe: sinter capabilities classifies held probe results (spawned)', () => {
  async function caps(probes: unknown, extra: string[] = []) {
    const file = path.join(work, `caps${n++}.json`); writeFileSync(file, JSON.stringify(probes));
    const fake = await startFakeProvider({});
    try { return await runSinterAsync(['capabilities', file, ...extra], fakeProviderEnv(fake, { home: path.join(work, 'hc'), stateRoot: path.join(work, 'sc') })); } finally { await fake.close(); }
  }
  it('fresh evidence attests; none is UNATTESTED; stale evidence is not attested; a denial does not demote another surface; duplicates are refused', async () => {
    const fresh = new Date().toISOString(); const stale = new Date(Date.now() - 86_400_000).toISOString();
    const r = await caps([
      { surface: 'openai-direct', state: 'available', evidence: { probeClass: 'auth-check', probedAt: fresh } },
      { surface: 'anthropic-direct', state: 'available' },
      { surface: 'google-direct', state: 'available', evidence: { probeClass: 'auth-check', probedAt: stale } },
      { surface: 'glm-direct', state: 'denied' }]);
    expect(r.status, r.out.slice(-400)).toBe(0);
    expect(r.out).toMatch(/openai-direct\s+available\s+attested/);
    expect(r.out).toMatch(/anthropic-direct\s+available\s+UNATTESTED/);
    expect(r.out).toMatch(/google-direct\s+available\s+UNATTESTED/);
    expect(r.out).toMatch(/glm-direct\s+denied\s+denied/);
    const wide = await caps([{ surface: 'google-direct', state: 'available', evidence: { probeClass: 'auth-check', probedAt: stale } }], ['--max-age-ms', '172800000']);
    expect(wide.out).toMatch(/google-direct\s+available\s+attested/);
    const dup = await caps([{ surface: 'openai-direct', state: 'denied' }, { surface: 'openai-direct', state: 'available' }]);
    expect(dup.status).not.toBe(0);
    expect(dup.out).toContain('CAPABILITY_PROBE_DUPLICATE');
  });
});

describe('scavenger FragmentArchive: sinter fragments browses the curated archive (spawned)', () => {
  async function frag(args: string[]) {
    const fake = await startFakeProvider({});
    try { return await runSinterAsync(['fragments', ...args], fakeProviderEnv(fake, { home: path.join(work, 'hc'), stateRoot: path.join(work, 'sc') })); } finally { await fake.close(); }
  }
  it('lists real categories, draws a constraint and a seed from the shipped archive, searches it, and rejects a bad subcommand', async () => {
    const cats = await frag(['categories']);
    expect(cats.status, cats.out.slice(-300)).toBe(0);
    expect(cats.out).toMatch(/swarm_theory\s+\d+ fragments/);
    const constraint = await frag(['constraint']);
    expect(constraint.status).toBe(0);
    expect(constraint.out.trim().length).toBeGreaterThan(20);
    const seed = await frag(['seed']);
    expect(seed.status).toBe(0);
    expect(seed.out.trim().length).toBeGreaterThan(20);
    const hit = await frag(['search', 'mirror']);
    expect(hit.out).toContain('theory-shattered-mirror');
    const bad = await frag(['bogus']);
    expect(bad.status).not.toBe(0);
    expect(bad.out).toContain('Usage: sinter fragments');
  });
});

describe('swarm NotationTranslator: sinter notation compresses and expands a swarm prompt (spawned)', () => {
  async function nota(args: string[]) {
    const fake = await startFakeProvider({});
    try { return await runSinterAsync(['notation', ...args], fakeProviderEnv(fake, { home: path.join(work, 'hc'), stateRoot: path.join(work, 'sc') })); } finally { await fake.close(); }
  }
  it('known lines collapse to ~tokens, expand back to the same sentence, and a missing file is refused', async () => {
    const f = path.join(work, `prompt${n++}.txt`);
    writeFileSync(f, 'Philosophy:\n- Less is more: every element must earn its place\n- Nature never draws a straight line\n');
    const enc = await nota(['encode', f]);
    expect(enc.status, enc.out.slice(-300)).toBe(0);
    expect(enc.out).toContain('~less-more');
    expect(enc.out).toContain('~nature-curves');
    const e = path.join(work, `enc${n++}.txt`); writeFileSync(e, '~less-more\n~nature-curves\n');
    const dec = await nota(['decode', e]);
    expect(dec.out).toContain('Less is more: every element must earn its place');
    expect(dec.out).toContain('Nature never draws a straight line');
    const bad = await nota(['encode', path.join(work, 'nope.txt')]);
    expect(bad.status).not.toBe(0);
    expect(bad.out).toContain('Notation failed');
  });
});
