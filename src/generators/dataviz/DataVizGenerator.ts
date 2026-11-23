/**
 * DataVizGenerator - Generates self-contained D3.js v7 data visualizations via LLM
 *
 * Emits a complete single-file HTML page that loads D3.js v7 from CDN, embeds
 * inline sample data, and renders a data-driven visualization (bar/line/scatter/
 * network/etc.) into an <svg> or <canvas> mount. The output is HTML, so it shares
 * the html render/preview path (HTMLWrapper passes complete pages through).
 *
 * Mirrors HTMLWebGenerator: a bounded direct retry loop calling llm.complete()
 * (no generic tool loop), with validation that the page is real HTML, references
 * D3, and contains an svg/canvas mount. Mirrors SVGGenerator's validation style
 * (reject silently-invalid output rather than fabricating a passing artifact).
 */

import { TierBasedGenerator, type TierBasedGeneratorOptions } from '../TierBasedGenerator.js';
import { HTMLValidator } from '../../core/validators/HTMLValidator.js';
import { GenerationError } from '../../errors/GenerationError.js';
import { htmlBlock, splitThinking } from '../../llm/ModelOutput.js';

export interface DataVizGeneratorOptions extends TierBasedGeneratorOptions {
  title?: string;
}

// D3 visualizations carry inline data + scales + axes + the chart body, so they
// need more room than a bare HTML page to finish in one response. Two bounded
// attempts match HTMLWebGenerator's shape (primary + a tighter retry). The
// per-attempt timeout matches the SVG generator's primary (120s) because D3
// pages are similarly token-dense and slower reasoning providers were timing
// out at the tighter HTML budget before closing </html>.
const DATAVIZ_ATTEMPT_TIMEOUT_MS = 120_000;
const DATAVIZ_DEFAULT_MAX_TOKENS = 4_000;

// D3 v7 from the vendored local bundle (#924 — served at /vendor on the
// artifact origin; zero CDN). The exact tag is enforced by the prompt.
const D3_CDN_GUIDANCE = [
  'Load D3.js v7 from the local vendored bundle in <head> with exactly this script tag (no other D3 sources):',
  '<script src="/vendor/d3/7.9.0/d3.min.js"></script>',
].join('\n');

const DATAVIZ_RULES = [
  'Generate a complete single-file HTML document that renders a D3.js v7 data visualization.',
  'Start with <!DOCTYPE html> and include <html>, <head> (with <meta charset="utf-8"> and a non-empty <title>), <body>, and all closing tags.',
  D3_CDN_GUIDANCE,
  'Embed the data inline as a JavaScript array/object literal of sample data (10-40 rows); do NOT fetch from a network URL or read a local file.',
  'Use D3 (the global `d3`) to bind that data and draw the visualization: build scales (d3.scaleLinear/scaleBand/scaleTime/etc.), axes (d3.axisBottom/axisLeft), and the marks (bars/lines/circles/paths/links).',
  'Append an <svg> element (or a <canvas> for dense/particle visualizations) as the visualization mount and draw the data-driven marks into it. The mount must occupy most of the viewport.',
  'Pick a visualization that fits the request: bar chart, grouped/stacked bars, line/area chart, scatter plot, histogram, network/force graph, treemap, arc/chord, etc.',
  'Include axis labels or a legend/title so the chart is readable; use a clear, high-contrast color scheme on a non-white background field.',
  'Render the visualization immediately on load (no button required to draw the first frame). Animation/transitions are welcome but the static chart must be present.',
  'Keep all JavaScript inside <script> tags syntactically valid and free of ReferenceErrors; the only external dependency is the vendored /vendor/d3/7.9.0/d3.min.js script; never load D3 from a CDN.',
  'No markdown fences, no prose, no build step, no module bundler, no framework — one self-contained .html file.',
].join('\n');

export class DataVizGenerator extends TierBasedGenerator {
  constructor(llmOrConfig?: ConstructorParameters<typeof TierBasedGenerator>[1]) {
    super('dataviz', llmOrConfig);
  }

  async generate(prompt: string, options?: DataVizGeneratorOptions): Promise<string> {
    const direct = await this.retryDataVizDirect(prompt, options);
    if (direct.html) return direct.html;
    throw new GenerationError(
      `DataVizGenerator: provider did not return a valid D3 visualization within bounded attempts: ${direct.error ?? 'provider returned no valid dataviz candidate'}`,
      'dataviz',
      { directRetryError: direct.error },
    );
  }

  /**
   * Validate that the output is a complete HTML page that loads D3 and has an
   * svg/canvas mount. Mirrors SVGGenerator.validateOutput: returns a structured
   * reason on failure rather than throwing, so the retry loop can react.
   */
  protected validateOutput(code: string): { valid: boolean; error?: string } {
    let html: string;
    try {
      html = this.extractHTML(code);
    } catch {
      return { valid: false, error: 'Generated dataviz output is not a valid HTML document' };
    }

    const structural = HTMLValidator.validate(html);
    if (!structural.valid) {
      return { valid: false, error: structural.errors.join('; ') };
    }
    if (!this.referencesD3(html)) {
      return { valid: false, error: 'dataviz output does not load D3.js or use the d3 global' };
    }
    if (!this.hasVisualizationMount(html)) {
      return { valid: false, error: 'dataviz output has no <svg> or <canvas> visualization mount' };
    }
    return { valid: true };
  }

  /** True when the page loads the D3 library or uses the `d3` global API. */
  private referencesD3(html: string): boolean {
    const loadsD3Cdn = /<script[^>]+src\s*=\s*["'][^"']*\bd3(?:@|\.min|\.v7|[/.])[^"']*["']/i.test(html);
    const usesD3Api = /\bd3\s*\.\s*(?:select|selectAll|scale[A-Z]\w*|axis[A-Z]\w*|forceSimulation|hierarchy|line|arc|csvParse|json|range|max|min|extent)\b/.test(html);
    return loadsD3Cdn && usesD3Api;
  }

  /** True when the page has an <svg> or <canvas> the visualization can draw into. */
  private hasVisualizationMount(html: string): boolean {
    return /<svg\b/i.test(html) || /<canvas\b/i.test(html) || /\.append\s*\(\s*["']svg["']\s*\)/.test(html);
  }

  /**
   * Extract a complete HTML document from raw provider output (strip markdown
   * fences, tolerate a leading prose line before <!DOCTYPE>). Mirrors
   * HTMLWebGenerator.extractHTML.
   */
  private extractHTML(code: string): string {
    const block = htmlBlock(code);
    if (block) {
      const doctype = /<!DOCTYPE\s+html>/i.test(block.before) ? '<!DOCTYPE html>\n' : '';
      return `${doctype}${block.body}`;
    }
    const { answer } = splitThinking(code);
    if (answer.includes('<!DOCTYPE html>') || /<html[\s>]/i.test(answer)) return answer.trim();
    throw new Error('DataVizGenerator: LLM output is not a valid HTML document');
  }

  private async retryDataVizDirect(prompt: string, options?: DataVizGeneratorOptions): Promise<{ html: string | null; error?: string }> {
    const primaryPrompt = [
      DATAVIZ_RULES,
      '',
      `User request: ${prompt}`,
    ].join('\n');
    const retryPrompt = (why?: string) => [
      'The previous attempt did not return a valid self-contained D3 visualization.',
      ...(why ? [`What was wrong: ${why.slice(0, 600)}`] : []),
      'Return ONE complete HTML file only — no fences, no prose.',
      `Start with <!DOCTYPE html>, include a non-empty <title> in <head>, load <script src="/vendor/d3/7.9.0/d3.min.js"></script>, and end with </html>.`,
      'Embed a small inline sample-data array, build d3 scales + axes, and draw the marks into an <svg> mount that fills the viewport.',
      `User request: ${prompt}`,
    ].join('\n');

    let lastError: string | undefined;

    for (const attempt of [0, 1]) {
      const userPrompt = attempt === 0 ? primaryPrompt : retryPrompt(lastError);
      let result: Awaited<ReturnType<typeof this.llm.complete>>;
      try {
        result = await this.withAttemptTimeout(
          options?.signal,
          DATAVIZ_ATTEMPT_TIMEOUT_MS,
          (signal) => this.llm.complete({
            systemPrompt: 'You create complete single-file HTML pages that render D3.js v7 data visualizations. Output raw HTML only.',
            prompt: userPrompt,
            maxTokens: options?.maxTokens ?? DATAVIZ_DEFAULT_MAX_TOKENS,
            temperature: this.llm.getConfig().temperature,
            signal,
          }),
        );
      } catch (error) {
        lastError = this.describeError(error);
        continue;
      }
      if (!result.success || !result.text) {
        lastError = result.error ?? 'provider returned empty dataviz text';
        continue;
      }
      try {
        const html = this.extractHTML(result.text);
        const validation = this.validateOutput(html);
        if (validation.valid) return { html };
        lastError = validation.error;
      } catch (error) {
        lastError = this.describeError(error);
      }
    }

    return { html: null, error: lastError ?? 'provider returned no valid dataviz candidate' };
  }

  private async withAttemptTimeout<T>(
    parentSignal: AbortSignal | undefined,
    timeoutMs: number,
    run: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    if (parentSignal?.aborted) {
      throw new Error('DataViz generation aborted before provider attempt started');
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => {
      controller.abort(new Error(`DataViz provider attempt timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    const abortFromParent = () => {
      controller.abort(parentSignal?.reason ?? new Error('DataViz generation aborted'));
    };
    parentSignal?.addEventListener('abort', abortFromParent, { once: true });

    try {
      return await run(controller.signal);
    } finally {
      clearTimeout(timeout);
      parentSignal?.removeEventListener('abort', abortFromParent);
    }
  }

  private describeError(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
