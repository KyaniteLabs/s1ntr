import { createHash, randomBytes } from 'node:crypto';
import type { RenderDomain } from '../render/HeadlessRenderer.js';

const DIGEST = /^[a-f0-9]{64}$/;

function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map(
    key => `${JSON.stringify(key)}:${canonical(record[key])}`,
  ).join(',')}}`;
}

function digest(value: unknown): string {
  return createHash('sha256').update(typeof value === 'string' ? value : canonical(value))
    .digest('hex');
}

export interface PinnedPluginManifest {
  readonly schema: 'sinter.pinned-plugin';
  readonly schemaVersion: 1;
  readonly id: string;
  readonly version: string;
  readonly entryDigest: string;
  readonly domains: readonly RenderDomain[];
  readonly permissions: readonly ['generate'];
  readonly manifestDigest: string;
}

export interface PluginOperationCapability {
  readonly operationId: string;
  readonly pluginId: string;
  readonly manifestDigest: string;
  readonly domain: RenderDomain;
  readonly expiresAt: number;
  readonly nonce: string;
}

export function createPinnedPluginManifest(input: Omit<PinnedPluginManifest,
'schema' | 'schemaVersion' | 'permissions' | 'manifestDigest'>): PinnedPluginManifest {
  if (!input.id.trim() || !input.version.trim() || !DIGEST.test(input.entryDigest)
    || input.domains.length < 1) throw new Error('PINNED_PLUGIN_MANIFEST_INVALID');
  const body = Object.freeze({ schema: 'sinter.pinned-plugin' as const,
    schemaVersion: 1 as const, ...input, permissions: ['generate'] as const });
  return Object.freeze({ ...body, manifestDigest: digest(body) });
}

export function createPluginOperationAuthority(): {
  issue(input: Omit<PluginOperationCapability, 'nonce'>): PluginOperationCapability;
  assert(capability: PluginOperationCapability): void;
} {
  const grants = new WeakMap<object, string>();
  return Object.freeze({
    issue(input: Omit<PluginOperationCapability, 'nonce'>) {
      if (!input.operationId.trim() || input.expiresAt <= Date.now()
        || !DIGEST.test(input.manifestDigest)) throw new Error('PLUGIN_CAPABILITY_INVALID');
      const capability = Object.freeze({ ...input, nonce: randomBytes(32).toString('hex') });
      grants.set(capability, digest(capability));
      return capability;
    },
    assert(capability: PluginOperationCapability) {
      if (grants.get(capability) !== digest(capability) || capability.expiresAt <= Date.now()) {
        throw new Error('PLUGIN_CAPABILITY_INVALID');
      }
    },
  });
}

export interface PinnedPluginWorkload {
  readonly operationId: string;
  readonly pluginId: string;
  readonly domain: RenderDomain;
  readonly source: string;
  readonly manifestDigest: string;
  readonly entryDigest: string;
}

/** Validates a plugin contribution; it owns no renderer, provider, or learning writer. */
export class GovernedPluginGate {
  constructor(private readonly assertCapability:
    (capability: PluginOperationCapability) => void) {}

  admit(manifest: PinnedPluginManifest, capability: PluginOperationCapability,
    source: string): PinnedPluginWorkload {
    this.assertCapability(capability);
    const { manifestDigest, ...manifestBody } = manifest;
    if (digest(manifestBody) !== manifestDigest
      || digest(source) !== manifest.entryDigest
      || capability.pluginId !== manifest.id
      || capability.manifestDigest !== manifestDigest
      || !manifest.domains.includes(capability.domain)) {
      throw new Error('PINNED_PLUGIN_BINDING_INVALID');
    }
    const suspicious = canonical(manifest).toLowerCase();
    if (suspicious.includes('teachingcontext') || suspicious.includes('learningwrite')) {
      throw new Error('PLUGIN_UNCLASSIFIED_TEACHING_CONTEXT');
    }
    return Object.freeze({ operationId: capability.operationId, pluginId: manifest.id,
      domain: capability.domain, source, manifestDigest, entryDigest: manifest.entryDigest });
  }
}
