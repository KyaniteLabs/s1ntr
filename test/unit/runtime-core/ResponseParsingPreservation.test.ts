/**
 * Sol audit G03: shared response parsing destroyed intended output (indentation, literal `ANALYSIS:`/`Libraries:` lines
 * in text media) and read the library declaration from the sanitized body instead of the reply that produced the source.
 */
import { describe, expect, it, vi } from 'vitest';
import { createLiminalProductionEffects } from '../../../src/runtime-core/LiminalProductionEffects.js';
import { sanitizeOutputWithReasoning } from '../../../src/llm/LLMClient.js';
import { stripModelScaffolding } from '../../../src/runtime-core/LiminalProductionEffects.js';

function effectsFor(generate: ReturnType<typeof vi.fn>) {
  return createLiminalProductionEffects({
    generator: { getConfig: () => ({ provider: 'fake', model: 'generator' }), generate } as never,
    evaluator: {} as never, renderer: {} as never,
    generatorIdentity: 'fake/generator', evaluatorIdentity: 'fake/evaluator', rendererIdentity: 'fake/renderer',
  });
}
const gen = (domain: string, prompt = 'a piece') => ({ identity: 'fake/generator', domain, prompt,
  startTransport: vi.fn(async () => 1), failTransport: vi.fn(async () => {}) }) as never;

describe('G03 text media survives the shared parser byte for byte', () => {
  it('keeps the first line indentation (unfenced and fenced)', () => {
    const art = '      .-.\n     (o.o)\n      |=|';
    expect(sanitizeOutputWithReasoning(art).sanitized.code).toBe(art);
    expect(sanitizeOutputWithReasoning('```text\n' + art + '\n```').sanitized.code).toBe(art);
  });

  it('keeps interior ANALYSIS:/Libraries: lines of a textgen piece and drops only a trailing declaration', () => {
    const poem = 'ANALYSIS: of a small sea\n  the tide keeps its own books\nLibraries: where the quiet is shelved\nVERDICT - salt';
    expect(stripModelScaffolding(poem, true)).toBe(poem);
    expect(stripModelScaffolding(poem + '\nlibraries: culori', true).trimEnd()).toBe(poem);
  });

  it('end to end through the effects: saved textgen bytes equal the model reply', async () => {
    const poem = '\n    ANALYSIS: of a small sea\n  the tide keeps its own books and lends them back at dawn\nLibraries: where the quiet is shelved beside the lamps\n  and nobody returns the salt to the water again\n';
    const generate = vi.fn(async () => ({ success: true, code: poem }));
    const artifact = await effectsFor(generate).generate(gen('textgen'));
    expect(artifact.source).toContain('    ANALYSIS: of a small sea');
    expect(artifact.source).toContain('Libraries: where the quiet is shelved');
  });

  it('code domains still strip real scaffolding lines (no regression)', () => {
    expect(stripModelScaffolding('ANALYSIS: it breaks\nconst x = 1;\nlibraries: culori')).toBe('const x = 1;\n');
  });
});

describe('G03 the declaration comes from the reply that produced the accepted source', () => {
  const sketch = (fill: number) => `function setup() {\n  createCanvas(400, 400);\n}\nfunction draw() {\n  background(0);\n  fill(${fill});\n  ellipse(200, 200, 50, 50);\n}`;
  const libs = (artifact: { provenance: string }) => JSON.stringify(JSON.parse(artifact.provenance));

  it('a declaration after a closed code fence is honored (it is outside the sanitized body)', async () => {
    const reply = '```js\n' + sketch(1) + '\n```\n\nlibraries: culori';
    const generate = vi.fn(async () => ({ success: true, code: sketch(1), explanation: reply }));
    const artifact = await effectsFor(generate).generate(gen('p5'));
    expect(libs(artifact)).toContain('culori');
    expect(artifact.playable).toMatch(/culori/);
  });

  it('a repair that declares a different library wins over the first reply declaration', async () => {
    const broken = '```js\nfunction setup() { createCanvas(400, 400) \n```\n\nlibraries: culori';
    const fixed = '```js\n' + sketch(2) + '\n```\n\nlibraries: roughjs';
    const generate = vi.fn()
      .mockResolvedValueOnce({ success: true, code: 'function setup() { createCanvas(400, 400) ', explanation: broken })
      .mockResolvedValueOnce({ success: true, code: sketch(2), explanation: fixed });
    const artifact = await effectsFor(generate).generate(gen('p5'));
    expect(JSON.parse(artifact.provenance).acceptedFrom).toBe('repair');
    expect(libs(artifact)).toContain('roughjs');
    expect(libs(artifact)).not.toContain('culori');
  });
});
