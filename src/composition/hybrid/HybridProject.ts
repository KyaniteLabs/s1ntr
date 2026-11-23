/**
 * Hybrid project: the hybrid path's use of the composition organs.
 *
 *  - CompositionEngine + LayerManager hold the layers (one Layer per planned layer);
 *  - registerAllAdapters supplies per-domain validation (a bad layer fails loudly, by name);
 *  - LayerMaskManager writes the CSS mask for every mask layer (generateCSSMask);
 *  - LayerManager.createAnimation + KeyframeAnimation.generateCSS write the beat grid
 *    (one loop per beat at plan.bpm, on the target layer's scale or opacity);
 *  - LayerSequencer.orderDomains gives the planned generation order recorded in the manifest;
 *  - ProjectSerializer exports and validates composition.project.json;
 *  - CompositionAnalyzer cross-checks the planner's domains against the prompt's keywords.
 * LayerSequencer.generateLayers makes the layers before this runs (HybridGeneration.ts).
 * CompositionControlRuntime rehearses the beat recipe at build time (HybridControl.ts); the page runs its embedded twin.
 */
import type { ControlRecipe } from '../ControlRecipe.js';
import { buildHybridControlRecipe, validateHybridControlRecipe } from './HybridControl.js';
import type { CompositionResult, ComposedLayer } from '../CompositionOrchestrator.js';
import { CompositionEngine } from '../CompositionEngine.js';
import { registerAllAdapters } from '../adapters/registerAdapters.js';
import { LayerSequencer } from '../LayerSequencer.js';
import { ProjectSerializer } from '../ProjectSerializer.js';
import { CompositionAnalyzer, DOMAIN_RENDER_ORDER } from '../CompositionAnalyzer.js';
import { KeyframeAnimation } from '../KeyframeAnimation.js';
import type { DomainType, Layer, SinterProject } from '../types.js';
import type { HybridPlan } from './HybridPlan.js';

/** Domains whose adapter validates the raw layer code (html/ascii adapters judge fragments, not full pages). */
const ADAPTER_VALIDATED = new Set<string>(['p5', 'three', 'shader', 'hydra', 'tone', 'strudel']);

export class HybridAdapterError extends Error {
  constructor(message: string, readonly layerIndex: number, readonly domain: string) {
    super(message);
    this.name = 'HybridAdapterError';
  }
}

export interface HybridProjectBuild {
  readonly project: SinterProject;
  /** CSS for the masks (LayerMaskManager) and the beat grid (KeyframeAnimation), ready to put in a <style>. */
  readonly css: string;
  /** layer index -> class names to add to its iframe. */
  readonly classes: ReadonlyMap<number, readonly string[]>;
  /** layer index -> mask data URI the stage binds to --mask-source on the target. */
  readonly sequencerOrder: readonly string[];
  readonly analyzer: { readonly keywordDomains: readonly string[]; readonly agreeing: readonly string[]; readonly renderOrder: readonly string[] };
  /** Control recipe for the beat signals (undefined when the plan has none); the page runs it. */
  readonly control?: ControlRecipe;
  readonly masks: ReadonlyArray<{ readonly source: number; readonly target: number; readonly cssRule: string }>;
  readonly animations: ReadonlyArray<{ readonly layer: number; readonly param: string; readonly className: string }>;
}

export function layerId(index: number): string { return `layer-${index}`; }

export function buildHybridProject(
  plan: HybridPlan, result: CompositionResult, prompt: string,
  maskUri: (index: number) => string,
): HybridProjectBuild {
  const engine = new CompositionEngine();
  registerAllAdapters(engine);
  plan.layers.forEach((planned, index) => {
    const composed: ComposedLayer | undefined = result.layers[index];
    const layer: Layer = {
      id: layerId(index),
      type: planned.domain as DomainType,
      code: composed?.artifactHtml ?? '',
      config: {
        zIndex: index, blendMode: planned.blendMode, opacity: planned.opacity,
        position: { x: 0, y: 0 }, scale: 1, role: planned.role === 'mask' || planned.role === 'background' || planned.role === 'overlay' ? planned.role : 'standalone',
        transparentBackground: planned.role !== 'background',
      },
      metadata: {
        prompt: planned.prompt, model: 'hybrid-plan', generatedAt: new Date().toISOString(),
        validation: { passed: true },
      } as Layer['metadata'],
      enabled: true, locked: false,
    };
    if (ADAPTER_VALIDATED.has(planned.domain)) {
      const verdict = engine.getAdapter(planned.domain as DomainType)?.validate?.(layer);
      if (verdict && !verdict.valid) {
        throw new HybridAdapterError(
          `layer ${index} (${planned.domain}, ${planned.role}) failed its adapter check: ${(verdict.errors ?? []).join('; ')}`,
          index, planned.domain);
      }
    }
    engine.addLayer(layer);
  });

  const cssParts: string[] = [];
  const classes = new Map<number, string[]>();
  const masks: Array<{ source: number; target: number; cssRule: string }> = [];
  const animations: Array<{ layer: number; param: string; className: string }> = [];
  const maskManager = engine.getMaskManager();
  plan.layers.forEach((planned, index) => {
    if (planned.role !== 'mask' || planned.maskTarget === undefined) return;
    const mask = maskManager.createMask(layerId(index), layerId(planned.maskTarget), 'luminance');
    const rule = `iframe.sinter-layer[data-layer-index="${planned.maskTarget}"] {\n  --mask-source: url("${maskUri(index)}");\n  ${maskManager.generateCSSMask(mask)}\n  mask-size: 100% 100%;\n  -webkit-mask-size: 100% 100%;\n  mask-repeat: no-repeat;\n}\niframe.sinter-layer[data-layer-index="${index}"] { display: none; }`;
    cssParts.push(rule);
    masks.push({ source: index, target: planned.maskTarget, cssRule: rule });
  });

  const layerManager = engine.getLayerManager();
  const keyframes = new KeyframeAnimation();
  if (plan.bpm) {
    const beatMs = Math.round(60000 / plan.bpm);
    for (const signal of plan.signals.filter((s) => s.kind === 'beat')) {
      const target = plan.layers[signal.to];
      const base = target?.opacity ?? 1;
      const depth = signal.depth;
      const frames = signal.param === 'scale'
        ? [{ time: 0, properties: { scale: Number((1 + 0.08 * depth).toFixed(4)) } }, { time: 1, properties: { scale: 1 } }]
        : [{ time: 0, properties: { opacity: base } }, { time: 1, properties: { opacity: Number(Math.max(0, base * (1 - 0.5 * depth)).toFixed(4)) } }];
      const animation = layerManager.createAnimation(layerId(signal.to), beatMs, frames, { loop: true, autoplay: true });
      if (!animation) continue;
      const className = `sinter-${animation.id}`;
      cssParts.push(keyframes.generateCSS(animation));
      classes.set(signal.to, [...(classes.get(signal.to) ?? []), className]);
      animations.push({ layer: signal.to, param: signal.param, className });
    }
  }

  const rawControl = buildHybridControlRecipe(plan);
  const control = rawControl ? validateHybridControlRecipe(rawControl) : undefined;

  const sequencer = new LayerSequencer();
  const sequencerOrder = sequencer.orderDomains(plan.layers.map((l) => l.domain as DomainType));
  const keywordDomains = [...new Set(new CompositionAnalyzer({ useLLM: false }).analyzeWithKeywords(prompt).map((r) => r.domain as string))];
  const planned = new Set(plan.layers.map((l) => l.domain as string));

  const project = new ProjectSerializer().exportProject(engine, { animations: engine.getAnimations() });
  project.composition.metadata.name = plan.title;
  const valid = new ProjectSerializer().validateProject(project);
  if (!valid.valid) throw new Error(`hybrid project failed validation: ${(valid.errors ?? []).join(', ')}`);

  return {
    project, css: cssParts.join('\n'), classes, sequencerOrder, masks, animations,
    ...(control ? { control } : {}),
    analyzer: {
      keywordDomains, agreeing: keywordDomains.filter((d) => planned.has(d)),
      renderOrder: DOMAIN_RENDER_ORDER.filter((d) => planned.has(d as string)),
    },
  };
}
