/**
 * BlenderGenerator - writes a bpy (Blender Python) scene script.
 *
 * The model returns a Python script that builds a scene (objects, materials,
 * light, camera). Sinter renders it headless with Blender in an isolated
 * subprocess (render/BlenderRenderer) and the PNG is judged like any other
 * visual domain. The script never renders itself; the driver does, with
 * capped resolution and samples.
 *
 * Mirrors MetaGenerator/DataVizGenerator: a bounded direct retry loop calling
 * llm.complete(), no generic tool loop.
 */

import { TierBasedGenerator, type TierBasedGeneratorOptions } from '../TierBasedGenerator.js';
import { findForbiddenBlenderConstruct } from '../../render/BlenderRenderer.js';
import { GenerationError } from '../../errors/GenerationError.js';
import { BLENDER_RULES } from './blenderRules.js';
import { pickCodeBlock, splitThinking } from '../../llm/ModelOutput.js';

export type BlenderGeneratorOptions = TierBasedGeneratorOptions;

const BLENDER_ATTEMPT_TIMEOUT_MS = 120_000;
const BLENDER_DEFAULT_MAX_TOKENS = 6_000;

const BPY_IMPORT = /^\s*(?:import\s+bpy\b|from\s+bpy\b)/m;


export class BlenderGenerator extends TierBasedGenerator {
  constructor(llmOrConfig?: ConstructorParameters<typeof TierBasedGenerator>[1]) {
    super('blender', llmOrConfig);
  }

  async generate(prompt: string, options?: BlenderGeneratorOptions): Promise<string> {
    const direct = await this.retryDirect(prompt, options);
    if (direct.code) return direct.code;
    throw new GenerationError(
      `BlenderGenerator: provider did not return a valid bpy script within bounded attempts: ${direct.error ?? 'provider returned no valid blender candidate'}`,
      'blender',
      { directRetryError: direct.error },
    );
  }

  protected validateOutput(code: string): { valid: boolean; error?: string } {
    if (!BPY_IMPORT.test(code)) {
      return { valid: false, error: 'blender output must be a Python script that imports bpy' };
    }
    const forbidden = findForbiddenBlenderConstruct(code);
    if (forbidden) {
      return { valid: false, error: `blender script uses "${forbidden}", which is not allowed (no network, subprocess, shell or dynamic code)` };
    }
    return { valid: true };
  }

  /** Strip markdown fences and any prose around the script. */
  private extractScript(text: string): string {
    const { answer } = splitThinking(text);
    const fence = pickCodeBlock(answer, ['python', 'py']);
    if (fence) return fence.body.trim();
    const start = answer.search(/^\s*(?:import\s+bpy\b|from\s+bpy\b)/m);
    return (start > 0 ? answer.slice(start) : answer).trim();
  }

  private async retryDirect(
    prompt: string,
    options?: BlenderGeneratorOptions,
  ): Promise<{ code: string | null; error?: string }> {
    const prompts = [
      [BLENDER_RULES, '', `User request (the scene to build): ${prompt}`].join('\n'),
      [
        'The previous attempt did not return a valid Blender python script.',
        'Return ONLY a raw Python script that starts with `import bpy`, builds objects, a light and a camera, and does not call bpy.ops.render.',
        'No fences, no prose, no network, subprocess, shell, exec or eval.',
        `User request (the scene to build): ${prompt}`,
      ].join('\n'),
    ];
    let lastError: string | undefined;

    for (const userPrompt of prompts) {
      let result: Awaited<ReturnType<typeof this.llm.complete>>;
      try {
        result = await this.withAttemptTimeout(options?.signal, (signal) => this.llm.complete({
          systemPrompt: 'You write Blender Python (bpy) scene scripts. Output raw Python only.',
          prompt: userPrompt,
          maxTokens: options?.maxTokens ?? BLENDER_DEFAULT_MAX_TOKENS,
          temperature: this.llm.getConfig().temperature,
          signal,
        }));
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
        continue;
      }
      if (!result.success || !result.text) {
        lastError = result.error ?? 'provider returned empty blender text';
        continue;
      }
      const code = this.extractScript(result.text);
      const validation = this.validateOutput(code);
      if (validation.valid) return { code };
      lastError = validation.error;
    }
    return { code: null, error: lastError };
  }

  private async withAttemptTimeout<T>(
    parentSignal: AbortSignal | undefined,
    run: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    if (parentSignal?.aborted) throw new Error('Blender generation aborted before provider attempt started');
    const controller = new AbortController();
    const timeout = setTimeout(() => {
      controller.abort(new Error(`Blender provider attempt timed out after ${BLENDER_ATTEMPT_TIMEOUT_MS}ms`));
    }, BLENDER_ATTEMPT_TIMEOUT_MS);
    const abortFromParent = () => controller.abort(parentSignal?.reason ?? new Error('Blender generation aborted'));
    parentSignal?.addEventListener('abort', abortFromParent, { once: true });
    try {
      return await run(controller.signal);
    } finally {
      clearTimeout(timeout);
      parentSignal?.removeEventListener('abort', abortFromParent);
    }
  }
}
