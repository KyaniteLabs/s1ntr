import type { DomainType, Layer } from './types.js';
import { DEFAULT_LAYER_CONFIG } from './types.js';

export const CONTROL_RECIPE_SCHEMA = 'sinter.control-recipe' as const;
export const CONTROL_RECIPE_VERSION = '2.0' as const;

export type ControlValueType = 'number' | 'string' | 'boolean';
export type StaleBehavior = 'hold' | 'zero' | 'drop' | 'error';

export interface ControlLayer {
  id: string;
  domain: DomainType;
  code: string;
  order: number;
}

export interface ControlPort {
  id: string;
  layerId: string;
  type: ControlValueType;
}

export interface ControlMapping {
  id: string;
  signalId: string;
  targetId: string;
  scale: number;
  offset: number;
  clamp?: [number, number];
}

export interface OwnedResource {
  id: string;
  kind: 'canvas' | 'audio-context' | 'timer' | 'subscription' | 'other';
  ownerLayerId: string;
}

export interface ControlRecipe {
  schema: typeof CONTROL_RECIPE_SCHEMA;
  schemaVersion: typeof CONTROL_RECIPE_VERSION;
  id: string;
  layers: ControlLayer[];
  transport: {
    clock: 'animation-frame' | 'interval';
    cadenceMs: number;
    bufferSize: number;
    staleAfterMs: number;
    staleBehavior: StaleBehavior;
  };
  signals: ControlPort[];
  targets: ControlPort[];
  mappings: ControlMapping[];
  resources: OwnedResource[];
  lifecycle: { startOrder: string[]; teardownOrder: string[] };
  audio: { unlock: 'user-gesture' | 'not-required'; ownerLayerId?: string };
  lineage: { parentRecipeIds: string[]; createdAt: string };
}

export interface LegacyControlRecipe {
  schema: typeof CONTROL_RECIPE_SCHEMA;
  schemaVersion: '1.0';
  id: string;
  layers: ControlLayer[];
  cadenceMs: number;
  links: Array<{
    id: string;
    from: ControlPort;
    to: ControlPort;
    scale?: number;
    offset?: number;
  }>;
  resources: OwnedResource[];
  createdAt: string;
}

const ID = /^[a-z][a-z0-9-]*$/;
const VALUE_TYPES = new Set<ControlValueType>(['number', 'string', 'boolean']);
const DOMAINS = new Set<DomainType>([
  'p5', 'three', 'shader', 'tone', 'music', 'strudel', 'hydra',
  'ascii', 'video', 'html', 'textgen', 'group',
  'svg', 'kinetic', 'glsl', 'nbe', 'custom',
]);
const STALE_BEHAVIORS = new Set<StaleBehavior>(['hold', 'zero', 'drop', 'error']);

function assertUniqueIds(items: Array<{ id: string }>, label: string): void {
  const seen = new Set<string>();
  for (const item of items) {
    if (!ID.test(item.id) || seen.has(item.id)) {
      throw new Error(`Invalid or duplicate ${label} id: ${item.id}`);
    }
    seen.add(item.id);
  }
}

function sameMembers(actual: string[], expected: string[]): boolean {
  return actual.length === expected.length
    && new Set(actual).size === actual.length
    && actual.every(id => expected.includes(id));
}

function uniquePorts(ports: ControlPort[]): ControlPort[] {
  const byId = new Map<string, ControlPort>();
  for (const port of ports) {
    const existing = byId.get(port.id);
    if (existing && (existing.layerId !== port.layerId || existing.type !== port.type)) {
      throw new Error(`Legacy port ${port.id} has conflicting definitions`);
    }
    byId.set(port.id, port);
  }
  return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
}

function cloneRecipe<T extends ControlRecipe | LegacyControlRecipe>(recipe: T): T {
  return JSON.parse(JSON.stringify(recipe)) as T;
}

function validateTransport(recipe: ControlRecipe): void {
  const { cadenceMs, bufferSize, staleAfterMs } = recipe.transport;
  if (!['animation-frame', 'interval'].includes(recipe.transport.clock)
    || !STALE_BEHAVIORS.has(recipe.transport.staleBehavior)) {
    throw new Error('Control transport has an unsupported mode');
  }
  if (!Number.isFinite(cadenceMs) || cadenceMs <= 0) {
    throw new Error('Control cadence must be positive');
  }
  if (!Number.isInteger(bufferSize) || bufferSize < 1) {
    throw new Error('Control bufferSize must be a positive integer');
  }
  if (!Number.isFinite(staleAfterMs) || staleAfterMs < cadenceMs * bufferSize) {
    throw new Error('Control staleAfterMs must cover the configured buffer');
  }
}

function validatePorts(ports: ControlPort[], layers: Set<string>, label: string): void {
  assertUniqueIds(ports, label);
  for (const port of ports) {
    if (!layers.has(port.layerId) || !VALUE_TYPES.has(port.type)) {
      throw new Error(`Invalid ${label} port: ${port.id}`);
    }
  }
}

function validateMappings(recipe: ControlRecipe, layerIds: Set<string>): void {
  assertUniqueIds(recipe.mappings, 'mapping');
  const signals = new Map(recipe.signals.map(port => [port.id, port]));
  const targets = new Map(recipe.targets.map(port => [port.id, port]));
  const connected = new Set<string>();
  const usedSignals = new Set<string>();
  const usedTargets = new Set<string>();
  for (const mapping of recipe.mappings) {
    const signal = signals.get(mapping.signalId);
    const target = targets.get(mapping.targetId);
    if (!signal || !target) {
      throw new Error(`Mapping ${mapping.id} has a missing or reversed endpoint`);
    }
    if (signal.layerId === target.layerId) {
      throw new Error(`Mapping ${mapping.id} is not cross-layer`);
    }
    if (signal.type !== target.type) {
      throw new Error(`Mapping ${mapping.id} has incompatible port types`);
    }
    if (usedTargets.has(target.id)) {
      throw new Error(`Target ${target.id} has multiple unordered writers`);
    }
    if (!Number.isFinite(mapping.scale) || !Number.isFinite(mapping.offset)) {
      throw new Error(`Mapping ${mapping.id} has a malformed transform`);
    }
    if (signal.type !== 'number'
      && (mapping.scale !== 1 || mapping.offset !== 0 || mapping.clamp)) {
      throw new Error(`Mapping ${mapping.id} transforms a non-numeric value`);
    }
    if (mapping.clamp && (
      mapping.clamp.length !== 2
      || !mapping.clamp.every(Number.isFinite)
      || mapping.clamp[0] > mapping.clamp[1]
    )) throw new Error(`Mapping ${mapping.id} has a malformed clamp`);
    connected.add(signal.layerId);
    connected.add(target.layerId);
    usedSignals.add(signal.id);
    usedTargets.add(target.id);
  }
  if (layerIds.size === 1 && recipe.mappings.length === 0
    && signals.size === 0 && targets.size === 0) return;
  if (recipe.mappings.length === 0
    || connected.size !== layerIds.size
    || usedSignals.size !== signals.size
    || usedTargets.size !== targets.size) {
    throw new Error('Control graph contains a disconnected layer');
  }
}

function validateResources(recipe: ControlRecipe, layerIds: Set<string>): void {
  assertUniqueIds(recipe.resources, 'resource');
  const kinds = new Set(['canvas', 'audio-context', 'timer', 'subscription', 'other']);
  for (const resource of recipe.resources) {
    if (!layerIds.has(resource.ownerLayerId) || !kinds.has(resource.kind)) {
      throw new Error(`Resource ${resource.id} has no valid owner`);
    }
  }
  if (recipe.audio.ownerLayerId && !layerIds.has(recipe.audio.ownerLayerId)) {
    throw new Error('Audio owner is not a recipe layer');
  }
  if (recipe.audio.ownerLayerId && recipe.audio.unlock !== 'user-gesture') {
    throw new Error('Audio resources require an explicit user gesture');
  }
  if (!recipe.audio.ownerLayerId && recipe.audio.unlock !== 'not-required') {
    throw new Error('Audio unlock policy has no owner');
  }
  if (recipe.audio.ownerLayerId && !recipe.resources.some(resource =>
    resource.ownerLayerId === recipe.audio.ownerLayerId
    && resource.kind === 'audio-context')) {
    throw new Error('Audio owner must own an audio-context resource');
  }
}

export function validateControlRecipe(recipe: ControlRecipe): ControlRecipe {
  if (recipe.schema !== CONTROL_RECIPE_SCHEMA || recipe.schemaVersion !== CONTROL_RECIPE_VERSION) {
    throw new Error('Unsupported control recipe version');
  }
  if (!ID.test(recipe.id) || recipe.layers.length < 1) {
    throw new Error('A control recipe needs a valid id and at least one layer');
  }
  assertUniqueIds(recipe.layers, 'layer');
  if (recipe.layers.some(layer => !DOMAINS.has(layer.domain) || typeof layer.code !== 'string')) {
    throw new Error('Control recipe contains an invalid layer');
  }
  const orders = recipe.layers.map(layer => layer.order);
  if (orders.some(order => !Number.isInteger(order)) || new Set(orders).size !== orders.length) {
    throw new Error('Layer order must contain unique integers');
  }
  const layerIds = new Set(recipe.layers.map(layer => layer.id));
  const expectedOrder = [...recipe.layers]
    .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id))
    .map(layer => layer.id);
  if (!sameMembers(recipe.lifecycle.startOrder, expectedOrder)
    || !sameMembers(recipe.lifecycle.teardownOrder, expectedOrder)
    || recipe.lifecycle.startOrder.some((id, index) => id !== expectedOrder[index])
    || recipe.lifecycle.teardownOrder.some(
      (id, index) => id !== [...expectedOrder].reverse()[index],
    )) {
    throw new Error('Lifecycle order must start forward and tear down in reverse');
  }
  validateTransport(recipe);
  validatePorts(recipe.signals, layerIds, 'signal');
  validatePorts(recipe.targets, layerIds, 'target');
  validateMappings(recipe, layerIds);
  validateResources(recipe, layerIds);
  if (!Array.isArray(recipe.lineage.parentRecipeIds)
    || recipe.lineage.parentRecipeIds.some(parent => !ID.test(parent))
    || !recipe.lineage.createdAt
    || Number.isNaN(Date.parse(recipe.lineage.createdAt))) {
    throw new Error('Control recipe lineage is incomplete');
  }
  return recipe;
}

export function migrateControlRecipe(input: ControlRecipe | LegacyControlRecipe): ControlRecipe {
  if (input.schemaVersion === CONTROL_RECIPE_VERSION) {
    return validateControlRecipe(cloneRecipe(input));
  }
  if (input.schema !== CONTROL_RECIPE_SCHEMA || input.schemaVersion !== '1.0') {
    throw new Error('Unsupported control recipe version');
  }
  const legacy = cloneRecipe(input);
  const layers = [...legacy.layers].sort(
    (a, b) => a.order - b.order || a.id.localeCompare(b.id),
  );
  const migrated: ControlRecipe = {
    schema: CONTROL_RECIPE_SCHEMA,
    schemaVersion: CONTROL_RECIPE_VERSION,
    id: legacy.id,
    layers,
    transport: {
      clock: 'interval',
      cadenceMs: legacy.cadenceMs,
      bufferSize: 1,
      staleAfterMs: legacy.cadenceMs,
      staleBehavior: 'hold',
    },
    signals: uniquePorts(legacy.links.map(link => link.from)),
    targets: uniquePorts(legacy.links.map(link => link.to)),
    mappings: legacy.links.map(link => ({
      id: link.id,
      signalId: link.from.id,
      targetId: link.to.id,
      scale: link.scale ?? 1,
      offset: link.offset ?? 0,
    })),
    resources: legacy.resources,
    lifecycle: {
      startOrder: layers.map(layer => layer.id),
      teardownOrder: layers.map(layer => layer.id).reverse(),
    },
    audio: audioPolicy(layers),
    lineage: { parentRecipeIds: [legacy.id], createdAt: legacy.createdAt },
  };
  return validateControlRecipe(migrated);
}

function audioPolicy(layers: ControlLayer[]): ControlRecipe['audio'] {
  const owner = layers.find(layer =>
    layer.domain === 'tone' || layer.domain === 'music' || layer.domain === 'strudel',
  );
  return owner
    ? { unlock: 'user-gesture', ownerLayerId: owner.id }
    : { unlock: 'not-required' };
}

export function controlRecipeLayers(recipe: ControlRecipe): Layer[] {
  validateControlRecipe(recipe);
  return [...recipe.layers]
    .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id))
    .map(layer => ({
      id: layer.id,
      type: layer.domain,
      code: layer.code,
      config: {
        ...DEFAULT_LAYER_CONFIG,
        zIndex: layer.order,
        transparentBackground: layer.domain !== 'tone' && layer.domain !== 'music',
      },
      metadata: {
        prompt: `Control recipe ${recipe.id}`,
        generator: 'control-recipe',
        model: 'unknown',
        generatedAt: recipe.lineage.createdAt,
        controlRecipeId: recipe.id,
      },
      enabled: true,
      locked: false,
    }));
}
