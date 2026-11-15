import { createHash } from 'node:crypto';
import type { ProviderRequest } from './ProviderTypes.js';

/** Canonical digest of every provider request field that can affect model output. */
export function providerRequestDigest(req: ProviderRequest): string {
  return createHash('sha256').update(JSON.stringify({
    systemPrompt: req.systemPrompt,
    userPrompt: req.userPrompt,
    temperature: req.temperature ?? null,
    maxTokens: req.maxTokens ?? null,
    thinking: req.thinking ?? null,
    tools: req.tools ?? null,
    toolResults: req.toolResults ?? null,
    imageInputs: req.imageInputs?.map(image => ({ ...image,
      dataBase64: createHash('sha256').update(image.dataBase64).digest('hex'),
    })) ?? null,
    jsonMode: req.jsonMode ?? false,
  })).digest('hex');
}
