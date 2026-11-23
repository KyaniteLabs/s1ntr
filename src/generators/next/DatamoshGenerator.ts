/**
 * DatamoshGenerator - asks the model for a datamosh PLAN (JSON), never for code.
 * The plan names footage ids from the licence-checked library; the renderer does the real bitstream edit.
 */
import type { LLMClient } from '../../llm/LLMClient.js';
import { GenerationError } from '../../errors/GenerationError.js';
import { parseMoshPlan } from '../../render/DatamoshPlan.js';
import { FootageLibrary } from '../../footage/FootageLibrary.js';
import { splitThinking } from '../../llm/ModelOutput.js';

export const DATAMOSH_RULES = [
  'Datamosh = a real codec glitch. You choose footage and where to break it; a renderer edits the video bitstream.',
  'Return ONLY one JSON object, no prose, no fence:',
  '{"segments":[{"clip":"<id from the list>","start":<seconds>,"duration":<seconds>}],"gop":12,"fps":24,"width":480,"strip":"all","holds":[{"at":<frame index of a P-frame>,"repeat":<1-120>}],"post":{"saturation":<0-4>,"hue":<-180..180>,"contrast":<0.5-2>}}',
  'Rules: 1 or 2 segments, total at most 12 s; use only clip ids from the list; "strip":"all" removes every I-frame after the first so motion smears across scene changes;',
  'a "hold" repeats one P-frame so its motion vectors push the picture further (pick indexes that are not multiples of gop); saturation above 1.5 gives hard rainbow streaks.',
].join('\n');

const ATTEMPT_TIMEOUT_MS = 120_000;

export interface DatamoshGeneratorOptions { footageContext?: string; footageRoot?: string; maxTokens?: number; signal?: AbortSignal }

export class DatamoshGenerator {
  constructor(private readonly llm: LLMClient, private readonly options: DatamoshGeneratorOptions = {}) {}

  async generate(prompt: string): Promise<string> {
    const context = this.options.footageContext ?? new FootageLibrary(this.options.footageRoot).promptContext();
    const known = new Set(context.split('\n').map((line) => line.split(':')[0].trim()).filter(Boolean));
    const prompts = [
      [DATAMOSH_RULES, '', 'Footage available:', context, '', `User request: ${prompt}`].join('\n'),
      ['The previous reply was not a valid datamosh plan. Return ONLY the JSON object described below.', DATAMOSH_RULES, 'Footage available:', context, `User request: ${prompt}`].join('\n'),
    ];
    let lastError = 'provider returned no plan';
    for (const userPrompt of prompts) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(new Error('datamosh provider attempt timed out')), ATTEMPT_TIMEOUT_MS);
      try {
        const result = await this.llm.complete({
          systemPrompt: 'You design datamosh plans as strict JSON. Output the JSON object only.',
          prompt: userPrompt, maxTokens: this.options.maxTokens ?? 1500, temperature: this.llm.getConfig().temperature,
          signal: this.options.signal ?? controller.signal,
        });
        if (!result.success || !result.text) { lastError = result.error ?? 'provider returned empty text'; continue; }
        const { plan } = parseMoshPlan(splitThinking(result.text).answer);
        const unknown = plan.segments.find((s) => !known.has(s.clip));
        if (unknown) { lastError = `plan names footage "${unknown.clip}" which is not in the list`; continue; }
        return JSON.stringify(plan);
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
      } finally { clearTimeout(timer); }
    }
    throw new GenerationError(`DatamoshGenerator: no valid datamosh plan within bounded attempts: ${lastError}`, 'datamosh', { lastError });
  }
}
