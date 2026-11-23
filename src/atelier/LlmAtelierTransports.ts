/**
 * AtelierTransport implementations over LLMClient (PRD A5: rides LLMClient.complete so
 * per-completion attestation is inherited — no per-stage funding reservations).
 * GLM brain authors directives; qwen/GLM generates candidates; vision eyes critique.
 */
import type { LLMClient } from '../llm/LLMClient.js';
import { z } from 'zod';
import { TASK_AXES, type AtelierTransport } from './GuiSpec.js';
import { answerCode } from '../llm/ModelOutput.js';

type AtelierCompletionClient = Pick<LLMClient, 'complete' | 'getConfig'>;
const directiveSchema = z.object({
  id: z.string().trim().min(1), hypothesis: z.string().trim().min(1),
  verifyingMetric: z.enum([...TASK_AXES, 'runtimeErrors']),
  boundedEdit: z.string().trim().min(1),
});
const critiqueSchema = z.array(z.object({
  element: z.string().trim().min(1), defect: z.string().trim().min(1),
  mechanicalFix: z.string().trim().min(1),
}));

function responseBody(text: string): string {
  return answerCode(text, ['json', 'html']).trim();
}

function parseJson<T>(text: string, schema: z.ZodType<T>, kind: string): T {
  try { return schema.parse(JSON.parse(responseBody(text))); }
  catch { throw new Error(`ATELIER_INVALID_RESPONSE (${kind})`); }
}

const BONUS_MANDATE = `STANDING BONUS LAW (CEO): every seat earns bonus credit each round for
recursive self-improvement of the WHOLE system — the loop, the harness, the pipeline, the
other seats' work — not just your own task. Always be scanning for a meta-optimization:
if you see one, emit it (as a "#system" critique element or a meta-directive hypothesis)
and it banks as bonus points for you.`;

const DIRECTIVE_PROMPT = `You are the design brain of a creative-coding agent's operator GUI.
Author ONE bounded mutation directive for the GUI candidate page as strict JSON:
{"id":"...","nicheKey":"<given>","hypothesis":"one sentence operator-need hypothesis",
"verifyingMetric":"coverage|latencyToFirstSignal|errorVisibility|findability|runtimeErrors",
"boundedEdit":"one concrete bounded edit instruction, never a rewrite"}
The verifyingMetric MUST be the deterministic metric your edit improves (A3 law).
Rules: fitness is OPERATOR POWER (verbs reachable, state fast, honest errors, findable controls), never decoration.
${BONUS_MANDATE}`;

const CANDIDATE_PROMPT = `Apply this bounded directive to the base HTML page. Return ONLY the complete HTML document.
Laws: every operator control marked data-atelier-control="<name>"; every panel marked
data-atelier-panel="<name>"; every panel ALSO carries data-atelier-error-state="<panel>"
(an honest error/degraded placeholder, hidden by default). Single file, no external
scripts except CDN <script src>. Never remove existing controls.`;

const CRITIQUE_PROMPT = `Critique this operator GUI (HTML below) against the spec. Return a JSON array; each item:
{"element":"which control/panel","defect":"what fails the operator","mechanicalFix":"the concrete fix"}.
Be specific and element-anchored — rationale content is the asset, scores are worthless.
You MAY append ONE system-level observation as {"element":"#system","defect":"...","mechanicalFix":"..."}
when you spot an improvement to the loop, pipeline, or harness itself — bonus credit.
${BONUS_MANDATE}`;

export type GovernedTransportRunner = <T>(input: {
  role: 'generator' | 'evaluator' | 'harness' | 'studio';
  idempotencyKey: string;
  binding: unknown;
  identity: string;
  effect: () => Promise<T>;
}) => Promise<T>;

export class LlmAtelierTransports {
  readonly brain: AtelierTransport;
  readonly generator: AtelierTransport;
  readonly eyes: readonly AtelierTransport[];

  constructor(input: { brain: AtelierCompletionClient; generator: AtelierCompletionClient; eyes: readonly AtelierCompletionClient[];
    governedRun: GovernedTransportRunner }) {
    const run = input.governedRun;
    const complete = async (role: Parameters<GovernedTransportRunner>[0]['role'],
      client: AtelierCompletionClient, system: string, user: string): Promise<string> => {
      const response = await run({
        role, idempotencyKey: `atelier-${role}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        binding: { system: system.slice(0, 120), prompt: user.slice(0, 2000) },
        identity: `${client.getConfig().provider ?? 'configured'}/${client.getConfig().model}`,
        effect: () => client.complete({ systemPrompt: system, prompt: user }),
      });
      if (!response.success) {
        throw new Error(`ATELIER_TRANSPORT_FAILED (${response.provider ?? '?'}/${response.model ?? '?'}): ${response.error ?? 'unknown error'}`);
      }
      return response.text ?? '';
    };
    this.brain = {
      label: 'brain',
      async authorDirective({ nicheKey, incumbents, librarySummaries }) {
        const text = await complete('harness', input.brain, DIRECTIVE_PROMPT,
          `nicheKey=${nicheKey}\nincumbentMetrics=${incumbents.join(';') || 'none'}\nlibrary=${librarySummaries.join(',') || 'empty'}`);
        const directive = parseJson(text, directiveSchema, 'directive');
        return {
          ...directive,
          nicheKey,
          authoredBy: 'glm-brain', createdAt: new Date().toISOString(),
        };
      },
      // Each seat exposes only its assigned role; unsupported calls fail explicitly.
      generateCandidate() { return Promise.reject(new Error('brain does not generate')); },
      critique() { return Promise.reject(new Error('brain does not critique')); },
      probe() { return Promise.reject(new Error('brain does not probe')); },
    };
    this.generator = {
      label: 'generator',
      authorDirective() { return Promise.reject(new Error('generator does not author')); },
      async generateCandidate({ directive, baseHtml }) {
        const text = await complete('generator', input.generator, CANDIDATE_PROMPT,
          `DIRECTIVE: ${directive.boundedEdit} (verify via ${directive.verifyingMetric})\n\nBASE PAGE:\n${baseHtml}`);
        const html = responseBody(text);
        if (!/^(?:<!doctype\s+html[^>]*>\s*)?<html(?:\s|>)/i.test(html) || !/<\/html\s*>\s*$/i.test(html)) {
          throw new Error('ATELIER_INVALID_RESPONSE (candidate HTML)');
        }
        return html;
      },
      critique() { return Promise.reject(new Error('generator does not critique')); },
      probe() { return Promise.reject(new Error('generator does not probe')); },
    };
    this.eyes = input.eyes.map((eye, index) => ({
      label: `eye-${index}`,
      authorDirective() { return Promise.reject(new Error('eyes do not author')); },
      generateCandidate() { return Promise.reject(new Error('eyes do not generate')); },
      async critique({ html, specBrief, controls }) {
        const text = await complete('evaluator', eye, CRITIQUE_PROMPT,
          `SPEC: ${specBrief}\nREQUIRED CONTROLS: ${controls.join(', ')}\n\nHTML:\n${html.slice(0, 24000)}`);
        return parseJson(text, critiqueSchema, 'critique')
          .map(critique => ({ ...critique, vendor: `eye-${index}` }));
      },
      async probe({ html, control }) {
        const text = await complete('evaluator', eye,
          'Grounding probe. Answer strictly YES or NO only.',
          `Does this HTML render a control marked data-atelier-control="${control}" that is visible to the operator? Answer YES or NO.\n\n${html.slice(0, 24000)}`);
        // Models answer "Yes." or "No!"; trailing sentence punctuation is not ambiguity (#1709).
        // Anything beyond the bare word still throws (#1491: "NO, do not answer YES").
        const answer = text.trim().replace(/[.!]+$/, '').toUpperCase();
        if (answer !== 'YES' && answer !== 'NO') throw new Error('ATELIER_INVALID_RESPONSE (probe)');
        return answer === 'YES';
      },
    }));
  }
}
