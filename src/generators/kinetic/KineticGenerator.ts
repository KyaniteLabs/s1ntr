/**
 * KineticGenerator - CSS-native generative art.
 */

import { TierBasedGenerator, type TierBasedGeneratorOptions } from '../TierBasedGenerator.js';
import type { LLMClient, LLMResponse } from '../../llm/LLMClient.js';
import { CodeValidator } from '../../core/CodeValidator.js';
import { KINETIC_SYSTEM_PROMPT, buildKineticPrompt } from './kineticPrompt.js';
import { KineticWrapper } from './KineticWrapper.js';
import { Logger } from '../../utils/Logger.js';
import { GenerationError } from '../../errors/GenerationError.js';
import { answerCode } from '../../llm/ModelOutput.js';
import { directAttemptTimeoutMs } from '../directAttemptTimeout.js';

export type KineticGeneratorOptions = TierBasedGeneratorOptions;

export class KineticGenerator extends TierBasedGenerator {
  constructor(llmOrConfig?: ConstructorParameters<typeof TierBasedGenerator>[1]) {
    super('kinetic', llmOrConfig);
  }

  async generate(prompt: string, options?: KineticGeneratorOptions): Promise<string> {
    const response = await this.generateFull(prompt, options);
    if (!response.success || !response.code?.trim()) {
      throw new GenerationError(`KineticGenerator: ${response.error ?? 'generation failed'}`, 'kinetic', {
        generatedCode: response.code,
      });
    }
    this.captureFitnessMetadata(response);
    return response.code;
  }

  async generateFull(prompt: string, options?: KineticGeneratorOptions): Promise<LLMResponse> {
    if (!this.llm) {
      throw new Error('KineticGenerator: LLM not initialized');
    }

    Logger.info('KineticGenerator', 'Generating CSS-kinetic artwork');
    let response = await this.tryCompactDirect(prompt, options);
    if (!response) {
      if (this.usesMiniMaxAnthropic()) {
        return this.buildFailedKineticResponse('MiniMax direct attempt did not return valid CSS kinetic HTML inside the bounded live-journey budget');
      }
      try {
        response = await this.llm.generate(
          KINETIC_SYSTEM_PROMPT,
          buildKineticPrompt(prompt),
          options?.signal,
          options?.bypassCache
        );
      } catch (error) {
        return this.buildFailedKineticResponse(this.describeError(error));
      }
    }

    if (!response.code || response.code.trim().length === 0) {
      return this.buildFailedKineticResponse('LLM returned empty CSS kinetic HTML');
    }

    response.code = this.normalizeKineticHtml(response.code);
    const validated = this.validateOutput(response.code);
    if (!validated.valid) {
      try {
        response = await this.llm.generate(
          KINETIC_SYSTEM_PROMPT,
          this.buildRetryPrompt(prompt, response.code, validated.error ?? 'Validation failed'),
          options?.signal,
          true
        );
      } catch (error) {
        return this.buildFailedKineticResponse(`Validation retry failed after ${validated.error}: ${this.describeError(error)}`, response.code);
      }
      response.code = this.normalizeKineticHtml(response.code ?? '');
      const revalidated = this.validateOutput(response.code);
      if (!revalidated.valid) {
        if (process.env.KINETIC_DIAGNOSE) {
          const c = (response.code ?? '').trim();
          const headOpen = (c.match(/<head\b/gi) || []).length;
          const headClose = (c.match(/<\/head>/gi) || []).length;
          const bodyOpen = (c.match(/<body\b/gi) || []).length;
          Logger.error('KineticGenerator', `[kinetic-diagnose] len=${c.length} headOpen=${headOpen} headClose=${headClose} bodyOpen=${bodyOpen} hasCloseHtml=${/<\/html>/i.test(c)} err="${revalidated.error}"`);
        }
        return this.buildFailedKineticResponse(`Validation retry returned invalid CSS kinetic HTML: ${revalidated.error}`, response.code);
      }
    }

    return response;
  }

  private buildFailedKineticResponse(reason: string, code = ''): LLMResponse {
    return {
      code,
      success: false,
      error: reason,
    };
  }

  private describeError(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }

  private async tryCompactDirect(prompt: string, options?: KineticGeneratorOptions): Promise<LLMResponse | null> {
    await this.resolveConfigIfNeeded();
    const attemptTimeoutMs = KineticGenerator.directAttemptTimeoutMs(this.llm.getTimeoutOverride());
    const result = await this.completeWithAttemptTimeout({
      systemPrompt: 'You are a deterministic source-code printer. Do not reason. Do not explain. Output only the requested source file.',
      prompt: [
        'Print one complete HTML file only.',
        'The first characters must be <!DOCTYPE html> and the final characters must be </html>.',
        `Create CSS kinetic typography for: ${prompt}`,
        'Requirements: no JavaScript; include <style>, @keyframes, animation:, and visible text elements in <body>.',
        'Use a DEEP DARK full-scene background with BRIGHT, luminous, glowing animated text/shapes; set body/html background-color to a deep dark hex such as #0a0e1a, #0f172a, or #120a1f, and make the animated text/forms bright (glowing whites, cyans, ambers) so they clearly light up the dark stage.',
        'Never use a pale or near-white background (it washes out); never use dim low-contrast text on the dark background (it renders near-blank). If you use CSS variables, --bg must resolve to a deep dark hex and the text/foreground must resolve to bright luminous colors.',
        'Keep it compact enough to finish in one response.',
      ].join('\n'),
      // A full kinetic HTML doc (DOCTYPE + head + @keyframes + animated body)
      // overran the old 2800 cap and truncated before </head>/</html> and before
      // the animation CSS — the live kinetic failure ("1 opening, 0 closing
      // <head>" + "must define animation"). Raised so it can finish.
      maxTokens: Math.min(options?.maxTokens ?? 4000, 4500),
      temperature: 0.1,
      // The compact-direct attempt runs BEFORE the main path and its budget
      // comes out of the caller's overall window (audit F21).
      preferMiniMaxOpenAI: true,
    }, options?.signal, attemptTimeoutMs);
    if (!result.success || !result.text) return null;
    const extracted = this.extractKineticHtml(result.text);
    if (!extracted) return null;
    const code = this.normalizeKineticHtml(extracted);
    const validated = this.validateOutput(code);
    return {
      code,
      explanation: result.text,
      success: true,
      error: validated.valid ? result.error : validated.error,
      provenance: result.provenance,
    };
  }

  private async completeWithAttemptTimeout(
    request: Parameters<LLMClient['complete']>[0],
    parentSignal: AbortSignal | undefined,
    timeoutMs: number,
  ): Promise<Awaited<ReturnType<LLMClient['complete']>>> {
    if (parentSignal?.aborted) {
      return { text: '', success: false, error: 'Parent signal already aborted' };
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    const abortFromParent = () => controller.abort(parentSignal?.reason);
    parentSignal?.addEventListener('abort', abortFromParent, { once: true });
    try {
      return await this.llm.complete({ ...request, signal: controller.signal, providerTimeoutMs: timeoutMs });
    } finally {
      clearTimeout(timeout);
      parentSignal?.removeEventListener('abort', abortFromParent);
    }
  }

  /** Wall-clock budget for the compact-direct first attempt (default 60s). */
  static directAttemptTimeoutMs(configuredTimeout?: number): number {
    return directAttemptTimeoutMs(configuredTimeout);
  }

  private usesMiniMaxAnthropic(): boolean {
    return /api\.minimax\.io\/anthropic/i.test(this.llm.getConfig().baseUrl);
  }

  private extractKineticHtml(text: string): string | null {
    const candidate = answerCode(text, ['html']).trim();
    const start = candidate.search(/<!DOCTYPE\s+html|<html\b/i);
    if (start < 0) return null;
    const fromHtml = candidate.slice(start);
    const end = fromHtml.search(/<\/html>/i);
    return end >= 0 ? fromHtml.slice(0, end + '</html>'.length) : fromHtml;
  }

  private buildRetryPrompt(prompt: string, failedCode: string, error: string): string {
    return `${buildKineticPrompt(prompt)}

The previous output failed validation.
Validation error: ${error}

Previous output:
\`\`\`html
${failedCode}
\`\`\`

Regenerate a complete CSS-kinetic artwork:
- include <!DOCTYPE html>, <html>, <head>, and <body>
- include visible elements inside <body> such as div/span/svg elements
- include at least one CSS @keyframes block
- use animation: ... infinite on visible elements
- use a deep dark scene background with bright, luminous, glowing animated text/forms
- set body/html background-color to a deep dark hex such as #0a0e1a, #0f172a, or #120a1f, and make the text/forms bright (glowing whites, cyans, ambers) so they light up the dark stage
- never use a pale/near-white background (washes out) and never use dim low-contrast text on dark (renders near-blank)
- do not include JavaScript or <script>
- output raw HTML only`;
  }

  protected validateOutput(code: string): { valid: boolean; error?: string } {
    const validation = CodeValidator.validate(code, 'kinetic');
    if (!validation.valid) {
      return { valid: false, error: validation.errors.join('; ') };
    }
    if (!this.hasVisibleBodyContent(code)) {
      return {
        valid: false,
        error: 'Kinetic HTML must include visible elements inside <body>, not just CSS',
      };
    }
    return { valid: true };
  }

  private hasVisibleBodyContent(code: string): boolean {
    const bodyMatch = code.match(/<body\b[^>]*>([\s\S]*?)<\/body>/i);
    const body = bodyMatch?.[1] ?? code;
    const visibleElementPattern = /<(div|span|section|article|main|p|h[1-6]|svg|canvas|ul|ol|li)\b[^>]*>/i;
    return visibleElementPattern.test(
      body
        .replace(/<style\b[\s\S]*?<\/style>/gi, '')
        .replace(/<script\b[\s\S]*?<\/script>/gi, '')
        .replace(/<!--[\s\S]*?-->/g, '')
    );
  }

  private normalizeKineticHtml(code: string): string {
    let cleaned = answerCode(code, ['html']).trim();

    if (!/^<!DOCTYPE\s+html/i.test(cleaned) && /<html\b/i.test(cleaned)) {
      cleaned = `<!DOCTYPE html>\n${cleaned}`;
    }

    // Collapse any number of <head> sections and stray head tags into one
    // well-formed <head>...</head> before <body>. LLMs often emit stray
    // </head>, duplicate heads, or place the head inside the body.
    if (/<head\b/i.test(cleaned) && !/<\/head>/i.test(cleaned)) {
      cleaned = cleaned.replace(/<body\b/i, '</head>\n$&');
      if (!/<\/head>/i.test(cleaned)) {
        cleaned = cleaned.replace(/<\/html>/i, '</head>\n</html>');
      }
    }
    const headContents: string[] = [];
    let headMatch: RegExpExecArray | null;
    const headRegex = /<head\b[^>]*>([\s\S]*?)<\/head>/gi;
    while ((headMatch = headRegex.exec(cleaned)) !== null) {
      headContents.push(headMatch[1]);
    }
    cleaned = cleaned.replace(/<\/?head\b[^>]*>/gi, '');
    const headBlock = headContents.length > 0 ? headContents.join('\n') : '<meta charset="utf-8">';
    cleaned = cleaned.replace(/<html\b[^>]*>/i, `$&\n<head>${headBlock}</head>`);

    const styleClose = cleaned.lastIndexOf('</style>');
    const bodyOpen = cleaned.search(/<body\b/i);
    if (styleClose >= 0 && bodyOpen >= 0 && styleClose < bodyOpen) {
      const bodyStart = cleaned.slice(0, bodyOpen);
      let rest = cleaned.slice(bodyOpen);
      const orphanKeyframes = rest.match(/@keyframes[\s\S]*?(?=<\/style>|<\/head>|<\/body>|<div|<svg|$)/g);
      if (orphanKeyframes?.length) {
        rest = rest.replace(/@keyframes[\s\S]*?(?=<\/style>|<\/head>|<\/body>|<div|<svg|$)/g, '');
        cleaned = `${bodyStart.replace('</style>', `${orphanKeyframes.join('\n')}\n</style>`)}${rest}`;
      }
    }

    // Ensure opening <body> exists
    if (!/<body\b/i.test(cleaned)) {
      cleaned = cleaned.replace(/<\/head>/i, '</head>\n<body>') ?? cleaned;
      if (!/<body\b/i.test(cleaned)) {
        cleaned = cleaned.replace(/<html\b[^>]*>/i, '$&\n<body>') ?? cleaned;
      }
    }
    if (!/<\/body>/i.test(cleaned)) {
      cleaned += '\n</body>';
    }
    if (!/<\/html>/i.test(cleaned)) {
      cleaned += '\n</html>';
    }

    const bodyMatch = /<body\b[^>]*>/i.exec(cleaned);
    if (bodyMatch) {
      const bodyStart = bodyMatch.index + bodyMatch[0].length;
      const beforeBody = cleaned.slice(0, bodyStart);
      const body = cleaned.slice(bodyStart)
        .replace(/<\/?style[^>]*>/gi, '')
        .replace(/<\/?head[^>]*>/gi, '')
        .replace(/<body\b[^>]*>/gi, '')
        .replace(/<\/body>/gi, '')
        .replace(/<\/html>/gi, '');
      cleaned = `${beforeBody}${body}\n</body>\n</html>`;
    }

    // If body has no visible elements, inject elements for CSS targets
    if (!this.hasVisibleBodyContent(cleaned)) {
      // Collect animation targets from @keyframes names and CSS class selectors
      const keyframeNames = [...cleaned.matchAll(/@keyframes\s+([a-zA-Z_-][\w-]*)/g)].map(m => m[1]);
      const styleContent = cleaned.match(/<style\b[\s\S]*?<\/style>/i)?.[0] ?? '';
      const classNames = [...styleContent.matchAll(/\.([a-zA-Z_-][\w-]*)\s*\{[^}]*animation/g)].map(m => m[1]);
      const targetNames = [...new Set([...keyframeNames, ...classNames])];

      if (targetNames.length > 0) {
        const injectedDivs = targetNames.map(name =>
          `  <div class="${name}" style="position:absolute;left:50%;top:50%;width:16vmin;height:16vmin;transform:translate(-50%,-50%);border-radius:50%;background:radial-gradient(circle,#9ae6ff,#b794f6);box-shadow:0 0 48px #9ae6ff;"></div>`
        ).join('\n');
        cleaned = cleaned.replace(/(<body\b[^>]*>)/i, `$1\n${injectedDivs}`);
        if (!cleaned.includes('position:') && !cleaned.includes('display:')) {
          cleaned = cleaned.replace('</style>', `
body { margin: 0; overflow: hidden; background: #0a0e1a; width: 100vw; height: 100vh; position: relative; }
body > div { position: absolute; }
</style>`);
        }
      }
    }

    return cleaned;
  }

  wrapForGallery(code: string): string {
    return KineticWrapper.wrap(code, { title: 'Kinetic Artwork' });
  }
}
