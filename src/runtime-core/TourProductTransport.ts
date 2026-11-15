import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import type { LLMClient } from '../llm/LLMClient.js';
import { productPurposeForRole } from '../llm/LLMClient.js';
import type { LiminalRole } from './LiminalCommandService.js';
import { createProductionLiminalRuntime, type ProductionLiminalRuntime } from './ProductionLiminalRuntime.js';

const TRANSPORT_METHODS = [
  'generate', 'complete', 'generateWithImages', 'generateWithTools', 'generateWithToolLoop',
] as const;

type TourClient = LLMClient & { __tourProductBound?: boolean };

const inflight = new Map<string, Promise<ProductionLiminalRuntime>>();

export function tourProductRuntimeRoot(
  env: NodeJS.ProcessEnv = process.env, cwd = process.cwd(),
): string {
  const stamp = env.LIMINAL_WAVE_STAMP || 'unstamped';
  const wave = env.LIMINAL_TOUR_WAVE || '2';
  return path.resolve(cwd, '.quality', 'tour', `wave-${wave}`, stamp, 'product-runtime');
}

export async function getTourProductRuntime(): Promise<ProductionLiminalRuntime> {
  const root = tourProductRuntimeRoot();
  const existing = inflight.get(root);
  if (existing) return existing;
  const created = (async () => {
    await mkdir(root, { recursive: true });
    return createProductionLiminalRuntime({ root });
  })();
  inflight.set(root, created);
  try {
    return await created;
  } catch (error) {
    inflight.delete(root);
    throw error;
  }
}

/** Wrap live tour LLM methods in a journal-reserved product grant for the client role. */
export function attachTourProductRoleTransport<T extends LLMClient>(client: T): T {
  const role = client.getRole();
  if (!productPurposeForRole(role)) return client;
  const bound = client as TourClient;
  if (bound.__tourProductBound) return client;
  bound.__tourProductBound = true;
  for (const method of TRANSPORT_METHODS) {
    const original = (client as unknown as Record<string, unknown>)[method];
    if (typeof original !== 'function') continue;
    (client as unknown as Record<string, unknown>)[method] = async (...args: unknown[]) => {
      const runtime = await getTourProductRuntime();
      return runtime.port.runResearchProviderEffect({
        idempotencyKey: `tour-product:${role}:${method}:${randomUUID()}`,
        binding: { surface: 'tour', role, method },
        identity: `${role}:${client.getConfig().model}`,
        role: role as LiminalRole,
        maxTransportAttempts: 1,
        effect: () => Promise.resolve(
          (original as (...inner: unknown[]) => unknown).apply(client, args)),
      });
    };
  }
  return client;
}
