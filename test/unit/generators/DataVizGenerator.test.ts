import { afterEach, describe, expect, it, vi } from 'vitest';

import { DataVizGenerator } from '../../../src/generators/dataviz/DataVizGenerator.js';
import { LLMClient } from '../../../src/llm/LLMClient.js';

/** Exposes the protected validateOutput for direct contract assertions. */
class TestableDataVizGenerator extends DataVizGenerator {
  validateForTest(code: string) {
    return this.validateOutput(code);
  }
}

const D3_PAGE = [
  '<!DOCTYPE html>',
  '<html>',
  '<head>',
  '<meta charset="utf-8">',
  '<title>Monthly Rainfall</title>',
  '<script src="/vendor/d3/7.9.0/d3.min.js"></script>',
  '</head>',
  '<body>',
  '<svg width="640" height="400"></svg>',
  '<script>',
  'const data = [{m:"Jan",mm:42},{m:"Feb",mm:55},{m:"Mar",mm:30}];',
  'const svg = d3.select("svg");',
  'const x = d3.scaleBand().domain(data.map(d=>d.m)).range([0,640]).padding(0.1);',
  'const y = d3.scaleLinear().domain([0, d3.max(data,d=>d.mm)]).range([400,0]);',
  'svg.selectAll("rect").data(data).join("rect")',
  '  .attr("x",d=>x(d.m)).attr("y",d=>y(d.mm))',
  '  .attr("width",x.bandwidth()).attr("height",d=>400-y(d.mm)).attr("fill","#22d3ee");',
  '</script>',
  '</body>',
  '</html>',
].join('\n');

describe('DataVizGenerator validation contract', () => {
  it('accepts a complete D3 page that loads d3 and has an svg mount', () => {
    const gen = new TestableDataVizGenerator();
    const result = gen.validateForTest(D3_PAGE);

    expect(result.valid).toBe(true);
  });

  it('rejects an HTML page that has no D3 reference', () => {
    const gen = new TestableDataVizGenerator();
    const page = '<!DOCTYPE html><html><head><meta charset="utf-8"><title>No D3</title></head><body><svg></svg><script>const x=1;</script></body></html>';
    const result = gen.validateForTest(page);

    expect(result.valid).toBe(false);
    expect(result.error).toBe('dataviz output does not load D3.js or use the d3 global');
  });

  it('rejects a D3 page that has no svg/canvas mount', () => {
    const gen = new TestableDataVizGenerator();
    const page = [
      '<!DOCTYPE html><html><head><meta charset="utf-8"><title>No mount</title>',
      '<script src="/vendor/d3/7.9.0/d3.min.js"></script>',
      '</head><body><div id="chart"></div>',
      '<script>const sel = d3.select("#chart"); sel.text("no mount");</script>',
      '</body></html>',
    ].join('');
    const result = gen.validateForTest(page);

    expect(result.valid).toBe(false);
    expect(result.error).toBe('dataviz output has no <svg> or <canvas> visualization mount');
  });

  it('accepts a canvas-mounted D3 page (dense visualizations)', () => {
    const gen = new TestableDataVizGenerator();
    const page = [
      '<!DOCTYPE html><html><head><meta charset="utf-8"><title>Density</title>',
      '<script src="/vendor/d3/7.9.0/d3.min.js"></script>',
      '</head><body><canvas width="640" height="400"></canvas>',
      '<script>const r = d3.range(100); const ctx = document.querySelector("canvas").getContext("2d"); r.forEach(i=>ctx.fillRect(i*6,0,4,400));</script>',
      '</body></html>',
    ].join('');
    const result = gen.validateForTest(page);

    expect(result.valid).toBe(true);
  });

  it('rejects non-HTML output (not a document)', () => {
    const gen = new TestableDataVizGenerator();
    const result = gen.validateForTest('Here is a chart idea but no actual HTML.');

    expect(result.valid).toBe(false);
    expect(result.error).toBe('Generated dataviz output is not a valid HTML document');
  });
});

describe('DataVizGenerator behavior', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.LIMINAL_LLM_BASE_URL;
  });

  it('returns a validated D3 page from the provider on the first attempt', async () => {
    process.env.LIMINAL_LLM_BASE_URL = 'http://localhost:1234/v1';
    const llm = new LLMClient({ baseUrl: 'http://localhost:1234/v1', model: 'dataviz-test-model' });
    const complete = vi.spyOn(llm, 'complete').mockResolvedValue({ text: D3_PAGE, success: true });
    const toolLoop = vi.spyOn(llm, 'generateWithToolLoop').mockResolvedValue({
      content: '',
      iterations: 1,
      toolCallsMade: 0,
      success: false,
    });

    const gen = new DataVizGenerator(llm);
    const html = await gen.generate('an animated bar chart of monthly rainfall');

    expect(toolLoop).not.toHaveBeenCalled();
    expect(complete).toHaveBeenCalledOnce();
    expect(complete.mock.calls[0]?.[0].maxTokens).toBe(4000);
    expect(complete.mock.calls[0]?.[0].signal).toBeInstanceOf(AbortSignal);
    expect(complete.mock.calls[0]?.[0].prompt).toContain('/vendor/d3/7.9.0/d3.min.js'); // vendored (#924)
    expect(html).toContain('<svg');
    expect(html).toContain('d3.scaleBand');
    expect(html).toContain('</html>');
  });

  it('strips a ```html fence the provider wraps around the page', async () => {
    process.env.LIMINAL_LLM_BASE_URL = 'http://localhost:1234/v1';
    const llm = new LLMClient({ baseUrl: 'http://localhost:1234/v1', model: 'dataviz-test-model' });
    const complete = vi.spyOn(llm, 'complete').mockResolvedValue({
      text: '```html\n' + D3_PAGE + '\n```',
      success: true,
    });
    vi.spyOn(llm, 'generateWithToolLoop').mockResolvedValue({ content: '', iterations: 1, toolCallsMade: 0, success: false });

    const gen = new DataVizGenerator(llm);
    const html = await gen.generate('bar chart of rainfall');

    expect(html).not.toMatch(/^```/);
    expect(html.startsWith('<!DOCTYPE html>')).toBe(true);
    expect(html).toContain('/vendor/d3/7.9.0/d3.min.js'); // vendored (#924)
  });

  it('retries with a tighter prompt when the first response is not valid dataviz', async () => {
    process.env.LIMINAL_LLM_BASE_URL = 'http://localhost:1234/v1';
    const llm = new LLMClient({ baseUrl: 'http://localhost:1234/v1', model: 'dataviz-test-model' });
    const complete = vi.spyOn(llm, 'complete')
      .mockResolvedValueOnce({ text: '<!DOCTYPE html><html><head></head><body><p>I will draw a chart.</p></body></html>', success: true })
      .mockResolvedValueOnce({ text: D3_PAGE, success: true });
    vi.spyOn(llm, 'generateWithToolLoop').mockResolvedValue({ content: '', iterations: 1, toolCallsMade: 0, success: false });

    const gen = new DataVizGenerator(llm);
    const html = await gen.generate('scatter plot of two variables');

    expect(complete).toHaveBeenCalledTimes(2);
    expect(complete.mock.calls[1]?.[0].prompt).toContain('did not return a valid self-contained D3 visualization');
    expect(html).toContain('d3.scaleLinear');
  });

  it('fails clearly when bounded attempts never return a valid D3 page', async () => {
    process.env.LIMINAL_LLM_BASE_URL = 'http://localhost:1234/v1';
    const llm = new LLMClient({ baseUrl: 'http://localhost:1234/v1', model: 'dataviz-test-model' });
    const complete = vi.spyOn(llm, 'complete').mockResolvedValue({ text: '', success: true, error: 'empty response' });
    vi.spyOn(llm, 'generateWithToolLoop').mockResolvedValue({ content: '', iterations: 1, toolCallsMade: 0, success: false });

    const gen = new DataVizGenerator(llm);

    await expect(gen.generate('a network graph of dependencies')).rejects.toThrow(
      'DataVizGenerator: provider did not return a valid D3 visualization within bounded attempts',
    );
    expect(complete).toHaveBeenCalledTimes(2);
  });
});
