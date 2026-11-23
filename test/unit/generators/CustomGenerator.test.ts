import { afterEach, describe, expect, it, vi } from 'vitest';

import { CustomGenerator, parseMetaDescriptorFromHtml } from '../../../src/generators/custom/CustomGenerator.js';
import { LLMClient } from '../../../src/llm/LLMClient.js';
import { customConfidence } from '../../../src/generators/registerGenerators.js';

/** Exposes the protected validateOutput for direct contract assertions. */
class TestableCustomGenerator extends CustomGenerator {
  validateForTest(code: string) {
    return this.validateOutput(code);
  }
}

const DESCRIPTOR_OPEN = '<!--SINTER-META-DESCRIPTOR';

// Custom medium #1: a reaction-diffusion ink simulation on a <canvas> (vanilla, no library).
const REACTION_DIFFUSION_PAGE = [
  `${DESCRIPTOR_OPEN} {"name":"reaction-diffusion","runtime":"canvas","libraries":[],"renderTarget":"#stage","notes":"Gray-Scott reaction-diffusion ink bleed on a 2D canvas"} -->`,
  '<!DOCTYPE html>',
  '<html>',
  '<head>',
  '<meta charset="utf-8">',
  '<title>Reaction-Diffusion Ink</title>',
  '</head>',
  '<body>',
  '<canvas id="stage" width="640" height="480"></canvas>',
  '<script>',
  'const ctx = document.getElementById("stage").getContext("2d");',
  'const img = ctx.createImageData(640, 480);',
  'for (let i = 0; i < img.data.length; i += 4) { img.data[i] = (i % 255); img.data[i+3] = 255; }',
  'ctx.putImageData(img, 0, 0);',
  '</script>',
  '</body>',
  '</html>',
].join('\n');

// Custom medium #2: a generative L-system fern drawn with a CDN library (opentype-style URL).
const LSYSTEM_PAGE = [
  `${DESCRIPTOR_OPEN} {"name":"lsystem-fern","runtime":"svg","libraries":["https://cdn.jsdelivr.net/npm/opentype.js@1.3.4"],"renderTarget":"svg","notes":"Barnsley-style L-system fern rendered as SVG paths"} -->`,
  '<!DOCTYPE html>',
  '<html>',
  '<head>',
  '<meta charset="utf-8">',
  '<title>L-System Fern</title>',
  '<script src="https://cdn.jsdelivr.net/npm/opentype.js@1.3.4"></script>',
  '</head>',
  '<body>',
  '<svg width="600" height="600" id="fern"></svg>',
  '<script>',
  'const svg = document.getElementById("fern");',
  'let axiom = "X"; for (let i = 0; i < 3; i++) { axiom = axiom.replace(/X/g, "F+[[X]-X]-F[-FX]+X").replace(/F/g, "FF"); }',
  'const path = document.createElementNS("http://www.w3.org/2000/svg", "path");',
  'path.setAttribute("d", "M300 600 L300 400"); path.setAttribute("stroke", "#2f8");',
  'svg.appendChild(path);',
  '</script>',
  '</body>',
  '</html>',
].join('\n');

describe('CustomGenerator validation contract', () => {
  it('accepts a vanilla canvas custom medium with an empty libraries descriptor', () => {
    const gen = new TestableCustomGenerator();
    const result = gen.validateForTest(REACTION_DIFFUSION_PAGE);

    expect(result.valid).toBe(true);
    expect(result.descriptor).toEqual({
      name: 'reaction-diffusion',
      runtime: 'canvas',
      libraries: [],
      renderTarget: '#stage',
      notes: 'Gray-Scott reaction-diffusion ink bleed on a 2D canvas',
    });
  });

  it('accepts a CDN-library custom medium and surfaces the declared library', () => {
    const gen = new TestableCustomGenerator();
    const result = gen.validateForTest(LSYSTEM_PAGE);

    expect(result.valid).toBe(true);
    expect(result.descriptor?.name).toBe('lsystem-fern');
    expect(result.descriptor?.libraries).toEqual(['https://cdn.jsdelivr.net/npm/opentype.js@1.3.4']);
  });

  it('rejects output with no SINTER-META-DESCRIPTOR comment', () => {
    const gen = new TestableCustomGenerator();
    const page = '<!DOCTYPE html><html><head><meta charset="utf-8"><title>No descriptor</title></head><body><canvas></canvas><script>const x=1;</script></body></html>';
    const result = gen.validateForTest(page);

    expect(result.valid).toBe(false);
    expect(result.error).toBe('custom output is missing a parseable SINTER-META-DESCRIPTOR comment');
  });

  it('rejects a page that declares a CDN library it never loads', () => {
    const gen = new TestableCustomGenerator();
    const page = [
      `${DESCRIPTOR_OPEN} {"name":"webgl-fluid","runtime":"webgl","libraries":["https://cdn.jsdelivr.net/npm/regl@2.1.0"],"renderTarget":"canvas","notes":"WebGL fluid sim"} -->`,
      '<!DOCTYPE html><html><head><meta charset="utf-8"><title>Fluid</title></head>',
      '<body><canvas id="c"></canvas>',
      '<script>const gl = document.getElementById("c").getContext("webgl");</script>',
      '</body></html>',
    ].join('');
    const result = gen.validateForTest(page);

    expect(result.valid).toBe(false);
    expect(result.error).toBe('custom descriptor declares library "https://cdn.jsdelivr.net/npm/regl@2.1.0" but the page never loads it via a script/link tag');
  });

  it('rejects a descriptor-bearing page that has no render mount', () => {
    const gen = new TestableCustomGenerator();
    const page = [
      `${DESCRIPTOR_OPEN} {"name":"no-mount","runtime":"dom","libraries":[],"renderTarget":"#stage","notes":"missing mount"} -->`,
      '<!DOCTYPE html><html><head><meta charset="utf-8"><title>No mount</title></head>',
      '<body><p>just text, nothing to render into</p></body></html>',
    ].join('');
    const result = gen.validateForTest(page);

    expect(result.valid).toBe(false);
    expect(result.error).toBe('custom output has no <canvas>, <svg>, WebGL, or mount element to render into');
  });

  it('rejects non-HTML output (not a document)', () => {
    const gen = new TestableCustomGenerator();
    const result = gen.validateForTest('Here is an idea for a custom medium but no actual HTML.');

    expect(result.valid).toBe(false);
    expect(result.error).toBe('Generated custom output is not a valid HTML document');
  });

  it('parses the descriptor from a finished artifact via the exported helper', () => {
    const descriptor = parseMetaDescriptorFromHtml(LSYSTEM_PAGE);
    expect(descriptor).toEqual({
      name: 'lsystem-fern',
      runtime: 'svg',
      libraries: ['https://cdn.jsdelivr.net/npm/opentype.js@1.3.4'],
      renderTarget: 'svg',
      notes: 'Barnsley-style L-system fern rendered as SVG paths',
    });
  });
});

describe('CustomGenerator behavior (two distinct custom mediums)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.LIMINAL_LLM_BASE_URL;
  });

  it('returns a validated reaction-diffusion canvas artifact and exposes its descriptor', async () => {
    process.env.LIMINAL_LLM_BASE_URL = 'http://localhost:1234/v1';
    const llm = new LLMClient({ baseUrl: 'http://localhost:1234/v1', model: 'meta-test-model' });
    const complete = vi.spyOn(llm, 'complete').mockResolvedValue({ text: REACTION_DIFFUSION_PAGE, success: true });
    const toolLoop = vi.spyOn(llm, 'generateWithToolLoop').mockResolvedValue({
      content: '',
      iterations: 1,
      toolCallsMade: 0,
      success: false,
    });

    const gen = new CustomGenerator(llm);
    const html = await gen.generate('a reaction-diffusion ink simulation on a canvas');

    expect(toolLoop).not.toHaveBeenCalled();
    expect(complete).toHaveBeenCalledOnce();
    expect(complete.mock.calls[0]?.[0].maxTokens).toBe(12000);
    expect(complete.mock.calls[0]?.[0].signal).toBeInstanceOf(AbortSignal);
    expect(html).toContain('<canvas');
    expect(html).toContain('</html>');
    expect(gen.getLastDescriptor()).toEqual({
      name: 'reaction-diffusion',
      runtime: 'canvas',
      libraries: [],
      renderTarget: '#stage',
      notes: 'Gray-Scott reaction-diffusion ink bleed on a 2D canvas',
    });
  });

  it('returns a validated L-system fern artifact for a different custom medium', async () => {
    process.env.LIMINAL_LLM_BASE_URL = 'http://localhost:1234/v1';
    const llm = new LLMClient({ baseUrl: 'http://localhost:1234/v1', model: 'meta-test-model' });
    vi.spyOn(llm, 'complete').mockResolvedValue({ text: LSYSTEM_PAGE, success: true });
    vi.spyOn(llm, 'generateWithToolLoop').mockResolvedValue({ content: '', iterations: 1, toolCallsMade: 0, success: false });

    const gen = new CustomGenerator(llm);
    const html = await gen.generate('an L-system fern in svg');

    expect(html).toContain('<svg');
    expect(html).toContain('opentype.js@1.3.4');
    expect(gen.getLastDescriptor()?.runtime).toBe('svg');
  });

  it('strips a ```html fence the provider wraps around the descriptor + page', async () => {
    process.env.LIMINAL_LLM_BASE_URL = 'http://localhost:1234/v1';
    const llm = new LLMClient({ baseUrl: 'http://localhost:1234/v1', model: 'meta-test-model' });
    vi.spyOn(llm, 'complete').mockResolvedValue({
      text: '```html\n' + REACTION_DIFFUSION_PAGE + '\n```',
      success: true,
    });
    vi.spyOn(llm, 'generateWithToolLoop').mockResolvedValue({ content: '', iterations: 1, toolCallsMade: 0, success: false });

    const gen = new CustomGenerator(llm);
    const html = await gen.generate('reaction-diffusion ink');

    expect(html).not.toMatch(/```/);
    expect(html).toContain(DESCRIPTOR_OPEN);
    expect(html).toContain('<canvas');
  });

  it('retries with a tighter prompt when the first response is not a valid custom artifact', async () => {
    process.env.LIMINAL_LLM_BASE_URL = 'http://localhost:1234/v1';
    const llm = new LLMClient({ baseUrl: 'http://localhost:1234/v1', model: 'meta-test-model' });
    const complete = vi.spyOn(llm, 'complete')
      .mockResolvedValueOnce({ text: '<!DOCTYPE html><html><head></head><body><p>I will invent a medium.</p></body></html>', success: true })
      .mockResolvedValueOnce({ text: REACTION_DIFFUSION_PAGE, success: true });
    vi.spyOn(llm, 'generateWithToolLoop').mockResolvedValue({ content: '', iterations: 1, toolCallsMade: 0, success: false });

    const gen = new CustomGenerator(llm);
    const html = await gen.generate('a custom medium where ink diffuses');

    expect(complete).toHaveBeenCalledTimes(2);
    expect(complete.mock.calls[1]?.[0].prompt).toContain('did not return a valid self-contained custom-medium artifact');
    expect(html).toContain('reaction-diffusion');
  });

  it('fails clearly when bounded attempts never return a valid custom artifact', async () => {
    process.env.LIMINAL_LLM_BASE_URL = 'http://localhost:1234/v1';
    const llm = new LLMClient({ baseUrl: 'http://localhost:1234/v1', model: 'meta-test-model' });
    const complete = vi.spyOn(llm, 'complete').mockResolvedValue({ text: '', success: true, error: 'empty response' });
    vi.spyOn(llm, 'generateWithToolLoop').mockResolvedValue({ content: '', iterations: 1, toolCallsMade: 0, success: false });

    const gen = new CustomGenerator(llm);

    await expect(gen.generate('an arbitrary medium with no fixed domain')).rejects.toThrow(
      'CustomGenerator: provider did not return a valid custom-medium artifact within bounded attempts',
    );
    expect(complete).toHaveBeenCalledTimes(2);
  });
});

describe('customConfidence routing (explicit-only, never the default)', () => {
  it('fires high only on the forced --domain custom injection', () => {
    expect(customConfidence('Target creative domain: custom. invent something')).toBe(0.99);
  });

  it('fires on explicit custom/arbitrary-medium keywords', () => {
    expect(customConfidence('invent a medium where pixels rot over time')).toBe(0.95);
    expect(customConfidence('a custom domain for generative blackletter calligraphy')).toBe(0.95);
    expect(customConfidence('make up a new visual technique')).toBe(0.95);
    expect(customConfidence('render this in any medium you like')).toBe(0.95);
  });

  it('returns 0 for normal prompts so real domains are never hijacked', () => {
    // These must route to three/p5/dataviz/etc., NOT custom.
    expect(customConfidence('a spinning cube')).toBe(0);
    expect(customConfidence('a bar chart of monthly rainfall')).toBe(0);
    expect(customConfidence('a p5 flow field of particles')).toBe(0);
    expect(customConfidence('a fragment shader with noise')).toBe(0);
    expect(customConfidence('make it cooler')).toBe(0);
  });
});
