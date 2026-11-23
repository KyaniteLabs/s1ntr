import { describe, it, expect, vi } from 'vitest';
import { createLiminalProductionEffects } from '../../../src/runtime-core/LiminalProductionEffects.js';

/** The facts LFM3 got wrong in the v16 bench (tone, strudel, d3, GLSL ES 1.0, revideo imports) must reach the generator's system prompt. */
describe('domain prompt contracts carry the API facts the model got wrong', () => {
  const systemPromptFor = async (domain: string): Promise<string> => {
    const generate = vi.fn(async () => ({ success: true, code: 'x' }));
    const effects = createLiminalProductionEffects({
      generator: { getConfig: () => ({ provider: 'fake', model: 'generator' }), generate } as never,
      evaluator: {} as never, renderer: {} as never,
      generatorIdentity: 'fake/generator', evaluatorIdentity: 'fake/evaluator', rendererIdentity: 'fake/renderer',
    });
    await effects.generate({ identity: 'fake/generator', domain, prompt: 'x',
      startTransport: vi.fn(async () => 1), failTransport: vi.fn(async () => {}) }).catch(() => {});
    return String((generate.mock.calls[0] as unknown[])[0]);
  };

  it.each([
    ['tone', /Tone\.Transport is a ready-made singleton/],
    ['strudel', /pattern language, not p5/],
    ['dataviz', /d3 has no d3\.random\(\)/],
    ['glsl', /GLSL ES 1\.0.*loop bounds must be constants/s],
    ['shader', /GLSL ES 1\.0.*loop bounds must be constants/s],
  ])('%s', async (domain, fact) => {
    expect(await systemPromptFor(domain)).toMatch(fact);
  });
});
