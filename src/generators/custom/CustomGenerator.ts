/**
 * CustomGenerator - The custom-domain catch-all generator.
 *
 * `custom` (formerly `meta`) is the 15th generator but NOT a launch creative medium: it is a
 * catch-all for any medium the user describes that is NOT one of the 14
 * fixed domains (e.g. "a reaction-diffusion ink simulation", "generative
 * blackletter calligraphy with opentype.js", "an L-system fern in canvas",
 * "a custom WebGL fluid sim").
 *
 * Given such a prompt, the LLM is asked to:
 *   1. Infer a custom DOMAIN DESCRIPTOR — { name, runtime, libraries[],
 *      renderTarget, notes } — for the requested medium.
 *   2. Emit a SINGLE self-contained HTML document that loads the chosen
 *      libraries from a CDN and renders the piece into a mount
 *      (canvas/svg/webgl/audio as appropriate).
 *
 * The descriptor is embedded in the emitted HTML as a machine-readable comment
 * (<!--SINTER-META-DESCRIPTOR ...-->) so it travels with the artifact through
 * the SAME html pass-through render/preview path as `html`/`dataviz`. The CLI
 * writes it out as a `<artifact>.domain.json` sidecar so the custom domain is
 * captured and reusable.
 *
 * Mirrors DataVizGenerator: a bounded direct retry loop calling llm.complete()
 * (no generic tool loop). Validation is intentionally OPEN-ENDED (this is the
 * catch-all domain): require a complete HTML document with a render mount and
 * the declared library script tags — do NOT over-constrain the medium.
 */

import { TierBasedGenerator, type TierBasedGeneratorOptions } from '../TierBasedGenerator.js';
import { HTMLValidator } from '../../core/validators/HTMLValidator.js';
import { stripLeadingMetaDescriptor } from '../../core/validators/MetaDescriptor.js';
import { GenerationError } from '../../errors/GenerationError.js';
import { htmlBlock, splitThinking } from '../../llm/ModelOutput.js';

export { stripLeadingMetaDescriptor } from '../../core/validators/MetaDescriptor.js';

export interface CustomGeneratorOptions extends TierBasedGeneratorOptions {
  title?: string;
}

/**
 * The custom-domain descriptor the model infers for the requested medium.
 * Kept deliberately small and open: `name` is a slug, `runtime` is the rendering
 * substrate (canvas/svg/webgl/audio/...), `libraries` are CDN deps (may be empty
 * for vanilla mediums), `renderTarget` is the mount selector/kind, `notes` is a
 * one-line human description of the technique.
 */
export interface MetaDomainDescriptor {
  name: string;
  runtime: string;
  libraries: string[];
  renderTarget: string;
  notes: string;
}

// Custom mediums vary wildly in density (a vanilla L-system vs. a WebGL fluid
// sim with shaders). Two bounded attempts match DataVizGenerator's shape
// (primary + a tighter retry); the per-attempt timeout matches dataviz (120s)
// because a self-contained simulation page is similarly token-dense.
const META_ATTEMPT_TIMEOUT_MS = 120_000;
const META_DEFAULT_MAX_TOKENS = 12_000;

// Marker that wraps the inferred descriptor JSON inside the emitted HTML so it
// travels with the artifact and can be parsed back out for the sidecar.
const DESCRIPTOR_OPEN = '<!--SINTER-META-DESCRIPTOR';
const DESCRIPTOR_CLOSE = '-->';

const META_RULES = [
  'You are generating a creative artifact in a CUSTOM medium the user describes — a medium OUTSIDE the fixed set (not p5, three.js, GLSL, hydra, svg, plain html, ascii, kinetic, textgen, tone, strudel, revideo, hyperframes, or D3 dataviz).',
  '',
  'STEP 1 — Infer a custom domain DESCRIPTOR for the requested medium and emit it FIRST as a single HTML comment on its own line, exactly in this form (compact JSON, no line breaks inside):',
  `${DESCRIPTOR_OPEN} {"name":"<slug>","runtime":"<canvas|svg|webgl|audio|dom|...>","libraries":["<cdn-url-or-name>", "..."],"renderTarget":"<#mount-id or canvas/svg/...>","notes":"<one-line description of the technique>"} ${DESCRIPTOR_CLOSE}`,
  '  - name: a short kebab/slug identifier for the medium (e.g. "reaction-diffusion", "lsystem-fern", "webgl-fluid").',
  '  - runtime: the rendering substrate you will actually use (canvas, svg, webgl, audio, dom, ...).',
  '  - libraries: the CDN libraries you load (full https CDN URLs preferred); use an empty array [] for a vanilla medium with no external library.',
  '  - renderTarget: the mount the piece draws into (e.g. "#stage", "canvas", "svg").',
  '  - notes: one human-readable line describing the technique.',
  '',
  'STEP 2 — Immediately after the descriptor comment, emit ONE complete, self-contained HTML document that renders the piece:',
  '  - Start with <!DOCTYPE html> and include <html>, <head> (with <meta charset="utf-8"> and a non-empty <title>), <body>, and all closing tags through </html>.',
  '  - For every library named in descriptor.libraries, load it via a <script src="https://..."></script> (or <link>) tag from a CDN in <head>. If libraries is empty, write the medium in vanilla JS/CSS with no external script.',
  '  - Include the render mount declared in descriptor.renderTarget (a <canvas>, <svg>, WebGL canvas, audio context host, or a positioned <div>) and draw/animate the piece into it on load — no button required to start the first frame.',
  '  - Embed any sample parameters/data inline; do NOT fetch from a network URL or read a local file beyond the declared CDN libraries.',
  '  - Keep all JavaScript syntactically valid and free of ReferenceErrors; render something visibly non-trivial for the described medium.',
  '',
  'Output ONLY the descriptor comment followed by the HTML document. No markdown fences, no prose, no build step, no bundler, no framework scaffolding — one self-contained .html file.',
].join('\n');

export class CustomGenerator extends TierBasedGenerator {
  /** Descriptor parsed from the most recent successful generate() — read by the CLI to write the sidecar. */
  private lastDescriptor: MetaDomainDescriptor | null = null;

  constructor(llmOrConfig?: ConstructorParameters<typeof TierBasedGenerator>[1]) {
    super('custom', llmOrConfig);
  }

  async generate(prompt: string, options?: CustomGeneratorOptions): Promise<string> {
    const direct = await this.retryMetaDirect(prompt, options);
    if (direct.html) {
      this.lastDescriptor = direct.descriptor ?? null;
      return direct.html;
    }
    throw new GenerationError(
      `CustomGenerator: provider did not return a valid custom-medium artifact within bounded attempts: ${direct.error ?? 'provider returned no valid custom candidate'}`,
      'custom',
      { directRetryError: direct.error },
    );
  }

  /** The custom-domain descriptor inferred on the last successful generate(), if any. */
  getLastDescriptor(): MetaDomainDescriptor | null {
    return this.lastDescriptor;
  }

  /**
   * Validate that the output is a complete HTML page with a render mount and the
   * declared library script tags. Mirrors DataVizGenerator.validateOutput:
   * returns a structured reason on failure rather than throwing.
   *
   * Intentionally OPEN-ENDED — this is the catch-all domain, so we do NOT pin a
   * specific library/runtime. We only require: parseable descriptor, real HTML,
   * a render mount, and that every CDN library the descriptor declares is
   * actually loaded by a tag in the page (so the descriptor is not a lie).
   */
  protected validateOutput(code: string): { valid: boolean; error?: string; descriptor?: MetaDomainDescriptor } {
    let html: string;
    try {
      html = this.extractHTML(code);
    } catch {
      return { valid: false, error: 'Generated custom output is not a valid HTML document' };
    }

    const descriptor = this.parseDescriptor(html);
    if (!descriptor) {
      return { valid: false, error: 'custom output is missing a parseable SINTER-META-DESCRIPTOR comment' };
    }

    // Validate the HTML *document* structure on the doctype-onward portion: the
    // descriptor comment legitimately precedes <!DOCTYPE html>, but HTMLValidator
    // requires the input to START with the doctype, so strip the leading comment
    // for the structural check only (the comment still ships in the artifact).
    const structural = HTMLValidator.validate(stripLeadingMetaDescriptor(html));
    if (!structural.valid) {
      return { valid: false, error: structural.errors.join('; ') };
    }

    if (!this.hasRenderMount(html)) {
      return { valid: false, error: 'custom output has no <canvas>, <svg>, WebGL, or mount element to render into' };
    }

    const missingLib = this.firstUndeclaredLibrary(html, descriptor);
    if (missingLib) {
      return { valid: false, error: `custom descriptor declares library "${missingLib}" but the page never loads it via a script/link tag` };
    }

    return { valid: true, descriptor };
  }

  /** Parse the embedded descriptor comment into a typed object, or null if absent/invalid. */
  private parseDescriptor(html: string): MetaDomainDescriptor | null {
    const open = html.indexOf(DESCRIPTOR_OPEN);
    if (open === -1) return null;
    const close = html.indexOf(DESCRIPTOR_CLOSE, open + DESCRIPTOR_OPEN.length);
    if (close === -1) return null;
    const raw = html.slice(open + DESCRIPTOR_OPEN.length, close).trim();
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return null;
    }
    if (!parsed || typeof parsed !== 'object') return null;
    const obj = parsed as Record<string, unknown>;
    const name = typeof obj.name === 'string' ? obj.name.trim() : '';
    const runtime = typeof obj.runtime === 'string' ? obj.runtime.trim() : '';
    const renderTarget = typeof obj.renderTarget === 'string' ? obj.renderTarget.trim() : '';
    const notes = typeof obj.notes === 'string' ? obj.notes.trim() : '';
    const libraries = Array.isArray(obj.libraries)
      ? obj.libraries.filter((l): l is string => typeof l === 'string').map((l) => l.trim()).filter(Boolean)
      : [];
    // name + runtime + renderTarget are the load-bearing fields; libraries may be
    // empty (vanilla medium) and notes is descriptive.
    if (!name || !runtime || !renderTarget) return null;
    return { name, runtime, libraries, renderTarget, notes };
  }

  /** True when the page has a canvas/svg/webgl/mount element the piece can render into. */
  private hasRenderMount(html: string): boolean {
    if (/<canvas\b/i.test(html) || /<svg\b/i.test(html)) return true;
    // WebGL/audio mediums append their own canvas or attach to a positioned div.
    if (/getContext\s*\(\s*["'](?:webgl2?|2d)["']/i.test(html)) return true;
    if (/\.append\s*\(\s*["'](?:svg|canvas)["']\s*\)/i.test(html)) return true;
    if (/createElement\s*\(\s*["'](?:canvas|svg)["']\s*\)/i.test(html)) return true;
    return false;
  }

  /**
   * Return the first descriptor-declared CDN library URL that the page does not
   * actually load (so a descriptor cannot claim a dependency the artifact omits).
   * Only full https URLs are checked — bare library names ("opentype.js") are
   * descriptive and not verifiable against a tag, so they pass.
   */
  private firstUndeclaredLibrary(html: string, descriptor: MetaDomainDescriptor): string | null {
    // Check the DOCUMENT only, not the descriptor comment (the descriptor JSON
    // itself contains the URL, so a raw html.includes() would falsely pass).
    const document = stripLeadingMetaDescriptor(html);
    // Collect the src/href URLs the page actually loads.
    const loaded = [...document.matchAll(/(?:src|href)\s*=\s*["']([^"']+)["']/gi)].map((m) => m[1]);
    for (const lib of descriptor.libraries) {
      if (!/^https?:\/\//i.test(lib)) continue; // bare name — not verifiable, allow
      // Tolerate a trailing-slash / minor version-suffix difference by matching on
      // the longest stable prefix (so "regl@2" matches a loaded "regl@2.1.0").
      const prefix = lib.split('#')[0].replace(/\/+$/, '');
      const isLoaded = loaded.some((url) => url.includes(prefix) || prefix.includes(url));
      if (!isLoaded) return lib;
    }
    return null;
  }

  /**
   * Extract a complete HTML document from raw provider output (strip markdown
   * fences, tolerate a leading prose line before the descriptor/<!DOCTYPE>).
   * Mirrors DataVizGenerator.extractHTML but keeps any leading descriptor comment.
   */
  private extractHTML(code: string): string {
    const block = htmlBlock(code);
    if (block) {
      // Preserve a descriptor comment the model emitted before the fence.
      return `${this.sliceDescriptorComment(block.before)}${block.body}`;
    }
    const { answer } = splitThinking(code);
    if (answer.includes(DESCRIPTOR_OPEN) || answer.includes('<!DOCTYPE html>') || /<html[\s>]/i.test(answer)) {
      let cleaned = answer.trim();
      // Drop any prose before the descriptor comment or the doctype, whichever comes first.
      const descIdx = cleaned.indexOf(DESCRIPTOR_OPEN);
      const docIdx = cleaned.search(/<!DOCTYPE html>|<html[\s>]/i);
      const start = [descIdx, docIdx].filter((i) => i >= 0).sort((a, b) => a - b)[0];
      if (typeof start === 'number' && start > 0) cleaned = cleaned.slice(start);
      return cleaned.trim();
    }
    throw new Error('CustomGenerator: LLM output is not a valid HTML document');
  }

  /** Pull a descriptor comment out of a text fragment (returns "" if none), for fenced output. */
  private sliceDescriptorComment(text: string): string {
    const open = text.indexOf(DESCRIPTOR_OPEN);
    if (open === -1) return '';
    const close = text.indexOf(DESCRIPTOR_CLOSE, open + DESCRIPTOR_OPEN.length);
    if (close === -1) return '';
    return `${text.slice(open, close + DESCRIPTOR_CLOSE.length).trim()}\n`;
  }

  private async retryMetaDirect(
    prompt: string,
    options?: CustomGeneratorOptions,
  ): Promise<{ html: string | null; descriptor?: MetaDomainDescriptor; error?: string }> {
    const primaryPrompt = [
      META_RULES,
      '',
      `User request (the custom medium to create): ${prompt}`,
    ].join('\n');
    const retryPrompt = [
      'The previous attempt did not return a valid self-contained custom-medium artifact.',
      `Return ONLY a ${DESCRIPTOR_OPEN} ... ${DESCRIPTOR_CLOSE} comment followed by ONE complete HTML file — no fences, no prose.`,
      'The descriptor JSON must have name, runtime, libraries (array, may be empty), renderTarget, and notes.',
      'Start the HTML with <!DOCTYPE html>, include a non-empty <title>, load every descriptor library via a CDN <script>/<link>, include the render mount, and end with </html>.',
      'Render something visibly non-trivial for the described medium on load.',
      `User request (the custom medium to create): ${prompt}`,
    ].join('\n');

    const prompts = [primaryPrompt, retryPrompt];
    let lastError: string | undefined;

    for (const userPrompt of prompts) {
      let result: Awaited<ReturnType<typeof this.llm.complete>>;
      try {
        result = await this.withAttemptTimeout(
          options?.signal,
          META_ATTEMPT_TIMEOUT_MS,
          (signal) => this.llm.complete({
            systemPrompt: 'You create complete single-file HTML pages that render creative artifacts in ANY custom medium the user describes. You first emit a SINTER-META-DESCRIPTOR comment describing the inferred custom domain, then the self-contained HTML. Output raw HTML only.',
            prompt: userPrompt,
            maxTokens: options?.maxTokens ?? META_DEFAULT_MAX_TOKENS,
            temperature: this.llm.getConfig().temperature,
            signal,
          }),
        );
      } catch (error) {
        lastError = this.describeError(error);
        continue;
      }
      if (!result.success || !result.text) {
        lastError = result.error ?? 'provider returned empty custom text';
        continue;
      }
      try {
        const html = this.extractHTML(result.text);
        const validation = this.validateOutput(html);
        if (validation.valid) return { html, descriptor: validation.descriptor };
        lastError = validation.error;
      } catch (error) {
        lastError = this.describeError(error);
      }
    }

    return { html: null, error: lastError ?? 'provider returned no valid custom candidate' };
  }

  private async withAttemptTimeout<T>(
    parentSignal: AbortSignal | undefined,
    timeoutMs: number,
    run: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    if (parentSignal?.aborted) {
      throw new Error('Meta generation aborted before provider attempt started');
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => {
      controller.abort(new Error(`Meta provider attempt timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    const abortFromParent = () => {
      controller.abort(parentSignal?.reason ?? new Error('Meta generation aborted'));
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

/**
 * Parse the SINTER-META-DESCRIPTOR comment out of a generated custom-domain artifact.
 * Exported so the CLI can write the `<artifact>.domain.json` sidecar beside the
 * rendered HTML without re-instantiating the generator.
 */
export function parseMetaDescriptorFromHtml(html: string): MetaDomainDescriptor | null {
  const open = html.indexOf(DESCRIPTOR_OPEN);
  if (open === -1) return null;
  const close = html.indexOf(DESCRIPTOR_CLOSE, open + DESCRIPTOR_OPEN.length);
  if (close === -1) return null;
  const raw = html.slice(open + DESCRIPTOR_OPEN.length, close).trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const obj = parsed as Record<string, unknown>;
  const name = typeof obj.name === 'string' ? obj.name.trim() : '';
  const runtime = typeof obj.runtime === 'string' ? obj.runtime.trim() : '';
  const renderTarget = typeof obj.renderTarget === 'string' ? obj.renderTarget.trim() : '';
  const notes = typeof obj.notes === 'string' ? obj.notes.trim() : '';
  const libraries = Array.isArray(obj.libraries)
    ? obj.libraries.filter((l): l is string => typeof l === 'string').map((l) => l.trim()).filter(Boolean)
    : [];
  if (!name || !runtime || !renderTarget) return null;
  return { name, runtime, libraries, renderTarget, notes };
}
