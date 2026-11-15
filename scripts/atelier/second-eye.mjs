// Second vision eye for `sinter sss-score` — config-driven, default unchanged.
//
// The sss-score ensemble runs the configured evaluator eye plus two fixed
// eyes: this second vision eye and glm-5.3-flash. Until 2026-11-12 the second
// eye was hardcoded to minimax-m3 (provider minimax, anthropic wire), so
// pointing the ensemble at another vision model required a code change while
// MiniMax lanes sat behind a spend wall.
//
// Config (all keys optional; absent = the historical hardcode, byte-identical):
//
//   {
//     "sssScore": {
//       "secondEye": {
//         "provider": "glm",               // provider key in providers{} for key + endpoint
//         "model": "glm-4.6v",             // model id sent on the wire
//         "baseUrl": "https://…/anthropic",// optional endpoint override
//         "wire": "anthropic" | "openai",  // optional; inferred from the endpoint
//         "maxTokens": 1500                // optional; default 1500
//       }
//     }
//   }
//
// Default (no `sssScore.secondEye`): provider minimax, model minimax-m3,
// endpoint https://api.minimax.io/anthropic, max_tokens 1500 — exactly what
// bin/sinter hardcoded before this module existed.

/** The pre-2026-11-12 hardcode, preserved as the default. */
export const DEFAULT_SECOND_EYE = Object.freeze({
  provider: 'minimax',
  model: 'minimax-m3',
  baseUrl: 'https://api.minimax.io/anthropic',
  maxTokens: 1500,
});

// MiniMax's GENERATION wire is /v1 (OpenAI shape), but its JUDGE lane is
// probe-verified only on the anthropic wire: /v1 returns 4096/4096
// reasoning_tokens think-only on art briefs (probes 2026-10-10). A config that
// names {provider:'minimax'} without an endpoint therefore keeps the anthropic
// judge endpoint instead of inheriting providers.minimax.baseUrl.
const PROVIDER_JUDGE_BASE = Object.freeze({
  minimax: 'https://api.minimax.io/anthropic',
});

const DEFAULT_MAX_TOKENS = 1500;

function trimBase(value) {
  return String(value || '').trim().replace(/\/+$/, '');
}

function inferWire(baseUrl, explicitWire) {
  const wire = String(explicitWire || '').trim().toLowerCase();
  if (wire) {
    if (wire !== 'anthropic' && wire !== 'openai') {
      throw new Error(`SSS_SCORE_SECOND_EYE_BAD_WIRE: ${wire} (expected anthropic|openai)`);
    }
    return wire;
  }
  // `https://api.z.ai/api/anthropic`, `https://api.anthropic.com/v1` and
  // `https://api.minimax.io/anthropic` are all anthropic-wire endpoints.
  return /(^|[./])anthropic([./]|$)/i.test(baseUrl) ? 'anthropic' : 'openai';
}

/** Join an endpoint base with a wire path, tolerating a `/v1` base suffix. */
function wireUrl(base, wire) {
  if (wire === 'anthropic') {
    if (/\/v1\/messages$/i.test(base)) return base;
    if (/\/v1$/i.test(base)) return `${base}/messages`;
    return `${base}/v1/messages`;
  }
  return /\/chat\/completions$/i.test(base) ? base : `${base}/chat/completions`;
}

/**
 * Resolve the configurable second vision eye.
 *
 * @param {Record<string, any>} config parsed ~/.sinter/config.json
 * @returns {{provider:string, model:string, baseUrl:string, wire:'anthropic'|'openai',
 *            maxTokens:number, apiKey:string, configured:boolean}}
 */
export function resolveSecondEye(config) {
  const raw = config?.sssScore?.secondEye;
  if (raw === undefined || raw === null) {
    const providers = config?.providers || {};
    return {
      ...DEFAULT_SECOND_EYE,
      wire: inferWire(DEFAULT_SECOND_EYE.baseUrl),
      apiKey: String(providers.minimax?.apiKey || ''),
      configured: false,
    };
  }
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('SSS_SCORE_SECOND_EYE_INVALID: sssScore.secondEye must be an object');
  }
  const provider = String(raw.provider || '').trim().toLowerCase();
  const model = String(raw.model || '').trim();
  if (!provider) throw new Error('SSS_SCORE_SECOND_EYE_NO_PROVIDER: sssScore.secondEye.provider is required');
  if (!model) throw new Error('SSS_SCORE_SECOND_EYE_NO_MODEL: sssScore.secondEye.model is required');

  const providerCfg = config?.providers?.[provider] || {};
  const baseUrl = trimBase(raw.baseUrl || PROVIDER_JUDGE_BASE[provider] || providerCfg.baseUrl);
  if (!baseUrl) {
    throw new Error(`SSS_SCORE_SECOND_EYE_NO_BASEURL: provider ${provider} has no baseUrl — set sssScore.secondEye.baseUrl`);
  }
  const maxTokens = Number.isFinite(Number(raw.maxTokens)) && Number(raw.maxTokens) > 0
    ? Math.floor(Number(raw.maxTokens))
    : DEFAULT_MAX_TOKENS;
  return {
    provider,
    model,
    baseUrl,
    wire: inferWire(baseUrl, raw.wire),
    maxTokens,
    apiKey: String(providerCfg.apiKey || ''),
    configured: true,
  };
}

/**
 * Build the judge request for the second eye. The wire shape follows the
 * endpoint: anthropic-compatible endpoints get image content blocks, anything
 * else gets the OpenAI chat-completions image_url shape.
 *
 * @param {{eye: {model:string, baseUrl:string, wire:string, maxTokens:number, apiKey:string},
 *          imageB64: string, prompt: string}} input
 * @returns {{url:string, headers:Record<string,string>, body:string}}
 */
export function buildSecondEyeRequest({ eye, imageB64, prompt }) {
  if (!eye || typeof eye !== 'object') throw new Error('SSS_SCORE_SECOND_EYE_MISSING');
  const base = trimBase(eye.baseUrl);
  if (!base) throw new Error('SSS_SCORE_SECOND_EYE_NO_BASEURL');
  const model = String(eye.model || '');
  if (!model) throw new Error('SSS_SCORE_SECOND_EYE_NO_MODEL');
  const maxTokens = Number.isFinite(Number(eye.maxTokens)) && Number(eye.maxTokens) > 0
    ? Math.floor(Number(eye.maxTokens))
    : DEFAULT_MAX_TOKENS;

  if (eye.wire === 'openai') {
    const headers = { 'Content-Type': 'application/json' };
    if (eye.apiKey) headers.Authorization = `Bearer ${eye.apiKey}`;
    return {
      url: wireUrl(base, 'openai'),
      headers,
      body: JSON.stringify({
        model,
        max_tokens: maxTokens,
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: prompt },
            { type: 'image_url', image_url: { url: `data:image/png;base64,${imageB64}` } },
          ],
        }],
      }),
    };
  }

  const headers = { 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' };
  if (eye.apiKey) headers['x-api-key'] = eye.apiKey;
  return {
    url: wireUrl(base, 'anthropic'),
    headers,
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: imageB64 } },
          { type: 'text', text: prompt },
        ],
      }],
    }),
  };
}
