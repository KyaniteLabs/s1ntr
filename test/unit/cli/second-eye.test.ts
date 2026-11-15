import { describe, expect, it } from 'vitest';
import { DEFAULT_SECOND_EYE, buildSecondEyeRequest, resolveSecondEye } from '../../../scripts/atelier/second-eye.mjs';

// The sss-score second vision eye was hardcoded to minimax-m3 until
// 2026-11-12. These tests pin both halves of the contract: the default is
// byte-identical to the old hardcode, and a configured non-minimax eye is the
// eye that actually runs (model, endpoint, wire and key all follow config).

const glmConfig = {
  providers: {
    glm: { baseUrl: 'https://api.z.ai/api/anthropic', apiKey: 'glm-test-key' },
    minimax: { baseUrl: 'https://api.minimax.io/v1', apiKey: 'mm-test-key' },
    local: { baseUrl: 'http://127.0.0.1:46406/v1' },
  },
  sssScore: { secondEye: { provider: 'glm', model: 'glm-4.6v' } },
};

describe('resolveSecondEye — config-driven second vision eye', () => {
  it('defaults to the pre-2026-11-12 hardcode when sssScore is absent', () => {
    const eye = resolveSecondEye({ providers: { minimax: { baseUrl: 'https://api.minimax.io/v1', apiKey: 'mm-test-key' } } });
    expect(eye.provider).toBe('minimax');
    expect(eye.model).toBe('minimax-m3');
    expect(eye.baseUrl).toBe('https://api.minimax.io/anthropic');
    expect(eye.wire).toBe('anthropic');
    expect(eye.maxTokens).toBe(1500);
    expect(eye.apiKey).toBe('mm-test-key');
    expect(eye.configured).toBe(false);
    expect(DEFAULT_SECOND_EYE).toEqual({ provider: 'minimax', model: 'minimax-m3', baseUrl: 'https://api.minimax.io/anthropic', maxTokens: 1500 });
  });

  it('runs the configured non-minimax eye: model, endpoint and key come from config', () => {
    const eye = resolveSecondEye(glmConfig);
    expect(eye.configured).toBe(true);
    expect(eye.provider).toBe('glm');
    expect(eye.model).toBe('glm-4.6v');
    expect(eye.baseUrl).toBe('https://api.z.ai/api/anthropic');
    expect(eye.wire).toBe('anthropic');
    expect(eye.apiKey).toBe('glm-test-key');
  });

  it('keeps the anthropic judge wire for an explicitly named minimax eye', () => {
    // providers.minimax.baseUrl is the /v1 generation wire (think-only judge
    // failures); naming minimax as the eye must not silently move the judge
    // onto that wire.
    const eye = resolveSecondEye({
      providers: { minimax: { baseUrl: 'https://api.minimax.io/v1', apiKey: 'k' } },
      sssScore: { secondEye: { provider: 'minimax', model: 'minimax-m3' } },
    });
    expect(eye.baseUrl).toBe('https://api.minimax.io/anthropic');
    expect(eye.wire).toBe('anthropic');
  });

  it('honours an explicit baseUrl/wire/maxTokens override', () => {
    const eye = resolveSecondEye({
      providers: { local: { baseUrl: 'http://127.0.0.1:9999/v1' } },
      sssScore: { secondEye: { provider: 'local', model: 'some-vl', baseUrl: 'https://proxy.example/v1', wire: 'openai', maxTokens: 900 } },
    });
    expect(eye.baseUrl).toBe('https://proxy.example/v1');
    expect(eye.wire).toBe('openai');
    expect(eye.maxTokens).toBe(900);
  });

  it('infers the openai wire from a non-anthropic endpoint and leaves keyless providers keyless', () => {
    const eye = resolveSecondEye({ providers: glmConfig.providers, sssScore: { secondEye: { provider: 'local', model: 'local-vl' } } });
    expect(eye.wire).toBe('openai');
    expect(eye.apiKey).toBe('');
    const request = buildSecondEyeRequest({ eye, imageB64: 'QUJD', prompt: 'judge' });
    expect(request.headers.Authorization).toBeUndefined();
  });

  it('fails loudly on an invalid config instead of falling back to minimax', () => {
    const bad = (secondEye: unknown) => () => resolveSecondEye({ providers: glmConfig.providers, sssScore: { secondEye } });
    expect(bad({ provider: 'glm' })).toThrow(/SSS_SCORE_SECOND_EYE_NO_MODEL/);
    expect(bad({ model: 'glm-4.6v' })).toThrow(/SSS_SCORE_SECOND_EYE_NO_PROVIDER/);
    expect(bad({ provider: 'nope', model: 'x' })).toThrow(/SSS_SCORE_SECOND_EYE_NO_BASEURL/);
    expect(bad({ provider: 'glm', model: 'glm-4.6v', wire: 'grpc' })).toThrow(/SSS_SCORE_SECOND_EYE_BAD_WIRE/);
    expect(bad('glm-4.6v')).toThrow(/SSS_SCORE_SECOND_EYE_INVALID/);
  });
});

describe('buildSecondEyeRequest — wire shape follows the endpoint', () => {
  const prompt = 'Judge this generative-art screenshot under the SPU-2.0 universal scale.';

  it('anthropic wire: image content block + prompt, configured model and token budget', () => {
    const eye = resolveSecondEye(glmConfig);
    const request = buildSecondEyeRequest({ eye, imageB64: 'QUJD', prompt });
    expect(request.url).toBe('https://api.z.ai/api/anthropic/v1/messages');
    expect(request.headers['x-api-key']).toBe('glm-test-key');
    expect(request.headers['anthropic-version']).toBe('2023-06-01');
    const body = JSON.parse(request.body);
    expect(body.model).toBe('glm-4.6v');
    expect(body.max_tokens).toBe(1500);
    expect(body.messages[0].content[0]).toEqual({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'QUJD' } });
    expect(body.messages[0].content[1]).toEqual({ type: 'text', text: prompt });
  });

  it('openai wire: image_url data URL + bearer auth', () => {
    const eye = { model: 'local-vl', baseUrl: 'http://127.0.0.1:4000/v1', wire: 'openai', maxTokens: 800, apiKey: 'local-key' };
    const request = buildSecondEyeRequest({ eye, imageB64: 'QUJD', prompt });
    expect(request.url).toBe('http://127.0.0.1:4000/v1/chat/completions');
    expect(request.headers.Authorization).toBe('Bearer local-key');
    const body = JSON.parse(request.body);
    expect(body.model).toBe('local-vl');
    expect(body.max_tokens).toBe(800);
    expect(body.messages[0].content[1]).toEqual({ type: 'image_url', image_url: { url: 'data:image/png;base64,QUJD' } });
  });

  it('accepts endpoints that already end in the wire path', () => {
    const anth = buildSecondEyeRequest({ eye: { model: 'm', baseUrl: 'https://host/anthropic/v1/messages', wire: 'anthropic', maxTokens: 1500, apiKey: '' }, imageB64: 'QUJD', prompt });
    expect(anth.url).toBe('https://host/anthropic/v1/messages');
    const oai = buildSecondEyeRequest({ eye: { model: 'm', baseUrl: 'https://host/v1/chat/completions', wire: 'openai', maxTokens: 1500, apiKey: '' }, imageB64: 'QUJD', prompt });
    expect(oai.url).toBe('https://host/v1/chat/completions');
  });

  it('handles a /v1-suffixed anthropic base (api.anthropic.com) without doubling the version', () => {
    const eye = resolveSecondEye({
      providers: { anthropic: { baseUrl: 'https://api.anthropic.com/v1', apiKey: 'anthropic-key' } },
      sssScore: { secondEye: { provider: 'anthropic', model: 'claude-opus-4-1' } },
    });
    expect(eye.wire).toBe('anthropic');
    const request = buildSecondEyeRequest({ eye, imageB64: 'QUJD', prompt });
    expect(request.url).toBe('https://api.anthropic.com/v1/messages');
  });
});
