/**
 * DecisionModelClient - typed calls to decision models (Liquid AI d1 family).
 *
 * A decision model is not an LLM. It never generates tokens: one forward pass
 * answers named, typed questions about a `state` (text plus optional images)
 * with calibrated outputs. LLMClient refuses these models, so this is their
 * only way in.
 *
 * Transport: the llama.cpp server route `POST <baseUrl>/v1/systemone` with body
 * `{ state, images, questions }`, answering `{ answers: { <name>: ... } }`
 * (docs.liquid.ai/lfm/models/d1-2b). That route supports only `noul`
 * (P(yes)), single `choice` and `score` questions, so other types are refused
 * before any network call rather than sent and misread.
 *
 * Every answer is validated. A missing or malformed answer is an error, never a
 * neutral default: a decision seat must not silently "decide" 0.5.
 */

import { CapabilityRegistry } from './CapabilityRegistry.js';

export type DecisionQuestion =
  | { readonly type: 'noul'; readonly instructions: string }
  | { readonly type: 'choice'; readonly instructions: string;
    readonly criteria: Readonly<Record<string, string>> }
  | { readonly type: 'score'; readonly instructions: string;
    readonly criteria: readonly string[] };

export type DecisionAnswer =
  | { readonly type: 'noul'; readonly probability: number }
  | { readonly type: 'choice'; readonly choice: string;
    readonly probabilities?: Readonly<Record<string, number>> }
  | { readonly type: 'score'; readonly score: number; readonly label: string };

export interface DecisionImage {
  readonly mimeType: string;
  readonly data: Buffer;
}

export interface DecisionRequest {
  readonly state: string;
  readonly questions: Readonly<Record<string, DecisionQuestion>>;
  readonly images?: readonly DecisionImage[];
}

export interface DecisionResult {
  readonly model: string;
  readonly answers: Readonly<Record<string, DecisionAnswer>>;
}

export interface DecisionModelClientConfig {
  readonly baseUrl: string;
  readonly model: string;
  readonly timeoutMs?: number;
  /** Injected for tests; defaults to global fetch. */
  readonly fetchImpl?: typeof fetch;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const SUPPORTED_TYPES = new Set(['noul', 'choice', 'score']);

export class DecisionModelClient {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly config: DecisionModelClientConfig) {
    if (!config.model || !CapabilityRegistry.isDecisionModel(config.model)) {
      throw new Error(`DECISION_MODEL_KIND_MISMATCH: ${config.model || '(empty)'} is not a decision model`);
    }
    if (!/^https?:\/\//.test(config.baseUrl ?? '')) {
      throw new Error(`DECISION_MODEL_BASE_URL_INVALID: ${config.baseUrl || '(empty)'}`);
    }
    this.baseUrl = config.baseUrl.replace(/\/+$/, '').replace(/\/v1$/, '');
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetchImpl = config.fetchImpl ?? fetch;
  }

  get model(): string {
    return this.config.model;
  }

  async decide(request: DecisionRequest): Promise<DecisionResult> {
    validateRequest(request);
    const body = {
      state: request.state,
      images: (request.images ?? []).map(image =>
        `data:${image.mimeType};base64,${image.data.toString('base64')}`),
      questions: request.questions,
    };
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}/v1/systemone`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      throw new Error(`DECISION_TRANSPORT_FAILED: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!response.ok) {
      throw new Error(`DECISION_TRANSPORT_FAILED: HTTP ${response.status}`);
    }
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new Error('DECISION_RESPONSE_INVALID: body is not JSON');
    }
    return { model: this.config.model, answers: parseAnswers(payload, request.questions) };
  }
}

function validateRequest(request: DecisionRequest): void {
  if (typeof request.state !== 'string' || request.state.trim() === '') {
    throw new Error('DECISION_REQUEST_INVALID: state must be non-empty text');
  }
  const entries = Object.entries(request.questions ?? {});
  if (entries.length === 0) throw new Error('DECISION_REQUEST_INVALID: at least one question is required');
  for (const [name, question] of entries) {
    if (!SUPPORTED_TYPES.has(question?.type)) {
      throw new Error(`DECISION_QUESTION_UNSUPPORTED: ${name} has type ${String(question?.type)}; /v1/systemone serves noul, choice, score`);
    }
    if (!question.instructions?.trim()) {
      throw new Error(`DECISION_REQUEST_INVALID: ${name} has no instructions`);
    }
    if (question.type === 'choice' && Object.keys(question.criteria ?? {}).length < 2) {
      throw new Error(`DECISION_REQUEST_INVALID: ${name} choice needs at least two options`);
    }
    if (question.type === 'score' && (question.criteria?.length ?? 0) < 2) {
      throw new Error(`DECISION_REQUEST_INVALID: ${name} score needs at least two labels`);
    }
  }
}

function isProbability(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
}

function parseAnswers(payload: unknown,
  questions: Readonly<Record<string, DecisionQuestion>>): Record<string, DecisionAnswer> {
  const answers = (payload as { answers?: unknown } | null)?.answers;
  if (!answers || typeof answers !== 'object') {
    throw new Error('DECISION_RESPONSE_INVALID: missing answers object');
  }
  const out: Record<string, DecisionAnswer> = {};
  for (const [name, question] of Object.entries(questions)) {
    const raw = (answers as Record<string, unknown>)[name] as Record<string, unknown> | undefined;
    if (!raw || typeof raw !== 'object') throw new Error(`DECISION_ANSWER_MISSING: ${name}`);
    out[name] = parseAnswer(name, question, raw);
  }
  return out;
}

function parseAnswer(name: string, question: DecisionQuestion,
  raw: Record<string, unknown>): DecisionAnswer {
  const bad = (why: string): never => { throw new Error(`DECISION_ANSWER_INVALID: ${name} ${why}`); };
  switch (question.type) {
    case 'noul':
      if (!isProbability(raw.noul)) bad('noul is not a probability in [0,1]');
      return { type: 'noul', probability: raw.noul as number };
    case 'choice': {
      const choice = raw.choice;
      if (typeof choice !== 'string' || !(choice in question.criteria)) bad('choice is not one of the options');
      const probabilities = raw.probabilities;
      if (probabilities !== undefined) {
        if (!probabilities || typeof probabilities !== 'object'
          || !Object.values(probabilities).every(isProbability)) bad('probabilities are not all in [0,1]');
        return { type: 'choice', choice: choice as string,
          probabilities: probabilities as Record<string, number> };
      }
      return { type: 'choice', choice: choice as string };
    }
    case 'score': {
      const score = raw.score;
      if (typeof score !== 'number' || !Number.isFinite(score)) bad('score is not a finite number');
      const legend = raw.legend as Record<string, unknown> | undefined;
      const label = legend?.[String(Math.trunc(score as number))];
      if (typeof label !== 'string' || !question.criteria.includes(label)) bad('score does not map to a label');
      return { type: 'score', score: score as number, label: label as string };
    }
  }
}
