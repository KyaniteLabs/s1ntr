import { describe, it, expect, vi } from 'vitest';

import { DecisionModelClient } from '../../../src/llm/DecisionModelClient.js';
import type { DecisionRequest } from '../../../src/llm/DecisionModelClient.js';

const BASE = 'http://127.0.0.1:9931';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function client(fetchImpl: typeof fetch, baseUrl = BASE): DecisionModelClient {
  return new DecisionModelClient({ baseUrl, model: 'LiquidAI/d1-2B', fetchImpl, timeoutMs: 1_000, sleepImpl: async () => {} });
}

const request: DecisionRequest = {
  state: 'A render of a calm blue gradient with slow drifting particles.',
  questions: {
    valid: { type: 'noul', instructions: 'Is the render a non-blank, coherent image?' },
    mood: { type: 'choice', instructions: 'Which mood fits?', criteria: { calm: 'Calm, slow', tense: 'Tense, fast' } },
    quality: { type: 'score', instructions: 'Rate visual quality.', criteria: ['poor', 'fair', 'good', 'excellent'] },
  },
};

const goodAnswers = {
  answers: {
    valid: { noul: 0.93 },
    mood: { choice: 'calm', probabilities: { calm: 0.81, tense: 0.19 } },
    quality: { score: 2.4, legend: { '0': 'poor', '1': 'fair', '2': 'good', '3': 'excellent' } },
  },
  usage: { prompt_tokens: 40 },
};

describe('DecisionModelClient', () => {
  it('posts the systemone contract and returns typed answers', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(goodAnswers));
    const result = await client(fetchImpl as unknown as typeof fetch, `${BASE}/v1/`).decide({
      ...request, images: [{ mimeType: 'image/png', data: Buffer.from('png-bytes') }] });

    expect(result).toEqual({
      model: 'LiquidAI/d1-2B',
      answers: {
        valid: { type: 'noul', probability: 0.93 },
        mood: { type: 'choice', choice: 'calm', probabilities: { calm: 0.81, tense: 0.19 } },
        quality: { type: 'score', score: 2.4, label: 'good' },
      },
    });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`${BASE}/v1/systemone`);
    const body = JSON.parse(String(init.body));
    expect(body.images).toEqual([`data:image/png;base64,${Buffer.from('png-bytes').toString('base64')}`]);
    expect(body.questions.quality.criteria).toEqual(['poor', 'fair', 'good', 'excellent']);
  });

  it('refuses generative models and bad endpoints at construction', () => {
    expect(() => new DecisionModelClient({ baseUrl: BASE, model: 'LiquidAI/LFM3-1.7B' }))
      .toThrow('DECISION_MODEL_KIND_MISMATCH: LiquidAI/LFM3-1.7B is not a decision model');
    expect(() => new DecisionModelClient({ baseUrl: BASE, model: '' }))
      .toThrow('DECISION_MODEL_KIND_MISMATCH: (empty) is not a decision model');
    expect(() => new DecisionModelClient({ baseUrl: 'ftp://x', model: 'd1-2b' }))
      .toThrow('DECISION_MODEL_BASE_URL_INVALID: ftp://x');
  });

  it.each([
    [{ ...request, state: '  ' }, 'DECISION_REQUEST_INVALID: state must be non-empty text'],
    [{ ...request, questions: {} }, 'DECISION_REQUEST_INVALID: at least one question is required'],
    [{ ...request, questions: { q: { type: 'noul', instructions: '' } } }, 'DECISION_REQUEST_INVALID: q has no instructions'],
    [{ ...request, questions: { q: { type: 'choice', instructions: 'x', criteria: { only: 'one' } } } },
      'DECISION_REQUEST_INVALID: q choice needs at least two options'],
    [{ ...request, questions: { q: { type: 'score', instructions: 'x', criteria: ['one'] } } },
      'DECISION_REQUEST_INVALID: q score needs at least two labels'],
    [{ ...request, questions: { q: { type: 'text', instructions: 'x' } } },
      'DECISION_QUESTION_UNSUPPORTED: q has type text; /v1/systemone serves noul, choice, score'],
  ])('rejects an invalid request before any network call (%#)', async (bad, message) => {
    const fetchImpl = vi.fn();
    await expect(client(fetchImpl as unknown as typeof fetch).decide(bad as DecisionRequest)).rejects.toThrow(message);
    expect(fetchImpl.mock.calls.length).toBe(0);
  });

  it('reports network errors, timeouts and HTTP failures as transport failures', async () => {
    await expect(client((async () => { throw new Error('ECONNREFUSED'); }) as unknown as typeof fetch).decide(request))
      .rejects.toThrow('DECISION_TRANSPORT_FAILED: ECONNREFUSED');
    const hang = ((_url: string, init: RequestInit) => new Promise((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => reject(init.signal?.reason));
    })) as unknown as typeof fetch;
    await expect(new DecisionModelClient({ baseUrl: BASE, model: 'd1-2b', fetchImpl: hang, timeoutMs: 20 }).decide(request))
      .rejects.toThrow(/^DECISION_TRANSPORT_FAILED: .*(timeout|aborted)/i);
    await expect(client((async () => jsonResponse({}, 503)) as unknown as typeof fetch).decide(request))
      .rejects.toThrow('DECISION_TRANSPORT_FAILED: HTTP 503');
  });

  it('never invents a neutral answer for a missing or malformed one', async () => {
    const respond = (body: unknown) => client((async () =>
      typeof body === 'string' ? new Response(body) : jsonResponse(body)) as unknown as typeof fetch).decide(request);
    await expect(respond('not json')).rejects.toThrow('DECISION_RESPONSE_INVALID: body is not JSON');
    await expect(respond({ usage: {} })).rejects.toThrow('DECISION_RESPONSE_INVALID: missing answers object');
    const { valid: _dropped, ...rest } = goodAnswers.answers;
    await expect(respond({ answers: rest })).rejects.toThrow('DECISION_ANSWER_MISSING: valid');
    await expect(respond({ answers: { ...goodAnswers.answers, valid: { noul: 1.2 } } }))
      .rejects.toThrow('DECISION_ANSWER_INVALID: valid noul is not a probability in [0,1]');
    await expect(respond({ answers: { ...goodAnswers.answers, mood: { choice: 'angry' } } }))
      .rejects.toThrow('DECISION_ANSWER_INVALID: mood choice is not one of the options');
    await expect(respond({ answers: { ...goodAnswers.answers, mood: { choice: 'calm', probabilities: { calm: 'high' } } } }))
      .rejects.toThrow('DECISION_ANSWER_INVALID: mood probabilities are not all in [0,1]');
    await expect(respond({ answers: { ...goodAnswers.answers, quality: { score: null } } }))
      .rejects.toThrow('DECISION_ANSWER_INVALID: quality score is not a finite number');
    await expect(respond({ answers: { ...goodAnswers.answers, quality: { score: 7, legend: { '7': 'superb' } } } }))
      .rejects.toThrow('DECISION_ANSWER_INVALID: quality score does not map to a label');
  });

  it('accepts a choice answer without probabilities', async () => {
    const result = await client((async () => jsonResponse({ answers: { ...goodAnswers.answers,
      mood: { choice: 'tense' } } })) as unknown as typeof fetch).decide(request);
    expect(result.answers.mood).toEqual({ type: 'choice', choice: 'tense' });
  });
});
