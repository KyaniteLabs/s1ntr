/**
 * Hybrid composition: plan -> layers (each by its domain's normal generator) ->
 * ONE self-contained page with a shared contract -> render check -> manifest.
 *
 * Shared contract (all on the composite stage, no per-layer cooperation needed):
 *  - clock: the stage's existing `sinter:state` time, plus one beat grid at plan.bpm
 *    that also fixes the sound layer's tempo;
 *  - palette: every layer prompt carries the same palette;
 *  - signal: the beat is posted to every layer as `sinter:signal`
 *    (window.sinterSignal.beat) AND applied by the stage to the target layer's
 *    scale or opacity, so the cross-layer response exists even if a layer ignores it;
 *  - mask: an svg layer becomes a luminance CSS mask on its target layer.
 */
import type { ControlRecipe } from '../ControlRecipe.js';
import { controlScript } from './HybridControl.js';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { writeFileAtomic } from '../../utils/atomicWrite.js';
import path from 'node:path';
import type { CompositionResult, CompositionSpec, ComposedLayer } from '../CompositionOrchestrator.js';
import { capLayerBrightness, exceedsWashoutBudget } from '../BlendBudget.js';
import type { LLMClient } from '../../llm/LLMClient.js';
import { buildHybridProject, type HybridProjectBuild } from './HybridProject.js';
import { describeMedium, parseMetaDescriptor, type MediumRecord } from '../../core/MediumLine.js';
import {
  HybridPlanError, layerPromptWithContract, parseHybridPlan, plannerSystemPrompt,
  type ExplicitLayerRequest, type HybridPlan,
} from './HybridPlan.js';

export const HYBRID_MANIFEST = 'composition.hybrid.json';

export class HybridLayerError extends Error {
  constructor(message: string, readonly layerIndex: number, readonly domain: string) {
    super(message);
    this.name = 'HybridLayerError';
  }
}

/** Ask S1NTR's planner to decide (no layer list needed) or to fill in an operator-fixed list. */
export async function planHybrid(
  prompt: string, llm: LLMClient, explicit?: readonly ExplicitLayerRequest[],
): Promise<HybridPlan> {
  const res = await llm.generate(plannerSystemPrompt(explicit), `Idea: ${prompt}`);
  const plan = parseHybridPlan(res.code ?? '', explicit);
  const visual = plan.layers.map((l, i) => ({ i, l })).filter(({ l }) => l.domain !== 'tone' && l.domain !== 'strudel');
  const probe = visual.map(({ l }) => ({ domain: l.domain, prompt: l.prompt, blendMode: l.blendMode, opacity: l.opacity }));
  if (exceedsWashoutBudget(probe as never)) {
    const capped = capLayerBrightness(probe as never) as Array<{ opacity: number }>;
    const layers = plan.layers.map((l) => l);
    visual.forEach(({ i }, k) => { layers[i] = { ...layers[i], opacity: capped[k].opacity }; });
    return { ...plan, layers };
  }
  return plan;
}

export function specFromPlan(plan: HybridPlan): CompositionSpec {
  return {
    title: plan.title,
    background: plan.background,
    layers: plan.layers.map((layer, index) => ({
      domain: layer.domain,
      prompt: layerPromptWithContract(plan, index),
      blendMode: layer.blendMode,
      opacity: layer.opacity,
      ...(layer.code ? { code: layer.code } : {}),
    })),
  };
}

function maskDataUri(layer: ComposedLayer | undefined): string | undefined {
  const html = layer?.artifactHtml ?? '';
  const match = /<svg\b[^>]*>[\s\S]*<\/svg>/i.exec(html);
  if (!match) return undefined;
  const fitted = match[0].replace(/<svg\b([^>]*)>/i, (_m, attrs: string) => {
    const kept = attrs.replace(/\s(?:width|height|preserveAspectRatio)="[^"]*"/gi, '');
    const ns = /xmlns=/.test(kept) ? '' : ' xmlns="http://www.w3.org/2000/svg"';
    return `<svg${kept}${ns} width="100%" height="100%" preserveAspectRatio="xMidYMid slice">`;
  });
  return `data:image/svg+xml;base64,${Buffer.from(fitted, 'utf8').toString('base64')}`;
}

function stageScript(build: HybridProjectBuild, plan: HybridPlan): string {
  const cfg = { bpm: plan.bpm, classes: [...build.classes.entries()] };
  const b64 = Buffer.from(JSON.stringify(cfg), 'utf8').toString('base64');
  return `<style id="sinter-hybrid-css">\n${build.css}\n</style>
<script id="sinter-hybrid-stage">(function(){var cfg=JSON.parse(atob('${b64}'));
function frames(){return Array.prototype.slice.call(document.querySelectorAll('iframe.sinter-layer'))}
cfg.classes.forEach(function(e){var f=frames().find(function(x){return Number(x.dataset.layerIndex)===e[0]});
if(f)e[1].forEach(function(c){f.classList.add(c)})});
if(cfg.bpm){var t0=performance.now();window.sinterBeat={beat:0,beats:0};
/* the stage only keeps the clock; the control script is what delivers the beat to wired layers */
(function tick(now){var beats=(now-t0)/1000*cfg.bpm/60,beat=typeof window.sinterBeatHold==='number'?window.sinterBeatHold:Math.exp(-5*(beats%1));window.sinterBeat={beat:beat,beats:beats};
requestAnimationFrame(tick)})(t0)}
})();</script>${build.control ? '\n' + controlScript(build.control) : ''}`;
}

export interface HybridFinalized {
  readonly plan: HybridPlan;
  readonly html: string;
  /** The composition organs' record of this piece (engine project, masks, beat animations, analyzer check). */
  readonly build: HybridProjectBuild;
}

/** Strict: a failed layer fails the whole piece, naming the layer. Then wire the shared contract. */
export function finalizeHybrid(result: CompositionResult, plan: HybridPlan, prompt?: string): HybridFinalized {
  plan.layers.forEach((layer, index) => {
    const composed = result.layers[index];
    if (!composed || !composed.generated) {
      throw new HybridLayerError(
        `hybrid layer ${index} (${layer.domain}, ${layer.role}) failed: ${composed?.error ?? 'no result'}`, index, layer.domain);
    }
  });
  const maskUri = (index: number): string => {
    const uri = maskDataUri(result.layers[index]);
    if (!uri) throw new HybridLayerError(`layer ${index} (svg, mask) produced no <svg> to use as a mask`, index, 'svg');
    return uri;
  };
  const build = buildHybridProject(plan, result, prompt ?? [plan.title, ...plan.layers.map((l) => l.prompt)].join(' '), maskUri);
  const script = stageScript(build, plan);
  const at = result.html.lastIndexOf('</body>');
  const html = at >= 0 ? `${result.html.slice(0, at)}${script}\n${result.html.slice(at)}` : `${result.html}${script}`;
  return { plan, html, build };
}

const DOMAIN_LIBS: Record<string, string> = {
  p5: 'p5.js', three: 'three.js', glsl: 'WebGL/GLSL', hydra: 'hydra', tone: 'Tone.js', strudel: 'strudel',
};

export function hybridMedium(result: CompositionResult, plan: HybridPlan): MediumRecord {
  const libs = new Set<string>();
  plan.layers.forEach((layer, index) => {
    const named = DOMAIN_LIBS[layer.domain];
    if (named) libs.add(named);
    if (layer.domain === 'custom') {
      const d = parseMetaDescriptor(result.layers[index]?.artifactHtml ?? '');
      d?.libraries.forEach((l) => libs.add(l));
    }
  });
  return describeMedium({
    domain: plan.layers[0].domain,
    source: '',
    libraries: [...libs],
    renderTarget: plan.layers.length > 1 ? 'one self-contained page of stacked layers' : 'one self-contained page',
    decision: { source: plan.chosenBy === 'operator-layers' ? 'forced' : 'planner', reason: plan.reason },
    layers: plan.layers.map((l, i) => ({ id: `layer-${i}`, domain: l.domain, role: l.role, why: l.why })),
  });
}

export interface LayerJudgement {
  readonly index: number; readonly domain: string; readonly role: string;
  readonly errors: readonly string[]; readonly alive: boolean;
}
/** A beat-wired layer's measured answer to the signal (mean abs pixel change, 0..1, of that layer's own frame). */
export interface SignalResponse {
  readonly layer: number; readonly domain: string;
  /** Median change between adjacent shots at DIFFERENT beat values (0..1 mean abs pixel change of the layer alone). */
  readonly effect: number;
  /** Median change between adjacent shots at the SAME beat value, taken at the same spacing: the layer's own churn. */
  readonly noise: number;
  /** Read by compose loops, including replay of manifests written before sampling. */
  readonly responsive: boolean;
  readonly busy?: boolean;
  /** responsive: beat-held changes are distinguishably larger; deaf: calm layer, no response; not-measurable: churn hides it. */
  readonly status: 'responsive' | 'deaf' | 'not-measurable';
  readonly samples: { readonly beat: number; readonly same: number };
  /** Human sentence for the judge output. */
  readonly note: string;
}
/** A response must beat the layer's own churn by at least this much (mean abs pixel change) to count as visible. */
export const SIGNAL_RESPONSE_FLOOR = 0.01;
// Adjacent pairs span one capture interval, whether the beat changes or holds.
const SIGNAL_SHOT_HOLDS = [0, 0, 1, 1, 0, 0, 1, 1, 0, 0, 1, 1] as const;

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2) return sorted[middle];
  return (sorted[middle - 1] + sorted[middle]) / 2;
}

/** Four of the five transitions must exceed every same-beat change and the median gap must be visible. */
export function classifySignalResponse(layer: number, domain: string, beat: readonly number[], same: readonly number[]): SignalResponse {
  const effect = median(beat);
  const noise = median(same);
  const peakChurn = Math.max(...same);
  const separated = beat.filter(change => change > peakChurn).length >= Math.ceil(0.8 * beat.length)
    && effect - noise >= SIGNAL_RESPONSE_FLOOR;
  const status = separated ? 'responsive' : noise < SIGNAL_RESPONSE_FLOOR ? 'deaf' : 'not-measurable';
  const descriptions = {
    responsive: 'responds to the beat',
    deaf: 'is wired to the beat but its frames do not change with the signal',
    'not-measurable': 'response not measurable against its own churn',
  };
  const samples = { beat: beat.length, same: same.length };
  const measuredEffect = Number(effect.toFixed(4));
  const measuredNoise = Number(noise.toFixed(4));
  const note = `layer ${layer} (${domain}) ${descriptions[status]} (beat-held change ${measuredEffect}, own churn ${measuredNoise}, ${samples.beat}+${samples.same} frame pairs)`;
  return { layer, domain, effect: measuredEffect, noise: measuredNoise, status, samples, note,
    responsive: status === 'responsive', ...(status === 'not-measurable' ? { busy: true } : {}) };
}

export interface FrameStats { readonly meanLuminance: number; readonly spread: number }
/** Named judge criterion: do the layers read as one piece (shared palette, planner agreed with the idea)? */
export const COHERENCE_CRITERION = 'seam/coherence between layers';
export interface CoherenceScore {
  readonly criterion: typeof COHERENCE_CRITERION;
  /** 0..1, higher is more coherent: 0.7 palette fit of the rendered frame + 0.3 CompositionAnalyzer agreement. */
  readonly score: number;
  readonly paletteFit: number;
  readonly analyzerAgreement: number;
}
/** Below this the layers clash badly enough that the piece fails on this criterion alone. */
export const COHERENCE_FAIL_BELOW = 0.35;

export interface HybridJudgement {
  readonly verdict: 'pass' | 'fail' | 'unjudged';
  readonly coherence?: CoherenceScore;
  readonly reason?: string;
  readonly early?: FrameStats;
  readonly late?: FrameStats;
  /** Mean absolute pixel change between the early and late frames, 0..1. */
  readonly frameChange?: number;
  readonly framesDiffer?: boolean;
  readonly layers: readonly LayerJudgement[];
  /** Per control mapping: the last value the in-page control loop wrote to its target (undefined = loop never ran). */
  readonly control?: ReadonlyArray<{ readonly mapping: string; readonly target?: number }>;
  /** Per beat-wired visual layer: do its frames change with the signal? */
  readonly signals?: readonly SignalResponse[];
  /** Non-failing observations, e.g. a wired layer whose response could not be measured. */
  readonly notes?: readonly string[];
  readonly stills?: { readonly early: string; readonly late: string };
}

const STATS_FN = `async (b64) => {
  const img = await createImageBitmap(await (await fetch('data:image/png;base64,' + b64)).blob());
  const c = new OffscreenCanvas(64, 36); const x = c.getContext('2d'); x.drawImage(img, 0, 0, 64, 36);
  return Array.from(x.getImageData(0, 0, 64, 36).data);
}`;

function stats(px: number[]): FrameStats {
  const lum: number[] = [];
  for (let i = 0; i < px.length; i += 4) lum.push((0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2]) / 255);
  const mean = lum.reduce((s, v) => s + v, 0) / lum.length;
  const spread = Math.sqrt(lum.reduce((s, v) => s + (v - mean) ** 2, 0) / lum.length);
  return { meanLuminance: mean, spread };
}

function hexRgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '');
  const v = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  return [parseInt(v.slice(0, 2), 16), parseInt(v.slice(2, 4), 16), parseInt(v.slice(4, 6), 16)];
}
function chroma(rgb: readonly number[]): [number, number, number] | null {
  const m = Math.max(rgb[0], rgb[1], rgb[2]);
  if (m < 1) return null;
  return [rgb[0] / m, rgb[1] / m, rgb[2] / m];
}

/** Share of lit, coloured pixels whose hue sits near the shared palette. Neutral and dark pixels fit by definition. */
export function paletteFit(px: readonly number[], plan: Pick<HybridPlan, 'palette'>): number {
  const wanted = [plan.palette.background, ...plan.palette.colors].map((c) => chroma(hexRgb(c))).filter((c): c is [number, number, number] => c !== null);
  let coloured = 0; let fit = 0;
  for (let i = 0; i < px.length; i += 4) {
    const rgb = [px[i], px[i + 1], px[i + 2]];
    const max = Math.max(...rgb); const min = Math.min(...rgb);
    if (max < 40 || (max - min) / Math.max(max, 1) < 0.2) continue; // dark or near-neutral
    coloured += 1;
    const c = chroma(rgb)!;
    if (wanted.some((w) => Math.hypot(c[0] - w[0], c[1] - w[1], c[2] - w[2]) < 0.45)) fit += 1;
  }
  return coloured === 0 ? 1 : fit / coloured;
}

/** Fold the render and the CompositionAnalyzer cross-check into one named criterion. */
export function scoreCoherence(
  px: readonly number[], plan: Pick<HybridPlan, 'palette'>,
  analyzer?: { readonly keywordDomains: readonly string[]; readonly agreeing: readonly string[] },
): CoherenceScore {
  const fit = paletteFit(px, plan);
  const agreement = analyzer && analyzer.keywordDomains.length > 0 ? analyzer.agreeing.length / analyzer.keywordDomains.length : 1;
  return { criterion: COHERENCE_CRITERION, score: Math.round((0.7 * fit + 0.3 * agreement) * 1000) / 1000, paletteFit: fit, analyzerAgreement: agreement };
}

/** Render the composite headless; early and late frames, per-layer liveness, and loud failures. */
export async function judgeHybrid(
  html: string, plan: HybridPlan, outDir: string,
  opts: { control?: ControlRecipe; earlyMs?: number; lateMs?: number; width?: number; height?: number; analyzer?: { keywordDomains: readonly string[]; agreeing: readonly string[] } } = {},
): Promise<HybridJudgement> {
  const earlyMs = opts.earlyMs ?? 1500;
  const lateMs = opts.lateMs ?? 5000;
  let browser: import('playwright').Browser | null = null;
  try {
    const { chromium } = await import('playwright');
    const { resolveChromiumExecutablePath } = await import('../../utils/browserAssetFallbacks.js');
    const { createCompositionJudgePage } = await import('../CompositeRenderGate.js');
    const { launchPlaywrightChromium, sandboxOptOutArgs } = await import('../../security/SandboxConfig.js');
    browser = await launchPlaywrightChromium(chromium, { headless: true, executablePath: resolveChromiumExecutablePath(),
      args: [...sandboxOptOutArgs(), '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
    const page = await createCompositionJudgePage(browser, opts.width ?? 960, opts.height ?? 540);
    await page.setContent(html, { waitUntil: 'load', timeout: 30000 });
    await page.waitForTimeout(earlyMs);
    const early = (await page.screenshot({ type: 'png' })) as Buffer;
    await page.waitForTimeout(Math.max(0, lateMs - earlyMs));
    const late = (await page.screenshot({ type: 'png' })) as Buffer;
    const earlyPx = (await page.evaluate(`(${STATS_FN})('${early.toString('base64')}')`)) as number[];
    const latePx = (await page.evaluate(`(${STATS_FN})('${late.toString('base64')}')`)) as number[];
    let delta = 0;
    for (let i = 0; i < earlyPx.length; i += 1) if (i % 4 !== 3) delta += Math.abs(earlyPx[i] - latePx[i]);
    const frameChange = delta / ((earlyPx.length / 4) * 3 * 255);

    const layers: LayerJudgement[] = [];
    const handles = await page.$$('iframe.sinter-layer');
    for (const handle of handles) {
      const index = Number(await handle.getAttribute('data-layer-index'));
      const planned = plan.layers[index];
      if (!planned || planned.role === 'mask' || planned.role === 'sound') continue;
      const frame = await handle.contentFrame();
      const info = frame
        ? await frame.evaluate(() => ({
          errors: ((window as unknown as { __sinterErrors?: string[] }).__sinterErrors ?? []).slice(0, 3),
          canvases: document.querySelectorAll('canvas').length,
          svgs: document.querySelectorAll('svg').length,
          text: (document.body?.innerText ?? '').trim().length,
          nodes: document.body?.querySelectorAll('*').length ?? 0,
        }))
        : { errors: ['frame did not load'], canvases: 0, svgs: 0, text: 0, nodes: 0 };
      layers.push({ index, domain: planned.domain, role: planned.role, errors: info.errors,
        alive: info.canvases + info.svgs + info.text > 0 || info.nodes > 3 });
    }
    const control = opts.control
      ? ((await page.evaluate((ids: string[]) => ids.map((mapping) => {
        try {
          const o = (window as unknown as { SinterControl?: { observe(id: string): { targetValue?: number } } }).SinterControl?.observe(mapping);
          return { mapping, target: o?.targetValue };
        } catch { return { mapping }; }
      }), opts.control.mappings.map((m) => m.id))) as Array<{ mapping: string; target?: number }>)
      : undefined;

    // Signal response: hold the beat at 0 and 1 (stage hook), pause the stage's own CSS loop, and compare the
    // wired layer's pixels. Same-value shots give the layer's own motion; the signal must beat that.
    const signals: SignalResponse[] = [];
    const wiredIndexes = [...new Set(plan.signals.filter((sg) => sg.kind === 'beat' && plan.bpm).map((sg) => sg.to))];
    if (wiredIndexes.length > 0) {
      await page.addStyleTag({ content: 'iframe.sinter-layer{animation-play-state:paused!important}' });
      const hideOthers = async (keep: number) => page.evaluate((k: number) => {
        document.querySelectorAll('iframe.sinter-layer').forEach((f) => {
          (f as HTMLElement).style.visibility = Number((f as HTMLElement).dataset.layerIndex) === k ? 'visible' : 'hidden';
        });
      }, keep);
      const diff = (a: number[], b: number[]): number => {
        let d = 0; let n = 0;
        for (let i = 0; i < a.length; i += 1) if (i % 4 !== 3) { d += Math.abs(a[i] - b[i]); n += 1; }
        return d / (n * 255);
      };
      for (const index of wiredIndexes) {
        const planned = plan.layers[index];
        if (!planned || planned.role === 'mask' || planned.role === 'sound') continue;
        let target: import('playwright').ElementHandle | undefined;
        for (const h of handles) if (Number(await h.getAttribute('data-layer-index')) === index) target = h;
        if (!target) continue;
        await hideOthers(index);
        const shoot = async (hold: number, n: number): Promise<number[]> => {
          await page.evaluate((v: number) => { (window as unknown as { sinterBeatHold?: number }).sinterBeatHold = v; }, hold);
          // jittered wait so a layer that steps on a fixed clock cannot line up with the shot cadence and fake a pattern
          await page.waitForTimeout(160 + ((n * 53) % 97));
          const png = (await target!.screenshot({ type: 'png' })) as Buffer;
          return (await page.evaluate(`(${STATS_FN})('${png.toString('base64')}')`)) as number[];
        };
        const shots: number[][] = [];
        for (const [n, hold] of SIGNAL_SHOT_HOLDS.entries()) shots.push(await shoot(hold, n));
        const beatDiffs: number[] = []; const sameDiffs: number[] = [];
        for (let i = 1; i < shots.length; i += 1) {
          (SIGNAL_SHOT_HOLDS[i] === SIGNAL_SHOT_HOLDS[i - 1] ? sameDiffs : beatDiffs).push(diff(shots[i - 1], shots[i]));
        }
        signals.push(classifySignalResponse(index, planned.domain, beatDiffs, sameDiffs));
      }
    }
    await browser.close(); browser = null;

    await mkdir(outDir, { recursive: true });
    const earlyPath = path.join(outDir, 'hybrid-early.png');
    const latePath = path.join(outDir, 'hybrid-late.png');
    await writeFile(earlyPath, early);
    await writeFile(latePath, late);

    const earlyStats = stats(earlyPx);
    const lateStats = stats(latePx);
    const failures: string[] = [];
    for (const l of layers) {
      if (l.errors.length) failures.push(`layer ${l.index} (${l.domain}, ${l.role}) threw: ${l.errors[0]}`);
      else if (!l.alive) failures.push(`layer ${l.index} (${l.domain}, ${l.role}) drew nothing`);
    }
    for (const c of control ?? []) if (c.target === undefined) failures.push(`control mapping ${c.mapping}: the in-page control loop never wrote its target`);
    const coherence = scoreCoherence(latePx, plan, opts.analyzer);
    if (coherence.score < COHERENCE_FAIL_BELOW) failures.push(`${COHERENCE_CRITERION}: ${coherence.score} (palette fit ${coherence.paletteFit.toFixed(2)}); the layers do not read as one piece`);
    for (const sg of signals) if (sg.status === 'deaf') failures.push(`${COHERENCE_CRITERION}: ${sg.note}`);
    const notes = signals.filter((sg) => sg.status === 'not-measurable').map((sg) => sg.note);
    const blank = (s: FrameStats) => s.spread < 0.004;
    if (blank(earlyStats) && blank(lateStats)) failures.push('the composite is blank in both the early and the late frame');
    return {
      verdict: failures.length ? 'fail' : 'pass',
      ...(failures.length ? { reason: failures.join('; ') } : {}),
      ...(control ? { control } : {}), ...(signals.length ? { signals } : {}), ...(notes.length ? { notes } : {}), coherence, early: earlyStats, late: lateStats, frameChange, framesDiffer: frameChange > 0.002, layers,
      stills: { early: earlyPath, late: latePath },
    };
  } catch (error) {
    if (browser) await browser.close().catch(() => undefined);
    return { verdict: 'unjudged', reason: `headless render unavailable: ${error instanceof Error ? error.message : String(error)}`, layers: [] };
  }
}

export interface HybridArtifacts {
  readonly htmlPath: string;
  readonly manifestPath: string;
  readonly mediumPath: string;
  readonly medium: MediumRecord;
  readonly judgement: HybridJudgement;
}

/** Write composition.html, composition.hybrid.json and medium.json, judging the real page. */
export async function writeHybridArtifacts(
  outDir: string, result: CompositionResult, finalized: HybridFinalized,
  options: { judge?: boolean; retainRejectedDraft?: boolean } = {},
): Promise<HybridArtifacts> {
  await mkdir(outDir, { recursive: true });
  const htmlPath = path.join(outDir, 'composition.html');
  const judgement: HybridJudgement = options.judge === false
    ? { verdict: 'unjudged', reason: 'judging disabled', layers: [] }
    : await judgeHybridExport(outDir, finalized, options.retainRejectedDraft === true);
  const medium = hybridMedium(result, finalized.plan);
  const { plan } = finalized;
  const manifest = {
    schema: 'sinter.hybrid', schemaVersion: '1.0',
    made_with: medium.made_with,
    medium_line: medium.medium_line,
    kind: plan.kind, chosenBy: plan.chosenBy, reason: plan.reason, title: plan.title,
    palette: plan.palette, bpm: plan.bpm,
    layers: plan.layers.map((layer, index) => ({
      index, domain: layer.domain, role: layer.role, why: layer.why,
      blendMode: layer.blendMode, opacity: layer.opacity, maskTarget: layer.maskTarget ?? null,
      codeLength: result.layers[index]?.codeLength ?? 0,
    })),
    signals: plan.signals,
    composition: {
      generation: result.hybridGeneration ?? null,
      sequencerOrder: finalized.build.sequencerOrder,
      masks: finalized.build.masks.map((m) => ({ source: m.source, target: m.target })),
      beatAnimations: finalized.build.animations,
      analyzer: finalized.build.analyzer,
      control: finalized.build.control
        ? { recipeId: finalized.build.control.id, mappings: finalized.build.control.mappings.map((m) => m.id), layers: finalized.build.control.layers.map((l) => l.id) }
        : null,
    },
    judge: judgement,
    files: { html: 'composition.html', medium: 'medium.json', project: 'composition.project.json' },
  };
  const manifestPath = path.join(outDir, HYBRID_MANIFEST);
  const mediumPath = path.join(outDir, 'medium.json');
  await writeFileAtomic(path.join(outDir, 'composition.project.json'), JSON.stringify(finalized.build.project, null, 2) + '\n');
  await writeFileAtomic(mediumPath, JSON.stringify(medium, null, 2) + '\n');
  await writeFileAtomic(htmlPath, finalized.html);
  await writeFileAtomic(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
  return { htmlPath, manifestPath, mediumPath, medium, judgement };
}


async function judgeHybridExport(outDir: string, finalized: HybridFinalized, retainRejectedDraft: boolean): Promise<HybridJudgement> {
  const staging = await mkdtemp(path.join(outDir, '.hybrid-judge-'));
  try {
    const judgement = await judgeHybrid(finalized.html, finalized.plan, staging, {
      analyzer: finalized.build.analyzer, control: finalized.build.control,
    });
    if (judgement.verdict !== 'pass' && !retainRejectedDraft) {
      const bad = judgement.layers.find((layer) => layer.errors.length > 0 || !layer.alive);
      throw bad
        ? new HybridLayerError(`hybrid ${judgement.reason}`, bad.index, bad.domain)
        : new HybridPlanError(`hybrid ${judgement.reason ?? 'failed the render check'}`);
    }
    if (!judgement.stills) return judgement;
    const { early, late } = judgement.stills;
    const stills = { early: path.join(outDir, path.basename(early)), late: path.join(outDir, path.basename(late)) };
    const [earlyBytes, lateBytes] = await Promise.all([readFile(early), readFile(late)]);
    await writeFileAtomic(stills.early, earlyBytes);
    await writeFileAtomic(stills.late, lateBytes);
    return { ...judgement, stills };
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}
