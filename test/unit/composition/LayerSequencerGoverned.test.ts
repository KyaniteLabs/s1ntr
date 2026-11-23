import { describe, it, expect } from 'vitest';
import { LayerSequencer } from '../../../src/composition/LayerSequencer.js';
import { createLayer, type DomainType, type Layer } from '../../../src/composition/types.js';

const make = (domain: DomainType, index: number, code = `// ${domain}`): Layer =>
  ({ ...createLayer(domain, code, 'p', { generator: 'test', model: 'm', validation: { passed: true } }), id: `layer-${index}` });

describe('LayerSequencer.generateLayers with per-layer prompts and a governed generator', () => {
  it('sends each layer its own prompt, in sequencer order, and reports the order', async () => {
    const seen: Array<{ domain: string; prompt: string; index: number; context: number }> = [];
    const result = await new LayerSequencer().generateLayers('shared', ['kinetic', 'glsl'], {
      layerPrompts: ['type prompt', 'glsl prompt'],
      passContext: false,
      generate: async (req) => { seen.push({ domain: req.domain, prompt: req.prompt, index: req.index, context: req.context.length }); return make(req.domain, req.index); },
    });
    expect(result.errors).toEqual([]);
    expect(seen).toEqual([
      { domain: 'glsl', prompt: 'glsl prompt', index: 1, context: 0 },
      { domain: 'kinetic', prompt: 'type prompt', index: 0, context: 1 },
    ]);
    expect(result.generationOrder).toEqual([1, 0]);
  });

  it('falls back to the shared prompt and keeps the old generators-map call working', async () => {
    const prompts: string[] = [];
    const result = await new LayerSequencer().generateLayers('shared', ['p5'], {
      generate: async (req) => { prompts.push(req.prompt); return make('p5', req.index); },
    });
    expect(prompts).toEqual(['shared']);
    expect(result.layers).toHaveLength(1);
    const noGen = await new LayerSequencer().generateLayers('x', ['p5'], {});
    expect(noGen.errors[0].error.message).toContain('No generator registered for domain: p5');
  });

  it('a failing layer stops the run and is named by input index and domain', async () => {
    const result = await new LayerSequencer().generateLayers('s', ['glsl', 'kinetic'], {
      continueOnError: false, rollbackOnError: true,
      generate: async (req) => { if (req.domain === 'kinetic') throw new Error('provider said no'); return make(req.domain, req.index); },
    });
    expect(result.layers).toEqual([]);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toMatchObject({ domain: 'kinetic', index: 1 });
    expect(result.errors[0].error.message).toBe('provider said no');
  });
});
