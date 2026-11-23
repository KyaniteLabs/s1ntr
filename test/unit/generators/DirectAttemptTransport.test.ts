import { afterEach, describe, expect, it, vi } from 'vitest';
import { KineticGenerator } from '../../../src/generators/kinetic/KineticGenerator.js';
import { SVGGenerator } from '../../../src/generators/svg/SVGGenerator.js';
import { ToneGenerator } from '../../../src/generators/tone/ToneGenerator.js';
import { LLMClient } from '../../../src/llm/LLMClient.js';
import { dispatcherFor } from '../../../src/llm/providerFetch.js';
import * as urlValidator from '../../../src/security/UrlValidator.js';

type TimedFetchInit = RequestInit & { dispatcher?: unknown };

const kinetic = '<!DOCTYPE html><html><head><meta charset="utf-8"><title>Drift study</title><style>body { background: #0a0e1a; color: white; } .word { animation: drift 2s infinite; font-size: 4em; } @keyframes drift { from { transform: translateX(0); } to { transform: translateX(10px); } }</style></head><body><div class="word">hello</div></body></html>';
const tone = '<!DOCTYPE html><html><head><title>Tone Patch</title></head><body><button id="start">Start</button><script>document.getElementById("start").onclick=async()=>{await Tone.start();Tone.Transport.bpm.value=84;new Tone.Synth().toDestination().triggerAttackRelease("C4","8n");};</script></body></html>';
const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><circle cx="32" cy="32" r="18"/></svg>';

function stubProvider(outputs: string[]) {
  vi.spyOn(urlValidator, 'validateUrl').mockResolvedValue(undefined);
  const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async (url, init) => {
    if (init?.method !== 'POST') return Response.json({ data: [{ id: 'glm-5.3' }] });
    const content = outputs.shift();
    if (String(url).endsWith('/messages')) {
      return Response.json({ content: [{ type: 'text', text: content }], stop_reason: 'end_turn' });
    }
    return Response.json({ choices: [{ message: { content }, finish_reason: 'stop' }] });
  });
  vi.stubGlobal('fetch', fetch);
  return () => fetch.mock.calls.filter(([, init]) => init?.method === 'POST');
}

describe('direct generator transport', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it.each([
    { Generator: KineticGenerator, content: kinetic, temperature: 0.1, maxTokens: 4000 },
    { Generator: ToneGenerator, content: tone, temperature: 0.2, maxTokens: 1600 },
  ])('routes $Generator.name MiniMax direct calls to the OpenAI-compatible endpoint', async ({
    Generator, content, temperature, maxTokens,
  }) => {
    vi.stubEnv('SINTER_KINETIC_DIRECT_TIMEOUT_MS', '120000');
    const posts = stubProvider([content]);
    const client = new LLMClient({
      baseUrl: 'https://api.minimax.io/anthropic', model: 'MiniMax-M2.7', timeout: 600_000,
    });

    await expect(new Generator(client).generate('small motion study')).resolves.toContain('<body');
    expect(posts()).toHaveLength(1);
    const [url, init] = posts()[0];
    expect(url).toBe('https://api.minimax.io/v1/chat/completions');
    expect(JSON.parse(String(init?.body))).toMatchObject({ temperature, max_tokens: maxTokens });
    expect((init as TimedFetchInit).dispatcher).toBe(dispatcherFor(120_000));
  });

  it.each([
    { Generator: KineticGenerator, content: kinetic, attempts: 1 },
    { Generator: ToneGenerator, content: tone, attempts: 3 },
    { Generator: SVGGenerator, content: svg, attempts: 3 },
  ])('bounds all $Generator.name direct attempts despite a long generator deadline', async ({
    Generator, content, attempts,
  }) => {
    vi.stubEnv('SINTER_LLM_TIMEOUT_MS', '600000');
    vi.stubEnv('SINTER_KINETIC_DIRECT_TIMEOUT_MS', '');
    const posts = stubProvider([...Array<string>(attempts - 1).fill('invalid artifact'), content]);
    const client = new LLMClient({
      baseUrl: 'http://127.0.0.1:1234/v1', model: 'glm-5.3', timeout: 600_000,
    });

    const artifact = await new Generator(client).generate('small motion study');
    expect(artifact).toContain(content.startsWith('<svg') ? '<circle' : '<body');
    expect(posts()).toHaveLength(attempts);
    for (const [, init] of posts()) {
      expect((init as TimedFetchInit).dispatcher).toBe(dispatcherFor(60_000));
    }
  });
});
