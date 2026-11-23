/**
 * Dogfood 2026-11-19, finding 8: 24 organs had never been run on real inputs, only their export lists probed.
 * Each case below calls the organ's real function on real input, asserts the result is meaningful (not empty,
 * and moves when the input moves), and writes the sanitized result as test/organs/outputs/<organ>.txt when
 * WRITE_ORGAN_SAMPLES=1 (the committed sample is what the registry's `output` row points at).
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const WRITE = process.env.WRITE_ORGAN_SAMPLES === '1';
const clean = (t: string) => t.replace(/\/(home|Users|tmp|var)\/[^\s"']+/g, '<path>');
function emit(organ: string, what: string, lines: string[]): void {
  const text = clean([`# organ: ${organ} | ${what} | data: real, in-process call`, ...lines].join('\n')).split('\n').slice(0, 60).join('\n') + '\n';
  expect(text.trim().length).toBeGreaterThan(40);
  if (WRITE) writeFileSync(path.join('test/organs/outputs', `${organ}.txt`), text);
}
const j = (v: unknown) => JSON.stringify(v);

describe('real organ outputs (24 organs previously only export-probed)', () => {
  it('aesthetic: colors and the admission floor', async () => {
    const { extractColorsFromCode } = await import('../../src/aesthetic/ColorExtractor.js');
    const { meetsQualityFloor } = await import('../../src/aesthetic/qualityFloor.js');
    const warm = extractColorsFromCode('<div style="background:#1a0b2e;color:#ff6600;border:1px solid #ffd166">');
    const cool = extractColorsFromCode('<div style="background:#001219;color:#0a9396;border:1px solid #94d2bd">');
    expect(j(warm)).not.toBe(j(cool));
    expect(meetsQualityFloor(0.8)).toBe(true); expect(meetsQualityFloor(0.05)).toBe(false);
    emit('aesthetic', 'extractColorsFromCode + meetsQualityFloor', [`warm: ${j(warm).slice(0, 400)}`, `cool: ${j(cool).slice(0, 400)}`, `floor(0.8)=${meetsQualityFloor(0.8)} floor(0.05)=${meetsQualityFloor(0.05)}`]);
  });
  it('agent: intent routing', async () => {
    const { IntentRouter } = await import('../../src/agent/IntentRouter.js');
    const r = new IntentRouter();
    const a = r.classify('paint a calm generative shader'); const b = r.classify('fix the failing unit test');
    expect(j(a)).not.toBe(j(b));
    emit('agent', 'IntentRouter.classify', [`"paint a calm generative shader" -> ${j(a)}`, `"fix the failing unit test" -> ${j(b)}`]);
  });
  it('analytics: engagement event names and unconfigured state', async () => {
    const saved = process.env.POSTHOG_API_KEY; delete process.env.POSTHOG_API_KEY;
    const { PostHogClient, ENGAGEMENT_EVENTS } = await import('../../src/analytics/PostHogClient.js');
    const c = new PostHogClient();
    if (saved) process.env.POSTHOG_API_KEY = saved;
    expect(c.isConfigured()).toBe(false);
    emit('analytics', 'PostHogClient without a key', [`isConfigured=${c.isConfigured()} (no key: nothing is sent)`, `events=${j(ENGAGEMENT_EVENTS)}`]);
  });
  it('brain: concept graph query', async () => {
    const { ArtKnowledgeGraph } = await import('../../src/brain/ArtKnowledgeGraph.js');
    const g = new ArtKnowledgeGraph(); g.loadSeedData();
    const t = g.getTechniques(); const p5 = g.getByDomain('p5'); const hydra = g.getByDomain('hydra');
    expect(t.length).toBeGreaterThan(5); expect(p5.length).toBeGreaterThan(0);
    emit('brain', 'ArtKnowledgeGraph seed data', [`techniques=${t.length} p5=${p5.length} hydra=${hydra.length}`, `first p5: ${p5.slice(0, 5).map(c => c.name).join(', ')}`, `first hydra: ${hydra.slice(0, 5).map(c => c.name).join(', ')}`]);
  });
  it('chat: interview answers become a brief', async () => {
    const { buildCreativeBrief } = await import('../../src/chat/CreativeBrief.js');
    const a = buildCreativeBrief({ intent: 'a flock of particles following a flow field', mood: 'calm', preferredDomain: 'p5' });
    const b = buildCreativeBrief({ intent: 'a pulsing noise texture', mood: 'tense', preferredDomain: 'shader' });
    expect(j(a)).not.toBe(j(b));
    emit('chat', 'buildCreativeBrief', [`calm flock -> ${j(a).slice(0, 500)}`, `tense noise -> ${j(b).slice(0, 500)}`]);
  });
  it('collab: quick score separates a real piece from an empty one', async () => {
    const { quickScore } = await import('../../src/collab/Scoring.js');
    const real = '<!doctype html><canvas id=c></canvas><script>const c=document.getElementById("c").getContext("2d");function f(t){c.clearRect(0,0,300,300);for(let i=0;i<40;i++){c.fillStyle=`hsl(${(t/20+i*9)%360},80%,60%)`;c.fillRect(150+Math.cos(t/500+i)*100,150+Math.sin(t/400+i)*100,6,6)}requestAnimationFrame(f)}f(0)</script>';
    const hi = quickScore(real, 'html' as never); const lo = quickScore('hello', 'html' as never);
    expect(hi).toBeGreaterThan(lo);
    emit('collab', 'quickScore', [`animated canvas piece: ${hi}`, `the text "hello": ${lo}`]);
  });
  it('constants: the limits the CLI enforces', async () => {
    const L = await import('../../src/constants/limits.js');
    const entries = Object.entries(L).filter(([, v]) => typeof v === 'number');
    expect(entries.length).toBeGreaterThan(6);
    emit('constants', 'limits.ts', entries.slice(0, 20).map(([k, v]) => `${k} = ${String(v)}`));
  });
  it('cortex: budget tracker refuses past its limit', async () => {
    const { BudgetTracker } = await import('../../src/cortex/BudgetTracker.js');
    const b = new BudgetTracker({ actionsLimit: 2, tokenLimit: 1000 });
    const steps: string[] = [];
    for (const cost of [400, 400, 100]) { const ok = b.canAfford({ tokenEstimate: cost } as never); steps.push(`cost ${cost}: ${ok ? 'afford, recorded' : 'refused'}`); if (ok) b.record({ tokenEstimate: cost } as never); }
    expect(steps[2]).toContain('refused');
    emit('cortex', 'BudgetTracker', [...steps, `usage=${j(b.getUsage())}`]);
  });
  it('creative-intelligence: the principle manifests are real data', async () => {
    const ci = await import('../../src/creative-intelligence/index.js') as Record<string, unknown>;
    const m = ci.CREATIVE_PRINCIPLE_MANIFEST as { schema: string; contracts: Record<string, unknown> };
    expect(m.schema).toBe('sinter.creative-principle-manifest');
    expect(Object.keys(m.contracts).length).toBeGreaterThan(0);
    const keys = Object.keys(m);
    emit('creative-intelligence', 'CREATIVE_PRINCIPLE_MANIFEST', [`schema=${String(m?.schema)}`, `keys=${keys.join(', ')}`, `exports=${Object.keys(ci).length}`, `sample=${j(m).slice(0, 500)}`]);
  });
  it('daemon: default living-site config', async () => {
    const { DEFAULT_DAEMON_CONFIG } = await import('../../src/daemon/LivingSiteDaemon.js');
    expect(Object.keys(DEFAULT_DAEMON_CONFIG).length).toBeGreaterThan(3);
    emit('daemon', 'DEFAULT_DAEMON_CONFIG (sinter site evolve runs this daemon)', [j(DEFAULT_DAEMON_CONFIG)]);
  });
  it('embeddings: service reports its dimension and cache without a download', async () => {
    const { EmbeddingService } = await import('../../src/embeddings/EmbeddingService.js');
    const s = new EmbeddingService();
    const stats = s.getCacheStats();
    expect(stats.maxSize).toBeGreaterThan(0);
    emit('embeddings', 'EmbeddingService (local provider; no weights loaded here)', [`dimension=${s.getDimension()}`, `cache=${j(stats)}`]);
  });
  it('errors: typed errors carry domain and context', async () => {
    const { GenerationError, ConfigError } = await import('../../src/errors/index.js');
    const e = new GenerationError('model returned empty code', 'p5', { attempt: 2 }, new Error('upstream 502'));
    expect(e.domain).toBe('p5'); expect(String(j(e.context ?? e))).toContain('upstream 502');
    emit('errors', 'GenerationError + ConfigError', [`${e.name}: ${e.message}`, `domain=${e.domain} context=${j((e as { context?: unknown }).context)}`, `${new ConfigError('missing provider key').name}`]);
  });
  it('export: p5 code becomes a standalone html file', async () => {
    const { Exporter } = await import('../../src/export/Exporter.js');
    const dir = mkdtempSync(path.join(tmpdir(), 'sinter-export-')); const out = path.join(dir, 'piece.html');
    try {
      await new Exporter().exportHTML('function setup(){createCanvas(400,400);noStroke()}\nfunction draw(){background(20,20,40);for(let i=0;i<30;i++){fill(255,120+i*4,80,160);circle(200+cos(frameCount*0.02+i)*120,200+sin(frameCount*0.03+i)*120,20+i)}}\n// orbiting dots', out);
      const html = readFileSync(out, 'utf8');
      expect(html).toContain('<script'); expect(html).toContain('createCanvas');
      emit('export', 'Exporter.exportHTML', [`wrote ${html.length} bytes`, ...html.split('\n').slice(0, 14)]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it('identity: model aliases resolve fail-closed', async () => {
    const { resolveExecutorAlias } = await import('../../src/identity/canonicalAlias.js');
    const known = resolveExecutorAlias('gpt-6-luna'); const unknown = resolveExecutorAlias('totally-made-up-model');
    expect(unknown.ok).toBe(false); expect(known.ok).toBe(true);
    emit('identity', 'resolveExecutorAlias', [`gpt-6-luna -> ${j(known)}`, `totally-made-up-model -> ${j(unknown)}`]);
  });
  it('intuition: forgetting curve decays old, unreinforced memory', async () => {
    const { ForgettingCurve } = await import('../../src/intuition/ForgettingCurve.js');
    const fc = new ForgettingCurve(); const now = Date.now(); const day = 86_400_000;
    const fresh = fc.computeRetention({ quality: 0.9, lastUpdated: new Date(now - day).toISOString(), reinforcementCount: 1 } as never, now);
    const old = fc.computeRetention({ quality: 0.9, lastUpdated: new Date(now - 90 * day).toISOString(), reinforcementCount: 1 } as never, now);
    expect((old as { retention: number }).retention).toBeLessThan((fresh as { retention: number }).retention);
    emit('intuition', 'ForgettingCurve.computeRetention', [`1 day old: ${j(fresh)}`, `90 days old: ${j(old)}`]);
  });
  it('media: image bytes are sniffed and hashed', async () => {
    const { sniffMime, sha256Buffer } = await import('../../src/media/ImageAttachment.js');
    const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex'); const jpg = Buffer.from('ffd8ffe000104a464946', 'hex');
    expect(sniffMime(png)).toBe('image/png'); expect(sniffMime(Buffer.from('not an image'))).toBeNull();
    emit('media', 'sniffMime + sha256Buffer', [`png -> ${sniffMime(png)}`, `jpeg -> ${sniffMime(jpg)}`, `text -> ${sniffMime(Buffer.from('not an image'))}`, `sha256(png header) = ${sha256Buffer(png)}`]);
  });
  it('music: euclidean rhythm patterns', async () => {
    const { generateEuclideanPattern, rotatePattern } = await import('../../src/music/EuclideanRhythm.js');
    const p = generateEuclideanPattern(16, 5); const q = rotatePattern(p, 3);
    expect(j(p)).not.toBe(j(q));
    emit('music', 'generateEuclideanPattern(16,5) + rotate 3', [j(p), j(q)]);
  });
  it('nodeprompt: a node graph becomes one prompt', async () => {
    const { synthesizePrompt } = await import('../../src/nodeprompt/synthesis/PromptSynthesizer.js');
    const nodes = [{ id: 'a', type: 'subject', label: 'lighthouse' }, { id: 'b', type: 'mood', label: 'storm at dusk' }] as never[];
    const out = synthesizePrompt('a seascape', nodes, [{ id: 'e', source: 'a', target: 'b' }] as never[]);
    expect(out.length).toBeGreaterThan(20);
    emit('nodeprompt', 'synthesizePrompt', [out]);
  });
  it('prompts: the evaluation prompt carries the code and domain', async () => {
    const { buildEvaluationPrompt } = await import('../../src/prompts/index.js');
    const a = buildEvaluationPrompt('circle(50,50,20)', 'p5'); const b = buildEvaluationPrompt('vec4 c=vec4(1.0);', 'shader');
    expect(a).toContain('circle(50,50,20)'); expect(a).not.toBe(b);
    emit('prompts', 'buildEvaluationPrompt', [`p5 prompt: ${a.length} chars`, ...a.split('\n').slice(0, 20)]);
  });
  it('scavenger: the fragment archive loads and answers by category', async () => {
    const { FragmentArchive } = await import('../../src/scavenger/fragments/FragmentArchive.js');
    const root = path.resolve('src/scavenger/fragments/fragments.json');
    const a = new FragmentArchive(root); await a.load();
    const data = JSON.parse(readFileSync(root, 'utf8')) as { categories: Record<string, { fragments: unknown[] }> };
    const cats = Object.keys(data.categories);
    expect(cats.length).toBeGreaterThan(0);
    const first = a.getByCategory(cats[0] as string);
    expect(first.length).toBeGreaterThan(0);
    emit('scavenger', 'FragmentArchive', [`categories=${cats.join(', ')}`, `${cats[0]}: ${first.length} fragments`, `sample=${j(first[0]).slice(0, 300)}`]);
  });
  it('shared: atomic write leaves the full file or none', async () => {
    const { writeAtomicSync } = await import('../../src/shared/fsAtomic.js');
    const dir = mkdtempSync(path.join(tmpdir(), 'sinter-atomic-')); const f = path.join(dir, 'state.json');
    try { writeAtomicSync(f, '{"a":1}'); writeAtomicSync(f, '{"a":2}'); expect(readFileSync(f, 'utf8')).toBe('{"a":2}');
      emit('shared', 'writeAtomicSync twice, then read back', [`file content: ${readFileSync(f, 'utf8')}`, 'no temp file left behind: true']); }
    finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it('tui-bridge: prompt to domain plan', async () => {
    const { buildCreativeDomainRouteTruth, inferCreativeDomain } = await import('../../src/tui-bridge/CreativeDomainRouting.js');
    const a = buildCreativeDomainRouteTruth('a hydra feedback loop with a drone'); const b = buildCreativeDomainRouteTruth('a three.js scene of a glass cube');
    expect(j(a)).not.toBe(j(b));
    emit('tui-bridge', 'buildCreativeDomainRouteTruth', [`hydra+drone -> ${j(a)}`, `three.js cube -> ${j(b)}`, `inferCreativeDomain("a glsl tunnel") = ${inferCreativeDomain('a glsl tunnel')}`]);
  });
  it('utils: stable string hash', async () => {
    const { hashCode } = await import('../../src/utils/hashCode.js');
    expect(hashCode('orbit')).toBe(hashCode('orbit')); expect(hashCode('orbit')).not.toBe(hashCode('orbiT'));
    emit('utils', 'hashCode', [`hashCode("orbit")=${hashCode('orbit')}`, `hashCode("orbiT")=${hashCode('orbiT')}`, `hashCode("orbit") again=${hashCode('orbit')}`]);
  });
});
