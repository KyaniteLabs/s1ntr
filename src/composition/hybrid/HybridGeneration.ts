/**
 * Layered generation: the layered build's use of LayerSequencer.generateLayers.
 *
 * Each planned layer is generated with its OWN prompt (the shared contract included), one after
 * another in the sequencer's order, through CompositionOrchestrator.generateGovernedLayer: the same
 * generator registry, provider-call ledger and seam guard compose() uses. The generated code then
 * goes back into compose() as pre-existing layer code, so assembly, vendor inlining, the render
 * gate and the thesis embed stay on the one governed path. A layer that fails stops the piece and
 * is named by index and domain.
 */
import { CompositionOrchestrator, type CompositionGenerationContext, type CompositionSpec, type GeneratedLayerResult } from '../CompositionOrchestrator.js';
import { LayerSequencer } from '../LayerSequencer.js';
import { createLayer, type DomainType, type Layer } from '../types.js';
import type { CreativeThesis } from '../../creative-intelligence/CreativeIntelligence.js';
import { HybridLayerError } from './HybridComposition.js';
import type { HybridPlan } from './HybridPlan.js';

export interface HybridGenerationEvidence {
  readonly via: 'LayerSequencer.generateLayers';
  /** Plan indices in the order the sequencer generated them. */
  readonly order: readonly number[];
  /** Layers whose own prompt (not one shared prompt) was sent. */
  readonly perLayerPrompts: number;
  /** Plan indices whose opaque background the seam guard turned into a screen blend. */
  readonly seamGuarded: readonly number[];
}

export interface HybridGenerated {
  /** The spec with every layer's code (and any seam-guarded blend) filled in, ready for compose(). */
  readonly spec: CompositionSpec;
  readonly evidence: HybridGenerationEvidence;
}

export async function generateHybridLayers(
  plan: HybridPlan, spec: CompositionSpec,
  context: { creativeThesis?: CreativeThesis; generationContext?: CompositionGenerationContext; signal?: AbortSignal },
): Promise<HybridGenerated> {
  const results = new Map<number, GeneratedLayerResult>();
  const sequencer = new LayerSequencer();
  const outcome = await sequencer.generateLayers(
    spec.title ?? plan.title,
    spec.layers.map((l) => l.domain),
    {
      layerPrompts: spec.layers.map((l) => l.prompt),
      passContext: false,
      continueOnError: false,
      rollbackOnError: true,
      signal: context.signal,
      generate: async ({ index, signal }): Promise<Layer> => {
        const layerSpec = spec.layers[index];
        const generated = await CompositionOrchestrator.generateGovernedLayer(layerSpec, index, {
          layers: spec.layers, background: spec.background,
          creativeThesis: context.creativeThesis, generationContext: context.generationContext, signal,
        });
        if (!generated.generated) throw new Error(generated.error ?? 'no code produced');
        results.set(index, generated);
        return {
          ...createLayer(layerSpec.domain as DomainType, generated.code, layerSpec.prompt,
            { generator: 'CompositionOrchestrator.generateGovernedLayer', model: 'governed', validation: { passed: true } },
            { blendMode: generated.spec.blendMode ?? 'normal', opacity: generated.spec.opacity ?? 1 }),
          id: `layer-${index}`,
        };
      },
    },
  );
  const failure = outcome.errors[0];
  if (failure) {
    const index = failure.index ?? 0;
    const planned = plan.layers[index];
    throw new HybridLayerError(
      `hybrid layer ${index} (${planned?.domain ?? failure.domain}, ${planned?.role ?? 'layer'}) failed: ${failure.error.message}`,
      index, planned?.domain ?? failure.domain);
  }
  const layers = spec.layers.map((layerSpec, index) => {
    const generated = results.get(index);
    if (!generated) throw new HybridLayerError(`hybrid layer ${index} (${layerSpec.domain}) was never generated`, index, layerSpec.domain);
    return { ...layerSpec, code: generated.code, blendMode: generated.spec.blendMode ?? layerSpec.blendMode };
  });
  return {
    spec: { ...spec, layers },
    evidence: {
      via: 'LayerSequencer.generateLayers',
      order: outcome.generationOrder ?? [],
      perLayerPrompts: spec.layers.length,
      seamGuarded: [...results.entries()].filter(([, r]) => r.seamGuarded).map(([i]) => i).sort((a, b) => a - b),
    },
  };
}
